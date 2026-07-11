// Global command-palette search (Search.md v1). Scope-clamped server-side; vendors + locations
// for everyone, users for Admin/District only. Simple name matching behind the swappable
// matcher interfaces. Empty query → the caller's recently-viewed entities (from the audit
// trail's vendor.viewed/location.viewed events) — no parallel tracking table.
//
// Query strings are never logged (Search.md: light standard-access grain, not per-query noise).

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { inClause } from '@/lib/reports';
import { simpleVendorNameMatcher, type VendorNameMatcher } from './vendor-name';
import { simpleLocationNameMatcher, type LocationNameMatcher } from './location-name';

const CAP = 10;
const RECENT = 8;

export interface SearchScope { locationIds: string[] | null }

export interface SearchInput {
  scope: SearchScope;
  role: string;
  actorId: string;
  query: string;
}

export interface SearchResults {
  query: string;
  recent: boolean;
  vendors: { id: string; name: string; trade: string }[];
  locations: { id: string; name: string; region: string | null }[];
  users: { id: string; name: string; email: string; role: string }[];
}

export async function searchEntities(
  db: Db,
  tenantId: string,
  input: SearchInput,
  matchers: { vendor?: VendorNameMatcher; location?: LocationNameMatcher } = {},
  caps: { cap?: number; recent?: number } = {}
): Promise<SearchResults> {
  const vMatch = matchers.vendor ?? simpleVendorNameMatcher;
  const lMatch = matchers.location ?? simpleLocationNameMatcher;
  const cap = caps.cap ?? CAP;
  const q = input.query.trim();
  const tdb = new TenantDB(db, tenantId);
  const scoped = input.scope.locationIds !== null;
  const scopeLocs = input.scope.locationIds ?? [];
  const noScope = scoped && scopeLocs.length === 0; // in scope mode but nothing in scope

  if (q.length === 0) {
    return { query: '', recent: true, ...(await recentlyViewed(db, tenantId, input, caps.recent ?? RECENT)) };
  }

  const vendors = noScope ? [] : (await tdb.all<{ id: string; business_name: string; trade: string }>(
    `SELECT DISTINCT v.id, v.business_name, v.trade
     FROM vendors v ${scoped ? 'JOIN vendor_locations vl ON vl.vendor_id = v.id AND vl.tenant_id = v.tenant_id' : ''}
     WHERE v.tenant_id = $1${scoped ? ` AND vl.location_id IN (${inClause(scopeLocs.length, 2)})` : ''}
     ORDER BY v.business_name`,
    scoped ? scopeLocs : []
  )).filter((r) => vMatch.matches(r.business_name, q)).slice(0, cap).map((r) => ({ id: r.id, name: r.business_name, trade: r.trade }));

  const locations = noScope ? [] : (await tdb.all<{ id: string; name: string; region_name: string | null }>(
    `SELECT l.id, l.name, r.name AS region_name FROM locations l LEFT JOIN regions r ON r.id = l.region_id
     WHERE l.tenant_id = $1 AND l.status = 'active'${scoped ? ` AND l.id IN (${inClause(scopeLocs.length, 2)})` : ''}
     ORDER BY l.name`,
    scoped ? scopeLocs : []
  )).filter((r) => lMatch.matches(r.name, q)).slice(0, cap).map((r) => ({ id: r.id, name: r.name, region: r.region_name }));

  const users = (input.role === 'admin' || input.role === 'district_manager')
    ? await searchUsers(db, tenantId, input, q, vMatch, cap)
    : [];

  return { query: q, recent: false, vendors, locations, users };
}

