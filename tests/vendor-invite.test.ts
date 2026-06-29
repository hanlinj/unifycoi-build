import crypto from 'crypto';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedInvite,
} from './helpers';
import { generateInviteToken, hashInviteToken } from '@/lib/auth/invite-token';
import { fsmTransition, IllegalTransitionError } from '@/lib/services/vendor-fsm';
import { createVendorInvite, VALID_TRADES } from '@/lib/services/vendors';

// ── Token utility ─────────────────────────────────────────────────────────────

describe('generateInviteToken', () => {
  test('raw token and hash are different strings', () => {
    const { rawToken, tokenHash } = generateInviteToken();
    expect(rawToken).not.toBe(tokenHash);
  });

  test('hash is exactly SHA-256 of the raw token', () => {
    const { rawToken, tokenHash } = generateInviteToken();
    const expected = crypto.createHash('sha256').update(rawToken).digest('hex');
    expect(tokenHash).toBe(expected);
  });

  test('hash is 64-char hex', () => {
    const { tokenHash } = generateInviteToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('raw token is 43-char base64url (32 bytes)', () => {
    const { rawToken } = generateInviteToken();
    // base64url of 32 bytes = 43 chars (no padding)
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('each call produces a unique raw token', () => {
    const { rawToken: a } = generateInviteToken();
    const { rawToken: b } = generateInviteToken();
    expect(a).not.toBe(b);
  });

  test('hashInviteToken is deterministic', () => {
    const h1 = hashInviteToken('test-token');
    const h2 = hashInviteToken('test-token');
    expect(h1).toBe(h2);
  });
});

// ── seedInvite stores hash, returns raw ────────────────────────────────────────

describe('seedInvite helper', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let user: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    user = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('returns rawToken, stores its hash in DB', () => {
    const { id, rawToken } = seedInvite(db, tenant.id, { inviterUserId: user.id });
    const row = db.prepare('SELECT token FROM invites WHERE id = ?').get(id) as { token: string };
    expect(row.token).toBe(hashInviteToken(rawToken));
    expect(row.token).not.toBe(rawToken);
  });

  test('accepts a provided rawToken and hashes it consistently', () => {
    const provided = 'my-deterministic-raw-token';
    const { rawToken } = seedInvite(db, tenant.id, { rawToken: provided, inviterUserId: user.id });
    expect(rawToken).toBe(provided);
    const row = db.prepare("SELECT token FROM invites WHERE tenant_id = ?").get(tenant.id) as { token: string };
    expect(row.token).toBe(hashInviteToken(provided));
  });
});

// ── FSM ───────────────────────────────────────────────────────────────────────

describe('fsmTransition', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let vendor: ReturnType<typeof seedVendor>;
  let loc1: ReturnType<typeof seedLocation>;
  let loc2: ReturnType<typeof seedLocation>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    vendor = seedVendor(db, tenant.id);
    loc1 = seedLocation(db, tenant.id);
    loc2 = seedLocation(db, tenant.id);
  });
  afterEach(() => db.close());

  function getStatuses() {
    return (db.prepare('SELECT location_id, status FROM vendor_locations WHERE vendor_id = ? ORDER BY location_id')
      .all(vendor.id) as { location_id: string; status: string }[]);
  }

  test('open_link: invited_pending → onboarding (single location)', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    fsmTransition(db, tenant.id, vendor.id, 'open_link');
    const rows = getStatuses();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('onboarding');
  });

  test('open_link: transitions ALL locations atomically', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    seedVendorLocation(db, tenant.id, vendor.id, loc2.id, { status: 'invited_pending' });
    fsmTransition(db, tenant.id, vendor.id, 'open_link');
    const rows = getStatuses();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'onboarding')).toBe(true);
  });

  test('submit: onboarding → under_review', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'onboarding' });
    fsmTransition(db, tenant.id, vendor.id, 'submit');
    const rows = getStatuses();
    expect(rows[0].status).toBe('under_review');
  });

  test('returns locationIds that were transitioned', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    seedVendorLocation(db, tenant.id, vendor.id, loc2.id, { status: 'invited_pending' });
    const result = fsmTransition(db, tenant.id, vendor.id, 'open_link');
    expect(result.locationIds).toHaveLength(2);
    expect(result.locationIds).toContain(loc1.id);
    expect(result.locationIds).toContain(loc2.id);
  });

  test('illegal: invited_pending cannot submit (must open_link first)', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'submit'))
      .toThrow(IllegalTransitionError);
  });

  test('illegal: onboarding cannot open_link again', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'onboarding' });
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'open_link'))
      .toThrow(IllegalTransitionError);
  });

  test('illegal: under_review cannot open_link', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'under_review' });
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'open_link'))
      .toThrow(IllegalTransitionError);
  });

  test('illegal: under_review cannot submit', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'under_review' });
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'submit'))
      .toThrow(IllegalTransitionError);
  });

  test('mixed status across locations rolls back atomically', () => {
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    seedVendorLocation(db, tenant.id, vendor.id, loc2.id, { status: 'onboarding' }); // wrong state
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'open_link'))
      .toThrow(IllegalTransitionError);
    // Both should be unchanged after failed transaction
    const rows = getStatuses();
    const statuses = Object.fromEntries(rows.map((r) => [r.location_id, r.status]));
    expect(statuses[loc1.id]).toBe('invited_pending');
    expect(statuses[loc2.id]).toBe('onboarding');
  });

  test('throws when no vendor_locations exist for vendor', () => {
    expect(() => fsmTransition(db, tenant.id, vendor.id, 'open_link'))
      .toThrow(/No vendor_locations found/);
  });

  test('cross-tenant: wrong tenantId finds no rows and throws', () => {
    const tenant2 = seedTenant(db);
    seedVendorLocation(db, tenant.id, vendor.id, loc1.id, { status: 'invited_pending' });
    // Passing the wrong tenant — TenantDB scoping means vendor not found
    expect(() => fsmTransition(db, tenant2.id, vendor.id, 'open_link'))
      .toThrow(/No vendor_locations found/);
    // Original row untouched
    const row = db.prepare('SELECT status FROM vendor_locations WHERE vendor_id = ? AND location_id = ?')
      .get(vendor.id, loc1.id) as { status: string };
    expect(row.status).toBe('invited_pending');
  });
});

