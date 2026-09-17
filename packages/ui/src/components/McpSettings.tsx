import type {
  ConnectionTestResult,
  HarnessSettings,
  HarnessSettingsUpdate,
  McpServer,
} from '@evu/harness-protocol';
import { useState } from 'react';
import { Modal } from './Modal.js';

export interface McpSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  onTest?: (serverId: string) => Promise<ConnectionTestResult>;
  className?: string;
}

export function McpSettings({ settings, onChange, onTest, className }: McpSettingsProps) {
  const [editing, setEditing] = useState<McpServer | { id: null } | null>(null);
  const [draft, setDraft] = useState({ id: '', label: '', url: '', apiKey: '' });

  return (
    <section className={className} data-harness="mcp-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>MCP</h2>
          <p data-harness="provider-settings-hint">
            Remote servers are called through mcp_list and mcp_call. Per-tool permissions can be
            added later on each server.
          </p>
        </div>
        <button
          type="button"
          data-variant="primary"
          onClick={() => {
            setDraft({ id: crypto.randomUUID(), label: '', url: '', apiKey: '' });
            setEditing({ id: null });
          }}
        >
          Add server
        </button>
      </header>

      {settings.mcpServers.length === 0 ? (
        <p data-harness="provider-empty">No MCP server yet.</p>
      ) : (
        <ul data-harness="provider-list">
          {settings.mcpServers.map((server) => (
            <li key={server.id} data-harness="provider-row">
              <div data-harness="provider-row-main">
                <span data-harness="provider-label">{server.label ?? server.id}</span>
                <span data-harness="provider-base-url">{server.url}</span>
              </div>
              <div data-harness="provider-row-meta">{server.enabled ? 'enabled' : 'disabled'}</div>
              <div data-harness="provider-row-actions">
                {onTest !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      void onTest(server.id);
                    }}
                  >
                    Test
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void onChange({
                      mcpServers: [{ id: server.id, url: server.url, enabled: !server.enabled }],
                    })
                  }
                >
                  {server.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  data-variant="danger"
                  onClick={() => void onChange({ removeMcpServerIds: [server.id] })}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title="Add MCP server"
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
                      mcpServers: [
                        {
                          id: draft.id,
                          url: draft.url,
                          ...(draft.label.trim() === '' ? {} : { label: draft.label.trim() }),
                          ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
                          permissions: { default: 'requires_approval', tools: {} },
                        },
                      ],
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
            Label
            <input
              value={draft.label}
              data-autofocus
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
          <label>
            URL
            <input
              value={draft.url}
              required
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </label>
          <label>
            Bearer token
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>
        </Modal>
      )}
    </section>
  );
}
