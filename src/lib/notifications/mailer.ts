// Mailer — the channel seam for v1 (email only). No real ESP integration yet:
// the v1 implementation is a logged no-op that RECORDS what it was asked to send so
// tests and the worker can verify recipients, From headers, and bodies.
//
// Operator-branded vendor comms (Notifications_and_Communications.md § Branding):
// vendor-facing email From reflects the OPERATOR (the tenant), not "UnifyCOI" — the
// vendor knows the operator, not us. Internal email may carry UnifyCOI branding. The
// From identity is passed per-send (see resolveFrom).

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
  operatorName: string | null
): { fromName: string; fromEmail: string } {
  if (audience === 'vendor') {
    return {
      fromName: operatorName?.trim() || 'Your Operator',
      fromEmail: 'noreply@unifycoi-mail.com',
    };
  }
  return { fromName: 'UnifyCOI', fromEmail: 'noreply@unifycoi-mail.com' };
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

/** Default process Mailer (v1: the no-op). Swap to a real ESP-backed impl later. */
export const defaultMailer: Mailer = new NoOpMailer();
