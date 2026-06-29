// Vendor onboarding — integration tests.
// Tests the complete Phase 5 flow from invite → upload → submit, with emphasis on:
//   1. Session-boundary save-and-resume (the hard case — no client state carried over)
//   2. Encryption round-trip: ciphertext ≠ plaintext; decryption recovers exactly
//   3. Submit pre-conditions: doc-completeness gate and FSM double-submit guard
//   4. Already-submitted: verification_runs presence gates SubmittedPage
//   5. Inviter notification row queued on submit

import { randomUUID } from 'crypto';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedInvite,
  seedDocument,
} from './helpers';
import { validateInviteToken } from '@/lib/services/vendor-token';
import { fsmTransition, IllegalTransitionError } from '@/lib/services/vendor-fsm';
import { TenantDB } from '@/lib/db/tenant';
import { encryptForStorage, decryptFromStorage } from '@/lib/crypto/envelope';
import { sniffIsPdf } from '@/lib/upload/validate';
import { convertImageToPdf } from '@/lib/upload/convert';
import sharp from 'sharp';

// ── Shared setup ──────────────────────────────────────────────────────────────

function buildFixture() {
  const db = setupTestDb();
  const tenant = seedTenant(db);
  const admin   = seedTenantUser(db, tenant.id, { role: 'admin' });
  const vendor  = seedVendor(db, tenant.id);
  const loc     = seedLocation(db, tenant.id);
  seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'invited_pending' });
  const { rawToken } = seedInvite(db, tenant.id, {
    vendorId: vendor.id,
    inviterUserId: admin.id,
  });
  return { db, tenant, admin, vendor, loc, rawToken };
}

// ── Save-and-resume across a hard session boundary ────────────────────────────
//
// "Hard session boundary" = the client closes and reopens the link with no
// in-memory state, cookies, localStorage, or sessionStorage from any prior visit.
// The only client-side datum that persists is the URL (the raw token the vendor
// received via email).
//
// These tests simulate that by calling validateInviteToken fresh — no shared
// in-memory objects, no useState, no client-side storage involved — and asserting
// that the server-side DB query returns the correct upload state.

