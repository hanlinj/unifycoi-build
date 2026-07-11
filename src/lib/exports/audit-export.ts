// Audit export engine (Slice D — plumbing). Produces a point-in-time, scope-filtered export
// of the audit trail. Sync for small scopes (vendor/location); async (worker) for large ones
// (region/org/tenant_offboard). Files are envelope-encrypted, self-contained (envelope-file.ts),
// and stored in BlobStore. Generation + Sensitive-inclusion + download are all audited.
//
// NOTE: the rich evidentiary CONTENT/FORMAT (posture, requirements-in-force, documents
// manifest, chronological PDF, offboard-from-inception completeness) is Slice E. This slice
// lands a correct-but-basic audit-events export so the engine is testable end to end.

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { captureSecurityAlert } from '@/lib/observability';
import { getBlobStore } from '@/lib/blob';
import { packEncrypted } from '@/lib/crypto/envelope-file';
import { gatherAuditExportContent } from './content';
import { renderAuditExportCsv } from './audit-csv';
import { renderAuditExportPdf } from './audit-pdf';

export type ExportScope = 'vendor' | 'location' | 'region' | 'org' | 'tenant_offboard';
export type ExportFormat = 'pdf' | 'csv';

export const SYNC_SCOPES: ExportScope[] = ['vendor', 'location'];
export const ASYNC_SCOPES: ExportScope[] = ['region', 'org', 'tenant_offboard'];
const SCOPE_REF_REQUIRED: ExportScope[] = ['vendor', 'location', 'region'];
const MIN_REASON = 10;

export class AuditExportError extends Error {
  constructor(message: string, public readonly code: 'BAD_REQUEST' | 'REASON_REQUIRED') {
    super(message);
  }
}

export interface CreateExportInput {
  db: Db;
  tenantId: string;
  requestedBy: string;
  scope: ExportScope;
  scopeRef: string | null;
  format: ExportFormat;
  includesSensitive: boolean;
  reason?: string | null;
}

export interface CreateExportResult {
  exportId: string;
  status: 'ready' | 'queued';
}

export async function createAuditExport(input: CreateExportInput): Promise<CreateExportResult> {
  const { db, tenantId, requestedBy, scope, scopeRef, format, includesSensitive, reason } = input;

  if (![...SYNC_SCOPES, ...ASYNC_SCOPES].includes(scope)) throw new AuditExportError('Invalid scope', 'BAD_REQUEST');
  if (format !== 'pdf' && format !== 'csv') throw new AuditExportError('Invalid format', 'BAD_REQUEST');
  if (SCOPE_REF_REQUIRED.includes(scope) && !scopeRef) throw new AuditExportError(`scope_ref is required for ${scope} scope`, 'BAD_REQUEST');
  if (includesSensitive && (!reason || reason.trim().length < MIN_REASON)) {
    throw new AuditExportError(`A reason of at least ${MIN_REASON} characters is required to include Sensitive data`, 'REASON_REQUIRED');
  }

  const tdb = new TenantDB(db, tenantId);
  const exportId = randomUUID();
  const now = new Date();
  const isSync = SYNC_SCOPES.includes(scope);

  await tdb.insert('audit_exports', {
    id: exportId,
    requested_by: requestedBy,
    scope_type: scope,
    scope_ref: scopeRef,
    format,
    includes_sensitive: includesSensitive,
    status: isSync ? 'generating' : 'queued',
    storage_key: null,
    claimed_at: null,
    created_at: now,
    completed_at: null,
  });

  await logAudit(db, {
    tenantId, actorType: 'user', actorId: requestedBy,
    eventType: 'export.generated', targetType: 'audit_export', targetId: exportId,
    payload: { scope, scope_ref: scopeRef, format, includes_sensitive: includesSensitive, mode: isSync ? 'sync' : 'async' },
  });

  if (includesSensitive) {
    await logAudit(db, {
      tenantId, actorType: 'user', actorId: requestedBy,
      eventType: 'export.sensitive_included', targetType: 'audit_export', targetId: exportId,
      payload: { scope, scope_ref: scopeRef, reason: reason!.trim() },
    });
  }

  if (isSync) {
    await generateExportArtifact(db, tenantId, exportId);
    return { exportId, status: 'ready' };
  }
  return { exportId, status: 'queued' };
}

interface ExportRow {
  id: string; scope_type: ExportScope; scope_ref: string | null; format: ExportFormat; includes_sensitive: boolean; status: string;
}

interface ExportRowFull extends ExportRow { requested_by: string }

