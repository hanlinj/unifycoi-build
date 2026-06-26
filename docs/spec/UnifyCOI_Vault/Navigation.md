# System: Navigation & Sidebars

> A **cross-cutting structural** doc (not a single surface). Defines the **per-role sidebars and default landings** — the last segment, because navigation *falls out of which surfaces exist per role*, and now they all do. The ordering principle is simple: **each role's nav leads with the surface that answers its [[MISSION]] question**, then supporting destinations, then configuration.
> Consolidates the inline "Platform sidebar" sketch in [[Platform Super Admin Console]] and finalizes the District default-landing flagged in [[Regional District View]]. `[[wikilinks]]` point to the destinations each entry opens.

## Two app shells (the top-level split)

- **Tenant app** — Admin / District Manager / Store Manager. **One shell, one role-conditional sidebar**: same chrome, with entries and scope that narrow per role. This mirrors the role-scoping pattern everywhere else — the [[Vendor Record]] and [[Location Record]] *adapt by role* rather than becoming separate screens; nav does the same.
- **Platform app** — Platform Owner / Platform Staff. A **separate shell** at the platform altitude ([[Platform Super Admin Console]] and its workflows). Never mixed with tenant nav. Platform staff reach a tenant's data only via **logged impersonation**, which drops them into the *tenant* shell as that role, with a persistent banner ([[Platform Systems & Tenancy]]).
- **Vendor** — **no app, no nav.** The tokenized [[Vendor Onboarding Workflow]] is a linear, no-login flow; renewals/corrections reuse the same no-nav tokenized pattern (Segment 5 absorbed).

## Global chrome (tenant app, all roles)

Not sidebar destinations — persistent app-level elements:

- **Search** — global, top-bar; scoped per role, server-side ([[Search]]). A lookup, not a destination.
- **Invite** — the primary action button, always visible for Admin / District / Store (scoped); launches [[Invite Vendor Workflow]]. An action, not a destination.
- **Notifications** — a top-bar indicator for the exception/digest items ([[Notifications & Communications]]).
- **Scope selector** — facility selector for a multi-store Store Manager; region for a District; org for an Admin.
- **Account / profile**.

> **Records are reached *through* destinations or Search, never as permanent sidebar entries** — the sidebar holds durable destinations (dashboards, reports, config), not individual vendor/location records.

## Per-role sidebars

