import type { PromptPreview as PromptPreviewData } from '@evu/harness-protocol';

export interface PromptPreviewProps {
  preview: PromptPreviewData;
  className?: string;
}

/**
 * The composed system prompt, section by section.
 *
 * Sections are shown alongside the assembled text because the assembled text alone
 * does not tell you which part came from a mode, a host slot, or global settings —
 * and that is the thing you need to know in order to change it. Dynamic sections are
 * marked so a reader knows the text was evaluated, not stored.
 */
export function PromptPreviewView({ preview, className }: PromptPreviewProps) {
  return (
    <div className={className} data-harness="prompt-preview" data-mode={preview.mode}>
      <ol data-harness="prompt-sections">
        {preview.sections.map((section) => (
          <li key={section.id} data-harness="prompt-section" data-dynamic={section.dynamic}>
            <span data-harness="prompt-section-label">{section.label}</span>
            {section.dynamic && <span data-harness="prompt-section-dynamic">dynamic</span>}
            <pre>{section.text}</pre>
          </li>
        ))}
      </ol>

      <details data-harness="prompt-assembled">
        <summary>Assembled prompt</summary>
        <pre>{preview.text}</pre>
      </details>
    </div>
  );
}
