// Phase 9, Slice F — consolidated integration matrix (end-to-end: route → BlobStore → download).
//
// The per-slice suites (phase9-reports, -report-export, -audit-export, -audit-content) cover the
// granular cases and run in the same full suite. This file proves the cross-cutting END-TO-END
// flows in one place — especially the Sensitive-exclusion inverse through the actual download
// path, which is the phase's defensibility capstone.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  seedTenant, seedTenantUser, seedRegion, seedLocation, seedVendor, seedVendorLocation,
  seedDocument, seedExtraction, seedRequirementSettings, seedRequirementRule, assignUserToRegion,
} from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { TenantDB } from '@/lib/db/tenant';
import { encryptField, decryptField } from '@/lib/crypto/field';
import { REPORTS } from '@/lib/reports';
import { processQueuedExports } from '@/lib/exports/worker';
import type { FieldValue, ProcessedCOIExtraction, ProcessedW9Extraction, ProcessedACHExtraction } from '@/lib/extraction/types';

const TIN = '123-45-6789', ROUTING = '021000021', ACCOUNT = '9876543210';
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const NOW = new Date('2026-06-30T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function fv<T>(v: T): FieldValue<T> { return { value: v, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false }; }
function coi(): ProcessedCOIExtraction { return { doc_type: 'coi', document_type_confirmed: 'coi', certificate_date: fv<string | null>(null), producer: fv<string | null>(null), named_insured: fv<string | null>(null), insured_address: fv<string | null>(null), insurers: [], policies: [{ coverage_type: fv<string | null>('general_liability'), insurer_letter: fv<string | null>(null), policy_number: fv<string | null>(null), effective_date: fv<string | null>(null), expiration_date: fv<string | null>('2027-01-01'), limits: { each_occurrence: fv<number | null>(1_000_000) }, additional_insured: fv<boolean | null>(true), additional_insured_scope: fv<string | null>(null), waiver_of_subrogation: fv<boolean | null>(false), primary_noncontributory: fv<boolean | null>(null) }], additional_insured_entities: fv<string | null>(null), description_of_operations: fv<string | null>(null), certificate_holder: fv<string | null>(null) }; }
function w9(c: string): ProcessedW9Extraction { return { doc_type: 'w9', document_type_confirmed: 'w9', legal_name: fv<string | null>('Acme'), business_name: fv<string | null>('Acme'), federal_tax_classification: fv<string | null>('llc'), tin_type: fv<string | null>('ein'), tin_value: fv<string | null>(c), address: fv<string | null>('1 Main'), signature_present: fv<boolean | null>(true), signature_date: fv<string | null>('2026-01-01') }; }
function ach(r: string, a: string): ProcessedACHExtraction { return { doc_type: 'ach', document_type_confirmed: 'ach', account_holder_name: fv<string | null>('Acme'), bank_name: fv<string | null>('Bank'), routing_number: fv<string | null>(r), account_number: fv<string | null>(a), account_type: fv<string | null>('checking'), voided_check_present: fv<boolean | null>(true), authorization_signature: fv<boolean | null>(true) }; }
function aevt(db: Database.Database, tenantId: string, vendorId: string, type: string): void {
  db.prepare(`INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, payload_json, created_at) VALUES (?,?,'user','u',?,'vendor',?,'{}',?)`).run(randomUUID(), tenantId, type, vendorId, new Date(NOW.getTime() - 86_400_000).toISOString());
}
function decompressPdfText(pdf: Buffer): string {
  let out = '', idx = 0;
  for (;;) {
    const s = pdf.indexOf('stream', idx); if (s === -1) break;
    let ds = s + 6; if (pdf[ds] === 0x0d) ds++; if (pdf[ds] === 0x0a) ds++;
    const e = pdf.indexOf('endstream', ds); if (e === -1) break;
    try {
      const inf = zlib.inflateSync(pdf.subarray(ds, e)).toString('latin1');
      out += inf;
      for (const m of inf.matchAll(/<([0-9A-Fa-f]+)>/g)) if (m[1].length % 2 === 0) out += Buffer.from(m[1], 'hex').toString('latin1');
    } catch { /* not flate */ }
    idx = e + 9;
  }
  return out;
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }
async function reportFile(jwt: string, key: string, fmt: 'csv' | 'pdf'): Promise<Buffer> {
  const { GET } = await import('@/app/api/reports/[reportKey]/route');
  const res = await GET(new Request(`http://t/api/reports/${key}?format=${fmt}`, bearer(jwt)), { params: { reportKey: key } });
  return Buffer.from(await res.arrayBuffer());
}
async function postExport(jwt: string, body: unknown) {
  return (await import('@/app/api/exports/route')).POST(new Request('http://t/api/exports', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}
async function downloadExport(jwt: string, id: string) {
  return (await import('@/app/api/exports/[id]/download/route')).GET(new Request(`http://t/api/exports/${id}/download`, bearer(jwt)), { params: { id } });
}

function world() {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db, { name: 'Storage Star' });
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const store = seedTenantUser(db, t.id, { role: 'store_manager' });
  const district = seedTenantUser(db, t.id, { role: 'district_manager' });
  const r1 = seedRegion(db, t.id, 'R1'); const r2 = seedRegion(db, t.id, 'R2');
  assignUserToRegion(db, district.id, r1.id, t.id);
  const loc = seedLocation(db, t.id, { name: 'Main St', regionId: r1.id });
  seedRequirementSettings(db, t.id);
  seedRequirementRule(db, t.id, admin.id, { requirement_key: 'coverage.general_liability.each_occurrence', required_value: '1000000' });
  const v = seedVendor(db, t.id, { business_name: 'Acme Plumbing', trade: 'plumbing' });
  seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
  const cd = seedDocument(db, t.id, v.id, { doc_type: 'coi' }); seedExtraction(db, t.id, cd.id, coi());
  const wd = seedDocument(db, t.id, v.id, { doc_type: 'w9' }); seedExtraction(db, t.id, wd.id, w9(encryptField(TIN)));
  const ad = seedDocument(db, t.id, v.id, { doc_type: 'ach' }); seedExtraction(db, t.id, ad.id, ach(encryptField(ROUTING), encryptField(ACCOUNT)));
  aevt(db, t.id, v.id, 'vendor.approved');
  return {
    db, t, vendorId: v.id, region1: r1.id, region2: r2.id,
    adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }),
    storeJwt: issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }),
    districtJwt: issueToken({ sub: district.id, tenantId: t.id, role: 'district_manager', type: 'tenant' }),
  };
}
const clean = (s: string) => { expect(s).not.toContain(TIN); expect(s).not.toContain(ROUTING); expect(s).not.toContain(ACCOUNT); expect(s).not.toMatch(SSN); };

