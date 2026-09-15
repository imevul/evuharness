import type { PendingModeSwitch } from '@evu/harness-protocol';

export interface ModeSwitchGateProps {
  request: PendingModeSwitch;
  onDecide: (approve: boolean) => void;
}

/**
 * The mode-switch gate.
 *
 * The model may ask to change mode; only a person may approve. Approval is one of
 * the few paths that writes the session's default mode, so it is a gate rather than
 * a notification — a model that could widen its own tool policy would make every
 * other approval decision meaningless.
 */
export function ModeSwitchGate({ request, onDecide }: ModeSwitchGateProps) {
  return (
    <div data-harness="gate" data-gate="mode-switch">
      <h3>
        Switch from <code>{request.from}</code> to <code>{request.to}</code>?
      </h3>
      <p data-harness="gate-reason">{request.reason}</p>

      <div data-harness="gate-actions">
        <button type="button" onClick={() => onDecide(true)}>
          Switch
        </button>
        <button type="button" data-harness="gate-deny" onClick={() => onDecide(false)}>
          Stay in {request.from}
        </button>
      </div>
    </div>
  );
}
