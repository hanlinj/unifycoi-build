// Phase 9, Slice C — report PDF/CSV export.
//
// Round-trips through the real route + BlobStore: generate via GET ?format=, fetch the stored
// (envelope-encrypted) blob, decrypt, and parse. Verifies CSV shape, PDF validity, the
// report.generated audit event, empty-report graceful output, and (defensibility) that NO raw
// TIN/ACH appears in ANY generated output — non-vacuous (encrypted Sensitive data is present).

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { PDFDocument } from 'pdf-lib';
import zlib from 'zlib';
import {
  seedTenant, seedTenantUser, seedLocation, seedVendor, seedVendorLocation, seedDocument, seedExtraction,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { getBlobStore } from '@/lib/blob';
import { issueToken } from '@/lib/auth/jwt';
import { encryptField, decryptField } from '@/lib/crypto/field';
import { unpackEncrypted } from '@/lib/crypto/envelope-file';
import { REPORTS } from '@/lib/reports';
import type { FieldValue, ProcessedCOIExtraction, ProcessedW9Extraction, ProcessedACHExtraction } from '@/lib/extraction/types';

const TIN = '123-45-6789', ROUTING = '021000021', ACCOUNT = '9876543210';
const SSN_SHAPED = /\b\d{3}-\d{2}-\d{4}\b/;

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function fv<T>(v: T): FieldValue<T> { return { value: v, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false }; }
function coi(): ProcessedCOIExtraction {
  return { doc_type: 'coi', document_type_confirmed: 'coi', certificate_date: fv<string | null>(null), producer: fv<string | null>(null), named_insured: fv<string | null>(null), insured_address: fv<string | null>(null), insurers: [], policies: [{ coverage_type: fv<string | null>('general_liability'), insurer_letter: fv<string | null>(null), policy_number: fv<string | null>(null), effective_date: fv<string | null>(null), expiration_date: fv<string | null>('2027-01-01'), limits: { each_occurrence: fv<number | null>(1_000_000) }, additional_insured: fv<boolean | null>(true), additional_insured_scope: fv<string | null>(null), waiver_of_subrogation: fv<boolean | null>(false), primary_noncontributory: fv<boolean | null>(null) }], additional_insured_entities: fv<string | null>(null), description_of_operations: fv<string | null>(null), certificate_holder: fv<string | null>(null) };
}
function w9(cipher: string): ProcessedW9Extraction {
  return { doc_type: 'w9', document_type_confirmed: 'w9', legal_name: fv<string | null>('Acme LLC'), business_name: fv<string | null>('Acme'), federal_tax_classification: fv<string | null>('llc'), tin_type: fv<string | null>('ein'), tin_value: fv<string | null>(cipher), address: fv<string | null>('1 Main'), signature_present: fv<boolean | null>(true), signature_date: fv<string | null>('2026-01-01') };
}
function ach(rC: string, aC: string): ProcessedACHExtraction {
  return { doc_type: 'ach', document_type_confirmed: 'ach', account_holder_name: fv<string | null>('Acme LLC'), bank_name: fv<string | null>('Bank'), routing_number: fv<string | null>(rC), account_number: fv<string | null>(aC), account_type: fv<string | null>('checking'), voided_check_present: fv<boolean | null>(true), authorization_signature: fv<boolean | null>(true) };
}

function world() {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db, { name: 'Storage Star' });
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const loc = seedLocation(db, t.id, { name: 'Main St' });
  const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing', trade: 'plumbing' });
  seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
  // Coverage + Sensitive (encrypted) data present on this vendor.
  const coiDoc = seedDocument(db, t.id, v.id, { doc_type: 'coi' }); seedExtraction(db, t.id, coiDoc.id, coi());
  const w9Doc = seedDocument(db, t.id, v.id, { doc_type: 'w9' }); seedExtraction(db, t.id, w9Doc.id, w9(encryptField(TIN)));
  const achDoc = seedDocument(db, t.id, v.id, { doc_type: 'ach' }); seedExtraction(db, t.id, achDoc.id, ach(encryptField(ROUTING), encryptField(ACCOUNT)));
  return { db, t, jwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }) };
}

