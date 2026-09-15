import type {
  ChatMessage,
  ChatModeId,
  PendingGates,
  SessionUsage,
  TranscriptRow,
} from '@evu/harness-protocol';
import type { SessionRecord } from './session-record.js';

/**
 * An immutable snapshot of everything a turn decided at send time.
 *
 * A turn captures its mode, tool allowlist, and system prompt once and holds them
 * for its whole lifetime, including across tool rounds and gate waits. That is
 * what makes toggling the draft mode in a client free: the toggle stages the next
 * send and cannot reach into a turn already running.
 *
 * A turn that resumes after an approval resumes under its original mode, not
 * whatever a UI is showing by then.
 */
export interface TurnPin {
  readonly sessionId: string;
  readonly mode: ChatModeId;
  readonly toolNames: ReadonlySet<string>;
  readonly systemPrompt: string;
  readonly startedAt: string;
}

export interface CreateTurnPinInput {
  sessionId: string;
  mode: ChatModeId;
  toolNames: Iterable<string>;
  systemPrompt: string;
  startedAt?: string;
}

/**
 * Create a turn pin.
 *
 * Frozen, and the tool set is copied rather than aliased, so a later mutation of
 * the caller's collection cannot retroactively widen what a running turn is
 * allowed to call.
 */
export function createTurnPin(input: CreateTurnPinInput): TurnPin {
  const pin: TurnPin = {
    sessionId: input.sessionId,
    mode: input.mode,
    toolNames: new Set(input.toolNames),
    systemPrompt: input.systemPrompt,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
  return Object.freeze(pin);
}

/** Whether a tool call is permitted under a pin. */
export function pinAllowsTool(pin: TurnPin, toolName: string): boolean {
  return pin.toolNames.has(toolName);
}

/**
 * The fields a turn may persist.
 *
 * `mode` is excluded, and `mode?: never` makes including it a compile error
 * rather than a convention someone has to remember. See `applyTurnPatch` for
 * why this matters.
 */
export interface TurnPatch {
  messages?: ChatMessage[];
  transcript?: TranscriptRow[];
  usage?: SessionUsage;
  pending?: PendingGates;
  title?: string;
  /** Structurally forbidden: a turn must never write the session mode. */
  mode?: never;
}

/**
 * Merge a turn's output into the stored record.
 *
 * The stored `mode` always wins. This is the rule that keeps a mode change made
 * during a live turn from being silently reverted when that turn finishes.
 *
 * It matters because the obvious implementation is wrong. If a turn holds a
 * session object in memory, mutates it, and writes the whole thing back, then a
 * `set-mode` that lands mid-turn is clobbered by the turn's terminal write. That
 * bug hides whenever a store hands the same in-memory instance to both writers,
 * because the mutation happens to be shared — and it appears as soon as the store
 * is durable or the process count is greater than one.
 *
 * So the stored record is the authority for `mode` at persist time, and the patch
 * cannot express one.
 */
export function applyTurnPatch(
  stored: SessionRecord,
  patch: TurnPatch,
  now?: string,
): SessionRecord {
  return {
    ...stored,
    ...(patch.messages === undefined ? {} : { messages: patch.messages }),
    ...(patch.transcript === undefined ? {} : { transcript: patch.transcript }),
    ...(patch.usage === undefined ? {} : { usage: patch.usage }),
    ...(patch.pending === undefined ? {} : { pending: patch.pending }),
    ...(patch.title === undefined ? {} : { title: patch.title }),
    // Never taken from the patch: re-read from storage so a concurrent set-mode
    // survives this write.
    mode: stored.mode,
    updatedAt: now ?? new Date().toISOString(),
  };
}

/** Who is allowed to write the session default mode. */
export type ModeWriter = 'send-time-pin' | 'explicit-set-mode' | 'plan-approval';

export const MODE_WRITERS: readonly ModeWriter[] = [
  'send-time-pin',
  'explicit-set-mode',
  'plan-approval',
];

/**
 * Write the session default mode.
 *
 * Requires naming the writer. The argument is not decoration: it forces a caller
 * to be one of the three sanctioned paths, and makes an unsanctioned write
 * visible at the call site during review.
 */
export function setSessionMode(
  stored: SessionRecord,
  mode: ChatModeId,
  writer: ModeWriter,
  now?: string,
): SessionRecord {
  if (!MODE_WRITERS.includes(writer)) {
    throw new Error(`Unsupported mode writer: ${String(writer)}`);
  }
  if (stored.mode === mode) {
    return stored;
  }
  return { ...stored, mode, updatedAt: now ?? new Date().toISOString() };
}
