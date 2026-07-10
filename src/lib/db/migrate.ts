import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from '@/lib/db/client';
import type { Db } from '@/lib/db/client';

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'migrations-pg');

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('_migrations')
    .ifNotExists()
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('applied_at', 'timestamptz', (c) => c.notNull())
    .execute();
}

async function appliedMigrations(db: Db): Promise<Set<string>> {
  const rows = await db.selectFrom('_migrations').select('name').execute();
  return new Set(rows.map((r: { name: string }) => r.name));
}

export async function runMigrations(db: Db = getDb()): Promise<void> {
  await ensureMigrationsTable(db);
  const applied = await appliedMigrations(db);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const migration = await import(path.join(MIGRATIONS_DIR, file));
    const trx = await db.startTransaction().execute();
    try {
      await migration.up(trx);
      await trx
        .insertInto('_migrations')
        .values({ name: file, applied_at: new Date() })
        .execute();
      await trx.commit().execute();
    } catch (err) {
      await trx.rollback().execute();
      throw err;
    }
    console.log(`  apply ${file}`);
    count++;
  }

  if (count === 0) {
    console.log('No new migrations.');
  } else {
    console.log(`Applied ${count} migration(s).`);
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => closeDb())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
