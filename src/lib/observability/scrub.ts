// beforeSend scrub (OPS-12 / SEC-16 hard requirement): NO decrypted Sensitive values
// (full TIN/SSN/EIN, ACH account/routing), NO full COI extractions, NO key material — in
// ANY part of a captured event (message, exception value, breadcrumb, request, extra,
// contexts, tags). This is a DENYLIST: it redacts (1) values under sensitive-looking KEYS
// and (2) strings matching sensitive digit PATTERNS. See the checkpoint for its boundary
// (what a denylist can still miss). Applied both as Sentry's beforeSend and to any context
// we log ourselves.

const REDACTED = '[REDACTED]';

// Whole value is redacted when its key contains any of these fragments (case-insensitive).
const SENSITIVE_KEY_FRAGMENTS = [
  'tin', 'ssn', 'ein', 'tax_id', 'taxid',
  'account', 'routing', 'ach',
  'password', 'secret', 'token', 'api_key', 'apikey', 'private_key',
  'kek', 'dek', 'data_key', 'master_kek', 'field_encryption_key',
  'extraction', 'payload_json', 'processed_extraction', 'ciphertext',
];

// Matching substrings inside ANY string are redacted (catches Sensitive values that land in
// a free-text message or exception string, not just under a known key).
const VALUE_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN 123-45-6789
  /\b\d{2}-\d{7}\b/g,       // EIN 12-3456789
  /\b\d{9,17}\b/g,          // bare digit runs: SSN/EIN/routing (9) … ACH account (≤17)
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

function scrubString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Recursively scrub any value. Returns a new (scrubbed) structure; never mutates input. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED; // guard against deep / cyclic structures
  if (typeof value === 'string') return scrubString(value);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return REDACTED; // raw bytes never leave
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value; // number / boolean / null / undefined
}

/** Sentry beforeSend hook — scrub the whole event before it can leave the process. */
export function scrubEvent<T>(event: T): T {
  return scrubValue(event) as T;
}
