-- Migration: 016_billing_setup
-- Phase 12 (Slice 5a.1): the Stripe card-entry page. Closes the carry-forward ledger item
-- ("upgrade [password_reset_tokens] to a purpose column when a consumer queries by it") — the
-- billing-setup link is that consumer: it needs to distinguish its own tokens from
-- reset/invite tokens, which the table couldn't do before.
--
-- stripe_setup_intent_id: persisted so the card-entry page (opened whenever the operator's
-- link gets clicked, possibly days later) can re-fetch a live client secret from Stripe rather
-- than relying on the one-time value that used to only exist in an API response.
--
-- purpose: 'reset' | 'invite' | 'billing_setup'. DEFAULT 'reset' backfills existing rows —
-- harmless imprecision (some backfilled rows were actually 'invite'), since confirmPasswordReset
-- doesn't gate on purpose and no existing row could have been 'billing_setup' (that value is
-- net-new). New rows are written with their real purpose from here on.

ALTER TABLE tenants ADD COLUMN stripe_setup_intent_id TEXT;
ALTER TABLE password_reset_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reset';
