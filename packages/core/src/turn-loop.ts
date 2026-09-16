import type {
  ApprovalDecision,
  ChatMessage,
  ChatModeId,
  ChatRequest,
  PendingToolApproval,
  Scope,
  StreamEvent,
  ToolEvent,
  TranscriptRow,
  UserTurnInput,
} from '@evu/harness-protocol';
import type { ContextMenuRegistry } from './context-menus/index.js';
import { abortError, isAbortError, type ProviderAdapter } from './fake-provider.js';
import { GateCancelledError, GateNotFoundError, type GateWaiterRegistry } from './gate-waiters.js';
import { digestToolCall, type GrantStore, grantForDecision, resolveGrant } from './grants.js';
import { applyTurnPatch, type TurnPin } from './mode-pinning.js';
import type { ProviderCompleteInput } from './openai-client.js';
import { mergeIntoLeadingSystemMessage } from './prompts.js';
import {
  DEFAULT_SESSION_TITLE,
  emptyGates,
  type SessionRecord,
  titleFromMessage,
} from './session-record.js';
import type { StoredProviderProfile } from './settings-store.js';
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
  setSessionMode(sessionId: string, mode: ChatModeId): Promise<void>;
  maxToolRounds(): Promise<number>;
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

  await deps.setSessionMode(sessionId, request.mode);

  const scope: Scope = loaded.workspaceId === undefined ? {} : { workspaceId: loaded.workspaceId };
  const pin = await deps.pinTurn({ sessionId, mode: request.mode, scope });

  const profile = await (request.provider?.providerId === undefined
    ? deps.getStoredProvider()
    : deps.getStoredProvider(request.provider.providerId));
  if (profile === null) {
    yield { event: 'error', sessionId, message: 'No provider configured' };
    return;
  }

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

  const promptExtra = resolved.promptExtra;
  const maxToolRounds = await deps.maxToolRounds();
  const pinnedTools = deps.tools.specsForMode(pin.toolNames);
  const model = request.provider?.model ?? profile.model;
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
        ...(request.provider?.effort === undefined ? {} : { effort: request.provider.effort }),
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
        terminal = doneEvent(record, content, turnTools);
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
    if (isAbortError(error) || handle.controller.signal.aborted) {
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
    if (registration.spec.approval === 'requires_approval') {
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
  const latest = await deps.store.get(sessionId);
  if (latest === null) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const next = applyTurnPatch(latest, patch, deps.now());
  await deps.store.upsert(next);
  return next;
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
  const quiet = input.content === '' && input.tools.length === 0;
  return {
    event: 'cancelled',
    sessionId,
    content: input.content,
    mode: latest.mode,
    title: latest.title,
    tools: input.tools,
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

function doneEvent(record: SessionRecord, content: string, tools: ToolEvent[]): StreamEvent {
  return {
    event: 'done',
    sessionId: record.id,
    content,
    mode: record.mode,
    title: record.title,
    tools,
    pendingToolApprovals: [],
    pendingPlan: null,
    pendingModeSwitch: null,
    pendingAskUser: null,
    promptTokensTotal: record.usage.promptTokensTotal,
    completionTokensTotal: record.usage.completionTokensTotal,
  };
}
