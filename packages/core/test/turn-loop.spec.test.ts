/**
 * Turn-loop specification checklist.
 *
 * Streaming, tool rounds, cancellation, and follow-up queue drain are
 * implemented. Remaining groups stay skipped until their sprint. Do not delete
 * a skipped test to make a run green, and do not unskip one without an
 * assertion.
 *
 * `SPEC.md` is the normative description of everything below.
 */

import {
  createHarness,
  FakeProvider,
  InMemorySessionStore,
  type ProviderEvent,
  type SessionStore,
} from '@evu/harness-core';
import { isTerminalEvent, type StreamEvent } from '@evu/harness-protocol';
import { describe, expect, it } from 'vitest';

const ECHO = {
  name: 'echo',
  description: 'echo',
  parameters: {},
  mutates: false,
  approval: 'always_allow' as const,
  handler: (args: Record<string, unknown>) => String(args.text ?? ''),
};

const WRITE = {
  name: 'write_note',
  description: 'write',
  parameters: {},
  handler: () => 'written',
};

function runtime(provider: FakeProvider, overrides: Parameters<typeof createHarness>[0] = {}) {
  return createHarness({
    provider,
    providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
    tools: [ECHO],
    ...overrides,
  });
}

async function collect(
  harness: ReturnType<typeof createHarness>,
  sessionId: string,
  text = 'hi',
  mode = 'ask',
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of harness.runTurn({ sessionId, mode, messages: [{ text }] })) {
    events.push(event);
  }
  return events;
}

function textEvents(text: string): ProviderEvent[] {
  return [
    { kind: 'delta', text },
    { kind: 'usage', promptTokens: 2, completionTokens: 1 },
    { kind: 'message', message: { role: 'assistant', content: text } },
  ];
}

function toolEvents(id: string, name: string, args: Record<string, unknown> = {}): ProviderEvent[] {
  return [
    {
      kind: 'message',
      message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] },
    },
  ];
}

/**
 * Run a turn until the first tool-approval gate opens, then hand control back.
 *
 * `finish` resumes draining the same generator after the caller decides.
 */
async function runUntilApproval(
  harness: ReturnType<typeof createHarness>,
  sessionId: string,
  mode: 'ask' | 'plan' | 'agent' = 'agent',
): Promise<{
  approval: Extract<StreamEvent, { event: 'tool_approval_required' }>;
  events: StreamEvent[];
  finish: () => Promise<StreamEvent[]>;
}> {
  const events: StreamEvent[] = [];
  const iterator = harness
    .runTurn({
      sessionId,
      mode,
      messages: [{ text: 'hi' }],
    })
    [Symbol.asyncIterator]();

  let approval: Extract<StreamEvent, { event: 'tool_approval_required' }> | null = null;
  while (approval === null) {
    const next = await iterator.next();
    if (next.done) {
      throw new Error('Turn ended before an approval gate opened');
    }
    events.push(next.value);
    if (next.value.event === 'tool_approval_required') {
      approval = next.value;
    }
  }

  return {
    approval,
    events,
    finish: async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return events;
        }
        events.push(next.value);
      }
    },
  };
}

