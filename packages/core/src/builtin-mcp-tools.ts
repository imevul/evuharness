import type { McpPermissions } from '@evu/harness-protocol';
import { createMcpClient, type McpServerRuntime } from './mcp-client.js';
import type { ToolDefinition } from './tools.js';
import { wrapUntrustedToolResult } from './untrusted.js';

export interface McpToolsDeps {
  fetch: typeof fetch;
  listServers: () => Promise<Array<McpServerRuntime & { permissions: McpPermissions }>>;
}

export function builtinMcpTools(deps: McpToolsDeps): ToolDefinition[] {
  const client = createMcpClient(deps.fetch);

  return [
    {
      name: 'mcp_list',
      description:
        'List tools on a configured MCP server, or on every enabled server when serverId is omitted.',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: 'MCP server id from settings.' },
        },
      },
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: async (args) => {
        const servers = (await deps.listServers()).filter((server) => server.enabled);
        const wanted = typeof args.serverId === 'string' ? args.serverId : undefined;
        const selected =
          wanted === undefined ? servers : servers.filter((server) => server.id === wanted);
        if (selected.length === 0) {
          return wrapUntrustedToolResult('mcp_list', 'No matching MCP server.');
        }
        const lines: string[] = [];
        for (const server of selected) {
          try {
            const tools = await client.listTools(server);
            const names =
              tools.length === 0
                ? '(no tools)'
                : tools
                    .map(
                      (tool) =>
                        `- ${tool.name}${tool.description === undefined ? '' : `: ${tool.description}`}`,
                    )
                    .join('\n');
            lines.push(`${server.label ?? server.id}\n${names}`);
          } catch (cause) {
            lines.push(
              `${server.label ?? server.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        return wrapUntrustedToolResult('mcp_list', lines.join('\n\n'));
      },
    },
    {
      name: 'mcp_call',
      description:
        'Call one tool on a configured MCP server. Requires approval unless that server’s permissions allow the named tool. Arguments must match the remote schema from mcp_list.',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: 'MCP server id.' },
          tool: { type: 'string', description: 'Remote tool name.' },
          arguments: { type: 'object', description: 'Arguments for the remote tool.' },
        },
        required: ['serverId', 'tool'],
      },
      mutates: true,
      approval: 'requires_approval',
      builtin: true,
      handler: async (args) => {
        const serverId = String(args.serverId ?? '');
        const tool = String(args.tool ?? '');
        const payload =
          args.arguments !== null &&
          typeof args.arguments === 'object' &&
          !Array.isArray(args.arguments)
            ? (args.arguments as Record<string, unknown>)
            : {};
        const server = (await deps.listServers()).find((entry) => entry.id === serverId);
        if (server === undefined || !server.enabled) {
          return wrapUntrustedToolResult('mcp_call', `Unknown or disabled MCP server: ${serverId}`);
        }
        try {
          const text = await client.callTool(server, tool, payload);
          return wrapUntrustedToolResult('mcp_call', text);
        } catch (cause) {
          return wrapUntrustedToolResult(
            'mcp_call',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      },
    },
  ];
}
