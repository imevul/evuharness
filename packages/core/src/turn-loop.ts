import type {
  ApprovalDecision,
  AskUserAnswer,
  AskUserQuestion,
  ChatMessage,
  ChatModeId,
  ChatRequest,
  PendingAskUser,
  PendingModeSwitch,
  PendingPlan,
  PendingToolApproval,
  PlanStep,
  Scope,
  StreamEvent,
  ToolEvent,
  TranscriptRow,
  UserTurnInput,
} from '@evu/harness-protocol';
import {
  AskUserQuestionSchema,
  BUILTIN_TOOL_NAMES,
  ChatModeIdSchema,
  PlanStepSchema,
} from '@evu/harness-protocol';
import type { ContextMenuRegistry } from './context-menus/index.js';
import { abortError, isAbortError, type ProviderAdapter } from './fake-provider.js';
import { GateCancelledError, GateNotFoundError, type GateWaiterRegistry } from './gate-waiters.js';
import { digestToolCall, type GrantStore, grantForDecision, resolveGrant } from './grants.js';
import { applyTurnPatch, type ModeWriter, type TurnPin } from './mode-pinning.js';
import type { ProviderCompleteInput } from './openai-client.js';
import { mergeIntoLeadingSystemMessage } from './prompts.js';
import { resolveProviderSelection } from './provider-override.js';
import { withSessionLock } from './session-cache.js';
import {
  DEFAULT_SESSION_TITLE,
  emptyGates,
  type SessionRecord,
  titleFromMessage,
} from './session-record.js';
import type { StoredProviderProfile } from './settings-store.js';
import { formatSkillInjection, type SkillCatalog } from './skills/index.js';
import type { SessionStore } from './stores.js';
import type { ToolHandler, ToolRegistry } from './tools.js';
import { wrapUntrustedToolResult } from './untrusted.js';

const CAP_NUDGE =
  'You have reached the maximum number of tool rounds. Answer with what you have. Do not call tools.';

export type CancelReason = 'operator' | 'follow_up';

export interface TurnController {
  runTurn(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  cancel(sessionId: string, reason?: CancelReason): Promise<void>;
  isLive(sessionId: string): boolean;
  /**
   * Deliver a tool-approval decision to a suspended turn.
   *
   * The turn loop records grants and executes (or refuses) after this resolves.
   * Returns once the waiter has accepted the decision — not after the tool runs.
   */
  decideToolApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  /**
   * Deliver answers to a suspended ask-user gate.
   *
   * Resolves the waiter so the turn resumes. Rejects when the ask is missing or
   * no longer pending — a late POST must not invent an exchange.
   */
  answerAskUser(sessionId: string, askId: string, answers: AskUserAnswer[]): Promise<void>;
  approvePlan(sessionId: string): Promise<void>;
  discardPlan(sessionId: string): Promise<void>;
  decideModeSwitch(sessionId: string, approve: boolean): Promise<void>;
}

export interface TurnControllerDeps {
  store: SessionStore;
  grants: GrantStore;
  tools: ToolRegistry;
  contextMenus: ContextMenuRegistry;
  provider: ProviderAdapter;
  gates: GateWaiterRegistry;
  newId: () => string;
  getStoredProvider(id?: string): Promise<StoredProviderProfile | null>;
  pinTurn(input: { sessionId: string; mode: ChatModeId; scope?: Scope }): Promise<TurnPin>;
  createSession(options?: {
    mode?: ChatModeId;
    workspaceId?: string;
    title?: string;
  }): Promise<{ id: string }>;
  hasMode(id: ChatModeId): boolean;
  writeSessionMode(sessionId: string, mode: ChatModeId, writer: ModeWriter): Promise<void>;
  maxToolRounds(): Promise<number>;
  askUserEnabled(): Promise<boolean>;
  /**
   * Effective approval rule for a tool name after settings overrides.
   *
   * Builtins always resolve to `always_allow`. Unknown names fail closed to
   * `requires_approval`.
   */
  toolApprovalRule(name: string): Promise<'always_allow' | 'requires_approval'>;
  /** Host skill catalog; required for `load_skill` mid-turn injection. */
  skills?: SkillCatalog;
  now: () => string;
}

interface LiveTurn {
  controller: AbortController;
  reason: CancelReason | null;
  finished: Promise<void>;
  resolveFinished: () => void;
}

/**
 * One follow-up send waiting to be drained into the next turn.
 *
 * Concurrent `runTurn` calls for the same session enqueue here before canceling
 * the live turn, so several mid-turn messages become a single next request.
 */
interface QueuedFollowUp {
  messages: UserTurnInput[];
  mode: ChatModeId;
  provider: ChatRequest['provider'];
  workspaceId: string | undefined;
}

/**
 * Per-session turn runtime.
 *
 * One live turn at a time. A second `runTurn` for the same session enqueues its
 * messages, cancels the live turn with `follow_up`, and the next starter drains
 * every queued send as one turn (last send wins for the mode pin). Persistence
 * goes through `TurnPatch` so a concurrent set-mode cannot be clobbered.
 */
type PlanGateDecision = 'approve' | 'discard';

export function createTurnController(deps: TurnControllerDeps): TurnController {
  const live = new Map<string, LiveTurn>();
  const queues = new Map<string, QueuedFollowUp[]>();
  /** Serializes turn starts so concurrent follow-ups drain once, not race. */
  const startLocks = new Map<string, Promise<void>>();

  async function cancel(sessionId: string, reason: CancelReason = 'operator'): Promise<void> {
    const handle = live.get(sessionId);
    if (handle === undefined) {
      // Still drop any orphaned waiters tied to this session id.
      deps.gates.cancelSession(sessionId);
      return;
    }
    handle.reason = reason;
    // Reject open gate waiters before aborting so a late decideToolApproval cannot
    // resume execution after cancel has been requested.
    deps.gates.cancelSession(sessionId);
    handle.controller.abort();
    await handle.finished;
  }

  async function decideToolApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const record = await deps.store.get(sessionId);
    if (record === null) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const pending = record.pending.toolApprovals.find((entry) => entry.approvalId === approvalId);
    if (pending === undefined) {
      throw new GateNotFoundError('tool_approval', approvalId);
    }
    if (!deps.gates.resolve('tool_approval', approvalId, decision)) {
      throw new GateNotFoundError('tool_approval', approvalId);
    }
  }

  async function answerAskUser(
    sessionId: string,
    askId: string,
    answers: AskUserAnswer[],
  ): Promise<void> {
    const record = await deps.store.get(sessionId);
    if (record === null) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const pending = record.pending.askUser;
    if (pending === null || pending.askId !== askId) {
      throw new GateNotFoundError('ask_user', askId);
    }
    if (!deps.gates.resolve('ask_user', askId, answers)) {
      throw new GateNotFoundError('ask_user', askId);
    }
  }

