import type { PendingPlan } from '@evu/harness-protocol';

export interface PlanGateProps {
  plan: PendingPlan;
  onApprove: () => void;
  onDiscard: () => void;
}

/** The plan gate: a proposed sequence of steps awaiting approval or discard. */
export function PlanGate({ plan, onApprove, onDiscard }: PlanGateProps) {
  return (
    <div data-harness="gate" data-gate="plan">
      <h3>{plan.title}</h3>

      <ol data-harness="plan-steps">
        {/* A pending plan is immutable while the gate is open, so index is identity. */}
        {plan.steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered list, see above
          <li key={`${step.tool ?? 'step'}-${index}`}>
            {step.tool !== undefined && <code>{step.tool}</code>} {step.summary}
          </li>
        ))}
      </ol>

      <div data-harness="gate-actions">
        <button type="button" onClick={onApprove} disabled={!plan.awaitingApproval}>
          Approve plan
        </button>
        <button type="button" data-harness="gate-deny" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
