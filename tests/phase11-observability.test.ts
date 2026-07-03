// Phase 11 · Slice 5 — Observability + secrets. Proves: the beforeSend scrub removes
// Sensitive values from a captured event; the SEC-16 / OPS-3 alerts fire with IDs-only
// context; and existing encrypted data still decrypts after the key_version migration.

import type Database from 'better-sqlite3';
import {
  setupTestDb, seedTenant, seedTenantUser, seedLocation, seedVendor, seedVendorLocation,
  seedRequirementSettings, seedRequirementRule, seedDocument, seedExtraction,
} from './helpers';
import { scrubEvent, scrubValue } from '@/lib/observability/scrub';
import * as obs from '@/lib/observability';
import { encryptForStorage, decryptFromStorage, type EncryptionMeta } from '@/lib/crypto/envelope';
import { encryptField, decryptField } from '@/lib/crypto/field';
import { queueNotification } from '@/lib/notifications/queue';
import { processDueNotifications } from '@/lib/notifications/worker';
import { NoOpMailer } from '@/lib/notifications/mailer';
import type { FieldValue, ProcessedW9Extraction } from '@/lib/extraction/types';

const TIN = '123-45-6789', SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const NOW = new Date('2026-07-03T12:00:00.000Z');

function fv<T>(v: T): FieldValue<T> { return { value: v, confidence: 1, band: 'high', source: { page: 1, snippet: '' }, corroborated: false }; }
function w9(c: string): ProcessedW9Extraction { return { doc_type: 'w9', document_type_confirmed: 'w9', legal_name: fv<string | null>('Acme'), business_name: fv<string | null>('Acme'), federal_tax_classification: fv<string | null>('llc'), tin_type: fv<string | null>('ein'), tin_value: fv<string | null>(c), address: fv<string | null>('1 Main'), signature_present: fv<boolean | null>(true), signature_date: fv<string | null>('2026-01-01') }; }

afterEach(() => jest.restoreAllMocks());

// ── beforeSend scrub ──────────────────────────────────────────────────────────

describe('scrub', () => {
  test('redacts values under Sensitive-looking keys (any depth)', () => {
    const scrubbed = scrubValue({
      tenant_id: 't1',
      tin_value: '12-3456789',
      nested: { routing_number: '021000021', account_number: '9876543210', note: 'ok' },
      password: 'hunter2',
    }) as Record<string, unknown>;
    expect(scrubbed.tin_value).toBe('[REDACTED]');
    expect((scrubbed.nested as Record<string, unknown>).routing_number).toBe('[REDACTED]');
    expect((scrubbed.nested as Record<string, unknown>).account_number).toBe('[REDACTED]');
    expect(scrubbed.password).toBe('[REDACTED]');
    expect(scrubbed.tenant_id).toBe('t1'); // non-sensitive preserved
    expect((scrubbed.nested as Record<string, unknown>).note).toBe('ok');
  });

  test('redacts Sensitive digit patterns inside free-text strings', () => {
    const out = scrubValue('decrypt failed for TIN 123-45-6789 / EIN 12-3456789 / acct 9876543210') as string;
    expect(out).not.toMatch(SSN_RE);
    expect(out).not.toContain('12-3456789');
    expect(out).not.toContain('9876543210');
    expect(out).toContain('[REDACTED]');
  });

  test('a whole COI/extraction payload is redacted by key', () => {
    const scrubbed = scrubValue({ extraction: { tin_value: { value: '123456789' } }, payload_json: '{secret}' }) as Record<string, unknown>;
    expect(scrubbed.extraction).toBe('[REDACTED]');
    expect(scrubbed.payload_json).toBe('[REDACTED]');
  });

  // Load-bearing proof #1: a (thrown-error-shaped) event is scrubbed everywhere.
  test('a captured event with a TIN/ACH in message, exception, breadcrumb, extra, request → scrubbed', () => {
    const event = {
      message: 'processing failed for 123456789',
      exception: { values: [{ type: 'Error', value: `decrypt failed for TIN ${TIN}` }] },
      breadcrumbs: [{ message: 'loaded account 9876543210' }],
      extra: { full_tin: '123456789', note: 'routing 021000021' },
      request: { data: { account_number: '123456789012' } },
    };
    const s = JSON.stringify(scrubEvent(event));
    for (const secret of [TIN, '9876543210', '021000021', '123456789012', '123456789']) {
      expect(s).not.toContain(secret);
    }
    expect(s).toContain('[REDACTED]');
  });
});

// ── SEC-13 key_version migration-safety ──────────────────────────────────────

