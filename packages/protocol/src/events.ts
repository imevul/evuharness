import { z } from 'zod';
import {
  PendingAskUserSchema,
  PendingModeSwitchSchema,
  PendingPlanSchema,
  PendingToolApprovalSchema,
} from './gates.js';
import { ChatModeIdSchema, ToolEventSchema } from './session.js';

export const TurnPhaseSchema = z.enum(['started', 'thinking', 'tools', 'finalizing']);
export type TurnPhase = z.infer<typeof TurnPhaseSchema>;

const StatusEventSchema = z.object({
  event: z.literal('status'),
  sessionId: z.string(),
  phase: TurnPhaseSchema,
});

const SystemEventSchema = z.object({
  event: z.literal('system'),
  text: z.string(),
});

const DeltaEventSchema = z.object({
  event: z.literal('delta'),
  text: z.string(),
});

/** Emitted only by providers that expose reasoning content. Always optional. */
const ReasoningDeltaEventSchema = z.object({
  event: z.literal('reasoning_delta'),
  text: z.string(),
});

const ToolStreamEventSchema = z.object({
  event: z.literal('tool'),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: z.string(),
  denied: z.boolean().optional(),
});

const ToolApprovalRequiredEventSchema = PendingToolApprovalSchema.extend({
  event: z.literal('tool_approval_required'),
  sessionId: z.string(),
});

const AskUserRequiredEventSchema = PendingAskUserSchema.extend({
  event: z.literal('ask_user_required'),
  sessionId: z.string(),
});

/** Emitted when `propose_plan` opens a gate. The turn stays suspended until decide. */
const PlanApprovalRequiredEventSchema = PendingPlanSchema.extend({
  event: z.literal('plan_approval_required'),
  sessionId: z.string(),
});

/** Emitted when `request_mode_switch` opens a gate. */
const ModeSwitchRequiredEventSchema = PendingModeSwitchSchema.extend({
  event: z.literal('mode_switch_required'),
  sessionId: z.string(),
});

const UsageEventSchema = z.object({
  event: z.literal('usage'),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  promptTokensTotal: z.number().int().nonnegative(),
  completionTokensTotal: z.number().int().nonnegative(),
});

/**
 * Fields shared by the two successful terminal events.
 *
 * `mode` is echoed so a client can resync its draft control after a gate changed
 * the session default.
 *
 * `reasoning` is the accumulated reasoning text for the turn, when any provider
 * emitted it. It is never folded into `content`.
 */
const TerminalFieldsSchema = z.object({
  sessionId: z.string(),
  content: z.string(),
  mode: ChatModeIdSchema,
  title: z.string(),
  tools: z.array(ToolEventSchema).default([]),
  reasoning: z.string().optional(),
  pendingToolApprovals: z.array(PendingToolApprovalSchema).default([]),
  pendingPlan: PendingPlanSchema.nullable().default(null),
  pendingModeSwitch: PendingModeSwitchSchema.nullable().default(null),
  pendingAskUser: PendingAskUserSchema.nullable().default(null),
  promptTokensTotal: z.number().int().nonnegative().default(0),
  completionTokensTotal: z.number().int().nonnegative().default(0),
});

const DoneEventSchema = TerminalFieldsSchema.extend({
  event: z.literal('done'),
});

/**
 * Cancellation is a terminal state that still persists what was produced.
 *
 * `quiet` marks an interrupt with nothing worth showing, so a UI can suppress an
 * empty bubble rather than rendering a blank assistant row.
 */
const CancelledEventSchema = TerminalFieldsSchema.extend({
  event: z.literal('cancelled'),
  quiet: z.boolean().default(false),
  reason: z.enum(['operator', 'follow_up']).default('operator'),
});

const ErrorEventSchema = z.object({
  event: z.literal('error'),
  sessionId: z.string().optional(),
  message: z.string(),
});

export const StreamEventSchema = z.discriminatedUnion('event', [
  StatusEventSchema,
  SystemEventSchema,
  DeltaEventSchema,
  ReasoningDeltaEventSchema,
  ToolStreamEventSchema,
  ToolApprovalRequiredEventSchema,
  AskUserRequiredEventSchema,
  PlanApprovalRequiredEventSchema,
  ModeSwitchRequiredEventSchema,
  UsageEventSchema,
  DoneEventSchema,
  CancelledEventSchema,
  ErrorEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export type StatusEvent = z.infer<typeof StatusEventSchema>;
export type SystemEvent = z.infer<typeof SystemEventSchema>;
export type DeltaEvent = z.infer<typeof DeltaEventSchema>;
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;
export type ToolStreamEvent = z.infer<typeof ToolStreamEventSchema>;
export type ToolApprovalRequiredEvent = z.infer<typeof ToolApprovalRequiredEventSchema>;
export type AskUserRequiredEvent = z.infer<typeof AskUserRequiredEventSchema>;
export type PlanApprovalRequiredEvent = z.infer<typeof PlanApprovalRequiredEventSchema>;
export type ModeSwitchRequiredEvent = z.infer<typeof ModeSwitchRequiredEventSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type CancelledEvent = z.infer<typeof CancelledEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/** Event names that end a turn. Nothing follows one of these on the stream. */
export const TERMINAL_EVENTS = ['done', 'cancelled', 'error'] as const;
export type TerminalEventName = (typeof TERMINAL_EVENTS)[number];

export function isTerminalEvent(event: StreamEvent): boolean {
  return (TERMINAL_EVENTS as readonly string[]).includes(event.event);
}