/** Build the export bytes, encrypt, store, and flip the row to 'ready'. Shared by sync + worker. */
export async function generateExportArtifact(db: Db, tenantId: string, exportId: string): Promise<string> {
  const tdb = new TenantDB(db, tenantId);
  const row = (await tdb.get<ExportRowFull>(
    'SELECT id, scope_type, scope_ref, format, includes_sensitive, status, requested_by FROM audit_exports WHERE tenant_id = $1 AND id = $2',
    [exportId]
  ))!;
  const generator = (await tdb.get<{ id: string; name: string; role: string }>('SELECT id, name, role FROM users WHERE tenant_id = $1 AND id = $2', [row.requested_by])) ?? null;
  const tenantRow = await db.selectFrom('tenants').select('name').where('id', '=', tenantId).executeTakeFirst();
  const tenantName = tenantRow?.name ?? 'UnifyCOI';

  const { bytes, decryptFailures } = await buildAuditExportBytes(db, tenantId, {
    scope: row.scope_type, scopeRef: row.scope_ref, format: row.format,
    includesSensitive: row.includes_sensitive, tenantName, generator,
  });

  // If any Sensitive ciphertext was unreadable, record the degradation (counts only — no
  // Sensitive content in the payload). The artifact still renders '(unreadable)' gracefully.
  const totalFails = decryptFailures.tin + decryptFailures.routing + decryptFailures.account;
  if (totalFails > 0) {
    await logAudit(db, {
      tenantId, actorType: 'user', actorId: row.requested_by,
      eventType: 'export.sensitive_decrypt_failed', targetType: 'audit_export', targetId: exportId,
      payload: { unreadable: decryptFailures },
    });
    // SEC-16: an unreadable Sensitive value means key/data corruption — alert immediately.
    // IDs + counts ONLY (decryptFailures is counts); no plaintext/ciphertext/key material.
    captureSecurityAlert('export.sensitive_decrypt_failed', {
      tenant_id: tenantId, export_id: exportId, unreadable: decryptFailures,
    });
  }

  const storageKey = `tenants/${tenantId}/exports/${exportId}.${row.format}`;
  await getBlobStore().put(storageKey, packEncrypted(bytes));

  await tdb.update('audit_exports', { status: 'ready', storage_key: storageKey, claimed_at: null, completed_at: new Date() }, { id: exportId });
  return storageKey;
}

// ── Scope → audit_events ────────────────────────────────────────────────────────────

/**
 * Postgres-parameterized IN(...) placeholder list, starting at $<startAt>. `reports/index.ts`'s
 * `inClause()` is SQLite `?`-only (still Stage 9's file, un-converted) — a narrow local helper
 * here avoids pulling that whole not-yet-scoped file into this stage's conversion. Same helper
 * as content.ts's — small and local enough that a shared export isn't worth it yet.
 */
function inClausePg(count: number, startAt: number): string {
  return Array.from({ length: count }, (_, i) => `$${startAt + i}`).join(', ');
}

interface AuditRow { created_at: string; actor_type: string; actor_id: string | null; event_type: string; target_type: string | null; target_id: string | null; payload_json: Record<string, unknown> | null }

export async function scopeAuditEvents(db: Db, tenantId: string, scope: ExportScope, scopeRef: string | null): Promise<AuditRow[]> {
  const tdb = new TenantDB(db, tenantId);
  const cols = 'created_at, actor_type, actor_id, event_type, target_type, target_id, payload_json';

  // org / tenant_offboard: the complete tenant trail (offboard = from inception — Slice E
  // verifies completeness; the query is already the full trail).
  if (scope === 'org' || scope === 'tenant_offboard') {
    return tdb.all<AuditRow>(`SELECT ${cols} FROM audit_events WHERE tenant_id = $1 ORDER BY created_at ASC`);
  }

  let targets: string[] = [];
  if (scope === 'vendor') {
    targets = scopeRef ? [scopeRef] : [];
  } else if (scope === 'location') {
    const vendorIds = (await tdb.all<{ vendor_id: string }>('SELECT DISTINCT vendor_id FROM vendor_locations WHERE tenant_id = $1 AND location_id = $2', [scopeRef])).map((r) => r.vendor_id);
    targets = [scopeRef!, ...vendorIds];
  } else { // region
    const locIds = (await tdb.all<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1 AND region_id = $2', [scopeRef])).map((r) => r.id);
    const vendorIds = locIds.length
      ? (await tdb.all<{ vendor_id: string }>(`SELECT DISTINCT vendor_id FROM vendor_locations WHERE tenant_id = $1 AND location_id IN (${inClausePg(locIds.length, 2)})`, locIds)).map((r) => r.vendor_id)
      : [];
    targets = [scopeRef!, ...locIds, ...vendorIds];
  }

  if (targets.length === 0) return [];
  return tdb.all<AuditRow>(
    `SELECT ${cols} FROM audit_events WHERE tenant_id = $1 AND target_id IN (${inClausePg(targets.length, 2)}) ORDER BY created_at ASC`,
    targets
  );
}

export async function buildAuditExportBytes(
  db: Db,
  tenantId: string,
  input: {
    scope: ExportScope; scopeRef: string | null; format: ExportFormat;
    includesSensitive: boolean; tenantName: string; generator: { id: string; name: string; role: string } | null;
  }
): Promise<{ bytes: Buffer; decryptFailures: { tin: number; routing: number; account: number } }> {
  const { scope, scopeRef, format, includesSensitive, tenantName, generator } = input;
  const generatedAt = new Date().toISOString();
  const content = await gatherAuditExportContent(db, tenantId, { scope, scopeRef, includesSensitive, generatedAt, generator });

  const bytes = format === 'csv'
    ? Buffer.from(renderAuditExportCsv(content), 'utf-8')
    : Buffer.from(await renderAuditExportPdf(content, { tenantName, scopeLabel: `${scope}${scopeRef ? ` (${scopeRef})` : ''}`, generatedAt }));

  return { bytes, decryptFailures: content.decryptFailures };
}
