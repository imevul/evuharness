import {
  encodeSseEvent,
  isTerminalEvent,
  parseSseChunk,
  SseDecoder,
  type StreamEvent,
} from '@evu/harness-protocol';
import { describe, expect, it } from 'vitest';

const delta = (text: string): StreamEvent => ({ event: 'delta', text });

describe('SSE framing', () => {
  it('round-trips an event', () => {
    const encoded = encodeSseEvent(delta('hello'));
    const { events, rest } = parseSseChunk(encoded);

    expect(events).toEqual([{ event: 'delta', text: 'hello' }]);
    expect(rest).toBe('');
  });

  it('parses several frames from one buffer', () => {
    const buffer = [delta('a'), delta('b'), delta('c')].map(encodeSseEvent).join('');
    const { events } = parseSseChunk(buffer);

    expect(events.map((event) => (event.event === 'delta' ? event.text : null))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('retains a partial trailing frame as rest', () => {
    const buffer = `${encodeSseEvent(delta('done'))}data: {"event":"delta","text":"par`;
    const { events, rest } = parseSseChunk(buffer);

    expect(events).toHaveLength(1);
    expect(rest).toContain('par');
  });

  it('skips malformed frames instead of discarding the stream', () => {
    const buffer = ['data: {not json}\n\n', encodeSseEvent(delta('survived'))].join('');
    const { events } = parseSseChunk(buffer);

    expect(events).toEqual([{ event: 'delta', text: 'survived' }]);
  });

  it('skips frames that parse as JSON but violate the schema', () => {
    const buffer = ['data: {"event":"nonsense"}\n\n', encodeSseEvent(delta('ok'))].join('');
    const { events } = parseSseChunk(buffer);

    expect(events).toEqual([{ event: 'delta', text: 'ok' }]);
  });

  it('ignores the [DONE] sentinel some providers append', () => {
    const { events } = parseSseChunk('data: [DONE]\n\n');
    expect(events).toEqual([]);
  });
});

describe('SseDecoder', () => {
  it('reassembles an event split across chunk boundaries', () => {
    const encoded = encodeSseEvent(delta('split me'));
    const midpoint = Math.floor(encoded.length / 2);
    const decoder = new SseDecoder();

    expect(decoder.push(encoded.slice(0, midpoint))).toEqual([]);
    expect(decoder.push(encoded.slice(midpoint))).toEqual([{ event: 'delta', text: 'split me' }]);
    expect(decoder.pending).toBe('');
  });

  it('reports pending bytes when a stream ends mid-frame', () => {
    const decoder = new SseDecoder();
    decoder.push('data: {"event":"delta"');

    expect(decoder.pending).not.toBe('');
  });
});

describe('terminal events', () => {
  it.each(['done', 'cancelled', 'error'] as const)('treats %s as terminal', (name) => {
    expect(isTerminalEvent({ event: name } as StreamEvent)).toBe(true);
  });

  it.each(['delta', 'status', 'tool', 'usage'] as const)('treats %s as non-terminal', (name) => {
    expect(isTerminalEvent({ event: name } as StreamEvent)).toBe(false);
  });
});
