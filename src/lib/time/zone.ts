// One timezone treatment for the whole codebase, built on Intl.DateTimeFormat — the same
// primitive the digest cadence uses. Null / empty / invalid IANA zone → UTC, matching the
// digest's documented fallback (Notifications_and_Communications: a tenant with no timezone
// falls back to UTC). No new dependency, no second tz approach.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True if `tz` is a valid IANA timezone (e.g. 'America/Chicago'). Used to validate the
 *  required tenant timezone at provisioning (OPS-7 input). Same Intl basis as the rest. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local hour (0–23) at `now` in an IANA zone. (Home of the digest cadence's helper; digest.ts re-exports it.) */
export function localHourInZone(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  // 'en-US' h23-ish formatting can yield '24' at midnight — normalize to 0–23.
  return parseInt(formatted, 10) % 24;
}

/** ms offset (local wall clock − UTC) for `date` observed in `tz`. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = parseInt(p.value, 10);
  const hour = m.hour === 24 ? 0 : m.hour; // en-US can emit 24 at midnight
  const asIfUtc = Date.UTC(m.year, m.month - 1, m.day, hour, m.minute, m.second);
  return asIfUtc - date.getTime();
}

/** UTC ms of 00:00 local on Y-M-D in `tz`. Two-step so a DST transition near midnight resolves. */
function zonedDayStartMs(y: number, mo: number, d: number, tz: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const guess = asUtc - tzOffsetMs(new Date(asUtc), tz);
  return asUtc - tzOffsetMs(new Date(guess), tz);
}

/**
 * The UTC instant (ms) of a COI's coverage boundary, resolved in the TENANT's timezone (OPS-7).
 *
 * Semantics: **start of the expiration day, tenant-local** — the spec's "Expired the moment the
 * date passes / safest compliance posture" (Renewal_and_Expiration_Chase). A date-only expiry
 * ('2027-01-01') anchors to 00:00 tenant-local; a full-ISO expiry (with an explicit time/offset)
 * is an unambiguous instant and is honored as-is (so it is a NO-OP relative to Date.parse). A
 * UTC (or null → UTC) tenant with a date-only expiry is byte-identical to `Date.parse(expiry)`.
 *
 * Null/invalid tz → UTC. Returns NaN for an unparseable expiry (callers already guard on NaN).
 */
export function expiryBoundaryMs(expirationDate: string, tz: string | null): number {
  const zone = tz && tz.trim() ? tz : 'UTC';
  if (DATE_ONLY.test(expirationDate)) {
    const [y, mo, d] = expirationDate.split('-').map((s) => parseInt(s, 10));
    try {
      return zonedDayStartMs(y, mo, d, zone);
    } catch {
      return zonedDayStartMs(y, mo, d, 'UTC'); // invalid IANA zone → UTC
    }
  }
  // Explicit time/offset present → the instant is unambiguous; honor it (no reinterpretation).
  return Date.parse(expirationDate);
}

/**
 * UTC ms of 00:00 tenant-local on day 1 of the tenant-local calendar month containing `nowMs`
 * (OPS-7 sibling for month-grain boundaries — e.g. Command Center's "new this month" stat).
 * Same Intl-derived, two-step DST-safe resolution as expiryBoundaryMs/zonedDayStartMs — never
 * casts a stored value to timestamptz and reformats it back to text (the trap documented in
 * docs/decisions.md); this only ever computes a boundary from the current instant.
 * Null/invalid tz → UTC.
 */
export function monthStartMs(nowMs: number, tz: string | null): number {
  const zone = tz && tz.trim() ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(nowMs));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = parseInt(p.value, 10);
  try {
    return zonedDayStartMs(m.year, m.month, 1, zone);
  } catch {
    return zonedDayStartMs(m.year, m.month, 1, 'UTC'); // invalid IANA zone → UTC
  }
}
