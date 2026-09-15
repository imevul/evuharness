import type { ToolCatalogEntry } from '@evu/harness-protocol';

export interface ToolCatalogViewProps {
  /** The mode the catalog was requested for; availability is relative to it. */
  mode: string;
  tools: readonly ToolCatalogEntry[];
  className?: string;
}

/**
 * The tool catalog.
 *
 * Shows every registered tool with whether the current mode exposes it, rather than
 * hiding the unavailable ones: "why did it not use that tool" is almost always a
 * mode question, and the answer should be visible without reading configuration.
 */
export function ToolCatalogView({ mode, tools, className }: ToolCatalogViewProps) {
  return (
    <div className={className} data-harness="tool-catalog" data-mode={mode}>
      {tools.map((tool) => (
        <div
          key={tool.name}
          data-harness="tool-entry"
          data-available={tool.availableInMode}
          data-mutates={tool.mutates}
        >
          <span data-harness="tool-name">{tool.name}</span>
          <span data-harness="tool-description">{tool.description}</span>
          {tool.mutates && <span data-harness="tool-mutates">mutates</span>}
          {tool.approval === 'requires_approval' && (
            <span data-harness="tool-approval">needs approval</span>
          )}
          {tool.builtin && <span data-harness="tool-builtin">built in</span>}
          {!tool.availableInMode && (
            <span data-harness="tool-unavailable">not available in {mode}</span>
          )}
        </div>
      ))}
    </div>
  );
}
