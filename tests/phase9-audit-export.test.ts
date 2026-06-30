// Phase 9, Slice D — audit export engine (plumbing).
//
// Behavioral, route-level. Proves: sync (vendor) inline-ready + download; async (org) queue →
// worker → ready + requester notification + download; includes_sensitive reason gate + extra
// audit; download is audited; cross-tenant isolation; worker idempotency/stale-reclaim;
// Admin-only enforcement. (Rich CONTENT/FORMAT is Slice E.)

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { seedTenant, seedTenantUser, seedVendor, seedLocation, seedVendorLocation } from './helpers';
import { getRawDb, closeDb } from '@/lib/db/client';
import { issueToken } from '@/lib/auth/jwt';
import { TenantDB } from '@/lib/db/tenant';
import { processQueuedExports } from '@/lib/exports/worker';

const NOW = new Date('2026-06-30T12:00:00.000Z');

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}
function aevt(db: Database.Database, tenantId: string, targetType: string, targetId: string, type: string): void {
  db.prepare(`INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, payload_json, created_at) VALUES (?,?,'user','u',?,?,?,'{}',?)`)
    .run(randomUUID(), tenantId, type, targetType, targetId, new Date(NOW.getTime() - 1000).toISOString());
}
function bearer(jwt: string) { return { headers: { Authorization: `Bearer ${jwt}` } }; }
function jbody(jwt: string, body: unknown) { return new Request('http://t/api/exports', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

async function postExport(jwt: string, body: unknown) { return (await import('@/app/api/exports/route')).POST(jbody(jwt, body)); }
async function getMeta(jwt: string, id: string) { return (await import('@/app/api/exports/[id]/route')).GET(new Request(`http://t/api/exports/${id}`, bearer(jwt)), { params: { id } }); }
async function download(jwt: string, id: string) { return (await import('@/app/api/exports/[id]/download/route')).GET(new Request(`http://t/api/exports/${id}/download`, bearer(jwt)), { params: { id } }); }

function world() {
  closeDb();
  const db = getRawDb();
  migrate(db);
  const t = seedTenant(db, { name: 'Storage Star' });
  const admin = seedTenantUser(db, t.id, { role: 'admin' });
  const store = seedTenantUser(db, t.id, { role: 'store_manager' });
  const loc = seedLocation(db, t.id);
  const v = seedVendor(db, t.id, { business_name: 'Acme' });
  seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
  aevt(db, t.id, 'vendor', v.id, 'vendor.approved');
  aevt(db, t.id, 'vendor', v.id, 'vendor.submitted');
  return { db, t, vendorId: v.id, requesterId: admin.id, adminJwt: issueToken({ sub: admin.id, tenantId: t.id, role: 'admin', type: 'tenant' }), storeJwt: issueToken({ sub: store.id, tenantId: t.id, role: 'store_manager', type: 'tenant' }) };
}

afterEach(() => closeDb());

// ── Sync (vendor) ──────────────────────────────────────────────────────────────────

describe('audit export — sync (vendor scope)', () => {
  test('generates inline (ready), download streams the scoped events, both audited', async () => {
    const w = world();
    const res = await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('ready');

    const meta = await getMeta(w.adminJwt, data.export_id);
    expect((await meta.json()).data.status).toBe('ready');

    const dl = await download(w.adminJwt, data.export_id);
    expect(dl.status).toBe(200);
    const csv = Buffer.from(await dl.arrayBuffer()).toString('utf-8');
    // Slice E format: combined record_type CSV (was a flat event-only CSV in Slice D).
    expect(csv).toContain('record_type'); // header of the combined format
    expect(csv).toContain('vendor.approved'); // the scoped event still present (as an 'event' row)

    const tdb = new TenantDB(w.db, w.t.id);
    expect(tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='export.generated' AND target_id=?`, [data.export_id])).toBeDefined();
    expect(tdb.get(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='export.downloaded' AND target_id=?`, [data.export_id])).toBeDefined();
  });
});

// ── Async (org) ────────────────────────────────────────────────────────────────────

describe('audit export — async (org scope)', () => {
  test('queued → worker generates → ready + requester notification + download works', async () => {
    const w = world();
    const res = await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false });
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data.status).toBe('queued');

    const tick = await processQueuedExports(w.db, NOW);
    expect(tick.generated).toBe(1);

    const meta = await (await getMeta(w.adminJwt, data.export_id)).json();
    expect(meta.data.status).toBe('ready');

    const tdb = new TenantDB(w.db, w.t.id);
    const notif = tdb.get<{ recipient_ref: string; payload_json: string }>(
      `SELECT recipient_ref, payload_json FROM notifications WHERE tenant_id=? AND json_extract(payload_json,'$.type')='audit_export_ready'`
    );
    expect(notif!.recipient_ref).toBe(w.requesterId);
    expect(JSON.parse(notif!.payload_json).export_id).toBe(data.export_id);

    const dl = await download(w.adminJwt, data.export_id);
    expect(dl.status).toBe(200);
  });

  test('download before ready → 409', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).json();
    const dl = await download(w.adminJwt, data.export_id);
    expect(dl.status).toBe(409);
  });
});

