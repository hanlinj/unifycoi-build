import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getRawDb } from '@/lib/db/client';

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'migrations');

function ensureMigrationsTable(db: ReturnType<typeof getRawDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedMigrations(db: ReturnType<typeof getRawDb>): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function runMigrations(): void {
  const db = getRawDb();
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString()
      );
    })();
    console.log(`  apply ${file}`);
    count++;
  }

  if (count === 0) {
    console.log('No new migrations.');
  } else {
    console.log(`Applied ${count} migration(s).`);
  }
}

runMigrations();
