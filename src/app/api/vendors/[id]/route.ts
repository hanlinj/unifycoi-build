// GET /api/vendors/:id
// Vendor Record — role-conditional response.
// Admin: full workbench (evaluations, advisories, decision surface).
// Manager (district/store): status-only per invariant §7 decision 3.
// Sensitive fields (TIN, ACH account/routing) are masked server-side for non-Admin (invariant #8).

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound } from '@/lib/api';
import { resolveScope, scopeIncludesLocation } from '@/lib/scope';
import { logAudit } from '@/lib/audit';
import { computeComplianceGrid, type ComplianceGrid } from '@/lib/verification/grid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Event types excluded from the in-page Activity timeline (Zone 5) only — passive reads/internal
// signals that would otherwise flood the timeline (a page open logs vendor.viewed every time;
// scope_violation is a blocked-access record, not vendor activity). Nothing else reads this
// list: the write path (src/lib/audit.ts) and the audit export (scopeAuditEvents() in
// src/lib/exports/audit-export.ts) are untouched and still record/emit every event type,
// unfiltered. Every other vendor-targeted event type (approvals, declines, corrections, invites,
// uploads, verifications, reminders, renewals, expirations) stays visible — when in doubt this
// list stays narrow, not broad.
const TIMELINE_EXCLUDED_EVENT_TYPES = ['vendor.viewed', 'security.scope_violation'];

/** "Decided by" — never a raw user id. Approved/declined but the resolving users-table join
 *  came back empty (a deleted/orphaned user record) still gets a readable label, not a UUID. */
function decidedByName(vl: VendorLocationRow): string | null {
  if (vl.status === 'approved') return vl.approved_by_name ?? 'Unknown user';
  if (vl.status === 'declined') return vl.declined_by_name ?? 'Unknown user';
  return null;
}

interface VendorRow {
  id: string;
  business_name: string;
  trade: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

interface VendorLocationRow {
  id: string;
  location_id: string;
  location_name: string;
  status: string;
  // jsonb — Kysely/pg returns it already parsed; re-stringified before the response goes out
  // to preserve the existing wire contract (src/app/vendors/[vendorId]/page.tsx still does its
  // own JSON.parse() on this field — not part of this stage's scope to touch).
  flags_json: Record<string, unknown> | null;
  approved_at: string | null;
  approved_by_name: string | null;
  // Decline never wrote approved_by/approved_at (decision.ts's reject branch only sets
  // status), so who/when a decline happened is sourced from that location's own
  // vendor.declined audit event instead — a read-time join, no schema change.
  declined_at: string | null;
  declined_by_name: string | null;
}

interface VerificationRunRow {
  id: string;
  trigger: string;
  recommendation: string;
  created_at: string;
}

interface EvaluationRow {
  id: string;
  location_id: string;
  requirement_key: string;
  required_value: string | null;
  extracted_value_ref: string | null;
  comparison_result: string;
  confidence_band: string | null;
  outcome: string;
  note: string | null;
}

interface AdvisoryRow {
  id: string;
  key: string;
  severity: string;
  message: string;
  evidence_json: Record<string, unknown>; // jsonb — see the flags_json note above
}

interface DocumentRow {
  id: string;
  doc_type: string;
  original_filename: string | null;
  uploaded_at: string;
}

interface AuditEventRow {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  event_type: string;
  payload_json: Record<string, unknown> | null; // jsonb — already parsed (invariant 2)
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const auth = requireTenantAuth(request);
  if (isResponse(auth)) return auth;
  if (!auth.tenantId) return forbidden();

  const vendorId = params.id;
  const tenantId = auth.tenantId;
  const isAdmin = auth.role === 'admin';
  const db = getDb();
  const tdb = new TenantDB(db, tenantId);

  // Load vendor
  const vendor = await tdb.get<VendorRow>(
    `SELECT id, business_name, trade, contact_name, contact_email, contact_phone
     FROM vendors WHERE tenant_id = $1 AND id = $2`,
    [vendorId]
  );
  if (!vendor) return notFound('Vendor not found');

