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
          {turn.reasoning !== '' && (
            <details data-harness="reasoning">
              <summary>Thinking</summary>
              <pre>{turn.reasoning}</pre>
            </details>
          )}
          {turn.tools.map((tool, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only call sequence
            <ToolRow key={`${tool.name}-${index}`} tool={tool} />
          ))}
          <div data-harness="bubble">{turn.content}</div>
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
      {row.reasoning !== undefined && row.reasoning !== '' && (
        <details data-harness="reasoning">
          <summary>Thinking</summary>
          <pre>{row.reasoning}</pre>
        </details>
      )}
      {row.tools?.map((tool, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed call sequence on a stored row
        <ToolRow key={`${tool.name}-${index}`} tool={tool} />
      ))}
      <div data-harness="bubble">
        <MarkdownView text={row.text} />
      </div>
    </div>
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
