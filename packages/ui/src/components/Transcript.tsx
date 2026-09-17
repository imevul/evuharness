import { BUILTIN_TOOL_NAMES, type ToolEvent, type TranscriptRow } from '@evu/harness-protocol';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { LiveTurn } from '../hooks/session-live.js';
import { isNearBottom } from '../scroll.js';
import { MarkdownView } from './MarkdownView.js';

export interface TranscriptProps {
  rows: readonly TranscriptRow[];
  /** The turn in flight, rendered after the persisted rows. Null between turns. */
  turn?: LiveTurn | null;
  className?: string;
}

/**
 * The conversation view.
 *
 * Renders persisted rows, then the live turn as a trailing partial row. Keeping the
 * live turn out of the row list is what lets the terminal event replace it with the
 * server's authoritative version without a flicker or a duplicated bubble.
 *
 * Reasoning is a secondary collapsed block, never the assistant bubble. Providers
 * that never emit `reasoning_delta` leave the block absent. Assistant turns fold
 * thinking, progress notes, and tools into one "Worked for" disclosure. The latest
 * turn and the live turn keep that disclosure open; older turns stay collapsed.
 */
export function Transcript({ rows, turn = null, className }: TranscriptProps) {
  const latestAssistant = latestAssistantIndex(rows, turn !== null);
  const { scrollerRef, showJump, jumpToLatest } = useStickToBottom(rows, turn);

  return (
    <div className={className} data-harness="transcript-frame">
      <div data-harness="transcript" ref={scrollerRef}>
        <div data-harness="transcript-log">
          {/*
            Index keys are correct here, not a shortcut. A transcript is append-only: a
            row is never inserted, reordered, or removed, so its index *is* its stable
            identity. Protocol rows carry no id, and synthesizing one would invent
            identity the data does not have.
          */}
          {rows.map((row, index) => (
            <Row
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list, see above
              key={`${row.kind}-${index}`}
              row={row}
              workOpen={index === latestAssistant}
              durationFallbackStart={previousUserCreatedAt(rows, index)}
            />
          ))}

          {turn !== null && (
            <div data-harness="transcript-row" data-kind="assistant" data-partial="true">
              {hasLiveWork(turn) && (
                <WorkTrace reasoning={turn.reasoning} tools={turn.tools} open live />
              )}
              {turn.content !== '' && <div data-harness="bubble">{turn.content}</div>}
              <span data-harness="phase">{turn.phase}</span>
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          data-harness="scroll-bottom"
          aria-label="Scroll to latest"
          onClick={jumpToLatest}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M3.25 6.25 8 11l4.75-4.75"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Stay pinned to the newest row while the person is at the bottom. Scrolling
 * away unpins and shows the jump control; jumping pins again.
 */
function useStickToBottom(rows: readonly TranscriptRow[], turn: LiveTurn | null) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const syncFromScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) {
      return;
    }
    const overflow = el.scrollHeight > el.clientHeight + 1;
    const atBottom = isNearBottom(el);
    pinnedRef.current = atBottom;
    setShowJump(overflow && !atBottom);
  }, []);

  const stickIfPinned = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null || !pinnedRef.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) {
      return;
    }
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }, []);

  // Re-run when the transcript grows, not because the callbacks changed.
  useLayoutEffect(() => {
    void rows;
    void turn;
    stickIfPinned();
    syncFromScroll();
  }, [rows, turn, stickIfPinned, syncFromScroll]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) {
      return;
    }

    const onScroll = () => {
      syncFromScroll();
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            stickIfPinned();
            syncFromScroll();
          });
    resize?.observe(el);
    const log = el.firstElementChild;
    if (log !== null) {
      resize?.observe(log);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      resize?.disconnect();
    };
  }, [stickIfPinned, syncFromScroll]);

  return { scrollerRef, showJump, jumpToLatest };
}

function Row({
  row,
  workOpen,
  durationFallbackStart,
}: {
  row: TranscriptRow;
  workOpen: boolean;
  durationFallbackStart: string | undefined;
}) {
  return (
    <div
      data-harness="transcript-row"
      data-kind={row.kind}
      data-cancelled={row.cancelled === true ? 'true' : undefined}
    >
      {hasWorkChrome(row) && (
        <WorkTrace
          reasoning={row.reasoning}
          tools={row.tools ?? []}
          open={workOpen}
          {...durationProps(workDurationMs(row, durationFallbackStart))}
        />
      )}
      {row.attachments !== undefined && row.attachments.length > 0 && (
        <div data-harness="transcript-attachments">
          {row.attachments.map((attachment) => (
            <span
              key={attachment.id}
              data-harness="chip"
              data-kind="attachment"
              data-attachment-kind={attachment.kind}
            >
              <span data-harness="chip-icon">{attachment.kind === 'image' ? 'image' : 'file'}</span>
              <span data-harness="chip-label">{attachment.name}</span>
            </span>
          ))}
        </div>
      )}
      {(row.kind !== 'assistant' || row.text !== '') && (
        <div data-harness="bubble">
          <MarkdownView text={row.text} />
        </div>
      )}
    </div>
  );
}

function latestAssistantIndex(rows: readonly TranscriptRow[], live: boolean): number {
  if (live) {
    return -1;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.kind === 'assistant') {
      return index;
    }
  }
  return -1;
}

