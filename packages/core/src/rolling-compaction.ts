import type { ChatMessage, CompactionSettings } from '@evu/harness-protocol';
import {
  type CompactContext,
  type CompactContextInput,
  DEFAULT_COMPACTION_MAX_MESSAGES,
  estimateMessageTokens,
  truncateContext,
} from './context-compaction.js';
import { mergeIntoLeadingSystemMessage } from './prompts.js';

export interface CompactionState {
  summary: string;
  throughIndex: number;
  updatedAt: string;
}

export interface RollingCompactorDeps {
  loadState: (sessionId: string) => Promise<CompactionState | undefined>;
  saveState: (sessionId: string, state: CompactionState) => Promise<void>;
  getSettings: () => Promise<CompactionSettings>;
  summarize: (text: string) => Promise<string | null>;
  now: () => string;
}

const COMPACT_BATCH = 48;

/**
 * Core-shaped rolling / drop compaction.
 *
 * Idempotent: EvuHarness calls this every tool round. State is keyed by how
 * many non-system messages have already been folded into the summary, so a
 * second call in the same turn does not re-summarize.
 */
export function createRollingCompactor(deps: RollingCompactorDeps): CompactContext {
  return async (input) => {
    const settings = await deps.getSettings();
    if (settings.strategy === 'off') {
      return truncateContext(input.messages, { maxMessages: DEFAULT_COMPACTION_MAX_MESSAGES });
    }

    const { system, rest } = splitSystem(input.messages);
    const state = await deps.loadState(input.sessionId);
    const keepRecent = settings.keepRecent;
    const overBudget = needsCompact(input, state, rest, keepRecent, settings.targetPercent);

    let next = state;
    if (overBudget) {
      const through = alignThrough(rest, state?.throughIndex ?? -1);
      const keepFrom = snapKeepFrom(rest, Math.max(0, rest.length - keepRecent));
      const start = through + 1;
      const end = snapEnd(rest, Math.min(keepFrom, start + COMPACT_BATCH), keepFrom);

      if (end > start) {
        if (settings.strategy === 'drop') {
          next = {
            summary: state?.summary ?? '',
            throughIndex: end - 1,
            updatedAt: deps.now(),
          };
          await deps.saveState(input.sessionId, next);
        } else {
          const chunk = formatBatch(rest.slice(start, end));
          const merged = [state?.summary ?? '', chunk]
            .filter((part) => part.trim() !== '')
            .join('\n\n');
          const summary = await deps.summarize(merged);
          if (summary !== null) {
            next = { summary, throughIndex: end - 1, updatedAt: deps.now() };
            await deps.saveState(input.sessionId, next);
          }
        }
      }
    }

    const through = alignThrough(rest, next?.throughIndex ?? -1);
    const verbatim = rest.slice(through + 1);
    const outbound = [...system, ...verbatim];
    if (next !== undefined && next.summary.trim() !== '') {
      mergeIntoLeadingSystemMessage(outbound, `## Earlier in this conversation\n${next.summary}`);
    }

    return truncateContext(outbound, {
      maxMessages: DEFAULT_COMPACTION_MAX_MESSAGES,
      ...(input.maxContextTokens === undefined
        ? {}
        : { maxTokens: Math.floor((input.maxContextTokens * settings.targetPercent) / 100) }),
    });
  };
}

function splitSystem(messages: ChatMessage[]): { system: ChatMessage[]; rest: ChatMessage[] } {
  let end = 0;
  while (end < messages.length && messages[end]?.role === 'system') {
    end += 1;
  }
  return { system: messages.slice(0, end), rest: messages.slice(end) };
}

function needsCompact(
  input: CompactContextInput,
  state: CompactionState | undefined,
  rest: ChatMessage[],
  keepRecent: number,
  targetPercent: number,
): boolean {
  const through = state?.throughIndex ?? -1;
  const compactable = rest.length - through - 1;
  if (compactable <= keepRecent) return false;

  if (input.maxContextTokens === undefined) {
    return rest.length > keepRecent;
  }

  const used = rest.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const summaryTokens = state === undefined ? 0 : Math.ceil((state.summary.length + 40) / 4);
  return used + summaryTokens > (input.maxContextTokens * targetPercent) / 100;
}

/** Advance past tool results that belong to an already-folded assistant call. */
function alignThrough(rest: ChatMessage[], through: number): number {
  let index = through;
  while (index + 1 < rest.length && rest[index + 1]?.role === 'tool') {
    index += 1;
  }
  return index;
}

/** Do not start the recent tail on an orphan tool result. */
function snapKeepFrom(rest: ChatMessage[], keepFrom: number): number {
  let index = keepFrom;
  while (index < rest.length && rest[index]?.role === 'tool') {
    index += 1;
  }
  return index;
}

/** Do not cut between an assistant tool-call and its results. */
function snapEnd(rest: ChatMessage[], end: number, keepFrom: number): number {
  let snapped = Math.max(0, Math.min(end, keepFrom));
  const last = rest[snapped - 1];
  if (last?.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0) {
    while (snapped < keepFrom && rest[snapped]?.role === 'tool') {
      snapped += 1;
    }
  }
  return snapped;
}

function formatBatch(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const body = message.content.slice(0, 800);
      return `${message.role}: ${body}`;
    })
    .join('\n')
    .slice(0, 12_000);
}
