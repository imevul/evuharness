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
  digestToolCall,
  FakeProvider,
  InMemorySessionStore,
  type ProviderEvent,
  resolveGrant,
  type SessionStore,
  skillsMenu,
  staticSkillCatalog,
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

  it('persists reasoning on the transcript row and echoes it on done, not in content', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: [
            { kind: 'reasoning_delta', text: 'plan A' },
            { kind: 'delta', text: 'ship it' },
            { kind: 'message', message: { role: 'assistant', content: 'ship it' } },
          ],
        },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id);
    const done = events.find((event) => event.event === 'done');
    const stored = await harness.store.get(session.id);
    const assistant = stored?.transcript.find((row) => row.kind === 'assistant');

    expect(done).toMatchObject({
      event: 'done',
      content: 'ship it',
      reasoning: 'plan A',
    });
    expect(assistant).toMatchObject({
      text: 'ship it',
      reasoning: 'plan A',
    });
    expect(stored?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'ship it',
    });
    expect(JSON.stringify(stored?.messages)).not.toContain('plan A');
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

  it('does not mark a cancel quiet when only reasoning was produced', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: [
            { kind: 'reasoning_delta', text: 'still thinking' },
            { kind: 'delta', text: 'should not land' },
            {
              kind: 'message',
              message: { role: 'assistant', content: 'should not land' },
            },
          ],
          delayMs: 40,
        },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collectCancellingOn(harness, session.id, 'reasoning_delta');
    const cancelled = events.find((event) => event.event === 'cancelled');

    expect(cancelled).toMatchObject({
      event: 'cancelled',
      quiet: false,
      content: '',
      reasoning: 'still thinking',
    });
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
  it('suspends the turn when the model proposes a plan', async () => {
    const provider = new FakeProvider([
      {
        events: toolEvents('c1', 'propose_plan', {
          title: 'Roll out',
          steps: [{ tool: 'write_note', summary: 'write', arguments: { key: 'a', body: 'b' } }],
        }),
      },
      { events: textEvents('after plan') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'plan' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'plan',
        messages: [{ text: 'plan it' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'plan_approval_required'));
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect((await harness.getSession(session.id))?.pending.plan?.title).toBe('Roll out');

    await harness.approvePlan(session.id);
    await running;

    expect(events.some((event) => event.event === 'plan_approval_required')).toBe(true);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('switches the session to agent mode on plan approval', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'propose_plan', {
            title: 'Roll out',
            steps: [{ summary: 'look around' }],
          }),
        },
        { events: textEvents('done') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'plan' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'plan',
        messages: [{ text: 'plan' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'plan_approval_required'));
    expect((await harness.getSession(session.id))?.mode).toBe('plan');
    await harness.approvePlan(session.id);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('agent');
    expect(events.at(-1)).toMatchObject({ event: 'done', mode: 'agent' });
  });

  it('mints one-shot receipts for the approved plan steps', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'propose_plan', {
            title: 'Write',
            steps: [
              { tool: 'write_note', summary: 'write', arguments: { key: 'k', body: 'v' } },
              { summary: 'no tool, no receipt' },
            ],
          }),
        },
        { events: textEvents('done') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'plan' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'plan',
        messages: [{ text: 'plan' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'plan_approval_required'));
    await harness.approvePlan(session.id);
    await running;

    const digest = digestToolCall('write_note', { key: 'k', body: 'v' });
    const resolved = await resolveGrant(harness.grants, {
      sessionId: session.id,
      tool: 'write_note',
      digest,
    });
    expect(resolved).toMatchObject({ allowed: true, consumedReceipt: true });

    const again = await resolveGrant(harness.grants, {
      sessionId: session.id,
      tool: 'write_note',
      digest,
    });
    expect(again.allowed).toBe(false);
  });

  it('discards the plan and leaves the mode unchanged on discard', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'propose_plan', {
            title: 'Nope',
            steps: [{ summary: 'skip' }],
          }),
        },
        { events: textEvents('ok') },
      ]),
      { tools: [ECHO, WRITE] },
    );
    const session = await harness.createSession({ mode: 'plan' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'plan',
        messages: [{ text: 'plan' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'plan_approval_required'));
    await harness.discardPlan(session.id);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('plan');
    expect((await harness.getSession(session.id))?.pending.plan).toBeNull();
    const tool = events.find((event) => event.event === 'tool');
    expect(tool).toMatchObject({ event: 'tool', name: 'propose_plan' });
    expect(String((tool as { result: string }).result)).toMatch(/discarded/i);
  });

  it('does not let plan approval widen what the planning turn could do', async () => {
    const provider = new FakeProvider([
      {
        events: toolEvents('c1', 'propose_plan', {
          title: 'Then write',
          steps: [{ tool: 'write_note', summary: 'write', arguments: { key: 'k', body: 'v' } }],
        }),
      },
      {
        events: toolEvents('c2', 'write_note', { key: 'k', body: 'v' }),
      },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'plan' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'plan',
        messages: [{ text: 'plan' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'plan_approval_required'));
    await harness.approvePlan(session.id);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('agent');
    const write = events.find(
      (event) => event.event === 'tool' && (event as { name: string }).name === 'write_note',
    );
    expect(write).toMatchObject({
      event: 'tool',
      name: 'write_note',
      denied: true,
    });
    // The second provider round still saw only the plan-mode allowlist.
    const secondCallTools = provider.calls[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(secondCallTools).toContain('propose_plan');
    expect(secondCallTools).not.toContain('write_note');
  });
});

describe('turn loop: ask-user gate', () => {
  const ASK = {
    name: 'ask_user',
    description: 'ask',
    parameters: {},
    mutates: false,
    approval: 'always_allow' as const,
    builtin: true,
    handler: () => 'should not run',
  };

  const QUESTIONS = {
    questions: [
      {
        id: 'q1',
        prompt: 'Ship it?',
        choices: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        allowMultiple: false,
        allowFreeForm: true,
      },
    ],
  };

  it('suspends the turn and emits ask_user_required', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'ask_user', QUESTIONS) },
      { events: textEvents('thanks') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, ASK] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'ask_user_required'));
    const gate = events.find((event) => event.event === 'ask_user_required');
    expect(gate).toMatchObject({
      event: 'ask_user_required',
      sessionId: session.id,
      questions: [expect.objectContaining({ id: 'q1', prompt: 'Ship it?' })],
    });
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect((await harness.getSession(session.id))?.pending.askUser?.askId).toBe(
      (gate as { askId: string }).askId,
    );

    await harness.answerAskUser(session.id, (gate as { askId: string }).askId, [
      { questionId: 'q1', selected: ['yes'] },
    ]);
    await running;
  });

  it('resumes with the answer available to the model', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'ask_user', QUESTIONS) },
      { events: textEvents('got it') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, ASK] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'ask_user_required'));
    const askId = (events.find((event) => event.event === 'ask_user_required') as { askId: string })
      .askId;
    await harness.answerAskUser(session.id, askId, [{ questionId: 'q1', selected: ['yes'] }]);
    await running;

    expect(events.at(-1)).toMatchObject({ event: 'done', content: 'got it' });
    const modelThread = provider.calls[1]?.messages ?? [];
    expect(
      modelThread.some(
        (message) =>
          message.role === 'tool' && message.name === 'ask_user' && message.content.includes('Yes'),
      ),
    ).toBe(true);
  });

  it('supports free-form answers as well as choices', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'ask_user', QUESTIONS) },
      { events: textEvents('noted') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, ASK] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'ask_user_required'));
    const askId = (events.find((event) => event.event === 'ask_user_required') as { askId: string })
      .askId;
    await harness.answerAskUser(session.id, askId, [
      { questionId: 'q1', selected: ['no'], text: 'not yet — wait for review' },
    ]);
    await running;

    const modelThread = provider.calls[1]?.messages ?? [];
    const toolMessage = modelThread.find(
      (message) => message.role === 'tool' && message.name === 'ask_user',
    );
    expect(toolMessage?.content).toContain('No');
    expect(toolMessage?.content).toContain('not yet — wait for review');
  });

  it('records the exchange as transcript rows, not as a tool result', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'ask_user', QUESTIONS) },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, ASK] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'ask_user_required'));
    const askId = (events.find((event) => event.event === 'ask_user_required') as { askId: string })
      .askId;
    await harness.answerAskUser(session.id, askId, [{ questionId: 'q1', selected: ['yes'] }]);
    await running;

    expect(events.some((event) => event.event === 'tool' && event.name === 'ask_user')).toBe(false);

    const stored = await harness.store.get(session.id);
    expect(
      stored?.transcript.some((row) => row.kind === 'system' && row.text.includes('Ship it?')),
    ).toBe(true);
    expect(stored?.transcript.some((row) => row.kind === 'user' && row.text.includes('Yes'))).toBe(
      true,
    );
    expect(
      stored?.transcript.some(
        (row) => row.kind === 'assistant' && row.tools?.some((tool) => tool.name === 'ask_user'),
      ),
    ).toBe(false);
  });

  it('rejects an answer for an ask that is no longer pending', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'ask_user', QUESTIONS) },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, ASK] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'hi' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'ask_user_required'));
    const askId = (events.find((event) => event.event === 'ask_user_required') as { askId: string })
      .askId;
    await harness.answerAskUser(session.id, askId, [{ questionId: 'q1', selected: ['yes'] }]);
    await running;

    await expect(
      harness.answerAskUser(session.id, askId, [{ questionId: 'q1', selected: ['no'] }]),
    ).rejects.toMatchObject({ name: 'GateNotFoundError' });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('turn loop: mode switch gate', () => {
  it('suspends the turn when the model requests a mode switch', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'request_mode_switch', {
            to: 'agent',
            reason: 'need writes',
          }),
        },
        { events: textEvents('switched') },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'switch' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'mode_switch_required'));
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect((await harness.getSession(session.id))?.pending.modeSwitch?.to).toBe('agent');

    await harness.decideModeSwitch(session.id, true);
    await running;

    expect(events.at(-1)?.event).toBe('done');
  });

  it('writes the session default mode on approval', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'request_mode_switch', {
            to: 'agent',
            reason: 'need writes',
          }),
        },
        { events: textEvents('ok') },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'switch' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'mode_switch_required'));
    await harness.decideModeSwitch(session.id, true);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('agent');
    expect(events.at(-1)).toMatchObject({ event: 'done', mode: 'agent' });
  });

  it('leaves the running turn on its original pinned mode after approval', async () => {
    const provider = new FakeProvider([
      {
        events: toolEvents('c1', 'request_mode_switch', {
          to: 'agent',
          reason: 'need writes',
        }),
      },
      {
        events: toolEvents('c2', 'write_note', { key: 'k', body: 'v' }),
      },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'switch' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'mode_switch_required'));
    await harness.decideModeSwitch(session.id, true);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('agent');
    const write = events.find(
      (event) => event.event === 'tool' && (event as { name: string }).name === 'write_note',
    );
    expect(write).toMatchObject({ denied: true });
    const secondTools = provider.calls[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(secondTools).not.toContain('write_note');
  });

  it('reports the denial to the model on deny', async () => {
    const harness = runtime(
      new FakeProvider([
        {
          events: toolEvents('c1', 'request_mode_switch', {
            to: 'agent',
            reason: 'need writes',
          }),
        },
        { events: textEvents('staying') },
      ]),
    );
    const session = await harness.createSession({ mode: 'ask' });

    const events: StreamEvent[] = [];
    const running = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'switch' }],
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => events.some((event) => event.event === 'mode_switch_required'));
    await harness.decideModeSwitch(session.id, false);
    await running;

    expect((await harness.getSession(session.id))?.mode).toBe('ask');
    const tool = events.find((event) => event.event === 'tool');
    expect(tool).toMatchObject({
      event: 'tool',
      name: 'request_mode_switch',
      denied: true,
    });
    expect(String((tool as { result: string }).result)).toMatch(/denied/i);
  });
});