  async function decidePlan(sessionId: string, decision: PlanGateDecision): Promise<void> {
    await withSessionLock(deps.store, sessionId, async () => {
      const record = await deps.store.get(sessionId);
      if (record === null) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const pending = record.pending.plan;
      if (pending === null || !pending.awaitingApproval) {
        throw new GateNotFoundError('plan', pending?.planId ?? 'none');
      }

      if (decision === 'approve') {
        await mintPlanReceipts(deps, sessionId, record.workspaceId, pending.steps);
        await deps.writeSessionMode(sessionId, 'agent', 'plan-approval');
      }

      const latest = await deps.store.get(sessionId);
      if (latest === null) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      await deps.store.upsert({
        ...latest,
        pending: { ...latest.pending, plan: null },
        updatedAt: deps.now(),
      });

      if (!deps.gates.resolve('plan', pending.planId, decision)) {
        throw new GateNotFoundError('plan', pending.planId);
      }
    });
  }

  async function decideModeSwitch(sessionId: string, approve: boolean): Promise<void> {
    await withSessionLock(deps.store, sessionId, async () => {
      const record = await deps.store.get(sessionId);
      if (record === null) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const pending = record.pending.modeSwitch;
      if (pending === null) {
        throw new GateNotFoundError('mode_switch', 'none');
      }

      if (approve) {
        await deps.writeSessionMode(sessionId, pending.to, 'explicit-set-mode');
      }

      const latest = await deps.store.get(sessionId);
      if (latest === null) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      await deps.store.upsert({
        ...latest,
        pending: { ...latest.pending, modeSwitch: null },
        updatedAt: deps.now(),
      });

      if (!deps.gates.resolve('mode_switch', pending.requestId, approve)) {
        throw new GateNotFoundError('mode_switch', pending.requestId);
      }
    });
  }

  async function* runTurn(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    let sessionId = request.sessionId;
    if (sessionId === undefined) {
      const created = await deps.createSession({
        mode: request.mode,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      });
      sessionId = created.id;
    }

    const queue = queues.get(sessionId) ?? [];
    queue.push({
      messages: request.messages,
      mode: request.mode,
      provider: request.provider,
      workspaceId: request.workspaceId,
    });
    queues.set(sessionId, queue);

    if (live.has(sessionId)) {
      await cancel(sessionId, 'follow_up');
    }

    const previous = startLocks.get(sessionId) ?? Promise.resolve();
    let releaseStart = (): void => {};
    const ourStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    startLocks.set(
      sessionId,
      previous.then(() => ourStart),
    );
    await previous;

    try {
      const pending = queues.get(sessionId) ?? [];
      if (pending.length === 0) {
        // Another concurrent starter already drained including this request.
        return;
      }
      queues.set(sessionId, []);

      const drained = drainFollowUps(sessionId, pending);

      const controller = new AbortController();
      let resolveFinished = (): void => {};
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const handle: LiveTurn = { controller, reason: null, finished, resolveFinished };
      live.set(sessionId, handle);

      const onExternalAbort = () => {
        deps.gates.cancelSession(sessionId);
        controller.abort();
      };
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        yield* executeTurn(deps, drained, sessionId, handle);
      } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        deps.gates.cancelSession(sessionId);
        live.delete(sessionId);
        handle.resolveFinished();
      }
    } finally {
      releaseStart();
    }
  }

  return {
    runTurn,
    cancel,
    decideToolApproval,
    answerAskUser,
    approvePlan: (sessionId) => decidePlan(sessionId, 'approve'),
    discardPlan: (sessionId) => decidePlan(sessionId, 'discard'),
    decideModeSwitch,
    isLive: (sessionId) => live.has(sessionId),
  };
}

/**
 * Collapse queued follow-ups into one chat request.
 *
 * Message order is FIFO across sends. The mode pin and provider override come
 * from the last send — that is the user's most recent intent for the drained
 * turn.
 */
function drainFollowUps(sessionId: string, pending: QueuedFollowUp[]): ChatRequest {
  const last = pending.at(-1);
  if (last === undefined) {
    throw new Error('drainFollowUps requires at least one queued follow-up');
  }
  return {
    sessionId,
    mode: last.mode,
    messages: pending.flatMap((entry) => entry.messages),
    ...(last.provider === undefined ? {} : { provider: last.provider }),
    ...(last.workspaceId === undefined ? {} : { workspaceId: last.workspaceId }),
  };
}

