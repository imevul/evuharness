import { z } from 'zod';
import { AttachmentRefSchema, MessageContentSchema } from './attachments.js';

/**
 * Mode ids are open strings rather than a closed enum: custom modes are an
 * extension point, so the runtime validates an id against the registered mode
 * catalog instead of the schema pinning a fixed set.
 */
export const ChatModeIdSchema = z.string().min(1);
export type ChatModeId = z.infer<typeof ChatModeIdSchema>;

/** Mode ids shipped by the runtime. Hosts may register additional ones. */
export const STOCK_MODE_IDS = ['ask', 'plan', 'agent'] as const;
export type StockModeId = (typeof STOCK_MODE_IDS)[number];

/**
 * Optional scope attached to a session and threaded to every extension point.
 *
 * Hosts that never adopt workspaces leave `workspaceId` unset, in which case
 * workspace-scoped behavior collapses into global behavior with no special
 * casing anywhere.
 */
export const ScopeSchema = z.object({
  workspaceId: z.string().min(1).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** One tool call on an assistant message, matching the provider thread. */
export const MessageToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type MessageToolCall = z.infer<typeof MessageToolCallSchema>;

/** A message in the thread sent to the model. */
export const ChatMessageSchema = z.object({
  role: MessageRoleSchema,
  /**
   * Plain string for most roles. User turns with images may use multimodal
   * parts (`text` + `image_url`) so OpenAI-compatible providers receive them.
   */
  content: MessageContentSchema,
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(MessageToolCallSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** A completed tool call, as rendered in a transcript. */
export const ToolEventSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: z.string(),
  /** Set when the call was refused, so a UI can distinguish denial from failure. */
  denied: z.boolean().optional(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

export const TranscriptRowKindSchema = z.enum(['user', 'assistant', 'system']);
export type TranscriptRowKind = z.infer<typeof TranscriptRowKindSchema>;

/**
 * A row a UI renders.
 *
 * Transcript rows are deliberately separate from the model thread: they carry
 * presentation state such as `partial` and `cancelled` that must never be sent
 * to a model, and the thread carries system content a UI should not display.
 */
export const TranscriptRowSchema = z.object({
  kind: TranscriptRowKindSchema,
  text: z.string(),
  /** Structured attachments echoed for UI chips; never sent to the model alone. */
  attachments: z.array(AttachmentRefSchema).optional(),
  tools: z.array(ToolEventSchema).optional(),
  reasoning: z.string().optional(),
  partial: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  createdAt: z.string().optional(),
  /** Turn pin time. With `createdAt`, this is how long the turn ran. */
  startedAt: z.string().optional(),
});
export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Cumulative token accounting for a session. */
export const SessionUsageSchema = z.object({
  promptTokensTotal: z.number().int().nonnegative().default(0),
  completionTokensTotal: z.number().int().nonnegative().default(0),
  /** Last turn's prompt size, which is what a context-window footer shows. */
  lastPromptTokens: z.number().int().nonnegative().default(0),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** Lightweight session row for a sidebar, cheap to list without a transcript. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: ChatModeIdSchema,
  workspaceId: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  usage: SessionUsageSchema,
  turnInProgress: z.boolean().default(false),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
