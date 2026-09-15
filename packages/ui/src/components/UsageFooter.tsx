import type { SessionUsage } from '@evu/harness-protocol';

export interface UsageFooterProps {
  usage: SessionUsage;
  /** Context window of the active model, when known, for a fill indicator. */
  contextWindow?: number;
  className?: string;
}

/** Token accounting. `lastPromptTokens` is what fills a context-window meter. */
export function UsageFooter({ usage, contextWindow, className }: UsageFooterProps) {
  const fill =
    contextWindow === undefined || contextWindow === 0
      ? null
      : Math.min(100, Math.round((usage.lastPromptTokens / contextWindow) * 100));

  return (
    <div className={className} data-harness="usage-footer">
      <span data-harness="usage-prompt">{usage.promptTokensTotal.toLocaleString()} in</span>
      <span data-harness="usage-completion">
        {usage.completionTokensTotal.toLocaleString()} out
      </span>
      {fill !== null && (
        <span data-harness="usage-context" data-fill={fill}>
          {fill}% of context
        </span>
      )}
    </div>
  );
}
