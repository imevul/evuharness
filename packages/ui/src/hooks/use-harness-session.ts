import type {
  ApprovalDecision,
  ChatModeId,
  ContextRef,
  PendingGates,
  ProviderOverride,
  SessionDetail,
  StreamEvent,
  ToolEvent,
  TranscriptRow,
  TurnPhase,
} from '@evu/harness-protocol';
import { isTerminalEvent } from '@evu/harness-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessClient } from '../client.js';

export interface LiveTurn {
  phase: TurnPhase;
  /** Assistant text accumulated so far this turn. */
  content: string;
  /** Reasoning text, when the provider exposes it. Never persisted. */
  reasoning: string;
  /** Tool calls seen so far, shown inline while the turn runs. */
  tools: ToolEvent[];
  /** The mode this turn was sent with, which cannot change while it runs. */
  mode: ChatModeId;
}

export interface HarnessSessionState {
  session: SessionDetail | null;
  transcript: TranscriptRow[];
  pending: PendingGates | null;
  /** Null between turns. */
  turn: LiveTurn | null;
  error: string | null;
  /**
   * The mode the composer will send with the next message.
   *
   * Distinct from `session.mode` on purpose. See `setDraftMode`.
   */
  draftMode: ChatModeId;
  setDraftMode: (mode: ChatModeId) => void;
  /**
   * Persist a session-level provider preference.
   *
   * Distinct from a per-turn override passed to `send`. Does not rewrite named
   * settings profiles.
   */
  setSessionProvider: (provider: ProviderOverride | null) => Promise<void>;
  send: (input: {
    text: string;
    refs?: ContextRef[];
    provider?: ProviderOverride;
  }) => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * Resolve a tool-approval gate.
   *
   * Clears the pending row optimistically so the modal does not linger while the
   * turn resumes and executes the tool.
   */
  decideToolApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
  reload: () => Promise<void>;
}

export interface UseHarnessSessionOptions {
  client: HarnessClient;
  sessionId: string | null;
  initialMode: ChatModeId;
  workspaceId?: string;
}

const EMPTY_GATES: PendingGates = {
  toolApprovals: [],
  plan: null,
  modeSwitch: null,
  askUser: null,
};

interface QueuedSend {
  text: string;
  refs: ContextRef[];
  provider?: ProviderOverride;
  /** Draft mode captured at the moment this message was queued. */
  mode: ChatModeId;
}

/**
 * Session state plus the streaming turn.
 *
 * ## Mode ownership
 *
 * Three things called "mode" exist, and conflating any two of them causes the bug
 * this hook is shaped to avoid:
 *
 * - `draftMode` — what the composer control shows. Local. Changing it is free and
 *   has no effect on anything running.
 * - `session.mode` — the stored default, updated only by an explicit `setMode` call
 *   or by a terminal event echoing what the server stored.
 * - `turn.mode` — captured when the message is sent and immutable for that turn.
 *
 * So cycling modes mid-turn is safe: the running turn keeps the mode it was sent
 * with, and the next message picks up whatever the control shows at send time. A
 * UI that wrote the draft straight through to the session would let a keystroke
 * change the tool policy of a turn already choosing tools.
 *
 * ## Follow-up queue
 *
 * Sends that arrive while a turn is live are queued, the live turn is cancelled
 * as `follow_up`, and the queue is drained as one next chat request (last send
 * wins for the mode pin). That matches the core drain and avoids racing several
 * concurrent `/chat` streams for the same session.
 */
