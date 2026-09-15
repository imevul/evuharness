import type { DatabaseSync } from 'node:sqlite';
import type { GrantQuery, GrantStore } from '@evu/harness-core';
import type { Grant, GrantScope } from '@evu/harness-protocol';
import { asRows } from './rows.js';
import { openDatabase } from './schema.js';

interface GrantRow {
  id: number;
  scope: string;
  scope_id: string | null;
  tool: string;
  digest: string | null;
  created_at: string;
}

/**
 * Scope predicate shared by lookup and consumption.
 *
 * Written once so the two paths cannot drift: a grant resolving in `list` but not
 * in `consumeOnce`, or the reverse, would be a scope-isolation bug.
 */
const SCOPE_PREDICATE = `(
  (scope = 'session'   AND scope_id = ?)
  OR (scope = 'workspace' AND scope_id IS NOT NULL AND scope_id = ?)
  OR (scope = 'global'    AND scope_id IS NULL)
)`;

function rowToGrant(row: GrantRow): Grant {
  return {
    scope: row.scope as GrantScope,
    scopeId: row.scope_id,
    tool: row.tool,
    ...(row.digest === null ? {} : { digest: row.digest }),
    createdAt: row.created_at,
  };
}

export interface SqliteGrantStoreOptions {
  path: string;
}

export class SqliteGrantStore implements GrantStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteGrantStoreOptions | { db: DatabaseSync }) {
    this.db = 'db' in options ? options.db : openDatabase({ path: options.path });
  }

  async add(grant: Grant): Promise<void> {
    // A repeated standing grant is a no-op, enforced by the partial unique index.
    // Receipts have no such constraint, since each one authorizes one execution.
    this.db
      .prepare(
        `INSERT INTO grants (scope, scope_id, tool, digest, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(grant.scope, grant.scopeId, grant.tool, grant.digest ?? null, grant.createdAt);
  }

  /**
   * Every grant that could apply to this session.
   *
   * The scope id is part of the predicate, not an afterthought: a grant recorded
   * for one workspace must never be returned for another. The runtime re-checks
   * this, but the query is the first line of enforcement.
   */
  async list(query: GrantQuery): Promise<Grant[]> {
    const statement = this.db.prepare(
      `SELECT * FROM grants
       WHERE tool = ? AND ${SCOPE_PREDICATE}
       ORDER BY id ASC`,
    );

    const rows = asRows<GrantRow>(
      statement.all(query.tool, query.sessionId, query.workspaceId ?? null),
    );

    return rows.map(rowToGrant);
  }

  /**
   * Consume a one-shot receipt atomically.
   *
   * `DELETE ... RETURNING` against the lowest matching id performs the find and the
   * removal in a single statement, so two concurrent calls with the same digest
   * cannot both succeed. A select followed by a delete would let one approval
   * authorize two executions.
   */
  async consumeOnce(query: GrantQuery & { digest: string }): Promise<boolean> {
    const statement = this.db.prepare(
      `DELETE FROM grants
       WHERE id = (
         SELECT id FROM grants
         WHERE tool = ? AND digest = ? AND ${SCOPE_PREDICATE}
         ORDER BY id ASC
         LIMIT 1
       )
       RETURNING id`,
    );

    const deleted = asRows<GrantRow>(
      statement.all(query.tool, query.digest, query.sessionId, query.workspaceId ?? null),
    );

    return deleted.length > 0;
  }

  async clearSession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM grants WHERE scope = 'session' AND scope_id = ?").run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
