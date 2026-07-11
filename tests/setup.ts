// Set required env vars before any module that imports env.ts is loaded.
import crypto from 'crypto';
import os from 'os';
import path from 'path';

process.env['STORAGE_DRIVER'] = 'filesystem';
process.env['STORAGE_PATH'] = path.join(os.tmpdir(), 'unifycoi-test-blobs');
process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('hex');
process.env['FIELD_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
process.env['JWT_SECRET'] = crypto.randomBytes(32).toString('hex');
process.env['JWT_EXPIRES_IN'] = '1h';
process.env['LOG_LEVEL'] = 'silent'; // keep pino quiet under jest (SENTRY_DSN unset → no Sentry)

// Phase 13 migration, Stage 1: db-core's methods are now async where they used to be
// synchronous. Test files that haven't converted yet (still writing e.g.
// `expect(() => tdb.update(...)).toThrow()`, a sync-throw assertion against a method that now
// returns a rejected Promise instead) create a genuinely unhandled rejection — and Node 15+
// crashes the whole process by default when one occurs with no listener attached, taking
// unrelated test files in the same worker down with it. Attaching a listener restores the
// older "log and continue" behavior.
//
// Stage 10 (2026-07-11), migration complete — checked whether this still earns its keep, per
// ADR-013-01: it does, independently of the migration itself. ~40 old SQLite-era test files
// (tests/phase*.test.ts, tests/api-*.test.ts) were never in any stage's scope to convert or
// delete — the established pattern all migration was "old test files get superseded by a new
// .pg.test.ts file, not edited in place" — so they remain in the tree unconverted, still
// import `better-sqlite3` directly, and still produce exactly this failure shape. This listener
// stays for as long as those files do, which is a separate decision from Phase 13's own scope.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in test (likely an unconverted call site from the Phase 13 migration):', reason);
});
