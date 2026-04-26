import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Drizzle migrations live at `packages/store/drizzle/`, alongside both
 * `src/` (dev/tsx) and `dist/` (built output). Resolve from this module's URL
 * so the path works regardless of which one is loaded.
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

let runOnce: Promise<void> | null = null;

/**
 * Apply pending drizzle migrations against DATABASE_URL. Idempotent — safe to
 * call from multiple boot paths; only runs once per process.
 */
export const runMigrations = async (databaseUrl?: string): Promise<void> => {
  if (runOnce) return runOnce;
  runOnce = (async () => {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder });
    } finally {
      await pool.end();
    }
  })();
  return runOnce;
};
