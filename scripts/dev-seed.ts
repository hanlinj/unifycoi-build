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
 * Writes to the SAME database the dev server uses (SQLITE_PATH from .env). Runs any pending
 * migrations first, so it works on a fresh DB too.
 *
 * REFUSES to run when NODE_ENV=production.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getRawDb } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/password';
import { hashInviteToken, generateInviteToken } from '@/lib/auth/invite-token';

// ── Production guard (fail fast, loud) ──────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('\n🛑 dev-seed REFUSES to run with NODE_ENV=production. Aborting.\n');
  process.exit(1);
}

const TENANT_NAME = 'Cascade Storage Partners';
const PW = 'Pass123!';
const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const now = Date.now();
const iso = (ms: number = now) => new Date(ms).toISOString();
const inDays = (d: number) => iso(now + d * 86_400_000);
const dateInDays = (d: number) => inDays(d).slice(0, 10); // YYYY-MM-DD (COI expiry)

const db = getRawDb();
db.pragma('foreign_keys = ON');

// ── Run pending migrations (applied-set logic mirrors migrate.ts; safe on fresh or migrated) ──
function migrate(): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, iso());
    })();
    console.log(`  applied migration ${f}`);
  }
}

// ── Idempotent wipe ─────────────────────────────────────────────────────────────────────
function wipeExisting(): void {
  // .all (not .get): clean up any duplicates too. Every table below carries tenant_id; the
  // tenants row itself is keyed by id (no tenant_id column) so it's deleted separately.
  const matches = db.prepare('SELECT id FROM tenants WHERE name = ?').all(TENANT_NAME) as { id: string }[];
  if (matches.length === 0) return;
  const tenantScoped = [
    'requirement_evaluations', 'verification_runs', 'notifications', 'engine_advisories',
    'extractions', 'documents', 'invites', 'vendor_locations', 'vendors',
    'requirement_rules', 'requirement_settings', 'user_locations', 'user_regions',
    'audit_events', 'billing_snapshots', 'audit_exports', 'users', 'locations', 'regions',
  ];
  db.pragma('foreign_keys = OFF'); // dev-only bulk wipe; order-independent
  const wipe = db.transaction(() => {
    for (const { id } of matches) {
      for (const t of tenantScoped) db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(id);
      db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM platform_users WHERE email = ?').run('platform@cascade.test');
  });
  wipe();
  db.pragma('foreign_keys = ON');
  console.log(`  wiped existing "${TENANT_NAME}" (${matches.length} tenant row(s))`);
}

// ── Insert helpers ────────────────────────────────────────────────────────────────────
let TENANT = '';
function platformUser(email: string, name: string): void {
  db.prepare('INSERT INTO platform_users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), email, name, 'owner', hashPassword(PW), iso());
}
function tenantUser(email: string, name: string, role: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, TENANT, email, name, role, hashPassword(PW), 'active', iso());
  return id;
}
function region(name: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO regions (id, tenant_id, name) VALUES (?,?,?)').run(id, TENANT, name);
  return id;
}
function location(name: string, regionId: string, address: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO locations (id, tenant_id, region_id, name, address, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, TENANT, regionId, name, address, 'active', iso());
  return id;
}
const assignRegion = (u: string, r: string) => db.prepare('INSERT INTO user_regions (user_id, region_id, tenant_id) VALUES (?,?,?)').run(u, r, TENANT);
const assignLocation = (u: string, l: string) => db.prepare('INSERT INTO user_locations (user_id, location_id, tenant_id) VALUES (?,?,?)').run(u, l, TENANT);

function reqSettings(): void {
  db.prepare('INSERT OR REPLACE INTO requirement_settings (tenant_id, precedence_policy, floor_json) VALUES (?,?,?)')
    .run(TENANT, 'strictest', JSON.stringify({ 'doc_required.coi': 'true', 'doc_required.w9': 'true', 'coverage.general_liability.each_occurrence': '1000000' }));
}
function rule(scope: string, scopeRef: string | null, key: string, value: string, by: string, reason: string): void {
  db.prepare('INSERT INTO requirement_rules (id, tenant_id, scope_type, scope_ref, requirement_key, required_value, created_by, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, scope, scopeRef, key, value, by, reason, iso());
}

function vendor(name: string, trade: string, email: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO vendors (id, tenant_id, business_name, contact_name, contact_email, contact_phone, trade, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, TENANT, name, 'Pat Vendor', email, '208-555-0100', trade, iso());
  return id;
}
function vloc(vendorId: string, locationId: string, status: string): void {
  db.prepare('INSERT INTO vendor_locations (id, tenant_id, vendor_id, location_id, status, flags_json, approved_by, approved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, vendorId, locationId, status, null, null, status === 'approved' ? iso() : null, iso());
}
function run(vendorId: string, recommendation: string, trigger = 'onboarding'): string {
  const id = randomUUID();
  db.prepare('INSERT INTO verification_runs (id, tenant_id, vendor_id, trigger, engine_version, recommendation, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, TENANT, vendorId, trigger, '1', recommendation, iso(now - 2 * 86_400_000));
  return id;
}
function evalRow(runId: string, vendorId: string, locationId: string, key: string, required: string, outcome: string, comparison: string, band: string, note: string): void {
  db.prepare('INSERT INTO requirement_evaluations (id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref, comparison_result, confidence_band, outcome, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, runId, vendorId, locationId, key, required, null, comparison, band, outcome, note);
}
function doc(vendorId: string, docType: string): void {
  db.prepare('INSERT INTO documents (id, tenant_id, vendor_id, doc_type, storage_key, encryption_json, original_filename, superseded_by, state, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, vendorId, docType, `tenants/${TENANT}/vendors/${vendorId}/${randomUUID()}`, '{}', `${docType}.pdf`, null, 'active', iso());
}
// Chase row = a queued renewal_reminder whose payload carries the COI expiry. scheduled_for is
// set to the (future) expiry so the running notification worker won't send it (it only sends
// due rows), keeping it queued for the Command Center expiry derivation.
function chase(vendorId: string, email: string, expiryDate: string): void {
  db.prepare('INSERT INTO notifications (id, tenant_id, recipient_type, recipient_ref, channel, kind, status, scheduled_for, sent_at, payload_json, created_at, claimed_at, document_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, 'vendor', email, 'email', 'exception', 'queued', `${expiryDate}T08:00:00.000Z`, null,
      JSON.stringify({ type: 'renewal_reminder', vendor_id: vendorId, expiration_date: expiryDate, days_before: 7 }), iso(), null, null);
}
function invite(vendorId: string, inviterId: string, deliveryState: string): string {
  const { rawToken, tokenHash } = generateInviteToken();
  db.prepare('INSERT INTO invites (id, tenant_id, vendor_id, inviter_user_id, token, token_expires_at, purpose, delivery_state, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), TENANT, vendorId, inviterId, tokenHash, inDays(14), 'onboarding', deliveryState, iso());
  return rawToken;
}

// ── Seed ────────────────────────────────────────────────────────────────────────────────
function seed(): void {
  TENANT = randomUUID();
  db.prepare('INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, timezone, created_at) VALUES (?,?,?,?,?,?)')
    .run(TENANT, TENANT_NAME, 'active', 9000, 'America/Los_Angeles', iso());

  platformUser('platform@cascade.test', 'Pat Platform');
  const admin = tenantUser('admin@cascade.test', 'Avery Admin', 'admin');
  const district = tenantUser('district@cascade.test', 'Dana District', 'district_manager');
  const store = tenantUser('store@cascade.test', 'Sam Store', 'store_manager');

  const northIdaho = region('North Idaho');
  const spokane = region('Spokane Metro');
  const cda = location("Cascade Storage — Coeur d'Alene", northIdaho, '1450 W Seltice Way, Coeur d\'Alene, ID 83814');
  const postFalls = location('Cascade Storage — Post Falls', northIdaho, '305 N Spokane St, Post Falls, ID 83854');
  const spokaneValley = location('Cascade Storage — Spokane Valley', spokane, '12100 E Sprague Ave, Spokane Valley, WA 99206');
  const libertyLake = location('Cascade Storage — Liberty Lake', spokane, '23801 E Appleway Ave, Liberty Lake, WA 99019');

  assignRegion(district, northIdaho);          // District scoped to North Idaho
  assignLocation(store, cda);                   // Store Manager scoped to Coeur d'Alene

  // Requirement matrix — org base + one trade override + one location override (flagship CDA).
  reqSettings();
  rule('org', null, 'coverage.general_liability.each_occurrence', '1000000', admin, 'Org baseline GL');
  rule('org', null, 'coverage.general_liability.general_aggregate', '2000000', admin, 'Org baseline GL aggregate');
  rule('org', null, 'coverage.automobile_liability.combined_single_limit', '1000000', admin, 'Org baseline auto');
  rule('org', null, 'coverage_required.workers_comp', 'true', admin, 'WC required org-wide');
  rule('org', null, 'coverage.umbrella.each_occurrence', '2000000', admin, 'Org baseline umbrella');
  rule('org', null, 'endorsement.additional_insured', 'true', admin, 'Additional insured required');
  rule('org', null, 'doc_required.coi', 'true', admin, 'COI mandatory');
  rule('org', null, 'doc_required.w9', 'true', admin, 'W-9 mandatory');
  rule('trade', 'electrical', 'coverage.general_liability.each_occurrence', '2000000', admin, 'Electrical is higher-risk — raise GL');
  rule('location', cda, 'coverage.general_liability.each_occurrence', '3000000', admin, 'Flagship Coeur d\'Alene — elevated GL');
  rule('location', cda, 'coverage.umbrella.each_occurrence', '5000000', admin, 'Flagship Coeur d\'Alene — elevated umbrella');

  const allLocs = [cda, postFalls, spokaneValley, libertyLake];
  const summary: string[] = [];

  // 1 — clean approved everywhere (Tier 3 · on track)
  {
    const v = vendor('Summit Mechanical Services', 'hvac', 'dispatch@summitmech.test');
    for (const l of allLocs) vloc(v, l, 'approved');
    run(v, 'approve'); doc(v, 'coi'); doc(v, 'w9');
    chase(v, 'dispatch@summitmech.test', dateInDays(280)); // far out → on track
    summary.push('Summit Mechanical Services (hvac) — approved ×4, clean → Tier 3 · On track');
  }
  // 2 — under_review, uncertain (Tier 1 · uncertain) — Clearwater WC-exemption canonical case
  {
    const v = vendor('Clearwater Plumbing & Drain', 'plumbing', 'office@clearwaterplumbing.test');
    vloc(v, cda, 'under_review'); vloc(v, postFalls, 'under_review');
    const r = run(v, 'uncertain'); doc(v, 'coi'); doc(v, 'w9');
    evalRow(r, v, cda, 'workers_comp_exemption_claimed', 'true', 'uncertain', 'indeterminate', 'low',
      'COI shows no workers comp; vendor may be a sole proprietor claiming exemption — needs a human call.');
    summary.push('Clearwater Plumbing & Drain (plumbing) — under_review, uncertain → Tier 1 · Uncertain');
  }
  // 3 — under_review, deficiencies (Tier 1 · deficiencies, 2 failed)
  {
    const v = vendor('Apex Electric Co.', 'electrical', 'billing@apexelectric.test');
    vloc(v, spokaneValley, 'under_review'); vloc(v, libertyLake, 'under_review');
    const r = run(v, 'deficiencies'); doc(v, 'coi'); doc(v, 'w9');
    evalRow(r, v, spokaneValley, 'coverage.general_liability.each_occurrence', '2000000', 'deficient', 'fails', 'high',
      'Electrical trade requires $2M GL each-occurrence; COI shows $1M.');
    evalRow(r, v, spokaneValley, 'endorsement.additional_insured', 'true', 'deficient', 'missing', 'high',
      'No additional-insured endorsement found on the COI.');
    summary.push('Apex Electric Co. (electrical) — under_review, 2 deficiencies → Tier 1 · Deficiencies');
  }
  // 4 — approved, COI imminent (≤7d) (Tier 1 · imminent lapse)
  {
    const v = vendor('Liberty Lake Landscaping', 'landscaping', 'crew@lllandscaping.test');
    vloc(v, spokaneValley, 'approved'); vloc(v, libertyLake, 'approved');
    run(v, 'approve'); doc(v, 'coi'); doc(v, 'w9');
    chase(v, 'crew@lllandscaping.test', dateInDays(6));
    summary.push('Liberty Lake Landscaping (landscaping) — approved, COI expires ~6d → Tier 1 · Imminent lapse');
  }
  // 5 — approved, COI expiring soon (8–60d) (Tier 2 · expiring soon)
  {
    const v = vendor('Five-Star Cleaning Crew', 'cleaning', 'ops@fivestarclean.test');
    for (const l of allLocs) vloc(v, l, 'approved');
    run(v, 'approve'); doc(v, 'coi'); doc(v, 'w9');
    chase(v, 'ops@fivestarclean.test', dateInDays(21));
    summary.push('Five-Star Cleaning Crew (cleaning) — approved, COI expires ~21d → Tier 2 · Expiring soon');
  }
  // 6 — open invite, delivered, not opened (Tier 3 · pending) — click-through vendor flow
  let pendingToken = '';
  {
    const v = vendor('Ridgeline Tree & Pest', 'pest_control', 'hello@ridgelinepest.test');
    vloc(v, cda, 'invited_pending');
    pendingToken = invite(v, admin, 'sent');
    summary.push('Ridgeline Tree & Pest (pest_control) — open invite (not opened) → Tier 3 · Pending  [vendor link below]');
  }
  // 7 — bounced invite (Tier 2 · invite failed / Resend)
  {
    const v = vendor('Gate Guard Systems', 'gate_door', 'bademail@gateguard.test');
    vloc(v, postFalls, 'invited_pending');
    invite(v, district, 'bounced');
    summary.push('Gate Guard Systems (gate_door) — invite bounced → Tier 2 · Invite failed (Resend)');
  }
  // 8 — expired coverage (Tier 1 · expired)
  {
    const v = vendor('Northwest Paving', 'paving_asphalt', 'jobs@nwpaving.test');
    vloc(v, postFalls, 'expired'); doc(v, 'coi'); doc(v, 'w9');
    summary.push('Northwest Paving (paving_asphalt) — coverage expired → Tier 1 · Expired');
  }
  // 9 — non-compliant after a rule change (Tier 1 · non-compliant)
  {
    const v = vendor('Iron Gate Security', 'security', 'admin@irongatesec.test');
    vloc(v, spokaneValley, 'non_compliant'); doc(v, 'coi'); doc(v, 'w9');
    const r = run(v, 'deficiencies', 'rule_change');
    evalRow(r, v, spokaneValley, 'coverage.general_liability.each_occurrence', '1000000', 'deficient', 'fails', 'high',
      'GL each-occurrence below the newly tightened org requirement.');
    summary.push('Iron Gate Security (security) — non-compliant (rule change) → Tier 1 · Non-compliant');
  }

  printSummary(summary, pendingToken);
}

function printSummary(vendorLines: string[], pendingToken: string): void {
  const line = '─'.repeat(78);
  console.log(`\n${line}\n✅ Seeded "${TENANT_NAME}"  (tenant ${TENANT})\n${line}`);
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

migrate();
wipeExisting();
db.transaction(seed)();