async function searchUsers(db: Db, tenantId: string, input: SearchInput, q: string, matcher: VendorNameMatcher, cap: number): Promise<SearchResults['users']> {
  const tdb = new TenantDB(db, tenantId);
  const all = await tdb.all<{ id: string; name: string; email: string; role: string }>(
    `SELECT id, name, email, role FROM users WHERE tenant_id = $1 AND status != 'disabled' ORDER BY name`
  );
  let candidates = all;
  if (input.role === 'district_manager' && input.scope.locationIds !== null) {
    const inScope = new Set(input.scope.locationIds);
    const filtered: typeof all = [];
    for (const u of all) {
      if (u.role === 'admin') continue; // a District never manages/sees an Admin
      const locs = (await tdb.all<{ location_id: string }>('SELECT location_id FROM user_locations WHERE tenant_id = $1 AND user_id = $2', [u.id])).map((r) => r.location_id);
      const regionLocs = (await tdb.all<{ id: string }>(
        `SELECT l.id FROM user_regions ur JOIN locations l ON l.region_id = ur.region_id AND l.tenant_id = ur.tenant_id WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
        [u.id]
      )).map((r) => r.id);
      const targets = [...locs, ...regionLocs];
      if (targets.length > 0 && targets.every((l) => inScope.has(l))) filtered.push(u);
    }
    candidates = filtered;
  }
  return candidates.filter((u) => matcher.matches(u.name, q) || matcher.matches(u.email, q)).slice(0, cap)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
}

/** The caller's recently-viewed vendors/locations, newest-first, scope-clamped + deduped. */
async function recentlyViewed(db: Db, tenantId: string, input: SearchInput, n: number): Promise<Pick<SearchResults, 'vendors' | 'locations' | 'users'>> {
  const tdb = new TenantDB(db, tenantId);
  const scoped = input.scope.locationIds !== null;
  const scopeLocs = new Set(input.scope.locationIds ?? []);

  // rowid has no Postgres equivalent (invariant, flagged since the Stage 8 pre-kickoff scoping
  // trace) — audit_events.seq (bigserial, added in the baseline specifically for this) is the
  // insertion-order tiebreaker: two events can share a created_at millisecond, and seq is the
  // only reliable monotonic ordering left once rowid is gone.
  const events = await tdb.all<{ event_type: string; target_id: string }>(
    `SELECT event_type, target_id FROM audit_events
     WHERE tenant_id = $1 AND actor_id = $2 AND event_type IN ('vendor.viewed','location.viewed')
     ORDER BY created_at DESC, seq DESC`,
    [input.actorId]
  );

  const vendors: SearchResults['vendors'] = [];
  const locations: SearchResults['locations'] = [];
  const seenV = new Set<string>(), seenL = new Set<string>();

  const vendorInScope = async (vid: string): Promise<boolean> => {
    if (!scoped) return true;
    const locs = (await tdb.all<{ location_id: string }>('SELECT location_id FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2', [vid])).map((r) => r.location_id);
    return locs.some((l) => scopeLocs.has(l));
  };

  for (const e of events) {
    if (e.event_type === 'vendor.viewed' && vendors.length < n && !seenV.has(e.target_id)) {
      seenV.add(e.target_id);
      const v = await tdb.get<{ id: string; business_name: string; trade: string }>('SELECT id, business_name, trade FROM vendors WHERE tenant_id = $1 AND id = $2', [e.target_id]);
      if (v && (await vendorInScope(v.id))) vendors.push({ id: v.id, name: v.business_name, trade: v.trade });
    } else if (e.event_type === 'location.viewed' && locations.length < n && !seenL.has(e.target_id)) {
      seenL.add(e.target_id);
      const inScope = !scoped || scopeLocs.has(e.target_id);
      const l = await tdb.get<{ id: string; name: string; region_name: string | null }>(
        `SELECT l.id, l.name, r.name AS region_name FROM locations l LEFT JOIN regions r ON r.id = l.region_id WHERE l.tenant_id = $1 AND l.id = $2 AND l.status = 'active'`,
        [e.target_id]
      );
      if (l && inScope) locations.push({ id: l.id, name: l.name, region: l.region_name });
    }
  }

  return { vendors, locations, users: [] };
}