describe('turn loop: streaming', () => {
  it('emits status, then deltas, then a terminal done event', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello') }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.map((event) => event.event)).toContain('status');
    expect(events.map((event) => event.event)).toContain('delta');
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'hello' });
  });

  it('emits exactly one terminal event per turn', async () => {
    const harness = runtime(new FakeProvider());
    const session = await harness.createSession({ mode: 'ask' });
    const terminals = (await collect(harness, session.id)).filter((event) =>
      isTerminalEvent(event),
    );

    expect(terminals).toHaveLength(1);
  });

  it('emits nothing after a terminal event', async () => {
    const harness = runtime(new FakeProvider());
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(isTerminalEvent(events.at(-1)!)).toBe(true);
    expect(events.filter((event) => isTerminalEvent(event))).toHaveLength(1);
  });

  it('accumulates delta text into the persisted assistant message', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: [
            { kind: 'delta', text: 'Hel' },
            { kind: 'delta', text: 'lo' },
            { kind: 'message', message: { role: 'assistant', content: 'Hello' } },
          ],
        },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id);
    const stored = await harness.store.get(session.id);

    expect(stored?.messages.some((message) => message.content === 'Hello')).toBe(true);
    expect(stored?.transcript.some((row) => row.kind === 'assistant' && row.text === 'Hello')).toBe(
      true,
    );
  });

  it('emits reasoning_delta only when the provider produces reasoning', async () => {
    const withReason = runtime(
      new FakeProvider([
        {
          events: [
            { kind: 'reasoning_delta', text: 'hmm' },
            { kind: 'delta', text: 'ok' },
            { kind: 'message', message: { role: 'assistant', content: 'ok' } },
          ],
        },
      ]),
    );
    const without = runtime(new FakeProvider([{ events: textEvents('ok') }]));
    const a = await withReason.createSession({ mode: 'ask' });
    const b = await without.createSession({ mode: 'ask' });

    expect(
      (await collect(withReason, a.id)).some((event) => event.event === 'reasoning_delta'),
    ).toBe(true);
    expect((await collect(without, b.id)).some((event) => event.event === 'reasoning_delta')).toBe(
      false,
    );
  });

  it('reports token usage and accumulates session totals', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('ok') }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);
    const usage = events.find((event) => event.event === 'usage');

    expect(usage).toMatchObject({
      event: 'usage',
      promptTokens: 2,
      completionTokens: 1,
      promptTokensTotal: 2,
      completionTokensTotal: 1,
    });
    expect((await harness.getSession(session.id))?.usage).toMatchObject({
      promptTokensTotal: 2,
      completionTokensTotal: 1,
      lastPromptTokens: 2,
    });
  });

  it('surfaces a provider failure as an error event rather than throwing', async () => {
    const harness = runtime(new FakeProvider([{ error: new Error('upstream down') }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.at(-1)).toMatchObject({ event: 'error', message: 'upstream down' });
  });

  it('persists a partial assistant message when the provider dies mid-stream', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: [{ kind: 'delta', text: 'hel' }],
          error: new Error('cut off'),
        },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id);
    const stored = await harness.store.get(session.id);

    expect(stored?.transcript.some((row) => row.kind === 'assistant' && row.text === 'hel')).toBe(
      true,
    );
  });
});

describe('turn loop: tool rounds', () => {
  it('executes a requested tool and feeds the result back to the model', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'ping' }) },
      { events: textEvents('pong') },
    ]);
    const harness = runtime(provider);
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.some((event) => event.event === 'tool' && event.name === 'echo')).toBe(true);
    expect(provider.calls[1]?.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'pong' });
  });

  it('runs several tool rounds until the model stops requesting tools', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'a' }) },
      { events: toolEvents('c2', 'echo', { text: 'b' }) },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider);
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.filter((event) => event.event === 'tool')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'done' });
  });

  it('stops at the configured round cap', async () => {
    let echoes = 0;
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'a' }) },
      { events: toolEvents('c2', 'echo', { text: 'b' }) },
      { events: textEvents('capped') },
    ]);
    const harness = runtime(provider, {
      tools: [
        {
          ...ECHO,
          handler: (args) => {
            echoes += 1;
            return String(args.text ?? '');
          },
        },
      ],
      policies: { maxToolRounds: 1 },
    });
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id);

    expect(echoes).toBe(1);
  });

  it('nudges the model to synthesize an answer when the cap is reached', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'a' }) },
      { events: textEvents('enough') },
    ]);
    const harness = runtime(provider, { policies: { maxToolRounds: 1 } });
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id);
    const last = provider.calls.at(-1);

    expect(last?.tools).toEqual([]);
    expect(last?.messages.some((message) => message.content.includes('maximum number'))).toBe(true);
  });

  it('reports a tool error to the model without ending the turn', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'x' }) },
      { events: textEvents('recovered') },
    ]);
    const harness = runtime(provider, {
      tools: [
        {
          ...ECHO,
          handler: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.some((event) => event.event === 'tool' && event.result.includes('boom'))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'recovered' });
  });

  it('rejects a tool that is not in the turn pin allowlist', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'write_note', { key: 'k', body: 'v' }) },
      { events: textEvents('denied') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);
    const tool = events.find((event) => event.event === 'tool');

    expect(tool).toMatchObject({ name: 'write_note', denied: true });
    expect(events.at(-1)?.event).toBe('done');
  });

  it('rejects a tool outside the pinned mode even when a grant exists', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'write_note', { key: 'k', body: 'v' }) },
      { events: textEvents('still denied') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'ask' });
    await harness.grants.add({
      scope: 'session',
      scopeId: session.id,
      tool: 'write_note',
      createdAt: new Date().toISOString(),
    });
    const events = await collect(harness, session.id);

    expect(events.find((event) => event.event === 'tool')).toMatchObject({ denied: true });
  });

  it('tolerates malformed tool arguments without crashing the turn', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { raw: 'not-json' }) },
      { events: textEvents('ok') },
    ]);
    const harness = runtime(provider, {
      tools: [
        {
          ...ECHO,
          handler: (args) => JSON.parse(String(args.payload)),
        },
      ],
    });
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);

    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'ok' });
  });
});

