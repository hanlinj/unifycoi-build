import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { hashPassword } from '@/lib/auth/password';
import { logAudit } from '@/lib/audit';
import { userManageableByScope, type Scope } from '@/lib/scope';

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  created_at: string;
  password_hash?: string | null; // never returned to client
}

export interface UserWithScope extends Omit<User, 'password_hash'> {
  regionIds: string[];
  locationIds: string[];
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: 'admin' | 'district_manager' | 'store_manager';
  password?: string;          // if provided: user created as 'active'; otherwise 'invited'
  regionIds?: string[];       // for district_manager
  locationIds?: string[];     // for store_manager
}

export interface UpdateUserInput {
  name?: string;
  status?: 'active' | 'disabled' | 'invited';
  regionIds?: string[];
  locationIds?: string[];
}

const VALID_ROLES = ['admin', 'district_manager', 'store_manager'] as const;

function userWithScope(db: Database.Database, tenantId: string, userId: string): UserWithScope | null {
  const tdb = new TenantDB(db, tenantId);
  const user = tdb.get<User>('SELECT id, tenant_id, email, name, role, status, created_at FROM users WHERE tenant_id = ? AND id = ?', [userId]);
  if (!user) return null;

  const regionRows = tdb.all<{ region_id: string }>('SELECT region_id FROM user_regions WHERE tenant_id = ? AND user_id = ?', [userId]);
  const locRows = tdb.all<{ location_id: string }>('SELECT location_id FROM user_locations WHERE tenant_id = ? AND user_id = ?', [userId]);

  return {
    ...user,
    regionIds: regionRows.map((r) => r.region_id),
    locationIds: locRows.map((r) => r.location_id),
  };
}

export function createUser(
  db: Database.Database,
  tenantId: string,
  input: CreateUserInput,
  actorId: string,
  callerScope: Scope,
  callerRole: string
): UserWithScope {
  if (!VALID_ROLES.includes(input.role as (typeof VALID_ROLES)[number])) {
    throw Object.assign(new Error(`Invalid role: ${input.role}`), { status: 400 });
  }

  // District Manager cannot create Admin roles
  if (callerRole === 'district_manager' && input.role === 'admin') {
    throw Object.assign(new Error('District Managers cannot create Admin users'), { status: 403 });
  }
  // Store Managers cannot create any users (enforced at route level; guard here too)
  if (callerRole === 'store_manager') {
    throw Object.assign(new Error('Store Managers cannot create users'), { status: 403 });
  }

  const tdb = new TenantDB(db, tenantId);
  const existing = tdb.get<User>('SELECT id FROM users WHERE tenant_id = ? AND email = ? COLLATE NOCASE', [input.email]);
  if (existing) {
    throw Object.assign(new Error('A user with this email already exists in this tenant'), { status: 409 });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.password ? 'active' : 'invited';
  const passwordHash = input.password ? hashPassword(input.password) : null;

  tdb.insert('users', {
    id,
    email: input.email.toLowerCase().trim(),
    name: input.name.trim(),
    role: input.role,
    password_hash: passwordHash,
    status,
    created_at: now,
  });

  // Assign scope
  const regionIds = input.regionIds ?? [];
  const locationIds = input.locationIds ?? [];

  // Scope-check: DM can only assign within their own regions/locations
  if (callerRole === 'district_manager') {
    for (const rid of regionIds) {
      if (!callerScope.regionIds?.includes(rid)) {
        throw Object.assign(new Error(`Region ${rid} is outside your scope`), { status: 403 });
      }
    }
    for (const lid of locationIds) {
      if (!callerScope.locationIds?.includes(lid)) {
        throw Object.assign(new Error(`Location ${lid} is outside your scope`), { status: 403 });
      }
    }
  }

  for (const rid of regionIds) {
    tdb.insert('user_regions', { user_id: id, region_id: rid }, { orIgnore: true });
  }
  for (const lid of locationIds) {
    tdb.insert('user_locations', { user_id: id, location_id: lid }, { orIgnore: true });
  }

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'user.created',
    targetType: 'user',
    targetId: id,
    payload: { role: input.role, email: input.email },
  });

  return userWithScope(db, tenantId, id)!;
}