export function useHarnessSession(options: UseHarnessSessionOptions): HarnessSessionState {
  const { client, sessionId, initialMode, workspaceId } = options;

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [pending, setPending] = useState<PendingGates | null>(null);
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<ChatModeId>(initialMode);

  const abort = useRef<AbortController | null>(null);
  const followUpQueue = useRef<QueuedSend[]>([]);
  const draining = useRef(false);
  // Keep the latest ids for the drain loop without re-creating it every render.
  const sessionIdRef = useRef(sessionId);
  const workspaceIdRef = useRef(workspaceId);
  const clientRef = useRef(client);
  sessionIdRef.current = sessionId;
  workspaceIdRef.current = workspaceId;
  clientRef.current = client;

  const reload = useCallback(async () => {
    if (sessionId === null) {
      setSession(null);
      setTranscript([]);
      setPending(null);
      return;
    }

    try {
      const detail = await client.getSession(sessionId);
      setSession(detail);
      setTranscript(detail.transcript);
      setPending(detail.pending);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'load_failed');
    }
  }, [client, sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A live stream must not outlive the component. Without this, a turn kept
  // writing into state after unmount and the socket stayed open.
  useEffect(() => () => abort.current?.abort(), []);

  const drainFollowUps = useCallback(async () => {
    if (draining.current) {
      return;
    }
    draining.current = true;

    try {
      while (followUpQueue.current.length > 0) {
        const batch = followUpQueue.current.splice(0);
        const last = batch[batch.length - 1];
        if (last === undefined) {
          break;
        }

        const controller = new AbortController();
        abort.current = controller;
        setError(null);
        setTurn({
          phase: 'started',
          content: '',
          reasoning: '',
          tools: [],
          mode: last.mode,
        });

        try {
          const stream = clientRef.current.chat(
            {
              ...(sessionIdRef.current === null ? {} : { sessionId: sessionIdRef.current }),
              ...(workspaceIdRef.current === undefined
                ? {}
                : { workspaceId: workspaceIdRef.current }),
              mode: last.mode,
              messages: batch.map((entry) => ({
                text: entry.text,
                refs: entry.refs,
              })),
              ...(last.provider === undefined ? {} : { provider: last.provider }),
            },
            controller.signal,
          );

          for await (const event of stream) {
            applyEvent(event, { setTurn, setSession, setTranscript, setPending, setError });
            if (isTerminalEvent(event)) break;
          }
        } catch (cause) {
          // An abort is a cancel the user asked for, not a failure to report.
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : 'stream_failed');
          }
        } finally {
          if (abort.current === controller) abort.current = null;
          setTurn(null);
        }
      }
    } finally {
      draining.current = false;
      // A send may have enqueued after the while check but before this flag cleared.
      if (followUpQueue.current.length > 0) {
        await drainFollowUps();
      }
    }
  }, []);

  const send = useCallback(
    async (input: { text: string; refs?: ContextRef[]; provider?: ProviderOverride }) => {
      // Read once, here: this is the send-time pin for this queued entry.
      const pinnedMode = draftMode;

      followUpQueue.current.push({
        text: input.text,
        refs: input.refs ?? [],
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        mode: pinnedMode,
      });

      // Echo the user's message immediately. The server persists it too, but waiting
      // for the round trip makes the composer feel like it dropped the message.
      setTranscript((rows) => [...rows, { kind: 'user', text: input.text }]);

      if (draining.current) {
        // Cancel the live turn as a follow-up; the drain loop picks up the queue
        // after the cancelled terminal arrives. Do not abort the reader — that
        // would drop the cancelled event the transcript needs.
        if (sessionId !== null) {
          try {
            await client.cancel(sessionId, 'follow_up');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'cancel_failed');
          }
        }
        return;
      }

      await drainFollowUps();
    },
    [client, sessionId, draftMode, drainFollowUps],
  );

  const cancel = useCallback(async () => {
    // Operator cancel drops any queued follow-ups; the user asked to stop.
    followUpQueue.current = [];
    if (sessionId !== null) {
      // Server first: it has to stop the provider call and persist the partial
      // result. Aborting only the local reader would leave the turn running.
      try {
        await client.cancel(sessionId, 'operator');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'cancel_failed');
      }
    }
    abort.current?.abort();
  }, [client, sessionId]);

  const decideToolApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      if (sessionId === null) {
        return;
      }
      setPending((current) =>
        current === null
          ? null
          : {
              ...current,
              toolApprovals: current.toolApprovals.filter(
                (entry) => entry.approvalId !== approvalId,
              ),
            },
      );
      try {
        await client.decideToolApproval(sessionId, approvalId, { decision });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'approval_failed');
        await reload();
      }
    },
    [client, sessionId, reload],
  );

  const setSessionProvider = useCallback(
    async (provider: ProviderOverride | null) => {
      if (sessionId === null) {
        return;
      }
      try {
        const detail = await client.setProvider(sessionId, { provider });
        setSession(detail);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'set_provider_failed');
      }
    },
    [client, sessionId],
  );

  return {
    session,
    transcript,
    pending: pending ?? (session === null ? null : EMPTY_GATES),
    turn,
    error,
    draftMode,
    setDraftMode,
    setSessionProvider,
    send,
    cancel,
    decideToolApproval,
    reload,
  };
}

