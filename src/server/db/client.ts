import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

const { Pool } = pg;

export interface DbClient {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
}

export type DB = DbClient['db'];

export function createDb(opts: { url: string }): DbClient {
  const pool = new Pool({
    connectionString: opts.url,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  const db = drizzle(pool, { schema });

  return { db, pool };
}
