// Audit export engine (Slice D — plumbing). Produces a point-in-time, scope-filtered export
// of the audit trail. Sync for small scopes (vendor/location); async (worker) for large ones
// (region/org/tenant_offboard). Files are envelope-encrypted, self-contained (envelope-file.ts),
// and stored in BlobStore. Generation + Sensitive-inclusion + download are all audited.
//
// NOTE: the rich evidentiary CONTENT/FORMAT (posture, requirements-in-force, documents
// manifest, chronological PDF, offboard-from-inception completeness) is Slice E. This slice
// lands a correct-but-basic audit-events export so the engine is testable end to end.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { getBlobStore } from '@/lib/blob';
import { packEncrypted } from '@/lib/crypto/envelope-file';
import { toCsv } from '@/lib/reports/csv';
import { renderReportPdf } from '@/lib/reports/pdf';
import { inClause } from '@/lib/reports';

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
  db: Database.Database;
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
  const now = new Date().toISOString();
  const isSync = SYNC_SCOPES.includes(scope);

  tdb.insert('audit_exports', {
    id: exportId,
    requested_by: requestedBy,
    scope_type: scope,
    scope_ref: scopeRef,
    format,
    includes_sensitive: includesSensitive ? 1 : 0,
    status: isSync ? 'generating' : 'queued',
    storage_key: null,
    claimed_at: null,
    created_at: now,
    completed_at: null,
  });

  logAudit(db, {
    tenantId, actorType: 'user', actorId: requestedBy,
    eventType: 'export.generated', targetType: 'audit_export', targetId: exportId,
    payload: { scope, scope_ref: scopeRef, format, includes_sensitive: includesSensitive, mode: isSync ? 'sync' : 'async' },
  });

  if (includesSensitive) {
    logAudit(db, {
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
  id: string; scope_type: ExportScope; scope_ref: string | null; format: ExportFormat; includes_sensitive: number; status: string;
}

/** Build the export bytes, encrypt, store, and flip the row to 'ready'. Shared by sync + worker. */
export async function generateExportArtifact(db: Database.Database, tenantId: string, exportId: string): Promise<string> {
  const tdb = new TenantDB(db, tenantId);
  const row = tdb.get<ExportRow>(
    'SELECT id, scope_type, scope_ref, format, includes_sensitive, status FROM audit_exports WHERE tenant_id = ? AND id = ?',
    [exportId]
  )!;
  const tenantName = (db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as { name: string } | undefined)?.name ?? 'UnifyCOI';
  const bytes = await buildAuditExportBytes(db, tenantId, row.scope_type, row.scope_ref, row.format, tenantName);

  const storageKey = `tenants/${tenantId}/exports/${exportId}.${row.format}`;
  await getBlobStore().put(storageKey, packEncrypted(bytes));

  tdb.update('audit_exports', { status: 'ready', storage_key: storageKey, claimed_at: null, completed_at: new Date().toISOString() }, { id: exportId });
  return storageKey;
}

// ── Scope → audit_events ────────────────────────────────────────────────────────────

interface AuditRow { created_at: string; actor_type: string; actor_id: string | null; event_type: string; target_type: string | null; target_id: string | null; payload_json: string | null }

export function scopeAuditEvents(db: Database.Database, tenantId: string, scope: ExportScope, scopeRef: string | null): AuditRow[] {
  const tdb = new TenantDB(db, tenantId);
  const cols = 'created_at, actor_type, actor_id, event_type, target_type, target_id, payload_json';

  // org / tenant_offboard: the complete tenant trail (offboard = from inception — Slice E
  // verifies completeness; the query is already the full trail).
  if (scope === 'org' || scope === 'tenant_offboard') {
    return tdb.all<AuditRow>(`SELECT ${cols} FROM audit_events WHERE tenant_id = ? ORDER BY created_at ASC`);
  }

  let targets: string[] = [];
  if (scope === 'vendor') {
    targets = scopeRef ? [scopeRef] : [];
  } else if (scope === 'location') {
    const vendorIds = tdb.all<{ vendor_id: string }>('SELECT DISTINCT vendor_id FROM vendor_locations WHERE tenant_id = ? AND location_id = ?', [scopeRef]).map((r) => r.vendor_id);
    targets = [scopeRef!, ...vendorIds];
  } else { // region
    const locIds = tdb.all<{ id: string }>('SELECT id FROM locations WHERE tenant_id = ? AND region_id = ?', [scopeRef]).map((r) => r.id);
    const vendorIds = locIds.length
      ? tdb.all<{ vendor_id: string }>(`SELECT DISTINCT vendor_id FROM vendor_locations WHERE tenant_id = ? AND location_id IN (${inClause(locIds)})`, locIds).map((r) => r.vendor_id)
      : [];
    targets = [scopeRef!, ...locIds, ...vendorIds];
  }

  if (targets.length === 0) return [];
  return tdb.all<AuditRow>(
    `SELECT ${cols} FROM audit_events WHERE tenant_id = ? AND target_id IN (${inClause(targets)}) ORDER BY created_at ASC`,
    targets
  );
}

const EXPORT_COLUMNS = ['created_at', 'actor_type', 'actor_id', 'event_type', 'target_type', 'target_id', 'payload_json'];

export async function buildAuditExportBytes(
  db: Database.Database, tenantId: string, scope: ExportScope, scopeRef: string | null, format: ExportFormat, tenantName: string
): Promise<Buffer> {
  const events = scopeAuditEvents(db, tenantId, scope, scopeRef);
  const rows = events.map((e) => [e.created_at, e.actor_type, e.actor_id ?? '', e.event_type, e.target_type ?? '', e.target_id ?? '', e.payload_json ?? '']);
  const title = `Audit Export — ${scope}${scopeRef ? ` (${scopeRef})` : ''}`;

  if (format === 'csv') {
    return Buffer.from(toCsv(EXPORT_COLUMNS, rows), 'utf-8');
  }
  const pdf = await renderReportPdf({
    tenantName,
    table: { title, subtitle: `${events.length} events`, columns: EXPORT_COLUMNS, rows },
    generatedAt: new Date().toISOString(),
    filters: {},
  });
  return Buffer.from(pdf);
}
