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
  // Phase 13 migration, Stage 10: `sqlite.path` (required('SQLITE_PATH')) removed — better-
  // sqlite3 is uninstalled, and `env.sqlite` had zero readers left in src/ (confirmed by grep
  // before removal). NOT `required()` for the line below either — only db-core's own code
  // (client.ts, test-isolation.ts) reads this, and eagerly requiring it here would crash every
  // test at env.ts's module-load time, not just the ones that touch Postgres. client.ts's
  // getDb() throws its own clear error if this is empty when actually called.
  postgres: {
    databaseUrl: process.env['DATABASE_URL'] ?? '',
    // Test-isolation harness only (src/lib/db/test-isolation.ts) — not used by the app itself.
    host: optional('PG_HOST', '127.0.0.1'),
    port: parseInt(optional('PG_PORT', '5432'), 10),
    user: optional('PG_USER', 'postgres'),
    password: optional('PG_PASSWORD', ''),
    testTemplateDatabase: optional('PG_TEST_TEMPLATE_DATABASE', ''),
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
  billing: {
    // Stripe (OPS-10, owner-approved spec deviation). Empty secret → the NoOp billing
    // provider (dev/test/CI): provisioning still attaches a synthetic customer so the flow
    // works without real Stripe. Publishable key is for the Slice-5 wizard's Elements card entry.
    stripeSecretKey: process.env['STRIPE_SECRET_KEY'] ?? '',
    stripePublishableKey: process.env['STRIPE_PUBLISHABLE_KEY'] ?? '',
    // Slice 5a: automatic billing (ADR-012-05). Empty → the invoice.paid webhook route fails
    // closed (503) since it can't verify signatures without a secret.
    stripeWebhookSecret: process.env['STRIPE_WEBHOOK_SECRET'] ?? '',
    // Quantity-sync worker poll cadence — location-count changes aren't time-sensitive (the
    // next billing cycle is weeks away at minimum), so this defaults slower than the
    // notification worker's.
    syncWorkerPollSeconds: parseInt(process.env['BILLING_SYNC_WORKER_POLL_SECONDS'] ?? '300', 10),
  },
  observability: {
    // Sentry (OPS-12). Empty DSN → capture is a pino-only no-op (dev/test/CI).
    sentryDsn: process.env['SENTRY_DSN'] ?? '',
    environment: process.env['NODE_ENV'] ?? 'development',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  },
  app: {
    // Base origin for links surfaced to users (invite links, vendor tokens). Same fallback
    // dev-seed already uses.
    baseUrl: optional('APP_BASE_URL', 'http://localhost:3000'),
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
