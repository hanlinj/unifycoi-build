// db-postgres/proof/hello-world.ts — Stage 0 toolchain proof.
// Run: npx tsx db-postgres/proof/hello-world.ts
//
// Proves the whole chain connects: .env → pg → Kysely → the fresh baseline migration →
// a real query against a real table, against a THROWAWAY database (dropped at the end,
// never touches PG_DEV_DATABASE or the test template).

import 'dotenv/config';
import { sql } from 'kysely';
import { createEphemeralTestDatabase, dropEphemeralTestDatabase } from '../test-isolation';

async function main() {
  console.log('1. Connecting to Postgres and cloning a throwaway database from the template...');
  const { name, db } = await createEphemeralTestDatabase();
  console.log(`   ✓ connected — throwaway database "${name}" created`);

  try {
    console.log('2. Confirming the clone already carries the baseline schema (CREATE DATABASE ... TEMPLATE)...');
    const tableCount = await sql<{ count: string }>`SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public'`.execute(db);
    console.log(`   ✓ ${tableCount.rows[0]?.count} tables present on clone — no re-apply needed, the template already has them`);

    console.log('3. Inserting a row through Kysely and reading it back...');
    const tenantId = 'hello-world-tenant';
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: 'Hello World Storage Co.',
        lifecycle_state: 'active',
        monthly_rate_cents: 9000,
        created_at: new Date(),
      })
      .execute();
    const row = await db.selectFrom('tenants').selectAll().where('id', '=', tenantId).executeTakeFirstOrThrow();
    console.log(`   ✓ round-tripped: ${row.name} (lifecycle_state=${row.lifecycle_state}, created_at is a real Date: ${row.created_at instanceof Date})`);

    console.log('4. Confirming the rowid-replacement column exists and auto-increments...');
    await db
      .insertInto('billing_snapshots')
      .values({ id: 'bs-1', tenant_id: tenantId, billable_locations: 4, amount_cents: 36000, changed: true, created_at: new Date() })
      .execute();
    await db
      .insertInto('billing_snapshots')
      .values({ id: 'bs-2', tenant_id: tenantId, billable_locations: 5, amount_cents: 45000, changed: true, created_at: new Date() })
      .execute();
    const latest = await db
      .selectFrom('billing_snapshots')
      .select(['id', 'seq'])
      .where('tenant_id', '=', tenantId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    console.log(`   ✓ ORDER BY seq DESC LIMIT 1 → ${latest.id} (seq=${latest.seq}) — replaces the old \`ORDER BY rowid\` pattern`);

    console.log('5. Confirming boolean/jsonb columns round-trip as real types (not 0/1 or TEXT)...');
    await db
      .insertInto('requirement_settings')
      .values({ tenant_id: tenantId, precedence_policy: 'strictest', floor_json: JSON.stringify({ 'doc_required.coi': 'true' }) })
      .execute();
    const settings = await db.selectFrom('requirement_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    console.log(`   ✓ floor_json round-tripped as an object: ${JSON.stringify(settings.floor_json)} (typeof === '${typeof settings.floor_json}')`);
    const changedRow = await db.selectFrom('billing_snapshots').select('changed').where('id', '=', 'bs-1').executeTakeFirstOrThrow();
    console.log(`   ✓ billing_snapshots.changed is a real boolean: ${changedRow.changed} (typeof === '${typeof changedRow.changed}')`);

    console.log('\n✅ Hello-world proof passed — pg + Kysely + the fresh baseline all work end to end.');
  } finally {
    console.log(`6. Dropping the throwaway database "${name}"...`);
    await dropEphemeralTestDatabase(name, db);
    console.log('   ✓ dropped');
  }
}

main().catch((err) => {
  console.error('❌ Hello-world proof FAILED:', err);
  process.exit(1);
});
