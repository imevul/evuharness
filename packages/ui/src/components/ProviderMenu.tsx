import type {
  ActiveProviderSnapshot,
  ModelCatalogEntry,
  ProviderOverride,
  ProviderProfile,
  ReasoningEffort,
} from '@evu/harness-protocol';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { formatContextWindow } from '../k-notation.js';

export interface ProviderMenuProps {
  providers: readonly ProviderProfile[];
  /** The override being edited. Null means "follow settings". */
  value: ProviderOverride | null;
  onChange: (next: ProviderOverride | null) => void;
  /** Resolved snapshot, for the context row and the provider to list models for. */
  active: ActiveProviderSnapshot | null;
  /**
   * Host callback for the model catalog, invoked when the model row opens.
   *
   * The menu never reaches the network itself; without this the model row falls
   * back to the ids already stored on the profile.
   */
  onListModels?: (providerId: string) => Promise<readonly ModelCatalogEntry[]>;
  className?: string;
}

type Row = 'provider' | 'model' | 'effort';

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Provider, model, and effort as a compact menu with one flyout at a time.
 *
 * Rows over stacked selects: the three fields are read far more often than they are
 * changed, and a row that states its current value in place answers "what am I
 * running" without opening anything. Only the field being changed expands.
 *
 * Models are fetched when their row opens rather than up front. A provider list is
 * a network call against a box that may be asleep, and paying for it every time the
 * status bar renders would make the common case — reading the value — the expensive
 * one.
 */
