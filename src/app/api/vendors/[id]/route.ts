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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  approved_by: string | null;
  approved_at: string | null;
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

  // Load per-location statuses with location names
  const allLocations = await tdb.all<VendorLocationRow>(
    `SELECT vl.id, vl.location_id, l.name AS location_name, vl.status, vl.flags_json,
            vl.approved_by, vl.approved_at
     FROM vendor_locations vl
     JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
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

  // Documents (metadata only — no storage_key, no encryption_json)
  const documents = await tdb.all<DocumentRow>(
    `SELECT id, doc_type, original_filename, uploaded_at
     FROM documents
     WHERE tenant_id = $1 AND vendor_id = $2 AND state = 'active' AND superseded_by IS NULL
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
        approved_by: vl.approved_by,
        approved_at: vl.approved_at,
      })),
      verificationRun,
      documents: documents.map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        original_filename: d.original_filename,
        uploaded_at: d.uploaded_at,
      })),
      role: auth.role,
    },
  });
}
