import type Database from 'better-sqlite3';

/**
 * TenantDB — the only gateway for tenant-scoped reads and writes.
 *
 * Construction requires a non-empty tenantId; all query methods prepend it as
 * the first bound parameter. SQL for tenant tables must have `tenant_id = ?`
 * as the first placeholder. This makes cross-tenant reads structurally
 * impossible: you cannot obtain a TenantDB without a tenantId, and every
 * statement run through it binds that tenantId automatically.
 */
export class TenantDB {
  readonly tenantId: string;
  private readonly db: Database.Database;

  constructor(db: Database.Database, tenantId: string) {
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('TenantDB requires a non-empty tenantId');
    }
    this.db = db;
    this.tenantId = tenantId;
  }

  /** SELECT returning multiple rows. SQL must bind tenant_id as first ?. */
  all<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(this.tenantId, ...params) as T[];
  }

  /** SELECT returning one row or undefined. SQL must bind tenant_id as first ?. */
  get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(this.tenantId, ...params) as T | undefined;
  }

  /** INSERT / UPDATE / DELETE. SQL must bind tenant_id as first ?. */
  run(sql: string, params: unknown[] = []): Database.RunResult {
    return this.db.prepare(sql).run(this.tenantId, ...params);
  }

  /** Execute multiple statements atomically. */
  transaction<T>(fn: (tdb: TenantDB) => T): T {
    return this.db.transaction(() => fn(this))();
  }
}

export function createTenantDb(db: Database.Database, tenantId: string): TenantDB {
  return new TenantDB(db, tenantId);
}
