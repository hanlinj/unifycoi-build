import type Database from 'better-sqlite3';
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
 */
export function loginWithEmail(
  db: Database.Database,
  email: string,
  password: string,
  tenantId?: string
): LoginResult | null {
  if (!email || !password) return null;

  if (tenantId) {
    // Tenant user login
    const tenant = db
      .prepare('SELECT id, lifecycle_state FROM tenants WHERE id = ?')
      .get(tenantId) as { id: string; lifecycle_state: string } | undefined;

    if (!tenant) return null;
    if (tenant.lifecycle_state === 'suspended' || tenant.lifecycle_state === 'offboarded') {
      return null; // tenant access frozen
    }

    const user = db
      .prepare(
        "SELECT id, email, name, role, password_hash, status FROM users WHERE tenant_id = ? AND email = ? COLLATE NOCASE"
      )
      .get(tenantId, email) as
      | { id: string; email: string; name: string; role: string; password_hash: string | null; status: string }
      | undefined;

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
  const platformUser = db
    .prepare(
      'SELECT id, email, name, role, password_hash FROM platform_users WHERE email = ? COLLATE NOCASE'
    )
    .get(email) as
    | { id: string; email: string; name: string; role: string; password_hash: string }
    | undefined;

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
export function loginResolvingTenant(
  db: Database.Database,
  email: string,
  password: string,
  tenantId?: string
): LoginResult | null {
  if (!email || !password) return null;
  if (tenantId) return loginWithEmail(db, email, password, tenantId);

  const platform = loginWithEmail(db, email, password); // platform path (no tenantId)
  if (platform) return platform;

  const rows = db
    .prepare('SELECT DISTINCT tenant_id FROM users WHERE email = ? COLLATE NOCASE')
    .all(email) as { tenant_id: string }[];
  for (const r of rows) {
    const res = loginWithEmail(db, email, password, r.tenant_id);
    if (res) return res;
  }
  return null;
}

export function getMeInfo(
  db: Database.Database,
  payload: TokenPayload
): Record<string, unknown> | null {
  if (payload.type === 'platform') {
    const u = db
      .prepare('SELECT id, email, name, role, created_at FROM platform_users WHERE id = ?')
      .get(payload.sub) as { id: string; email: string; name: string; role: string; created_at: string } | undefined;
    if (!u) return null;
    return { ...u, type: 'platform' };
  }

  // tenant user (including impersonation)
  if (!payload.tenantId) return null;
  const u = db
    .prepare('SELECT id, email, name, role, status, created_at FROM users WHERE id = ? AND tenant_id = ?')
    .get(payload.sub, payload.tenantId) as
    | { id: string; email: string; name: string; role: string; status: string; created_at: string }
    | undefined;

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
  return { ...u, type: 'tenant', tenantId: payload.tenantId };
}
