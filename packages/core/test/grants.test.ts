import {
  digestToolCall,
  type GrantStore,
  grantForDecision,
  InMemoryGrantStore,
  matchesScope,
  resolveGrant,
} from '@evu/harness-core';
import { beforeEach, describe, expect, it } from 'vitest';

const TOOL = 'restart_service';
const SESSION = 'session-1';
const WORKSPACE = 'workspace-a';

let store: GrantStore;

beforeEach(() => {
  store = new InMemoryGrantStore();
});

async function grant(decision: Parameters<typeof grantForDecision>[0], workspaceId?: string) {
  const digest = digestToolCall(TOOL, { name: 'api' });
  const created = grantForDecision(decision, {
    sessionId: SESSION,
    workspaceId,
    tool: TOOL,
    digest,
  });
  if (created !== null) {
    await store.add(created);
  }
  return digest;
}

describe('argument digests', () => {
  it('is stable across property order', () => {
    expect(digestToolCall(TOOL, { a: 1, b: 2 })).toBe(digestToolCall(TOOL, { b: 2, a: 1 }));
  });

  it('changes when an argument value changes', () => {
    expect(digestToolCall(TOOL, { name: 'api' })).not.toBe(digestToolCall(TOOL, { name: 'web' }));
  });

  it('changes when the tool changes', () => {
    expect(digestToolCall('a', { x: 1 })).not.toBe(digestToolCall('b', { x: 1 }));
  });

  it('is stable for nested objects regardless of key order', () => {
    expect(digestToolCall(TOOL, { outer: { a: 1, b: [1, { c: 2, d: 3 }] } })).toBe(
      digestToolCall(TOOL, { outer: { b: [1, { d: 3, c: 2 }], a: 1 } }),
    );
  });

  it('distinguishes an absent key from an explicit undefined', () => {
    // Both normalize to "not present", which is correct: a provider that omits an
    // optional argument and one that sends null-ish for it authorize the same call.
    expect(digestToolCall(TOOL, { a: 1, b: undefined })).toBe(digestToolCall(TOOL, { a: 1 }));
  });
});

describe('decision to grant mapping', () => {
  it('binds allow_once to the digest', () => {
    const created = grantForDecision('allow_once', {
      sessionId: SESSION,
      tool: TOOL,
      digest: 'abc',
    });

    expect(created).toMatchObject({ scope: 'session', scopeId: SESSION, digest: 'abc' });
  });

  it('records allow_session without a digest, making it tool-wide', () => {
    const created = grantForDecision('allow_session', {
      sessionId: SESSION,
      tool: TOOL,
      digest: 'abc',
    });

    expect(created).toMatchObject({ scope: 'session', scopeId: SESSION });
    expect(created?.digest).toBeUndefined();
  });

  it('scopes allow_workspace to the workspace when one is set', () => {
    const created = grantForDecision('allow_workspace', {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      tool: TOOL,
      digest: 'abc',
    });

    expect(created).toMatchObject({ scope: 'workspace', scopeId: WORKSPACE });
  });

  it('collapses allow_workspace into global when no workspace is set', () => {
    const created = grantForDecision('allow_workspace', {
      sessionId: SESSION,
      tool: TOOL,
      digest: 'abc',
    });

    expect(created).toMatchObject({ scope: 'global', scopeId: null });
  });

  it('records nothing for deny', () => {
    expect(grantForDecision('deny', { sessionId: SESSION, tool: TOOL, digest: 'abc' })).toBeNull();
  });
});

