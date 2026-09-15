import { z } from 'zod';
import { ChatModeIdSchema } from './session.js';

/**
 * The approval decision ladder, widening from left to right.
 *
 * `allow_once` is the only digest-bound decision: it authorizes one exact call
 * and is consumed. The broader scopes are tool-wide, so granting one is a
 * deliberate widening of trust that a UI must present as such.
 */
export const ApprovalDecisionSchema = z.enum([
  'allow_once',
  'allow_session',
  'allow_workspace',
  'allow_always',
  'deny',
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Per-tool policy. Anything not `always_allow` opens a gate. */
export const ToolApprovalRuleSchema = z.enum(['always_allow', 'requires_approval']);
export type ToolApprovalRule = z.infer<typeof ToolApprovalRuleSchema>;

/**
 * Where a grant applies.
 *
 * `scopeId` is part of the lookup key, so a grant recorded for one workspace can
 * never resolve under another.
 */
export const GrantScopeSchema = z.enum(['session', 'workspace', 'global']);
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const GrantSchema = z.object({
  scope: GrantScopeSchema,
  /** Session id, workspace id, or null for global scope. */
  scopeId: z.string().min(1).nullable(),
  tool: z.string().min(1),
  /** Present only on one-shot receipts, binding the grant to exact arguments. */
  digest: z.string().optional(),
  createdAt: z.string(),
});
export type Grant = z.infer<typeof GrantSchema>;

/** An open tool-approval gate. The turn is suspended until it resolves. */
export const PendingToolApprovalSchema = z.object({
  approvalId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  /** Digest over normalized arguments. A decision authorizes this digest only. */
  digest: z.string(),
  requestedAt: z.string(),
});
export type PendingToolApproval = z.infer<typeof PendingToolApprovalSchema>;

export const PlanStepSchema = z.object({
  tool: z.string().optional(),
  summary: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/** A proposed plan awaiting approval or discard. */
export const PendingPlanSchema = z.object({
  planId: z.string(),
  title: z.string(),
  steps: z.array(PlanStepSchema),
  awaitingApproval: z.boolean().default(true),
  proposedAt: z.string(),
});
export type PendingPlan = z.infer<typeof PendingPlanSchema>;

/**
 * An agent-initiated mode switch request.
 *
 * The model may ask; only a person may approve. Approval writes the session
 * default mode, which is one of the few writers permitted to do so.
 */
export const PendingModeSwitchSchema = z.object({
  requestId: z.string(),
  from: ChatModeIdSchema,
  to: ChatModeIdSchema,
  reason: z.string(),
  requestedAt: z.string(),
});
export type PendingModeSwitch = z.infer<typeof PendingModeSwitchSchema>;

export const AskUserChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type AskUserChoice = z.infer<typeof AskUserChoiceSchema>;

export const AskUserQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  /** Empty for free-form input. */
  choices: z.array(AskUserChoiceSchema).default([]),
  allowMultiple: z.boolean().default(false),
  allowFreeForm: z.boolean().default(true),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

/**
 * An open ask-user gate.
 *
 * A first-class channel rather than a tool-result convention, so every surface
 * can render it natively instead of pattern-matching tool output.
 */
export const PendingAskUserSchema = z.object({
  askId: z.string(),
  questions: z.array(AskUserQuestionSchema).min(1),
  requestedAt: z.string(),
});
export type PendingAskUser = z.infer<typeof PendingAskUserSchema>;

export const AskUserAnswerSchema = z.object({
  questionId: z.string(),
  selected: z.array(z.string()).default([]),
  text: z.string().optional(),
});
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;

/** Every gate that can suspend a turn, as reported on a session record. */
export const PendingGatesSchema = z.object({
  toolApprovals: z.array(PendingToolApprovalSchema).default([]),
  plan: PendingPlanSchema.nullable().default(null),
  modeSwitch: PendingModeSwitchSchema.nullable().default(null),
  askUser: PendingAskUserSchema.nullable().default(null),
});
export type PendingGates = z.infer<typeof PendingGatesSchema>;
