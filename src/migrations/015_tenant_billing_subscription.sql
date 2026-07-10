-- Migration: 015_tenant_billing_subscription
-- Phase 12 (Slice 5a): automatic per-location Stripe subscription billing (ADR-012-05,
-- reverses the prior "billing is manual" framing). attachBilling grows from "card on file"
-- into "card on file + active recurring subscription."
--
-- stripe_subscription_id: the tenant's recurring subscription (NULL until attachBilling
--   succeeds — same recoverable-NULL pattern as stripe_customer_id from migration 013).
-- setup_fee_cents: optional one-time fee set at provisioning; NULL = none. Charged once, on
--   the subscription's first invoice only (a pending invoice item swept in at creation).
-- billing_snapshots.stripe_synced_at: marks a snapshot's location-count as already reflected
--   on the live Stripe subscription quantity, so the quantity-sync worker doesn't reprocess
--   pre-activation snapshots (no subscription exists yet to update) or already-pushed ones.

ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN setup_fee_cents INTEGER;
ALTER TABLE billing_snapshots ADD COLUMN stripe_synced_at TEXT;