async function collectCancellingOn(
  harness: ReturnType<typeof createHarness>,
  sessionId: string,
  trigger: StreamEvent['event'],
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of harness.runTurn({
    sessionId,
    mode: 'ask',
    messages: [{ text: 'hi' }],
  })) {
    events.push(event);
    if (event.event === trigger) {
      // Do not await: cancel waits for this generator to finish.
      void harness.cancel(sessionId, 'operator');
    }
  }
  return events;
}

describe('turn loop: cancellation', () => {
  it('stops the provider stream when cancelled', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello world'), delayMs: 40 }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collectCancellingOn(harness, session.id, 'delta');

    expect(events.some((event) => event.event === 'delta')).toBe(true);
    expect(events.at(-1)?.event).toBe('cancelled');
  });

  it('persists whatever text was produced before the cancel', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello world'), delayMs: 40 }]));
    const session = await harness.createSession({ mode: 'ask' });
    await collectCancellingOn(harness, session.id, 'delta');
    const stored = await harness.store.get(session.id);

    expect(stored?.transcript.some((row) => row.kind === 'assistant' && row.text !== '')).toBe(
      true,
    );
  });

  it('marks the persisted transcript row as cancelled', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello'), delayMs: 40 }]));
    const session = await harness.createSession({ mode: 'ask' });
    await collectCancellingOn(harness, session.id, 'delta');

    expect(
      (await harness.store.get(session.id))?.transcript.some((row) => row.cancelled === true),
    ).toBe(true);
  });

  it('emits a cancelled event rather than an error', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello'), delayMs: 40 }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collectCancellingOn(harness, session.id, 'delta');

    expect(events.some((event) => event.event === 'error')).toBe(false);
    expect(events.at(-1)?.event).toBe('cancelled');
  });

  it('reports reason operator for a user-initiated cancel', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello'), delayMs: 40 }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collectCancellingOn(harness, session.id, 'delta');

    expect(events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'operator' });
  });

  it('emits a quiet cancelled event when nothing was produced', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('hello'), delayMs: 80 }]));
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collectCancellingOn(harness, session.id, 'status');

    expect(events.at(-1)).toMatchObject({ event: 'cancelled', quiet: true });
  });

  it('does not leave an orphaned approval waiter that later executes a tool', async () => {
    let executed = false;
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'write_note', { key: 'k', body: 'v' }) },
      { events: textEvents('blocked') },
    ]);
    const harness = runtime(provider, {
      tools: [
        ECHO,
        {
          ...WRITE,
          handler: () => {
            executed = true;
            return 'written';
          },
        },
      ],
    });
    const session = await harness.createSession({ mode: 'agent' });

    const events: StreamEvent[] = [];
    for await (const event of harness.runTurn({
      sessionId: session.id,
      mode: 'agent',
      messages: [{ text: 'hi' }],
    })) {
      events.push(event);
      if (event.event === 'tool_approval_required') {
        // Do not await: cancel waits for this generator to finish.
        void harness.cancel(session.id, 'operator');
      }
    }

    const approval = events.find((event) => event.event === 'tool_approval_required');
    expect(approval).toMatchObject({ event: 'tool_approval_required' });
    expect(events.at(-1)).toMatchObject({ event: 'cancelled' });
    expect(executed).toBe(false);
    expect((await harness.getSession(session.id))?.pending.toolApprovals).toEqual([]);

    if (approval?.event === 'tool_approval_required') {
      await expect(
        harness.decideToolApproval(session.id, approval.approvalId, 'allow_once'),
      ).rejects.toThrow(/No open gate/);
    }
    expect(executed).toBe(false);
  });

  it('aborts an in-flight tool handler via its signal', async () => {
    let sawAbort = false;
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'echo', { text: 'hang' }) },
      { events: textEvents('nope') },
    ]);
    const harness = runtime(provider, {
      tools: [
        {
          ...ECHO,
          handler: async (_args, ctx) => {
            await new Promise<void>((_resolve, reject) => {
              if (ctx.signal.aborted) {
                sawAbort = true;
                reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              ctx.signal.addEventListener('abort', () => {
                sawAbort = true;
                reject(new DOMException('aborted', 'AbortError'));
              });
            });
            return 'never';
          },
        },
      ],
    });
    const session = await harness.createSession({ mode: 'ask' });
    const running = (async () => {
      for await (const _event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        // Drain the stream so cancel can finish the turn.
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.cancel(session.id, 'operator');
    await running;

    expect(sawAbort).toBe(true);
  });
});

