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
