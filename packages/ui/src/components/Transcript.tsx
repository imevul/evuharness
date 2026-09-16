import type { ToolEvent, TranscriptRow } from '@evu/harness-protocol';
import type { LiveTurn } from '../hooks/use-harness-session.js';
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
 * that never emit `reasoning_delta` leave the block absent.
 */
export function Transcript({ rows, turn = null, className }: TranscriptProps) {
  return (
    <div className={className} data-harness="transcript">
      {/*
        Index keys are correct here, not a shortcut. A transcript is append-only: a
        row is never inserted, reordered, or removed, so its index *is* its stable
        identity. Protocol rows carry no id, and synthesizing one would invent
        identity the data does not have.
      */}
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list, see above
        <Row key={`${row.kind}-${index}`} row={row} />
      ))}

      {turn !== null && (
        <div data-harness="transcript-row" data-kind="assistant" data-partial="true">
          <ReasoningBlock text={turn.reasoning} open />
          {turn.tools.map((tool, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only call sequence
            <ToolRow key={`${tool.name}-${index}`} tool={tool} />
          ))}
          {turn.content !== '' && <div data-harness="bubble">{turn.content}</div>}
          <span data-harness="phase">{turn.phase}</span>
        </div>
      )}
    </div>
  );
}

function Row({ row }: { row: TranscriptRow }) {
  return (
    <div
      data-harness="transcript-row"
      data-kind={row.kind}
      data-cancelled={row.cancelled === true ? 'true' : undefined}
    >
      <ReasoningBlock text={row.reasoning} />
      {row.tools?.map((tool, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed call sequence on a stored row
        <ToolRow key={`${tool.name}-${index}`} tool={tool} />
      ))}
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
