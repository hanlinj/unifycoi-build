import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { env } from '@/lib/env';

let _db: Database.Database | null = null;

export function getRawDb(): Database.Database {
  if (!_db) {
    const dbPath = path.resolve(env.sqlite.path);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    _db = new Database(dbPath);
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