describe('turn loop: follow-up queue', () => {
  it('cancels a live turn when a new user message arrives', async () => {
    const harness = runtime(
      new FakeProvider([{ events: textEvents('slow answer'), delayMs: 40 }, { echo: true }]),
    );
    const session = await harness.createSession({ mode: 'ask' });

    const firstEvents: StreamEvent[] = [];
    const first = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        firstEvents.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondEvents = await collect(harness, session.id, 'follow-up');
    await first;

    expect(firstEvents.at(-1)?.event).toBe('cancelled');
    expect(secondEvents.at(-1)?.event).toBe('done');
  });

  it('reports reason follow_up for that cancel', async () => {
    const harness = runtime(
      new FakeProvider([{ events: textEvents('slow answer'), delayMs: 40 }, { echo: true }]),
    );
    const session = await harness.createSession({ mode: 'ask' });

    const firstEvents: StreamEvent[] = [];
    const first = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        firstEvents.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    await collect(harness, session.id, 'follow-up');
    await first;

    expect(firstEvents.at(-1)).toMatchObject({ event: 'cancelled', reason: 'follow_up' });
  });

  it('persists the interrupted turn before starting the next one', async () => {
    const provider = new FakeProvider([
      { events: textEvents('partial text'), delayMs: 40 },
      { echo: true },
    ]);
    const harness = runtime(provider);
    const session = await harness.createSession({ mode: 'ask' });

    let followUp: Promise<StreamEvent[]> | null = null;
    const firstEvents: StreamEvent[] = [];
    const first = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        firstEvents.push(event);
        if (event.event === 'delta' && followUp === null) {
          followUp = collect(harness, session.id, 'second');
        }
      }
    })();
    await first;
    expect(followUp).not.toBeNull();
    await followUp;

    const followUpCall = provider.calls[1];
    expect(followUpCall).toBeDefined();
    const roles = followUpCall?.messages.map((message) => message.role) ?? [];
    const assistantIndex = roles.indexOf('assistant');
    const usersAfterAssistant = followUpCall?.messages
      .slice(assistantIndex + 1)
      .filter((message) => message.role === 'user')
      .map((message) => message.content);

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(followUpCall?.messages[assistantIndex]?.content).toContain('partial');
    expect(usersAfterAssistant).toContain('second');
    expect(firstEvents.at(-1)).toMatchObject({ event: 'cancelled', reason: 'follow_up' });

    const stored = await harness.store.get(session.id);
    expect(stored?.transcript.some((row) => row.cancelled === true)).toBe(true);
  });

  it('drains several queued messages as a single next turn', async () => {
    const provider = new FakeProvider([
      { events: textEvents('interrupted'), delayMs: 60 },
      { echo: true },
    ]);
    const harness = runtime(provider);
    const session = await harness.createSession({ mode: 'ask' });

    const first = (async () => {
      for await (const _event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        // Drain until cancelled.
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 25));

    const followA = collect(harness, session.id, 'alpha');
    const followB = collect(harness, session.id, 'beta');
    const [eventsA, eventsB] = await Promise.all([followA, followB]);
    await first;

    const terminals = [...eventsA, ...eventsB].filter((event) => isTerminalEvent(event));
    expect(terminals.filter((event) => event.event === 'done')).toHaveLength(1);
    // One provider call for the interrupted turn, one for the drained follow-up.
    expect(provider.calls).toHaveLength(2);

    const followUpUsers =
      provider.calls[1]?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content) ?? [];
    // History still includes the interrupted turn's user message; the drain appends both.
    expect(followUpUsers.slice(-2)).toEqual(['alpha', 'beta']);
  });

  it('pins the queued turn to the mode sent with it', async () => {
    const provider = new FakeProvider([
      { events: textEvents('ask turn'), delayMs: 40 },
      { echo: true },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'ask' });

    const first = (async () => {
      for await (const _event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        // Drain until cancelled.
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 25));
    await collect(harness, session.id, 'take over', 'agent');
    await first;

    const followUpTools = provider.calls[1]?.tools.map((tool) => tool.name) ?? [];
    expect(followUpTools).toContain('write_note');
    expect(followUpTools).toContain('echo');
    expect((await harness.getSession(session.id))?.mode).toBe('agent');
  });

  it('preserves queued message order', async () => {
    const provider = new FakeProvider([
      { events: textEvents('interrupted'), delayMs: 60 },
      { echo: true },
    ]);
    const harness = runtime(provider);
    const session = await harness.createSession({ mode: 'ask' });

    const first = (async () => {
      for await (const _event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'first' }],
      })) {
        // Drain until cancelled.
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 25));

    // Enqueue in a known order: first call must land in the queue before the second.
    const second = harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'one' }],
    });
    // Yield so the first follow-up enqueues before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'two' }, { text: 'three' }],
    });

    await Promise.all([
      (async () => {
        for await (const _event of second) {
          // Drain.
        }
      })(),
      (async () => {
        for await (const _event of third) {
          // Drain.
        }
      })(),
      first,
    ]);

    const users =
      provider.calls[1]?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content) ?? [];
    expect(users.slice(-3)).toEqual(['one', 'two', 'three']);

    const stored = await harness.store.get(session.id);
    const userRows = stored?.transcript.filter((row) => row.kind === 'user').map((row) => row.text);
    expect(userRows).toEqual(['first', 'one', 'two', 'three']);
  });
});

