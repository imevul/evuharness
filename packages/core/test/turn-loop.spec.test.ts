/**
 * Turn-loop specification checklist.
 *
 * Streaming, tool rounds, and cancellation are implemented. Remaining groups
 * stay skipped until their sprint. Do not delete a skipped test to make a run
 * green, and do not unskip one without an assertion.
 *
 * `SPEC.md` is the normative description of everything below.
 */

import { createHarness, FakeProvider, type ProviderEvent } from '@evu/harness-core';
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
    const provider = new FakeProvider([
      { events: toolEvents('c1', 'write_note', { key: 'k', body: 'v' }) },
      { events: textEvents('blocked') },
    ]);
    const harness = runtime(provider, { tools: [ECHO, WRITE] });
    const session = await harness.createSession({ mode: 'agent' });
    const events = await collect(harness, session.id, 'hi', 'agent');
    const detail = await harness.getSession(session.id);

    expect(events.find((event) => event.event === 'tool')).toMatchObject({ denied: true });
    expect(events.some((event) => event.event === 'tool_approval_required')).toBe(false);
    expect(detail?.pending.toolApprovals).toEqual([]);
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
  it.skip('cancels a live turn when a new user message arrives', () => {});

  it.skip('reports reason follow_up for that cancel', () => {});

  it.skip('persists the interrupted turn before starting the next one', () => {});

  it.skip('drains several queued messages as a single next turn', () => {});

  it.skip('pins the queued turn to the mode sent with it', () => {});

  it.skip('preserves queued message order', () => {});
});

describe('turn loop: tool approval gate', () => {
  it.skip('suspends the turn instead of executing a gated tool', () => {});

  it.skip('emits tool_approval_required carrying the argument digest', () => {});

  it.skip('resumes and executes the tool after allow_once', () => {});

  it.skip('resumes under the original pinned mode after an approval wait', () => {});

  it.skip('reports a refusal to the model after deny', () => {});

  it.skip('does not re-prompt for a tool already granted for the session', () => {});

  it.skip('re-prompts when the same tool is called with different arguments', () => {});

  it.skip('does not execute a gated tool before the decision arrives', () => {});
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
  it.skip('keeps the model thread and the UI transcript in step', () => {});

  it.skip('titles a session from its first user message', () => {});

  it.skip('serializes concurrent turns on one session', () => {});

  it.skip('does not persist on every delta', () => {});
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
