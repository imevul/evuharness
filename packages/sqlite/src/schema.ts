import { DatabaseSync } from 'node:sqlite';

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  path: string;
}

/**
 * Open a database and bring the schema up to date.
 *
 * The session payload is stored as one JSON blob, with the fields a sidebar needs
 * denormalized into columns. That split is deliberate: listing sessions must not
 * deserialize every transcript, which is the difference between a sidebar that
 * stays responsive and one that degrades as history grows.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(options.path);

  // Write-ahead logging so a reader is not blocked by a writer. Skipped for
  // in-memory databases, where it does not apply.
  if (options.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      mode           TEXT NOT NULL,
      workspace_id   TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      prompt_tokens  INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      payload        TEXT NOT NULL
    )
  `);

  // Listing is always "newest first, optionally one workspace".
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_workspace_updated
      ON sessions (workspace_id, updated_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL,
      scope_id   TEXT,
      tool       TEXT NOT NULL,
      digest     TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Resolution always filters by tool first, then by scope.
  db.exec(`
    CREATE INDEX IF NOT EXISTS grants_tool_scope
      ON grants (tool, scope, scope_id)
  `);

  // Enforces standing-grant idempotence in the database rather than only in code.
  // Receipts are excluded, since two identical one-shot approvals legitimately
  // authorize two executions.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS grants_standing_unique
      ON grants (scope, IFNULL(scope_id, ''), tool)
      WHERE digest IS NULL
  `);

  return db;
}
