import type { ControlledTransaction } from 'kysely';
import { randomUUID } from 'crypto';
import type { Db } from './client';

/**
 * Run `fn` inside a transaction — or, if `db` is already inside one (`db.isTransaction`),
 * inside a named SAVEPOINT instead, committing/rolling back only to that savepoint. Never
 * escapes an already-open enclosing transaction's own eventual commit/rollback.
 *
 * This is the same nesting-safe pattern `TenantDB.transaction()` uses (see its docstring for
 * why Kysely's simple callback-style `.transaction().execute()` doesn't support this —
 * calling it again on an already-open transaction throws), generalized here for RAW
 * (non-tenant-scoped) Kysely usage. Platform-scoped services that open their own transaction
 * outside TenantDB — password-reset.ts today, tenants.ts/provisioning.ts/templates.ts in
 * later stages — need the identical safety: they can be called from inside a test's wrapper
 * transaction, or from inside another already-open transaction, same as any TenantDB consumer.
 *
 * Found by actually testing Stage 3, not by inspection: confirmPasswordReset's first version
 * called `db.startTransaction()` directly and threw "calling the controlled transaction
 * method for a Transaction is not supported" the moment it ran inside a test (which wraps
 * every test in its own transaction). This helper — and TenantDB.transaction() delegating to
 * it — is the fix; every future raw-transaction call site should use this, not open one itself.
 */
export async function withTransaction<T>(db: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  if (db.isTransaction) {
    const savepointName = `sp_${randomUUID().replace(/-/g, '_')}`;
    const ctrl = db as unknown as ControlledTransaction<any>;
    const nested = await ctrl.savepoint(savepointName).execute();
    try {
      const result = await fn(nested);
      await nested.releaseSavepoint(savepointName).execute();
      return result;
    } catch (err) {
      await nested.rollbackToSavepoint(savepointName).execute();
      throw err;
    }
  }

  const trx = await db.startTransaction().execute();
  try {
    const result = await fn(trx);
    await trx.commit().execute();
    return result;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}
