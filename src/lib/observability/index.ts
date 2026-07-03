// Observability (OPS-12): Sentry error capture + pino structured logging (JSON → stdout).
// Sentry is host-agnostic and gated on SENTRY_DSN; when unset (dev/test/CI) capture is a
// pino-only no-op. The beforeSend scrub (scrubEvent) is a HARD guarantee — nothing reaches
// Sentry without passing it. Distinct security alerts (SEC-16 / OPS-3) route through
// captureSecurityAlert with IDs-only context.

import * as Sentry from '@sentry/node';
import pino, { type Logger } from 'pino';
import { env } from '@/lib/env';
import { scrubEvent, scrubValue } from './scrub';

let logger: Logger | null = null;
function getLogger(): Logger {
  if (!logger) logger = pino({ level: env.observability.logLevel });
  return logger;
}

let sentryReady = false;

/** Initialize Sentry + the logger. Called once at server startup (instrumentation.ts). */
export function initObservability(): void {
  getLogger();
  if (env.observability.sentryDsn && !sentryReady) {
    Sentry.init({
      dsn: env.observability.sentryDsn,
      environment: env.observability.environment,
      // Hard scrub: the whole event (message, exception, breadcrumbs, request, extra,
      // contexts, tags) is walked and Sensitive values redacted before it can leave.
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (t) => scrubEvent(t),
      beforeBreadcrumb: (bc) => scrubEvent(bc),
    });
    sentryReady = true;
  }
}

/** For tests: whether Sentry is active (DSN configured). */
export function isSentryEnabled(): boolean {
  return sentryReady;
}

function serializeErr(err: unknown): Record<string, unknown> {
  const base = err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
  return scrubValue(base) as Record<string, unknown>;
}

/** Capture an unexpected error. Context is scrubbed for the log; Sentry's beforeSend scrubs the event. */
export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  const scrubbed = scrubValue(context) as Record<string, unknown>;
  getLogger().error({ err: serializeErr(err), ...scrubbed }, 'error');
  if (sentryReady) Sentry.captureException(err, { extra: scrubbed });
}

/**
 * Route a named security/ops alert (SEC-16 export.sensitive_decrypt_failed; OPS-3
 * export.failed / notification.failed) to Sentry + the log. Callers pass IDs-only context;
 * scrubValue is defense-in-depth on top of that.
 */
export function captureSecurityAlert(name: string, context: Record<string, unknown> = {}): void {
  const scrubbed = scrubValue(context) as Record<string, unknown>;
  getLogger().error({ alert: name, ...scrubbed }, name);
  if (sentryReady) Sentry.captureMessage(name, { level: 'error', extra: scrubbed });
}