describe('turn loop: tool approval gate', () => {
  it('suspends the turn instead of executing a gated tool', async () => {
    let executed = false;
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'x' }) },
        { events: textEvents('done') },
      ]),
      {
        tools: [
          ECHO,
          {
            ...WRITE,
            handler: () => {
              executed = true;
              return 'written';
            },
          },
        ],
      },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);

    expect(executed).toBe(false);
    expect((await harness.getSession(session.id))?.pending.toolApprovals).toHaveLength(1);
    expect(approval.tool).toBe('write_note');

    await harness.decideToolApproval(session.id, approval.approvalId, 'deny');
    await finish();
    expect(executed).toBe(false);
  });

  it('emits tool_approval_required carrying the argument digest', async () => {
    const { digestToolCall } = await import('@evu/harness-core');
    const args = { key: 'k', body: 'v' };
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', args) },
        { events: textEvents('done') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);
    expect(approval).toMatchObject({
      event: 'tool_approval_required',
      tool: 'write_note',
      arguments: args,
      digest: digestToolCall('write_note', args),
      sessionId: session.id,
    });
    await harness.decideToolApproval(session.id, approval.approvalId, 'deny');
    await finish();
  });

  it('resumes and executes the tool after allow_once', async () => {
    let executed = false;
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'x' }) },
        { events: textEvents('done') },
      ]),
      {
        tools: [
          ECHO,
          {
            ...WRITE,
            handler: () => {
              executed = true;
              return 'written';
            },
          },
        ],
      },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);
    expect(executed).toBe(false);
    await harness.decideToolApproval(session.id, approval.approvalId, 'allow_once');
    const events = await finish();
    expect(executed).toBe(true);
    expect(events.find((event) => event.event === 'tool')).toMatchObject({
      name: 'write_note',
      result: 'written',
    });
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'done' });
  });

  it('resumes under the original pinned mode after an approval wait', async () => {
    const { setSessionMode } = await import('@evu/harness-core');
    const seenModes: string[] = [];
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'x' }) },
        { events: textEvents('done') },
      ]),
      {
        tools: [
          ECHO,
          {
            ...WRITE,
            handler: (_args, ctx) => {
              seenModes.push(ctx.mode);
              return 'written';
            },
          },
        ],
      },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);

    const stored = await harness.store.get(session.id);
    expect(stored).not.toBeNull();
    await harness.store.upsert(setSessionMode(stored!, 'ask', 'explicit-set-mode'));
    expect((await harness.getSession(session.id))?.mode).toBe('ask');

    await harness.decideToolApproval(session.id, approval.approvalId, 'allow_once');
    await finish();

    expect(seenModes).toEqual(['agent']);
    expect((await harness.getSession(session.id))?.mode).toBe('ask');
  });

  it('reports a refusal to the model after deny', async () => {
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'x' }) },
        { events: textEvents('understood') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);
    await harness.decideToolApproval(session.id, approval.approvalId, 'deny');
    const events = await finish();

    expect(events.find((event) => event.event === 'tool')).toMatchObject({
      name: 'write_note',
      denied: true,
    });
    const stored = await harness.store.get(session.id);
    const toolMessage = stored?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('UNTRUSTED TOOL RESULT');
    expect(toolMessage?.content).toMatch(/denied by the user/i);
    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'understood' });
  });

  it('does not re-prompt for a tool already granted for the session', async () => {
    let executed = 0;
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'one' }) },
        { events: toolEvents('c2', 'write_note', { body: 'two' }) },
        { events: textEvents('done') },
      ]),
      {
        tools: [
          ECHO,
          {
            ...WRITE,
            handler: () => {
              executed += 1;
              return 'written';
            },
          },
        ],
      },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);
    await harness.decideToolApproval(session.id, approval.approvalId, 'allow_session');
    const events = await finish();

    expect(executed).toBe(2);
    expect(events.filter((event) => event.event === 'tool_approval_required')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'tool')).toHaveLength(2);
  });

  it('re-prompts when the same tool is called with different arguments', async () => {
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'one' }) },
        { events: toolEvents('c2', 'write_note', { body: 'two' }) },
        { events: textEvents('done') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'agent' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'agent',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
        if (event.event === 'tool_approval_required') {
          await harness.decideToolApproval(session.id, event.approvalId, 'allow_once');
        }
      }
    })();
    await running;

    expect(events.filter((event) => event.event === 'tool_approval_required')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'tool')).toHaveLength(2);
  });

  it('does not execute a gated tool before the decision arrives', async () => {
    let executed = false;
    const harness = runtime(
      new FakeProvider([
        { events: toolEvents('c1', 'write_note', { body: 'x' }) },
        { events: textEvents('done') },
      ]),
      {
        tools: [
          ECHO,
          {
            ...WRITE,
            handler: async () => {
              executed = true;
              return 'written';
            },
          },
        ],
      },
    );
    const session = await harness.createSession({ mode: 'agent' });
    const { approval, finish } = await runUntilApproval(harness, session.id);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executed).toBe(false);

    await harness.decideToolApproval(session.id, approval.approvalId, 'allow_once');
    await finish();
    expect(executed).toBe(true);
  });
});

