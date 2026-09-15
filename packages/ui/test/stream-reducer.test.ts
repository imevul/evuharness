import type {
  PendingGates,
  SessionDetail,
  StreamEvent,
  TranscriptRow,
} from '@evu/harness-protocol';
import { applyStreamEvent, type LiveTurn } from '@evu/harness-ui';
import { describe, expect, it } from 'vitest';

/**
 * A stand-in for the four React setters the reducer writes through.
 *
 * Exercising the reducer directly rather than through a rendered component is
 * deliberate: the folding rules are the part that can be wrong, and they should not
 * need a DOM to verify.
 */
function harness(initial: { turn?: LiveTurn | null; session?: SessionDetail | null } = {}) {
  const state = {
    turn: initial.turn ?? null,
    session: initial.session ?? null,
    transcript: [] as TranscriptRow[],
    pending: null as PendingGates | null,
    error: null as string | null,
  };

  const setter =
    <K extends keyof typeof state>(key: K) =>
    (next: unknown) => {
      state[key] = typeof next === 'function' ? next(state[key]) : next;
    };

  const sinks = {
    setTurn: setter('turn'),
    setSession: setter('session'),
    setTranscript: setter('transcript'),
    setPending: setter('pending'),
    setError: setter('error'),
    // The reducer's parameter type is expressed in React's dispatch terms; these
    // stand-ins are structurally compatible at runtime.
  } as unknown as Parameters<typeof applyStreamEvent>[1];

  return {
    state,
    apply: (event: StreamEvent) => applyStreamEvent(event, sinks),
  };
}

const liveTurn: LiveTurn = {
  phase: 'started',
  content: '',
  reasoning: '',
  tools: [],
  mode: 'agent',
};

const session: SessionDetail = {
  id: 's1',
  title: 'Untitled',
  mode: 'agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  usage: { promptTokensTotal: 0, completionTokensTotal: 0, lastPromptTokens: 0 },
  turnInProgress: false,
  transcript: [],
  pending: { toolApprovals: [], plan: null, modeSwitch: null, askUser: null },
};

const terminal = {
  sessionId: 's1',
  content: 'done',
  mode: 'agent' as const,
  title: 'A title',
  tools: [],
  pendingToolApprovals: [],
  pendingPlan: null,
  pendingModeSwitch: null,
  pendingAskUser: null,
  promptTokensTotal: 10,
  completionTokensTotal: 5,
};

describe('applyStreamEvent', () => {
  it('accumulates text and reasoning deltas separately', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({ event: 'delta', text: 'Hel' });
    apply({ event: 'reasoning_delta', text: 'hmm' });
    apply({ event: 'delta', text: 'lo' });

    expect(state.turn?.content).toBe('Hello');
    expect(state.turn?.reasoning).toBe('hmm');
  });

  it('tracks the turn phase', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({ event: 'status', sessionId: 's1', phase: 'tools' });

    expect(state.turn?.phase).toBe('tools');
  });

  it('attaches tool calls to the live turn rather than creating transcript rows', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({ event: 'tool', name: 'read_file', arguments: { path: 'a' }, result: 'ok' });

    expect(state.turn?.tools).toEqual([
      { name: 'read_file', arguments: { path: 'a' }, result: 'ok' },
    ]);
    expect(state.transcript).toHaveLength(0);
  });

  it('carries the denied flag through to the tool entry', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({
      event: 'tool',
      name: 'write_file',
      arguments: {},
      result: 'denied by operator',
      denied: true,
    });

    expect(state.turn?.tools[0]?.denied).toBe(true);
  });

  it('appends an assistant row with its tools when the turn completes', () => {
    const { state, apply } = harness({ turn: liveTurn, session });

    apply({
      event: 'done',
      ...terminal,
      tools: [{ name: 'read_file', arguments: {}, result: 'ok' }],
    });

    expect(state.transcript).toEqual([
      {
        kind: 'assistant',
        text: 'done',
        tools: [{ name: 'read_file', arguments: {}, result: 'ok' }],
      },
    ]);
  });

  it('suppresses an empty bubble on a quiet cancel', () => {
    const { state, apply } = harness({ turn: liveTurn, session });

    apply({ event: 'cancelled', ...terminal, content: '', quiet: true, reason: 'follow_up' });

    expect(state.transcript).toHaveLength(0);
  });

  it('keeps a cancelled row that produced content, and marks it', () => {
    const { state, apply } = harness({ turn: liveTurn, session });

    apply({
      event: 'cancelled',
      ...terminal,
      content: 'partial',
      quiet: false,
      reason: 'operator',
    });

    expect(state.transcript).toEqual([{ kind: 'assistant', text: 'partial', cancelled: true }]);
  });

  it('resyncs the stored session mode from the terminal event', () => {
    // A gate may have changed the session default mid-turn; the terminal event is
    // what tells the client about it.
    const { state, apply } = harness({ turn: liveTurn, session });

    apply({ event: 'done', ...terminal, mode: 'plan' });

    expect(state.session?.mode).toBe('plan');
    expect(state.session?.title).toBe('A title');
  });

  it('records usage totals and the last prompt size', () => {
    const { state, apply } = harness({ session });

    apply({
      event: 'usage',
      promptTokens: 120,
      completionTokens: 30,
      promptTokensTotal: 400,
      completionTokensTotal: 90,
    });

    expect(state.session?.usage).toEqual({
      promptTokensTotal: 400,
      completionTokensTotal: 90,
      lastPromptTokens: 120,
    });
  });

  it('queues tool approvals rather than replacing the previous one', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({
      event: 'tool_approval_required',
      sessionId: 's1',
      approvalId: 'a1',
      tool: 'write_file',
      arguments: {},
      digest: 'd1',
      requestedAt: 'now',
    });
    apply({
      event: 'tool_approval_required',
      sessionId: 's1',
      approvalId: 'a2',
      tool: 'run_command',
      arguments: {},
      digest: 'd2',
      requestedAt: 'now',
    });

    expect(state.pending?.toolApprovals.map((a) => a.approvalId)).toEqual(['a1', 'a2']);
  });

  it('strips transport fields from a gate before storing it', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({
      event: 'ask_user_required',
      sessionId: 's1',
      askId: 'q1',
      questions: [
        { id: 'one', prompt: 'Which?', choices: [], allowMultiple: false, allowFreeForm: true },
      ],
      requestedAt: 'now',
    });

    // `event` and `sessionId` belong to the stream frame, not the gate.
    expect(state.pending?.askUser).toEqual({
      askId: 'q1',
      questions: [
        { id: 'one', prompt: 'Which?', choices: [], allowMultiple: false, allowFreeForm: true },
      ],
      requestedAt: 'now',
    });
  });

  it('records a system message as its own row', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({ event: 'system', text: 'Switched to plan mode' });

    expect(state.transcript).toEqual([{ kind: 'system', text: 'Switched to plan mode' }]);
  });

  it('surfaces an error event', () => {
    const { state, apply } = harness({ turn: liveTurn });

    apply({ event: 'error', sessionId: 's1', message: 'provider unreachable' });

    expect(state.error).toBe('provider unreachable');
  });
});