describe('grant resolution', () => {
  it('refuses an ungranted call', async () => {
    const digest = digestToolCall(TOOL, { name: 'api' });
    await expect(resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual({
      allowed: false,
    });
  });

  it('allows a session grant', async () => {
    const digest = await grant('allow_session');
    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, via: 'session' });
  });

  it('allows via workspace scope', async () => {
    const digest = await grant('allow_workspace', WORKSPACE);
    await expect(
      resolveGrant(store, {
        sessionId: 'other-session',
        workspaceId: WORKSPACE,
        tool: TOOL,
        digest,
      }),
    ).resolves.toMatchObject({ allowed: true, via: 'workspace' });
  });

  it('allows via global scope from any session', async () => {
    const digest = await grant('allow_always');
    await expect(
      resolveGrant(store, { sessionId: 'unrelated', tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, via: 'global' });
  });

  it('does not let a workspace grant leak into another workspace', async () => {
    const digest = await grant('allow_workspace', WORKSPACE);
    await expect(
      resolveGrant(store, {
        sessionId: SESSION,
        workspaceId: 'workspace-b',
        tool: TOOL,
        digest,
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('does not let a workspace grant apply when no workspace is in play', async () => {
    const digest = await grant('allow_workspace', WORKSPACE);
    await expect(resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual({
      allowed: false,
    });
  });

  it('does not let a session grant apply to a different session', async () => {
    const digest = await grant('allow_session');
    await expect(resolveGrant(store, { sessionId: 'other', tool: TOOL, digest })).resolves.toEqual({
      allowed: false,
    });
  });

  it('does not let a grant for one tool authorize another', async () => {
    await grant('allow_session');
    const otherDigest = digestToolCall('delete_everything', {});
    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: 'delete_everything', digest: otherDigest }),
    ).resolves.toEqual({ allowed: false });
  });

  it('never infers global scope from a narrower grant', async () => {
    await grant('allow_session');
    const grants = await store.list({ sessionId: SESSION, tool: TOOL });

    expect(grants.every((entry) => entry.scope !== 'global')).toBe(true);
  });
});

describe('one-shot receipts', () => {
  it('allows exactly once and is then consumed', async () => {
    const digest = await grant('allow_once');

    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, consumedReceipt: true });

    await expect(resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual({
      allowed: false,
    });
  });

  it('does not authorize a call with different arguments', async () => {
    await grant('allow_once');
    const otherDigest = digestToolCall(TOOL, { name: 'web' });

    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest: otherDigest }),
    ).resolves.toEqual({ allowed: false });
  });

  it('is not consumed by a standing grant lookup', async () => {
    await grant('allow_once');
    const digest = digestToolCall(TOOL, { name: 'api' });

    // A different tool's resolution must not spend this receipt.
    await resolveGrant(store, { sessionId: SESSION, tool: 'other_tool', digest });

    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('is not treated as a standing grant for other arguments', async () => {
    await grant('allow_once');
    const grants = await store.list({ sessionId: SESSION, tool: TOOL });

    expect(grants.every((entry) => entry.digest !== undefined)).toBe(true);
  });

  it('consumes only one receipt when two identical ones exist', async () => {
    const digest = await grant('allow_once');
    await grant('allow_once');

    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(resolveGrant(store, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual({
      allowed: false,
    });
  });
});

describe('standing grant bookkeeping', () => {
  it('deduplicates repeated identical standing grants', async () => {
    const memoryStore = new InMemoryGrantStore();
    const created = grantForDecision('allow_session', {
      sessionId: SESSION,
      tool: TOOL,
      digest: 'x',
    });

    await memoryStore.add(created!);
    await memoryStore.add(created!);

    expect(memoryStore.size).toBe(1);
  });

  it('keeps repeated receipts, since each authorizes one execution', async () => {
    const memoryStore = new InMemoryGrantStore();
    const created = grantForDecision('allow_once', {
      sessionId: SESSION,
      tool: TOOL,
      digest: 'x',
    });

    await memoryStore.add(created!);
    await memoryStore.add(created!);

    expect(memoryStore.size).toBe(2);
  });

  it('drops session grants when a session is cleared', async () => {
    await grant('allow_session');
    await store.clearSession(SESSION);

    expect(await store.list({ sessionId: SESSION, tool: TOOL })).toEqual([]);
  });

  it('keeps global grants when a session is cleared', async () => {
    await grant('allow_always');
    await store.clearSession(SESSION);

    expect(await store.list({ sessionId: SESSION, tool: TOOL })).toHaveLength(1);
  });
});

describe('scope matching', () => {
  it('requires a workspace id for a workspace grant', () => {
    const workspaceGrant = {
      scope: 'workspace' as const,
      scopeId: WORKSPACE,
      tool: TOOL,
      createdAt: 'now',
    };

    expect(matchesScope(workspaceGrant, { sessionId: SESSION })).toBe(false);
    expect(matchesScope(workspaceGrant, { sessionId: SESSION, workspaceId: WORKSPACE })).toBe(true);
  });
});