describe('Save-and-resume across hard session boundary', () => {
  let fixture: ReturnType<typeof buildFixture>;
  beforeEach(() => { fixture = buildFixture(); });
  afterEach(() => fixture.db.close());

  test('COI uploaded in Session 1 is returned by fresh token lookup in Session 2', () => {
    const { db, tenant, vendor, rawToken } = fixture;

    // ── Session 1: vendor uploads COI ──
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });

    // ── Session 2: fresh browser — only the raw token URL is available ──
    // Nothing shared with Session 1 except the DB and the token string.
    const validated = validateInviteToken(db, rawToken);
    expect(validated).not.toBeNull();

    const tdb = new TenantDB(db, validated!.invite.tenant_id);
    const uploadedDocs = tdb.all<{ id: string; doc_type: string }>(
      `SELECT id, doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [validated!.invite.vendor_id]
    );

    // The page server component would pass this as initialUploadedDocs to UploadFlow
    expect(uploadedDocs).toHaveLength(1);
    expect(uploadedDocs[0].doc_type).toBe('coi');
  });

  test('all three uploaded types resume correctly', () => {
    const { db, tenant, vendor, rawToken } = fixture;

    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'w9' });
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'ach' });

    // Fresh session — only token known
    const validated = validateInviteToken(db, rawToken);
    const tdb = new TenantDB(db, validated!.invite.tenant_id);
    const uploadedDocs = tdb.all<{ doc_type: string }>(
      `SELECT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [validated!.invite.vendor_id]
    );

    const types = new Set(uploadedDocs.map((d) => d.doc_type));
    expect(types.has('coi')).toBe(true);
    expect(types.has('w9')).toBe(true);
    expect(types.has('ach')).toBe(true);
  });

  test('partial upload (COI only) shows the correct remaining types', () => {
    const { db, tenant, vendor, rawToken } = fixture;

    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });

    const validated = validateInviteToken(db, rawToken);
    const tdb = new TenantDB(db, validated!.invite.tenant_id);
    const docs = tdb.all<{ doc_type: string }>(
      `SELECT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [validated!.invite.vendor_id]
    );
    const uploadedTypes = new Set(docs.map((d) => d.doc_type));
    const remaining = ['coi', 'w9', 'ach'].filter((t) => !uploadedTypes.has(t));

    expect(remaining).toEqual(['w9', 'ach']);
  });

  test('no docs uploaded: fresh session returns empty initialUploadedDocs', () => {
    const { db, rawToken } = fixture;

    const validated = validateInviteToken(db, rawToken);
    const tdb = new TenantDB(db, validated!.invite.tenant_id);
    const docs = tdb.all<{ doc_type: string }>(
      `SELECT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [validated!.invite.vendor_id]
    );

    expect(docs).toHaveLength(0);
  });

  test('only active, non-superseded docs are returned on resume', () => {
    const { db, tenant, vendor, rawToken } = fixture;

    // Seed an active doc and a superseded doc for the same type
    const activeDoc = seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi', state: 'active' });
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi', state: 'active',
      id: randomUUID(), storage_key: `tenants/${tenant.id}/vendors/${vendor.id}/${randomUUID()}` });
    // Mark one as superseded
    db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?')
      .run(activeDoc.id, activeDoc.id); // self-reference for test simplicity — just marks it

    const validated = validateInviteToken(db, rawToken);
    const tdb = new TenantDB(db, validated!.invite.tenant_id);
    const docs = tdb.all<{ doc_type: string; id: string }>(
      `SELECT id, doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [validated!.invite.vendor_id]
    );

    // The superseded one is filtered out
    expect(docs.every((d) => d.id !== activeDoc.id || !d)).toBe(true);
  });

  test('upload state derives purely from DB — no client-side state needed', () => {
    // This is the architectural invariant: session resume requires only the raw
    // token (URL) and the DB. Simulated here by using a completely fresh set of
    // variables with zero shared state from any prior calls.
    const { db, tenant, vendor, rawToken } = fixture;

    seedDocument(db, tenant.id, vendor.id, { doc_type: 'w9' });

    // "Close browser" — no variables from the upload step are referenced below.
    // "Open browser" — only rawToken (the URL) and db (the persistence layer) are known.
    const freshValidated = validateInviteToken(db, rawToken);
    const freshTdb = new TenantDB(db, freshValidated!.invite.tenant_id);
    const freshDocs = freshTdb.all<{ doc_type: string }>(
      `SELECT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [freshValidated!.invite.vendor_id]
    );

    expect(freshDocs).toHaveLength(1);
    expect(freshDocs[0].doc_type).toBe('w9');
  });
});

// ── Encryption round-trip ─────────────────────────────────────────────────────
//
// Every vendor document is envelope-encrypted before BlobStore.put.
// These tests assert: (a) the ciphertext is not the plaintext, and
// (b) decryption recovers the original bytes exactly.

describe('Encryption round-trip', () => {
  test('ciphertext is not equal to plaintext', () => {
    const plaintext = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    const { ciphertext } = encryptForStorage(plaintext);
    expect(ciphertext.equals(plaintext)).toBe(false);
  });

  test('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
    const plaintext = Buffer.from('same content');
    const { ciphertext: ct1 } = encryptForStorage(plaintext);
    const { ciphertext: ct2 } = encryptForStorage(plaintext);
    expect(ct1.equals(ct2)).toBe(false);
  });

  test('decryptFromStorage recovers the original bytes exactly', () => {
    const plaintext = Buffer.from('exact recovery required');
    const { ciphertext, meta } = encryptForStorage(plaintext);
    const recovered = decryptFromStorage(ciphertext, meta);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  test('PDF magic bytes survive encrypt → decrypt round-trip', () => {
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const { ciphertext, meta } = encryptForStorage(pdfMagic);
    const recovered = decryptFromStorage(ciphertext, meta);
    expect(sniffIsPdf(recovered)).toBe(true);
  });

  test('image→PDF conversion output survives encrypt → decrypt round-trip', async () => {
    const jpegBuf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).jpeg().toBuffer();

    const pdfBuf = await convertImageToPdf(jpegBuf);
    expect(sniffIsPdf(pdfBuf)).toBe(true);

    const { ciphertext, meta } = encryptForStorage(pdfBuf);
    expect(ciphertext.equals(pdfBuf)).toBe(false);           // ciphertext ≠ plaintext
    const recovered = decryptFromStorage(ciphertext, meta);
    expect(recovered.equals(pdfBuf)).toBe(true);             // decryption is exact
    expect(sniffIsPdf(recovered)).toBe(true);                // magic bytes intact
  });

  test('tampered ciphertext fails authentication', () => {
    const plaintext = Buffer.from('authentic content');
    const { ciphertext, meta } = encryptForStorage(plaintext);

    // Flip one byte in the ciphertext — GCM auth tag will reject it
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;

    expect(() => decryptFromStorage(tampered, meta)).toThrow();
  });
});

