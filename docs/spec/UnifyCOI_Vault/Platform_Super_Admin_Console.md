# Surface: Platform Super-Admin Console

> A **surface** (noun) at the **platform altitude** — UnifyCOI's own control room, used by you and platform staff, *above* any single client.
> This is not a tenant screen. Tenant users never see it.

## Role & question

**Primary role:** Platform owner / platform support staff (UnifyCOI internal). Distinct from all tenant roles.
**The one question:** *"How are all my client tenants doing — and how do I bring on and manage them?"*

This is the fleet view. Its user isn't managing vendors; they're managing **client organizations** (tenants) and the health of the platform itself.

## Job

1. See which tenants need attention — act before a client churns or a problem spreads.
2. See every client tenant and its status at a glance.
3. Provision a new client (white-glove).
4. Manage an existing tenant — billing, locations, users, suspend/offboard, support.
5. Monitor platform health (usage, processing, errors).

## Information hierarchy

**Exceptions first**, like the tenant-altitude [[Corporate Command Center]] one level down — the fleet attention queue leads; the full roster and the ops/billing views follow.

1. **Fleet attention** — the tenants that need *your* intervention right now (stalled provisioning, suspended/non-payment, deteriorating compliance-health, AI-pipeline trouble, support backlog, unreconciled billing, offboarding in flight). Ranked by severity.
2. **Tenant fleet** — the full browsable list of all client orgs; the everyday roster.
3. **Platform health** — system/ops status (uptime, AI processing volume & errors, support queue).
4. **Billing overview** — total billable locations across all tenants × $90; per-tenant breakdown.

## Zones

### Zone 1 — Fleet Attention (primary)
- **Shows:** the tenants that need *your* intervention, ranked by severity — each a lens over data already in the console, not a new subsystem:
  - **Stalled provisioning** — a tenant stuck mid-setup in [[New Client Provisioning Workflow]].
  - **Suspended / non-payment** — access frozen or billing overdue; needs resolution (see [[Platform Systems & Tenancy]] lifecycle).
  - **Deteriorating compliance-health** — a tenant whose own portfolio posture is sliding (rising Expired/Non-Compliant vendors) — an early churn / customer-success signal.
  - **AI-pipeline trouble** — a spiking extraction error rate or processing backlog affecting a tenant (from [[AI Verification Engine]] / monitoring).
  - **Support backlog** — open support items or an impersonation session needing follow-up.
  - **Unreconciled billing** — location count changed but the manual billing figure hasn't been adjusted (the billing-change flag — see [[Platform Systems & Tenancy]]).
  - **Offboarding in flight** — an offboarded tenant with a pending export or retention action ([[Document Storage & Security]]).
- **Why:** exception-based operations at the platform altitude (MISSION #11) — you run the fleet by exception, not by scanning a list. The platform analogue of the [[Corporate Command Center]] risk queue.
- **Priority:** Primary, top of screen.
- **Actions:** drill to tenant detail; jump straight to the fix (reconcile billing, resume provisioning, open support/impersonation, reactivate).
- **Empty state:** "All tenants healthy — N active, nothing needs attention." A credible all-clear is the product, exactly as on the Command Center.

### Zone 2 — Tenant Fleet (browse)
- **Shows:** every client org — name, # locations, status (Provisioning / Active / Suspended), monthly value (locations × $90), and a compliance-health snapshot per tenant.
- **Why:** the everyday roster beneath the attention queue — "how are my clients doing?" at a glance.
- **Priority:** Primary–secondary.
- **Actions:** **Provision new client** -> [[New Client Provisioning Workflow]]; open a tenant -> tenant detail; **Impersonate / support** (logged) -> see [[Platform Systems & Tenancy]]; suspend/offboard.
- **Empty state:** "No clients yet - provision your first." -> launches provisioning.

### Zone 3 — Platform Health & Ops
- **Shows:** uptime/server status, AI verification throughput and error rate, document-processing queue, open support items, per-tenant usage. *(Mostly standard SaaS ops - see [[Platform Systems & Tenancy]]; can mature over time.)*
- **Why:** keep the platform itself healthy.
- **Priority:** Secondary.
- **Empty state / partial:** show what's wired; this zone is expected to grow.

### Zone 4 — Billing Overview
- **Shows:** total billable locations × $90 across the fleet; per-tenant figures as a reference (billing is **manual** - this is a calculator, not a processor).
- **Why:** answers "what should I be invoicing?"
- **Actions:** open a tenant's billing record; adjust manually.
- See [[Platform Systems & Tenancy]] for the billing model.

## Tenant detail (drill-in)

Opening a tenant shows: org profile & primary contact, locations (count + manage), users (admins/DMs/managers), applied requirements template, billing record, status controls (suspend/offboard/reactivate), and a support/impersonation entry. This is your per-client cockpit.

## Platform sidebar (this altitude's nav)

Tenants · Provisioning · Billing · Health/Monitoring · Requirements Templates · Support · Settings

> Canonicalized in [[Navigation]] (the per-role sidebar doc) — this altitude's shell is separate from the tenant app's role-conditional sidebar.

## Scope

Platform-wide by definition. Platform users are **not** scoped to a tenant; tenant data stays isolated (see [[Platform Systems & Tenancy]]) and is reached only via explicit open/impersonate, which is logged.

## States

- **First-run:** no tenants -> single prompt to provision (no empty attention/fleet widgets).
- **Loading:** attention queue first (the reason you're here), then the fleet roster, then health/billing.
- **High volume (many tenants):** the attention queue ranks-and-paginates; the fleet is search/sort/filter by status, health, size.
- **Error:** isolate per zone; a health-feed failure must not blank the attention queue or fleet list.

## Links

- [[New Client Provisioning Workflow]] — the white-glove onboarding verb
- [[Bulk Location Import]] — used inside provisioning (and reused by tenant admins later)
- [[Platform Systems & Tenancy]] — isolation, billing, lifecycle, support, monitoring (the signals the attention queue surfaces)
- [[AI Verification Engine]] — the document-parsing pipeline whose health/errors feed the attention queue
- [[Document Storage & Security]] — offboard export + retention actions the attention queue tracks
- [[Audit Trail]] — where impersonation and support actions are logged
- [[Corporate Command Center]] — the tenant-altitude, exception-first analogue one level down
- [[Search]] — within-tenant vendor/location search is a different altitude from this fleet search
- [[Navigation]] — canonicalizes this console's platform sidebar