async function generate(jwt: string, key: string, format: 'csv' | 'pdf') {
  const { GET } = await import('@/app/api/reports/[reportKey]/route');
  return GET(new Request(`http://t/api/reports/${key}?format=${format}`, { headers: { Authorization: `Bearer ${jwt}` } }), { params: { reportKey: key } });
}
async function bytesOf(res: Response): Promise<Buffer> { return Buffer.from(await res.arrayBuffer()); }
// pdf-lib Flate-compresses content streams, so drawn text is never literal in the raw bytes.
// Inflate every FlateDecode stream so title/timestamp/Sensitive scans are genuine (not vacuous).
function decompressPdfText(pdf: Buffer): string {
  let out = '', idx = 0;
  for (;;) {
    const sIdx = pdf.indexOf('stream', idx);
    if (sIdx === -1) break;
    let ds = sIdx + 6;
    if (pdf[ds] === 0x0d) ds++;
    if (pdf[ds] === 0x0a) ds++;
    const eIdx = pdf.indexOf('endstream', ds);
    if (eIdx === -1) break;
    try {
      const inflated = zlib.inflateSync(pdf.subarray(ds, eIdx)).toString('latin1');
      out += inflated;
      // pdf-lib writes text as hex string operands <..> Tj — decode them so drawn text
      // (title, timestamps, and any leaked Sensitive value) is searchable.
      for (const m of inflated.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        if (m[1].length % 2 === 0) out += Buffer.from(m[1], 'hex').toString('latin1');
      }
    } catch { /* not a flate stream */ }
    idx = eIdx + 9;
  }
  return out;
}
function latestStorageKey(db: Database.Database, tenantId: string): string {
  const row = db.prepare(`SELECT payload_json FROM audit_events WHERE tenant_id=? AND event_type='report.generated' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(tenantId) as { payload_json: string };
  return JSON.parse(row.payload_json).storage_key;
}

afterEach(() => closeDb());

// ── CSV round-trip ───────────────────────────────────────────────────────────────────

describe('report CSV export', () => {
  test('vendor-roster CSV: BOM + header + row by value, stored encrypted + decryptable, audited', async () => {
    const w = world();
    const res = await generate(w.jwt, 'vendor-roster', 'csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const buf = await bytesOf(res);
    // UTF-8 BOM (EF BB BF) for Excel — checked on raw bytes (Response.text() would strip it).
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const body = buf.toString('utf-8');
    const lines = body.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toContain('Vendor');
    expect(lines.some((l) => l.includes('Acme Plumbing'))).toBe(true);

    // BlobStore round-trip: stored blob decrypts to the same bytes.
    const blob = await getBlobStore().get(latestStorageKey(w.db, w.t.id));
    expect(unpackEncrypted(blob).equals(buf)).toBe(true);

    // audit: report.generated with row_count
    const ev = JSON.parse((w.db.prepare(`SELECT payload_json FROM audit_events WHERE tenant_id=? AND event_type='report.generated'`).get(w.t.id) as { payload_json: string }).payload_json);
    expect(ev.report_key).toBe('vendor-roster');
    expect(ev.format).toBe('csv');
    expect(ev.row_count).toBe(1);
  });

  test('proper RFC-4180 quoting for fields with commas', async () => {
    const w = world();
    // A vendor name containing a comma must be quoted in the CSV.
    const v = seedVendor(w.db, w.t.id, { business_name: 'Bolt, Inc.', trade: 'electrical' });
    const loc = w.db.prepare('SELECT id FROM locations WHERE tenant_id=? LIMIT 1').get(w.t.id) as { id: string };
    seedVendorLocation(w.db, w.t.id, v.id, loc.id, { status: 'approved' });
    const body = (await bytesOf(await generate(w.jwt, 'vendor-roster', 'csv'))).toString('utf-8');
    expect(body).toContain('"Bolt, Inc."');
  });
});

// ── PDF round-trip ───────────────────────────────────────────────────────────────────

describe('report PDF export', () => {
  test('vendor-roster PDF: valid, stored encrypted, contains title + year', async () => {
    const w = world();
    const res = await generate(w.jwt, 'vendor-roster', 'pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');

    const blob = await getBlobStore().get(latestStorageKey(w.db, w.t.id));
    const pdfBytes = unpackEncrypted(blob);
    const pdf = await PDFDocument.load(pdfBytes); // valid + decryptable
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = decompressPdfText(pdfBytes); // inflate content streams to read drawn text
    expect(text).toContain('Vendor Roster'); // title
    expect(text).toContain('2026');          // generation timestamp footer
  });
});

// ── Empty report graceful ─────────────────────────────────────────────────────────────

describe('empty report output', () => {
  test('CSV with no rows = header only; PDF = valid single page', async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const t = seedTenant(db, { name: 'Empty Co' });
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const jwt = issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' });

    const csv = (await bytesOf(await generate(jwt, 'deficiency-analysis', 'csv'))).toString('utf-8');
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines).toHaveLength(1); // header only
    expect(lines[0]).toContain('Requirement');

    const pdfRes = await generate(jwt, 'deficiency-analysis', 'pdf');
    const pdf = await PDFDocument.load(unpackEncrypted(await getBlobStore().get(latestStorageKey(db, t.id))));
    expect(pdf.getPageCount()).toBe(1);
  });
});

// ── Sensitive exclusion across ALL outputs (defensibility) ────────────────────────────

describe('Sensitive exclusion — no report output contains raw TIN/ACH', () => {
  test('non-vacuous: data present (decrypts), absent from every report CSV + PDF', async () => {
    const w = world();
    // non-vacuous proof the Sensitive data exists in the store
    const ex = w.db.prepare(`SELECT payload_json FROM extractions WHERE tenant_id=? AND doc_type='w9'`).get(w.t.id) as { payload_json: string };
    expect(decryptField(JSON.parse(ex.payload_json).tin_value.value)).toBe(TIN);

    const assertClean = (s: string) => {
      expect(s).not.toContain(TIN);
      expect(s).not.toContain(ROUTING);
      expect(s).not.toContain(ACCOUNT);
      expect(s).not.toMatch(SSN_SHAPED);
    };

    for (const r of REPORTS) {
      const csv = (await bytesOf(await generate(w.jwt, r.key, 'csv'))).toString('utf-8');
      assertClean(csv);
      await generate(w.jwt, r.key, 'pdf');
      const pdfText = decompressPdfText(unpackEncrypted(await getBlobStore().get(latestStorageKey(w.db, w.t.id))));
      assertClean(pdfText);
    }
  });
});

// ── format validation ─────────────────────────────────────────────────────────────────

describe('format validation', () => {
  test('invalid format → 400', async () => {
    const w = world();
    const { GET } = await import('@/app/api/reports/[reportKey]/route');
    const res = await GET(new Request('http://t/api/reports/vendor-roster?format=xml', { headers: { Authorization: `Bearer ${w.jwt}` } }), { params: { reportKey: 'vendor-roster' } });
    expect(res.status).toBe(400);
  });
});