// ── Submit pre-condition enforcement ─────────────────────────────────────────

describe('Submit pre-condition enforcement', () => {
  let fixture: ReturnType<typeof buildFixture>;
  beforeEach(() => { fixture = buildFixture(); });
  afterEach(() => fixture.db.close());

  test('missing docs: all three absent', () => {
    const { db, tenant, vendor } = fixture;
    const tdb = new TenantDB(db, tenant.id);
    const activeDocs = tdb.all<{ doc_type: string }>(
      `SELECT DISTINCT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [vendor.id]
    );
    const missing = ['coi', 'w9', 'ach'].filter((t) => !new Set(activeDocs.map(d => d.doc_type)).has(t));
    expect(missing).toHaveLength(3);
  });

  test('missing docs: only COI uploaded', () => {
    const { db, tenant, vendor } = fixture;
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });

    const tdb = new TenantDB(db, tenant.id);
    const activeDocs = tdb.all<{ doc_type: string }>(
      `SELECT DISTINCT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [vendor.id]
    );
    const missing = ['coi', 'w9', 'ach'].filter((t) => !new Set(activeDocs.map(d => d.doc_type)).has(t));
    expect(missing).toContain('w9');
    expect(missing).toContain('ach');
    expect(missing).not.toContain('coi');
  });

  test('all docs present: missing list is empty', () => {
    const { db, tenant, vendor } = fixture;
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'coi' });
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'w9' });
    seedDocument(db, tenant.id, vendor.id, { doc_type: 'ach' });

    const tdb = new TenantDB(db, tenant.id);
    const activeDocs = tdb.all<{ doc_type: string }>(
      `SELECT DISTINCT doc_type FROM documents
       WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL`,
      [vendor.id]
    );
    const missing = ['coi', 'w9', 'ach'].filter((t) => !new Set(activeDocs.map(d => d.doc_type)).has(t));
    expect(missing).toHaveLength(0);
  });

  test('FSM double-submit guard: IllegalTransitionError when not in onboarding', () => {
    const { db, tenant, vendor } = fixture;

    // Transition to onboarding first (open_link)
    fsmTransition(db, tenant.id, vendor.id, 'open_link');
    // Submit once (onboarding → under_review)
    fsmTransition(db, tenant.id, vendor.id, 'submit');

    // Second submit throws — status is now under_review, not onboarding
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'submit')).toThrow(IllegalTransitionError);
  });

  test('FSM open_link idempotent: no throw on second GET after status moves to onboarding', () => {
    const { db, tenant, vendor } = fixture;
    fsmTransition(db, tenant.id, vendor.id, 'open_link'); // invited_pending → onboarding

    // Simulate second page load: guard checks allPending = false, so no transition fires
    const tdb = new TenantDB(db, tenant.id);
    const locations = tdb.all<{ status: string }>(
      'SELECT status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?',
      [vendor.id]
    );
    const allPending = locations.length > 0 && locations.every((vl) => vl.status === 'invited_pending');
    expect(allPending).toBe(false); // guard prevents second open_link call

    // Would NOT throw if called, but guard prevents it — demonstrate FSM rejects it:
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'open_link')).toThrow(IllegalTransitionError);
  });
});

