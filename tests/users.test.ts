import {
  setupTestDb,
  seedPlatformUser,
  seedTenant,
  seedTenantUser,
  seedRegion,
  seedLocation,
  assignUserToRegion,
  assignUserToLocation,
} from './helpers';
import { createUser, listUsers, getUserById, updateUser, inviteUser } from '@/lib/services/users';
import { resolveScope } from '@/lib/scope';

describe('createUser', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('Admin can create a store manager', () => {
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const user = createUser(db, tenant.id, {
      email: 'sm@example.com', name: 'Store Manager', role: 'store_manager', password: 'pass123!',
    }, admin.id, scope, 'admin');
    expect(user.role).toBe('store_manager');
    expect(user.status).toBe('active'); // password provided
  });

  test('User created without password is invited', () => {
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const user = createUser(db, tenant.id, {
      email: 'invited@example.com', name: 'Invited', role: 'store_manager',
    }, admin.id, scope, 'admin');
    expect(user.status).toBe('invited');
  });

  test('duplicate email in tenant is rejected', () => {
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    createUser(db, tenant.id, { email: 'dup@example.com', name: 'First', role: 'store_manager' }, admin.id, scope, 'admin');
    expect(() =>
      createUser(db, tenant.id, { email: 'dup@example.com', name: 'Second', role: 'store_manager' }, admin.id, scope, 'admin')
    ).toThrow(/already exists/);
  });

  test('district_manager cannot create admin', () => {
    const dm = seedTenantUser(db, tenant.id, { role: 'district_manager' });
    const region = seedRegion(db, tenant.id);
    assignUserToRegion(db, dm.id, region.id, tenant.id);
    const scope = resolveScope(db, tenant.id, dm.id, 'district_manager');

    expect(() =>
      createUser(db, tenant.id, { email: 'admin2@example.com', name: 'New Admin', role: 'admin' }, dm.id, scope, 'district_manager')
    ).toThrow(/cannot create Admin/);
  });

  test('store_manager cannot create users', () => {
    const sm = seedTenantUser(db, tenant.id, { role: 'store_manager' });
    const scope = resolveScope(db, tenant.id, sm.id, 'store_manager');

    expect(() =>
      createUser(db, tenant.id, { email: 'new@example.com', name: 'New', role: 'store_manager' }, sm.id, scope, 'store_manager')
    ).toThrow(/cannot create users/);
  });

  test('district_manager cannot assign location outside their scope', () => {
    const dm = seedTenantUser(db, tenant.id, { role: 'district_manager' });
    const region = seedRegion(db, tenant.id);
    const outsideLoc = seedLocation(db, tenant.id); // not in DM's region
    assignUserToRegion(db, dm.id, region.id, tenant.id);
    const scope = resolveScope(db, tenant.id, dm.id, 'district_manager');

    expect(() =>
      createUser(db, tenant.id, {
        email: 'sm2@example.com', name: 'SM', role: 'store_manager', locationIds: [outsideLoc.id],
      }, dm.id, scope, 'district_manager')
    ).toThrow(/outside your scope/);
  });

  test('location assignments are saved', () => {
    const loc = seedLocation(db, tenant.id);
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const user = createUser(db, tenant.id, {
      email: 'locuser@example.com', name: 'Loc User', role: 'store_manager', locationIds: [loc.id],
    }, admin.id, scope, 'admin');
    expect(user.locationIds).toContain(loc.id);
  });

  test('logs audit event', () => {
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const user = createUser(db, tenant.id, { email: 'log@example.com', name: 'Log', role: 'store_manager' }, admin.id, scope, 'admin');
    const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'user.created' AND target_id = ?").get(user.id);
    expect(event).toBeTruthy();
  });
});

describe('listUsers scope enforcement', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let region: { id: string; name: string };
  let locInRegion: { id: string };
  let locOutside: { id: string };
  let dm: ReturnType<typeof seedTenantUser>;
  let smInRegion: ReturnType<typeof seedTenantUser>;
  let smOutside: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    region = seedRegion(db, tenant.id);
    locInRegion = seedLocation(db, tenant.id, { regionId: region.id });
    locOutside = seedLocation(db, tenant.id);

    dm = seedTenantUser(db, tenant.id, { role: 'district_manager' });
    assignUserToRegion(db, dm.id, region.id, tenant.id);

    smInRegion = seedTenantUser(db, tenant.id, { role: 'store_manager' });
    assignUserToLocation(db, smInRegion.id, locInRegion.id, tenant.id);

    smOutside = seedTenantUser(db, tenant.id, { role: 'store_manager' });
    assignUserToLocation(db, smOutside.id, locOutside.id, tenant.id);
  });
  afterEach(() => db.close());

  test('admin sees all users', () => {
    const admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    const scope = resolveScope(db, tenant.id, admin.id, 'admin');
    const users = listUsers(db, tenant.id, scope);
    const ids = users.map((u) => u.id);
    expect(ids).toContain(smInRegion.id);
    expect(ids).toContain(smOutside.id);
  });

  test('district_manager sees only users in their region', () => {
    const scope = resolveScope(db, tenant.id, dm.id, 'district_manager');
    const users = listUsers(db, tenant.id, scope);
    const ids = users.map((u) => u.id);
    expect(ids).toContain(smInRegion.id);
    expect(ids).not.toContain(smOutside.id);
  });
});

describe('updateUser', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;
  let target: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    target = seedTenantUser(db, tenant.id, { role: 'store_manager', name: 'Original Name' });
  });
  afterEach(() => db.close());

  test('updates name', () => {
    const updated = updateUser(db, tenant.id, target.id, { name: 'New Name' }, admin.id);
    expect(updated.name).toBe('New Name');
  });

  test('disables user', () => {
    const updated = updateUser(db, tenant.id, target.id, { status: 'disabled' }, admin.id);
    expect(updated.status).toBe('disabled');
  });

  test('throws for unknown user', () => {
    expect(() => updateUser(db, tenant.id, 'no-such-id', { name: 'X' }, admin.id)).toThrow(/not found/i);
  });
});

describe('inviteUser', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('sets status to invited', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'active' });
    const updated = inviteUser(db, tenant.id, target.id, admin.id);
    expect(updated.status).toBe('invited');
  });

  test('logs audit event', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager' });
    inviteUser(db, tenant.id, target.id, admin.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'user.invited' AND target_id = ?").get(target.id);
    expect(event).toBeTruthy();
  });
});