describe('turn loop: prompt and skills', () => {
  it.skip('builds the system prompt once per turn from the pin', () => {});

  it('merges a loaded skill into the leading system message', async () => {
    const catalog = staticSkillCatalog([
      {
        id: 'review',
        name: 'review',
        description: 'Review carefully',
        body: 'Always read the diff first.',
      },
    ]);
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'load_skill', { name: 'review' }) },
      { events: textEvents('done reviewing') },
    ]);
    const harness = runtime(provider, { skills: catalog });
    const session = await harness.createSession({ mode: 'ask' });
    const events = await collect(harness, session.id, 'please review');

    expect(events.some((event) => event.event === 'tool' && event.name === 'load_skill')).toBe(
      true,
    );
    expect(provider.calls).toHaveLength(2);
    const systemMessages = provider.calls[1]?.messages.filter(
      (message) => message.role === 'system',
    );
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages?.[0]?.content).toContain('Always read the diff first.');
    expect(systemMessages?.[0]?.content).toContain('Loaded skill: review');
  });

  it('never inserts a second system message mid-thread', async () => {
    const catalog = staticSkillCatalog([
      {
        id: 'review',
        name: 'review',
        description: 'Review carefully',
        body: 'Skill body for merge.',
      },
    ]);
    const provider = new FakeProvider([
      { events: textEvents('first answer') },
      { events: toolEvents('c1', 'load_skill', { name: 'review' }) },
      { events: textEvents('after skill') },
    ]);
    const harness = runtime(provider, {
      skills: catalog,
      contextMenus: [skillsMenu({ catalog })],
    });
    const session = await harness.createSession({ mode: 'ask' });
    await collect(harness, session.id, 'hello');
    await collect(harness, session.id, 'load it');

    const secondTurn = provider.calls.slice(1);
    expect(secondTurn.length).toBeGreaterThanOrEqual(2);
    for (const call of secondTurn) {
      const systems = call.messages.filter((message) => message.role === 'system');
      expect(systems).toHaveLength(1);
    }
    const afterLoad = secondTurn.at(-1)?.messages.find((message) => message.role === 'system');
    expect(afterLoad?.content).toContain('Skill body for merge.');
  });

  it('merges a slash-picked skill into the leading system message', async () => {
    const catalog = staticSkillCatalog([
      {
        id: 'review',
        name: 'review',
        description: 'Review carefully',
        body: 'Slash-injected skill body.',
      },
    ]);
    const provider = new FakeProvider([{ events: textEvents('ok') }]);
    const harness = runtime(provider, {
      skills: catalog,
      contextMenus: [skillsMenu({ catalog })],
    });
    const session = await harness.createSession({ mode: 'ask' });
    for await (const _event of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [
        {
          text: '/review please',
          refs: [{ menu: 'commands', path: [], id: 'review', token: '/review' }],
        },
      ],
    })) {
      // drain
    }

    const system = provider.calls[0]?.messages.find((message) => message.role === 'system');
    expect(system?.content).toContain('Slash-injected skill body.');
    expect(provider.calls[0]?.messages.filter((message) => message.role === 'system')).toHaveLength(
      1,
    );
  });

  it.skip('applies a context resolver result as an appended context block', () => {});

  it.skip('applies a command resolver result before the turn starts', () => {});
});

