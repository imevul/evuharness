import type {
  ConnectionTestResult,
  ModelCatalogEntry,
  ProviderProfile,
  ProviderProfileWrite,
} from '@evu/harness-protocol';
import { useId, useState } from 'react';
import { expandKNotation, formatContextWindow, parseKNotation } from '../k-notation.js';
import { Modal } from './Modal.js';
import { ModelPickerField } from './ModelPickerField.js';

export interface ProviderFormModalProps {
  /** The profile being edited. Null creates one. */
  profile: ProviderProfile | null;
  /** True when this save should also make the profile active. */
  activateOnSave?: boolean;
  onClose: () => void;
  /** Rejects with a message the dialog shows; the host closes on success. */
  onSubmit: (write: ProviderProfileWrite) => Promise<void>;
  /** Bound to this profile by the host. Absent while creating. */
  onTest?: () => Promise<ConnectionTestResult>;
  /** Bound to this profile by the host. Absent while creating. */
  onListModels?: () => Promise<readonly ModelCatalogEntry[]>;
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
 * Create or edit one provider profile.
 *
 * The API key field is write-only: when a key is stored the input starts empty and
 * says so, and saving it empty leaves the stored secret alone. Clearing is an
 * explicit action rather than a side effect of an empty field, because the two are
 * indistinguishable to anyone reading the form.
 *
 * Mount this only while it is open. State seeds from `profile` once, so a settings
 * refetch behind the dialog cannot overwrite half-typed input.
 */
export function ProviderFormModal(props: ProviderFormModalProps) {
  const { profile, activateOnSave = false, onClose, onSubmit, onTest, onListModels } = props;

  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile));
  const [overrideText, setOverrideText] = useState(() =>
    profile === null ? '' : (profile.modelContextWindowOverrides[profile.model]?.toString() ?? ''),
  );
  const [clearKey, setClearKey] = useState(false);
  /** Last catalog seen in this dialog. Fresher than `profile` until settings refetch. */
  const [listed, setListed] = useState<readonly ModelCatalogEntry[]>([]);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setModel = (model: string) => {
    setDraft((current) => ({ ...current, model }));
    // The override is per model id, so following the field keeps the number and its
    // label describing the same thing.
    setOverrideText(profile?.modelContextWindowOverrides[model]?.toString() ?? '');
  };

  const overridesFor = (model: string, text: string): Record<string, number | null> => {
    const current: Record<string, number | null> = {
      ...(profile?.modelContextWindowOverrides ?? {}),
    };
    const parsed = parseKNotation(text);
    if (parsed === undefined) return current;
    return { ...current, [model]: parsed };
  };

  const submit = async () => {
    setBusy('save');
    setError(null);
    const expanded = expandKNotation(overrideText);
    setOverrideText(expanded);

    const model = draft.model.trim();
    const label = draft.label.trim();

    try {
      await onSubmit({
        id: draft.id,
        baseUrl: draft.baseUrl.trim(),
        model,
        ...(label === '' ? {} : { label }),
        ...(clearKey ? { apiKey: null } : draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
        modelContextWindowOverrides: overridesFor(model, expanded),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const catalogWindow =
    listed.find((entry) => entry.id === draft.model)?.contextWindow ??
    profile?.modelContextWindows[draft.model];

  return (
    <Modal
      open
      onClose={onClose}
      title={profile === null ? 'Add provider' : `Edit ${profile.label ?? profile.id}`}
      footer={
        <>
          <button type="button" data-harness="provider-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            data-variant="primary"
            data-harness="provider-save"
            disabled={busy !== null}
          >
            {activateOnSave ? 'Save and use' : 'Save'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        data-harness="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Label
          <input
            value={draft.label}
            data-autofocus
            placeholder="Local llama.cpp"
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </label>

        <label>
          Base URL
          <input
            value={draft.baseUrl}
            required
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </label>

        <ModelPickerField
          value={draft.model}
          onChange={setModel}
          required
          {...(onListModels === undefined
            ? { browseHint: 'Save the provider first to browse the models it serves.' }
            : {
                loadModels: async () => {
                  const models = await onListModels();
                  setListed(models);
                  return models;
                },
              })}
        />

        <label>
          Max context tokens
          <input
            type="text"
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            value={overrideText}
            placeholder={catalogWindow === undefined ? 'Not reported' : 'Use provider value'}
            onChange={(event) => setOverrideText(event.target.value)}
            onBlur={() => setOverrideText(expandKNotation(overrideText))}
          />
        </label>
        <ContextWindowHint overrideText={overrideText} catalogWindow={catalogWindow} />

        <label>
          API key
          <input
            type="password"
            value={draft.apiKey}
            autoComplete="off"
            disabled={clearKey}
            placeholder={profile?.hasApiKey === true ? 'Stored — leave blank to keep' : 'Optional'}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
        </label>

        {profile?.hasApiKey === true && (
          <div data-harness="provider-key-actions">
            {clearKey ? (
              <>
                <span data-harness="provider-key-pending">Key is cleared on save.</span>
                <button type="button" onClick={() => setClearKey(false)}>
                  Keep the stored key
                </button>
              </>
            ) : (
              <button
                type="button"
                data-variant="danger"
                data-harness="provider-clear-key"
                onClick={() => {
                  setClearKey(true);
                  setDraft((current) => ({ ...current, apiKey: '' }));
                }}
              >
                Clear stored key
              </button>
            )}
          </div>
        )}

        {onTest !== undefined && (
          <div data-harness="provider-probe">
            <button
              type="button"
              data-harness="provider-test-button"
              disabled={busy !== null}
              onClick={() => {
                setBusy('test');
                setError(null);
                void onTest()
                  .then(setTestResult)
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => setBusy(null));
              }}
            >
              Test connection
            </button>
            <span data-harness="provider-probe-hint">Tests the saved profile, not this draft.</span>
          </div>
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
    </Modal>
  );
}

/**
 * Which context window a turn would actually use, and where it came from.
 *
 * The input alone cannot answer that: an empty field means "whatever the provider
 * reports", which is a different number for every model.
 */
function ContextWindowHint({
  overrideText,
  catalogWindow,
}: {
  overrideText: string;
  catalogWindow: number | undefined;
}) {
  const parsed = parseKNotation(overrideText);

  if (parsed === undefined) {
    return (
      <p data-harness="provider-context-hint" data-source="invalid">
        Not a number. Use an integer or k-notation, such as <code>32Ki</code> or <code>128K</code>.
      </p>
    );
  }

  if (parsed !== null) {
    return (
      <p data-harness="provider-context-hint" data-source="override">
        Override: {formatContextWindow(parsed)} ({parsed.toLocaleString()} tokens)
      </p>
    );
  }

  if (catalogWindow !== undefined) {
    return (
      <p data-harness="provider-context-hint" data-source="catalog">
        From provider: {formatContextWindow(catalogWindow)} ({catalogWindow.toLocaleString()}{' '}
        tokens)
      </p>
    );
  }

  return (
    <p data-harness="provider-context-hint" data-source="unknown">
      The provider has not reported a context window for this model. Browse the models to pick one
      up, or set a value here.
    </p>
  );
}
