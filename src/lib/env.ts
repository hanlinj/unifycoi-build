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
  auth: {
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: optional('JWT_EXPIRES_IN', '8h'),
  },
} as const;

// Validate S3 vars when driver=s3
if (env.storage.driver === 's3') {
  const s3Required = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  for (const key of s3Required) {
    required(key);
  }
}

// Validate key lengths
function validateHex32(name: string, value: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character hex string (32 bytes); generate with: openssl rand -hex 32`);
  }
}

validateHex32('MASTER_KEK', env.crypto.masterKek);
validateHex32('FIELD_ENCRYPTION_KEY', env.crypto.fieldEncryptionKey);
