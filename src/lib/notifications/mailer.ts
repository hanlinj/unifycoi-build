// Mailer — the channel seam for v1 (email only). No real ESP integration yet:
// the v1 implementation is a logged no-op that RECORDS what it was asked to send so
// tests and the worker can verify recipients, From headers, and bodies.
//
// Operator-branded vendor comms (Notifications_and_Communications.md § Branding):
// vendor-facing email From reflects the OPERATOR (the tenant), not "UnifyCOI" — the
// vendor knows the operator, not us. Internal email may carry UnifyCOI branding. The
// From identity is passed per-send (see resolveFrom).

import { env } from '@/lib/env';

export interface EmailMessage {
  to: string;
  fromName: string;   // display name in the From header — operator name for vendor mail
  fromEmail: string;  // From address
  subject: string;
  body: string;
  /** For traceability/idempotency — the notification row id this send corresponds to. */
  notificationId?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /**
   * The ESP's own message id, when the transport returns one. Persisted on the
   * notification row (provider_message_id) so the cookie-less delivery webhook can
   * correlate a bounce/complaint back to a single tenant-scoped row. The NoOp mailer
   * leaves this undefined. Additive/optional — does not change the send() contract.
   */
  providerId?: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<SendResult>;
}

/**
 * Resolve the From identity for an email.
 * - vendor-facing  → operator-branded: "<Tenant Name>" <noreply@…>
 * - internal       → UnifyCOI-branded.
 * The address domain is a v1 placeholder; real deliverability (SPF/DKIM, a per-operator
 * from-domain) is deferred with the ESP integration.
 */
export function resolveFrom(
  audience: 'vendor' | 'internal',
  operatorName: string | null,
  fromEmail: string = env.email.fromEmail
): { fromName: string; fromEmail: string } {
  if (audience === 'vendor') {
    return {
      fromName: operatorName?.trim() || 'Your Operator',
      fromEmail,
    };
  }
  return { fromName: 'UnifyCOI', fromEmail };
}

/**
 * Logged no-op Mailer. Records every send for inspection (tests, debugging) and logs
 * the would-be From header so operator-branding is verifiable without a real ESP.
 */
export class NoOpMailer implements Mailer {
  public readonly sent: EmailMessage[] = [];
  /** When set, send() returns this failure instead of recording — used to test backpressure. */
  public failNext: string | null = null;

  async send(msg: EmailMessage): Promise<SendResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return { ok: false, error };
    }
    this.sent.push(msg);
    // Structured log line — the would-be From header is the verification point.
    console.log(
      `[mailer:noop] to=${msg.to} from="${msg.fromName}" <${msg.fromEmail}> subject="${msg.subject}"`
    );
    return { ok: true };
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  }
}

// ── Resend transport ────────────────────────────────────────────────────────────
//
// The real ESP-backed Mailer (SEC-1). A thin fetch against Resend's REST API — no SDK
// dependency, so the Idempotency-Key header and error surface stay under our control and
// the whole thing mocks cleanly in tests via an injected fetch.
//
// Idempotency (SEC-2): the worker passes the notification row id as `notificationId`, and
// we hand it to Resend as the `Idempotency-Key`. Resend collapses a repeated send within
// its ~24h key-retention window — closing the crash-after-send/before-commit double-send
// window. The DURABLE guard beyond 24h is the worker itself: it only ever polls
// status='queued' rows and flips to 'sent' on success, so a sent row is never re-picked.

/** Format an RFC5322 From value, always quoting the display name (handles commas etc.). */
function formatFrom(name: string, email: string): string {
  const quoted = name.replace(/(["\\])/g, '\\$1');
  return `"${quoted}" <${email}>`;
}

export interface ResendMailerOptions {
  apiKey: string;
  /** Override for tests / self-hosted proxies. Defaults to Resend's public endpoint. */
  endpoint?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ResendMailer implements Mailer {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendMailerOptions) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint ?? 'https://api.resend.com/emails';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    // The notification row id doubles as the ESP idempotency key (SEC-2).
    if (msg.notificationId) headers['Idempotency-Key'] = msg.notificationId;

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: formatFrom(msg.fromName, msg.fromEmail),
          to: msg.to,
          subject: msg.subject,
          text: msg.body,
        }),
      });

      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          /* body already consumed / unavailable */
        }
        return { ok: false, error: `resend ${res.status}: ${detail}`.trim() };
      }

      const data = (await res.json()) as { id?: string };
      return { ok: true, providerId: data.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Default process Mailer. Resend when RESEND_API_KEY is configured (prod / staging);
 * otherwise the logged NoOp (dev / test / CI). The transport is chosen once at import.
 */
export const defaultMailer: Mailer = env.email.resendApiKey
  ? new ResendMailer({ apiKey: env.email.resendApiKey })
  : new NoOpMailer();