// ── includes_sensitive ──────────────────────────────────────────────────────────────

describe('audit export — includes_sensitive', () => {
  test('missing/short reason → 422; no export row created', async () => {
    const w = world();
    const res = await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: true, reason: 'short' });
    expect(res.status).toBe(422);
    const tdb = new TenantDB(w.db, w.t.id);
    expect(tdb.all(`SELECT id FROM audit_exports WHERE tenant_id=?`)).toHaveLength(0);
  });

  test('valid reason → export.sensitive_included audit with reasoning', async () => {
    const w = world();
    const res = await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: true, reason: 'Insurer dispute requires banking confirmation.' });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const tdb = new TenantDB(w.db, w.t.id);
    const ev = tdb.get<{ payload_json: string }>(`SELECT payload_json FROM audit_events WHERE tenant_id=? AND event_type='export.sensitive_included' AND target_id=?`, [data.export_id]);
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload_json).reason).toContain('Insurer dispute');
  });
});

// ── validation ──────────────────────────────────────────────────────────────────────

describe('audit export — validation', () => {
  test('vendor scope without scope_ref → 400', async () => {
    const w = world();
    const res = await postExport(w.adminJwt, { scope: 'vendor', scope_ref: null, format: 'csv', includes_sensitive: false });
    expect(res.status).toBe(400);
  });
});

// ── Admin-only ────────────────────────────────────────────────────────────────────────

describe('audit export — Admin-only enforcement', () => {
  test('Store manager → 403 on POST, GET, download', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'vendor', scope_ref: w.vendorId, format: 'csv', includes_sensitive: false })).json();
    expect((await postExport(w.storeJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).status).toBe(403);
    expect((await getMeta(w.storeJwt, data.export_id)).status).toBe(403);
    expect((await download(w.storeJwt, data.export_id)).status).toBe(403);
  });
});

// ── Cross-tenant ──────────────────────────────────────────────────────────────────────

describe('audit export — cross-tenant isolation', () => {
  test("tenant B cannot read or download tenant A's export (404), non-vacuous", async () => {
    closeDb();
    const db = getRawDb();
    migrate(db);
    const tA = seedTenant(db); const tB = seedTenant(db);
    const adminA = seedTenantUser(db, tA.id, { role: 'admin' });
    const adminB = seedTenantUser(db, tB.id, { role: 'admin' });
    const v = seedVendor(db, tA.id); const loc = seedLocation(db, tA.id); seedVendorLocation(db, tA.id, v.id, loc.id, { status: 'approved' });
    aevt(db, tA.id, 'vendor', v.id, 'vendor.approved');
    const jwtA = issueToken({ sub: adminA.id, tenantId: tA.id, role: 'admin', type: 'tenant' });
    const jwtB = issueToken({ sub: adminB.id, tenantId: tB.id, role: 'admin', type: 'tenant' });

    const { data } = await (await postExport(jwtA, { scope: 'vendor', scope_ref: v.id, format: 'csv', includes_sensitive: false })).json();
    expect((await getMeta(jwtA, data.export_id)).status).toBe(200); // non-vacuous: it exists for A
    expect((await getMeta(jwtB, data.export_id)).status).toBe(404);
    expect((await download(jwtB, data.export_id)).status).toBe(404);
  });
});

// ── Worker safety ─────────────────────────────────────────────────────────────────────

describe('audit export — worker idempotency & crash safety', () => {
  test('a ready export is never re-generated on a later tick', async () => {
    const w = world();
    await (await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).json();
    expect((await processQueuedExports(w.db, NOW)).generated).toBe(1);
    expect((await processQueuedExports(w.db, NOW)).generated).toBe(0); // idempotent
  });

  test('a row stuck in generating > stale window is reclaimed and generated', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).json();
    // simulate a crashed worker: stuck in 'generating', claimed 10 min ago
    w.db.prepare(`UPDATE audit_exports SET status='generating', claimed_at=? WHERE id=?`).run(new Date(NOW.getTime() - 10 * 60_000).toISOString(), data.export_id);

    const tick = await processQueuedExports(w.db, NOW, { staleSeconds: 300 });
    expect(tick.reclaimed).toBe(1);
    expect(tick.generated).toBe(1);
    const meta = await (await getMeta(w.adminJwt, data.export_id)).json();
    expect(meta.data.status).toBe('ready');
  });

  test('a recently-claimed generating row is NOT reclaimed', async () => {
    const w = world();
    const { data } = await (await postExport(w.adminJwt, { scope: 'org', scope_ref: null, format: 'csv', includes_sensitive: false })).json();
    w.db.prepare(`UPDATE audit_exports SET status='generating', claimed_at=? WHERE id=?`).run(new Date(NOW.getTime() - 30_000).toISOString(), data.export_id);
    const tick = await processQueuedExports(w.db, NOW, { staleSeconds: 300 });
    expect(tick.reclaimed).toBe(0);
    expect(tick.generated).toBe(0);
  });
});
