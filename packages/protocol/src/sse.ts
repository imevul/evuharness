import { type StreamEvent, StreamEventSchema } from './events.js';

/**
 * Server-sent-event framing helpers.
 *
 * Both the server and every client parse through this module so the wire format
 * has exactly one definition.
 */

const DATA_PREFIX = 'data:';
const FRAME_SEPARATOR = '\n\n';

/** Encode one event as an SSE frame. */
export function encodeSseEvent(event: StreamEvent): string {
  return `${DATA_PREFIX} ${JSON.stringify(event)}${FRAME_SEPARATOR}`;
}

export interface SseParseResult {
  events: StreamEvent[];
  /** Bytes after the last complete frame, to be prepended to the next chunk. */
  rest: string;
}

/**
 * Parse whatever complete frames a buffer contains.
 *
 * Malformed frames are skipped rather than thrown: a stream that has already
 * produced useful output should not be discarded because of one bad line.
 */
export function parseSseChunk(buffer: string): SseParseResult {
  const events: StreamEvent[] = [];
  let rest = buffer;

  for (;;) {
    const separator = rest.indexOf(FRAME_SEPARATOR);
    if (separator < 0) {
      break;
    }

    const frame = rest.slice(0, separator);
    rest = rest.slice(separator + FRAME_SEPARATOR.length);

    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(DATA_PREFIX)) {
        continue;
      }

      const raw = trimmed.slice(DATA_PREFIX.length).trim();
      if (raw === '' || raw === '[DONE]') {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const result = StreamEventSchema.safeParse(parsed);
      if (result.success) {
        events.push(result.data);
      }
    }
  }

  return { events, rest };
}

/**
 * Incremental parser for a byte stream.
 *
 * Holds the partial trailing frame between chunks, which is the whole reason a
 * stateful helper exists rather than a bare function.
 */
export class SseDecoder {
  private buffer = '';

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const { events, rest } = parseSseChunk(this.buffer);
    this.buffer = rest;
    return events;
  }

  /** Non-empty when a stream ended mid-frame, which indicates a truncated response. */
  get pending(): string {
    return this.buffer;
  }
}