// ── createVendorInvite ────────────────────────────────────────────────────────

describe('createVendorInvite', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;
  let loc: ReturnType<typeof seedLocation>;

  const baseInput = () => ({
    businessName: 'Acme Plumbing LLC',
    contactFirstName: 'John',
    contactLastName: 'Doe',
    email: 'john@acmeplumbing.com',
    companyPhone: '+15095551234',
    trade: 'plumbing' as const,
    locationIds: [] as string[],
    inviterUserId: '',
  });

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    loc = seedLocation(db, tenant.id);
  });
  afterEach(() => db.close());

  test('happy path: creates vendor, invite, vendor_locations, notification, audit event', () => {
    const input = { ...baseInput(), locationIds: [loc.id], inviterUserId: admin.id };
    const result = createVendorInvite(db, tenant.id, input);
    expect(result.type).toBe('created');
    if (result.type !== 'created') return;

    // vendor row
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? AND tenant_id = ?')
      .get(result.vendorId, tenant.id) as Record<string, unknown>;
    expect(vendor.business_name).toBe('Acme Plumbing LLC');
    expect(vendor.contact_email).toBe('john@acmeplumbing.com');
    expect(vendor.trade).toBe('plumbing');

    // invite row — hash stored, not raw
    const invite = db.prepare('SELECT * FROM invites WHERE id = ? AND tenant_id = ?')
      .get(result.inviteId, tenant.id) as Record<string, unknown>;
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);  // SHA-256 hex
    expect(invite.purpose).toBe('onboarding');
    expect(invite.delivery_state).toBe('sent');

    // vendor_locations at invited_pending
    const vls = db.prepare('SELECT * FROM vendor_locations WHERE vendor_id = ? AND tenant_id = ?')
      .all(result.vendorId, tenant.id) as Record<string, unknown>[];
    expect(vls).toHaveLength(1);
    expect(vls[0].status).toBe('invited_pending');
    expect(vls[0].location_id).toBe(loc.id);

    // notification queued
    const notif = db.prepare("SELECT * FROM notifications WHERE tenant_id = ? AND recipient_ref = ? AND kind = 'exception'")
      .get(tenant.id, 'john@acmeplumbing.com') as Record<string, unknown>;
    expect(notif).toBeTruthy();
    expect(notif.status).toBe('queued');
    const payload = JSON.parse(notif.payload_json as string);
    expect(payload.type).toBe('vendor_invite');
    expect(payload.invite_path).toMatch(/^\/v\//);

    // audit event
    const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'vendor.invited' AND target_id = ?")
      .get(result.vendorId) as Record<string, unknown>;
    expect(audit).toBeTruthy();
    expect(audit.actor_id).toBe(admin.id);
  });

  test('invite token in DB is SHA-256 of the raw token in notification', () => {
    const result = createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [loc.id], inviterUserId: admin.id });
    if (result.type !== 'created') throw new Error('expected created');

    const invite = db.prepare('SELECT token FROM invites WHERE id = ?').get(result.inviteId) as { token: string };
    const notif = db.prepare('SELECT payload_json FROM notifications WHERE tenant_id = ?').get(tenant.id) as { payload_json: string };
    const payload = JSON.parse(notif.payload_json);
    const rawToken = payload.invite_path.replace('/v/', '');

    expect(invite.token).toBe(hashInviteToken(rawToken));
  });

  test('creates vendor_locations for each provided location', () => {
    const loc2 = seedLocation(db, tenant.id);
    const result = createVendorInvite(db, tenant.id, {
      ...baseInput(), locationIds: [loc.id, loc2.id], inviterUserId: admin.id,
    });
    if (result.type !== 'created') throw new Error('expected created');

    const vls = db.prepare('SELECT location_id, status FROM vendor_locations WHERE vendor_id = ?')
      .all(result.vendorId) as { location_id: string; status: string }[];
    expect(vls).toHaveLength(2);
    expect(vls.every((r) => r.status === 'invited_pending')).toBe(true);
  });

  test('duplicate email returns duplicate result', () => {
    createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [loc.id], inviterUserId: admin.id });
    const result = createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [loc.id], inviterUserId: admin.id });
    expect(result.type).toBe('duplicate');
    if (result.type !== 'duplicate') return;
    expect(result.existingBusinessName).toBe('Acme Plumbing LLC');
  });

  test('inactive location throws 400', () => {
    const archived = seedLocation(db, tenant.id, { status: 'archived' });
    expect(() =>
      createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [archived.id], inviterUserId: admin.id })
    ).toThrow(/Location not found or not active/);
  });

  test('location in another tenant throws 400', () => {
    const tenant2 = seedTenant(db);
    const foreignLoc = seedLocation(db, tenant2.id);
    expect(() =>
      createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [foreignLoc.id], inviterUserId: admin.id })
    ).toThrow(/Location not found or not active/);
  });

  test('cross-tenant isolation: vendor created in tenant A not visible in tenant B', () => {
    const tenant2 = seedTenant(db);
    const result = createVendorInvite(db, tenant.id, { ...baseInput(), locationIds: [loc.id], inviterUserId: admin.id });
    if (result.type !== 'created') throw new Error('expected created');

    const inTenantB = db.prepare('SELECT id FROM vendors WHERE id = ? AND tenant_id = ?')
      .get(result.vendorId, tenant2.id);
    expect(inTenantB).toBeUndefined();
  });

  test('everything rolls back if a location is invalid (atomicity)', () => {
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM vendors WHERE tenant_id = ?')
      .get(tenant.id) as { c: number }).c;

    expect(() =>
      createVendorInvite(db, tenant.id, {
        ...baseInput(),
        locationIds: [loc.id, 'nonexistent-location'],
        inviterUserId: admin.id,
      })
    ).toThrow();

    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM vendors WHERE tenant_id = ?')
      .get(tenant.id) as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  test('VALID_TRADES includes expected values', () => {
    expect(VALID_TRADES).toContain('plumbing');
    expect(VALID_TRADES).toContain('electrical');
    expect(VALID_TRADES).toContain('other');
  });
});