async function* executeTurn(
  deps: TurnControllerDeps,
  request: ChatRequest,
  sessionId: string,
  handle: LiveTurn,
): AsyncGenerator<StreamEvent> {
  const loaded = await deps.store.get(sessionId);
  if (loaded === null) {
    yield { event: 'error', sessionId, message: `Unknown session: ${sessionId}` };
    return;
  }

  await deps.writeSessionMode(sessionId, request.mode, 'send-time-pin');

  const scope: Scope = loaded.workspaceId === undefined ? {} : { workspaceId: loaded.workspaceId };
  const pin = await deps.pinTurn({ sessionId, mode: request.mode, scope });

  // Turn > session > settings active profile. Per-turn never rewrites the session.
  const selection = await resolveProviderSelection(
    (id) => deps.getStoredProvider(id),
    loaded.provider,
    request.provider,
  );
  if (selection === null) {
    yield { event: 'error', sessionId, message: 'No provider configured' };
    return;
  }
  const { profile, model } = selection;

  const resolved = await resolveUserTurns(deps, request.messages, {
    sessionId,
    mode: request.mode,
    scope,
    signal: handle.controller.signal,
  });

  let record = await persist(deps, sessionId, {
    messages: [...loaded.messages, ...resolved.messages],
    transcript: [...loaded.transcript, ...resolved.rows],
    ...(loaded.title === DEFAULT_SESSION_TITLE
      ? { title: titleFromMessage(resolved.messages[0]?.content ?? '') }
      : {}),
  });

  yield { event: 'status', sessionId, phase: 'started' };

  let promptExtra = resolved.promptExtra;
  const maxToolRounds = await deps.maxToolRounds();
  const pinnedTools = deps.tools.specsForMode(pin.toolNames);
  const turnTools: ToolEvent[] = [];
  let content = '';
  let reasoning = '';
  let usage = { ...record.usage };
  let toolRounds = 0;
  let terminal: StreamEvent | null = null;

  try {
    for (;;) {
      if (handle.controller.signal.aborted) {
        terminal = await finishCancelled(deps, sessionId, handle, {
          content,
          reasoning,
          tools: turnTools,
          usage,
        });
        break;
      }

      const atCap = toolRounds >= maxToolRounds;
      const thread = composeThread(pin.systemPrompt, record.messages, promptExtra);
      if (atCap) {
        thread.push({ role: 'user', content: CAP_NUDGE });
        yield { event: 'status', sessionId, phase: 'finalizing' };
      } else {
        yield { event: 'status', sessionId, phase: 'thinking' };
      }

      const streamed = yield* streamProvider(deps.provider, profile, {
        messages: thread,
        tools: atCap ? [] : [...pinnedTools],
        model,
        signal: handle.controller.signal,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        timeoutMs: profile.timeoutMs,
      });

      if (streamed.kind === 'cancelled') {
        content = streamed.content;
        reasoning += streamed.reasoning;
        usage = addUsage(usage, streamed.usage);
        if (streamed.usage !== null) {
          yield usageEvent(sessionId, streamed.usage, usage);
        }
        terminal = await finishCancelled(deps, sessionId, handle, {
          content,
          reasoning,
          tools: turnTools,
          usage,
        });
        break;
      }

      if (streamed.kind === 'failed') {
        content = streamed.content;
        reasoning += streamed.reasoning;
        usage = addUsage(usage, streamed.usage);
        await persistPartial(deps, sessionId, { content, reasoning, tools: turnTools, usage });
        terminal = { event: 'error', sessionId, message: streamed.message };
        break;
      }

      content = streamed.content;
      reasoning += streamed.reasoning;
      usage = addUsage(usage, streamed.usage);
      if (streamed.usage !== null) {
        yield usageEvent(sessionId, streamed.usage, usage);
      }

      const toolCalls = streamed.message.toolCalls ?? [];
      if (toolCalls.length === 0 || atCap) {
        record = await persistTerminalAssistant(deps, sessionId, {
          message: streamed.message,
          content,
          reasoning,
          tools: turnTools,
          usage,
        });
        terminal = doneEvent(record, content, turnTools, reasoning);
        break;
      }

      yield { event: 'status', sessionId, phase: 'tools' };

      record = await persist(deps, sessionId, {
        messages: [...record.messages, streamed.message],
        usage,
      });

      for (const call of toolCalls) {
        if (handle.controller.signal.aborted) {
          terminal = await finishCancelled(deps, sessionId, handle, {
            content,
            reasoning,
            tools: turnTools,
            usage,
          });
          break;
        }

        if (
          call.name === BUILTIN_TOOL_NAMES.proposePlan ||
          call.name === BUILTIN_TOOL_NAMES.requestModeSwitch
        ) {
          const gateOutcome = yield* runBuiltinGate(deps, {
            sessionId,
            pin,
            scope,
            call,
            content,
            reasoning,
            turnTools,
            usage,
            signal: handle.controller.signal,
          });
          if (gateOutcome.kind === 'cancelled') {
            terminal = await finishCancelled(deps, sessionId, handle, {
              content,
              reasoning,
              tools: turnTools,
              usage,
            });
            break;
          }
          record = gateOutcome.record;
          continue;
        }

        if (call.name === BUILTIN_TOOL_NAMES.askUser) {
          const askOutcome = yield* runAskUserGate(deps, {
            sessionId,
            pin,
            call,
            content,
            reasoning,
            turnTools,
            usage,
            signal: handle.controller.signal,
          });
          if (askOutcome.kind === 'cancelled') {
            terminal = await finishCancelled(deps, sessionId, handle, {
              content,
              reasoning,
              tools: turnTools,
              usage,
            });
            break;
          }
          record = askOutcome.record;
          continue;
        }

        if (call.name === BUILTIN_TOOL_NAMES.loadSkill) {
          const loaded = await runLoadSkill(deps, pin, call);
          if (loaded.injection !== '') {
            // Accumulate for every later provider round in this turn. composeThread
            // merges into the leading system message — never a mid-thread system role.
            promptExtra = joinExtra(promptExtra, loaded.injection);
          }
          turnTools.push(loaded.event);
          yield {
            event: 'tool',
            name: loaded.event.name,
            arguments: loaded.event.arguments,
            result: loaded.event.result,
            ...(loaded.event.denied === undefined ? {} : { denied: loaded.event.denied }),
          };
          const latestAfterSkill = await deps.store.get(sessionId);
          if (latestAfterSkill === null) {
            throw new Error(`Unknown session: ${sessionId}`);
          }
          record = await persist(deps, sessionId, {
            messages: [...latestAfterSkill.messages, loaded.message],
            transcript: upsertAssistantRow(latestAfterSkill.transcript, {
              kind: 'assistant',
              text: content,
              tools: [...turnTools],
              ...(reasoning === '' ? {} : { reasoning }),
              partial: true,
              createdAt: deps.now(),
            }),
            usage,
          });
          continue;
        }

        let executed: { event: ToolEvent; message: ChatMessage };
        try {
          const toolRun = executeTool(deps, pin, scope, call, handle.controller.signal);
          let next = await toolRun.next();
          while (!next.done) {
            yield next.value;
            next = await toolRun.next();
          }
          executed = next.value;
        } catch (error) {
          if (
            isAbortError(error) ||
            error instanceof GateCancelledError ||
            handle.controller.signal.aborted
          ) {
            terminal = await finishCancelled(deps, sessionId, handle, {
              content,
              reasoning,
              tools: turnTools,
              usage,
            });
            break;
          }
          throw error;
        }

        turnTools.push(executed.event);
        yield {
          event: 'tool',
          name: executed.event.name,
          arguments: executed.event.arguments,
          result: executed.event.result,
          ...(executed.event.denied === undefined ? {} : { denied: executed.event.denied }),
        };

        const latest = await deps.store.get(sessionId);
        if (latest === null) {
          throw new Error(`Unknown session: ${sessionId}`);
        }
        record = await persist(deps, sessionId, {
          messages: [...latest.messages, executed.message],
          transcript: upsertAssistantRow(latest.transcript, {
            kind: 'assistant',
            text: content,
            tools: [...turnTools],
            ...(reasoning === '' ? {} : { reasoning }),
            partial: true,
            createdAt: deps.now(),
          }),
          usage,
        });
      }

      if (terminal !== null) {
        break;
      }
      toolRounds += 1;
    }
  } catch (error) {
    if (
      isAbortError(error) ||
      handle.controller.signal.aborted ||
      error instanceof GateCancelledError
    ) {
      terminal = await finishCancelled(deps, sessionId, handle, {
        content,
        reasoning,
        tools: turnTools,
        usage,
      });
    } else {
      await persistPartial(deps, sessionId, { content, reasoning, tools: turnTools, usage });
      terminal = {
        event: 'error',
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (terminal !== null) {
    yield terminal;
  }
}

async function* streamProvider(
  provider: ProviderAdapter,
  profile: StoredProviderProfile,
  input: ProviderCompleteInput,
): AsyncGenerator<StreamEvent, StreamOutcome> {
  let content = '';
  let reasoning = '';
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let message: ChatMessage = { role: 'assistant', content: '' };

  if (input.signal.aborted) {
    return { kind: 'cancelled', content, reasoning, usage };
  }

  try {
    for await (const event of provider.complete(profile, input)) {
      if (input.signal.aborted) {
        return { kind: 'cancelled', content, reasoning, usage };
      }
      switch (event.kind) {
        case 'delta':
          content += event.text;
          yield { event: 'delta', text: event.text };
          break;
        case 'reasoning_delta':
          reasoning += event.text;
          yield { event: 'reasoning_delta', text: event.text };
          break;
        case 'usage':
          usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
          break;
        case 'message':
          message = event.message;
          if (event.message.content !== '' && content === '') {
            content = event.message.content;
          }
          break;
      }
    }
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      return { kind: 'cancelled', content, reasoning, usage };
    }
    return {
      kind: 'failed',
      content,
      reasoning,
      usage,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (message.content === '' && content !== '') {
    message = { ...message, content };
  }

  return { kind: 'complete', content, reasoning, usage, message };
}

type StreamOutcome =
  | {
      kind: 'complete';
      content: string;
      reasoning: string;
      usage: { promptTokens: number; completionTokens: number } | null;
      message: ChatMessage;
    }
  | {
      kind: 'cancelled';
      content: string;
      reasoning: string;
      usage: { promptTokens: number; completionTokens: number } | null;
    }
  | {
      kind: 'failed';
      content: string;
      reasoning: string;
      usage: { promptTokens: number; completionTokens: number } | null;
      message: string;
    };

type GateToolOutcome = { kind: 'answered'; record: SessionRecord } | { kind: 'cancelled' };

/**
 * Dispatch a builtin gate tool: propose_plan or request_mode_switch.
 *
 * Both suspend the turn via GateWaiterRegistry. Plan approval may write the
 * session default to agent and mint one-shot receipts; mode-switch approval
 * writes only the session default. Neither mutates the turn pin.
 */
async function* runBuiltinGate(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    pin: TurnPin;
    scope: Scope;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
    signal: AbortSignal;
  },
): AsyncGenerator<StreamEvent, GateToolOutcome> {
  if (input.call.name === BUILTIN_TOOL_NAMES.proposePlan) {
    return yield* runPlanGate(deps, input);
  }
  return yield* runModeSwitchGate(deps, input);
}

async function* runPlanGate(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    pin: TurnPin;
    scope: Scope;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
    signal: AbortSignal;
  },
): AsyncGenerator<StreamEvent, GateToolOutcome> {
  const args = normalizeArgs(input.call.arguments);

  if (!input.pin.toolNames.has(BUILTIN_TOOL_NAMES.proposePlan)) {
    return yield* completeGateTool(deps, input, {
      result: `Tool '${BUILTIN_TOOL_NAMES.proposePlan}' is not available in this mode.`,
      denied: true,
    });
  }
  if (!deps.tools.has(BUILTIN_TOOL_NAMES.proposePlan)) {
    return yield* completeGateTool(deps, input, {
      result: `Unknown tool: ${BUILTIN_TOOL_NAMES.proposePlan}`,
      denied: true,
    });
  }

  const parsed = parsePlanProposal(args);
  if (parsed === null) {
    return yield* completeGateTool(deps, input, {
      result: `Tool '${BUILTIN_TOOL_NAMES.proposePlan}' was denied: title and steps are required.`,
      denied: true,
    });
  }

  const planId = deps.newId();
  const pending: PendingPlan = {
    planId,
    title: parsed.title,
    steps: parsed.steps,
    awaitingApproval: true,
    proposedAt: deps.now(),
  };

  const latestBefore = await deps.store.get(input.sessionId);
  if (latestBefore === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }

  await persist(deps, input.sessionId, {
    transcript: upsertAssistantRow(latestBefore.transcript, {
      kind: 'assistant',
      text: input.content,
      ...(input.turnTools.length === 0 ? {} : { tools: [...input.turnTools] }),
      ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
      partial: true,
      createdAt: deps.now(),
    }),
    pending: { ...latestBefore.pending, plan: pending },
    usage: input.usage,
  });

  const waiter = deps.gates.open<PlanGateDecision>({
    sessionId: input.sessionId,
    kind: 'plan',
    id: planId,
  });

  const waiting = waiter.wait(input.signal);

  yield {
    event: 'plan_approval_required',
    sessionId: input.sessionId,
    planId: pending.planId,
    title: pending.title,
    steps: pending.steps,
    awaitingApproval: pending.awaitingApproval,
    proposedAt: pending.proposedAt,
  };

  let decision: PlanGateDecision;
  try {
    decision = await waiting;
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted || error instanceof GateCancelledError) {
      return { kind: 'cancelled' };
    }
    throw error;
  }

  const result =
    decision === 'approve'
      ? `Plan "${pending.title}" approved. Session switched to agent mode. One-shot receipts minted for steps that named a tool. This turn remains in ${input.pin.mode} mode.`
      : `Plan "${pending.title}" discarded. Session mode is unchanged.`;

  return yield* completeGateTool(deps, input, { result, denied: false });
}

async function* runModeSwitchGate(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    pin: TurnPin;
    scope: Scope;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
    signal: AbortSignal;
  },
): AsyncGenerator<StreamEvent, GateToolOutcome> {
  const args = normalizeArgs(input.call.arguments);

  if (!input.pin.toolNames.has(BUILTIN_TOOL_NAMES.requestModeSwitch)) {
    return yield* completeGateTool(deps, input, {
      result: `Tool '${BUILTIN_TOOL_NAMES.requestModeSwitch}' is not available in this mode.`,
      denied: true,
    });
  }
  if (!deps.tools.has(BUILTIN_TOOL_NAMES.requestModeSwitch)) {
    return yield* completeGateTool(deps, input, {
      result: `Unknown tool: ${BUILTIN_TOOL_NAMES.requestModeSwitch}`,
      denied: true,
    });
  }

  const toRaw = args.to;
  const reasonRaw = args.reason;
  const toParsed = ChatModeIdSchema.safeParse(toRaw);
  if (!toParsed.success || typeof reasonRaw !== 'string' || reasonRaw.trim() === '') {
    return yield* completeGateTool(deps, input, {
      result: `Tool '${BUILTIN_TOOL_NAMES.requestModeSwitch}' was denied: 'to' and 'reason' are required.`,
      denied: true,
    });
  }
  const to = toParsed.data;
  if (!deps.hasMode(to)) {
    return yield* completeGateTool(deps, input, {
      result: `Tool '${BUILTIN_TOOL_NAMES.requestModeSwitch}' was denied: unknown mode '${to}'.`,
      denied: true,
    });
  }

  const requestId = deps.newId();
  const pending: PendingModeSwitch = {
    requestId,
    from: input.pin.mode,
    to,
    reason: reasonRaw.trim(),
    requestedAt: deps.now(),
  };

  const latestBefore = await deps.store.get(input.sessionId);
  if (latestBefore === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }

  await persist(deps, input.sessionId, {
    transcript: upsertAssistantRow(latestBefore.transcript, {
      kind: 'assistant',
      text: input.content,
      ...(input.turnTools.length === 0 ? {} : { tools: [...input.turnTools] }),
      ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
      partial: true,
      createdAt: deps.now(),
    }),
    pending: { ...latestBefore.pending, modeSwitch: pending },
    usage: input.usage,
  });

  const waiter = deps.gates.open<boolean>({
    sessionId: input.sessionId,
    kind: 'mode_switch',
    id: requestId,
  });

  const waiting = waiter.wait(input.signal);

  yield {
    event: 'mode_switch_required',
    sessionId: input.sessionId,
    requestId: pending.requestId,
    from: pending.from,
    to: pending.to,
    reason: pending.reason,
    requestedAt: pending.requestedAt,
  };

  let approved: boolean;
  try {
    approved = await waiting;
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted || error instanceof GateCancelledError) {
      return { kind: 'cancelled' };
    }
    throw error;
  }

  const result = approved
    ? `Mode switch approved. Session default is now ${pending.to}. This turn remains in ${input.pin.mode} mode.`
    : `Mode switch to ${pending.to} denied. Remaining in ${input.pin.mode} for this turn; session default unchanged.`;

  return yield* completeGateTool(deps, input, { result, denied: !approved });
}

