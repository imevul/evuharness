import type {
  ChatModeId,
  HarnessSettings,
  HarnessSettingsUpdate,
  PromptPreview as PromptPreviewData,
} from '@evu/harness-protocol';
import { useEffect, useState } from 'react';
import { PromptPreviewView } from './PromptPreview.js';

const FALLBACK_MODES: ChatModeId[] = ['ask'];

export interface PromptSettingsProps {
  settings: HarnessSettings;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  /**
   * Load a composed preview for a mode.
   *
   * Must call the same preview path a turn uses (server `GET /prompt/preview` →
   * `composePrompt`), including dynamic slots. The editor does not invent a
   * second composition.
   */
  loadPreview: (mode: ChatModeId) => Promise<PromptPreviewData>;
  className?: string;
}

/**
 * Editable global and per-mode prompts, with a live composed preview.
 *
 * Save writes through the secret-safe settings PATCH. Preview then reloads from
 * the store so what a person reads includes host dynamic slots and matches the
 * system prompt a new turn would pin.
 */
export function PromptSettings(props: PromptSettingsProps) {
  const { settings, onChange, loadPreview, className } = props;
  const modes = settings.modes.length > 0 ? settings.modes : FALLBACK_MODES;
  const [mode, setMode] = useState<ChatModeId>(() => modes[0] ?? 'ask');
  const [globalDraft, setGlobalDraft] = useState(settings.prompts.global);
  const [perModeDraft, setPerModeDraft] = useState(settings.prompts.perMode[mode] ?? '');
  const [preview, setPreview] = useState<PromptPreviewData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a successful save so in-flight loads cancel and preview reloads. */
  const [previewEpoch, setPreviewEpoch] = useState(0);

  useEffect(() => {
    setGlobalDraft(settings.prompts.global);
    setPerModeDraft(settings.prompts.perMode[mode] ?? '');
  }, [settings.prompts, mode]);

  useEffect(() => {
    if (!modes.includes(mode)) {
      const fallback = modes[0];
      if (fallback !== undefined) {
        setMode(fallback);
      }
    }
  }, [modes, mode]);

  useEffect(() => {
    let cancelled = false;
    setBusy('preview');
    setError(null);
    // previewEpoch is an intentional reload signal after save.
    void previewEpoch;
    void loadPreview(mode)
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, loadPreview, previewEpoch]);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await onChange({
        prompts: {
          global: globalDraft,
          perMode: { [mode]: perModeDraft },
        },
      });
      // Reload through the same compose path a turn uses (cancels any in-flight load).
      setPreviewEpoch((epoch) => epoch + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={className} data-harness="prompt-settings">
      <header data-harness="prompt-settings-header">
        <h2>Prompts</h2>
      </header>

      <form
        data-harness="prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Global prompt
          <textarea
            data-harness="prompt-global"
            value={globalDraft}
            rows={6}
            spellCheck={false}
            onChange={(event) => setGlobalDraft(event.target.value)}
          />
        </label>

        <label>
          Mode
          <select
            data-harness="prompt-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            {modes.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>

        <label>
          Per-mode prompt ({mode})
          <textarea
            data-harness="prompt-per-mode"
            value={perModeDraft}
            rows={4}
            spellCheck={false}
            onChange={(event) => setPerModeDraft(event.target.value)}
          />
        </label>

        <div data-harness="prompt-actions">
          <button type="submit" disabled={busy !== null}>
            Save prompts
          </button>
        </div>

        {error !== null && <p data-harness="prompt-error">{error}</p>}
      </form>

      <div data-harness="prompt-preview-panel">
        <header data-harness="prompt-preview-header">
          <h3>Composed preview</h3>
          {busy === 'preview' && <span data-harness="prompt-preview-busy">Refreshing…</span>}
        </header>
        <p data-harness="prompt-preview-hint">
          Same composition a turn pins, including dynamic slots. Save to refresh after edits.
        </p>
        {preview !== null ? (
          <PromptPreviewView preview={preview} />
        ) : (
          <p data-harness="prompt-preview-empty">No preview yet.</p>
        )}
      </div>
    </section>
  );
}
