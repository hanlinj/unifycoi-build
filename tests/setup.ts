// Set required env vars before any module that imports env.ts is loaded.
// Tests use the filesystem adapter and in-memory SQLite.
import crypto from 'crypto';
import os from 'os';
import path from 'path';

process.env['SQLITE_PATH'] = ':memory:';
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
// older "log and continue" behavior. This is a test-harness resilience fix that matters for
// every remaining stage's partial-conversion window, not just this one.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in test (likely an unconverted call site from the Phase 13 migration):', reason);
});
