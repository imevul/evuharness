import type { ChatRequest, SessionDetail, StreamEvent } from '@evu/harness-protocol';
import { type HarnessClient, useHarnessSession } from '@evu/harness-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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

/**
 * A client whose stream is driven by the test.
 *
 * Holding the turn open at a chosen point is the whole reason for this stub: the
 * behavior under test is what happens to a turn *while* it is running, which a
 * pre-baked event list cannot express.
 */
function stubClient() {
  const requests: ChatRequest[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client = {
    getSession: async () => session,
    cancel: async () => undefined,
    async *chat(body: ChatRequest): AsyncGenerator<StreamEvent> {
      requests.push(body);
      yield { event: 'delta', text: 'partial' };
      await gate;
      yield {
        event: 'done',
        sessionId: 's1',
        content: 'partial done',
        // The server echoes the mode it ran the turn with.
        mode: body.mode,
        title: 'A title',
        tools: [],
        pendingToolApprovals: [],
        pendingPlan: null,
        pendingModeSwitch: null,
        pendingAskUser: null,
        promptTokensTotal: 1,
        completionTokensTotal: 1,
      };
    },
  } as unknown as HarnessClient;

  return { client, requests, release: () => release?.() };
}

describe('mode ownership during a live turn', () => {
  it('pins the turn to the mode it was sent with, even if the draft changes', async () => {
    const { client, requests, release } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'agent' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    // Start a turn in agent mode and leave it open.
    let sent: Promise<void>;
    act(() => {
      sent = result.current.send({ text: 'hello' });
    });

    await waitFor(() => expect(result.current.turn).not.toBeNull());
    expect(result.current.turn?.mode).toBe('agent');

    // Cycle the composer mode while the turn is still streaming. This is the case
    // that used to corrupt a turn: the user flips modes and the running turn's tool
    // policy changes underneath it.
    act(() => {
      result.current.setDraftMode('plan');
    });

    // The draft moved; the turn did not.
    expect(result.current.draftMode).toBe('plan');
    expect(result.current.turn?.mode).toBe('agent');

    act(() => {
      release();
    });
    await act(async () => {
      await sent;
    });

    // The request carried the send-time mode, not the mode at completion time.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mode).toBe('agent');
  });

  it('sends the draft mode chosen before the message, not the session default', async () => {
    const { client, requests, release } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'agent' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => {
      result.current.setDraftMode('ask');
    });

    let sent: Promise<void>;
    act(() => {
      sent = result.current.send({ text: 'hello' });
    });

    act(() => {
      release();
    });
    await act(async () => {
      await sent;
    });

    expect(requests[0]?.mode).toBe('ask');
    // The stored default only follows because the server echoed it back.
    expect(result.current.session?.mode).toBe('ask');
  });

  it('leaves the draft alone when a terminal event reports a different stored mode', async () => {
    // A mode-switch gate approved mid-turn changes the session default. That must
    // resync `session.mode` without overwriting what the user has queued up next.
    const { client, requests, release } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'agent' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    let sent: Promise<void>;
    act(() => {
      sent = result.current.send({ text: 'hello' });
    });

    await waitFor(() => expect(result.current.turn).not.toBeNull());

    act(() => {
      result.current.setDraftMode('plan');
    });

    act(() => {
      release();
    });
    await act(async () => {
      await sent;
    });

    expect(requests[0]?.mode).toBe('agent');
    expect(result.current.session?.mode).toBe('agent');
    expect(result.current.draftMode).toBe('plan');
  });

  it('echoes the user message immediately rather than waiting for the server', async () => {
    const { client, release } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'agent' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    let sent: Promise<void>;
    act(() => {
      sent = result.current.send({ text: 'hello' });
    });

    await waitFor(() =>
      expect(result.current.transcript).toEqual([{ kind: 'user', text: 'hello' }]),
    );

    act(() => {
      release();
    });
    await act(async () => {
      await sent;
    });

    expect(result.current.transcript).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'partial done' },
    ]);
  });

  it('clears the live turn once the stream ends', async () => {
    const { client, release } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'agent' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    let sent: Promise<void>;
    act(() => {
      sent = result.current.send({ text: 'hello' });
    });

    await waitFor(() => expect(result.current.turn).not.toBeNull());

    act(() => {
      release();
    });
    await act(async () => {
      await sent;
    });

    expect(result.current.turn).toBeNull();
  });
});
