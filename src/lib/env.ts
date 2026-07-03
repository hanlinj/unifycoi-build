// Validates required environment variables at module load time.
// Any missing var throws immediately — fail fast before any request is served.

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function validatedStorageDriver(value: string): 's3' | 'filesystem' {
  if (value === 's3' || value === 'filesystem') return value;
  throw new Error(`STORAGE_DRIVER must be 's3' or 'filesystem', got: ${value}`);
}

export const env = {
  sqlite: {
    path: required('SQLITE_PATH'),
  },
  anthropic: {
    apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
    visionModelPrimary: process.env['VISION_MODEL_PRIMARY'] ?? 'claude-sonnet-4-6',
    visionModelEscalation: process.env['VISION_MODEL_ESCALATION'] ?? 'claude-opus-4-8',
    extractionSchemaVersion: process.env['EXTRACTION_SCHEMA_VERSION'] ?? '1',
  },
  engine: {
    confBandHigh: parseFloat(process.env['CONF_BAND_HIGH'] ?? '0.90'),
    confBandMed: parseFloat(process.env['CONF_BAND_MED'] ?? '0.75'),
  },
  email: {
    // ESP (Resend). All optional: when RESEND_API_KEY is empty the process falls back to
    // the logged NoOp mailer (dev/test/CI), so nothing here is `required()`.
    resendApiKey: process.env['RESEND_API_KEY'] ?? '',
    // Shared verified sending domain (FEAT-13: per-operator DKIM domains deferred). The
    // operator name rides in the From display name; this is the envelope address.
    fromEmail: process.env['MAIL_FROM_EMAIL'] ?? 'noreply@unifycoi-mail.com',
    // Svix-style signing secret for the Resend delivery webhook (whsec_…). Empty → the
    // webhook fails closed (rejects every event) since it cannot verify authenticity.
    webhookSecret: process.env['RESEND_WEBHOOK_SECRET'] ?? '',
  },
  notifications: {
    // Hour (0–23) in the tenant's local timezone at which the daily digest is sent.
    digestHourLocal: parseInt(process.env['DIGEST_HOUR_LOCAL'] ?? '8', 10),
    // Worker poll interval (seconds) for the notification sender.
    workerPollSeconds: parseInt(process.env['NOTIFICATION_WORKER_POLL_SECONDS'] ?? '60', 10),
    // Rows stuck in 'sending' longer than this (seconds) are reclaimed to 'queued'.
    sendingStaleSeconds: parseInt(process.env['NOTIFICATION_SENDING_STALE_SECONDS'] ?? '300', 10),
  },
  storage: {
    driver: validatedStorageDriver(required('STORAGE_DRIVER')),
    // S3 / Backblaze B2 — required when driver='s3'
    s3: {
      endpoint: process.env['S3_ENDPOINT'] ?? '',
      region: process.env['S3_REGION'] ?? '',
      bucket: process.env['S3_BUCKET'] ?? '',
      accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
    },
    // Filesystem adapter — tests/CI only
    path: optional('STORAGE_PATH', './data/blobs'),
  },
  crypto: {
    masterKek: required('MASTER_KEK'),
    fieldEncryptionKey: required('FIELD_ENCRYPTION_KEY'),
  },
  observability: {
    // Sentry (OPS-12). Empty DSN → capture is a pino-only no-op (dev/test/CI).
    sentryDsn: process.env['SENTRY_DSN'] ?? '',
    environment: process.env['NODE_ENV'] ?? 'development',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  },
  auth: {
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: optional('JWT_EXPIRES_IN', '8h'),
    // Login throttle (SEC-9). Rolling window; soft lockout derived from windowed counts.
    login: {
      maxPerEmail: parseInt(process.env['LOGIN_MAX_PER_EMAIL'] ?? '5', 10),
      maxPerIp: parseInt(process.env['LOGIN_MAX_PER_IP'] ?? '30', 10),
      windowSeconds: parseInt(process.env['LOGIN_RATE_WINDOW_SECONDS'] ?? '900', 10), // 15m
    },
  },
} as const;

// Validate S3 vars when driver=s3
if (env.storage.driver === 's3') {
  const s3Required = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  for (const key of s3Required) {
    required(key);
  }
}

// Validate key is exactly 32 bytes when decoded.
// Accepts either 64-char hex or 44-char base64 (both encode 32 bytes).
function validateKey32(name: string, value: string): void {
  const isHex = /^[0-9a-fA-F]{64}$/.test(value);
  const isB64 = /^[A-Za-z0-9+/]{43}=?$/.test(value);
  if (!isHex && !isB64) {
    throw new Error(`${name} must encode 32 bytes (64-char hex or 44-char base64); generate with: openssl rand -hex 32`);
  }
}

validateKey32('MASTER_KEK', env.crypto.masterKek);
validateKey32('FIELD_ENCRYPTION_KEY', env.crypto.fieldEncryptionKey);