describe('turn loop: provider overrides', () => {
  it('uses turn > session > settings for model and effort', async () => {
    const provider = new FakeProvider([{ events: textEvents('ok') }]);
    const harness = createHarness({
      provider,
      providers: [
        { id: 'local', baseUrl: 'https://local.test/v1', model: 'settings-model' },
        { id: 'cloud', baseUrl: 'https://cloud.test/v1', model: 'cloud-model' },
      ],
      activeProviderId: 'local',
    });
    const session = await harness.createSession({ mode: 'ask' });
    await harness.store.upsert({
      ...(await harness.store.get(session.id))!,
      provider: { providerId: 'cloud', model: 'session-model', effort: 'low' },
    });

    for await (const _event of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [{ text: 'hi' }],
      provider: { model: 'turn-model', effort: 'high' },
    })) {
      // drain
    }

    expect(provider.calls[0]).toMatchObject({ model: 'turn-model', effort: 'high' });
    // Session preference is unchanged by a per-turn override.
    expect((await harness.store.get(session.id))?.provider).toEqual({
      providerId: 'cloud',
      model: 'session-model',
      effort: 'low',
    });
    // Settings profile is unchanged.
    expect((await harness.getSettings()).providers.find((p) => p.id === 'cloud')?.model).toBe(
      'cloud-model',
    );
  });

  it('falls back from turn to session to settings', async () => {
    const provider = new FakeProvider([
      { events: textEvents('a') },
      { events: textEvents('b') },
      { events: textEvents('c') },
    ]);
    const harness = createHarness({
      provider,
      providers: [
        { id: 'local', baseUrl: 'https://local.test/v1', model: 'settings-model' },
        { id: 'cloud', baseUrl: 'https://cloud.test/v1', model: 'cloud-model' },
      ],
      activeProviderId: 'local',
    });

    const settingsOnly = await harness.createSession({ mode: 'ask' });
    await collect(harness, settingsOnly.id);
    expect(provider.calls[0]?.model).toBe('settings-model');

    const withSession = await harness.createSession({ mode: 'ask' });
    await harness.store.upsert({
      ...(await harness.store.get(withSession.id))!,
      provider: { providerId: 'cloud', effort: 'medium' },
    });
    await collect(harness, withSession.id);
    expect(provider.calls[1]).toMatchObject({ model: 'cloud-model', effort: 'medium' });

    for await (const _event of harness.runTurn({
      sessionId: withSession.id,
      mode: 'ask',
      messages: [{ text: 'again' }],
      provider: { effort: 'minimal' },
    })) {
      // drain
    }
    expect(provider.calls[2]).toMatchObject({ model: 'cloud-model', effort: 'minimal' });
  });

  it('does not let a turn write wipe a concurrent session provider preference', async () => {
    const store: SessionStore = new InMemorySessionStore();
    const provider = new FakeProvider([
      {
        events: textEvents('ok'),
        delayMs: 20,
      },
    ]);
    const harness = createHarness({
      store,
      cache: false,
      provider,
      providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
    });
    const session = await harness.createSession({ mode: 'ask' });

    const turn = collect(harness, session.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsert({
      ...(await store.get(session.id))!,
      provider: { model: 'kept' },
    });
    await turn;

    expect((await store.get(session.id))?.provider).toEqual({ model: 'kept' });
  });
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

  it('serializes concurrent turns on one session', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const base = new InMemorySessionStore();
    const store: SessionStore = {
      get: (id) => base.get(id),
      upsert: async (record) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        await base.upsert(record);
        inFlight -= 1;
      },
      delete: (id) => base.delete(id),
      listSummaries: (options) => base.listSummaries(options),
    };

    const harness = runtime(
      new FakeProvider([{ events: textEvents('one'), delayMs: 40 }, { echo: true }]),
      { store },
    );
    const session = await harness.createSession({ mode: 'ask' });

    const firstEvents: StreamEvent[] = [];
    const first = (async () => {
      for await (const event of harness.runTurn({
        sessionId: session.id,
        mode: 'ask',
        messages: [{ text: 'alpha' }],
      })) {
        firstEvents.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondEvents = await collect(harness, session.id, 'beta');
    await first;

    // Follow-up queue + per-session store lock: at most one durable write at a time.
    expect(maxInFlight).toBe(1);

    const terminals = [firstEvents.at(-1), secondEvents.at(-1)].filter(Boolean);
    expect(terminals.some((event) => event?.event === 'done')).toBe(true);
    expect(
      terminals.every(
        (event) => event?.event === 'done' || event?.event === 'cancelled' || event === undefined,
      ),
    ).toBe(true);

    const stored = await harness.store.get(session.id);
    const userTexts = (stored?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    expect(userTexts).toEqual(expect.arrayContaining(['alpha', 'beta']));
    // No torn transcript: every assistant row is well-formed.
    for (const row of stored?.transcript ?? []) {
      if (row.kind === 'assistant') {
        expect(typeof row.text).toBe('string');
      }
    }
  });

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

describe('turn loop: settings approval policy', () => {
  it('settings always_allow skips the approval gate on future calls', async () => {
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'write_note', { key: 'a' }) },
      { events: textEvents('done') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    await harness.updateSettings({
      policies: { toolApprovals: { write_note: 'always_allow' } },
    });
    const session = await harness.createSession({ mode: 'agent' });
    const events = await collect(harness, session.id, 'write', 'agent');
    expect(events.some((event) => event.event === 'tool_approval_required')).toBe(false);
    expect(events.some((event) => event.event === 'tool' && event.name === 'write_note')).toBe(
      true,
    );
    expect(events.at(-1)?.event).toBe('done');
  });
});
