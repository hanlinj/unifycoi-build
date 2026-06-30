// Regression: concurrent double-COI upload must not create a supersession cycle.
//
// COI upload inserts the doc, then `await`s Vision extraction, then supersedes the prior COI.
// Two overlapping uploads are both present by supersession time; without an uploaded_at guard
// each supersedes the other (A↔B), leaving NO active COI and bricking submit. Found live during
// a walkthrough (Bojo's Bash Fishing). The fix: only supersede STRICTLY OLDER COIs.

import { setupTestDb, seedTenant, seedVendor, seedDocument } from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { handleCoiUploadChase } from '@/lib/notifications/renewal';

function setUploadedAt(db: ReturnType<typeof setupTestDb>, id: string, ts: string): void {
  db.prepare('UPDATE documents SET uploaded_at = ? WHERE id = ?').run(ts, id);
}

describe('handleCoiUploadChase — no supersession cycle under concurrent COI uploads', () => {
  test('the older racing request does not supersede the newer COI (no A↔B cycle)', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { trade: 'plumbing' });
    const coiA = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    const coiB = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setUploadedAt(db, coiA.id, '2026-06-30T06:06:12.000Z'); // older
    setUploadedAt(db, coiB.id, '2026-06-30T06:06:47.000Z'); // newer

    // Both supersession calls run after BOTH rows exist (the race), in either interleaving.
    handleCoiUploadChase(db, { tenantId: t.id, vendorId: v.id, newDocumentId: coiB.id, expirationDate: '2028-01-01T00:00:00Z' });
    handleCoiUploadChase(db, { tenantId: t.id, vendorId: v.id, newDocumentId: coiA.id, expirationDate: '2028-01-01T00:00:00Z' });

    const tdb = new TenantDB(db, t.id);
    const a = tdb.get<{ superseded_by: string | null }>('SELECT superseded_by FROM documents WHERE tenant_id = ? AND id = ?', [coiA.id]);
    const b = tdb.get<{ superseded_by: string | null }>('SELECT superseded_by FROM documents WHERE tenant_id = ? AND id = ?', [coiB.id]);
    expect(b!.superseded_by).toBeNull();    // newest stays active (would be coiA without the fix → cycle)
    expect(a!.superseded_by).toBe(coiB.id); // older superseded by newest

    const active = tdb.all<{ id: string }>("SELECT id FROM documents WHERE tenant_id = ? AND doc_type = 'coi' AND state = 'active' AND superseded_by IS NULL", []);
    expect(active.map((r) => r.id)).toEqual([coiB.id]); // exactly one active COI → submit passes
    db.close();
  });

  test('control: a normal sequential renewal still supersedes the prior COI', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id, { trade: 'plumbing' });
    const oldDoc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setUploadedAt(db, oldDoc.id, '2026-06-01T00:00:00.000Z');
    const newDoc = seedDocument(db, t.id, v.id, { doc_type: 'coi' });
    setUploadedAt(db, newDoc.id, '2026-06-30T00:00:00.000Z');

    handleCoiUploadChase(db, { tenantId: t.id, vendorId: v.id, newDocumentId: newDoc.id, expirationDate: '2028-01-01T00:00:00Z' });

    const tdb = new TenantDB(db, t.id);
    expect(tdb.get<{ superseded_by: string | null }>('SELECT superseded_by FROM documents WHERE tenant_id = ? AND id = ?', [oldDoc.id])!.superseded_by).toBe(newDoc.id);
    expect(tdb.get<{ superseded_by: string | null }>('SELECT superseded_by FROM documents WHERE tenant_id = ? AND id = ?', [newDoc.id])!.superseded_by).toBeNull();
    db.close();
  });
});