describe('turn loop: plan gate', () => {
  it.skip('suspends the turn when the model proposes a plan', () => {});

  it.skip('switches the session to agent mode on plan approval', () => {});

  it.skip('mints one-shot receipts for the approved plan steps', () => {});

  it.skip('discards the plan and leaves the mode unchanged on discard', () => {});

  it.skip('does not let plan approval widen what the planning turn could do', () => {});
});

describe('turn loop: ask-user gate', () => {
  it.skip('suspends the turn and emits ask_user_required', () => {});

  it.skip('resumes with the answer available to the model', () => {});

  it.skip('supports free-form answers as well as choices', () => {});

  it.skip('records the exchange as transcript rows, not as a tool result', () => {});

  it.skip('rejects an answer for an ask that is no longer pending', () => {});
});

describe('turn loop: mode switch gate', () => {
  it.skip('suspends the turn when the model requests a mode switch', () => {});

  it.skip('writes the session default mode on approval', () => {});

  it.skip('leaves the running turn on its original pinned mode after approval', () => {});

  it.skip('reports the denial to the model on deny', () => {});
});

describe('turn loop: prompt and skills', () => {
  it.skip('builds the system prompt once per turn from the pin', () => {});

  it.skip('merges a loaded skill into the leading system message', () => {});

  it.skip('never inserts a second system message mid-thread', () => {});

  it.skip('applies a context resolver result as an appended context block', () => {});

  it.skip('applies a command resolver result before the turn starts', () => {});
});

