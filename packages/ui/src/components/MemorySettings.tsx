import type { MemoryEntry, MemoryEntryWrite } from '@evu/harness-protocol';
import { useEffect, useState } from 'react';
import { Modal } from './Modal.js';

export interface MemorySettingsProps {
  userText: string;
  memories: readonly MemoryEntry[];
  onSaveUser: (text: string) => Promise<void> | void;
  onSearch: (query: string) => Promise<void> | void;
  onSaveMemory: (write: MemoryEntryWrite) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  className?: string;
}

/**
 * USER.md editor plus a searchable MEMORY list.
 *
 * Two documents, two panels: the person profile is a single textarea; everything
 * else that should persist across chats is a row you can add, edit, or delete.
 */
export function MemorySettings(props: MemorySettingsProps) {
  const { userText, memories, onSaveUser, onSearch, onSaveMemory, onDelete, className } = props;
  const [draft, setDraft] = useState(userText);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryEntry | { id: null } | null>(null);
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);
  const [memoryDraft, setMemoryDraft] = useState({ title: '', body: '' });

  useEffect(() => {
    setDraft(userText);
  }, [userText]);

  const dirty = draft !== userText;

  const saveUser = async () => {
    setBusy(true);
    try {
      await onSaveUser(draft);
    } finally {
      setBusy(false);
    }
  };

  const saveMemory = async () => {
    setBusy(true);
    try {
      await onSaveMemory({
        ...(editing !== null && editing.id !== null ? { id: editing.id } : {}),
        title: memoryDraft.title,
        body: memoryDraft.body,
      });
      await onSearch(query);
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={className} data-harness="memory-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>Memory</h2>
          <p data-harness="provider-settings-hint">
            Two stores: USER.md is standing facts about the person, MEMORY is everything else that
            should survive a chat.
          </p>
        </div>
      </header>

      <section data-harness="memory-user">
        <header data-harness="memory-panel-header">
          <div>
            <h3>USER.md</h3>
            <p data-harness="provider-settings-hint">
              Name, pronouns, timezone, voice, how they like to be addressed. Not projects.
            </p>
          </div>
          {dirty && <span data-harness="prompt-dirty">Unsaved changes</span>}
        </header>

        <form
          data-harness="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveUser();
          }}
        >
          <label>
            Profile
            <textarea
              data-harness="memory-user-editor"
              rows={12}
              spellCheck={false}
              placeholder={'Name: …\nPronouns: …\nTimezone: …\nVoice: never use em dashes.'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div data-harness="prompt-actions">
            <button type="submit" data-variant="primary" disabled={busy || !dirty}>
              Save USER.md
            </button>
            <button type="button" disabled={busy || !dirty} onClick={() => setDraft(userText)}>
              Reset
            </button>
          </div>
        </form>
      </section>

      <section data-harness="memory-list">
        <header data-harness="memory-panel-header">
          <div>
            <h3>MEMORY</h3>
            <p data-harness="provider-settings-hint">
              Projects, decisions, environment notes, “we tried X and it failed”.
            </p>
          </div>
          <button
            type="button"
            data-variant="primary"
            data-harness="memory-add"
            onClick={() => {
              setMemoryDraft({ title: '', body: '' });
              setEditing({ id: null });
            }}
          >
            Add memory
          </button>
        </header>

        <form data-harness="settings-form" onSubmit={(event) => event.preventDefault()}>
          <label data-harness="memory-search">
            Search
            <input
              type="search"
              placeholder="Search title or body"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                void onSearch(event.target.value);
              }}
            />
          </label>
        </form>

        {memories.length === 0 ? (
          <p data-harness="provider-empty">
            {query.trim() === ''
              ? 'No memories yet. Add one, or let the model remember() during a chat.'
              : 'No memories match that search.'}
          </p>
        ) : (
          <ul data-harness="provider-list">
            {memories.map((entry) => (
              <li key={entry.id} data-harness="provider-row">
                <div data-harness="provider-row-main">
                  <span data-harness="provider-label">
                    {entry.title.trim() === '' ? '(untitled)' : entry.title}
                  </span>
                  <span data-harness="provider-base-url">{entry.body}</span>
                </div>
                <div data-harness="provider-row-actions">
                  <button
                    type="button"
                    data-variant="ghost"
                    aria-label={`Edit ${entry.title === '' ? 'memory' : entry.title}`}
                    onClick={() => {
                      setMemoryDraft({ title: entry.title, body: entry.body });
                      setEditing(entry);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    aria-label={`Delete ${entry.title === '' ? 'memory' : entry.title}`}
                    onClick={() => setDeleting(entry)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing !== null && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.id === null ? 'Add memory' : 'Edit memory'}
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-variant="primary"
                disabled={busy || memoryDraft.body.trim() === ''}
                onClick={() => void saveMemory()}
              >
                Save
              </button>
            </>
          }
        >
          <label>
            Title
            <input
              data-autofocus
              value={memoryDraft.title}
              onChange={(event) => setMemoryDraft({ ...memoryDraft, title: event.target.value })}
            />
          </label>
          <label>
            Body
            <textarea
              rows={8}
              value={memoryDraft.body}
              onChange={(event) => setMemoryDraft({ ...memoryDraft, body: event.target.value })}
            />
          </label>
        </Modal>
      )}

      {deleting !== null && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Forget ${deleting.title.trim() === '' ? 'this memory' : deleting.title}?`}
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
                  void Promise.resolve(onDelete(id));
                }}
              >
                Delete memory
              </button>
            </>
          }
        >
          <p>This removes the MEMORY row. USER.md is not changed.</p>
        </Modal>
      )}
    </section>
  );
}
