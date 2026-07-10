// db-postgres/apply-baseline.ts — apply the fresh baseline to a named database.
// Run: npx tsx db-postgres/apply-baseline.ts <database-name>
//
// Used once against PG_DEV_DATABASE (so dev has real tables) and once against
// PG_TEST_TEMPLATE_DATABASE (so ephemeral per-run test databases inherit the schema on clone).
// Never run this against an ephemeral test database directly — those get the schema for free
// via CREATE DATABASE ... TEMPLATE.

import 'dotenv/config';
import { kyselyFor } from './test-isolation';
import { up as applyBaseline } from './migrations/001_baseline';

async function main() {
  const database = process.argv[2];
  if (!database) {
    console.error('Usage: npx tsx db-postgres/apply-baseline.ts <database-name>');
    process.exit(1);
  }
  const db = kyselyFor(database);
  try {
    console.log(`Applying 001_baseline to "${database}"...`);
    await applyBaseline(db);
    console.log('✓ done');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('❌ apply-baseline FAILED:', err);
  process.exit(1);
});
