import { type CompactionState, createRollingCompactor } from '@evu/harness-core';
import type { ChatMessage } from '@evu/harness-protocol';
import { describe, expect, it, vi } from 'vitest';

function msg(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra };
}

function thread(): ChatMessage[] {
  return [
    msg('system', 'base system'),
    msg('user', 'old-1'),
    msg('assistant', 'old-2'),
    msg('user', 'mid-1'),
    msg('assistant', 'mid-2'),
    msg('user', 'keep-1'),
    msg('assistant', 'keep-2'),
  ];
}

describe('rolling compaction', () => {
  it('is idempotent across repeated tool-round calls', async () => {
    let state: CompactionState | undefined;
    const summarize = vi.fn(async () => 'folded earlier turns');
    const compact = createRollingCompactor({
      loadState: async () => state,
      saveState: async (_id, next) => {
        state = next;
      },
      getSettings: async () => ({ strategy: 'rolling', targetPercent: 75, keepRecent: 2 }),
      summarize,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const input = { messages: thread(), sessionId: 's1', mode: 'agent' as const };
    const first = await compact(input);
    const second = await compact(input);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]?.content).toContain('## Earlier in this conversation');
    expect(first[0]?.content).toContain('folded earlier turns');
    expect(first.map((message) => message.content)).toContain('keep-1');
  });

  it('does not split an assistant tool-call from its results', async () => {
    let state: CompactionState | undefined;
    const compact = createRollingCompactor({
      loadState: async () => state,
      saveState: async (_id, next) => {
        state = next;
      },
      getSettings: async () => ({ strategy: 'drop', targetPercent: 75, keepRecent: 2 }),
      summarize: async () => {
        throw new Error('drop must not summarize');
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'u0'),
      msg('assistant', '', {
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }],
      }),
      msg('tool', 'echo-result', { toolCallId: 'c1', name: 'echo' }),
      msg('user', 'latest-user'),
      msg('assistant', 'latest-assistant'),
    ];

    const out = await compact({ messages, sessionId: 's1', mode: 'agent' });
    const roles = out.map((message) => message.role);

    for (let index = 0; index < out.length; index += 1) {
      if (out[index]?.role !== 'tool') continue;
      const parent = out[index - 1];
      expect(parent?.role).toBe('assistant');
      expect(parent?.toolCalls?.some((call) => call.id === out[index]?.toolCallId)).toBe(true);
    }
    expect(roles.at(-1)).toBe('assistant');
    expect(
      out.some((message) => message.content === 'echo-result') || !roles.includes('tool'),
    ).toBe(true);
  });

  it('falls back to the truncator when summarize fails', async () => {
    const compact = createRollingCompactor({
      loadState: async () => undefined,
      saveState: async () => {
        throw new Error('should not save on failure');
      },
      getSettings: async () => ({ strategy: 'rolling', targetPercent: 75, keepRecent: 2 }),
      summarize: async () => null,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const out = await compact({ messages: thread(), sessionId: 's1', mode: 'agent' });
    expect(out[0]?.content).toBe('base system');
    expect(out.map((message) => message.content)).toContain('keep-2');
    expect(out[0]?.content).not.toContain('Earlier in this conversation');
  });
});
