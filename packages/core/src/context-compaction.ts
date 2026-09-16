import type { ChatMessage, ChatModeId } from '@evu/harness-protocol';

/**
 * Input to the host-overridable context compaction hook.
 *
 * Called each time the turn loop builds the model thread for a provider
 * `complete` call (once per tool round, including the first). Compaction
 * reshapes only the outbound thread — stored session messages are untouched.
 */
export interface CompactContextInput {
  /** Thread after system composition and leading-system merge. */
  messages: ChatMessage[];
  sessionId: string;
  mode: ChatModeId;
  /** Resolved model context window when the catalog or an override knows one. */
  maxContextTokens?: number;
}

/**
 * Host-overridable compaction hook.
 *
 * Must preserve a leading system message when present so mode pinning and
 * skill / prompt-extra merges stay intact. Returning a thread that drops the
 * leading system message is allowed but almost always wrong.
 */
export type CompactContext = (
  input: CompactContextInput,
) => ChatMessage[] | Promise<ChatMessage[]>;

/** Default non-system message cap for the naive truncating compactor. */
export const DEFAULT_COMPACTION_MAX_MESSAGES = 48;

export interface TruncatingCompactorOptions {
  /**
   * Keep at most this many non-system messages, newest first.
   * Defaults to {@link DEFAULT_COMPACTION_MAX_MESSAGES}.
   */
  maxMessages?: number;
  /**
   * Approximate token budget for the whole outbound thread (system included).
   * When omitted, only the message cap applies.
   */
  maxTokens?: number;
  /** Rough characters-per-token estimate. Defaults to 4. */
  charsPerToken?: number;
}

/**
 * Rough token estimate for budget checks.
 *
 * Not a real tokenizer — good enough for a naive truncator. Counts content,
 * tool-call payloads, and common id fields.
 */
export function estimateMessageTokens(message: ChatMessage, charsPerToken = 4): number {
  const divisor = charsPerToken > 0 ? charsPerToken : 4;
  let chars = message.content.length;
  if (message.name !== undefined) {
    chars += message.name.length;
  }
  if (message.toolCallId !== undefined) {
    chars += message.toolCallId.length;
  }
  for (const call of message.toolCalls ?? []) {
    chars += call.id.length + call.name.length;
    try {
      chars += JSON.stringify(call.arguments).length;
    } catch {
      chars += 8;
    }
  }
  return Math.max(1, Math.ceil(chars / divisor));
}

/**
 * Naive truncating compaction: keep the leading system message(s) and the
 * newest tail of the thread within a message and/or token budget.
 *
 * Drops orphan leading `tool` messages after the cut so a provider never sees
 * tool results without their assistant `toolCalls` parent.
 */
export function truncateContext(
  messages: ChatMessage[],
  options: TruncatingCompactorOptions = {},
): ChatMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const maxMessages = options.maxMessages ?? DEFAULT_COMPACTION_MAX_MESSAGES;
  const charsPerToken = options.charsPerToken ?? 4;
  const maxTokens = options.maxTokens;

  let systemEnd = 0;
  while (systemEnd < messages.length && messages[systemEnd]?.role === 'system') {
    systemEnd += 1;
  }
  const system = messages.slice(0, systemEnd);
  let rest = messages.slice(systemEnd);

  if (rest.length > maxMessages) {
    rest = rest.slice(rest.length - maxMessages);
  }

  if (maxTokens !== undefined) {
    const systemTokens = system.reduce(
      (sum, message) => sum + estimateMessageTokens(message, charsPerToken),
      0,
    );
    while (rest.length > 1) {
      const restTokens = rest.reduce(
        (sum, message) => sum + estimateMessageTokens(message, charsPerToken),
        0,
      );
      if (systemTokens + restTokens <= maxTokens) {
        break;
      }
      rest = rest.slice(1);
    }
  }

  rest = dropLeadingOrphanToolMessages(rest);
  return [...system, ...rest];
}

/**
 * Build a {@link CompactContext} that applies {@link truncateContext}.
 *
 * This is the stock default. Hosts that want summarization or a no-op replace
 * the hook on `createHarness({ compactContext })`.
 */
export function createTruncatingCompactor(
  options: TruncatingCompactorOptions = {},
): CompactContext {
  return (input) =>
    truncateContext(input.messages, {
      maxMessages: options.maxMessages ?? DEFAULT_COMPACTION_MAX_MESSAGES,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.charsPerToken === undefined ? {} : { charsPerToken: options.charsPerToken }),
    });
}

/** Stock naive truncator used when the host does not supply a hook. */
export const defaultCompactContext: CompactContext = createTruncatingCompactor();

function dropLeadingOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role === 'tool') {
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}
