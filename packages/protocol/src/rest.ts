import { z } from 'zod';
import { AttachmentRefSchema } from './attachments.js';
import { ContextMenuDescriptorSchema, ContextRefSchema } from './context-menus.js';
import { ApprovalDecisionSchema, AskUserAnswerSchema, PendingGatesSchema } from './gates.js';
import {
  ChatMessageSchema,
  ChatModeIdSchema,
  SessionSummarySchema,
  SessionUsageSchema,
  TranscriptRowSchema,
} from './session.js';
import { ProviderOverrideSchema, ReasoningEffortSchema } from './settings.js';

/**
 * A user message plus the structured references its chips produced.
 *
 * `refs` are context-menu picks. `attachments` are image/file chips from the
 * composer attach control. Both ride the wire so core never re-parses prose.
 */
export const UserTurnInputSchema = z.object({
  text: z.string(),
  refs: z.array(ContextRefSchema).default([]),
  attachments: z.array(AttachmentRefSchema).default([]),
});
export type UserTurnInput = z.infer<typeof UserTurnInputSchema>;

/**
 * A chat request.
 *
 * `mode` is the pin for this turn: it is captured once and held for the turn's
 * whole lifetime, including across tool rounds and gate waits. It also wins over
 * the stored session default and quietly updates it.
 *
 * `messages` carries more than one entry when a follow-up queue is drained, so
 * several queued user messages become a single turn.
 */
export const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  mode: ChatModeIdSchema,
  messages: z.array(UserTurnInputSchema).min(1),
  provider: ProviderOverrideSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const CreateSessionRequestSchema = z.object({
  mode: ChatModeIdSchema,
  /** Fixed at creation; a session never moves between workspaces. */
  workspaceId: z.string().min(1).optional(),
  title: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ListSessionsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/** Full session detail, including the transcript and any open gates. */
export const SessionDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: ChatModeIdSchema,
  workspaceId: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  usage: SessionUsageSchema,
  turnInProgress: z.boolean().default(false),
  transcript: z.array(TranscriptRowSchema).default([]),
  pending: PendingGatesSchema,
  provider: ProviderOverrideSchema.optional(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

/**
 * An explicit mode change, outside a turn.
 *
 * Quiet by default: it updates the session default without adding a transcript
 * row, since a mode change is not conversation.
 */
export const SetModeRequestSchema = z.object({
  mode: ChatModeIdSchema,
  announce: z.boolean().default(false),
});
export type SetModeRequest = z.infer<typeof SetModeRequestSchema>;

/**
 * Persist a session-level provider preference, or clear it with `null`.
 *
 * Distinct from a per-turn `ChatRequest.provider`: this writes the session
 * record and does not rewrite named settings profiles.
 */
export const SetProviderRequestSchema = z.object({
  provider: ProviderOverrideSchema.nullable(),
});
export type SetProviderRequest = z.infer<typeof SetProviderRequestSchema>;

/**
 * `follow_up` means the user sent another message while a turn was live. The
 * partial result is persisted and the queued messages are drained as one turn.
 */
export const CancelRequestSchema = z.object({
  reason: z.enum(['operator', 'follow_up']).default('operator'),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const ToolApprovalDecisionRequestSchema = z.object({
  decision: ApprovalDecisionSchema,
});
export type ToolApprovalDecisionRequest = z.infer<typeof ToolApprovalDecisionRequestSchema>;

export const AskUserResponseRequestSchema = z.object({
  answers: z.array(AskUserAnswerSchema).min(1),
});
export type AskUserResponseRequest = z.infer<typeof AskUserResponseRequestSchema>;

export const ModeSwitchDecisionRequestSchema = z.object({
  approve: z.boolean(),
});
export type ModeSwitchDecisionRequest = z.infer<typeof ModeSwitchDecisionRequestSchema>;

export const ContextMenuCatalogResponseSchema = z.object({
  menus: z.array(ContextMenuDescriptorSchema),
});
export type ContextMenuCatalogResponse = z.infer<typeof ContextMenuCatalogResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ActiveProviderSnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  model: z.string().min(1),
  /** Effective effort after session/turn overrides, when set. */
  effort: ReasoningEffortSchema.optional(),
  /** Resolved max for `model`: override ?? catalog. Omitted when unknown. */
  contextWindow: z.number().int().positive().optional(),
});
export type ActiveProviderSnapshot = z.infer<typeof ActiveProviderSnapshotSchema>;

export const HarnessFeaturesSnapshotSchema = z.object({
  settings: z.boolean(),
  effort: z.boolean(),
  attachments: z.boolean(),
  agents: z.boolean().default(false),
  memory: z.boolean().default(false),
  webSearch: z.boolean().default(false),
  httpRequest: z.boolean().default(false),
  compaction: z.boolean().default(false),
  mcp: z.boolean().default(false),
});
export type HarnessFeaturesSnapshot = z.infer<typeof HarnessFeaturesSnapshotSchema>;

export const StatusResponseSchema = z.object({
  ready: z.boolean(),
  modes: z.array(ChatModeIdSchema),
  activeProviderId: z.string().nullable(),
  /** Public snapshot of the active profile and the resolved window for its model. */
  activeProvider: ActiveProviderSnapshotSchema.nullable().default(null),
  providerConfigured: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  contextMenuCount: z.number().int().nonnegative(),
  /** Effective feature flags from harness config. */
  features: HarnessFeaturesSnapshotSchema.optional(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Canonical route paths, relative to whatever base a host mounts the router at.
 *
 * Exported as data so a client, a server, and a terminal surface cannot drift
 * from each other over a typo.
 */
export const ROUTES = {
  health: '/health',
  status: '/status',
  chat: '/chat',
  sessions: '/sessions',
  session: (id: string) => `/sessions/${id}`,
  cancel: (id: string) => `/sessions/${id}/cancel`,
  setMode: (id: string) => `/sessions/${id}/set-mode`,
  setProvider: (id: string) => `/sessions/${id}/set-provider`,
  toolApproval: (id: string, approvalId: string) => `/sessions/${id}/tool-approvals/${approvalId}`,
  approvePlan: (id: string) => `/sessions/${id}/approve-plan`,
  discardPlan: (id: string) => `/sessions/${id}/discard-plan`,
  modeSwitch: (id: string) => `/sessions/${id}/mode-switch`,
  askUser: (id: string, askId: string) => `/sessions/${id}/ask-user/${askId}`,
  settings: '/settings',
  models: '/models',
  testConnection: '/test',
  promptPreview: '/prompt/preview',
  tools: '/tools',
  contextMenus: '/context-menus',
  contextMenuItems: (menuId: string) => `/context-menus/${menuId}/items`,
  memoryUser: '/memory/user',
  memories: '/memory',
  memory: (id: string) => `/memory/${id}`,
  compactionReset: (id: string) => `/sessions/${id}/compaction/reset`,
  mcpHealth: (id: string) => `/mcp/${id}/test`,
} as const;

export const ChatMessageArraySchema = z.array(ChatMessageSchema);