  // Load per-location statuses with location names. "Decided by/at" resolves for BOTH
  // approve (vendor_locations.approved_by/approved_at, already stored) and decline (never
  // stored there — decision.ts's reject branch only writes status — so sourced instead from
  // that location's own vendor.declined audit event via a LATERAL join). No schema change:
  // the decline actor/timestamp already exists in audit_events, just not in vendor_locations.
  const allLocations = await tdb.all<VendorLocationRow>(
    `SELECT vl.id, vl.location_id, l.name AS location_name, vl.status, vl.flags_json,
            vl.approved_at, approver.name AS approved_by_name,
            decline_evt.created_at AS declined_at, decliner.name AS declined_by_name
     FROM vendor_locations vl
     JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
     LEFT JOIN users approver ON approver.id = vl.approved_by AND approver.tenant_id = vl.tenant_id
     LEFT JOIN LATERAL (
       SELECT ae.actor_id, ae.created_at
       FROM audit_events ae
       WHERE ae.tenant_id = vl.tenant_id AND ae.target_id = vl.vendor_id
         AND ae.event_type = 'vendor.declined'
         AND ae.payload_json->>'location_id' = vl.location_id
       ORDER BY ae.created_at DESC
       LIMIT 1
     ) decline_evt ON vl.status = 'declined'
     LEFT JOIN users decliner ON decliner.id = decline_evt.actor_id AND decliner.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = $1 AND vl.vendor_id = $2
     ORDER BY l.name`,
    [vendorId]
  );

  // Within-tenant scope clamp (Phase 8 Slice C). A District/Store user may see this vendor
  // only if ≥1 of the vendor's locations is in their scope, and then ONLY their in-scope
  // location rows. Out-of-scope → uniform 404 (enumeration-resistant, same shape/code as a
  // genuinely-missing vendor — Search.md). Admin (scope.locationIds === null) sees all rows.
  const scope = await resolveScope(db, tenantId, auth.sub, auth.role);
  const locations = scope.locationIds === null
    ? allLocations
    : allLocations.filter((vl) => scopeIncludesLocation(scope, vl.location_id));

  if (!isAdmin && locations.length === 0) {
    // The vendor exists but is entirely outside the caller's scope — a real out-of-scope
    // access attempt. Log the security event (no Sensitive values), then 404.
    await logAudit(db, {
      tenantId,
      actorType: 'user',
      actorId: auth.sub,
      eventType: 'security.scope_violation',
      targetType: 'vendor',
      targetId: vendorId,
      payload: {
        role: auth.role,
        scope_location_ids: scope.locationIds,
        attempted: 'GET /api/vendors/:id',
      },
    });
    return notFound('Vendor not found');
  }

  // Record the in-scope view (standard-access grain) — powers Search recent-viewed. No Sensitive.
  await logAudit(db, {
    tenantId, actorType: 'user', actorId: auth.sub,
    eventType: 'vendor.viewed', targetType: 'vendor', targetId: vendorId,
    payload: { role: auth.role },
  });

  // Documents (metadata only — no storage_key, no encryption_json). state IN ('active',
  // 'correction_requested') — not just 'active' — so a document an admin flagged for
  // replacement (src/lib/documents/flags.ts) stays visible here instead of silently vanishing
  // from the workbench the moment it's flagged; superseded_by IS NULL still means "the current
  // document of this type" either way.
  const documents = await tdb.all<DocumentRow>(
    `SELECT id, doc_type, original_filename, uploaded_at
     FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND state IN ('active', 'correction_requested') AND superseded_by IS NULL
     ORDER BY uploaded_at DESC`,
    [vendorId]
  );

  // Manager view: status-only (decision 3 in §7)
  if (!isAdmin) {
    return NextResponse.json({
      data: {
        vendor: {
          id: vendor.id,
          business_name: vendor.business_name,
          trade: vendor.trade,
          contact_name: vendor.contact_name,
        },
        locations: locations.map((vl) => ({
          id: vl.id,
          location_id: vl.location_id,
          location_name: vl.location_name,
          status: vl.status,
          flags_json: vl.flags_json ? JSON.stringify(vl.flags_json) : null,
        })),
        documents: documents.map((d) => ({
          id: d.id,
          doc_type: d.doc_type,
          uploaded_at: d.uploaded_at,
        })),
        role: auth.role,
      },
    });
  }