export function listUsers(
  db: Database.Database,
  tenantId: string,
  scope: Scope
): UserWithScope[] {
  const tdb = new TenantDB(db, tenantId);
  let users: User[];

  if (scope.locationIds === null) {
    // Admin: all users
    users = tdb.all<User>(
      'SELECT id, tenant_id, email, name, role, status, created_at FROM users WHERE tenant_id = ? ORDER BY name'
    );
  } else {
    // District: users with location assignments in scope
    if (scope.locationIds.length === 0) return [];
    const placeholders = scope.locationIds.map(() => '?').join(',');
    users = tdb.all<User>(
      `SELECT DISTINCT u.id, u.tenant_id, u.email, u.name, u.role, u.status, u.created_at
       FROM users u
       JOIN user_locations ul ON ul.user_id = u.id AND ul.tenant_id = u.tenant_id
       WHERE u.tenant_id = ? AND ul.location_id IN (${placeholders})
       ORDER BY u.name`,
      scope.locationIds
    );
  }

  return users.map((u) => userWithScope(db, tenantId, u.id)!);
}

export function getUserById(
  db: Database.Database,
  tenantId: string,
  userId: string
): UserWithScope | null {
  return userWithScope(db, tenantId, userId);
}

export interface ManagedUser extends UserWithScope {
  /** Whether the calling user may manage this target (Phase 8 containment rule). */
  manageable: boolean;
}

/**
 * Users for the management UI, each tagged with the caller's manageability.
 * Admin: every user, all manageable. District: their in-region manageable users PLUS Admins
 * shown-but-marked unmanageable (explicit affordance, not hidden); out-of-scope non-admins are
 * omitted. (Reuses the Phase 8 containment rule — target's scope ⊆ caller's regions; Admins
 * unmanageable by Districts.)
 */
export function usersForManagement(
  db: Database.Database,
  tenantId: string,
  scope: Scope,
  callerRole: string
): ManagedUser[] {
  const tdb = new TenantDB(db, tenantId);
  const all = tdb.all<{ id: string; role: string }>('SELECT id, role FROM users WHERE tenant_id = ? ORDER BY name');
  const out: ManagedUser[] = [];
  for (const u of all) {
    if (callerRole === 'admin') {
      out.push({ ...userWithScope(db, tenantId, u.id)!, manageable: true });
    } else if (u.role === 'admin') {
      out.push({ ...userWithScope(db, tenantId, u.id)!, manageable: false }); // shown, marked
    } else if (userManageableByScope(db, tenantId, scope, u.id).inScope) {
      out.push({ ...userWithScope(db, tenantId, u.id)!, manageable: true });
    }
    // else: out-of-scope non-admin → omitted (District sees only manageable + admins-marked)
  }
  return out;
}

export function updateUser(
  db: Database.Database,
  tenantId: string,
  userId: string,
  input: UpdateUserInput,
  actorId: string
): UserWithScope {
  const tdb = new TenantDB(db, tenantId);
  const existing = tdb.get<User>('SELECT id, status FROM users WHERE tenant_id = ? AND id = ?', [userId]);
  if (!existing) throw Object.assign(new Error('User not found'), { status: 404 });

  if (input.name !== undefined) {
    tdb.update('users', { name: input.name.trim() }, { id: userId });
  }
  if (input.status !== undefined) {
    tdb.update('users', { status: input.status }, { id: userId });
  }

  if (input.regionIds !== undefined) {
    tdb.del('user_regions', { user_id: userId });
    for (const rid of input.regionIds) {
      tdb.insert('user_regions', { user_id: userId, region_id: rid }, { orIgnore: true });
    }
  }
  if (input.locationIds !== undefined) {
    tdb.del('user_locations', { user_id: userId });
    for (const lid of input.locationIds) {
      tdb.insert('user_locations', { user_id: userId, location_id: lid }, { orIgnore: true });
    }
  }

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'user.updated',
    targetType: 'user',
    targetId: userId,
    payload: { changes: Object.keys(input) },
  });

  return userWithScope(db, tenantId, userId)!;
}

export function inviteUser(
  db: Database.Database,
  tenantId: string,
  userId: string,
  actorId: string
): UserWithScope {
  const tdb = new TenantDB(db, tenantId);
  const existing = tdb.get<User>('SELECT id, status FROM users WHERE tenant_id = ? AND id = ?', [userId]);
  if (!existing) throw Object.assign(new Error('User not found'), { status: 404 });

  tdb.update('users', { status: 'invited' }, { id: userId });

  logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'user.invited',
    targetType: 'user',
    targetId: userId,
  });

  return userWithScope(db, tenantId, userId)!;
}
