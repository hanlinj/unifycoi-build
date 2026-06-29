// Phase 7, Slice D — retention enforcement.
//
// Proves the retention worker marks rows past the 7-year horizon purge-eligible, leaves
// in-retention rows alone, never double-marks, never deletes, and logs a
// retention.purge_eligible audit event per marked row. Clock frozen for determinism.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedVendor, seedDocument } from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { runRetentionSweep, retentionHorizon, RETENTION_YEARS } from '@/lib/retention/worker';

const NOW = new Date('2026-06-29T12:00:00.000Z');
const EIGHT_YEARS_AGO = '2018-06-29T12:00:00.000Z';
const ONE_YEAR_AGO = '2025-06-29T12:00:00.000Z';

function insertAuditEvent(db: Database.Database, tenantId: string, createdAt: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, payload_json, created_at)
     VALUES (?, ?, 'user', 'u', 'vendor.approved', 'vendor', 'v', '{}', ?)`
  ).run(id, tenantId, createdAt);
  return id;
}

// Retention keys on superseded_at (the inactive anchor). superseded_by is a self-FK to
// documents(id); not needed to exercise the worker, so we set only superseded_at.
function setSupersededAt(db: Database.Database, docId: string, when: string): void {
  db.prepare(`UPDATE documents SET superseded_at = ? WHERE id = ?`).run(when, docId);
}

// ── horizon ──────────────────────────────────────────────────────────────────────

describe('retentionHorizon', () => {
  test('is exactly RETENTION_YEARS before now', () => {
    expect(retentionHorizon(NOW)).toBe('2019-06-29T12:00:00.000Z');
    expect(RETENTION_YEARS).toBe(7);
  });
});

// ── documents ──────────────────────────────────────────────────────────────────────

describe('retention sweep — documents', () => {
  test('marks a document superseded > 7 years ago, logs audit, does NOT delete', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setSupersededAt(db, doc.id, EIGHT_YEARS_AGO);

    const res = runRetentionSweep(db, NOW);
    expect(res.documentsMarked).toBe(1);

    const tdb = new TenantDB(db, t.id);
    const row = tdb.get<{ purge_eligible: number; purge_eligible_at: string }>(
      `SELECT purge_eligible, purge_eligible_at FROM documents WHERE tenant_id=? AND id=?`, [doc.id]
    );
    expect(row).toBeDefined();           // still exists — not deleted
    expect(row!.purge_eligible).toBe(1);
    expect(row!.purge_eligible_at).toBe(NOW.toISOString());

    const audit = tdb.get(
      `SELECT id FROM audit_events WHERE tenant_id=? AND event_type='retention.purge_eligible' AND target_id=?`, [doc.id]
    );
    expect(audit).toBeDefined();
    db.close();
  });

  test('does NOT mark a document superseded within retention', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setSupersededAt(db, doc.id, ONE_YEAR_AGO);

    const res = runRetentionSweep(db, NOW);
    expect(res.documentsMarked).toBe(0);
    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ purge_eligible: number }>(`SELECT purge_eligible FROM documents WHERE tenant_id=? AND id=?`, [doc.id])!.purge_eligible).toBe(0);
    db.close();
  });

  test('does NOT mark an active (never-superseded) document, however old', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    // uploaded long ago but still active (no superseded_at)
    db.prepare(`UPDATE documents SET uploaded_at=? WHERE id=?`).run(EIGHT_YEARS_AGO, doc.id);

    const res = runRetentionSweep(db, NOW);
    expect(res.documentsMarked).toBe(0);
    db.close();
  });

  test('idempotent: a second sweep marks nothing and adds no duplicate audit', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const doc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setSupersededAt(db, doc.id, EIGHT_YEARS_AGO);

    runRetentionSweep(db, NOW);
    const res2 = runRetentionSweep(db, NOW);
    expect(res2.documentsMarked).toBe(0);

    const tdb = new TenantDB(db, t.id);
    const audits = tdb.all(`SELECT id FROM audit_events WHERE tenant_id=? AND event_type='retention.purge_eligible' AND target_id=?`, [doc.id]);
    expect(audits).toHaveLength(1); // not 2
    db.close();
  });
});

// ── audit events ───────────────────────────────────────────────────────────────────

describe('retention sweep — audit events', () => {
  test('marks an audit event created > 7 years ago and logs a retention event', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const oldId = insertAuditEvent(db, t.id, EIGHT_YEARS_AGO);

    const res = runRetentionSweep(db, NOW);
    expect(res.auditEventsMarked).toBe(1);

    const marked = db.prepare(`SELECT purge_eligible FROM audit_events WHERE id=?`).get(oldId) as { purge_eligible: number };
    expect(marked.purge_eligible).toBe(1);
    db.close();
  });

  test('does NOT mark a recent audit event', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    insertAuditEvent(db, t.id, ONE_YEAR_AGO);
    const res = runRetentionSweep(db, NOW);
    expect(res.auditEventsMarked).toBe(0);
    db.close();
  });

  test('the retention.purge_eligible events it writes are recent and not swept this pass', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    insertAuditEvent(db, t.id, EIGHT_YEARS_AGO);

    const res = runRetentionSweep(db, NOW);
    expect(res.auditEventsMarked).toBe(1); // only the old one, not the new retention event

    // The new retention.purge_eligible event exists and is NOT purge-eligible.
    const ret = db.prepare(`SELECT purge_eligible FROM audit_events WHERE tenant_id=? AND event_type='retention.purge_eligible'`).get(t.id) as { purge_eligible: number };
    expect(ret.purge_eligible).toBe(0);
    db.close();
  });

  test('idempotent across audit events (no double-mark, no audit storm)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    insertAuditEvent(db, t.id, EIGHT_YEARS_AGO);
    insertAuditEvent(db, t.id, EIGHT_YEARS_AGO);

    const r1 = runRetentionSweep(db, NOW);
    const r2 = runRetentionSweep(db, NOW);
    expect(r1.auditEventsMarked).toBe(2);
    expect(r2.auditEventsMarked).toBe(0);
    db.close();
  });
});

// ── cross-tenant ───────────────────────────────────────────────────────────────────

describe('retention sweep — cross-tenant attribution', () => {
  test('marks rows in both tenants; each retention event is logged under its own tenant', () => {
    const db = setupTestDb();
    const tA = seedTenant(db);
    const tB = seedTenant(db);
    const vA = seedVendor(db, tA.id);
    const vB = seedVendor(db, tB.id);
    const docA = seedDocument(db, tA.id, vA.id, { doc_type: 'coi' });
    const docB = seedDocument(db, tB.id, vB.id, { doc_type: 'coi' });
    setSupersededAt(db, docA.id, EIGHT_YEARS_AGO);
    setSupersededAt(db, docB.id, EIGHT_YEARS_AGO);

    const res = runRetentionSweep(db, NOW);
    expect(res.documentsMarked).toBe(2);

    // Each retention event is scoped to the right tenant (no cross-tenant attribution).
    const aEvt = db.prepare(`SELECT tenant_id FROM audit_events WHERE event_type='retention.purge_eligible' AND target_id=?`).get(docA.id) as { tenant_id: string };
    const bEvt = db.prepare(`SELECT tenant_id FROM audit_events WHERE event_type='retention.purge_eligible' AND target_id=?`).get(docB.id) as { tenant_id: string };
    expect(aEvt.tenant_id).toBe(tA.id);
    expect(bEvt.tenant_id).toBe(tB.id);
    db.close();
  });
});
