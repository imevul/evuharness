import type { AgentProfile, HarnessSettings, HarnessSettingsUpdate } from '@evu/harness-protocol';
import { useState } from 'react';
import { Modal } from './Modal.js';

export interface AgentSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  className?: string;
}

export function AgentSettings({ settings, onChange, className }: AgentSettingsProps) {
  const [editing, setEditing] = useState<AgentProfile | { id: null } | null>(null);
  const [deleting, setDeleting] = useState<AgentProfile | null>(null);
  const [draft, setDraft] = useState({ id: '', label: '', soul: '' });
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    setDraft({ id: crypto.randomUUID(), label: '', soul: '' });
    setEditing({ id: null });
  };

  const openEdit = (agent: AgentProfile) => {
    setDraft({ id: agent.id, label: agent.label ?? '', soul: agent.soul });
    setEditing(agent);
  };

  return (
    <section className={className} data-harness="agent-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>Agents</h2>
          <p data-harness="provider-settings-hint">
            The active soul is composed into the system prompt after the mode text.
          </p>
        </div>
        <button type="button" data-variant="primary" onClick={openNew}>
          Add agent
        </button>
      </header>

      {settings.agents.length === 0 ? (
        <p data-harness="provider-empty">No agent yet. Add a soul to give the model a voice.</p>
      ) : (
        <ul data-harness="provider-list">
          {settings.agents.map((agent) => {
            const active = agent.id === settings.activeAgentId;
            return (
              <li key={agent.id} data-harness="provider-row" data-active={active}>
                <div data-harness="provider-row-main">
                  <span data-harness="provider-label">{agent.label ?? agent.id}</span>
                </div>
                <div data-harness="provider-row-meta">
                  {active ? (
                    <span data-harness="provider-active-badge">Active</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onChange({ activeAgentId: agent.id })}
                    >
                      Use
                    </button>
                  )}
                </div>
                <div data-harness="provider-row-actions">
                  <button type="button" data-variant="ghost" onClick={() => openEdit(agent)}>
                    ✎
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    disabled={busy}
                    onClick={() => setDeleting(agent)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.id === null ? 'Add agent' : 'Edit agent'}
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
                      agents: [
                        {
                          id: draft.id,
                          soul: draft.soul,
                          ...(draft.label.trim() === '' ? {} : { label: draft.label.trim() }),
                        },
                      ],
                      ...(settings.activeAgentId === null ? { activeAgentId: draft.id } : {}),
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
            Soul
            <textarea
              rows={12}
              value={draft.soul}
              onChange={(event) => setDraft({ ...draft, soul: event.target.value })}
            />
          </label>
        </Modal>
      )}

      {deleting !== null && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.label ?? deleting.id}?`}
          footer={
            <>
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-variant="danger"
                disabled={busy}
                onClick={() => {
                  const id = deleting.id;
                  setDeleting(null);
                  setBusy(true);
                  void Promise.resolve(onChange({ removeAgentIds: [id] })).finally(() =>
                    setBusy(false),
                  );
                }}
              >
                Delete agent
              </button>
            </>
          }
        >
          <p>The soul is removed. Sessions keep using the remaining active agent if one exists.</p>
        </Modal>
      )}
    </section>
  );
}
