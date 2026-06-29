import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedVendor,
  seedVendorLocation,
  seedInvite,
} from './helpers';
import { validateInviteToken, INVALID_TOKEN_MESSAGE } from '@/lib/services/vendor-token';
import { sniffIsPdf, withinSizeLimit, MAX_UPLOAD_BYTES } from '@/lib/upload/validate';
import { hashInviteToken } from '@/lib/auth/invite-token';

// ── validateInviteToken ───────────────────────────────────────────────────────

describe('validateInviteToken', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let user: ReturnType<typeof seedTenantUser>;
  let vendor: ReturnType<typeof seedVendor>;
  let loc: ReturnType<typeof seedLocation>;
  let rawToken: string;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    user = seedTenantUser(db, tenant.id, { role: 'admin' });
    vendor = seedVendor(db, tenant.id);
    loc = seedLocation(db, tenant.id);
    seedVendorLocation(db, tenant.id, vendor.id, loc.id, { status: 'invited_pending' });

    const seeded = seedInvite(db, tenant.id, {
      vendorId: vendor.id,
      inviterUserId: user.id,
    });
    rawToken = seeded.rawToken;
  });
  afterEach(() => db.close());

  test('valid token returns invite + vendor + vendorLocations', () => {
    const result = validateInviteToken(db, rawToken);
    expect(result).not.toBeNull();
    expect(result!.invite.tenant_id).toBe(tenant.id);
    expect(result!.invite.vendor_id).toBe(vendor.id);
    expect(result!.vendor.business_name).toBe(vendor.business_name);
    expect(result!.vendorLocations).toHaveLength(1);
    expect(result!.vendorLocations[0].location_id).toBe(loc.id);
  });

  test('token lookup is by hash — raw token never stored', () => {
    const row = db
      .prepare('SELECT token FROM invites WHERE vendor_id = ?')
      .get(vendor.id) as { token: string };
    // DB stores the hash, not the raw token
    expect(row.token).toBe(hashInviteToken(rawToken));
    expect(row.token).not.toBe(rawToken);
  });

  test('unknown token returns null (enumeration-resistant)', () => {
    expect(validateInviteToken(db, 'completelymadeuptoken')).toBeNull();
  });

  test('expired token returns null — same null as unknown', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { rawToken: expiredRaw } = seedInvite(db, tenant.id, {
      vendorId: vendor.id,
      inviterUserId: user.id,
      expiresAt: past,
    });
    expect(validateInviteToken(db, expiredRaw)).toBeNull();
  });

  test('bounced delivery_state returns null', () => {
    const { rawToken: bouncedRaw } = seedInvite(db, tenant.id, {
      vendorId: vendor.id,
      inviterUserId: user.id,
      deliveryState: 'bounced',
    });
    expect(validateInviteToken(db, bouncedRaw)).toBeNull();
  });

  test('expired_invite delivery_state returns null', () => {
    const { rawToken: agedRaw } = seedInvite(db, tenant.id, {
      vendorId: vendor.id,
      inviterUserId: user.id,
      deliveryState: 'expired_invite',
    });
    expect(validateInviteToken(db, agedRaw)).toBeNull();
  });

  test('unknown/expired/revoked all return null — same type, not distinct errors', () => {
    const past = new Date(Date.now() - 1).toISOString();
    const { rawToken: expiredRaw } = seedInvite(db, tenant.id, {
      vendorId: vendor.id, inviterUserId: user.id, expiresAt: past,
    });
    const { rawToken: bouncedRaw } = seedInvite(db, tenant.id, {
      vendorId: vendor.id, inviterUserId: user.id, deliveryState: 'bounced',
    });

    expect(validateInviteToken(db, 'unknowntoken')).toBeNull();
    expect(validateInviteToken(db, expiredRaw)).toBeNull();
    expect(validateInviteToken(db, bouncedRaw)).toBeNull();
  });

  test('INVALID_TOKEN_MESSAGE is a single uniform string', () => {
    expect(typeof INVALID_TOKEN_MESSAGE).toBe('string');
    expect(INVALID_TOKEN_MESSAGE.length).toBeGreaterThan(0);
  });

  test('cross-tenant: valid token from tenant A returns null when looked up via wrong hash', () => {
    // This is guaranteed structurally: two different inputs produce different SHA-256 hashes.
    // An attacker from tenant B cannot guess tenant A's raw token.
    const fakeRaw = rawToken.split('').reverse().join(''); // garbage raw token
    expect(validateInviteToken(db, fakeRaw)).toBeNull();
  });

  test('valid token includes vendor_locations from correct tenant', () => {
    const tenant2 = seedTenant(db);
    const vendor2 = seedVendor(db, tenant2.id);
    const loc2 = seedLocation(db, tenant2.id);
    seedVendorLocation(db, tenant2.id, vendor2.id, loc2.id, { status: 'invited_pending' });

    // Tenant A's token only sees tenant A's vendor_locations
    const result = validateInviteToken(db, rawToken);
    expect(result!.vendorLocations.map((vl) => vl.location_id)).not.toContain(loc2.id);
    expect(result!.vendorLocations).toHaveLength(1);
  });
});

// ── Upload validation (content sniff + size cap) ──────────────────────────────

describe('sniffIsPdf', () => {
  test('accepts a valid PDF magic header', () => {
    const pdfBuf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    expect(sniffIsPdf(pdfBuf)).toBe(true);
  });

  test('rejects a JPEG (wrong magic)', () => {
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffIsPdf(jpegBuf)).toBe(false);
  });

  test('rejects a PNG (wrong magic)', () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffIsPdf(pngBuf)).toBe(false);
  });

  test('rejects a buffer that looks like PDF extension but has wrong bytes', () => {
    const fakePdf = Buffer.from('This is not a PDF', 'utf-8');
    expect(sniffIsPdf(fakePdf)).toBe(false);
  });

  test('rejects an empty buffer', () => {
    expect(sniffIsPdf(Buffer.alloc(0))).toBe(false);
  });

  test('rejects a 3-byte buffer (too short for magic check)', () => {
    expect(sniffIsPdf(Buffer.from([0x25, 0x50, 0x44]))).toBe(false);
  });

  test('accepts exactly 4 bytes of PDF magic', () => {
    expect(sniffIsPdf(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe(true);
  });
});

describe('withinSizeLimit', () => {
  test('accepts a buffer at exactly MAX_UPLOAD_BYTES', () => {
    const buf = Buffer.alloc(MAX_UPLOAD_BYTES);
    expect(withinSizeLimit(buf)).toBe(true);
  });

  test('rejects a buffer one byte over MAX_UPLOAD_BYTES', () => {
    const buf = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    expect(withinSizeLimit(buf)).toBe(false);
  });

  test('accepts an empty buffer', () => {
    expect(withinSizeLimit(Buffer.alloc(0))).toBe(true);
  });

  test('MAX_UPLOAD_BYTES is 10 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
