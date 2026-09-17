import type { McpPermissions, ToolApprovalRule } from '@evu/harness-protocol';

export const DEFAULT_MCP_PERMISSIONS: McpPermissions = {
  default: 'requires_approval',
  tools: {},
};

/**
 * Approval rule for one `mcp_call`.
 *
 * A later per-tool map on the server profile wins over `default`. v1 writes an
 * empty `tools` object, so this returns `default` until that editor exists.
 */
export function resolveMcpCallApproval(
  permissions: McpPermissions | undefined,
  toolName: string,
): ToolApprovalRule {
  const policy = permissions ?? DEFAULT_MCP_PERMISSIONS;
  return policy.tools[toolName] ?? policy.default;
}
