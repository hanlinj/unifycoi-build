import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { env } from '@/lib/env';

/**
 * Phase 13 migration, Stage 1: better-sqlite3 → Kysely/Postgres.
 *
 * `Kysely<any>` deliberately — there is no schema-wide typed `Database` interface yet. Each
 * module authors its own typed table interfaces as it converts in later stages; writing all
 * 24 tables' types here up front would need revisiting per-module anyway, so it's deferred
 * rather than done twice. `Db` is exported as the shared alias downstream modules import.
 */
export type Db = Kysely<any>;

let _db: Db | null = null;

export function getDb(): Db {
  if (!_db) {
    if (!env.postgres.databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Postgres is only required for code that actually calls getDb() ' +
          '— set DATABASE_URL in .env if you are running/testing a converted module.'
      );
    }
    _db = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: env.postgres.databaseUrl }) }),
    });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}
