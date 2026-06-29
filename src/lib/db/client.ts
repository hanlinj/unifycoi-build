import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { env } from '@/lib/env';

let _db: Database.Database | null = null;

export function getRawDb(): Database.Database {
  if (!_db) {
    // Honor the ':memory:' sentinel literally — path.resolve() would turn it into a real
    // on-disk file named ':memory:'. Tests/CI rely on true in-memory semantics.
    if (env.sqlite.path === ':memory:') {
      _db = new Database(':memory:');
    } else {
      const dbPath = path.resolve(env.sqlite.path);
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      _db = new Database(dbPath);
    }
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
