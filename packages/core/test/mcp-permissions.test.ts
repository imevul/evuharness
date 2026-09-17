import { digestToolCall, resolveMcpCallApproval } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('resolveMcpCallApproval', () => {
  it('returns the server default when the per-tool map is empty', () => {
    expect(resolveMcpCallApproval({ default: 'requires_approval', tools: {} }, 'search')).toBe(
      'requires_approval',
    );
  });

  it('honours a future permissions.tools override over default', () => {
    expect(
      resolveMcpCallApproval(
        {
          default: 'requires_approval',
          tools: { search: 'always_allow', write: 'requires_approval' },
        },
        'search',
      ),
    ).toBe('always_allow');
    expect(
      resolveMcpCallApproval(
        {
          default: 'always_allow',
          tools: { write: 'requires_approval' },
        },
        'write',
      ),
    ).toBe('requires_approval');
  });

  it('treats a missing permissions object as requires_approval', () => {
    expect(resolveMcpCallApproval(undefined, 'anything')).toBe('requires_approval');
  });
});

describe('mcp_call digest', () => {
  it('binds allow_once to server, remote tool, and arguments — not the proxy name alone', () => {
    const search = digestToolCall('mcp_call', {
      serverId: 'docs',
      tool: 'search',
      arguments: { q: 'ssrf' },
    });
    const otherTool = digestToolCall('mcp_call', {
      serverId: 'docs',
      tool: 'write',
      arguments: { q: 'ssrf' },
    });
    const otherServer = digestToolCall('mcp_call', {
      serverId: 'other',
      tool: 'search',
      arguments: { q: 'ssrf' },
    });

    expect(search).not.toBe(otherTool);
    expect(search).not.toBe(otherServer);
  });
});