async function* completeGateTool(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
  },
  outcome: { result: string; denied: boolean },
): AsyncGenerator<StreamEvent, { kind: 'answered'; record: SessionRecord }> {
  const args = normalizeArgs(input.call.arguments);
  const event: ToolEvent = {
    name: input.call.name,
    arguments: args,
    result: outcome.result,
    ...(outcome.denied ? { denied: true } : {}),
  };
  input.turnTools.push(event);
  yield {
    event: 'tool',
    name: event.name,
    arguments: event.arguments,
    result: event.result,
    ...(event.denied === undefined ? {} : { denied: event.denied }),
  };

  const latest = await deps.store.get(input.sessionId);
  if (latest === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
  const record = await persist(deps, input.sessionId, {
    messages: [
      ...latest.messages,
      {
        role: 'tool',
        content: wrapUntrustedToolResult(input.call.name, outcome.result),
        name: input.call.name,
        toolCallId: input.call.id,
      },
    ],
    transcript: upsertAssistantRow(latest.transcript, {
      kind: 'assistant',
      text: input.content,
      tools: [...input.turnTools],
      ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
      partial: true,
      createdAt: deps.now(),
    }),
    usage: input.usage,
  });
  return { kind: 'answered', record };
}

function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function parsePlanProposal(
  args: Record<string, unknown>,
): { title: string; steps: PlanStep[] } | null {
  const title = args.title;
  const stepsRaw = args.steps;
  if (typeof title !== 'string' || title.trim() === '' || !Array.isArray(stepsRaw)) {
    return null;
  }
  const steps: PlanStep[] = [];
  for (const entry of stepsRaw) {
    const parsed = PlanStepSchema.safeParse(entry);
    if (!parsed.success) {
      return null;
    }
    steps.push(parsed.data);
  }
  return { title: title.trim(), steps };
}

async function mintPlanReceipts(
  deps: TurnControllerDeps,
  sessionId: string,
  workspaceId: string | undefined,
  steps: PlanStep[],
): Promise<void> {
  for (const step of steps) {
    if (step.tool === undefined || step.tool === '') {
      continue;
    }
    const args = step.arguments ?? {};
    const grant = grantForDecision(
      'allow_once',
      {
        sessionId,
        workspaceId,
        tool: step.tool,
        digest: digestToolCall(step.tool, args),
      },
      deps.now(),
    );
    if (grant !== null) {
      await deps.grants.add(grant);
    }
  }
}

/**
 * Suspend for an ask-user gate.
 *
 * The exchange is recorded as transcript rows (question as system, answer as
 * user). The model still receives a tool-role message so the provider's tool-call
 * protocol stays intact — but that message is not mirrored as a `tool` stream
 * event or an assistant-row tool chip.
 */
async function* runAskUserGate(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    pin: TurnPin;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
    signal: AbortSignal;
  },
): AsyncGenerator<
  StreamEvent,
  { kind: 'answered'; record: SessionRecord } | { kind: 'cancelled' }