export function ProviderMenu(props: ProviderMenuProps) {
  const { providers, value, onChange, active, onListModels, className } = props;

  const [open, setOpen] = useState<Row | null>(null);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<{
    providerId: string;
    models: readonly ModelCatalogEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const providerId = value?.providerId ?? active?.id ?? null;
  const profile = providers.find((entry) => entry.id === providerId) ?? null;
  const contextWindow = active?.contextWindow;

  useEffect(() => {
    if (open !== 'model') return;
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open === null) return;

    // Capture, so this runs before a host's own Escape handler: from inside a
    // flyout, Escape has to back out one level rather than tear down the whole
    // popover the menu is mounted in.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const openModels = () => {
    setOpen('model');
    setQuery('');

    if (providerId === null || onListModels === undefined) return;
    if (catalog?.providerId === providerId) return;

    setLoading(true);
    setError(null);
    void onListModels(providerId)
      .then((models) => setCatalog({ providerId, models }))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setLoading(false));
  };

  /**
   * Apply a patch, dropping keys set to undefined, and collapse an empty override
   * to null so "inherit everything" is stored as absence rather than as `{}`.
   */
  const apply = (patch: Partial<Record<keyof ProviderOverride, string | undefined>>) => {
    const next: ProviderOverride = { ...(value ?? {}) };

    if ('providerId' in patch) {
      if (patch.providerId === undefined) delete next.providerId;
      else next.providerId = patch.providerId;
    }
    if ('model' in patch) {
      if (patch.model === undefined) delete next.model;
      else next.model = patch.model;
    }
    if ('effort' in patch) {
      if (patch.effort === undefined) delete next.effort;
      else next.effort = patch.effort as ReasoningEffort;
    }

    onChange(
      next.providerId === undefined && next.model === undefined && next.effort === undefined
        ? null
        : next,
    );
  };

  const chooseProvider = (id: string | undefined) => {
    // A model id is only meaningful for the endpoint that serves it, so switching
    // provider drops a pinned model rather than carrying a name the new box has
    // never heard of into the next turn.
    apply({ providerId: id, model: undefined });
    setOpen(null);
  };

  // Before a fetch lands, fall back to whatever ids the profile already carries, so
  // the row is never empty for a provider that has been browsed before.
  const listed: readonly ModelCatalogEntry[] =
    catalog?.providerId === providerId
      ? catalog.models
      : (profile?.models ?? []).map((id) => ({ id }));
  const needle = query.trim().toLowerCase();
  const matches =
    needle === '' ? listed : listed.filter((entry) => entry.id.toLowerCase().includes(needle));

  const overridden = value !== null;

  return (
    <div className={className} data-harness="provider-menu">
      <div data-harness="provider-menu-rows">
        <MenuRow
          label="Provider"
          value={profile?.label ?? profile?.id ?? 'Settings default'}
          open={open === 'provider'}
          onClick={() => setOpen(open === 'provider' ? null : 'provider')}
        />

        <MenuRow
          label="Model"
          value={value?.model ?? active?.model ?? '—'}
          open={open === 'model'}
          onClick={() => (open === 'model' ? setOpen(null) : openModels())}
        />

        {profile?.supportsEffort === true && (
          <MenuRow
            label="Effort"
            value={value?.effort ?? active?.effort ?? 'Inherit'}
            open={open === 'effort'}
            onClick={() => setOpen(open === 'effort' ? null : 'effort')}
          />
        )}

        <div data-harness="provider-menu-static">
          <span data-harness="provider-menu-label">Context</span>
          <span data-harness="provider-menu-value">
            {contextWindow === undefined ? 'Unknown' : formatContextWindow(contextWindow)}
          </span>
        </div>

        {overridden && (
          <button
            type="button"
            data-harness="provider-menu-reset"
            onClick={() => {
              onChange(null);
              setOpen(null);
            }}
          >
            Use the settings default
          </button>
        )}
      </div>

      {open === 'provider' && (
        <Flyout>
          <Option
            label="Settings default"
            selected={value?.providerId === undefined}
            onClick={() => chooseProvider(undefined)}
          />
          {providers.map((entry) => (
            <Option
              key={entry.id}
              label={entry.label ?? entry.id}
              hint={entry.model}
              selected={entry.id === value?.providerId}
              onClick={() => chooseProvider(entry.id)}
            />
          ))}
        </Flyout>
      )}

      {open === 'model' && (
        <Flyout
          header={
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search models"
              aria-label="Search models"
              spellCheck={false}
              data-harness="provider-menu-search"
              onChange={(event) => setQuery(event.target.value)}
            />
          }
        >
          {loading && <p data-harness="provider-menu-loading">Loading models…</p>}
          {!loading && error !== null && <p data-harness="provider-menu-error">{error}</p>}

          {!loading && error === null && (
            <>
              <Option
                label="Default"
                hint={profile?.model ?? active?.model}
                selected={value?.model === undefined}
                onClick={() => {
                  apply({ model: undefined });
                  setOpen(null);
                }}
              />
              {matches.map((entry) => (
                <Option
                  key={entry.id}
                  label={entry.id}
                  hint={
                    entry.contextWindow === undefined
                      ? undefined
                      : formatContextWindow(entry.contextWindow)
                  }
                  selected={entry.id === value?.model}
                  onClick={() => {
                    apply({ model: entry.id });
                    setOpen(null);
                  }}
                />
              ))}
              {listed.length > 0 && matches.length === 0 && (
                <p data-harness="provider-menu-empty">No model matches “{query}”.</p>
              )}
              {listed.length === 0 && (
                <p data-harness="provider-menu-empty">
                  {providerId === null
                    ? 'Pick a provider first.'
                    : 'This provider did not return any models.'}
                </p>
              )}
            </>
          )}
        </Flyout>
      )}

      {open === 'effort' && (
        <Flyout>
          <Option
            label="Inherit"
            selected={value?.effort === undefined}
            onClick={() => {
              apply({ effort: undefined });
              setOpen(null);
            }}
          />
          {EFFORTS.map((level) => (
            <Option
              key={level}
              label={level}
              selected={level === value?.effort}
              onClick={() => {
                apply({ effort: level });
                setOpen(null);
              }}
            />
          ))}
        </Flyout>
      )}
    </div>
  );
}

function MenuRow({
  label,
  value,
  open,
  onClick,
}: {
  label: string;
  value: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-harness="provider-menu-row"
      data-open={open}
      aria-haspopup="true"
      aria-expanded={open}
      onClick={onClick}
    >
      <span data-harness="provider-menu-label">{label}</span>
      <span data-harness="provider-menu-value">{value}</span>
      <span data-harness="provider-menu-caret" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/*
 * No label of its own: the flyout is a disclosure from a row that already names it
 * and carries `aria-expanded`, and a second name here would be read twice.
 *
 * `header` is outside the scrolling region so a search field cannot scroll away
 * from the list it filters.
 */
function Flyout({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div data-harness="provider-menu-flyout">
      {header !== undefined && <div data-harness="provider-menu-flyout-header">{header}</div>}
      <div data-harness="provider-menu-options">{children}</div>
    </div>
  );
}

function Option({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-harness="provider-menu-option"
      data-selected={selected}
      aria-current={selected}
      onClick={onClick}
    >
      <span data-harness="provider-menu-option-label">{label}</span>
      {hint !== undefined && <span data-harness="provider-menu-option-hint">{hint}</span>}
      <span data-harness="provider-menu-check" aria-hidden="true">
        {selected ? '✓' : ''}
      </span>
    </button>
  );
}
