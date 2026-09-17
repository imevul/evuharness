import type { SessionDetail } from '@evu/harness-protocol';
import { type HarnessClient, useHarnessSession } from '@evu/harness-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const ask = {
  askId: 'ask-1',
  questions: [
    {
      id: 'q1',
      prompt: 'What would you like to test?',
      choices: [],
      allowMultiple: false,
      allowFreeForm: true,
    },
  ],
  requestedAt: '2026-01-01T00:00:00.000Z',
};

const session: SessionDetail = {
  id: 's1',
  title: 'Untitled',
  mode: 'ask',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  usage: { promptTokensTotal: 0, completionTokensTotal: 0, lastPromptTokens: 0 },
  turnInProgress: true,
  transcript: [],
  pending: { toolApprovals: [], plan: null, modeSwitch: null, askUser: ask },
};

describe('useHarnessSession answerAskUser', () => {
  it('clears the pending ask before the request returns', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<{ askId: string; answers: unknown }> = [];

    const client = {
      getSession: async () => session,
      answerAskUser: async (_id: string, askId: string, body: { answers: unknown }) => {
        calls.push({ askId, answers: body.answers });
        await held;
      },
    } as unknown as HarnessClient;

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'ask' }),
    );

    await waitFor(() => {
      expect(result.current.pending?.askUser?.askId).toBe('ask-1');
    });

    act(() => {
      void result.current.answerAskUser('ask-1', [
        { questionId: 'q1', selected: [], text: 'setup' },
      ]);
    });

    expect(result.current.pending?.askUser).toBeNull();
    expect(calls).toHaveLength(1);
    release?.();
    await waitFor(() => expect(calls[0]?.askId).toBe('ask-1'));
  });
});
