// Phase 7, Slice E — Sensitive masking, end-to-end & holistic.
//
// Drives the REAL tenant GET route handlers (against getRawDb, migrated + seeded) with a
// Manager (non-Admin) JWT and string-matches each response BODY for raw TIN / ACH account /
// routing patterns — the proven Phase 6 pattern (match the serialized body, not the parsed
// object). Also scans every audit_events.payload_json for the same patterns.
//
// NON-VACUOUS: the seeded vendor genuinely carries Sensitive data — it lives encrypted in
// extractions.payload_json, and the test first proves the plaintext is recoverable via
// decryptField. So a leak WOULD be detectable; the assertions earn their green.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getRawDb, closeDb } from '@/lib/db/client';
import {
  seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation,
  seedDocument, seedExtraction, seedRequirementSettings, assignUserToLocation,
} from './helpers';
import { issueToken } from '@/lib/auth/jwt';
import { encryptField, decryptField } from '@/lib/crypto/field';
import { runVerification } from '@/lib/verification/run';
import { applyDecision } from '@/lib/services/decision';
import type { FieldValue, ProcessedW9Extraction, ProcessedACHExtraction } from '@/lib/extraction/types';

// Known Sensitive plaintext — seeded (encrypted) so a leak is detectable.
const TIN_PLAINTEXT = '123-45-6789';
const ROUTING_PLAINTEXT = '021000021';
const ACCOUNT_PLAINTEXT = '9876543210';
const SSN_SHAPED = /\b\d{3}-\d{2}-\d{4}\b/; // TIN/SSN shape — specific enough to scan broadly

function migrateRaw(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
  }
}

function fv<T>(value: T): FieldValue<T> {
  return { value, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false };
}

function w9WithEncryptedTin(tinCipher: string): ProcessedW9Extraction {
  return {
    doc_type: 'w9',
    document_type_confirmed: 'w9',
    legal_name: fv<string | null>('Acme Plumbing LLC'),
    business_name: fv<string | null>('Acme Plumbing'),
    federal_tax_classification: fv<string | null>('llc'),
    tin_type: fv<string | null>('ein'),
    tin_value: fv<string | null>(tinCipher), // ciphertext at rest
    address: fv<string | null>('123 Main St'),
    signature_present: fv<boolean | null>(true),
    signature_date: fv<string | null>('2026-01-01'),
  };
}

function achWithEncrypted(routingCipher: string, accountCipher: string): ProcessedACHExtraction {
  return {
    doc_type: 'ach',
    document_type_confirmed: 'ach',
    account_holder_name: fv<string | null>('Acme Plumbing LLC'),
    bank_name: fv<string | null>('First Bank'),
    routing_number: fv<string | null>(routingCipher),  // ciphertext
    account_number: fv<string | null>(accountCipher),  // ciphertext
    account_type: fv<string | null>('checking'),
    voided_check_present: fv<boolean | null>(true),
    authorization_signature: fv<boolean | null>(true),
  };
}

interface Seeded {
  db: Database.Database;
  tenantId: string;
  vendorId: string;
  locationId: string;
  managerJwt: string;
  adminJwt: string;
  tinCipher: string;
  routingCipher: string;
  accountCipher: string;
}

async function seedScenario(): Promise<Seeded> {
  closeDb();
  const db = getRawDb();
  migrateRaw(db);

  const t = seedTenant(db);
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const manager = seedTenantUser(db, t.id, { role: 'store_manager' });
  const vendor = seedVendor(db, t.id, { contact_email: 'vendor@x.test', trade: 'plumbing' });
  const loc = seedLocation(db, t.id);
  assignUserToLocation(db, manager.id, loc.id, t.id);
  seedVendorLocation(db, t.id, vendor.id, loc.id, { status: 'under_review' });
  seedRequirementSettings(db, t.id);

  // Encrypt the Sensitive fields exactly as the extractor does, store ciphertext.
  const tinCipher = encryptField(TIN_PLAINTEXT);
  const routingCipher = encryptField(ROUTING_PLAINTEXT);
  const accountCipher = encryptField(ACCOUNT_PLAINTEXT);

  const w9Doc = seedDocument(db, t.id, vendor.id, { doc_type: 'w9' });
  seedExtraction(db, t.id, w9Doc.id, w9WithEncryptedTin(tinCipher));
  const achDoc = seedDocument(db, t.id, vendor.id, { doc_type: 'ach' });
  seedExtraction(db, t.id, achDoc.id, achWithEncrypted(routingCipher, accountCipher));

  // Generate audit events in a realistic flow (ai.recommendation, vendor.approved, ...).
  await runVerification(db, { tenantId: t.id, vendorId: vendor.id, vendorTrade: 'plumbing', trigger: 'onboarding' });
  applyDecision({ db, tenantId: t.id, vendorId: vendor.id, actorUserId: admin.id, action: 'approve', locationIds: [loc.id] });

  const managerJwt = issueToken({ sub: manager.id, tenantId: t.id, role: 'store_manager', type: 'tenant' });
  const adminJwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

  return {
    db, tenantId: t.id, vendorId: vendor.id, locationId: loc.id,
    managerJwt, adminJwt, tinCipher, routingCipher, accountCipher,
  };
}

