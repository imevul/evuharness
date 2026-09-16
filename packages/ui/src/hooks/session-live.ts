import type {
  ChatModeId,
  PendingGates,
  SessionDetail,
  ToolEvent,
  TranscriptRow,
  TurnPhase,
} from '@evu/harness-protocol';

/**
 * How often to poll session detail while recovering a live turn after the SSE
 * body dropped. Short enough to feel responsive; long enough to avoid hammering.
 */
export const LIVE_TURN_POLL_MS = 1_000;

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

export interface SplitLiveSession {
  /** Persisted rows only — trailing partial assistant rows are lifted into `turn`. */
  transcript: TranscriptRow[];
  pending: PendingGates;
  /**
   * Reconstructed live turn when `turnInProgress` is set, else null.
   *
   * Mode is the session default: the wire does not expose the pinned turn mode
   * on reload, and recovery only needs a stable composer/status signal.
   */
  turn: LiveTurn | null;
}

/**
 * Split a session detail into transcript rows plus an optional live turn.
 *
 * Used after disconnect or remount: the server keeps the turn running, persists
 * partial assistant rows, and advertises `turnInProgress`. The client cannot
 * reattach to the original SSE body, so it rebuilds UI state from this snapshot
 * and polls until the flag clears.
 */
export function splitLiveSession(detail: SessionDetail): SplitLiveSession {
  const pending = detail.pending;
  if (!detail.turnInProgress) {
    return { transcript: detail.transcript, pending, turn: null };
  }

  const rows = [...detail.transcript];
  const last = rows.at(-1);
  if (last?.kind === 'assistant' && last.partial === true) {
    rows.pop();
    return {
      transcript: rows,
      pending,
      turn: {
        phase: phaseFromPending(pending),
        content: last.text,
        reasoning: last.reasoning ?? '',
        tools: last.tools ?? [],
        mode: detail.mode,
      },
    };
  }

  return {
    transcript: rows,
    pending,
    turn: {
      phase: phaseFromPending(pending),
      content: '',
      reasoning: '',
      tools: [],
      mode: detail.mode,
    },
  };
}

function phaseFromPending(pending: PendingGates): TurnPhase {
  if (
    pending.toolApprovals.length > 0 ||
    pending.plan !== null ||
    pending.modeSwitch !== null ||
    pending.askUser !== null
  ) {
    return 'tools';
  }
  return 'started';
}
