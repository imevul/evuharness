import type { ModelCatalogEntry } from '@evu/harness-protocol';
import { useId, useState } from 'react';
import { formatContextWindow } from '../k-notation.js';
import { Modal } from './Modal.js';

export interface ModelPickerFieldProps {
  value: string;
  onChange: (model: string) => void;
  /**
   * Load the provider's catalog. Called each time the picker opens, because a
   * running provider can gain or lose a model between two visits to this form.
   *
   * Omitted when there is nothing to ask yet — a profile that has never been
   * saved has no server-side identity to list models for.
   */
  loadModels?: () => Promise<readonly ModelCatalogEntry[]>;
  /** Why Browse is unavailable, shown beside the disabled control. */
  browseHint?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A model id field: free text, with a Browse picker beside it.
 *
 * Free text stays authoritative. A provider may serve a model it does not
 * advertise, and a picker that refused unknown ids would make that unreachable —
 * so the catalog is an aid, never a constraint.
 */
export function ModelPickerField(props: ModelPickerFieldProps) {
  const {
    value,
    onChange,
    loadModels,
    browseHint,
    label = 'Model',
    required = false,
    disabled = false,
    className,
  } = props;

  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ModelCatalogEntry[]>([]);
  const [query, setQuery] = useState('');

  const openPicker = () => {
    if (loadModels === undefined) return;

    setOpen(true);
    setError(null);
    setModels([]);
    setQuery('');
    setLoading(true);

    void loadModels()
      .then((listed) => {
        setModels(listed);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const needle = query.trim().toLowerCase();
  const matches =
    needle === '' ? models : models.filter((entry) => entry.id.toLowerCase().includes(needle));

  return (
    <div className={className} data-harness="model-picker">
      <label htmlFor={inputId}>{label}</label>

      <div data-harness="model-picker-row">
        <input
          id={inputId}
          value={value}
          required={required}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          data-harness="model-picker-input"
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          data-harness="model-picker-browse"
          disabled={disabled || loadModels === undefined}
          onClick={openPicker}
        >
          Browse
        </button>
      </div>

      {loadModels === undefined && browseHint !== undefined && (
        <p data-harness="model-picker-hint">{browseHint}</p>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Pick a model"
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        }
      >
        <input
          type="search"
          value={query}
          placeholder="Filter models…"
          aria-label="Filter models"
          spellCheck={false}
          data-autofocus
          data-harness="model-picker-filter"
          onChange={(event) => setQuery(event.target.value)}
        />

        {loading && <p data-harness="model-picker-loading">Loading models from the provider…</p>}

        {!loading && error !== null && <p data-harness="model-picker-error">{error}</p>}

        {!loading && error === null && models.length === 0 && (
          <p data-harness="model-picker-empty">This provider did not return any models.</p>
        )}

        {!loading && error === null && models.length > 0 && matches.length === 0 && (
          <p data-harness="model-picker-empty">No model matches “{query}”.</p>
        )}

        {matches.length > 0 && (
          <ul data-harness="model-picker-list">
            {matches.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-harness="model-picker-option"
                  data-selected={entry.id === value}
                  onClick={() => {
                    onChange(entry.id);
                    setOpen(false);
                  }}
                >
                  <span data-harness="model-picker-option-id">{entry.id}</span>
                  {entry.contextWindow !== undefined && (
                    <span data-harness="model-picker-option-window">
                      {formatContextWindow(entry.contextWindow)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
