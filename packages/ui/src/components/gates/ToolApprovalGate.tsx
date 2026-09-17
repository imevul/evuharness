import type { ApprovalDecision, PendingToolApproval } from '@evu/harness-protocol';

export interface ToolApprovalGateProps {
  approval: PendingToolApproval;
  /** True when the session belongs to a workspace; gates the workspace option. */
  workspaceScoped?: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}

/**
 * The tool approval gate.
 *
 * Shows the exact arguments, because a decision authorizes a specific call and the
 * user cannot judge it otherwise. `allow_once` is bound to this digest; the wider
 * options are tool-wide, which is why they are labeled with their reach rather than
 * as degrees of "yes".
 *
 * `allow_workspace` is hidden for a session with no workspace: offering a scope that
 * collapses to "always" would understate what the user is granting.
 */
export function ToolApprovalGate({
  approval,
  workspaceScoped = false,
  onDecide,
}: ToolApprovalGateProps) {
  return (
    <div data-harness="gate" data-gate="tool-approval">
      <h3>
        Run <code>{approval.tool}</code>?
      </h3>

      {approval.tool === 'mcp_call' && (
        <p data-harness="gate-mcp-hint">
          Allowing this call authorizes this server, remote tool, and arguments only — not every MCP
          server.
        </p>
      )}

      <pre data-harness="gate-arguments">{JSON.stringify(approval.arguments, null, 2)}</pre>

      <div data-harness="gate-actions">
        <button type="button" onClick={() => onDecide('allow_once')}>
          Allow once
        </button>
        <button type="button" onClick={() => onDecide('allow_session')}>
          Allow for this chat
        </button>
        {workspaceScoped && (
          <button type="button" onClick={() => onDecide('allow_workspace')}>
            Allow in this workspace
          </button>
        )}
        <button type="button" onClick={() => onDecide('allow_always')}>
          Always allow
        </button>
        <button type="button" data-harness="gate-deny" onClick={() => onDecide('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}