afterEach(() => closeDb());

// ── Reports end-to-end ─────────────────────────────────────────────────────────────────

describe('integration — reports', () => {
  test('all six render CSV (200, header); roster CSV has the seeded vendor', async () => {
    const w = world();
    for (const r of REPORTS) {
      const csv = (await reportFile(w.adminJwt, r.key, 'csv')).toString('utf-8');
      expect(csv.replace('﻿', '').split('\r\n')[0].length).toBeGreaterThan(0); // header row
    }
    const roster = (await reportFile(w.adminJwt, 'vendor-roster', 'csv')).toString('utf-8');
    expect(roster).toContain('Acme Plumbing');
  });

  test('roster PDF round-trip: title + timestamp + the vendor row', async () => {
    const w = world();
    const text = decompressPdfText(await reportFile(w.adminJwt, 'vendor-roster', 'pdf'));
    expect(text).toContain('Vendor Roster');
    expect(text).toContain('2026');
    expect(text).toContain('Acme Plumbing');
  });

  test('Sensitive exclusion across every report CSV + PDF (non-vacuous)', async () => {
    const w = world();
    const wd = w.db.prepare(`SELECT payload_json FROM extractions WHERE tenant_id=? AND doc_type='w9'`).get(w.t.id) as { payload_json: string };
    expect(decryptField(JSON.parse(wd.payload_json).tin_value.value)).toBe(TIN); // data really present
    for (const r of REPORTS) {
      clean((await reportFile(w.adminJwt, r.key, 'csv')).toString('utf-8'));
      clean(decompressPdfText(await reportFile(w.adminJwt, r.key, 'pdf')));
    }
  });
});

// ── Audit export end-to-end ─────────────────────────────────────────────────────────────