describe('turn loop: session persistence', () => {
  it('keeps the model thread and the UI transcript in step', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: [
            { kind: 'delta', text: 'Hel' },
            { kind: 'delta', text: 'lo' },
            { kind: 'message', message: { role: 'assistant', content: 'Hello' } },
          ],
        },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id, 'hi there');
    const stored = await harness.store.get(session.id);

    const userMessages = stored?.messages.filter((message) => message.role === 'user') ?? [];
    const assistantMessages =
      stored?.messages.filter((message) => message.role === 'assistant') ?? [];
    const userRows = stored?.transcript.filter((row) => row.kind === 'user') ?? [];
    const assistantRows = stored?.transcript.filter((row) => row.kind === 'assistant') ?? [];

    expect(userMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(userRows).toHaveLength(1);
    expect(assistantRows).toHaveLength(1);
    expect(userMessages[0]?.content).toBe(userRows[0]?.text);
    expect(assistantMessages[0]?.content).toBe(assistantRows[0]?.text);
    expect(assistantRows[0]).not.toMatchObject({ partial: true });
  });

  it('titles a session from its first user message', async () => {
    const harness = runtime(new FakeProvider([{ events: textEvents('ok') }]));
    const session = await harness.createSession({ mode: 'ask' });
    expect(session.title).toBe('New chat');

    const events = await collect(harness, session.id, 'Restart the api\nand then check logs');

    expect(events.at(-1)).toMatchObject({ event: 'done', title: 'Restart the api' });
    expect(await harness.getSession(session.id)).toMatchObject({ title: 'Restart the api' });
    expect(await harness.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: session.id, title: 'Restart the api' }),
      ]),
    );

    // A later turn must not overwrite a title that has already been derived.
    await collect(harness, session.id, 'something else entirely');
    expect((await harness.getSession(session.id))?.title).toBe('Restart the api');
  });

  it.skip('serializes concurrent turns on one session', () => {});

  it('does not persist on every delta', async () => {
    const base = new InMemorySessionStore();
    let upserts = 0;
    const store: SessionStore = {
      get: (id) => base.get(id),
      upsert: async (record) => {
        upserts += 1;
        await base.upsert(record);
      },
      delete: (id) => base.delete(id),
      listSummaries: (options) => base.listSummaries(options),
    };
    const deltaCount = 5;
    const harness = runtime(
      new FakeProvider([
        {
          events: [
            ...Array.from({ length: deltaCount }, (_, index) => ({
              kind: 'delta' as const,
              text: String(index),
            })),
            { kind: 'usage', promptTokens: 2, completionTokens: 1 },
            { kind: 'message', message: { role: 'assistant', content: '01234' } },
          ],
        },
      ]),
      { store },
    );
    const session = await harness.createSession({ mode: 'ask' });
    const beforeTurn = upserts;
    await collect(harness, session.id);

    // Mode pin + user/title persist + terminal assistant. Deltas must not each write.
    const duringTurn = upserts - beforeTurn;
    expect(duringTurn).toBe(3);
    expect(duringTurn).toBeLessThan(deltaCount);
  });
});

/**
 * `runTurn` exists, so skipped groups above are still the plan for later sprints.
 * This guard fails if that entry point disappears.
 */
describe('checklist guard', () => {
  it('exposes runTurn, so remaining skipped groups must stay honest', () => {
    const harness = createHarness();

    expect(typeof harness.runTurn).toBe('function');
    expect(typeof harness.cancel).toBe('function');
    expect(typeof harness.pinTurn).toBe('function');
  });
});
