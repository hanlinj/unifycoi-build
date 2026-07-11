// Shared renewal/expiration chase queries.
//
// The COI expiration date is not persisted on a row — it lives in the Phase 7 renewal
// notification payloads (expiration_date + scheduled_for), maintained by supersession
// (canceled on renewal). This module is the SINGLE definition of "the chase rows for a
// vendor," consumed by both the Command Center taxonomy (Slice A) and the day-0 expired
// flip worker (Slice E), so the two never drift.
//
// Phase 13 migration, Stage 5 (hard dependency of location-record.ts/manager-home.ts): a NEW
// finding, not caught by the Stage 0 investigation (which checked DDL for JSON1 functions but
// not application SELECT queries) — SQLite's json_extract() has no Postgres equivalent at all.
// payload_json is a native jsonb column now, so this rewrites to Postgres's ->> operator
// (extract as text) directly.
//
// ->> always extracts as TEXT — MIN()/ordering over the raw extracted text is a lexicographic
// string comparison, not a chronological one. That's only safe if every stored value is a
// fixed-width, zero-padded ISO-8601 string (a data-shape assumption, not something the query
// enforces). expiration_date values here can be DATE-ONLY ("2026-07-15", no time component) —
// that's not an edge case, it's the common case: COI certificates state a bare expiration date,
// and src/lib/time/zone.ts's expiryBoundaryMs() specifically detects that exact shape
// (`/^\d{4}-\d{2}-\d{2}$/`) to do tenant-timezone-aware day-boundary math (OPS-7) instead of
// treating it as a UTC instant. So the fix here must NOT rewrite/reformat expiration_date's text
// on the way out — an earlier version of this fix ran every row through `to_char(...::timestamptz
// AT TIME ZONE 'UTC', ...)`, which silently turned every date-only value into a full
// "...T00:00:00.000Z" timestamp and broke that downstream detection (caught in pre-commit
// review, not by a test — see the timezone-tile test in chaseExpiryByVendor's coverage). Instead:
// chaseExpiryByVendor uses `DISTINCT ON` ordered by a ::timestamptz cast to pick the
// chronologically-earliest ROW per vendor and returns that row's ORIGINAL, unmodified text — the
// cast drives the comparison only, never the output. findChaseRows doesn't order or aggregate
// over expiration_date at all (it orders by the real `scheduled_for` column), so it needs no
// cast there either — it stays a plain ->> passthrough. vendorExpiry's client-side "earliest of
// these rows" reduction compares via Date.parse() instead of raw string `<`, which correctly
// orders a date-only value against a full-timestamp one without needing either to be rewritten.
// days_before IS cast to ::int — that's an isolated type fix (its TS type was already `number`,
// but the uncast ->> was silently handing back a string at runtime) with no text-format stakes.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

// Payload `type` values that represent an active chase against a COI. 'renewal_reminder'
// is the Phase 7 ladder; 'coi_expiration' is the Slice E day-0 flip job (added here now so
// both slices share one definition even before Slice E lands).
export const CHASE_PAYLOAD_TYPES = ['renewal_reminder', 'coi_expiration'] as const;

const TYPE_LIST = CHASE_PAYLOAD_TYPES.map((t) => `'${t}'`).join(', ');

export interface ChaseRow {
  id: string;
  vendor_id: string | null;
  document_id: string | null;
  scheduled_for: string | null;
  expiration_date: string | null;
  days_before: number | null;
  payload_type: string;
}

/**
 * The unfired (status='queued') chase rows for one vendor. Used by Slice E to target the
 * day-0 flip, and available for per-vendor expiry lookups.
 */
export async function findChaseRows(
  db: Db,
  tenantId: string,
  vendorId: string
): Promise<ChaseRow[]> {
  const tdb = new TenantDB(db, tenantId);
  return tdb.all<ChaseRow>(
    `SELECT id,
            payload_json->>'vendor_id'       AS vendor_id,
            document_id,
            scheduled_for,
            payload_json->>'expiration_date' AS expiration_date,
            (payload_json->>'days_before')::int AS days_before,
            payload_json->>'type'            AS payload_type
     FROM notifications
     WHERE tenant_id = $1 AND status = 'queued'
       AND payload_json->>'type' IN (${TYPE_LIST})
       AND payload_json->>'vendor_id' = $2
     ORDER BY scheduled_for`,
    [vendorId]
  );
}

/** The vendor's current COI expiration = earliest expiration_date among its queued chase rows.
 *  Compares via Date.parse() rather than a raw string `<` — expiration_date can be date-only
 *  ("2026-07-15") or a full timestamp, and a lexicographic string comparison isn't guaranteed
 *  correct across that mix (or against an unpadded value from a non-conforming upstream source);
 *  Date.parse() gives a genuine chronological ordering regardless of which shape a given row is
 *  in, without needing to rewrite the value itself (findChaseRows returns it untouched — see the
 *  DATE_ONLY note above the imports). */
export async function vendorExpiry(db: Db, tenantId: string, vendorId: string): Promise<string | null> {
  const rows = await findChaseRows(db, tenantId, vendorId);
  let earliest: string | null = null;
  let earliestMs: number | null = null;
  for (const r of rows) {
    if (!r.expiration_date) continue;
    const ms = Date.parse(r.expiration_date);
    if (Number.isNaN(ms)) continue;
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
      earliest = r.expiration_date;
    }
  }
  return earliest;
}

/**
 * Tenant-wide map of vendor_id → earliest queued chase expiration. One query for the whole
 * Command Center (vs N per-vendor lookups). `DISTINCT ON (vendor_id)` + `ORDER BY ...
 * (expiration_date)::timestamptz` picks the chronologically-earliest ROW per vendor and returns
 * ITS original expiration_date text untouched — deliberately not `MIN(...)`, which would force
 * choosing between a lexicographic (wrong) comparison or a to_char-reformatted (also wrong: it
 * silently turns a date-only value into a full timestamp, breaking expiryBoundaryMs's
 * DATE_ONLY detection downstream — see the note above the imports) output.
 */
export async function chaseExpiryByVendor(db: Db, tenantId: string): Promise<Map<string, string>> {
  const tdb = new TenantDB(db, tenantId);
  const rows = await tdb.all<{ vendor_id: string | null; exp: string | null }>(
    `SELECT DISTINCT ON (vendor_id) vendor_id, expiration_date AS exp
     FROM (
       SELECT payload_json->>'vendor_id'       AS vendor_id,
              payload_json->>'expiration_date' AS expiration_date
       FROM notifications
       WHERE tenant_id = $1 AND status = 'queued'
         AND payload_json->>'type' IN (${TYPE_LIST})
     ) sub
     WHERE expiration_date IS NOT NULL
     ORDER BY vendor_id, (expiration_date)::timestamptz ASC`
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.vendor_id && r.exp) map.set(r.vendor_id, r.exp);
  }
  return map;
}
