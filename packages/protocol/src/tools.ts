import { z } from 'zod';
import { ToolApprovalRuleSchema } from './gates.js';

/**
 * A tool as advertised to a model and to a catalog UI.
 *
 * `parameters` is a JSON Schema object passed through to the provider. It is
 * typed loosely on purpose: the runtime does not interpret it, and pinning a
 * schema-of-schemas here would only fight provider-specific dialects.
 */
export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  /**
   * Mode ids permitted to call this tool. Empty defers to the mode policy, which
   * decides based on `mutates`.
   */
  modes: z.array(z.string()).default([]),
  /**
   * Whether calling this tool can change something.
   *
   * Defaults to `true` because the safe default for an unannotated tool is to
   * assume it has side effects: a host that forgets to annotate gets a tool
   * excluded from read-only modes rather than one that quietly runs in `ask`.
   */
  mutates: z.boolean().default(true),
  approval: ToolApprovalRuleSchema.default('requires_approval'),
  /** Marks a tool as owned by the runtime rather than the host. */
  builtin: z.boolean().default(false),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const ToolCatalogEntrySchema = ToolSpecSchema.extend({
  /** Whether the tool is callable in the mode the catalog was requested for. */
  availableInMode: z.boolean().default(true),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

export const ToolCatalogResponseSchema = z.object({
  mode: z.string(),
  tools: z.array(ToolCatalogEntrySchema),
});
export type ToolCatalogResponse = z.infer<typeof ToolCatalogResponseSchema>;

/**
 * Runtime-owned tool names.
 *
 * Gate tools are exempt from approval because they cannot themselves cause a
 * side effect: each one opens a gate that a person resolves. `report_progress`
 * is exempt because it only writes a short user-visible note.
 */
export const BUILTIN_TOOL_NAMES = {
  requestModeSwitch: 'request_mode_switch',
  proposePlan: 'propose_plan',
  askUser: 'ask_user',
  loadSkill: 'load_skill',
  reportProgress: 'report_progress',
} as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[keyof typeof BUILTIN_TOOL_NAMES];

export const BUILTIN_TOOL_NAME_LIST = Object.values(BUILTIN_TOOL_NAMES);

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAME_LIST as readonly string[]).includes(name);
}