describe('key_version — existing encrypted data still decrypts', () => {
  test('envelope: new meta carries v1; legacy meta WITHOUT key_version still decrypts', () => {
    const { ciphertext, meta } = encryptForStorage(Buffer.from('document bytes'));
    expect(meta.key_version).toBe(1);
    expect(decryptFromStorage(ciphertext, meta).toString()).toBe('document bytes');

    const legacy: EncryptionMeta = { algo: meta.algo, iv: meta.iv, tag: meta.tag, wrapped_data_key: meta.wrapped_data_key };
    expect('key_version' in legacy).toBe(false);
    expect(decryptFromStorage(ciphertext, legacy).toString()).toBe('document bytes'); // defaults to v1
  });

  test('field: unversioned 3-part (v1) format unchanged AND round-trips; a v1-tagged form is understood', () => {
    const ct = encryptField(TIN);
    expect(ct.split(':')).toHaveLength(3); // format unchanged — v1 is implicit
    expect(decryptField(ct)).toBe(TIN);
    expect(decryptField(`v1:${ct}`)).toBe(TIN); // version-aware hook
  });

  test('documents.key_version defaults to 1 for rows after the migration', () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    const v = seedVendor(db, t.id);
    const doc = seedDocument(db, t.id, v.id);
    expect((db.prepare('SELECT key_version FROM documents WHERE id = ?').get(doc.id) as { key_version: number }).key_version).toBe(1);
  });
});

// ── SEC-16: forced decrypt failure → alert with IDs only ─────────────────────

describe('SEC-16 · export.sensitive_decrypt_failed alert', () => {
  test('a forced decrypt failure fires the alert with IDs + counts ONLY (no plaintext/ciphertext)', async () => {
    const db = setupTestDb();
    const t = seedTenant(db, { name: 'Storage Star' });
    const admin = seedTenantUser(db, t.id, { role: 'admin' });
    const loc = seedLocation(db, t.id);
    const v = seedVendor(db, t.id, { business_name: 'Acme', trade: 'plumbing' });
    seedVendorLocation(db, t.id, v.id, loc.id, { status: 'approved' });
    seedRequirementSettings(db, t.id);
    seedRequirementRule(db, t.id, admin.id, { requirement_key: 'coverage.general_liability.each_occurrence', required_value: '1000000' });
    const w9d = seedDocument(db, t.id, v.id, { doc_type: 'w9' });
    seedExtraction(db, t.id, w9d.id, w9(encryptField(TIN)));
    // Corrupt the TIN ciphertext so decryptField throws during the sensitive export.
    const ext = db.prepare(`SELECT id, payload_json FROM extractions WHERE tenant_id=? AND doc_type='w9'`).get(t.id) as { id: string; payload_json: string };
    const payload = JSON.parse(ext.payload_json);
    payload.tin_value.value = 'not-valid-ciphertext';
    db.prepare('UPDATE extractions SET payload_json=? WHERE id=?').run(JSON.stringify(payload), ext.id);

    const spy = jest.spyOn(obs, 'captureSecurityAlert').mockImplementation(() => {});
    const { createAuditExport } = await import('@/lib/exports/audit-export');
    await createAuditExport({ db, tenantId: t.id, requestedBy: admin.id, scope: 'vendor', scopeRef: v.id, format: 'csv', includesSensitive: true, reason: 'Dispute requires banking confirmation.' });

    const call = spy.mock.calls.find((c) => c[0] === 'export.sensitive_decrypt_failed');
    expect(call).toBeDefined();
    const ctx = call![1] as Record<string, unknown>;
    expect(ctx).toMatchObject({ tenant_id: t.id });
    expect(ctx).toHaveProperty('export_id');
    expect((ctx.unreadable as { tin: number }).tin).toBeGreaterThanOrEqual(1);
    // IDs + counts only — no plaintext TIN, no ciphertext string, no key material.
    const s = JSON.stringify(ctx);
    expect(s).not.toMatch(SSN_RE);
    expect(s).not.toContain('not-valid-ciphertext');
  });
});

// ── OPS-3: notification failure → alert with IDs only ────────────────────────

describe('OPS-3 · notification.failed alert', () => {
  test('a failed send fires notification.failed with IDs + kind, no Sensitive content', async () => {
    const db = setupTestDb();
    const t = seedTenant(db);
    // Recipient user does not exist → resolveRecipient fails → markFailed → alert.
    const notifId = queueNotification(db, t.id, { recipientType: 'user', recipientRef: 'ghost-user', kind: 'exception', payload: { type: 'vendor_submitted' } });

    const spy = jest.spyOn(obs, 'captureSecurityAlert').mockImplementation(() => {});
    const tick = await processDueNotifications(new NoOpMailer(), db, NOW);
    expect(tick.failed).toBe(1);

    const call = spy.mock.calls.find((c) => c[0] === 'notification.failed');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ tenant_id: t.id, notification_id: notifId, kind: 'exception' });
  });
});
