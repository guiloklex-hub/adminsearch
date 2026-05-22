import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Aplica todos os arquivos `*.sql` em `/drizzle` em ordem alfabética.
 *
 * Cada SQL deve ser idempotente (`CREATE ... IF NOT EXISTS`) para tolerar
 * re-run no boot. Mantemos uma tabela `_adminsearch_migrations` para registrar
 * o que já rodou e evitar reaplicar conteúdo grande à toa.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _adminsearch_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = resolve(__dirname, '../../../drizzle');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const applied = await pool.query<{ filename: string }>(
      'SELECT filename FROM _adminsearch_migrations WHERE filename = $1',
      [file],
    );
    if (applied.rows.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _adminsearch_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Falha ao aplicar migração ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}
