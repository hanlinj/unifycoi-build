-- Migration: 013_tenant_stripe_customer
-- Phase 12 (Slice 3): billing-attach at provisioning (OPS-10, ⚠ owner-approved spec deviation).
-- Stores the Stripe customer id created at provisioning. NULL until the customer is attached
-- (the attach runs AFTER the provisioning DB commit — an external call can't be inside a DB
-- transaction — so a transient Stripe failure leaves a 'provisioning' tenant with NULL here;
-- that is recoverable via an idempotent retry, and activation is gated on this being set).
--
-- (tenants.timezone already exists from 005; provisioning now REQUIRES + validates it — OPS-7
-- input half — with no schema change.)

ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
