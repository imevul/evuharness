import type {
  ConnectionTestResult,
  HarnessSettings,
  HarnessSettingsUpdate,
  ModelCatalogEntry,
  ProviderProfile,
  ProviderProfileWrite,
} from '@evu/harness-protocol';
import { useEffect, useState } from 'react';
import { expandKNotation, parseKNotation } from '../k-notation.js';

export interface ProviderSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  onTest: (providerId: string) => Promise<ConnectionTestResult>;
  onListModels: (providerId: string) => Promise<ModelCatalogEntry[]>;
  className?: string;
}

interface Draft {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function draftFrom(profile: ProviderProfile | null): Draft {
  return {
    id: profile?.id ?? crypto.randomUUID(),
    label: profile?.label ?? '',
    baseUrl: profile?.baseUrl ?? 'http://127.0.0.1:8080/v1',
    model: profile?.model ?? 'local-model',
    apiKey: '',
  };
}

/**
 * Named provider profiles: create, edit, test, and pick the active one.
 *
 * The API key field is write-only. When a key is already stored the input stays
 * empty and a placeholder says so; an empty save leaves the stored key alone.
 */
export function ProviderSettings(props: ProviderSettingsProps) {
  const { settings, onChange, onTest, onListModels, className } = props;
  const [selectedId, setSelectedId] = useState<string | null>(
    settings.activeProviderId ?? settings.providers[0]?.id ?? null,
  );
  const selected = settings.providers.find((profile) => profile.id === selectedId) ?? null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(selected));
  const [creating, setCreating] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [overrideText, setOverrideText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!creating) {
      setDraft(draftFrom(selected));
      setTestResult(null);
      setModels((selected?.models ?? []).map((id) => ({ id })));
      setOverrideText(
        selected?.modelContextWindowOverrides[selected.model] === undefined
          ? ''
          : String(selected.modelContextWindowOverrides[selected.model]),
      );
    }
  }, [selected, creating]);

  useEffect(() => {
    if (creating || selected === null) return;
    const override = selected.modelContextWindowOverrides[draft.model];
    setOverrideText(override === undefined ? '' : String(override));
  }, [creating, selected, draft.model]);

  const overridesFor = (model: string, text: string): Record<string, number | null> => {
    const current = { ...(selected?.modelContextWindowOverrides ?? {}) };
    const parsed = parseKNotation(text);
    if (parsed === null) {
      return { ...current, [model]: null };
    }
    if (parsed === undefined) {
      return current;
    }
    return { ...current, [model]: parsed };
  };

  const save = async (extra: Partial<ProviderProfileWrite> = {}, activate = false) => {
    setBusy('save');
    setError(null);
    const expandedOverride = expandKNotation(overrideText);
    setOverrideText(expandedOverride);
    try {
      const write: ProviderProfileWrite = {
        id: draft.id,
        baseUrl: draft.baseUrl,
        model: extra.model ?? draft.model,
        ...(draft.label === '' ? {} : { label: draft.label }),
        ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
        ...(extra.modelContextWindowOverrides === undefined && extra.model === undefined
          ? { modelContextWindowOverrides: overridesFor(draft.model, expandedOverride) }
          : {}),
        ...extra,
      };
      await onChange({
        providers: [write],
        ...(activate || settings.activeProviderId === null ? { activeProviderId: draft.id } : {}),
      });
      setCreating(false);
      setSelectedId(draft.id);
      setDraft((current) => ({ ...current, apiKey: '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={className} data-harness="provider-settings">
      <header data-harness="provider-settings-header">
        <h2>Providers</h2>
        <button
          type="button"
          data-harness="provider-new"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
            setDraft(draftFrom(null));
            setTestResult(null);
            setModels([]);
            setOverrideText('');
          }}
        >
          Add provider
        </button>
      </header>

      <ul data-harness="provider-list">
        {settings.providers.map((profile) => (
          <li
            key={profile.id}
            data-harness="provider-row"
            data-active={profile.id === settings.activeProviderId}
            data-selected={profile.id === selectedId}
          >
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setSelectedId(profile.id);
              }}
            >
              <span>{profile.label ?? profile.id}</span>
              <span data-harness="provider-model">{profile.model}</span>
            </button>
            {profile.id === settings.activeProviderId && (
              <span data-harness="provider-active-badge">active</span>
            )}
          </li>
        ))}
      </ul>

      <form
        data-harness="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Label
          <input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </label>
        <label>
          Base URL
          <input
            value={draft.baseUrl}
            required
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </label>
        <label>
          Model
          <input
            value={draft.model}
            required
            list="harness-provider-models"
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
        </label>
        <datalist id="harness-provider-models">
          {models.map((model) => (
            <option key={model.id} value={model.id} />
          ))}
        </datalist>
        <label>
          Max context tokens
          <input
            type="text"
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            value={overrideText}
            placeholder={catalogWindowLabel(selected, draft.model, models)}
            onChange={(event) => setOverrideText(event.target.value)}
            onBlur={() => setOverrideText(expandKNotation(overrideText))}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            value={draft.apiKey}
            autoComplete="off"
            placeholder={selected?.hasApiKey === true ? 'Stored — leave blank to keep' : 'Optional'}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
        </label>

        <div data-harness="provider-actions">
          <button type="submit" disabled={busy !== null}>
            Save
          </button>
          {selected !== null && selected.id !== settings.activeProviderId && (
            <button
              type="button"
              data-harness="provider-activate"
              disabled={busy !== null}
              onClick={() => void onChange({ activeProviderId: selected.id })}
            >
              Use this provider
            </button>
          )}
          {selected !== null && (
            <button
              type="button"
              data-harness="provider-delete"
              disabled={busy !== null}
              onClick={() => {
                void onChange({ removeProviderIds: [selected.id] });
                setSelectedId(settings.providers.find((p) => p.id !== selected.id)?.id ?? null);
              }}
            >
              Delete
            </button>
          )}
          {selected?.hasApiKey === true && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void save({ apiKey: null })}
            >
              Clear key
            </button>
          )}
        </div>

        {selected !== null && (
          <div data-harness="provider-probe">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy('test');
                setError(null);
                void onTest(selected.id)
                  .then((result) => {
                    setTestResult(result);
                  })
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => setBusy(null));
              }}
            >
              Test connection
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy('models');
                setError(null);
                void onListModels(selected.id)
                  .then((listed) => {
                    setModels(listed);
                    return onChange({
                      providers: [
                        {
                          id: selected.id,
                          baseUrl: selected.baseUrl,
                          model: selected.model,
                          models: listed.map((entry) => entry.id),
                        },
                      ],
                    });
                  })
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => setBusy(null));
              }}
            >
              Refresh models
            </button>
          </div>
        )}

        {models.length > 0 && (
          <ul data-harness="provider-models">
            {models.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  data-selected={model.id === draft.model}
                  onClick={() => {
                    setDraft({ ...draft, model: model.id });
                    if (!creating) {
                      void save({ model: model.id });
                    }
                  }}
                >
                  {model.id}
                </button>
              </li>
            ))}
          </ul>
        )}

        {testResult !== null && (
          <p data-harness="provider-test" data-ok={testResult.ok}>
            {testResult.ok ? 'Connected' : 'Failed'}
            {testResult.message !== undefined ? ` — ${testResult.message}` : ''}
            {testResult.latencyMs !== undefined ? ` (${testResult.latencyMs}ms)` : ''}
          </p>
        )}
        {error !== null && <p data-harness="provider-error">{error}</p>}
      </form>
    </section>
  );
}

function catalogWindowLabel(
  profile: ProviderProfile | null,
  model: string,
  listed: ModelCatalogEntry[],
): string {
  const catalog =
    profile?.modelContextWindows[model] ??
    listed.find((entry) => entry.id === model)?.contextWindow;
  return catalog === undefined ? 'Use catalog' : `Catalog: ${catalog.toLocaleString()}`;
}