describe('integration — audit export sync + async', () => {
  test('sync vendor: POST → download contains the event, no Sensitive (default)', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false })).json();
    expect(data.status).toBe('ready');
    const csv = Buffer.from(await (await downloadExport(w.adminJwt, data.export_id)).arrayBuffer()).toString('utf-8');
    expect(csv).toContain('vendor.approved');
    clean(csv);
  });

  test('async org: queued → worker → ready → notification → download', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).json();
    expect(data.status).toBe('queued');
    expect((await processQueuedExports(w.db, NOW)).generated).toBe(1);
    const tdb = new TenantDB(w.db, w.t.id);
    expect(tdb.get(`SELECT id FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='audit_export_ready'`)).toBeDefined();
    expect((await downloadExport(w.adminJwt, data.export_id)).status).toBe(200);
    // idempotent: a second tick generates nothing
    expect((await processQueuedExports(w.db, NOW)).generated).toBe(0);
  });
});

// ── includes_sensitive inverse, end-to-end ────────────────────────────────────────────────

describe('integration — includes_sensitive inverse (end-to-end)', () => {
  test('empty reason → 422', async () => {
    const w = world();
    expect((await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: true, reason: '' })).status).toBe(422);
  });

  test('default download has NO Sensitive; opt-in download DOES (+ sensitive_included audit)', async () => {
    const w = world();
    const def = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false })).json();
    clean(Buffer.from(await (await downloadExport(w.adminJwt, def.data.export_id)).arrayBuffer()).toString('utf-8'));

    const inc = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: true, reason: 'Insurer dispute over coverage.' })).json();
    const csv = Buffer.from(await (await downloadExport(w.adminJwt, inc.data.export_id)).arrayBuffer()).toString('utf-8');
    expect(csv).toContain(TIN);       // the inverse: opt-in really includes
    expect(csv).toContain(ROUTING);
    expect(csv).toContain(ACCOUNT);
    const tdb = new TenantDB(w.db, w.t.id);
    expect(tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='export.sensitive_included' AND target_id=?`, [inc.data.export_id])).toBeDefined();
  });
});

// ── District / Manager / cross-tenant ─────────────────────────────────────────────────────

describe('integration — authority + isolation', () => {
  test('District: region permitted (Standard-only download), org + out-of-region 403 + violation, sensitive coerced', async () => {
    const w = world();
    // region in-scope → queued; worker → download is Standard-only despite Sensitive on file
    const r = await (await postExport(w.districtJwt, { scope: 'region', scope_ref: w.region1, format: 'csv', includes_sensitive: true, reason: 'ignored for district' })).json();
    await processQueuedExports(w.db, NOW);
    const csv = Buffer.from(await (await downloadExport(w.districtJwt, r.data.export_id)).arrayBuffer()).toString('utf-8');
    clean(csv); // Standard-only — coercion held end to end
    const tdb = new TenantDB(w.db, w.t.id);
    expect(tdb.get<{ includes_sensitive: number }>(`SELECT includes_sensitive FROM audit_exports WHERE tenant_id=? AND id=?`, [r.data.export_id])!.includes_sensitive).toBe(0);

    expect((await postExport(w.districtJwt, { scope: 'org', scope_ref: null, format: 'csv' })).status).toBe(403);
    expect((await postExport(w.districtJwt, { scope: 'region', scope_ref: w.region2, format: 'csv' })).status).toBe(403);
    const violations = (w.db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE tenant_id=? AND event_type='security.scope_violation'`).get(w.t.id) as { n: number }).n;
    expect(violations).toBeGreaterThanOrEqual(3); // sensitive-coerce + org + out-of-region
  });

  test('Manager (store) → 403 on POST/GET/download (Admin-only, not 404)', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false })).json();
    expect((await postExport(w.storeJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv' })).status).toBe(403);
    const getMeta = await (await import('@/app/api/exports/[id]/route')).GET(new Request(`http://t/api/exports/${data.export_id}`, bearer(w.storeJwt)), { params: { id: data.export_id } });
    expect(getMeta.status).toBe(403);
    expect((await downloadExport(w.storeJwt, data.export_id)).status).toBe(403);
  });

  test('cross-tenant: tenant B cannot view or download tenant A export (404), non-vacuous', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false })).json();
    const tB = seedTenant(w.db); const adminB = seedTenantUser(w.db, tB.id, { role: 'admin' });
    const jwtB = issueToken({ sub: adminB.id, tenantId: tB.id, role: 'admin', type: 'tenant' });
    expect((await downloadExport(w.adminJwt, data.export_id)).status).toBe(200); // non-vacuous: A can
    const metaB = await (await import('@/app/api/exports/[id]/route')).GET(new Request(`http://t/api/exports/${data.export_id}`, bearer(jwtB)), { params: { id: data.export_id } });
    expect(metaB.status).toBe(404);
    expect((await downloadExport(jwtB, data.export_id)).status).toBe(404);
  });
});
