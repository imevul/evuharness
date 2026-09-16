import { z } from 'zod';
import { ToolApprovalRuleSchema } from './gates.js';
import { ChatModeIdSchema } from './session.js';

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * A named provider profile.
 *
 * Credentials never appear in a response: `hasApiKey` reports whether one is
 * configured, which is all a settings UI needs.
 */
/** Last-known catalog context window, keyed by model id. */
export const ModelContextWindowsSchema = z.record(z.string(), z.number().int().positive());
export type ModelContextWindows = z.infer<typeof ModelContextWindowsSchema>;

/**
 * User overrides of catalog windows, keyed by model id.
 *
 * On write, a `null` value clears that model's override. The public read shape
 * never contains nulls.
 */
export const ModelContextWindowOverridesWriteSchema = z.record(
  z.string(),
  z.number().int().positive().nullable(),
);

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  hasApiKey: z.boolean().default(false),
  /** Models offered in a picker. Empty means "ask the provider". */
  models: z.array(z.string()).default([]),
  supportsEffort: z.boolean().default(false),
  supportsReasoning: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Last catalog-discovered window per model id. */
  modelContextWindows: ModelContextWindowsSchema.default({}),
  /** Per-model overrides. When set, they win over the catalog for that id. */
  modelContextWindowOverrides: ModelContextWindowsSchema.default({}),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/**
 * Write shape for a provider profile.
 *
 * `apiKey` is write-only and absent from `ProviderProfile`:
 * - a string sets the secret
 * - `null` clears it
 * - omitted leaves whatever is stored unchanged (including on a new profile, which
 *   then has no key)
 */
export const ProviderProfileWriteSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  models: z.array(z.string()).optional(),
  supportsEffort: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  modelContextWindowOverrides: ModelContextWindowOverridesWriteSchema.optional(),
});
export type ProviderProfileWrite = z.infer<typeof ProviderProfileWriteSchema>;

/**
 * Per-session or per-turn override of the active provider.
 *
 * A turn-level override does not change the session default, which keeps
 * "try this once with a bigger model" from mutating the session. Session
 * overrides never rewrite named settings profiles either.
 */
export const ProviderOverrideSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: ReasoningEffortSchema.optional(),
});
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;

/**
 * Field-wise merge of provider overrides.
 *
 * Later layers win per field. Pass layers in ascending precedence order, e.g.
 * `mergeProviderOverrides(session, turn)` so turn > session. Settings active
 * profile is not an override layer — it is the base profile the turn loop
 * resolves when `providerId` is unset.
 */
export function mergeProviderOverrides(
  ...layers: Array<ProviderOverride | null | undefined>
): ProviderOverride | undefined {
  const merged: ProviderOverride = {};
  for (const layer of layers) {
    if (layer == null) continue;
    if (layer.providerId !== undefined) merged.providerId = layer.providerId;
    if (layer.model !== undefined) merged.model = layer.model;
    if (layer.effort !== undefined) merged.effort = layer.effort;
  }
  if (
    merged.providerId === undefined &&
    merged.model === undefined &&
    merged.effort === undefined
  ) {
    return undefined;
  }
  return merged;
}

export const PromptSettingsSchema = z.object({
  global: z.string().default(''),
  /** Keyed by mode id. A missing entry means the mode contributes no extra prompt. */
  perMode: z.record(ChatModeIdSchema, z.string()).default({}),
});
export type PromptSettings = z.infer<typeof PromptSettingsSchema>;

export const PolicySettingsSchema = z.object({
  /** Per-tool approval rules, keyed by tool name. */
  toolApprovals: z.record(z.string(), ToolApprovalRuleSchema).default({}),
  askUserEnabled: z.boolean().default(true),
  maxToolRounds: z.number().int().positive().default(12),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;

export const HarnessSettingsSchema = z.object({
  providers: z.array(ProviderProfileSchema).default([]),
  activeProviderId: z.string().min(1).nullable().default(null),
  prompts: PromptSettingsSchema,
  policies: PolicySettingsSchema,
  modes: z.array(ChatModeIdSchema).default([]),
});
export type HarnessSettings = z.infer<typeof HarnessSettingsSchema>;

/**
 * Only supplied fields are changed, so a UI can patch one tab at a time.
 *
 * `providers` is an upsert-by-id, not a replace-all: a providers tab must not
 * wipe profiles a different tab did not send. Removals go through
 * `removeProviderIds` for the same reason.
 */
export const HarnessSettingsUpdateSchema = z.object({
  activeProviderId: z.string().min(1).nullable().optional(),
  providers: z.array(ProviderProfileWriteSchema).optional(),
  removeProviderIds: z.array(z.string().min(1)).optional(),
  prompts: PromptSettingsSchema.partial().optional(),
  policies: PolicySettingsSchema.partial().optional(),
});
export type HarnessSettingsUpdate = z.infer<typeof HarnessSettingsUpdateSchema>;

export const ConnectionTestRequestSchema = z.object({
  providerId: z.string().min(1).optional(),
});
export type ConnectionTestRequest = z.infer<typeof ConnectionTestRequestSchema>;

export const ModelListRequestSchema = z.object({
  providerId: z.string().min(1).optional(),
});
export type ModelListRequest = z.infer<typeof ModelListRequestSchema>;

export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  /** Round-trip latency, present only on success. */
  latencyMs: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  /** Redacted before it reaches here; never contains a credential. */
  message: z.string().optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ModelListResponseSchema = z.object({
  providerId: z.string(),
  models: z.array(ModelCatalogEntrySchema),
});
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

/** One contributed section of a composed system prompt. */
export const PromptSectionSchema = z.object({
  /** Stable identifier, e.g. `global`, `mode`, or a host slot id. */
  id: z.string(),
  label: z.string(),
  text: z.string(),
  /** True for host-supplied slots evaluated at composition time. */
  dynamic: z.boolean().default(false),
});
export type PromptSection = z.infer<typeof PromptSectionSchema>;

/**
 * The composed prompt, section by section plus the assembled text.
 *
 * Preview runs the same composition a new session runs, including dynamic slots,
 * so what a person reads here is what the model receives.
 */
export const PromptPreviewSchema = z.object({
  mode: ChatModeIdSchema,
  sections: z.array(PromptSectionSchema),
  text: z.string(),
});
export type PromptPreview = z.infer<typeof PromptPreviewSchema>;

export const PromptPreviewRequestSchema = z.object({
  mode: ChatModeIdSchema,
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});
export type PromptPreviewRequest = z.infer<typeof PromptPreviewRequestSchema>;
