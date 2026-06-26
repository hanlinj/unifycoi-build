# System: Platform Systems & Tenancy

> A **cross-cutting systems** doc (not a screen) at the **platform altitude**. Defines the rules the whole multi-tenant platform obeys: isolation, billing, tenant lifecycle, support, and monitoring.

## Tenant isolation

- Every client org is a **fully isolated tenant**. No client can see another client's data — locations, users, vendors, documents, or compliance state.
- **Vendors are isolated per tenant** (confirmed decision). A vendor serving both Acme and New Age exists as two separate vendor records and onboards/verifies twice. No cross-tenant doc reuse. (Downstream effect on the [[Vendor Onboarding Workflow]] / Segment 5.)
- **Tenant users** belong to exactly one tenant. **Platform users** belong to no tenant and are a separate identity space.
- Data should be partitioned by tenant at the data layer so isolation is structural, not just UI filtering.

## Billing (manual model)

- Pricing: **$90 per location per month.**
- Billing is **manual** — no in-app payment processor. The app is the source of truth for the *figure*, not the transaction.
- Each tenant has a **billing record**; the app surfaces current billable location count × $90 as a reference so there's no manual math.
- When stores are added/removed, the platform admin **adjusts billing manually**; the location count updates automatically and flags that the billable amount changed.
- Invoicing/collection happens outside the app (for now).

## Tenant lifecycle

States: **Provisioning -> Active -> Suspended -> Offboarded** (Suspended/Offboarded can return to Active).

- **Provisioning:** being set up via [[New Client Provisioning Workflow]]; not billed, not live.
- **Active:** live and in use; billed.
- **Suspended:** access frozen (no tenant user can log in), **data retained**. Used for non-payment, pause, or pre-offboard.
- **Offboarded (churn):** **suspend + retain + export on demand.** Data is not auto-deleted. The client (or you on their behalf) can request a full export. Retention follows the **defined 7-year schedule, then purge-eligible** (see [[Document Storage & Security]]); hard deletion happens on explicit request or once purge-eligible.

> Default posture for a compliance product: **never silently delete** mid-window. Retain through the defined schedule; purge is deliberate, because audit/defensibility may be needed after a relationship ends.

## Support & impersonation

- Platform admins can **impersonate** a tenant user to troubleshoot ("log in as").
- **Every impersonated session and action is logged** and attributed to the real platform user, not the client — visible in the audit trail. Impersonation should be visibly indicated in-session.
- Follow standard support protocols/UX: a support entry from the [[Platform Super Admin Console]] tenant detail, scoped and time-bound access, clear exit.
- *(Confirm later: read-only vs. full-action impersonation; whether tenant admins are notified.)*

## Platform monitoring & ops

A platform-level backend for keeping UnifyCOI itself healthy. Much of this is standard SaaS ops and can mature over time — flagged as **proposed**, not blocking:

- Uptime / server health.
- AI verification throughput, latency, and error rates (the document-parsing pipeline is the heaviest subsystem).
- Document-processing queue depth.
- Per-tenant usage (locations, vendors, documents processed) — also feeds billing reference.
- Support queue / open issues.
- Surfaced in Zone 3 of the [[Platform Super Admin Console]] (and feeds its Zone 1 fleet-attention queue).

## Platform roles

- **Platform Owner** — full control (you).
- **Platform Support/Staff** — manage tenants, provision, impersonate (logged); scope TBD.
- Distinct from all tenant roles (Admin / District Manager / Store Manager / Vendor), which live one altitude down — see [[Roles & Permissions]].

## Open questions

- Retention policy specifics — **resolved: 7-year schedule, then purge-eligible** ([[Document Storage & Security]]); deletion-request + legal-hold flow still to detail.
- Support access granularity (read-only vs full; notification to client).
- Whether platform staff roles need finer permissions than owner.

## Links

- [[Platform Super Admin Console]] — the surface these rules power
- [[New Client Provisioning Workflow]] — creates tenants
- [[Roles & Permissions]] — the full role matrix (tenant altitude)
- [[Audit Trail]] — where impersonation and changes are logged
- [[Audit Export Generation]] — the on-demand full-tenant export the offboard posture promises
- [[Search]] — tenant-isolated; the platform fleet search is a separate altitude
- [[Navigation]] — the platform sidebar; impersonation switches into the tenant shell
