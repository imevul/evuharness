import type { ChatRequest, SessionDetail, StreamEvent } from '@evu/harness-protocol';
import { type HarnessClient, useHarnessSession } from '@evu/harness-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const session: SessionDetail = {
  id: 's1',
  title: 'Untitled',
  mode: 'ask',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  usage: { promptTokensTotal: 0, completionTokensTotal: 0, lastPromptTokens: 0 },
  turnInProgress: false,
  transcript: [],
  pending: { toolApprovals: [], plan: null, modeSwitch: null, askUser: null },
};

function stubClient() {
  const requests: ChatRequest[] = [];
  const cancels: Array<'operator' | 'follow_up'> = [];
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;

  const client = {
    getSession: async () => session,
    cancel: async (_id: string, reason: 'operator' | 'follow_up' = 'operator') => {
      cancels.push(reason);
      releaseFirst?.();
    },
    async *chat(body: ChatRequest): AsyncGenerator<StreamEvent> {
      requests.push(body);
      call += 1;
      if (call === 1) {
        yield { event: 'delta', text: 'partial' };
        await firstGate;
        yield {
          event: 'cancelled',
          sessionId: 's1',
          content: 'partial',
          mode: body.mode,
          title: 'Untitled',
          tools: [],
          pendingToolApprovals: [],
          pendingPlan: null,
          pendingModeSwitch: null,
          pendingAskUser: null,
          promptTokensTotal: 1,
          completionTokensTotal: 1,
          quiet: false,
          reason: 'follow_up',
        };
        return;
      }
      yield {
        event: 'done',
        sessionId: 's1',
        content: 'drained',
        mode: body.mode,
        title: 'Untitled',
        tools: [],
        pendingToolApprovals: [],
        pendingPlan: null,
        pendingModeSwitch: null,
        pendingAskUser: null,
        promptTokensTotal: 2,
        completionTokensTotal: 2,
      };
    },
  } as unknown as HarnessClient;

  return { client, requests, cancels };
}

describe('follow-up queue in useHarnessSession', () => {
  it('drains mid-turn sends as one chat request and cancels as follow_up', async () => {
    const { client, requests, cancels } = stubClient();

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'ask' }),
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());

    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.send({ text: 'first' });
    });
    await waitFor(() => expect(result.current.turn).not.toBeNull());

    act(() => {
      result.current.setDraftMode('agent');
    });

    let secondSend: Promise<void>;
    let thirdSend: Promise<void>;
    act(() => {
      secondSend = result.current.send({ text: 'alpha' });
      thirdSend = result.current.send({ text: 'beta' });
    });

    await act(async () => {
      await Promise.all([firstSend, secondSend, thirdSend]);
    });

    expect(cancels).toContain('follow_up');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual([{ text: 'first', refs: [], attachments: [] }]);
    expect(requests[1]?.messages.map((message) => message.text)).toEqual(['alpha', 'beta']);
    expect(requests[1]?.mode).toBe('agent');
  });
});
