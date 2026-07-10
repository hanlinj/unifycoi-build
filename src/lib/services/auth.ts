import { sql } from 'kysely';
import type { Db } from '@/lib/db/client';
import { verifyPassword } from '@/lib/auth/password';
import { issueToken, type TokenPayload } from '@/lib/auth/jwt';

export interface LoginResult {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    type: 'platform' | 'tenant';
    tenantId: string | null;
    impersonatedBy?: string;
  };
}

/**
 * Attempt login. Pass tenantId to authenticate as a tenant user; omit for platform user.
 * Returns null on any credential/state failure.
 *
 * Platform-scoped raw queries (bypasses TenantDB — no tenant context exists yet at login).
 * Case-insensitive email match: SQLite's `COLLATE NOCASE` → Postgres `lower(email) = lower($)`
 * (Stage 0's catalogued rework spot) — same ASCII case-folding behavior, not a citext column.
 */
export async function loginWithEmail(
  db: Db,
  email: string,
  password: string,
  tenantId?: string
): Promise<LoginResult | null> {
  if (!email || !password) return null;

  if (tenantId) {
    // Tenant user login
    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'lifecycle_state'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) return null;
    if (tenant.lifecycle_state === 'suspended' || tenant.lifecycle_state === 'offboarded') {
      return null; // tenant access frozen
    }

    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'role', 'password_hash', 'status'])
      .where('tenant_id', '=', tenantId)
      .where(sql`lower(email)`, '=', email.toLowerCase())
      .executeTakeFirst();

    if (!user || !user.password_hash) return null;
    if (user.status === 'disabled') return null;
    if (!verifyPassword(password, user.password_hash)) return null;

    const payload: TokenPayload = {
      sub: user.id,
      tenantId,
      role: user.role,
      type: 'tenant',
    };
    return {
      token: issueToken(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role, type: 'tenant', tenantId },
    };
  }

  // Platform user login
  const platformUser = await db
    .selectFrom('platform_users')
    .select(['id', 'email', 'name', 'role', 'password_hash'])
    .where(sql`lower(email)`, '=', email.toLowerCase())
    .executeTakeFirst();

  if (!platformUser) return null;
  if (!verifyPassword(password, platformUser.password_hash)) return null;

  const payload: TokenPayload = {
    sub: platformUser.id,
    tenantId: null,
    role: platformUser.role,
    type: 'platform',
  };
  return {
    token: issueToken(payload),
    user: {
      id: platformUser.id,
      email: platformUser.email,
      name: platformUser.name,
      role: platformUser.role,
      type: 'platform',
      tenantId: null,
    },
  };
}

/**
 * Login for the browser form (email + password, no tenant id). Tries platform first, then
 * resolves the tenant(s) carrying that email and authenticates against the one whose password
 * verifies. (Email is unique per tenant; the same email in two tenants is rare — first match
 * whose password verifies wins.) An explicit tenantId short-circuits to that tenant.
 */
export async function loginResolvingTenant(
  db: Db,
  email: string,
  password: string,
  tenantId?: string
): Promise<LoginResult | null> {
  if (!email || !password) return null;
  if (tenantId) return loginWithEmail(db, email, password, tenantId);

  const platform = await loginWithEmail(db, email, password); // platform path (no tenantId)
  if (platform) return platform;

  const rows = await db
    .selectFrom('users')
    .distinct()
    .select('tenant_id')
    .where(sql`lower(email)`, '=', email.toLowerCase())
    .execute();
  for (const r of rows) {
    const res = await loginWithEmail(db, email, password, r.tenant_id);
    if (res) return res;
  }
  return null;
}

export async function getMeInfo(
  db: Db,
  payload: TokenPayload
): Promise<Record<string, unknown> | null> {
  if (payload.type === 'platform') {
    const u = await db
      .selectFrom('platform_users')
      .select(['id', 'email', 'name', 'role', 'created_at'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();
    if (!u) return null;
    return { ...u, type: 'platform' };
  }

  // tenant user (including impersonation)
  if (!payload.tenantId) return null;
  const u = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'role', 'status', 'created_at'])
    .where('id', '=', payload.sub)
    .where('tenant_id', '=', payload.tenantId)
    .executeTakeFirst();

  if (payload.impersonatedBy) {
    // Synthetic impersonation session may not have a real sub; return synthetic info
    if (!u) {
      return {
        id: payload.sub,
        role: 'admin',
        tenantId: payload.tenantId,
        type: 'tenant',
        impersonatedBy: payload.impersonatedBy,
      };
    }
    return { ...u, type: 'tenant', tenantId: payload.tenantId, impersonatedBy: payload.impersonatedBy };
  }

  if (!u) return null;
  const tenant = await db.selectFrom('tenants').select('name').where('id', '=', payload.tenantId).executeTakeFirst();
  return { ...u, type: 'tenant', tenantId: payload.tenantId, tenant_name: tenant?.name ?? null };
}
