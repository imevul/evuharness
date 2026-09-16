import type { ToolApprovalRule, ToolCatalogEntry } from '@evu/harness-protocol';

export interface ToolCatalogViewProps {
  /** The mode the catalog was requested for; availability is relative to it. */
  mode: string;
  tools: readonly ToolCatalogEntry[];
  /**
   * Persist a per-tool approval rule.
   *
   * Omitted for a display-only catalog. Builtin tools never call this: their
   * control stays disabled because gate tools cannot themselves cause a side
   * effect and must remain always allowed.
   */
  onApprovalChange?: (toolName: string, rule: ToolApprovalRule) => Promise<void> | void;
  className?: string;
}

/**
 * The tool catalog.
 *
 * Shows every registered tool with whether the current mode exposes it, rather than
 * hiding the unavailable ones: "why did it not use that tool" is almost always a
 * mode question, and the answer should be visible without reading configuration.
 *
 * When `onApprovalChange` is supplied, each non-builtin row can toggle between
 * `always_allow` and `requires_approval`. The host owns the PATCH.
 */
export function ToolCatalogView({
  mode,
  tools,
  onApprovalChange,
  className,
}: ToolCatalogViewProps) {
  const editable = onApprovalChange !== undefined;

  return (
    <div className={className} data-harness="tool-catalog" data-mode={mode}>
      {tools.map((tool) => (
        <div
          key={tool.name}
          data-harness="tool-entry"
          data-available={tool.availableInMode}
          data-mutates={tool.mutates}
          data-approval={tool.approval}
          data-builtin={tool.builtin || undefined}
        >
          <div data-harness="tool-entry-main">
            <span data-harness="tool-name">{tool.name}</span>
            <span data-harness="tool-description">{tool.description}</span>
            {tool.mutates && <span data-harness="tool-mutates">mutates</span>}
            {tool.builtin && <span data-harness="tool-builtin">built in</span>}
            {!tool.availableInMode && (
              <span data-harness="tool-unavailable">not available in {mode}</span>
            )}
          </div>
          {editable ? (
            <label data-harness="tool-approval-control">
              <span data-harness="tool-approval-label">Approval</span>
              <select
                data-harness="tool-approval-select"
                aria-label={`Approval policy for ${tool.name}`}
                value={tool.approval}
                disabled={tool.builtin}
                onChange={(event) => {
                  const rule = event.target.value as ToolApprovalRule;
                  void onApprovalChange(tool.name, rule);
                }}
              >
                <option value="always_allow">Always allow</option>
                <option value="requires_approval">Requires approval</option>
              </select>
            </label>
          ) : (
            tool.approval === 'requires_approval' && (
              <span data-harness="tool-approval">needs approval</span>
            )
          )}
        </div>
      ))}
    </div>
  );
}
