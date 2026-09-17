import { Pool } from 'pg';
import { applySchema } from './schema.js';

export type PostgresStoreOptions = { connectionString: string } | { pool: Pool };

export function resolvePool(options: PostgresStoreOptions): { pool: Pool; ready: Promise<void> } {
  if ('pool' in options) {
    return { pool: options.pool, ready: Promise.resolve() };
  }
  const pool = new Pool({ connectionString: options.connectionString });
  return { pool, ready: applySchema(pool) };
}
