import {
  createHarness,
  createTruncatingCompactor,
  DEFAULT_COMPACTION_MAX_MESSAGES,
  estimateMessageTokens,
  FakeProvider,
  truncateContext,
  type CompactContext,
  type CompactContextInput,
} from '@evu/harness-core';
import type { ChatMessage } from '@evu/harness-protocol';
import { describe, expect, it, vi } from 'vitest';

function msg(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra };
}

describe('truncateContext', () => {
  it('keeps the leading system message and newest tail under maxMessages', () => {
    const messages: ChatMessage[] = [
      msg('system', 'pinned system'),
      msg('user', 'old-1'),
      msg('assistant', 'old-2'),
      msg('user', 'keep-1'),
      msg('assistant', 'keep-2'),
    ];
    const out = truncateContext(messages, { maxMessages: 2 });
    expect(out).toEqual([
      msg('system', 'pinned system'),
      msg('user', 'keep-1'),
      msg('assistant', 'keep-2'),
    ]);
  });

  it('preserves contiguous leading system messages', () => {
    const messages: ChatMessage[] = [
      msg('system', 'a'),
      msg('system', 'b'),
      msg('user', 'u1'),
      msg('user', 'u2'),
    ];
    expect(truncateContext(messages, { maxMessages: 1 })).toEqual([
      msg('system', 'a'),
      msg('system', 'b'),
      msg('user', 'u2'),
    ]);
  });

  it('drops orphan leading tool messages after the cut', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'u0'),
      msg('assistant', '', {
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }],
      }),
      msg('tool', 'result', { toolCallId: 'c1', name: 'echo' }),
      msg('user', 'latest'),
    ];
    const out = truncateContext(messages, { maxMessages: 2 });
    // Tail of 2 would start at the tool result; orphan tool is dropped.
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(out[1]?.content).toBe('latest');
  });

  it('enforces an approximate token budget from the front of the non-system tail', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'aaaa'.repeat(20)),
      msg('assistant', 'bbbb'.repeat(20)),
      msg('user', 'short'),
    ];
    const out = truncateContext(messages, { maxMessages: 50, maxTokens: 20, charsPerToken: 4 });
    expect(out[0]?.role).toBe('system');
    expect(out.at(-1)?.content).toBe('short');
    expect(out.length).toBeLessThan(messages.length);
  });

  it('defaults maxMessages to DEFAULT_COMPACTION_MAX_MESSAGES', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      ...Array.from({ length: DEFAULT_COMPACTION_MAX_MESSAGES + 5 }, (_, i) =>
        msg('user', `u${i}`),
      ),
    ];
    const out = truncateContext(messages);
    expect(out).toHaveLength(1 + DEFAULT_COMPACTION_MAX_MESSAGES);
    expect(out[0]?.content).toBe('sys');
    expect(out[1]?.content).toBe('u5');
  });
});

describe('estimateMessageTokens', () => {
  it('counts content and tool-call payload roughly', () => {
    const tokens = estimateMessageTokens(
      msg('assistant', 'abcd', {
        toolCalls: [{ id: 'id', name: 'echo', arguments: { text: 'hi' } }],
      }),
      4,
    );
    expect(tokens).toBeGreaterThan(1);
  });
});

describe('createTruncatingCompactor', () => {
  it('applies options through the CompactContext signature', async () => {
    const compact = createTruncatingCompactor({ maxMessages: 1 });
    const input: CompactContextInput = {
      messages: [msg('system', 's'), msg('user', 'a'), msg('user', 'b')],
      sessionId: 'sess',
      mode: 'ask',
    };
    await expect(compact(input)).resolves.toEqual([msg('system', 's'), msg('user', 'b')]);
  });
});