> {
  const args =
    input.call.arguments !== null &&
    typeof input.call.arguments === 'object' &&
    !Array.isArray(input.call.arguments)
      ? input.call.arguments
      : {};

  if (!input.pin.toolNames.has(BUILTIN_TOOL_NAMES.askUser)) {
    return yield* denyAskAsTool(
      deps,
      input,
      `Tool '${BUILTIN_TOOL_NAMES.askUser}' is not available in this mode.`,
    );
  }
  if (!deps.tools.has(BUILTIN_TOOL_NAMES.askUser)) {
    return yield* denyAskAsTool(deps, input, `Unknown tool: ${BUILTIN_TOOL_NAMES.askUser}`);
  }
  if (!(await deps.askUserEnabled())) {
    return yield* denyAskAsTool(
      deps,
      input,
      `Tool '${BUILTIN_TOOL_NAMES.askUser}' was denied: ask-user is disabled.`,
    );
  }

  const questions = parseAskUserQuestions(args);
  if (questions === null) {
    return yield* denyAskAsTool(
      deps,
      input,
      `Tool '${BUILTIN_TOOL_NAMES.askUser}' was denied: questions must be a non-empty array.`,
    );
  }

  const askId = deps.newId();
  const pending: PendingAskUser = {
    askId,
    questions,
    requestedAt: deps.now(),
  };

  const questionText = formatAskUserQuestions(questions);
  const latestBefore = await deps.store.get(input.sessionId);
  if (latestBefore === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }

  await persist(deps, input.sessionId, {
    transcript: [
      ...upsertAssistantRow(latestBefore.transcript, {
        kind: 'assistant',
        text: input.content,
        ...(input.turnTools.length === 0 ? {} : { tools: [...input.turnTools] }),
        ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
        partial: true,
        createdAt: deps.now(),
      }),
      { kind: 'system', text: questionText, createdAt: deps.now() },
    ],
    pending: {
      ...latestBefore.pending,
      askUser: pending,
    },
    usage: input.usage,
  });

  const waiter = deps.gates.open<AskUserAnswer[]>({
    sessionId: input.sessionId,
    kind: 'ask_user',
    id: askId,
  });

  // Start waiting before yielding so a cancel that arrives while the consumer
  // handles the event rejects a promise that already has a listener.
  const waiting = waiter.wait(input.signal);

  yield {
    event: 'ask_user_required',
    sessionId: input.sessionId,
    askId: pending.askId,
    questions: pending.questions,
    requestedAt: pending.requestedAt,
  };

  let answers: AskUserAnswer[];
  try {
    answers = await waiting;
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted || error instanceof GateCancelledError) {
      return { kind: 'cancelled' };
    }
    throw error;
  }

  const answerText = formatAskUserAnswers(questions, answers);
  const latest = await deps.store.get(input.sessionId);
  if (latest === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }

  // Tool-role content for the model thread only — not a transcript tool result.
  const modelPayload = formatAskUserAnswersForModel(questions, answers);
  const toolMessage: ChatMessage = {
    role: 'tool',
    content: wrapUntrustedToolResult(BUILTIN_TOOL_NAMES.askUser, modelPayload),
    name: BUILTIN_TOOL_NAMES.askUser,
    toolCallId: input.call.id,
  };

  const record = await persist(deps, input.sessionId, {
    messages: [...latest.messages, toolMessage],
    transcript: [...latest.transcript, { kind: 'user', text: answerText, createdAt: deps.now() }],
    pending: {
      ...latest.pending,
      askUser: null,
    },
    usage: input.usage,
  });

  return { kind: 'answered', record };
}