### Store Manager — operational-first
Core question: *"Who can I hire, and are my invites moving?"* The sidebar is deliberately short (MISSION #8 simplicity — few doors).

- **Home** → [[Manager Home Dashboard]] *(default landing)* — Approved directory + pipeline + needs-attention backstop.
- **My Stores** → [[Location Record]] for their facility/facilities (view-only; collapses to a direct link if a single store).

*No* Reports, Requirements, Users, Command Center, or Org Settings — not in their access ([[Roles & Permissions]]). Vendors are reached via **Search** + the directory, drilling into the [[Vendor Record]]. Global chrome: **Invite** (store scope), **Search** (store scope).

### District Manager — oversight-first *(decision locked this session)*
Core question: region **risk oversight** first, operational second. A District is a "mini-corporate for their region." Every entry is the **region-scoped instance** of an existing surface — no new surfaces, scope clamp + action-delta per [[Regional District View]].

- **Home** → region-scoped [[Corporate Command Center]] *(default landing — oversight-first)* — the region risk queue + posture.
- **Operations** → region-scoped [[Manager Home Dashboard]] — who-can-I-hire across their stores; one tap from Home.
- **Reports** → region-scoped [[Reports & Analytics]] — the catalog, region-clamped, **Standard-data-only** export.
- **Locations** → their region's stores → [[Location Record]] (view; store-scoped invite).
- **Users** → [[User Management]] — manage **their region's** users.

*No* Requirements editing, *no* Org Settings, *no* approve, and export is **region-scoped, Standard-only** (the [[Regional District View]] action-delta). Global chrome: **Invite** (region), **Search** (region).

### Admin (Corporate) — exception-first, full configuration
Core question: *"Are we compliant?"* Leads with oversight; carries every configuration surface. Grouped so daily oversight isn't crowded by setup.

**Monitor**
- **Home** → [[Corporate Command Center]] *(default landing)* — org risk queue + posture.
- **Operations** → [[Manager Home Dashboard]] — the operational view *(secondary — Admins mostly live in oversight + records; folding this is an open question below)*.
- **Reports** → [[Reports & Analytics]] — full catalog, org scope, **Sensitive-capable** export.

**Configure**
- **Requirements** → [[Requirements Configuration]] — coverage rules, overrides, precedence (Admin-only).
- **Locations** → [[Location Management]] — facilities, regions/grouping.
- **Users** → [[User Management]] — internal users, org-wide.
- **Org Settings** → [[Client Org Settings]] — profile, approval routing, notification/branding defaults.

Global chrome: **Invite**, **Search**, **Export / audit snapshot** (org/region/location → [[Audit Export Generation]]). Vendors/locations reached via Search → [[Vendor Record]] / [[Location Record]].

### Platform Super-Admin — separate shell
The platform altitude — canonicalizes the inline sidebar sketched in [[Platform Super Admin Console]]:

- **Fleet / Tenants** → [[Platform Super Admin Console]] *(default landing)* — the **Fleet Attention** exception-first zone, then the tenant list.
- **Provisioning** → [[New Client Provisioning Workflow]] (+ [[Bulk Location Import]]).
- **Billing** → manual billing reference (location count × $90 — [[Platform Systems & Tenancy]]).
- **Health / Monitoring** → per-tenant health & pipeline status.
- **Requirements Templates** → the platform-level templates seeded into tenants at provisioning.
- **Support** → impersonation (logged) and the support backlog.
- **Settings** → platform settings.

Distinct from tenant nav throughout; impersonation visibly switches context into a tenant shell ([[Platform Systems & Tenancy]]).

### Vendor — no navigation
No sidebar, no account, no app shell. The only "navigation" is **save-and-resume within** the tokenized [[Vendor Onboarding Workflow]]; the vendor never sees internal surfaces or compliance status.

## Default landings (summary)

| Role | Default landing | Lead |
|---|---|---|
| **Store Manager** | [[Manager Home Dashboard]] | Operational — who can I hire |
| **District Manager** | region-scoped [[Corporate Command Center]] | **Oversight-first** *(locked)* |
| **Admin** | [[Corporate Command Center]] | Exception-first — are we compliant |
| **Platform** | [[Platform Super Admin Console]] | Fleet Attention (exception-first) |
| **Vendor** | tokenized onboarding flow | (no landing concept — linear flow) |

## Scope & active-state behavior

- The sidebar reflects the user's **scope**: a single-store manager sees "My Store" as a direct link rather than a Locations list; a District sees region-scoped instances; an Admin sees org-wide.
- **Entries appear only if the role can reach the surface** ([[Roles & Permissions]]) — nav never shows a door that 403s.
- **Mobile:** the sidebar collapses to a drawer / bottom-nav; the role's **default landing + Invite + Search** stay reachable (Store Managers and vendors are mobile-heavy — MISSION mobile-first for the field roles).

## Edge & error states

- **Single accessible store** → "Locations" collapses to a direct link to that [[Location Record]].
- **Scope reassigned mid-session** (a District's region changes) → sidebar entries re-scope; an out-of-scope destination disappears without breaking the shell.
- **No surfaces in scope** (misconfigured user) → a safe empty state with a "contact your admin" prompt, never a broken/blank sidebar.
- **Impersonation** (platform → tenant) → the **tenant** sidebar renders for the impersonated role, with a persistent impersonation banner; platform nav is not shown inside the impersonated session ([[Platform Systems & Tenancy]]).

## Open questions

- **Admin "Operations" entry** — a top-level destination vs. folded away (Admins mostly live in oversight + records). Default: keep it, secondary; confirm.
- **Store Manager "Vendors" entry** — a dedicated destination vs. reaching vendors only via Search + the directory. Default: directory + Search, no separate entry.
- **Mobile pattern** — drawer vs. bottom-nav specifics (design-time).
- **Notification center placement** — top-bar indicator assumed; confirm whether it opens a panel or a destination.
- **Grouped vs. flat sidebar** for Admin — defaulted to grouped (Monitor / Configure); confirm the labels.

## Links

- [[Manager Home Dashboard]] — Store Manager default landing; the operational entry for District/Admin too
- [[Corporate Command Center]] — Admin default landing; the District's oversight-first home (region-scoped)
- [[Regional District View]] — the region-scoped instances every District sidebar entry opens; the action-delta this nav inherits
- [[Reports & Analytics]] — the Reports entry (org for Admin, region/Standard-only for District)
- [[Requirements Configuration]] · [[Location Management]] · [[User Management]] · [[Client Org Settings]] — the Admin **Configure** group
- [[Vendor Record]] · [[Location Record]] — record drill-ins reached via destinations/Search, not sidebar entries
- [[Platform Super Admin Console]] — the platform shell; this doc canonicalizes its inline sidebar
- [[New Client Provisioning Workflow]] · [[Bulk Location Import]] · [[Platform Systems & Tenancy]] — platform sidebar destinations
- [[Vendor Onboarding Workflow]] — the vendor's no-nav tokenized flow
- [[Search]] · [[Invite Vendor Workflow]] · [[Notifications & Communications]] — global chrome (lookup, primary action, alerts)
- [[Roles & Permissions]] — the access matrix that decides which entries each role sees
- [[MISSION]] — each role's question, which orders every sidebar
