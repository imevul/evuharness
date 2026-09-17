import { Pool } from 'pg';

export interface OpenPoolOptions {
  /** Postgres connection string. Never log this; it is a secret. */
  connectionString: string;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                   TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    mode                 TEXT NOT NULL,
    workspace_id         TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    prompt_tokens        INTEGER NOT NULL DEFAULT 0,
    completion_tokens    INTEGER NOT NULL DEFAULT 0,
    last_prompt_tokens   INTEGER NOT NULL DEFAULT 0,
    payload              JSONB NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_workspace_updated
    ON sessions (workspace_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS grants (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope      TEXT NOT NULL,
    scope_id   TEXT,
    tool       TEXT NOT NULL,
    digest     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS grants_tool_scope
    ON grants (tool, scope, scope_id);

  CREATE UNIQUE INDEX IF NOT EXISTS grants_standing_unique
    ON grants (scope, COALESCE(scope_id, ''), tool)
    WHERE digest IS NULL;

  CREATE TABLE IF NOT EXISTS settings (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    payload JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_profile (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS memories_updated
    ON memories (updated_at DESC);
`;

/**
 * Open a pool and bring the schema up to date.
 *
 * Same split as SQLite: session listing columns stay denormalized, and the
 * transcript lives in JSONB so a sidebar does not deserialize every row.
 */
export async function openPool(options: OpenPoolOptions): Promise<Pool> {
  const pool = new Pool({ connectionString: options.connectionString });
  await applySchema(pool);
  return pool;
}

export async function applySchema(pool: Pool): Promise<void> {
  await pool.query(DDL);
}
