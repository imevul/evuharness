import type { ApprovalDecision, AskUserAnswer, PendingGates } from '@evu/harness-protocol';
import { AskUserGate } from './AskUserGate.js';
import { ModeSwitchGate } from './ModeSwitchGate.js';
import { PlanGate } from './PlanGate.js';
import { ToolApprovalGate } from './ToolApprovalGate.js';

export interface GateStackProps {
  pending: PendingGates;
  workspaceScoped?: boolean;
  onToolDecision: (approvalId: string, decision: ApprovalDecision) => void;
  onPlanDecision: (approve: boolean) => void;
  onModeSwitchDecision: (approve: boolean) => void;
  onAskUserAnswer: (askId: string, answers: AskUserAnswer[]) => void;
  className?: string;
}

/**
 * Every open gate, rendered in the order a person should deal with them.
 *
 * Ask-user comes first because the model is blocked waiting on an answer; tool
 * approvals follow, since each one holds a call. A host that wants a modal can wrap
 * this, but the gates themselves are inline so a queued approval is visible rather
 * than hidden behind whichever dialog happens to be on top.
 */
export function GateStack(props: GateStackProps) {
  const {
    pending,
    workspaceScoped = false,
    onToolDecision,
    onPlanDecision,
    onModeSwitchDecision,
    onAskUserAnswer,
    className,
  } = props;

  const empty =
    pending.askUser === null &&
    pending.modeSwitch === null &&
    pending.plan === null &&
    pending.toolApprovals.length === 0;

  if (empty) return null;

  return (
    <div className={className} data-harness="gate-stack">
      {pending.askUser !== null && (
        <AskUserGate
          ask={pending.askUser}
          onAnswer={(answers) => {
            if (pending.askUser !== null) onAskUserAnswer(pending.askUser.askId, answers);
          }}
        />
      )}

      {pending.modeSwitch !== null && (
        <ModeSwitchGate request={pending.modeSwitch} onDecide={onModeSwitchDecision} />
      )}

      {pending.plan !== null && (
        <PlanGate
          plan={pending.plan}
          onApprove={() => onPlanDecision(true)}
          onDiscard={() => onPlanDecision(false)}
        />
      )}

      {pending.toolApprovals.map((approval) => (
        <ToolApprovalGate
          key={approval.approvalId}
          approval={approval}
          workspaceScoped={workspaceScoped}
          onDecide={(decision) => onToolDecision(approval.approvalId, decision)}
        />
      ))}
    </div>
  );
}