async function* denyAskAsTool(
  deps: TurnControllerDeps,
  input: {
    sessionId: string;
    call: { id: string; name: string; arguments: Record<string, unknown> };
    content: string;
    reasoning: string;
    turnTools: ToolEvent[];
    usage: SessionRecord['usage'];
  },
  result: string,
): AsyncGenerator<StreamEvent, { kind: 'answered'; record: SessionRecord }> {
  const args =
    input.call.arguments !== null &&
    typeof input.call.arguments === 'object' &&
    !Array.isArray(input.call.arguments)
      ? input.call.arguments
      : {};
  const event: ToolEvent = {
    name: BUILTIN_TOOL_NAMES.askUser,
    arguments: args,
    result,
    denied: true,
  };
  input.turnTools.push(event);
  yield {
    event: 'tool',
    name: event.name,
    arguments: event.arguments,
    result: event.result,
    denied: true,
  };

  const latest = await deps.store.get(input.sessionId);
  if (latest === null) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
  const record = await persist(deps, input.sessionId, {
    messages: [
      ...latest.messages,
      {
        role: 'tool',
        content: wrapUntrustedToolResult(BUILTIN_TOOL_NAMES.askUser, result),
        name: BUILTIN_TOOL_NAMES.askUser,
        toolCallId: input.call.id,
      },
    ],
    transcript: upsertAssistantRow(latest.transcript, {
      kind: 'assistant',
      text: input.content,
      tools: [...input.turnTools],
      ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
      partial: true,
      createdAt: deps.now(),
    }),
    usage: input.usage,
  });
  return { kind: 'answered', record };
}

function parseAskUserQuestions(args: Record<string, unknown>): AskUserQuestion[] | null {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const questions: AskUserQuestion[] = [];
  for (const entry of raw) {
    const parsed = AskUserQuestionSchema.safeParse(entry);
    if (!parsed.success) {
      return null;
    }
    questions.push(parsed.data);
  }
  return questions;
}

function formatAskUserQuestions(questions: AskUserQuestion[]): string {
  if (questions.length === 1) {
    const question = questions[0];
    if (question === undefined) {
      return 'Question:';
    }
    const choices =
      question.choices.length === 0
        ? ''
        : `\nChoices: ${question.choices.map((choice) => choice.label).join(', ')}`;
    return `Question: ${question.prompt}${choices}`;
  }
  return [
    'Questions:',
    ...questions.map((question, index) => {
      const choices =
        question.choices.length === 0
          ? ''
          : ` [${question.choices.map((choice) => choice.label).join(', ')}]`;
      return `${index + 1}. ${question.prompt}${choices}`;
    }),
  ].join('\n');
}

function formatAskUserAnswers(questions: AskUserQuestion[], answers: AskUserAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const lines = questions.map((question) => {
    const answer = byId.get(question.id);
    const parts: string[] = [];
    if (answer !== undefined) {
      for (const selectedId of answer.selected) {
        const choice = question.choices.find((entry) => entry.id === selectedId);
        parts.push(choice?.label ?? selectedId);
      }
      if (answer.text !== undefined && answer.text.trim() !== '') {
        parts.push(answer.text.trim());
      }
    }
    return parts.length === 0
      ? `${question.prompt}: (no answer)`
      : `${question.prompt}: ${parts.join('; ')}`;
  });
  return lines.join('\n');
}

function formatAskUserAnswersForModel(
  questions: AskUserQuestion[],
  answers: AskUserAnswer[],
): string {
  return formatAskUserAnswers(questions, answers);
}

