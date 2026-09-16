import type { ProviderOverride, ProviderProfile, ReasoningEffort } from '@evu/harness-protocol';

export interface ProviderOverrideControlsProps {
  /** Named profiles from settings. */
  providers: readonly ProviderProfile[];
  /** Current value. `null`/`undefined` means “use settings active profile”. */
  value: ProviderOverride | null | undefined;
  onChange: (next: ProviderOverride | null) => void;
  /**
   * When true, empty fields mean “inherit” and the control is a draft for the
   * next send. When false, the host persists a session preference via `onChange`.
   */
  draft?: boolean;
  disabled?: boolean;
  className?: string;
  /** Show effort picker. Defaults to true when any profile supports effort. */
  showEffort?: boolean;
}

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Provider / model / effort override picker.
 *
 * Ownership mirrors draft mode: a `draft` instance only stages the next send
 * and never calls the server. A non-draft instance is for session preference —
 * the host decides when to persist via `onChange`.
 */
export function ProviderOverrideControls(props: ProviderOverrideControlsProps) {
  const {
    providers,
    value,
    onChange,
    draft = false,
    disabled = false,
    className,
    showEffort = providers.some((profile) => profile.supportsEffort),
  } = props;

  const providerId = value?.providerId ?? '';
  const model = value?.model ?? '';
  const effort = value?.effort ?? '';
  const selected =
    providerId === '' ? null : (providers.find((profile) => profile.id === providerId) ?? null);
  const modelOptions = selected?.models.length
    ? selected.models
    : selected !== null
      ? [selected.model]
      : [];

  const emit = (patch: {
    providerId?: string | undefined;
    model?: string | undefined;
    effort?: ReasoningEffort | undefined;
    clear?: boolean;
  }) => {
    if (patch.clear) {
      onChange(null);
      return;
    }

    const next: ProviderOverride = { ...(value ?? {}) };
    if ('providerId' in patch) {
      if (patch.providerId === undefined || patch.providerId === '') {
        delete next.providerId;
      } else {
        next.providerId = patch.providerId;
      }
    }
    if ('model' in patch) {
      if (patch.model === undefined || patch.model === '') {
        delete next.model;
      } else {
        next.model = patch.model;
      }
    }
    if ('effort' in patch) {
      if (patch.effort === undefined) {
        delete next.effort;
      } else {
        next.effort = patch.effort;
      }
    }

    onChange(
      next.providerId === undefined && next.model === undefined && next.effort === undefined
        ? null
        : next,
    );
  };

  return (
    <div
      className={className}
      data-harness="provider-override"
      data-draft={draft ? 'true' : undefined}
    >
      <label data-harness="provider-override-provider">
        <span>{draft ? 'This send' : 'Session'} provider</span>
        <select
          value={providerId}
          disabled={disabled}
          onChange={(event) => emit({ providerId: event.target.value })}
        >
          <option value="">Settings default</option>
          {providers.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label ?? profile.id}
            </option>
          ))}
        </select>
      </label>

      <label data-harness="provider-override-model">
        <span>Model</span>
        <input
          list={modelOptions.length > 0 ? 'harness-override-models' : undefined}
          value={model}
          disabled={disabled}
          placeholder="Inherit"
          onChange={(event) => emit({ model: event.target.value })}
        />
        {modelOptions.length > 0 && (
          <datalist id="harness-override-models">
            {modelOptions.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        )}
      </label>

      {showEffort && (
        <label data-harness="provider-override-effort">
          <span>Effort</span>
          <select
            value={effort}
            disabled={disabled}
            onChange={(event) =>
              emit({
                effort:
                  event.target.value === '' ? undefined : (event.target.value as ReasoningEffort),
              })
            }
          >
            <option value="">Inherit</option>
            {EFFORTS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      )}

      {(value?.providerId !== undefined ||
        value?.model !== undefined ||
        value?.effort !== undefined) && (
        <button
          type="button"
          data-harness="provider-override-clear"
          disabled={disabled}
          onClick={() => emit({ clear: true })}
        >
          Clear
        </button>
      )}
    </div>
  );
}
