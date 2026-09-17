import type {
  ConnectionTestResult,
  HarnessSettings,
  HarnessSettingsUpdate,
  ModelCatalogEntry,
  ProviderProfile,
} from '@evu/harness-protocol';
import { useState } from 'react';
import { formatContextWindow } from '../k-notation.js';
import { resolveModelContextWindow } from '../provider-override.js';
import { Modal } from './Modal.js';
import { ProviderFormModal } from './ProviderFormModal.js';

export interface ProviderSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  onTest: (providerId: string) => Promise<ConnectionTestResult>;
  onListModels: (providerId: string) => Promise<ModelCatalogEntry[]>;
  className?: string;
}

/** Null id means "creating". */
type Editing = { id: string | null };

function displayName(profile: ProviderProfile): string {
  return profile.label ?? profile.id;
}

/**
 * Named provider profiles: a list of what exists, with create, edit, delete, and
 * which one is active.
 *
 * The list is the screen; editing happens in a dialog. One always-open form cannot
 * say which profile is active without competing with the form's own idea of
 * "selected", and the distinction between "the row I am looking at" and "the
 * profile every new turn will use" is the one thing this screen has to get right.
 */
export function ProviderSettings(props: ProviderSettingsProps) {
  const { settings, onChange, onTest, onListModels, className } = props;

  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ProviderProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingProfile =
    editing?.id === undefined || editing.id === null
      ? null
      : (settings.providers.find((profile) => profile.id === editing.id) ?? null);

  const run = async (update: HarnessSettingsUpdate) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(update);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * List models, and remember the ids on the profile.
   *
   * The override controls elsewhere offer `profile.models` as their model list, so
   * a browse here is also how that list stays current.
   */
  const listModelsFor = (profile: ProviderProfile) => async () => {
    const models = await onListModels(profile.id);
    const ids = models.map((entry) => entry.id);
    const unchanged =
      ids.length === profile.models.length &&
      ids.every((id, index) => profile.models[index] === id);

    if (ids.length > 0 && !unchanged) {
      await onChange({
        providers: [
          { id: profile.id, baseUrl: profile.baseUrl, model: profile.model, models: ids },
        ],
      });
    }
    return models;
  };

  return (
    <section className={className} data-harness="provider-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>Providers</h2>
          <p data-harness="provider-settings-hint">
            The active profile is what a new turn uses unless a session or send overrides it.
          </p>
        </div>
        <button
          type="button"
          data-variant="primary"
          data-harness="provider-new"
          onClick={() => setEditing({ id: null })}
        >
          Add provider
        </button>
      </header>

      {settings.providers.length === 0 ? (
        <p data-harness="provider-empty">
          No provider yet. Add one to point the harness at an OpenAI-compatible endpoint.
        </p>
      ) : (
        <ul data-harness="provider-list">
          {settings.providers.map((profile) => {
            const active = profile.id === settings.activeProviderId;
            const window = resolveModelContextWindow(profile, profile.model);

            return (
              <li key={profile.id} data-harness="provider-row" data-active={active}>
                <div data-harness="provider-row-main">
                  <span data-harness="provider-label">{displayName(profile)}</span>
                  <span data-harness="provider-model">{profile.model}</span>
                  <span data-harness="provider-base-url">{profile.baseUrl}</span>
                </div>

                <div data-harness="provider-row-meta">
                  {window !== undefined && (
                    <span data-harness="provider-window">{formatContextWindow(window)} ctx</span>
                  )}
                  {profile.hasApiKey && <span data-harness="provider-key">key set</span>}
                  {active ? (
                    <span data-harness="provider-active-badge">Active</span>
                  ) : (
                    <button
                      type="button"
                      data-harness="provider-activate"
                      disabled={busy}
                      onClick={() => void run({ activeProviderId: profile.id })}
                    >
                      Use
                    </button>
                  )}
                </div>

                <div data-harness="provider-row-actions">
                  <button
                    type="button"
                    data-variant="ghost"
                    data-harness="provider-edit"
                    aria-label={`Edit ${displayName(profile)}`}
                    onClick={() => setEditing({ id: profile.id })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    data-harness="provider-delete"
                    aria-label={`Delete ${displayName(profile)}`}
                    disabled={busy}
                    onClick={() => setDeleting(profile)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error !== null && <p data-harness="provider-error">{error}</p>}

      {editing !== null && (
        <ProviderFormModal
          key={editing.id ?? 'new'}
          profile={editingProfile}
          activateOnSave={settings.activeProviderId === null}
          onClose={() => setEditing(null)}
          onSubmit={async (write) => {
            await onChange({
              providers: [write],
              ...(settings.activeProviderId === null ? { activeProviderId: write.id } : {}),
            });
            setEditing(null);
          }}
          {...(editingProfile === null
            ? {}
            : {
                onTest: () => onTest(editingProfile.id),
                onListModels: listModelsFor(editingProfile),
              })}
        />
      )}

      {deleting !== null && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${displayName(deleting)}?`}
          footer={
            <>
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-variant="danger"
                data-harness="provider-delete-confirm"
                disabled={busy}
                onClick={() => {
                  const id = deleting.id;
                  setDeleting(null);
                  void run({ removeProviderIds: [id] });
                }}
              >
                Delete provider
              </button>
            </>
          }
        >
          <p>
            The profile and its stored key are removed. Sessions pinned to it fall back to the
            active provider.
          </p>
        </Modal>
      )}
    </section>
  );
}
