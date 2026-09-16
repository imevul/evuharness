import type { ActiveProviderSnapshot, SessionUsage } from '@evu/harness-protocol';
import { useId, useState } from 'react';

export interface StatusBarProps {
  provider: ActiveProviderSnapshot | null;
  usage: SessionUsage;
  className?: string;
}

/**
 * Always-visible chrome for the active provider, model, and context use.
 *
 * The donut only appears when a resolved max exists. Hover/focus opens a custom
 * tooltip (not `title`) so later usage-split lines can stack underneath.
 */
export function StatusBar({ provider, usage, className }: StatusBarProps) {
  const max = provider?.contextWindow;
  const used = usage.lastPromptTokens;
  const percent = max === undefined ? null : Math.min(100, Math.round((used / max) * 100));

  return (
    <div className={className} data-harness="status-bar">
      <span data-harness="status-provider">
        {provider === null ? 'No provider' : (provider.label ?? provider.id)}
      </span>
      {provider !== null && <span data-harness="status-model">{provider.model}</span>}
      {provider?.effort !== undefined && (
        <span data-harness="status-effort">{provider.effort}</span>
      )}
      {max !== undefined && percent !== null && (
        <ContextDonut used={used} max={max} percent={percent} />
      )}
    </div>
  );
}

function ContextDonut({ used, max, percent }: { used: number; max: number; percent: number }) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;
  const line = formatContextTooltip(used, max);

  return (
    <span data-harness="status-context">
      <button
        type="button"
        data-harness="status-donut"
        aria-describedby={open ? tooltipId : undefined}
        aria-label={line}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round"
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      {open && (
        <div role="tooltip" id={tooltipId} data-harness="status-tooltip">
          <div data-harness="status-tooltip-line">{line}</div>
        </div>
      )}
    </span>
  );
}

export function formatContextTooltip(used: number, max: number): string {
  const percent = Math.min(100, Math.round((used / max) * 100));
  return `Context: ${used.toLocaleString()} / ${max.toLocaleString()} (${percent}%)`;
}
