import type { SessionDetail } from '@evu/harness-protocol';
import { type HarnessClient, splitLiveSession, useHarnessSession } from '@evu/harness-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const baseSession: SessionDetail = {
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

describe('splitLiveSession', () => {
  it('lifts a trailing partial assistant row into the live turn', () => {
    const detail: SessionDetail = {
      ...baseSession,
      turnInProgress: true,
      transcript: [
        { kind: 'user', text: 'hi' },
        {
          kind: 'assistant',
          text: 'working',
          tools: [{ name: 'read_status', arguments: {}, result: 'ok' }],
          partial: true,
        },
      ],
    };

    const split = splitLiveSession(detail);
    expect(split.transcript).toEqual([{ kind: 'user', text: 'hi' }]);
    expect(split.turn).toEqual({
      phase: 'started',
      content: 'working',
      reasoning: '',
      tools: [{ name: 'read_status', arguments: {}, result: 'ok' }],
      mode: 'ask',
    });
  });

  it('returns null turn when the session is idle', () => {
    expect(splitLiveSession(baseSession).turn).toBeNull();
  });
});

describe('useHarnessSession reconnect', () => {
  it('recovers a live turn from session detail after the stream fails', async () => {
    vi.useFakeTimers();
    let live = true;
    const details: SessionDetail[] = [];

    const client = {
      getSession: async () => {
        const detail: SessionDetail = live
          ? {
              ...baseSession,
              turnInProgress: true,
              transcript: [
                { kind: 'user', text: 'hi' },
                { kind: 'assistant', text: 'partial from server', partial: true },
              ],
            }
          : {
              ...baseSession,
              turnInProgress: false,
              transcript: [
                { kind: 'user', text: 'hi' },
                { kind: 'assistant', text: 'finished after reconnect' },
              ],
            };
        details.push(detail);
        return detail;
      },
      cancel: async () => undefined,
      async *chat() {
        yield { event: 'delta', text: 'live' };
        throw new Error('network_drop');
      },
    } as unknown as HarnessClient;

    const { result } = renderHook(() =>
      useHarnessSession({ client, sessionId: 's1', initialMode: 'ask' }),
    );

    await act(async () => {
      await result.current.send({ text: 'hi' });
    });

    await waitFor(() => {
      expect(result.current.turn?.content).toBe('partial from server');
      expect(result.current.error).toBeNull();
    });

    live = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    await waitFor(() => {
      expect(result.current.turn).toBeNull();
      expect(result.current.transcript.at(-1)).toEqual({
        kind: 'assistant',
        text: 'finished after reconnect',
      });
    });

    expect(details.some((entry) => entry.turnInProgress)).toBe(true);
    vi.useRealTimers();
  });
});