async function* executeTool(
  deps: TurnControllerDeps,
  pin: TurnPin,
  scope: Scope,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, { event: ToolEvent; message: ChatMessage }> {
  const args =
    call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments
      : {};

  let result: string;
  let denied = false;

  if (!pin.toolNames.has(call.name)) {
    result = `Tool '${call.name}' is not available in this mode.`;
    denied = true;
  } else if (!deps.tools.has(call.name)) {
    result = `Unknown tool: ${call.name}`;
    denied = true;
  } else {
    const registration = deps.tools.get(call.name);
    if ((await deps.toolApprovalRule(call.name)) === 'requires_approval') {
      const digest = digestToolCall(call.name, args);
      const granted = await resolveGrant(deps.grants, {
        sessionId: pin.sessionId,
        workspaceId: scope.workspaceId,
        tool: call.name,
        digest,
      });
      if (granted.allowed) {
        result = await invokeTool(registration.handler, args, pin, scope, signal);
      } else {
        const outcome = yield* awaitApproval(deps, pin, scope, call.name, args, digest, signal);
        if (outcome.decision === 'deny') {
          result = `Tool '${call.name}' was denied by the user.`;
          denied = true;
        } else {
          result = await invokeTool(registration.handler, args, pin, scope, signal);
        }
      }
    } else {
      result = await invokeTool(registration.handler, args, pin, scope, signal);
    }
  }

  const event: ToolEvent = {
    name: call.name,
    arguments: args,
    result,
    ...(denied ? { denied: true } : {}),
  };

  return {
    event,
    message: {
      role: 'tool',
      content: wrapUntrustedToolResult(call.name, result),
      name: call.name,
      toolCallId: call.id,
    },
  };
}

/**
 * Suspend the turn for a tool-approval decision.
 *
 * Yields `tool_approval_required`, waits on the shared gate registry, records any
 * grant the decision implies, and returns. The caller still holds the original
 * turn pin — resume never re-reads the session mode.
 */
async function* awaitApproval(
  deps: TurnControllerDeps,
  pin: TurnPin,
  scope: Scope,
  tool: string,
  args: Record<string, unknown>,
  digest: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, { decision: ApprovalDecision }> {
  const approval: PendingToolApproval = {
    approvalId: deps.newId(),
    tool,
    arguments: args,
    digest,
    requestedAt: deps.now(),
  };

  const latest = await deps.store.get(pin.sessionId);
  if (latest === null) {
    throw new Error(`Unknown session: ${pin.sessionId}`);
  }
  await persist(deps, pin.sessionId, {
    pending: {
      ...latest.pending,
      toolApprovals: [...latest.pending.toolApprovals, approval],
    },
  });

  const waiter = deps.gates.open<ApprovalDecision>({
    sessionId: pin.sessionId,
    kind: 'tool_approval',
    id: approval.approvalId,
  });

  // Start waiting before yielding so a cancel that arrives while the consumer
  // handles the event rejects a promise that already has a listener.
  const waiting = waiter.wait(signal);

  yield {
    event: 'tool_approval_required',
    sessionId: pin.sessionId,
    ...approval,
  };

  let decision: ApprovalDecision;
  try {
    decision = await waiting;
  } catch (error) {
    await removePendingToolApproval(deps, pin.sessionId, approval.approvalId);
    if (error instanceof GateCancelledError || isAbortError(error) || signal.aborted) {
      throw error instanceof GateCancelledError ? error : abortError();
    }
    throw error;
  }

  await removePendingToolApproval(deps, pin.sessionId, approval.approvalId);

  if (decision !== 'deny') {
    const grant = grantForDecision(
      decision,
      {
        sessionId: pin.sessionId,
        workspaceId: scope.workspaceId,
        tool,
        digest,
      },
      deps.now(),
    );
    if (grant !== null) {
      await deps.grants.add(grant);
      // allow_once: consume the receipt we just wrote so it cannot authorize a
      // later identical call. Wider scopes stay as standing grants.
      if (decision === 'allow_once') {
        await deps.grants.consumeOnce({
          sessionId: pin.sessionId,
          workspaceId: scope.workspaceId,
          tool,
          digest,
        });
      }
    }
  }

  return { decision };
}

async function removePendingToolApproval(
  deps: TurnControllerDeps,
  sessionId: string,
  approvalId: string,
): Promise<void> {
  const latest = await deps.store.get(sessionId);
  if (latest === null) {
    return;
  }
  if (!latest.pending.toolApprovals.some((entry) => entry.approvalId === approvalId)) {
    return;
  }
  await persist(deps, sessionId, {
    pending: {
      ...latest.pending,
      toolApprovals: latest.pending.toolApprovals.filter(
        (entry) => entry.approvalId !== approvalId,
      ),
    },
  });
}

async function invokeTool(
  handler: ToolHandler,
  args: Record<string, unknown>,
  pin: TurnPin,
  scope: Scope,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await handler(args, {
      sessionId: pin.sessionId,
      mode: pin.mode,
      scope,
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      throw error instanceof Error ? error : abortError();
    }
    return `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runLoadSkill(
  deps: TurnControllerDeps,
  pin: TurnPin,
  call: { id: string; name: string; arguments: Record<string, unknown> },
): Promise<{ event: ToolEvent; message: ChatMessage; injection: string }> {
  const args =
    call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments
      : {};
  const requested = typeof args.name === 'string' ? args.name.trim() : '';

  let result: string;
  let denied = false;
  let injection = '';

  if (!pin.toolNames.has(BUILTIN_TOOL_NAMES.loadSkill)) {
    result = `Tool '${BUILTIN_TOOL_NAMES.loadSkill}' is not available in this mode.`;
    denied = true;
  } else if (deps.skills === undefined) {
    result = `Tool '${BUILTIN_TOOL_NAMES.loadSkill}' was denied: no skill catalog is configured.`;
    denied = true;
  } else if (requested === '') {
    result = `Tool '${BUILTIN_TOOL_NAMES.loadSkill}' was denied: 'name' is required.`;
    denied = true;
  } else {
    const skill = await deps.skills.get(requested);
    if (skill === null) {
      result = `Unknown skill '${requested}'.`;
      denied = true;
    } else {
      injection = formatSkillInjection(skill);
      result = `Loaded skill '${skill.name}'.`;
    }
  }

  const event: ToolEvent = {
    name: BUILTIN_TOOL_NAMES.loadSkill,
    arguments: args,
    result,
    ...(denied ? { denied: true } : {}),
  };

  return {
    event,
    injection,
    message: {
      role: 'tool',
      content: wrapUntrustedToolResult(BUILTIN_TOOL_NAMES.loadSkill, result),
      name: BUILTIN_TOOL_NAMES.loadSkill,
      toolCallId: call.id,
    },
  };
}

async function resolveUserTurns(
  deps: TurnControllerDeps,
  inputs: UserTurnInput[],
  ctx: { sessionId: string; mode: ChatModeId; scope: Scope; signal: AbortSignal },
): Promise<{ messages: ChatMessage[]; rows: TranscriptRow[]; promptExtra: string }> {
  const messages: ChatMessage[] = [];
  const rows: TranscriptRow[] = [];
  let promptExtra = '';

  for (const input of inputs) {
    let text = input.text;
    const contextBlocks: string[] = [];

    for (const ref of input.refs ?? []) {
      if (!deps.contextMenus.has(ref.menu)) {
        continue;
      }
      const resolution = await deps.contextMenus.get(ref.menu).resolve({
        ref,
        scope: ctx.scope,
        mode: ctx.mode,
        sessionId: ctx.sessionId,
        text: input.text,
        signal: ctx.signal,
      });

      if (resolution.effect === 'context') {
        contextBlocks.push(
          resolution.label === undefined
            ? resolution.text
            : `${resolution.label}\n${resolution.text}`,
        );
      } else if (resolution.effect === 'prompt') {
        promptExtra = joinExtra(promptExtra, resolution.text);
      } else if (resolution.effect === 'command') {
        if (resolution.replaceText !== undefined) {
          text = resolution.replaceText;
        }
        if (resolution.prompt !== undefined) {
          promptExtra = joinExtra(promptExtra, resolution.prompt);
        }
      }
    }

    const content =
      contextBlocks.length === 0
        ? text
        : `${text}\n\n<context>\n${contextBlocks.join('\n\n')}\n</context>`;

    messages.push({ role: 'user', content });
    rows.push({ kind: 'user', text: content, createdAt: deps.now() });
  }

  return { messages, rows, promptExtra };
}

function composeThread(
  systemPrompt: string,
  stored: ChatMessage[],
  promptExtra: string,
): ChatMessage[] {
  const thread: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...stored];
  mergeIntoLeadingSystemMessage(thread, promptExtra);
  return thread;
}

function joinExtra(current: string, addition: string): string {
  const trimmed = addition.trim();
  if (trimmed === '') return current;
  return current === '' ? trimmed : `${current}\n\n${trimmed}`;
}

async function persist(
  deps: TurnControllerDeps,
  sessionId: string,
  patch: Parameters<typeof applyTurnPatch>[1],
): Promise<SessionRecord> {
  return withSessionLock(deps.store, sessionId, async () => {
    const latest = await deps.store.get(sessionId);
    if (latest === null) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const next = applyTurnPatch(latest, patch, deps.now());
    await deps.store.upsert(next);
    return next;
  });
}

async function persistTerminalAssistant(
  deps: TurnControllerDeps,
  sessionId: string,
  input: {
    message: ChatMessage;
    content: string;
    reasoning: string;
    tools: ToolEvent[];
    usage: SessionRecord['usage'];
  },
): Promise<SessionRecord> {
  return withSessionLock(deps.store, sessionId, async () => {
    const latest = await deps.store.get(sessionId);
    if (latest === null) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return persist(deps, sessionId, {
      messages: [...latest.messages, { ...input.message, content: input.content }],
      transcript: upsertAssistantRow(latest.transcript, {
        kind: 'assistant',
        text: input.content,
        ...(input.tools.length === 0 ? {} : { tools: input.tools }),
        ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
        createdAt: deps.now(),
      }),
      usage: input.usage,
    });
  });
}

async function persistPartial(
  deps: TurnControllerDeps,
  sessionId: string,
  input: {
    content: string;
    reasoning: string;
    tools: ToolEvent[];
    usage: SessionRecord['usage'];
  },
): Promise<SessionRecord> {
  return withSessionLock(deps.store, sessionId, async () => {
    const latest = await deps.store.get(sessionId);
    if (latest === null) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const messages =
      input.content === ''
        ? latest.messages
        : [...latest.messages, { role: 'assistant' as const, content: input.content }];
    return persist(deps, sessionId, {
      messages,
      transcript: upsertAssistantRow(latest.transcript, {
        kind: 'assistant',
        text: input.content,
        ...(input.tools.length === 0 ? {} : { tools: input.tools }),
        ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
        partial: true,
        createdAt: deps.now(),
      }),
      usage: input.usage,
    });
  });
}

async function finishCancelled(
  deps: TurnControllerDeps,
  sessionId: string,
  handle: LiveTurn,
  input: {
    content: string;
    reasoning: string;
    tools: ToolEvent[];
    usage: SessionRecord['usage'];
  },
): Promise<StreamEvent> {
  const current = await deps.store.get(sessionId);
  if (current === null) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const latest = await persist(deps, sessionId, {
    ...(input.content === ''
      ? {}
      : {
          messages: [...current.messages, { role: 'assistant' as const, content: input.content }],
        }),
    transcript: upsertAssistantRow(current.transcript, {
      kind: 'assistant',
      text: input.content,
      ...(input.tools.length === 0 ? {} : { tools: input.tools }),
      ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
      cancelled: true,
      createdAt: deps.now(),
    }),
    usage: input.usage,
    // A cancel while a gate is open must not leave pending rows that a later
    // decision could match after the turn has ended.
    pending: emptyGates(),
  });

  const reason = handle.reason ?? 'operator';
  // Reasoning alone is still worth showing; only a truly empty cancel is quiet.
  const quiet = input.content === '' && input.tools.length === 0 && input.reasoning === '';
  return {
    event: 'cancelled',
    sessionId,
    content: input.content,
    mode: latest.mode,
    title: latest.title,
    tools: input.tools,
    ...(input.reasoning === '' ? {} : { reasoning: input.reasoning }),
    pendingToolApprovals: [],
    pendingPlan: null,
    pendingModeSwitch: null,
    pendingAskUser: null,
    promptTokensTotal: latest.usage.promptTokensTotal,
    completionTokensTotal: latest.usage.completionTokensTotal,
    quiet,
    reason,
  };
}

function upsertAssistantRow(transcript: TranscriptRow[], row: TranscriptRow): TranscriptRow[] {
  const last = transcript.at(-1);
  if (last?.kind === 'assistant' && last.partial === true) {
    return [...transcript.slice(0, -1), row];
  }
  return [...transcript, row];
}

function addUsage(
  current: SessionRecord['usage'],
  delta: { promptTokens: number; completionTokens: number } | null,
): SessionRecord['usage'] {
  if (delta === null) return current;
  return {
    promptTokensTotal: current.promptTokensTotal + delta.promptTokens,
    completionTokensTotal: current.completionTokensTotal + delta.completionTokens,
    lastPromptTokens: delta.promptTokens,
  };
}

function usageEvent(
  _sessionId: string,
  delta: { promptTokens: number; completionTokens: number },
  totals: SessionRecord['usage'],
): StreamEvent {
  return {
    event: 'usage',
    promptTokens: delta.promptTokens,
    completionTokens: delta.completionTokens,
    promptTokensTotal: totals.promptTokensTotal,
    completionTokensTotal: totals.completionTokensTotal,
  };
}

function doneEvent(
  record: SessionRecord,
  content: string,
  tools: ToolEvent[],
  reasoning: string,
): StreamEvent {
  return {
    event: 'done',
    sessionId: record.id,
    content,
    mode: record.mode,
    title: record.title,
    tools,
    ...(reasoning === '' ? {} : { reasoning }),
    pendingToolApprovals: [],
    pendingPlan: null,
    pendingModeSwitch: null,
    pendingAskUser: null,
    promptTokensTotal: record.usage.promptTokensTotal,
    completionTokensTotal: record.usage.completionTokensTotal,
  };
}
