// Runs once at server startup (Next.js instrumentation hook).
// Importing env.ts validates all required environment variables and throws
// loudly if any are missing — satisfying the fail-fast requirement.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/env');
    // Error monitoring + structured logging up first, so startup failures are captured.
    const { initObservability } = await import('@/lib/observability');
    initObservability();
    const { getRawDb } = await import('@/lib/db/client');
    const { seedTemplates } = await import('@/lib/requirements/templates');
    const db = getRawDb();
    seedTemplates(db);

    // Start the in-process background workers (notification sender, daily digest cycle,
    // retention sweep, billing quantity sync). Dynamic imports keep them out of the edge bundle.
    const { defaultMailer } = await import('@/lib/notifications/mailer');
    const { defaultBillingProvider } = await import('@/lib/billing/stripe');
    const { startAllWorkers } = await import('@/lib/workers/bootstrap');
    startAllWorkers(defaultMailer, db, defaultBillingProvider);
  }
}