describe('harness compactContext hook', () => {
  it('uses the custom hook for the outbound provider thread', async () => {
    const provider = new FakeProvider([{ echo: true }]);
    const hook = vi.fn<CompactContext>(async (input) => [
      msg('system', 'hooked-system'),
      msg('user', `compacted:${input.messages.at(-1)?.content ?? ''}`),
    ]);
    const harness = createHarness({
      provider,
      providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      compactContext: hook,
    });
    const session = await harness.createSession({ mode: 'ask' });
    for await (const _ of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'hello-world' }],
    })) {
      // drain
    }

    expect(hook).toHaveBeenCalledTimes(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages).toEqual([
      msg('system', 'hooked-system'),
      msg('user', 'compacted:hello-world'),
    ]);

    const stored = await harness.getSession(session.id);
    // Wire detail has no messages; check the store via a second turn hook input.
    const provider2 = new FakeProvider([{ echo: true }]);
    let seenStoredTail = '';
    const harness2 = createHarness({
      provider: provider2,
      providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      store: harness.store,
      compactContext: (input) => {
        seenStoredTail = input.messages.map((m) => m.content).join('|');
        return input.messages;
      },
    });
    for await (const _ of harness2.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'next' }],
    })) {
      // drain
    }
    expect(seenStoredTail).toContain('hello-world');
    expect(seenStoredTail).toContain('next');
  });

  it('applies the default truncator without rewriting stored messages', async () => {
    const provider = new FakeProvider([{ echo: true }]);
    const harness = createHarness({
      provider,
      providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      compactContext: createTruncatingCompactor({ maxMessages: 2 }),
      prompts: { global: 'GLOBAL_PROMPT' },
    });
    const session = await harness.createSession({ mode: 'ask' });

    // Seed a long history directly on the store.
    const record = await harness.store.get(session.id);
    if (record === null) throw new Error('missing session');
    const seeded: ChatMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      seeded.push(msg('user', `old-user-${i}`), msg('assistant', `old-asst-${i}`));
    }
    await harness.store.upsert({ ...record, messages: seeded });

    for await (const _ of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'fresh' }],
    })) {
      // drain
    }

    const sent = provider.calls[0]?.messages ?? [];
    expect(sent[0]?.role).toBe('system');
    expect(sent[0]?.content).toContain('GLOBAL_PROMPT');
    // system + at most 2 non-system from the composed thread (history + fresh user)
    expect(sent.filter((m) => m.role !== 'system')).toHaveLength(2);
    expect(sent.at(-1)?.content).toBe('fresh');

    const after = await harness.store.get(session.id);
    expect(after?.messages.filter((m) => m.content.startsWith('old-user-'))).toHaveLength(6);
    expect(after?.messages.some((m) => m.content === 'fresh')).toBe(true);
  });

  it('keeps leading-system merge content when truncating', async () => {
    const provider = new FakeProvider([{ echo: true }]);
    const harness = createHarness({
      provider,
      providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      compactContext: createTruncatingCompactor({ maxMessages: 1 }),
      prompts: { global: 'BASE' },
      contextMenus: [
        {
          id: 'note',
          trigger: '#',
          source: async () => [{ kind: 'item' as const, id: 'n1', label: 'N1' }],
          resolve: async () => ({ effect: 'prompt' as const, text: 'MERGED_EXTRA' }),
        },
      ],
    });
    const session = await harness.createSession({ mode: 'ask' });
    const record = await harness.store.get(session.id);
    if (record === null) throw new Error('missing');
    await harness.store.upsert({
      ...record,
      messages: [msg('user', 'ancient'), msg('assistant', 'reply'), msg('user', 'mid')],
    });

    for await (const _ of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [
        {
          text: '#n1 now',
          refs: [{ menu: 'note', path: [], id: 'n1', token: '#n1' }],
        },
      ],
    })) {
      // drain
    }

    const system = provider.calls[0]?.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('BASE');
    expect(system?.content).toContain('MERGED_EXTRA');
    expect(provider.calls[0]?.messages.filter((m) => m.role !== 'system')).toHaveLength(1);
  });
});