function authedReq(url: string, jwt: string): Request {
  return new Request(url, { headers: { Authorization: `Bearer ${jwt}` } });
}

function assertNoSensitive(body: string): void {
  expect(body).not.toContain(TIN_PLAINTEXT);
  expect(body).not.toContain(ROUTING_PLAINTEXT);
  expect(body).not.toContain(ACCOUNT_PLAINTEXT);
  expect(body).not.toMatch(SSN_SHAPED);
}

afterEach(() => closeDb());

// ── Non-vacuous proof: the Sensitive data really is present (encrypted) ───────────

describe('Sensitive scan — non-vacuous setup', () => {
  test('seeded ciphertext decrypts to the known plaintext (data really exists)', async () => {
    const s = await seedScenario();
    expect(s.tinCipher).not.toContain(TIN_PLAINTEXT);          // stored as ciphertext
    expect(decryptField(s.tinCipher)).toBe(TIN_PLAINTEXT);     // recoverable
    expect(decryptField(s.routingCipher)).toBe(ROUTING_PLAINTEXT);
    expect(decryptField(s.accountCipher)).toBe(ACCOUNT_PLAINTEXT);
  });

  test('extractions.payload_json stores ciphertext, never the plaintext (at rest)', async () => {
    const s = await seedScenario();
    const rows = s.db.prepare('SELECT payload_json FROM extractions WHERE tenant_id = ?').all(s.tenantId) as { payload_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) assertNoSensitive(r.payload_json);
  });
});

// ── API endpoint walk (Manager JWT) ──────────────────────────────────────────────

describe('Sensitive scan — Manager (non-Admin) cannot retrieve raw Sensitive from any endpoint', () => {
  test('GET /api/vendors/:id (manager view)', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(authedReq(`http://t/api/vendors/${s.vendorId}`, s.managerJwt), { params: { id: s.vendorId } });
    const body = await res.text();
    expect(res.status).toBe(200);
    assertNoSensitive(body);
  });

  test('GET /api/users', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(authedReq('http://t/api/users', s.managerJwt));
    assertNoSensitive(await res.text());
  });

  test('GET /api/locations', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/locations/route');
    const res = await GET(authedReq('http://t/api/locations', s.managerJwt));
    assertNoSensitive(await res.text());
  });

  test('GET /api/requirements', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/requirements/route');
    const res = await GET(authedReq('http://t/api/requirements', s.managerJwt));
    assertNoSensitive(await res.text());
  });

  test('GET /api/auth/me', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/auth/me/route');
    const res = await GET(authedReq('http://t/api/auth/me', s.managerJwt));
    assertNoSensitive(await res.text());
  });
});

// ── Admin path also does not surface raw Sensitive via the record API ─────────────
// (invariant #8: masked server-side; a dedicated Admin Sensitive-reveal endpoint is not v1.)

describe('Sensitive scan — Admin vendor record API does not surface raw Sensitive either', () => {
  test('GET /api/vendors/:id (admin workbench)', async () => {
    const s = await seedScenario();
    const { GET } = await import('@/app/api/vendors/[id]/route');
    const res = await GET(authedReq(`http://t/api/vendors/${s.vendorId}`, s.adminJwt), { params: { id: s.vendorId } });
    const body = await res.text();
    expect(res.status).toBe(200);
    assertNoSensitive(body);
  });
});

// ── Audit payload scan (all events, all phases) ───────────────────────────────────

describe('Sensitive scan — audit_events payloads are Sensitive-free', () => {
  test('no audit payload contains raw TIN / routing / account / SSN pattern', async () => {
    const s = await seedScenario();
    const rows = s.db.prepare('SELECT event_type, payload_json FROM audit_events WHERE tenant_id = ?').all(s.tenantId) as
      { event_type: string; payload_json: string | null }[];
    expect(rows.length).toBeGreaterThan(0); // the flow really produced audit events
    for (const r of rows) {
      if (!r.payload_json) continue;
      assertNoSensitive(r.payload_json);
    }
  });

  test('notifications payloads are Sensitive-free too', async () => {
    const s = await seedScenario();
    const rows = s.db.prepare('SELECT payload_json FROM notifications WHERE tenant_id = ?').all(s.tenantId) as { payload_json: string }[];
    for (const r of rows) assertNoSensitive(r.payload_json);
  });
});