interface EventSinks {
  setTurn: React.Dispatch<React.SetStateAction<LiveTurn | null>>;
  setSession: React.Dispatch<React.SetStateAction<SessionDetail | null>>;
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptRow[]>>;
  setPending: React.Dispatch<React.SetStateAction<PendingGates | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Fold one stream event into state.
 *
 * Separate from the hook so the reducer is testable without React, and so the
 * exhaustive switch is visible in one screen.
 */
function applyEvent(event: StreamEvent, sinks: EventSinks): void {
  switch (event.event) {
    case 'status':
      sinks.setTurn((current) => (current === null ? null : { ...current, phase: event.phase }));
      return;

    case 'delta':
      sinks.setTurn((current) =>
        current === null ? null : { ...current, content: current.content + event.text },
      );
      return;

    case 'reasoning_delta':
      sinks.setTurn((current) =>
        current === null ? null : { ...current, reasoning: current.reasoning + event.text },
      );
      return;

    case 'system':
      sinks.setTranscript((rows) => [...rows, { kind: 'system', text: event.text }]);
      return;

    // Tool calls accumulate on the live turn rather than becoming their own rows.
    // A transcript row is user, assistant, or system; tools hang off the assistant
    // row they belong to, which the terminal event delivers authoritatively.
    case 'tool':
      sinks.setTurn((current) =>
        current === null
          ? null
          : {
              ...current,
              tools: [
                ...current.tools,
                {
                  name: event.name,
                  arguments: event.arguments,
                  result: event.result,
                  ...(event.denied === undefined ? {} : { denied: event.denied }),
                },
              ],
            },
      );
      return;

    case 'tool_approval_required': {
      const { event: _event, sessionId: _sessionId, ...approval } = event;
      sinks.setPending((current) => ({
        ...(current ?? EMPTY_GATES),
        toolApprovals: [...(current?.toolApprovals ?? []), approval],
      }));
      return;
    }

    case 'ask_user_required': {
      const { event: _event, sessionId: _sessionId, ...ask } = event;
      sinks.setPending((current) => ({ ...(current ?? EMPTY_GATES), askUser: ask }));
      return;
    }

    case 'plan_approval_required': {
      const { event: _event, sessionId: _sessionId, ...plan } = event;
      sinks.setPending((current) => ({ ...(current ?? EMPTY_GATES), plan }));
      return;
    }

    case 'mode_switch_required': {
      const { event: _event, sessionId: _sessionId, ...modeSwitch } = event;
      sinks.setPending((current) => ({ ...(current ?? EMPTY_GATES), modeSwitch }));
      return;
    }

    case 'usage':
      sinks.setSession((current) =>
        current === null
          ? null
          : {
              ...current,
              usage: {
                promptTokensTotal: event.promptTokensTotal,
                completionTokensTotal: event.completionTokensTotal,
                lastPromptTokens: event.promptTokens,
              },
            },
      );
      return;

    case 'done':
    case 'cancelled': {
      // A cancel with nothing produced should not leave an empty bubble behind.
      const suppress = event.event === 'cancelled' && event.quiet && event.content === '';
      if (!suppress) {
        sinks.setTranscript((rows) => [
          ...rows,
          {
            kind: 'assistant',
            text: event.content,
            ...(event.tools.length === 0 ? {} : { tools: event.tools }),
            ...(event.event === 'cancelled' ? { cancelled: true } : {}),
          },
        ]);
      }

      // The terminal event echoes the mode the server has stored. Applying it here
      // resyncs after a gate changed the default; it deliberately does not touch
      // the draft, which belongs to the user.
      sinks.setSession((current) =>
        current === null
          ? null
          : {
              ...current,
              mode: event.mode,
              title: event.title,
              usage: {
                ...current.usage,
                promptTokensTotal: event.promptTokensTotal,
                completionTokensTotal: event.completionTokensTotal,
              },
            },
      );

      sinks.setPending({
        toolApprovals: event.pendingToolApprovals,
        plan: event.pendingPlan,
        modeSwitch: event.pendingModeSwitch,
        askUser: event.pendingAskUser,
      });
      return;
    }

    case 'error':
      sinks.setError(event.message);
      return;
  }
}

export { applyEvent as applyStreamEvent };
