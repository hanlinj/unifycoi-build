import { CompiledQuery, type ControlledTransaction } from 'kysely';
import { randomUUID } from 'crypto';
import type { Db } from './client';

/**
 * TenantDB — the only permitted gateway for reads and writes on tenant-scoped tables.
 * Phase 13 migration, Stage 1: rewritten on Kysely/Postgres. All methods are now async.
 *
 * Every method automatically injects this.tenantId so callers can never forget it.
 * Use the named helpers for ALL mutations on tenant-scoped tables:
 *
 *   insert(table, row)            — tenant_id is always written as this.tenantId,
 *                                   regardless of column order in the row object.
 *   update(table, set, where)     — tenant_id = this.tenantId is always added to WHERE;
 *                                   callers cannot omit it accidentally.
 *   del(table, where)             — same WHERE guarantee; empty where throws.
 *
 * Platform-scoped tables (platform_users, tenants, requirement_templates) have no
 * tenant_id column and MUST use raw Kysely queries directly — never TenantDB.
 *
 * The low-level all()/get() methods remain for reads that cannot be expressed through the
 * named helpers (JOINs, etc.) — Postgres raw-SQL contract (changed from the SQLite era):
 * write the query with $1 reserved for tenant_id (bound automatically) and your own params
 * as $2, $3, ... — same "tenant_id is always first" mental model as before, just Postgres's
 * numbered-placeholder syntax instead of SQLite's bare `?`.
 *
 * ── Transaction nesting (Stage 0's proof-driven finding) ──────────────────────────────────
 * Kysely's simple callback-style `.transaction().execute()` does NOT support being called
 * again on an already-open transaction — it throws. Real nesting requires the CONTROLLED
 * transaction API (`db.startTransaction().execute()` + `.savepoint(name)`), so transaction()
 * below ALWAYS uses that API, never the simple callback form — both when opening fresh and
 * when detecting it's already nested (via `this.db.isTransaction`). This is why the cast to
 * `ControlledTransaction` in the nested branch is safe: nothing in this codebase is allowed
 * to construct a TenantDB over a plain callback-style `Transaction` — only over a `Db`
 * (not yet a transaction) or a `ControlledTransaction` this same method (or the test harness's
 * withTestTransaction, built the same way) produced. Breaking that invariant elsewhere would
 * make the cast unsound — don't introduce a `.transaction().execute()` call anywhere that
 * hands its callback's `trx` to a TenantDB.
 */
export class TenantDB {
  readonly tenantId: string;
  private readonly db: Db;

  constructor(db: Db, tenantId: string) {
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('TenantDB requires a non-empty tenantId');
    }
    this.db = db;
    this.tenantId = tenantId;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────────

  /** SELECT returning multiple rows. $1 is bound to tenantId; write your own params as $2, $3, ... */
  async all<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.executeQuery<T>(CompiledQuery.raw(query, [this.tenantId, ...params]));
    return [...result.rows];
  }

  /** SELECT returning one row. Same $1-is-tenantId contract as all(). */
  async get<T = unknown>(query: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(query, params);
    return rows[0];
  }

  // ─── Writes ───────────────────────────────────────────────────────────────────

  /**
   * INSERT INTO table. tenant_id is always written as this.tenantId regardless of
   * column order in `row`. Throws if `row` includes tenant_id with a conflicting value.
   * Pass { orIgnore: true } for INSERT ... ON CONFLICT DO NOTHING (no conflict target
   * specified — matches SQLite's INSERT OR IGNORE, which also silently skips on ANY
   * unique/exclusion constraint violation, not one specific one).
   */
  async insert(table: string, row: Record<string, unknown>, opts: { orIgnore?: boolean } = {}): Promise<void> {
    if ('tenant_id' in row && row['tenant_id'] !== this.tenantId) {
      throw new Error(`TenantDB.insert: row.tenant_id "${row['tenant_id']}" conflicts with bound tenantId "${this.tenantId}"`);
    }
    const { tenant_id: _stripped, ...rest } = row;
    const values = { tenant_id: this.tenantId, ...rest };
    let query = this.db.insertInto(table).values(values);
    if (opts.orIgnore) {
      query = query.onConflict((oc: import('kysely').OnConflictBuilder<any, any>) => oc.doNothing());
    }
    await query.execute();
  }

  /**
   * UPDATE table SET ... WHERE tenant_id = this.tenantId AND <where>.
   * tenant_id is always included in WHERE — callers cannot omit it.
   * Throws if either `set` or `where` is empty.
   */
  async update(table: string, set: Record<string, unknown>, where: Record<string, unknown>): Promise<void> {
    if (Object.keys(set).length === 0) throw new Error('TenantDB.update: set object must not be empty');
    if (Object.keys(where).length === 0) throw new Error('TenantDB.update: where object must not be empty');

    let query = this.db.updateTable(table).set(set).where('tenant_id', '=', this.tenantId);
    for (const [col, val] of Object.entries(where)) {
      query = query.where(col, '=', val);
    }
    await query.execute();
  }

  /**
   * DELETE FROM table WHERE tenant_id = this.tenantId AND <where>.
   * tenant_id is always included — callers cannot omit it.
   * Throws if `where` is empty (prevents accidental full-table deletes).
   */
  async del(table: string, where: Record<string, unknown>): Promise<void> {
    if (Object.keys(where).length === 0) throw new Error('TenantDB.del: where object must not be empty');

    let query = this.db.deleteFrom(table).where('tenant_id', '=', this.tenantId);
    for (const [col, val] of Object.entries(where)) {
      query = query.where(col, '=', val);
    }
    await query.execute();
  }

  // ─── Transaction (see the class docstring for the nesting/savepoint invariant) ─

  /**
   * Execute multiple statements atomically. If already inside a transaction (this.db.isTransaction),
   * takes a SAVEPOINT instead of opening a new one — commits/rolls back to the savepoint, never
   * escapes the enclosing transaction's own eventual commit/rollback.
   */
  async transaction<T>(fn: (tdb: TenantDB) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) {
      const savepointName = `sp_${randomUUID().replace(/-/g, '_')}`;
      const ctrl = this.db as unknown as ControlledTransaction<any>;
      const nested = await ctrl.savepoint(savepointName).execute();
      try {
        const result = await fn(new TenantDB(nested, this.tenantId));
        await nested.releaseSavepoint(savepointName).execute();
        return result;
      } catch (err) {
        await nested.rollbackToSavepoint(savepointName).execute();
        throw err;
      }
    }

    const trx = await this.db.startTransaction().execute();
    try {
      const result = await fn(new TenantDB(trx, this.tenantId));
      await trx.commit().execute();
      return result;
    } catch (err) {
      await trx.rollback().execute();
      throw err;
    }
  }
}

export function createTenantDb(db: Db, tenantId: string): TenantDB {
  return new TenantDB(db, tenantId);
}
