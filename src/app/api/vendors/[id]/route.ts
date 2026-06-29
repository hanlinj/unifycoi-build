// GET /api/vendors/:id
// Vendor Record — role-conditional response.
// Admin: full workbench (evaluations, advisories, decision surface).
// Manager (district/store): status-only per invariant §7 decision 3.
// Sensitive fields (TIN, ACH account/routing) are masked server-side for non-Admin (invariant #8).

import { NextResponse } from 'next/server';
import { getRawDb } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { requireTenantAuth, isResponse, forbidden, notFound } from '@/lib/api';

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
  flags_json: string | null;
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
  evidence_json: string;
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
  const db = getRawDb();
  const tdb = new TenantDB(db, tenantId);

  // Load vendor
  const vendor = tdb.get<VendorRow>(
    `SELECT id, business_name, trade, contact_name, contact_email, contact_phone
     FROM vendors WHERE tenant_id = ? AND id = ?`,
    [vendorId]
  );
  if (!vendor) return notFound('Vendor not found');

  // Load per-location statuses with location names
  const locations = tdb.all<VendorLocationRow>(
    `SELECT vl.id, vl.location_id, l.name AS location_name, vl.status, vl.flags_json,
            vl.approved_by, vl.approved_at
     FROM vendor_locations vl
     JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = ? AND vl.vendor_id = ?
     ORDER BY l.name`,
    [vendorId]
  );

  // Documents (metadata only — no storage_key, no encryption_json)
  const documents = tdb.all<DocumentRow>(
    `SELECT id, doc_type, original_filename, uploaded_at
     FROM documents
     WHERE tenant_id = ? AND vendor_id = ? AND state = 'active' AND superseded_by IS NULL
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
          flags_json: vl.flags_json,
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
  const latestRun = tdb.get<VerificationRunRow>(
    `SELECT id, trigger, recommendation, created_at
     FROM verification_runs
     WHERE tenant_id = ? AND vendor_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [vendorId]
  );

  let verificationRun: (VerificationRunRow & { evaluations: EvaluationRow[]; advisories: AdvisoryRow[] }) | null = null;

  if (latestRun) {
    const evaluations = tdb.all<EvaluationRow>(
      `SELECT id, location_id, requirement_key, required_value, extracted_value_ref,
              comparison_result, confidence_band, outcome, note
       FROM requirement_evaluations
       WHERE tenant_id = ? AND run_id = ?
       ORDER BY location_id, requirement_key`,
      [latestRun.id]
    );

    const advisories = tdb.all<AdvisoryRow>(
      `SELECT id, key, severity, message, evidence_json
       FROM engine_advisories
       WHERE tenant_id = ? AND verification_run_id = ?
       ORDER BY severity DESC, key`,
      [latestRun.id]
    );

    verificationRun = { ...latestRun, evaluations, advisories };
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
        flags_json: vl.flags_json,
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
