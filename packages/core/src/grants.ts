import { createHash } from 'node:crypto';
import type { ApprovalDecision, Grant, GrantScope } from '@evu/harness-protocol';

/**
 * Digest the arguments of a tool call.
 *
 * Keys are sorted so that equivalent argument objects produce one digest
 * regardless of property order — otherwise an approval would fail to match a
 * re-serialization of the very call it authorized.
 *
 * The digest is what makes `allow_once` meaningful: a decision authorizes these
 * exact arguments, so changed arguments require a fresh decision.
 */
export function digestToolCall(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${tool}\u0000${stableStringify(args)}`)
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(',')}}`;
}

export interface GrantQuery {
  sessionId: string;
  workspaceId?: string | undefined;
  tool: string;
}

export interface GrantStore {
  add(grant: Grant): Promise<void>;
  /** Every grant that could apply to this session, across all three scopes. */
  list(query: GrantQuery): Promise<Grant[]>;
  /**
   * Atomically consume a one-shot receipt.
   *
   * Returns whether a matching receipt existed. Must be atomic: two concurrent
   * calls with the same digest must not both succeed, or one approval would
   * authorize two executions.
   */
  consumeOnce(query: GrantQuery & { digest: string }): Promise<boolean>;
  /** Drop every grant scoped to one session, used when a session is deleted. */
  clearSession(sessionId: string): Promise<void>;
}

/**
 * Translate a decision into the grant it records.
 *
 * `deny` records nothing. `allow_workspace` without a workspace records a global
 * grant, so it collapses into `allow_always` — one code path, and no behavioral
 * difference for a host that never adopts workspaces.
 */
export function grantForDecision(
  decision: ApprovalDecision,
  input: { sessionId: string; workspaceId?: string | undefined; tool: string; digest: string },
  now?: string,
): Grant | null {
  const createdAt = now ?? new Date().toISOString();
  const base = { tool: input.tool, createdAt };

  switch (decision) {
    case 'allow_once':
      // The only digest-bound decision, and the only one that is consumed.
      return { ...base, scope: 'session', scopeId: input.sessionId, digest: input.digest };
    case 'allow_session':
      return { ...base, scope: 'session', scopeId: input.sessionId };
    case 'allow_workspace':
      return input.workspaceId === undefined
        ? { ...base, scope: 'global', scopeId: null }
        : { ...base, scope: 'workspace', scopeId: input.workspaceId };
    case 'allow_always':
      return { ...base, scope: 'global', scopeId: null };
    case 'deny':
      return null;
  }
}

export type GrantResolution =
  | { allowed: false }
  | { allowed: true; via: GrantScope; consumedReceipt: boolean };

/**
 * Decide whether a tool call is already approved.
 *
 * Widening order: session, then workspace, then global. Any hit allows. The order
 * only affects which scope is reported, since a hit at any level is sufficient.
 *
 * A one-shot receipt is checked first and consumed, so a matching receipt is spent
 * rather than left behind to authorize a later identical call.
 */
export async function resolveGrant(
  store: GrantStore,
  input: {
    sessionId: string;
    workspaceId?: string | undefined;
    tool: string;
    digest: string;
  },
): Promise<GrantResolution> {
  const consumed = await store.consumeOnce({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    tool: input.tool,
    digest: input.digest,
  });
  if (consumed) {
    return { allowed: true, via: 'session', consumedReceipt: true };
  }

  const grants = await store.list({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    tool: input.tool,
  });

  // Tool-wide grants only. A receipt (digest set) is never a standing allowance.
  const standing = grants.filter((grant) => grant.digest === undefined);

  for (const scope of ['session', 'workspace', 'global'] as const) {
    const hit = standing.find((grant) => grant.scope === scope && matchesScope(grant, input));
    if (hit !== undefined) {
      return { allowed: true, via: scope, consumedReceipt: false };
    }
  }

  return { allowed: false };
}

/**
 * Confirm a grant's scope id matches the caller.
 *
 * Defense in depth: a store's `list` is expected to filter correctly, but scope
 * isolation is a security invariant, so it is re-checked here rather than trusted.
 * A grant recorded for one workspace must never resolve under another.
 */
export function matchesScope(
  grant: Grant,
  input: { sessionId: string; workspaceId?: string | undefined },
): boolean {
  switch (grant.scope) {
    case 'session':
      return grant.scopeId === input.sessionId;
    case 'workspace':
      return input.workspaceId !== undefined && grant.scopeId === input.workspaceId;
    case 'global':
      return grant.scopeId === null;
  }
}
