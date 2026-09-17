import type {
  ActiveProviderSnapshot,
  ModelCatalogEntry,
  ProviderOverride,
  ProviderProfile,
  SessionUsage,
} from '@evu/harness-protocol';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { focusableWithin } from '../focus-trap.js';
import { ProviderMenu } from './ProviderMenu.js';

export interface StatusBarProps {
  provider: ActiveProviderSnapshot | null;
  usage: SessionUsage;
  className?: string;
  /** Profiles the picker offers. */
  providers?: readonly ProviderProfile[];
  /** The session's stored override, so the picker can show and clear it. */
  override?: ProviderOverride | null;
  /**
   * Persist a session override. Supplying it turns the provider readout into a
   * button; without it the bar stays display-only.
   */
  onProviderChange?: (next: ProviderOverride | null) => void;
  /** Passed through to the picker; called when its model row opens. */
  onListModels?: (providerId: string) => Promise<readonly ModelCatalogEntry[]>;
  /** No session to pin an override to yet. */
  pickerDisabled?: boolean;
}

/**
 * Always-visible chrome for the active provider, model, and context use.
 *
 * The readout is also where the provider gets changed. It already names the thing
 * being changed and it is on screen during every turn, so a separate always-open
 * override panel above the composer was permanent chrome restating what this line
 * says. Picking here writes the session preference; settings profiles are never
 * rewritten from this bar.
 *
 * The donut only appears when a resolved max exists. Hover/focus opens a custom
 * tooltip (not `title`) so later usage-split lines can stack underneath.
 */
export function StatusBar(props: StatusBarProps) {
  const {
    provider,
    usage,
    className,
    providers = [],
    override,
    onProviderChange,
    onListModels,
    pickerDisabled = false,
  } = props;

  const max = provider?.contextWindow;
  const used = usage.lastPromptTokens;
  const percent = max === undefined ? null : Math.min(100, Math.round((used / max) * 100));

  const readout = (
    <>
      <span data-harness="status-provider">
        {provider === null ? 'No provider' : (provider.label ?? provider.id)}
      </span>
      {provider !== null && <span data-harness="status-model">{provider.model}</span>}
      {provider?.effort !== undefined && (
        <span data-harness="status-effort">{provider.effort}</span>
      )}
    </>
  );

  return (
    <div className={className} data-harness="status-bar">
      {onProviderChange === undefined ? (
        readout
      ) : (
        <ProviderPicker
          providers={providers}
          override={override ?? null}
          onChange={onProviderChange}
          active={provider}
          disabled={pickerDisabled}
          {...(onListModels === undefined ? {} : { onListModels })}
        >
          {readout}
        </ProviderPicker>
      )}

      {max !== undefined && percent !== null && (
        <ContextDonut used={used} max={max} percent={percent} />
      )}
    </div>
  );
}

function hasOverride(override: ProviderOverride | null): boolean {
  if (override === null) return false;
  return (
    override.providerId !== undefined ||
    override.model !== undefined ||
    override.effort !== undefined
  );
}

/**
 * The provider readout as a disclosure over the session override controls.
 *
 * A popover rather than a dialog: this changes one session preference and the
 * transcript behind it is the context for the choice, so taking over the screen
 * would be the wrong weight.
 */
function ProviderPicker({
  providers,
  override,
  onChange,
  active,
  onListModels,
  disabled,
  children,
}: {
  providers: readonly ProviderProfile[];
  override: ProviderOverride | null;
  onChange: (next: ProviderOverride | null) => void;
  active: ActiveProviderSnapshot | null;
  onListModels?: (providerId: string) => Promise<readonly ModelCatalogEntry[]>;
  disabled: boolean;
  children: ReactNode;
}) {
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    focusableWithin(popoverRef.current)[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    // Pointer-down rather than click: a mousedown outside is already the user
    // leaving, and waiting for click lets the popover eat the first press.
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target) === true) return;
      setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const overridden = hasOverride(override);

  return (
    <span ref={rootRef} data-harness="status-provider-picker">
      <button
        ref={triggerRef}
        type="button"
        data-harness="status-provider-trigger"
        data-overridden={overridden}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {/*
          The readout is the accessible name. `aria-haspopup` carries the rest, so
          there is no hidden label here duplicating what is already on screen.
        */}
        {children}
        <span data-harness="status-provider-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label="Provider for this chat"
          data-harness="status-provider-popover"
        >
          <ProviderMenu
            providers={providers}
            value={override}
            onChange={onChange}
            active={active}
            {...(onListModels === undefined ? {} : { onListModels })}
          />
          <p data-harness="status-provider-hint">
            Applies to this chat and persists with it. Settings still decides the default for new
            chats.
          </p>
        </div>
      )}
    </span>
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