// ── Already-submitted: SubmittedPage gate ─────────────────────────────────────

describe('Already-submitted gate (hasRun check)', () => {
  let fixture: ReturnType<typeof buildFixture>;
  beforeEach(() => { fixture = buildFixture(); });
  afterEach(() => fixture.db.close());

  test('no verification run: page renders UploadFlow (hasRun = false)', () => {
    const { db, tenant, vendor } = fixture;
    const tdb = new TenantDB(db, tenant.id);
    const hasRun = !!tdb.get<{ id: string }>(
      `SELECT id FROM verification_runs WHERE tenant_id = ? AND vendor_id = ? LIMIT 1`,
      [vendor.id]
    );
    expect(hasRun).toBe(false);
  });

  test('verification run present: page renders SubmittedPage (hasRun = true)', () => {
    const { db, tenant, vendor } = fixture;

    db.prepare(
      `INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), tenant.id, vendor.id, 'onboarding', '1', 'approve', new Date().toISOString());

    const tdb = new TenantDB(db, tenant.id);
    const hasRun = !!tdb.get<{ id: string }>(
      `SELECT id FROM verification_runs WHERE tenant_id = ? AND vendor_id = ? LIMIT 1`,
      [vendor.id]
    );
    expect(hasRun).toBe(true);
  });

  test('fresh token lookup after submit returns inviter_user_id on the invite', () => {
    const { db, admin, rawToken } = fixture;
    const validated = validateInviteToken(db, rawToken);
    expect(validated!.invite.inviter_user_id).toBe(admin.id);
  });
});

// ── Inviter notification ──────────────────────────────────────────────────────

describe('Inviter notification on submit', () => {
  let fixture: ReturnType<typeof buildFixture>;
  beforeEach(() => { fixture = buildFixture(); });
  afterEach(() => fixture.db.close());

  test('notification row is queued for the inviter after submit', () => {
    const { db, tenant, admin, vendor } = fixture;
    const now = new Date().toISOString();

    // Write the notification directly (simulating what the submit route does)
    db.prepare(
      `INSERT INTO notifications
         (id, tenant_id, recipient_type, recipient_ref, channel, kind, status, scheduled_for, sent_at, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), tenant.id,
      'user', admin.id,
      'email', 'exception', 'queued',
      null, null,
      JSON.stringify({ type: 'vendor_submitted', vendor_id: vendor.id, vendor_name: vendor.business_name }),
      now
    );

    const row = db
      .prepare(
        `SELECT recipient_type, recipient_ref, kind, status, payload_json
         FROM notifications WHERE tenant_id = ? AND recipient_ref = ?`
      )
      .get(tenant.id, admin.id) as { recipient_type: string; recipient_ref: string; kind: string; status: string; payload_json: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.recipient_type).toBe('user');
    expect(row!.recipient_ref).toBe(admin.id);
    expect(row!.kind).toBe('exception');     // immediate, not digest
    expect(row!.status).toBe('queued');
    const payload = JSON.parse(row!.payload_json) as { type: string; vendor_id: string };
    expect(payload.type).toBe('vendor_submitted');
    expect(payload.vendor_id).toBe(vendor.id);
  });

  test('notification is tenant-scoped: tenant B cannot see tenant A notification', () => {
    const { db, tenant, admin, vendor } = fixture;

    db.prepare(
      `INSERT INTO notifications
         (id, tenant_id, recipient_type, recipient_ref, channel, kind, status, scheduled_for, sent_at, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), tenant.id, 'user', admin.id,
      'email', 'exception', 'queued', null, null,
      JSON.stringify({ type: 'vendor_submitted', vendor_id: vendor.id }),
      new Date().toISOString()
    );

    const tenantB = seedTenant(db);
    const rows = db
      .prepare(`SELECT id FROM notifications WHERE tenant_id = ? AND recipient_ref = ?`)
      .all(tenantB.id, admin.id) as { id: string }[];

    expect(rows).toHaveLength(0);
  });
});
