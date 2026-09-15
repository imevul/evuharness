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
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/**
 * Per-session or per-turn override of the active provider.
 *
 * A turn-level override does not change the session default, which keeps
 * "try this once with a bigger model" from mutating the session.
 */
export const ProviderOverrideSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: ReasoningEffortSchema.optional(),
});
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;

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

/** Only supplied fields are changed, so a UI can patch one tab at a time. */
export const HarnessSettingsUpdateSchema = z.object({
  activeProviderId: z.string().min(1).nullable().optional(),
  prompts: PromptSettingsSchema.partial().optional(),
  policies: PolicySettingsSchema.partial().optional(),
});
export type HarnessSettingsUpdate = z.infer<typeof HarnessSettingsUpdateSchema>;

export const ConnectionTestRequestSchema = z.object({
  providerId: z.string().min(1).optional(),
});
export type ConnectionTestRequest = z.infer<typeof ConnectionTestRequestSchema>;

export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  /** Round-trip latency, present only on success. */
  latencyMs: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  /** Redacted before it reaches here; never contains a credential. */
  message: z.string().optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const ModelListResponseSchema = z.object({
  providerId: z.string(),
  models: z.array(z.string()),
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
