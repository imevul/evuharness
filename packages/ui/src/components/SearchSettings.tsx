import type {
  HarnessSettings,
  HarnessSettingsUpdate,
  SearchProvider,
  SearchProviderKind,
} from '@evu/harness-protocol';
import { useState } from 'react';
import { Modal } from './Modal.js';

export interface SearchSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  className?: string;
}

export function SearchSettings({ settings, onChange, className }: SearchSettingsProps) {
  const [editing, setEditing] = useState<SearchProvider | { id: null } | null>(null);
  const [kind, setKind] = useState<SearchProviderKind>('duckduckgo');
  const [draft, setDraft] = useState({ id: '', label: '', baseUrl: '', apiKey: '' });

  const openNew = () => {
    setKind('duckduckgo');
    setDraft({ id: crypto.randomUUID(), label: '', baseUrl: '', apiKey: '' });
    setEditing({ id: null });
  };

  return (
    <section className={className} data-harness="search-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>Search</h2>
          <p data-harness="provider-settings-hint">
            The active provider is what web_search uses. DuckDuckGo needs no key.
          </p>
        </div>
        <button type="button" data-variant="primary" onClick={openNew}>
          Add provider
        </button>
      </header>

      <ul data-harness="provider-list">
        {settings.searchProviders.map((provider) => {
          const active = provider.id === settings.activeSearchProviderId;
          return (
            <li key={provider.id} data-harness="provider-row" data-active={active}>
              <div data-harness="provider-row-main">
                <span data-harness="provider-label">{provider.label ?? provider.id}</span>
                <span data-harness="provider-model">{provider.kind}</span>
              </div>
              <div data-harness="provider-row-meta">
                {active ? (
                  <span data-harness="provider-active-badge">Active</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onChange({ activeSearchProviderId: provider.id })}
                  >
                    Use
                  </button>
                )}
              </div>
              <div data-harness="provider-row-actions">
                <button
                  type="button"
                  data-variant="danger"
                  onClick={() => void onChange({ removeSearchProviderIds: [provider.id] })}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {editing !== null && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title="Add search provider"
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-variant="primary"
                onClick={() => {
                  void Promise.resolve(
                    onChange({
                      searchProviders: [
                        {
                          id: draft.id,
                          kind,
                          ...(draft.label.trim() === '' ? {} : { label: draft.label.trim() }),
                          ...(kind === 'searxng' ? { baseUrl: draft.baseUrl } : {}),
                          ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
                        },
                      ],
                      ...(settings.activeSearchProviderId === null
                        ? { activeSearchProviderId: draft.id }
                        : {}),
                    }),
                  ).then(() => setEditing(null));
                }}
              >
                Save
              </button>
            </>
          }
        >
          <label>
            Kind
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as SearchProviderKind)}
            >
              <option value="duckduckgo">DuckDuckGo</option>
              <option value="searxng">SearXNG</option>
            </select>
          </label>
          <label>
            Label
            <input
              value={draft.label}
              data-autofocus
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
          {kind === 'searxng' && (
            <>
              <label>
                Base URL
                <input
                  value={draft.baseUrl}
                  required
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </label>
              <label>
                API token
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </label>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