  // Admin view: full workbench — latest verification run + evaluations + advisories
  const latestRun = await tdb.get<VerificationRunRow>(
    `SELECT id, trigger, recommendation, created_at
     FROM verification_runs
     WHERE tenant_id = $1 AND vendor_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [vendorId]
  );

  let verificationRun: (VerificationRunRow & { evaluations: EvaluationRow[]; advisories: (Omit<AdvisoryRow, 'evidence_json'> & { evidence_json: string })[] }) | null = null;

  if (latestRun) {
    const evaluations = await tdb.all<EvaluationRow>(
      `SELECT id, location_id, requirement_key, required_value, extracted_value_ref,
              comparison_result, confidence_band, outcome, note
       FROM requirement_evaluations
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY location_id, requirement_key`,
      [latestRun.id]
    );

    const advisories = await tdb.all<AdvisoryRow>(
      `SELECT id, key, severity, message, evidence_json
       FROM engine_advisories
       WHERE tenant_id = $1 AND verification_run_id = $2
       ORDER BY severity DESC, key`,
      [latestRun.id]
    );

    verificationRun = {
      ...latestRun,
      evaluations,
      advisories: advisories.map((a) => ({ ...a, evidence_json: JSON.stringify(a.evidence_json) })),
    };
  }

  // Compliance grid (Gate 2, Stage 1) — a READ-TIME recompute over the stored extraction
  // bundle + resolved requirements matrix, using the same pure rules-engine function the
  // worker/rules-only-reeval path already runs. No Vision call, no writes: requirement_evaluations
  // stays the point-in-time exceptions record, untouched. Gated on a completed run existing —
  // same "under_review + no run yet ⇒ in progress" signal the page already uses, so the grid
  // never renders against a submission that hasn't finished background verification.
  const grid: ComplianceGrid | null = latestRun
    ? await computeComplianceGrid(
        db,
        tenantId,
        vendorId,
        vendor.trade,
        locations.map((l) => ({ location_id: l.location_id, location_name: l.location_name }))
      )
    : null;

  // Activity (Zone 5) — the vendor's audit trail, newest first. Read-only; reuses the same
  // audit_events shape scopeAuditEvents() (src/lib/exports/audit-export.ts) queries for exports,
  // scoped here to this vendor's target_id under this route's existing tenant/role clamp.
  // actor_name resolves user-authored events to a display name; system/ai/vendor actors have
  // no users row so actor_name stays null and the UI falls back to a role label.
  //
  // TIMELINE_EXCLUDED_EVENT_TYPES filters passive-read noise (a page open logs vendor.viewed
  // every time) OUT of this in-page view only — the write path and the audit export both still
  // record/emit it. scopeAuditEvents() is untouched, so a full audit export for this vendor
  // still contains every vendor.viewed row.
  const activity = await tdb.all<AuditEventRow>(
    `SELECT ae.id, ae.created_at, ae.actor_type, ae.actor_id, u.name AS actor_name,
            ae.event_type, ae.payload_json
     FROM audit_events ae
     LEFT JOIN users u ON u.id = ae.actor_id AND u.tenant_id = ae.tenant_id
     WHERE ae.tenant_id = $1 AND ae.target_id = $2
       AND ae.event_type <> ALL($3::text[])
     ORDER BY ae.created_at DESC`,
    [vendorId, TIMELINE_EXCLUDED_EVENT_TYPES]
  );

  return NextResponse.json({
    data: {
      vendor: {
        id: vendor.id,
        business_name: vendor.business_name,
        trade: vendor.trade,
        contact_name: vendor.contact_name,
        contact_email: vendor.contact_email,
        contact_phone: vendor.contact_phone,
      },
      locations: locations.map((vl) => ({
        id: vl.id,
        location_id: vl.location_id,
        location_name: vl.location_name,
        status: vl.status,
        flags_json: vl.flags_json ? JSON.stringify(vl.flags_json) : null,
        decided_by: decidedByName(vl),
        decided_at: vl.status === 'approved' ? vl.approved_at : vl.status === 'declined' ? vl.declined_at : null,
      })),
      verificationRun,
      grid,
      documents: documents.map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        original_filename: d.original_filename,
        uploaded_at: d.uploaded_at,
      })),
      activity: activity.map((a) => ({
        id: a.id,
        created_at: a.created_at,
        actor_type: a.actor_type,
        actor_id: a.actor_id,
        actor_name: a.actor_name,
        event_type: a.event_type,
        payload: a.payload_json,
      })),
      role: auth.role,
    },
  });
}
