/**
 * The mode ownership model.
 *
 * Three pieces of state that must never be conflated:
 *
 *   draft mode          client only, changes when the user toggles
 *   session default     the session record, three sanctioned writers
 *   turn mode           an immutable snapshot, pinned at send
 *
 * The hazard these tests exist for: the obvious implementation loads a session,
 * mutates it during the turn, and writes the whole object back. That silently
 * reverts a mode change made while the turn was running. The bug hides whenever a
 * store hands the same in-memory instance to both writers, and appears as soon as
 * storage is durable or there is more than one process.
 */

import {
  applyTurnPatch,
  createHarness,
  createSessionRecord,
  createTurnPin,
  emptyGates,
  emptyUsage,
  InMemorySessionStore,
  pinAllowsTool,
  setSessionMode,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

function record(mode = 'ask') {
  return createSessionRecord({ id: 'session-1', mode, now: '2026-01-01T00:00:00.000Z' });
}

describe('turn pin immutability', () => {
  it('freezes the pin', () => {
    const pin = createTurnPin({
      sessionId: 'session-1',
      mode: 'ask',
      toolNames: ['read'],
      systemPrompt: 'prompt',
    });

    expect(Object.isFrozen(pin)).toBe(true);
  });

  it('copies the tool set so a later mutation cannot widen a running turn', () => {
    const tools = new Set(['read']);
    const pin = createTurnPin({
      sessionId: 'session-1',
      mode: 'ask',
      toolNames: tools,
      systemPrompt: 'prompt',
    });

    tools.add('restart_service');

    expect(pinAllowsTool(pin, 'restart_service')).toBe(false);
    expect(pinAllowsTool(pin, 'read')).toBe(true);
  });

  it('rejects a tool outside the allowlist', () => {
    const pin = createTurnPin({
      sessionId: 'session-1',
      mode: 'ask',
      toolNames: ['read'],
      systemPrompt: 'prompt',
    });

    expect(pinAllowsTool(pin, 'delete_everything')).toBe(false);
  });
});

describe('turn persistence must not write the mode', () => {
  it('keeps the stored mode when a turn persists', () => {
    const stored = { ...record('agent') };
    const updated = applyTurnPatch(stored, {
      transcript: [{ kind: 'assistant', text: 'done' }],
    });

    expect(updated.mode).toBe('agent');
  });

  it('takes the mode from storage, not from the turn that started earlier', () => {
    // The core scenario: a turn began in ask mode, the user set agent mid-turn,
    // and the turn is now finishing. The newer choice must survive.
    const atSendTime = record('ask');
    const afterSetMode = setSessionMode(atSendTime, 'agent', 'explicit-set-mode');

    const persisted = applyTurnPatch(afterSetMode, {
      transcript: [{ kind: 'assistant', text: 'finished the earlier turn' }],
      messages: [{ role: 'assistant', content: 'finished the earlier turn' }],
    });

    expect(persisted.mode).toBe('agent');
    expect(persisted.transcript).toHaveLength(1);
  });

  it('keeps a session provider preference when a turn persists', () => {
    const stored = {
      ...record('ask'),
      provider: { model: 'bigger', effort: 'high' as const },
    };
    const updated = applyTurnPatch(stored, {
      transcript: [{ kind: 'assistant', text: 'done' }],
    });
    expect(updated.provider).toEqual({ model: 'bigger', effort: 'high' });
  });

  it('persists every turn-owned field', () => {
    const stored = record();
    const usage = { ...emptyUsage(), promptTokensTotal: 10, lastPromptTokens: 10 };
    const updated = applyTurnPatch(stored, {
      messages: [{ role: 'user', content: 'hi' }],
      transcript: [{ kind: 'user', text: 'hi' }],
      usage,
      pending: emptyGates(),
      title: 'hi',
    });

    expect(updated).toMatchObject({
      title: 'hi',
      usage: { promptTokensTotal: 10 },
    });
    expect(updated.messages).toHaveLength(1);
    expect(updated.transcript).toHaveLength(1);
  });

  it('leaves untouched fields alone', () => {
    const stored = record();
    const updated = applyTurnPatch(stored, { transcript: [] });

    expect(updated.id).toBe(stored.id);
    expect(updated.createdAt).toBe(stored.createdAt);
    expect(updated.workspaceId).toBe(stored.workspaceId);
  });

  it('advances updatedAt', () => {
    const stored = record();
    const updated = applyTurnPatch(stored, { transcript: [] }, '2026-06-01T00:00:00.000Z');

    expect(updated.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(updated.updatedAt).not.toBe(stored.updatedAt);
  });

  it('does not mutate the record it was given', () => {
    const stored = record();
    applyTurnPatch(stored, { transcript: [{ kind: 'assistant', text: 'x' }] });

    expect(stored.transcript).toEqual([]);
  });
});

describe('sanctioned mode writers', () => {
  it('accepts send-time pinning', () => {
    expect(setSessionMode(record('ask'), 'agent', 'send-time-pin').mode).toBe('agent');
  });

  it('accepts an explicit set-mode', () => {
    expect(setSessionMode(record('ask'), 'plan', 'explicit-set-mode').mode).toBe('plan');
  });

  it('accepts plan approval, which forces agent mode', () => {
    expect(setSessionMode(record('plan'), 'agent', 'plan-approval').mode).toBe('agent');
  });

  it('rejects an unrecognized writer', () => {
    expect(() =>
      // A caller outside the three sanctioned paths is a bug, so it fails loudly
      // rather than writing the field anyway.
      setSessionMode(record(), 'agent', 'turn-persistence' as never),
    ).toThrow(/Unsupported mode writer/);
  });

  it('returns the same record when the mode is unchanged', () => {
    const stored = record('ask');
    expect(setSessionMode(stored, 'ask', 'explicit-set-mode')).toBe(stored);
  });
});

describe('mode cycling during a live turn', () => {
  it('does not touch the session when a client toggles its draft mode', async () => {
    const harness = createHarness({ idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    // A draft toggle is client-only: there is no harness call for it at all, which
    // is exactly why cycling modes during a turn is free.
    const reloaded = await harness.getSession(session.id);

    expect(reloaded?.mode).toBe('ask');
  });

  it('keeps a running turn on its pinned mode after the session default changes', async () => {
    const store = new InMemorySessionStore();
    const harness = createHarness({ store, idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    const pin = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });

    const stored = await store.get(session.id);
    await store.upsert(setSessionMode(stored!, 'agent', 'explicit-set-mode'));

    // The pin is a snapshot. An approval resuming now resumes under ask.
    expect(pin.mode).toBe('ask');
    expect((await harness.getSession(session.id))?.mode).toBe('agent');
  });

  it('survives a full cycle of modes while a turn is pinned', async () => {
    const store = new InMemorySessionStore();
    const harness = createHarness({ store, idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    const pin = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });

    for (const mode of ['plan', 'agent', 'ask', 'plan']) {
      const current = await store.get(session.id);
      await store.upsert(setSessionMode(current!, mode, 'explicit-set-mode'));
    }

    expect(pin.mode).toBe('ask');
    expect((await harness.getSession(session.id))?.mode).toBe('plan');
  });

  it('does not let a finishing turn clobber a newer set-mode', async () => {
    const store = new InMemorySessionStore();
    const harness = createHarness({ store, idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    // Turn starts in ask and holds its own snapshot.
    const pin = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });

    // User switches to agent while the turn streams.
    const midTurn = await store.get(session.id);
    await store.upsert(setSessionMode(midTurn!, 'agent', 'explicit-set-mode'));

    // Turn finishes and persists. It must re-read the record rather than writing
    // back the copy it loaded at send time.
    const latest = await store.get(session.id);
    await store.upsert(
      applyTurnPatch(latest!, {
        transcript: [{ kind: 'assistant', text: 'answer' }],
        messages: [{ role: 'assistant', content: 'answer' }],
      }),
    );

    const final = await store.get(session.id);

    expect(final?.mode).toBe('agent');
    expect(final?.transcript).toHaveLength(1);
    expect(pin.mode).toBe('ask');
  });

  it('holds the tool allowlist across the same window', async () => {
    const store = new InMemorySessionStore();
    const harness = createHarness({
      store,
      idFactory: () => 'session-1',
      tools: [
        { name: 'read', description: 'r', parameters: {}, mutates: false, handler: () => '' },
        { name: 'restart_service', description: 'w', parameters: {}, handler: () => '' },
      ],
    });
    const session = await harness.createSession({ mode: 'ask' });

    const pin = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });

    const stored = await store.get(session.id);
    await store.upsert(setSessionMode(stored!, 'agent', 'explicit-set-mode'));

    // Switching the session to agent must not retroactively unlock a mutating
    // tool for the turn that is already running.
    expect(pinAllowsTool(pin, 'restart_service')).toBe(false);
  });

  it('pins a later turn to the newer mode', async () => {
    const store = new InMemorySessionStore();
    const harness = createHarness({ store, idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    const firstPin = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });
    const secondPin = await harness.pinTurn({ sessionId: session.id, mode: 'agent' });

    expect(firstPin.mode).toBe('ask');
    expect(secondPin.mode).toBe('agent');
  });

  it('gives two turns independent snapshots', async () => {
    const harness = createHarness({ idFactory: () => 'session-1' });
    const session = await harness.createSession({ mode: 'ask' });

    const first = await harness.pinTurn({ sessionId: session.id, mode: 'ask' });
    const second = await harness.pinTurn({ sessionId: session.id, mode: 'agent' });

    expect(first).not.toBe(second);
    expect(first.toolNames).not.toBe(second.toolNames);
  });
});
