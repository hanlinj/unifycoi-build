import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { hashPassword } from '@/lib/auth/password';

export function setupTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const migrationsDir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
  }

  return db;
}

export function seedPlatformUser(
  db: Database.Database,
  overrides: Partial<{ id: string; email: string; name: string; role: string; password: string }> = {}
): { id: string; email: string; name: string; role: string; password: string } {
  const user = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? 'platform@unifycoi.com',
    name: overrides.name ?? 'Platform Owner',
    role: overrides.role ?? 'owner',
    password: overrides.password ?? 'securepassword123',
  };
  db.prepare(
    'INSERT INTO platform_users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user.id, user.email, user.name, user.role, hashPassword(user.password), new Date().toISOString());
  return user;
}

export function seedTenant(
  db: Database.Database,
  overrides: Partial<{ id: string; name: string; lifecycle_state: string }> = {}
): { id: string; name: string; lifecycle_state: string } {
  const tenant = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Tenant',
    lifecycle_state: overrides.lifecycle_state ?? 'active',
  };
  db.prepare(
    'INSERT INTO tenants (id, name, lifecycle_state, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenant.id, tenant.name, tenant.lifecycle_state, 9000, new Date().toISOString());
  return tenant;
}

export function seedTenantUser(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ id: string; email: string; name: string; role: string; password: string; status: string }> = {}
): { id: string; email: string; name: string; role: string; tenantId: string } {
  const user = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.com`,
    name: overrides.name ?? 'Test User',
    role: overrides.role ?? 'admin',
    status: overrides.status ?? 'active',
    password: overrides.password ?? 'securepassword123',
    tenantId,
  };
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(user.id, tenantId, user.email, user.name, user.role, hashPassword(user.password), user.status, new Date().toISOString());
  return user;
}

export function seedRegion(
  db: Database.Database,
  tenantId: string,
  name = 'North Region'
): { id: string; name: string } {
  const id = randomUUID();
  db.prepare('INSERT INTO regions (id, tenant_id, name) VALUES (?, ?, ?)').run(id, tenantId, name);
  return { id, name };
}

export function seedLocation(
  db: Database.Database,
  tenantId: string,
  overrides: Partial<{ id: string; name: string; regionId: string; status: string }> = {}
): { id: string; name: string; tenantId: string } {
  const loc = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? `Store-${randomUUID().slice(0, 6)}`,
    regionId: overrides.regionId ?? null,
    status: overrides.status ?? 'active',
    tenantId,
  };
  db.prepare(
    'INSERT INTO locations (id, tenant_id, region_id, name, address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(loc.id, tenantId, loc.regionId, loc.name, '123 Main St', loc.status, new Date().toISOString());
  return loc;
}

export function assignUserToRegion(db: Database.Database, userId: string, regionId: string, tenantId: string): void {
  db.prepare('INSERT OR IGNORE INTO user_regions (user_id, region_id, tenant_id) VALUES (?, ?, ?)').run(userId, regionId, tenantId);
}

export function assignUserToLocation(db: Database.Database, userId: string, locationId: string, tenantId: string): void {
  db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id, tenant_id) VALUES (?, ?, ?)').run(userId, locationId, tenantId);
}
