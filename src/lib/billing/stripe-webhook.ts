// Stripe invoice.paid webhook handler (Slice 5a, ADR-012-05 — activation-on-payment). Net-new:
// no Stripe webhook of any kind existed before this. Logic lives here; the route
// (src/app/api/webhooks/stripe/route.ts) is thin wiring, same split as the Resend webhook.
//
// Gate: only the FIRST invoice for a subscription (billing_reason === 'subscription_create')
// activates the tenant + issues the Admin invite — a monthly renewal invoice
// ('subscription_cycle') is a routine recurring charge, not an activation event.
//
// Idempotent by construction: activateTenantOnFirstPayment no-ops for a tenant that isn't
// still 'provisioning', so a redelivered webhook event (Stripe retries on anything but a 2xx,
// and can occasionally redeliver even after one) never double-activates or double-invites.

import type Stripe from 'stripe';
import type { Db } from '@/lib/db/client';
import { activateTenantOnFirstPayment, type ActivationResult } from '@/lib/services/provisioning';
import type { Mailer } from '@/lib/notifications/mailer';
import { defaultMailer, resolveFrom } from '@/lib/notifications/mailer';
import { logAudit } from '@/lib/audit';
import { captureError } from '@/lib/observability';

export interface StripeWebhookResult {
  handled: boolean;
  reason?: string;
}

export async function handleStripeEvent(
  db: Db,
  event: Stripe.Event,
  mailer: Mailer = defaultMailer
): Promise<StripeWebhookResult> {
  if (event.type !== 'invoice.paid') {
    return { handled: false, reason: `ignored event type: ${event.type}` };
  }

  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.billing_reason !== 'subscription_create') {
    return { handled: false, reason: `ignored billing_reason: ${invoice.billing_reason} (not the first invoice)` };
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return { handled: false, reason: 'invoice has no customer' };

  const tenant = await db.selectFrom('tenants').select('id').where('stripe_customer_id', '=', customerId).executeTakeFirst();
  if (!tenant) return { handled: false, reason: 'no tenant for this Stripe customer' };

  const result = await activateTenantOnFirstPayment(db, tenant.id);
  if (!result) return { handled: false, reason: 'tenant already active (idempotent no-op) or has no admin' };

  // Best-effort, deliberately outside the activation itself: the tenant is ALREADY active at
  // this point (the DB write already committed), so a mail failure here must never surface as
  // a webhook failure — Stripe retrying the whole event because the send was slow/broken would
  // be wrong (it already has the money; retrying can't fix delivery). Recoverable any time via
  // the cockpit's "Resend admin invite" button (sendAdminInviteEmail), which is why this
  // swallows everything down to a log + captureError rather than propagating.
  await sendActivationInviteEmail(db, tenant.id, result, mailer);

  return { handled: true };
}

async function sendActivationInviteEmail(db: Db, tenantId: string, activation: ActivationResult, mailer: Mailer): Promise<void> {
  try {
    const from = resolveFrom('internal', null);
    const result = await mailer.send({
      to: activation.adminEmail,
      fromName: from.fromName,
      fromEmail: from.fromEmail,
      subject: `You're invited to UnifyCOI — set your password`,
      body:
        `Your account is ready. Set your password to get started:\n\n${activation.invite.inviteUrl}\n\n` +
        `This link expires ${activation.invite.expiresAt}.`,
    });

    if (!result.ok) {
      captureError(new Error(`admin invite email send failed: ${result.error ?? 'unknown'}`), {
        where: 'sendActivationInviteEmail',
        tenantId,
        adminUserId: activation.adminUserId,
      });
      return;
    }

    // Distinct from activateTenantOnFirstPayment's admin.invite_issued (which fires on MINT,
    // inside the DB activation) — this is the delivery-confirmation signal, logged only once
    // the send actually succeeds, so the two are never conflated.
    await logAudit(db, {
      tenantId,
      actorType: 'system',
      actorId: 'stripe-webhook',
      eventType: 'admin.invite_emailed',
      targetType: 'user',
      targetId: activation.adminUserId,
      payload: { recipient: activation.adminEmail },
    });
  } catch (err) {
    // Defense in depth — mailer.send() is designed to never throw, but a bug here must still
    // never fail the webhook.
    captureError(err, { where: 'sendActivationInviteEmail', tenantId, adminUserId: activation.adminUserId });
  }
}
