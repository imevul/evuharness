import type { GrantQuery, GrantStore } from '@evu/harness-core';
import type { Grant, GrantScope } from '@evu/harness-protocol';
import type { Pool } from 'pg';
import { type PostgresStoreOptions, resolvePool } from './pool-options.js';

interface GrantRow {
  id: string | number;
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
  (scope = 'session'   AND scope_id = $SESSION)
  OR (scope = 'workspace' AND scope_id IS NOT NULL AND scope_id = $WORKSPACE)
  OR (scope = 'global'    AND scope_id IS NULL)
)`;

function scopeSql(sessionParam: number, workspaceParam: number): string {
  return SCOPE_PREDICATE.replace('$SESSION', `$${sessionParam}`).replace(
    '$WORKSPACE',
    `$${workspaceParam}`,
  );
}

function rowToGrant(row: GrantRow): Grant {
  return {
    scope: row.scope as GrantScope,
    scopeId: row.scope_id,
    tool: row.tool,
    ...(row.digest === null ? {} : { digest: row.digest }),
    createdAt: row.created_at,
  };
}

export class PostgresGrantStore implements GrantStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    const resolved = resolvePool(options);
    this.pool = resolved.pool;
    this.ready = resolved.ready;
  }

  async add(grant: Grant): Promise<void> {
    await this.ready;
    // A repeated standing grant is a no-op, enforced by the partial unique index.
    // Receipts have no such constraint, since each one authorizes one execution.
    await this.pool.query(
      `INSERT INTO grants (scope, scope_id, tool, digest, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [grant.scope, grant.scopeId ?? null, grant.tool, grant.digest ?? null, grant.createdAt],
    );
  }

  /**
   * Every grant that could apply to this session.
   *
   * The scope id is part of the predicate, not an afterthought: a grant recorded
   * for one workspace must never be returned for another. The runtime re-checks
   * this, but the query is the first line of enforcement.
   */
  async list(query: GrantQuery): Promise<Grant[]> {
    await this.ready;
    const result = await this.pool.query<GrantRow>(
      `SELECT * FROM grants
       WHERE tool = $1 AND ${scopeSql(2, 3)}
       ORDER BY id ASC`,
      [query.tool, query.sessionId, query.workspaceId ?? null],
    );
    return result.rows.map(rowToGrant);
  }

  /**
   * Consume a one-shot receipt atomically.
   *
   * `DELETE ... RETURNING` against the lowest matching id performs the find and the
   * removal in a single statement, so two concurrent calls with the same digest
   * cannot both succeed.
   */
  async consumeOnce(query: GrantQuery & { digest: string }): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query<{ id: string | number }>(
      `DELETE FROM grants
       WHERE id = (
         SELECT id FROM grants
         WHERE tool = $1 AND digest = $2 AND ${scopeSql(3, 4)}
         ORDER BY id ASC
         LIMIT 1
       )
       RETURNING id`,
      [query.tool, query.digest, query.sessionId, query.workspaceId ?? null],
    );
    return result.rows.length > 0;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM grants WHERE scope = 'session' AND scope_id = $1", [
      sessionId,
    ]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
