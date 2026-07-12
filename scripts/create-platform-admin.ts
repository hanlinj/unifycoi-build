/**
 * create-platform-admin.ts — one-time production bootstrap for the first platform_users row.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' npm run admin:create
 *
 * Every admin-creation path in the app requires an existing platform user, so the very first
 * one has to be inserted directly. Reuses the app's real hashPassword() (same as dev-seed.ts)
 * so the created admin can actually log in. Reads DATABASE_URL from the environment like
 * migrate.ts does, so it can target Railway. Does nothing else — no fixtures, no tenants.
 *
 * Credentials are read from env vars, not argv, so the password never lands in shell history.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getDb, closeDb } from '../src/lib/db/client';
import { hashPassword } from '../src/lib/auth/password';

async function main(): Promise<void> {
  const email = process.env['ADMIN_EMAIL'];
  const name = process.env['ADMIN_NAME'];
  const password = process.env['ADMIN_PASSWORD'];

  if (!email || !name || !password) {
    console.error('Usage: ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD=... npm run admin:create');
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.toLowerCase();
  const db = getDb();
  try {
    const existing = await db
      .selectFrom('platform_users')
      .select('id')
      .where('email', '=', normalizedEmail)
      .executeTakeFirst();

    if (existing) {
      console.log(`Admin already exists: ${normalizedEmail} (id ${existing.id}). Nothing to do.`);
      return;
    }

    await db
      .insertInto('platform_users')
      .values({
        id: randomUUID(),
        email: normalizedEmail,
        name,
        role: 'owner',
        password_hash: hashPassword(password),
        created_at: new Date(),
      })
      .execute();

    console.log(`Created platform admin: ${normalizedEmail}`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
