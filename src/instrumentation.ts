// Runs once at server startup (Next.js instrumentation hook).
// Importing env.ts validates all required environment variables and throws
// loudly if any are missing — satisfying the fail-fast requirement.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/env');
  }
}
