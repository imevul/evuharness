import type { PromptPreview as PromptPreviewData } from '@evu/harness-protocol';
import { useEffect, useState } from 'react';

export interface PromptPreviewProps {
  preview: PromptPreviewData;
  className?: string;
}

type View = 'sections' | 'assembled';

/**
 * The composed system prompt, section by section or as one block.
 *
 * Sections are the default because the assembled text alone does not tell you which
 * part came from a mode, a host slot, or global settings — and that is the thing you
 * need in order to change it. Assembled is one toggle away for the times the
 * question is "what exactly does the model receive". Dynamic sections stay marked so
 * a reader knows the text was evaluated, not stored.
 */
export function PromptPreviewView({ preview, className }: PromptPreviewProps) {
  const [view, setView] = useState<View>('sections');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (id: string, text: string) => {
    // Absent over plain HTTP and in tests. Copy is a convenience, so a missing
    // clipboard degrades to nothing rather than to an error.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) return;

    void clipboard.writeText(text).then(() => setCopied(id));
  };

  return (
    <div className={className} data-harness="prompt-preview" data-mode={preview.mode}>
      {/* No group role: both buttons are self-labeling and carry their own pressed state. */}
      <div data-harness="prompt-preview-views">
        <button
          type="button"
          data-harness="prompt-preview-view"
          aria-pressed={view === 'sections'}
          data-active={view === 'sections'}
          onClick={() => setView('sections')}
        >
          Sections
        </button>
        <button
          type="button"
          data-harness="prompt-preview-view"
          aria-pressed={view === 'assembled'}
          data-active={view === 'assembled'}
          onClick={() => setView('assembled')}
        >
          Assembled
        </button>
      </div>

      {view === 'sections' ? (
        <ol data-harness="prompt-sections">
          {preview.sections.map((section) => (
            <li key={section.id} data-harness="prompt-section" data-dynamic={section.dynamic}>
              <div data-harness="prompt-section-header">
                <span data-harness="prompt-section-label">{section.label}</span>
                {section.dynamic && <span data-harness="prompt-section-dynamic">dynamic</span>}
                <button
                  type="button"
                  data-variant="ghost"
                  data-harness="prompt-section-copy"
                  aria-label={`Copy ${section.label}`}
                  onClick={() => copy(section.id, section.text)}
                >
                  {copied === section.id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre>{section.text}</pre>
            </li>
          ))}
        </ol>
      ) : (
        <div data-harness="prompt-assembled">
          <div data-harness="prompt-assembled-header">
            <span>{preview.text.length.toLocaleString()} characters</span>
            <button
              type="button"
              data-variant="ghost"
              data-harness="prompt-assembled-copy"
              aria-label="Copy assembled prompt"
              onClick={() => copy('assembled', preview.text)}
            >
              {copied === 'assembled' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{preview.text}</pre>
        </div>
      )}
    </div>
  );
}
