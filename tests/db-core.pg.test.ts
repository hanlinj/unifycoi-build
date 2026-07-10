// tests/db-core.pg.test.ts — Phase 13 migration, Stage 1: verifies db-core (client.ts,
// tenant.ts, migrate.ts, test-isolation.ts) against real Postgres, in isolation from the rest
// of the suite. Needs .env's DATABASE_URL/PG_* (not set by tests/setup.ts, which is scoped to
// SQLite/filesystem — this file loads .env itself, same pattern as db-postgres/'s old proof
// scripts and the migrate/seed:dev CLI scripts).
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { setupTestDb, teardownTestDb, teardownTestDatabase } from './helpers';
import { TenantDB } from '@/lib/db/tenant';
import { runMigrations } from '@/lib/db/migrate';
import { kyselyFor } from '@/lib/db/test-isolation';
import type { Db } from '@/lib/db/client';

describe('db-core (Stage 1): TenantDB against Postgres', () => {
  let db: Db;
  const tenantId = randomUUID();

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insertInto('tenants').values({ id: tenantId, name: 'Test Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
  });

  afterEach(async () => {
    await teardownTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  test('insert() writes tenant_id automatically; get()/all() read it back with $1 bound to tenantId', async () => {
    const tdb = new TenantDB(db, tenantId);
    await tdb.insert('locations', { id: 'loc-1', name: 'Store A', status: 'active', created_at: new Date() });
    const row = await tdb.get<{ id: string; name: string }>('SELECT id, name FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-1']);
    expect(row?.name).toBe('Store A');
    const rows = await tdb.all<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1', []);
    expect(rows).toHaveLength(1);
  });

  test('insert() throws if row.tenant_id conflicts with the bound tenantId', async () => {
    const tdb = new TenantDB(db, tenantId);
    await expect(
      tdb.insert('locations', { id: 'loc-x', tenant_id: 'someone-else', name: 'X', status: 'active', created_at: new Date() })
    ).rejects.toThrow(/conflicts with bound tenantId/);
  });

  test('update()/del() always AND tenant_id — a different tenant\'s row with the same real id is untouched', async () => {
    // locations.id is a globally-unique PK (not per-tenant), so two tenants can't literally
    // share one id row — the guarantee this proves instead: calling update()/del() through the
    // WRONG tenant's TenantDB (i.e. targeting another tenant's real row by its real id) affects
    // zero rows, because tenant_id is always ANDed into the WHERE and can never be bypassed.
    const otherTenantId = randomUUID();
    await db.insertInto('tenants').values({ id: otherTenantId, name: 'Other Tenant', lifecycle_state: 'active', monthly_rate_cents: 9000, created_at: new Date() }).execute();
    const tdb = new TenantDB(db, tenantId);
    const otherTdb = new TenantDB(db, otherTenantId);
    await otherTdb.insert('locations', { id: 'loc-belongs-to-other', name: 'Theirs', status: 'active', created_at: new Date() });

    await tdb.update('locations', { status: 'archived' }, { id: 'loc-belongs-to-other' }); // wrong tenant — should affect 0 rows

    const theirs = await otherTdb.get<{ status: string }>('SELECT status FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-belongs-to-other']);
    expect(theirs?.status).toBe('active'); // untouched by tdb.update(), even though the id matched

    await tdb.del('locations', { id: 'loc-belongs-to-other' }); // wrong tenant — should delete 0 rows
    const stillThere = await otherTdb.get('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-belongs-to-other']);
    expect(stillThere).toBeDefined(); // del() scoped to tdb's tenant only — other tenant's row survives
  });

  test('update()/del() throw on empty set/where (accidental full-table guard)', async () => {
    const tdb = new TenantDB(db, tenantId);
    await expect(tdb.update('locations', {}, { id: 'x' })).rejects.toThrow(/set object must not be empty/);
    await expect(tdb.update('locations', { status: 'x' }, {})).rejects.toThrow(/where object must not be empty/);
    await expect(tdb.del('locations', {})).rejects.toThrow(/where object must not be empty/);
  });

  test('insert() with orIgnore does not throw on a duplicate unique key, and does not duplicate the row', async () => {
    const tdb = new TenantDB(db, tenantId);
    await tdb.insert('user_regions', { user_id: 'u1', region_id: 'r1' });
    await expect(tdb.insert('user_regions', { user_id: 'u1', region_id: 'r1' }, { orIgnore: true })).resolves.not.toThrow();
    const rows = await tdb.all<{ user_id: string }>('SELECT user_id FROM user_regions WHERE tenant_id = $1', []);
    expect(rows).toHaveLength(1);
  });

  test('transaction() commits when fn resolves', async () => {
    const tdb = new TenantDB(db, tenantId);
    await tdb.transaction(async (txTdb) => {
      await txTdb.insert('locations', { id: 'loc-tx', name: 'Tx Store', status: 'active', created_at: new Date() });
    });
    const row = await tdb.get<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-tx']);
    expect(row?.id).toBe('loc-tx');
  });

  test('transaction() rolls back everything if fn throws', async () => {
    const tdb = new TenantDB(db, tenantId);
    await expect(
      tdb.transaction(async (txTdb) => {
        await txTdb.insert('locations', { id: 'loc-fail', name: 'Fail Store', status: 'active', created_at: new Date() });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const row = await tdb.get('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-fail']);
    expect(row).toBeUndefined();
  });

  test('transaction() nests via savepoint when called from inside another transaction (the Stage 0 finding)', async () => {
    const tdb = new TenantDB(db, tenantId);
    await tdb.transaction(async (outerTdb) => {
      await outerTdb.insert('locations', { id: 'loc-outer', name: 'Outer', status: 'active', created_at: new Date() });
      await outerTdb.transaction(async (innerTdb) => {
        await innerTdb.insert('locations', { id: 'loc-inner', name: 'Inner (nested)', status: 'active', created_at: new Date() });
      });
      const both = await outerTdb.all("SELECT id FROM locations WHERE tenant_id = $1 AND id IN ('loc-outer','loc-inner')", []);
      expect(both).toHaveLength(2);
    });
    const afterCommit = await tdb.all("SELECT id FROM locations WHERE tenant_id = $1 AND id IN ('loc-outer','loc-inner')", []);
    expect(afterCommit).toHaveLength(2); // both survived the outer commit
  });

  test('nested transaction() rolls back only to its savepoint if the INNER fn throws — outer stays usable and keeps its own writes', async () => {
    const tdb = new TenantDB(db, tenantId);
    await tdb.transaction(async (outerTdb) => {
      await outerTdb.insert('locations', { id: 'loc-survives', name: 'Survives', status: 'active', created_at: new Date() });

      await expect(
        outerTdb.transaction(async (innerTdb) => {
          await innerTdb.insert('locations', { id: 'loc-doomed', name: 'Doomed', status: 'active', created_at: new Date() });
          throw new Error('inner boom');
        })
      ).rejects.toThrow('inner boom');

      // The outer transaction must still be usable after the inner savepoint rolled back —
      // this is the whole point of using a savepoint instead of failing the outer transaction.
      const survivor = await outerTdb.get<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-survives']);
      const doomed = await outerTdb.get('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-doomed']);
      expect(survivor?.id).toBe('loc-survives');
      expect(doomed).toBeUndefined();
    });
    const survivorAfterCommit = await tdb.get<{ id: string }>('SELECT id FROM locations WHERE tenant_id = $1 AND id = $2', ['loc-survives']);
    expect(survivorAfterCommit?.id).toBe('loc-survives');
  });
});

