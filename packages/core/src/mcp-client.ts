export interface McpServerRuntime {
  id: string;
  label?: string | undefined;
  url: string;
  transport: 'streamable-http' | 'sse';
  enabled: boolean;
  apiKey?: string | undefined;
}

export interface McpToolInfo {
  name: string;
  description?: string | undefined;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { message?: string };
}

/**
 * Minimal MCP client over Streamable HTTP / SSE.
 *
 * initialize + tools/list + tools/call. Stdio is out of scope.
 */
export function createMcpClient(fetchImpl: typeof fetch) {
  async function rpc(
    server: McpServerRuntime,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (server.apiKey !== undefined && server.apiKey !== '') {
      headers.authorization = `Bearer ${server.apiKey}`;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      ...(params === undefined ? {} : { params }),
    });

    const response = await fetchImpl(server.url, { method: 'POST', headers, body });
    if (!response.ok) {
      throw new Error(`${server.id} returned ${response.status}`);
    }

    const text = await response.text();
    const parsed = parseRpc(text);
    if (parsed.error !== undefined) {
      throw new Error(parsed.error.message ?? `${method} failed`);
    }
    return parsed.result;
  }

  return {
    async listTools(server: McpServerRuntime): Promise<McpToolInfo[]> {
      await rpc(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evuharness', version: '0.0.0' },
      }).catch(() => undefined);

      const result = (await rpc(server, 'tools/list')) as { tools?: McpToolInfo[] };
      return result.tools ?? [];
    },

    async callTool(
      server: McpServerRuntime,
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> {
      const result = (await rpc(server, 'tools/call', {
        name,
        arguments: args,
      })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const text = (result.content ?? [])
        .filter((part) => part.type === 'text' && part.text !== undefined)
        .map((part) => part.text)
        .join('\n');
      if (result.isError === true) {
        throw new Error(text === '' ? 'MCP tool error' : text);
      }
      return text === '' ? JSON.stringify(result) : text;
    },
  };
}

function parseRpc(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('data:')) {
    const line = trimmed
      .split('\n')
      .map((entry) => entry.replace(/^data:\s?/, '').trim())
      .find((entry) => entry.startsWith('{'));
    if (line !== undefined) return JSON.parse(line) as JsonRpcResponse;
  }
  return JSON.parse(trimmed) as JsonRpcResponse;
}
