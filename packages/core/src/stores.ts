import type { Grant, SessionSummary } from '@evu/harness-protocol';
import type { GrantQuery, GrantStore } from './grants.js';
import { matchesScope } from './grants.js';
import type { SessionRecord } from './session-record.js';
import { toSessionSummary } from './session-record.js';

export interface ListSessionsOptions {
  workspaceId?: string | undefined;
  limit?: number | undefined;
}

export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>;
  upsert(record: SessionRecord): Promise<void>;
  listSummaries(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * Deep-copy a record on the way in and out of a store.
 *
 * Without this, an in-memory store hands the same object to every caller, and
 * code that mutates a "loaded" session silently writes through to storage. That
 * makes durable-store bugs invisible in tests — including the mode-clobbering
 * class of bug that `applyTurnPatch` exists to prevent. Copying makes the
 * in-memory store behave like a real one.
 */
function cloneRecord(record: SessionRecord): SessionRecord {
  return structuredClone(record);
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async upsert(record: SessionRecord): Promise<void> {
    this.records.set(record.id, cloneRecord(record));
  }

  async listSummaries(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const limit = options.limit ?? 100;
    return [...this.records.values()]
      .filter((record) =>
        options.workspaceId === undefined ? true : record.workspaceId === options.workspaceId,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((record) => toSessionSummary(record));
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  get size(): number {
    return this.records.size;
  }
}

export class InMemoryGrantStore implements GrantStore {
  private grants: Grant[] = [];

  async add(grant: Grant): Promise<void> {
    // Standing grants are idempotent: re-approving a tool should not accumulate
    // duplicate rows. Receipts are not deduplicated, since two identical one-shot
    // approvals legitimately authorize two executions.
    if (grant.digest === undefined) {
      const exists = this.grants.some(
        (existing) =>
          existing.digest === undefined &&
          existing.scope === grant.scope &&
          existing.scopeId === grant.scopeId &&
          existing.tool === grant.tool,
      );
      if (exists) {
        return;
      }
    }
    this.grants.push({ ...grant });
  }

  async list(query: GrantQuery): Promise<Grant[]> {
    return this.grants
      .filter((grant) => grant.tool === query.tool)
      .filter((grant) => matchesScope(grant, query))
      .map((grant) => ({ ...grant }));
  }

  async consumeOnce(query: GrantQuery & { digest: string }): Promise<boolean> {
    const index = this.grants.findIndex(
      (grant) =>
        grant.tool === query.tool && grant.digest === query.digest && matchesScope(grant, query),
    );
    if (index < 0) {
      return false;
    }
    // Single-threaded splice: the read and the removal cannot interleave, which is
    // the atomicity a durable store has to reproduce with a transaction.
    this.grants.splice(index, 1);
    return true;
  }

  async clearSession(sessionId: string): Promise<void> {
    this.grants = this.grants.filter(
      (grant) => !(grant.scope === 'session' && grant.scopeId === sessionId),
    );
  }

  get size(): number {
    return this.grants.length;
  }
}