function previousUserCreatedAt(rows: readonly TranscriptRow[], index: number): string | undefined {
  const previous = rows[index - 1];
  if (previous?.kind !== 'user') {
    return undefined;
  }
  return previous.createdAt;
}

function hasWorkChrome(row: TranscriptRow): boolean {
  if (row.kind !== 'assistant') {
    return false;
  }
  const tools = row.tools ?? [];
  return tools.length > 0 || (row.reasoning !== undefined && row.reasoning !== '');
}

function hasLiveWork(turn: LiveTurn): boolean {
  return turn.tools.length > 0 || turn.reasoning !== '';
}

function durationProps(ms: number | undefined): { durationMs?: number } {
  return ms === undefined ? {} : { durationMs: ms };
}

function WorkTrace({
  reasoning,
  tools,
  open,
  durationMs,
  live = false,
}: {
  reasoning: string | undefined;
  tools: readonly ToolEvent[];
  open: boolean;
  durationMs?: number;
  live?: boolean;
}) {
  return (
    <details data-harness="work-trace" open={open || undefined}>
      <summary data-harness="work-summary">
        {live ? 'Working' : formatWorkedFor(durationMs)}
      </summary>
      <div data-harness="work-trace-details">
        <ReasoningBlock text={reasoning} open={live} />
        <WorkItems tools={tools} />
      </div>
    </details>
  );
}

function workDurationMs(row: TranscriptRow, fallbackStart: string | undefined): number | undefined {
  const end = parseIsoMs(row.createdAt);
  const start = parseIsoMs(row.startedAt) ?? parseIsoMs(fallbackStart);
  if (end === undefined || start === undefined) {
    return undefined;
  }
  const ms = end - start;
  if (!Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return ms;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "Worked for 12s" when timestamps exist; "Worked" when they do not. */
export function formatWorkedFor(ms: number | undefined): string {
  if (ms === undefined) {
    return 'Worked';
  }
  return `Worked for ${formatWorkedDuration(ms)}`;
}

export function formatWorkedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

/**
 * Collapsed secondary presentation for provider reasoning.
 *
 * Live turns pass `open` so tokens stay visible while streaming; completed rows
 * stay collapsed so reasoning does not compete with the assistant reply.
 */
function ReasoningBlock({ text, open = false }: { text: string | undefined; open?: boolean }) {
  if (text === undefined || text === '') {
    return null;
  }

  return (
    <details data-harness="reasoning" open={open || undefined}>
      <summary>Thinking</summary>
      <pre>{text}</pre>
    </details>
  );
}

/** Progress notes as inline text; every other call as a per-tool details row. */
function WorkItems({ tools }: { tools: readonly ToolEvent[] }) {
  return tools.map((tool, index) => {
    const note = progressNoteText(tool);
    if (note !== undefined) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: call order on one turn is stable
        <p key={`${tool.name}-${index}`} data-harness="progress-note">
          {note}
        </p>
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: call order on one turn is stable
      <ToolRow key={`${tool.name}-${index}`} tool={tool} />
    );
  });
}

/** Group calls by name, in first-seen order, as a single comma-separated line. */
export function summarizeToolTrace(tools: readonly ToolEvent[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const tool of tools) {
    if (progressNoteText(tool) !== undefined) {
      continue;
    }
    const previous = counts.get(tool.name);
    if (previous === undefined) {
      order.push(tool.name);
      counts.set(tool.name, 1);
    } else {
      counts.set(tool.name, previous + 1);
    }
  }
  return order.map((name) => phraseForTool(name, counts.get(name) ?? 1)).join(', ');
}

/** The user-facing sentence from a `report_progress` call, if the text is usable. */
export function progressNoteText(tool: ToolEvent): string | undefined {
  if (tool.name !== BUILTIN_TOOL_NAMES.reportProgress) {
    return undefined;
  }
  const text = tool.arguments.text;
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

function phraseForTool(name: string, count: number): string {
  switch (name) {
    case 'web_search':
      return count === 1 ? '1 search' : `${count} searches`;
    case 'search_memory':
      return count === 1 ? '1 memory search' : `${count} memory searches`;
    case 'http_request':
      return count === 1 ? '1 request' : `${count} requests`;
    case 'remember':
      return count === 1 ? 'saved 1 memory' : `saved ${count} memories`;
    case 'forget':
      return count === 1 ? 'forgot 1 memory' : `forgot ${count} memories`;
    case 'read_user':
      return 'read USER.md';
    case 'write_user':
      return count === 1 ? 'updated USER.md' : `updated USER.md ${count} times`;
    case 'mcp_list':
      return count === 1 ? '1 MCP list' : `${count} MCP lists`;
    case 'mcp_call':
      return count === 1 ? '1 MCP call' : `${count} MCP calls`;
    case 'load_skill':
      return count === 1 ? '1 skill' : `${count} skills`;
    default:
      return count === 1 ? name : `${count}× ${name}`;
  }
}

function ToolRow({ tool }: { tool: ToolEvent }) {
  return (
    <details data-harness="tool" data-denied={tool.denied === true ? 'true' : undefined}>
      <summary>
        {tool.name}
        {tool.denied === true ? ' (denied)' : ''}
      </summary>
      <pre data-harness="tool-arguments">{JSON.stringify(tool.arguments, null, 2)}</pre>
      <pre data-harness="tool-result">{tool.result}</pre>
    </details>
  );
}