describe('db-core (Stage 1): migration runner', () => {
  test('runMigrations() applies 001_baseline cleanly to a genuinely empty database (not cloned from the pre-migrated template)', async () => {
    const name = `migtest_${randomUUID().replace(/-/g, '')}`;
    const admin = kyselyFor('postgres');
    await sql`CREATE DATABASE ${sql.id(name)}`.execute(admin); // no TEMPLATE — truly empty, unlike createEphemeralTestDatabase()
    await admin.destroy();

    const fresh = kyselyFor(name);
    try {
      await runMigrations(fresh);
      const tables = await sql<{ count: string }>`SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public'`.execute(fresh);
      expect(Number(tables.rows[0]?.count)).toBe(25); // 24 app tables + _migrations

      const applied = await fresh.selectFrom('_migrations').select('name').execute();
      expect(applied.map((r: { name: string }) => r.name)).toEqual(['001_baseline.ts']);

      // Running it again is a no-op — proves the applied-tracking actually works, not just
      // that the migration happens to be idempotent on its own.
      await expect(runMigrations(fresh)).resolves.not.toThrow();
    } finally {
      await fresh.destroy();
      const admin2 = kyselyFor('postgres');
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`.execute(admin2);
      await sql`DROP DATABASE IF EXISTS ${sql.id(name)}`.execute(admin2);
      await admin2.destroy();
    }
  });
});
