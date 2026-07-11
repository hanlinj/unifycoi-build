// Reports & Analytics — fixed catalog of six reports (Reports_and_Analytics.md).
//
// Admin (org) + District (region-scoped). Store Managers have no Reports access. Sensitive
// data never appears in any report. Each report is a pure read builder; the registry maps a
// slug → builder. The same builders back the on-demand views (Slice B) and PDF/CSV export (C).

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

export type ReportKey =
  | 'compliance-posture'
  | 'renewal-forecast'
  | 'vendor-roster'
  | 'onboarding-funnel'
  | 'deficiency-analysis'
  | 'audit-readiness';

export interface ReportMeta {
  key: ReportKey;
  name: string;
  question: string;
}

export const REPORTS: ReportMeta[] = [
  { key: 'compliance-posture', name: 'Compliance Posture Over Time', question: 'Is our compliance trajectory improving or declining?' },
  { key: 'renewal-forecast', name: 'Expiration & Renewal Forecast', question: "What's coming due, and when?" },
  { key: 'vendor-roster', name: 'Vendor Roster & Coverage', question: 'Who do we have, where, with what coverage?' },
  { key: 'onboarding-funnel', name: 'Onboarding Throughput & Funnel', question: 'How efficiently is onboarding flowing, and where does it stall?' },
  { key: 'deficiency-analysis', name: 'Deficiency & Exception Analysis', question: 'Why do submissions fail, and is it systemic?' },
  { key: 'audit-readiness', name: 'Audit-Readiness Summary', question: 'Can we show our compliance health at a glance?' },
];

export function reportMeta(key: string): ReportMeta | undefined {
  return REPORTS.find((r) => r.key === key);
}

export interface ReportScope {
  locationIds: string[] | null; // null = org-wide (admin); [] = nothing in scope
}

export interface ReportFilters {
  region?: string | null;
  location?: string | null;
  trade?: string | null;
  from?: string | null; // ISO date (inclusive)
  to?: string | null;   // ISO date (inclusive)
}

export interface ReportResult {
  meta: ReportMeta;
  generatedAt: string;
  filters: ReportFilters;
  /** Report-specific payload (see each builder). */
  data: unknown;
}

// ── Scope/filter resolution ────────────────────────────────────────────────────────

/**
 * The effective location set for a report run: the caller's scope ∩ region filter ∩ location
 * filter. Returns null only for an Admin with no region/location filter (org-wide). An empty
 * array means "nothing in scope" (e.g. a District filtering to a region they don't own).
 */
export async function effectiveLocationIds(
  db: Db,
  tenantId: string,
  scope: ReportScope,
  filters: ReportFilters
): Promise<string[] | null> {
  const tdb = new TenantDB(db, tenantId);
  let ids = scope.locationIds; // null = all

  if (filters.region) {
    const regionLocs = (await tdb
      .all<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1 AND region_id = $2', [filters.region]))
      .map((r) => r.id);
    ids = ids === null ? regionLocs : ids.filter((id) => regionLocs.includes(id));
  }

  if (filters.location) {
    ids = ids === null ? [filters.location] : ids.filter((id) => id === filters.location);
  }

  return ids;
}

/** Concrete list of in-scope vendor ids (resolves the null=org case to all tenant vendors). */
export async function vendorIdsInScope(db: Db, tenantId: string, effLocationIds: string[] | null): Promise<string[]> {
  const tdb = new TenantDB(db, tenantId);
  if (effLocationIds === null) {
    return (await tdb.all<{ id: string }>('SELECT id FROM vendors WHERE tenant_id = $1')).map((r) => r.id);
  }
  if (effLocationIds.length === 0) return [];
  const ph = inClause(effLocationIds.length, 2);
  return (await tdb
    .all<{ vendor_id: string }>(
      `SELECT DISTINCT vendor_id FROM vendor_locations WHERE tenant_id = $1 AND location_id IN (${ph})`,
      effLocationIds
    ))
    .map((r) => r.vendor_id);
}

/**
 * Postgres-parameterized IN(...) placeholder list, `$<startAt>, $<startAt+1>, ...`. Phase 13
 * migration, Stage 9: this is the real fix — SQLite's `?`-only version forced Stage 8c's
 * `exports/content.ts` and `exports/audit-export.ts` to each carry their own narrow local
 * `inClausePg` shim rather than touch this not-yet-converted file early (see ADR-013-01 Stage
 * 8c). Converting this file retires both shims — search.ts's own `inClause` import now gets
 * the real, correct version too, in the same motion, no separate fix needed there.
 */
export function inClause(count: number, startAt: number = 1): string {
  return Array.from({ length: count }, (_, i) => `$${startAt + i}`).join(', ');
}
