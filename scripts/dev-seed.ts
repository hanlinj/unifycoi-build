/**
 * dev-seed.ts — one-time fictional tenant for manual UI click-through. DEV ONLY.
 *
 *   npm run seed:dev
 *
 * Creates "Cascade Storage Partners" with a platform user, three tenant users (admin/district/
 * store), two regions, four locations, a layered requirement matrix, and a spread of vendors
 * that light up every Command Center tier. Idempotent: if the tenant already exists, every row
 * for it (and the platform user) is wiped and reseeded clean.
 *
 * Writes to the SAME database the dev server uses (DATABASE_URL from .env). Runs any pending
 * migrations first, so it works on a fresh DB too.
 *
 * REFUSES to run when NODE_ENV=production.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { getDb, closeDb, type Db } from '../src/lib/db/client';
import { withTransaction } from '../src/lib/db/transaction';
import { hashPassword } from '../src/lib/auth/password';
import { generateInviteToken } from '../src/lib/auth/invite-token';

// ── Production guard (fail fast, loud) ──────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('\n🛑 dev-seed REFUSES to run with NODE_ENV=production. Aborting.\n');
  process.exit(1);
}

const TENANT_NAME = 'Cascade Storage Partners';
const PW = 'Pass123!';
const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const now = Date.now();
const nowDate = () => new Date(now);
const inDays = (d: number) => new Date(now + d * 86_400_000);
const dateInDays = (d: number) => inDays(d).toISOString().slice(0, 10); // YYYY-MM-DD (COI expiry)

// ── Idempotent wipe — children before parents (Postgres FKs are RESTRICT, not CASCADE) ──
// Wrapped in one transaction: a failure partway through (e.g. a table added later whose FK
// isn't yet listed here) must roll back entirely, not leave a half-wiped tenant — each
// deleteFrom() below commits independently otherwise, so a mid-wipe error previously left
// child tables (documents, vendor_locations, ...) empty while `vendors` itself survived.
async function wipeExisting(db: Db, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const CHILD_TO_PARENT_ORDER = [
    'verification_jobs', 'engine_advisories', 'requirement_evaluations', 'verification_runs',
    'extractions', 'notifications', 'audit_exports', 'invites', 'documents', 'vendor_locations',
    'vendors', 'requirement_rules', 'requirement_settings', 'user_locations', 'user_regions',
    'audit_events', 'billing_snapshots', 'password_reset_tokens', 'users', 'locations', 'regions',
  ] as const;
  await withTransaction(db, async (trx) => {
    for (const table of CHILD_TO_PARENT_ORDER) {
      await trx.deleteFrom(table).where('tenant_id', 'in', tenantIds).execute();
    }
    await trx.deleteFrom('tenants').where('id', 'in', tenantIds).execute();
    await trx.deleteFrom('platform_users').where('email', '=', 'platform@cascade.test').execute();
  });
  console.log(`  wiped existing "${TENANT_NAME}" (${tenantIds.length} tenant row(s))`);
}

// ── Insert helpers ────────────────────────────────────────────────────────────────────
let TENANT = '';

async function platformUser(db: Db, email: string, name: string): Promise<void> {
  await db.insertInto('platform_users').values({
    id: randomUUID(), email, name, role: 'owner', password_hash: hashPassword(PW), created_at: nowDate(),
  }).execute();
}
async function tenantUser(db: Db, email: string, name: string, role: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('users').values({
    id, tenant_id: TENANT, email, name, role, password_hash: hashPassword(PW), status: 'active', created_at: nowDate(),
  }).execute();
  return id;
}
async function region(db: Db, name: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('regions').values({ id, tenant_id: TENANT, name }).execute();
  return id;
}
async function location(db: Db, name: string, regionId: string, address: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('locations').values({
    id, tenant_id: TENANT, region_id: regionId, name, address, status: 'active', created_at: nowDate(),
  }).execute();
  return id;
}
const assignRegion = (db: Db, u: string, r: string) => db.insertInto('user_regions').values({ user_id: u, region_id: r, tenant_id: TENANT }).execute();
const assignLocation = (db: Db, u: string, l: string) => db.insertInto('user_locations').values({ user_id: u, location_id: l, tenant_id: TENANT }).execute();

async function reqSettings(db: Db): Promise<void> {
  await db.insertInto('requirement_settings').values({
    tenant_id: TENANT, precedence_policy: 'strictest',
    floor_json: JSON.stringify({ 'doc_required.coi': 'true', 'doc_required.w9': 'true', 'coverage.general_liability.each_occurrence': '1000000' }),
  }).execute();
}
async function rule(db: Db, scope: string, scopeRef: string | null, key: string, value: string, by: string, reason: string): Promise<void> {
  await db.insertInto('requirement_rules').values({
    id: randomUUID(), tenant_id: TENANT, scope_type: scope, scope_ref: scopeRef,
    requirement_key: key, required_value: value, created_by: by, reason, created_at: nowDate(),
  }).execute();
}

async function vendor(db: Db, name: string, trade: string, email: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('vendors').values({
    id, tenant_id: TENANT, business_name: name, contact_name: 'Pat Vendor', contact_email: email,
    contact_phone: '208-555-0100', trade, created_at: nowDate(),
  }).execute();
  return id;
}
async function vloc(db: Db, vendorId: string, locationId: string, status: string): Promise<void> {
  await db.insertInto('vendor_locations').values({
    id: randomUUID(), tenant_id: TENANT, vendor_id: vendorId, location_id: locationId, status,
    flags_json: null, approved_by: null, approved_at: status === 'approved' ? nowDate() : null, created_at: nowDate(),
  }).execute();
}
async function run(db: Db, vendorId: string, recommendation: string, trigger = 'onboarding'): Promise<string> {
  const id = randomUUID();
  await db.insertInto('verification_runs').values({
    id, tenant_id: TENANT, vendor_id: vendorId, trigger, engine_version: '1', recommendation,
    created_at: new Date(now - 2 * 86_400_000),
  }).execute();
  return id;
}
async function evalRow(db: Db, runId: string, vendorId: string, locationId: string, key: string, required: string, outcome: string, comparison: string, band: string, note: string): Promise<void> {
  await db.insertInto('requirement_evaluations').values({
    id: randomUUID(), tenant_id: TENANT, run_id: runId, vendor_id: vendorId, location_id: locationId,
    requirement_key: key, required_value: required, extracted_value_ref: null,
    comparison_result: comparison, confidence_band: band, outcome, note,
  }).execute();
}
async function doc(db: Db, vendorId: string, docType: string): Promise<void> {
  await db.insertInto('documents').values({
    id: randomUUID(), tenant_id: TENANT, vendor_id: vendorId, doc_type: docType,
    storage_key: `tenants/${TENANT}/vendors/${vendorId}/${randomUUID()}`, encryption_json: '{}',
    original_filename: `${docType}.pdf`, superseded_by: null, state: 'active', uploaded_at: nowDate(),
  }).execute();
}
// Chase row = a queued renewal_reminder whose payload carries the COI expiry. scheduled_for is
// set to the (future) expiry so the running notification worker won't send it (it only sends
// due rows), keeping it queued for the Command Center expiry derivation.
async function chase(db: Db, vendorId: string, email: string, expiryDate: string): Promise<void> {
  await db.insertInto('notifications').values({
    id: randomUUID(), tenant_id: TENANT, recipient_type: 'vendor', recipient_ref: email,
    channel: 'email', kind: 'exception', status: 'queued', scheduled_for: new Date(`${expiryDate}T08:00:00.000Z`),
    sent_at: null, payload_json: JSON.stringify({ type: 'renewal_reminder', vendor_id: vendorId, expiration_date: expiryDate, days_before: 7 }),
    created_at: nowDate(), claimed_at: null, document_id: null,
  }).execute();
}
async function invite(db: Db, vendorId: string, inviterId: string, deliveryState: string): Promise<string> {
  const { rawToken, tokenHash } = generateInviteToken();
  await db.insertInto('invites').values({
    id: randomUUID(), tenant_id: TENANT, vendor_id: vendorId, inviter_user_id: inviterId,
    token: tokenHash, token_expires_at: inDays(14), purpose: 'onboarding', delivery_state: deliveryState, created_at: nowDate(),
  }).execute();
  return rawToken;
}

// ── Seed ────────────────────────────────────────────────────────────────────────────────
async function seed(db: Db): Promise<{ summary: string[]; pendingToken: string }> {
  TENANT = randomUUID();
  await db.insertInto('tenants').values({
    id: TENANT, name: TENANT_NAME, lifecycle_state: 'active', monthly_rate_cents: 9000,
    timezone: 'America/Los_Angeles', created_at: nowDate(),
  }).execute();

  await platformUser(db, 'platform@cascade.test', 'Pat Platform');
  const admin = await tenantUser(db, 'admin@cascade.test', 'Avery Admin', 'admin');
  const district = await tenantUser(db, 'district@cascade.test', 'Dana District', 'district_manager');
  const store = await tenantUser(db, 'store@cascade.test', 'Sam Store', 'store_manager');

  const northIdaho = await region(db, 'North Idaho');
  const spokane = await region(db, 'Spokane Metro');
  const cda = await location(db, "Cascade Storage — Coeur d'Alene", northIdaho, '1450 W Seltice Way, Coeur d\'Alene, ID 83814');
  const postFalls = await location(db, 'Cascade Storage — Post Falls', northIdaho, '305 N Spokane St, Post Falls, ID 83854');
  const spokaneValley = await location(db, 'Cascade Storage — Spokane Valley', spokane, '12100 E Sprague Ave, Spokane Valley, WA 99206');
  const libertyLake = await location(db, 'Cascade Storage — Liberty Lake', spokane, '23801 E Appleway Ave, Liberty Lake, WA 99019');

  await assignRegion(db, district, northIdaho);          // District scoped to North Idaho
  await assignLocation(db, store, cda);                   // Store Manager scoped to Coeur d'Alene

  // Requirement matrix — org base + one trade override + one location override (flagship CDA).
  await reqSettings(db);
  await rule(db, 'org', null, 'coverage.general_liability.each_occurrence', '1000000', admin, 'Org baseline GL');
  await rule(db, 'org', null, 'coverage.general_liability.general_aggregate', '2000000', admin, 'Org baseline GL aggregate');
  await rule(db, 'org', null, 'coverage.automobile_liability.combined_single_limit', '1000000', admin, 'Org baseline auto');
  await rule(db, 'org', null, 'coverage_required.workers_comp', 'true', admin, 'WC required org-wide');
  await rule(db, 'org', null, 'coverage.umbrella.each_occurrence', '2000000', admin, 'Org baseline umbrella');
  await rule(db, 'org', null, 'endorsement.additional_insured', 'true', admin, 'Additional insured required');
  await rule(db, 'org', null, 'doc_required.coi', 'true', admin, 'COI mandatory');
  await rule(db, 'org', null, 'doc_required.w9', 'true', admin, 'W-9 mandatory');
  await rule(db, 'trade', 'electrical', 'coverage.general_liability.each_occurrence', '2000000', admin, 'Electrical is higher-risk — raise GL');
  await rule(db, 'location', cda, 'coverage.general_liability.each_occurrence', '3000000', admin, 'Flagship Coeur d\'Alene — elevated GL');
  await rule(db, 'location', cda, 'coverage.umbrella.each_occurrence', '5000000', admin, 'Flagship Coeur d\'Alene — elevated umbrella');

  const allLocs = [cda, postFalls, spokaneValley, libertyLake];
  const summary: string[] = [];

  // 1 — clean approved everywhere (Tier 3 · on track)
  {
    const v = await vendor(db, 'Summit Mechanical Services', 'hvac', 'dispatch@summitmech.test');
    for (const l of allLocs) await vloc(db, v, l, 'approved');
    await run(db, v, 'approve'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    await chase(db, v, 'dispatch@summitmech.test', dateInDays(280)); // far out → on track
    summary.push('Summit Mechanical Services (hvac) — approved ×4, clean → Tier 3 · On track');
  }
  // 2 — under_review, uncertain (Tier 1 · uncertain) — Clearwater WC-exemption canonical case
  {
    const v = await vendor(db, 'Clearwater Plumbing & Drain', 'plumbing', 'office@clearwaterplumbing.test');
    await vloc(db, v, cda, 'under_review'); await vloc(db, v, postFalls, 'under_review');
    const r = await run(db, v, 'uncertain'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    await evalRow(db, r, v, cda, 'workers_comp_exemption_claimed', 'true', 'uncertain', 'indeterminate', 'low',
      'COI shows no workers comp; vendor may be a sole proprietor claiming exemption — needs a human call.');
    summary.push('Clearwater Plumbing & Drain (plumbing) — under_review, uncertain → Tier 1 · Uncertain');
  }
  // 3 — under_review, deficiencies (Tier 1 · deficiencies, 2 failed)
  {
    const v = await vendor(db, 'Apex Electric Co.', 'electrical', 'billing@apexelectric.test');
    await vloc(db, v, spokaneValley, 'under_review'); await vloc(db, v, libertyLake, 'under_review');
    const r = await run(db, v, 'deficiencies'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    await evalRow(db, r, v, spokaneValley, 'coverage.general_liability.each_occurrence', '2000000', 'deficient', 'fails', 'high',
      'Electrical trade requires $2M GL each-occurrence; COI shows $1M.');
    await evalRow(db, r, v, spokaneValley, 'endorsement.additional_insured', 'true', 'deficient', 'missing', 'high',
      'No additional-insured endorsement found on the COI.');
    summary.push('Apex Electric Co. (electrical) — under_review, 2 deficiencies → Tier 1 · Deficiencies');
  }
  // 4 — approved, COI imminent (≤7d) (Tier 1 · imminent lapse)
  {
    const v = await vendor(db, 'Liberty Lake Landscaping', 'landscaping', 'crew@lllandscaping.test');
    await vloc(db, v, spokaneValley, 'approved'); await vloc(db, v, libertyLake, 'approved');
    await run(db, v, 'approve'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    await chase(db, v, 'crew@lllandscaping.test', dateInDays(6));
    summary.push('Liberty Lake Landscaping (landscaping) — approved, COI expires ~6d → Tier 1 · Imminent lapse');
  }
  // 5 — approved, COI expiring soon (8–60d) (Tier 2 · expiring soon)
  {
    const v = await vendor(db, 'Five-Star Cleaning Crew', 'cleaning', 'ops@fivestarclean.test');
    for (const l of allLocs) await vloc(db, v, l, 'approved');
    await run(db, v, 'approve'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    await chase(db, v, 'ops@fivestarclean.test', dateInDays(21));
    summary.push('Five-Star Cleaning Crew (cleaning) — approved, COI expires ~21d → Tier 2 · Expiring soon');
  }
  // 6 — open invite, delivered, not opened (Tier 3 · pending) — click-through vendor flow
  let pendingToken = '';
  {
    const v = await vendor(db, 'Ridgeline Tree & Pest', 'pest_control', 'hello@ridgelinepest.test');
    await vloc(db, v, cda, 'invited_pending');
    pendingToken = await invite(db, v, admin, 'sent');
    summary.push('Ridgeline Tree & Pest (pest_control) — open invite (not opened) → Tier 3 · Pending  [vendor link below]');
  }
  // 7 — bounced invite (Tier 2 · invite failed / Resend)
  {
    const v = await vendor(db, 'Gate Guard Systems', 'gate_door', 'bademail@gateguard.test');
    await vloc(db, v, postFalls, 'invited_pending');
    await invite(db, v, district, 'bounced');
    summary.push('Gate Guard Systems (gate_door) — invite bounced → Tier 2 · Invite failed (Resend)');
  }
  // 8 — expired coverage (Tier 1 · expired)
  {
    const v = await vendor(db, 'Northwest Paving', 'paving_asphalt', 'jobs@nwpaving.test');
    await vloc(db, v, postFalls, 'expired'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    summary.push('Northwest Paving (paving_asphalt) — coverage expired → Tier 1 · Expired');
  }
  // 9 — non-compliant after a rule change (Tier 1 · non-compliant)
  {
    const v = await vendor(db, 'Iron Gate Security', 'security', 'admin@irongatesec.test');
    await vloc(db, v, spokaneValley, 'non_compliant'); await doc(db, v, 'coi'); await doc(db, v, 'w9');
    const r = await run(db, v, 'deficiencies', 'rule_change');
    await evalRow(db, r, v, spokaneValley, 'coverage.general_liability.each_occurrence', '1000000', 'deficient', 'fails', 'high',
      'GL each-occurrence below the newly tightened org requirement.');
    summary.push('Iron Gate Security (security) — non-compliant (rule change) → Tier 1 · Non-compliant');
  }

  return { summary, pendingToken };
}

function printSummary(tenantId: string, vendorLines: string[], pendingToken: string): void {
  const line = '─'.repeat(78);
  console.log(`\n${line}\n✅ Seeded "${TENANT_NAME}"  (tenant ${tenantId})\n${line}`);
  console.log(`\nSign in at ${BASE}/login   (all passwords: ${PW})`);
  console.log('  • platform@cascade.test   — Platform owner → /platform placeholder');
  console.log('  • admin@cascade.test      — Admin (org-wide) → /command-center');
  console.log('  • district@cascade.test   — District Manager (North Idaho only) → /command-center');
  console.log('  • store@cascade.test      — Store Manager (Coeur d\'Alene only) → /dashboard');
  console.log('\nVendors (Command Center tiers):');
  for (const v of vendorLines) console.log(`  • ${v}`);
  console.log('\nVendor flow (no login) — open the un-opened invite:');
  console.log(`  ${BASE}/v/${pendingToken}`);
  console.log('\nTry these surfaces:');
  console.log('  • /command-center  — exception triage (Tiers 1/2/3)   • /dashboard — who can I hire');
  console.log('  • /settings/requirements — matrix + "preview effective requirements" (electrical × Coeur d\'Alene = $3M GL)');
  console.log('  • /users — user management   • /reports — six reports (CSV/PDF download)   • ⌘K — search');
  console.log('  • Click a Tier-1 vendor → Vendor Record → approve / request correction (correction link prints to this console)');
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  // Run any pending migrations first (same runner as `npm run migrate`), so this works on a
  // fresh DB too — mirrors migrate.ts's own applied-set logic rather than duplicating it here.
  execSync('npx tsx src/lib/db/migrate.ts', { stdio: 'inherit', cwd: process.cwd() });

  const db = getDb();
  try {
    const existing = await db.selectFrom('tenants').select('id').where('name', '=', TENANT_NAME).execute();
    await wipeExisting(db, existing.map((r) => r.id));

    const { summary, pendingToken } = await withTransaction(db, (trx) => seed(trx));
    printSummary(TENANT, summary, pendingToken);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
