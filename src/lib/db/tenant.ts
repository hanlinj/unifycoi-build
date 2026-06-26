import type Database from 'better-sqlite3';

/**
 * TenantDB — the only permitted gateway for reads and writes on tenant-scoped tables.
 *
 * Every method automatically injects this.tenantId so callers can never forget it.
 * Use the named helpers for all mutations:
 *   insert(table, row)            — tenant_id is always set; column order is irrelevant.
 *   update(table, set, where)     — tenant_id = ? is always appended to WHERE.
 *   del(table, where)             — same WHERE guarantee as update().
 *
 * Platform-scoped tables (platform_users, tenants, requirement_templates) have no
 * tenant_id column and MUST use raw db.prepare() directly — never TenantDB.
 *
 * The low-level get() / all() methods remain for SELECT statements that cannot be
 * expressed through the named helpers (e.g. JOINs, COLLATE NOCASE). Their contract:
 * SQL must have `tenant_id = ?` as the first placeholder.
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

  // ─── Reads ────────────────────────────────────────────────────────────────────

  /** SELECT returning multiple rows. First ? must be the tenant_id placeholder. */
  all<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(this.tenantId, ...params) as T[];
  }

  /** SELECT returning one row. First ? must be the tenant_id placeholder. */
  get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(this.tenantId, ...params) as T | undefined;
  }

  // ─── Writes ───────────────────────────────────────────────────────────────────

  /**
   * INSERT INTO table. tenant_id is always written as this.tenantId regardless of
   * column order in `row`. Throws if `row` includes tenant_id with a conflicting value.
   * Pass { orIgnore: true } to emit INSERT OR IGNORE.
   */
  insert(
    table: string,
    row: Record<string, unknown>,
    opts: { orIgnore?: boolean } = {}
  ): Database.RunResult {
    if ('tenant_id' in row && row['tenant_id'] !== this.tenantId) {
      throw new Error(
        `TenantDB.insert: row.tenant_id "${row['tenant_id']}" conflicts with bound tenantId "${this.tenantId}"`
      );
    }
    const { tenant_id: _stripped, ...rest } = row;
    const cols = ['tenant_id', ...Object.keys(rest)];
    const values = [this.tenantId, ...Object.values(rest)];
    const placeholders = cols.map(() => '?').join(', ');
    const or = opts.orIgnore ? 'OR IGNORE ' : '';
    return this.db.prepare(`INSERT ${or}INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
  }

  /**
   * UPDATE table SET ... WHERE tenant_id = ? AND <where>.
   * tenant_id is always appended to WHERE — callers cannot omit it.
   * Throws if either `set` or `where` is empty.
   */
  update(
    table: string,
    set: Record<string, unknown>,
    where: Record<string, unknown>
  ): Database.RunResult {
    if (Object.keys(set).length === 0) throw new Error('TenantDB.update: set object must not be empty');
    if (Object.keys(where).length === 0) throw new Error('TenantDB.update: where object must not be empty');

    const setClause = Object.keys(set).map((c) => `${c} = ?`).join(', ');
    const whereClause = ['tenant_id = ?', ...Object.keys(where).map((c) => `${c} = ?`)].join(' AND ');
    const values = [...Object.values(set), this.tenantId, ...Object.values(where)];
    return this.db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`).run(...values);
  }

  /**
   * DELETE FROM table WHERE tenant_id = ? AND <where>.
   * tenant_id is always included — callers cannot omit it.
   * Throws if `where` is empty (prevents accidental full-table deletes).
   */
  del(
    table: string,
    where: Record<string, unknown>
  ): Database.RunResult {
    if (Object.keys(where).length === 0) throw new Error('TenantDB.del: where object must not be empty');

    const whereClause = ['tenant_id = ?', ...Object.keys(where).map((c) => `${c} = ?`)].join(' AND ');
    const values = [this.tenantId, ...Object.values(where)];
    return this.db.prepare(`DELETE FROM ${table} WHERE ${whereClause}`).run(...values);
  }

  // ─── Transaction ──────────────────────────────────────────────────────────────

  /** Execute multiple statements atomically. */
  transaction<T>(fn: (tdb: TenantDB) => T): T {
    return this.db.transaction(() => fn(this))();
  }
}

export function createTenantDb(db: Database.Database, tenantId: string): TenantDB {
  return new TenantDB(db, tenantId);
}
