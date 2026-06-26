# Surface: Location Record

> The detail surface for a single **location/facility** — one store's page. Created via [[Bulk Location Import]] (or a single manual add), maintained from the [[Location Management]] surface, and the drill-in destination when a user opens a store from a dashboard, a region roll-up, or a posture breakdown.
> A **surface** (noun): you land, orient, and act. No single happy path — documented by *what it shows, in what priority, per role, and where it leads.* Sibling to the [[Vendor Record]]; one record, **role-scoped**.

## Role & question

One record, three readers, three questions:

- **Admin** — *"Is this store set up correctly, and what's its compliance posture?"* Full view; edits profile, region, requirements (via the canonical editor), and people; can deactivate.
- **District Manager** — *"How is this store in my region doing, and who can be hired here?"* View within region; invite vendors scoped to the store; no profile/requirements editing.
- **Store Manager** — *"What's true at my store — who's approved, what's pending, what needs attention?"* View their own store(s); invite vendors; no editing.

The record adapts by role — it does not become three screens. Same entity, scoped visibility and actions (see [[Roles & Permissions]]).

> **Surface contrast:** the [[Manager Home Dashboard]] answers operational questions *across* a manager's vendors; the [[Corporate Command Center]] answers risk *across* the portfolio; the [[Regional District View]] scopes those to a region. The Location Record is the *single-store* truth they all drill into — and a store's posture must read **identically** here and in any roll-up that contains it.

## What it shows (information hierarchy)

Lead with identity, then the rules in force, then the vendors that depend on them, then people, then history. Ranking, top to bottom:

1. **Profile & posture header** — what/where this store is and its at-a-glance compliance snapshot.
2. **Requirements in effect** — the resolved requirement set vendors at this location are verified against.
3. **Vendors at this location** — approved / in-pipeline / at-risk, scoped to the store.
4. **People** — the managers attached to the store.
5. **Activity & audit timeline** — every location-level event, for defensibility.

## Zones

### Zone 1 — Profile & posture header (always)
- **Shows:** store name, full address (city/state/ZIP), **region/district**, **primary manager**, active/inactive state, and a **compliance snapshot** — a one-line posture (e.g. *"12 approved · 2 at-risk · 1 in onboarding"*).
- **Why:** the at-a-glance orientation every role needs first.
- **Actions:** role-dependent global actions (below).

### Zone 2 — Requirements in effect
- **Shows:** the **resolved** requirement set for this location — org base + any **location override**, with the platform **floor** marked locked and the override clearly flagged as what differs from base (see [[Requirements Configuration]]).
- Because the effective matrix is **trade × location**, this zone carries a **trade selector** that reuses the [[Requirements Configuration]] "preview effective requirements" tool, fixed to this location — pick a trade, see exactly what a vendor of that trade is verified against *here*.
- **Editing happens in the canonical editor, not here.** This zone **displays**; an Admin edits the location override via a link to [[Requirements Configuration]] (Admin-only). One editing surface keeps the matrix consistent. *(Decision to confirm: inline-edit here vs. link-out — default link-out.)*
- **Why:** a manager can see *what this store demands* without interpreting insurance; an Admin can confirm the override resolved as intended.

### Zone 3 — Vendors at this location
- **Shows:** the store-scoped vendor view — **Approved** (the local "who can I hire"), **in-pipeline** (Invited/Pending · Onboarding · Under Review), and **at-risk** (Expired, Expiring Soon, Non-Compliant) — each in the canonical [[Status Vocabulary]], showing the vendor's **per-location** status *at this store* (not their overall roll-up).
- **Why:** this is the [[Manager Home Dashboard]]'s content for a single store; a vendor approved org-wide may still be deficient *here* if this location overrides higher — the per-location truth shows on the row.
- **Actions:** drill to [[Vendor Record]]; **Invite a vendor** scoped to this location ([[Invite Vendor Workflow]]); filter by trade/status. An already-approved vendor can also be brought here via [[Add Existing Vendor to Locations]] (Admin-activated) without re-onboarding.
- **Empty state:** "No vendors at this store yet — invite your first."

### Zone 4 — People
- **Shows:** the **primary manager** plus any assistant/secondary managers assigned to the store, and the region the store belongs to (which defines District scope).
- **Actions (Admin):** add/replace managers via [[User Management]]; reassign region.
- **Why:** answers "who runs this store" and anchors the scope rules that govern who can see this record.

### Zone 5 — Activity & audit timeline
- **Shows:** the location-targeted trail from the [[Audit Trail]] — store created/imported, region reassigned, requirement override changed (with the required reason), manager changed, vendor associated/removed, deactivated.
- **Why:** defensibility (MISSION #2) extends to configuration, not just vendor decisions — an operator can show *when and why* a store's requirements or grouping changed.
- **Actions:** export this location's compliance record (point-in-time, scope-and-role gated — see global actions).

## States (what the record emphasizes)

- **New / empty:** just created, no vendors yet → collapse Zone 3 to a single **Invite** prompt; don't show empty risk widgets.
- **Active (normal):** full record; posture header live.
- **Override present:** Zone 2 leads with what this store changes vs. base, so the non-standard requirement is never invisible.
- **Has at-risk vendors:** the posture header surfaces the at-risk count prominently (it feeds the region/portfolio risk queues upstream).
- **Deactivated / archived:** read-only historical record, retained per the [[Document Storage & Security]] schedule; clearly badged inactive; no new invites.

## Global actions (role-dependent)

- **Edit profile · assign/reassign region · deactivate** — **Admin** ([[Location Management]]).
- **Manage requirements (location override)** — **Admin**, via [[Requirements Configuration]].
- **Manage people** — **Admin** (org-wide) / **District** (their region), via [[User Management]].
- **Invite a vendor (store-scoped)** — Admin / District / Store Manager in scope → [[Invite Vendor Workflow]].
- **Export location compliance** — point-in-time snapshot for any audit-authorized role within scope, via [[Audit Export Generation]]. Non-Admin exports are **Standard-data only** (no Sensitive ACH/TIN), consistent with the [[Regional District View]] export rule and [[Document Storage & Security]].

## Scope

Honors role scope throughout ([[Roles & Permissions]]):
- **Store Manager** — only their own store(s); operational view + invite.
- **District Manager** — any store in their region; view + invite; no editing.
- **Admin** — any location in the tenant; full edit.
- Cross-tenant access is impossible (tenant-partitioned — see [[Platform Systems & Tenancy]]).

## Edge & error states

- **Deactivating a location with active vendors / pending work:** warn and define handling — reassign the vendors/work or archive with the location. *(Decision to confirm — inherited from [[Location Management]].)*
- **Removing or deactivating a location:** changes the billable location count → flags a **billing change** (manual billing reference, see [[Platform Systems & Tenancy]]).
- **Region reassigned while a District is viewing:** scope updates immediately; the store appears/disappears from the relevant District's view ([[Location Management]]).
- **Requirement override raised here (tightening):** triggers re-evaluation of already-approved vendors **at this location** — a vendor that no longer meets the higher bar flips to **Non-Compliant** (rules-only re-eval against stored extractions — see [[AI Verification Engine]]). Removing a stricter override (loosening) does not force re-eval.
- **Manager opens the record:** sees the operational view and store-scoped vendors; cannot edit profile/requirements; Sensitive vendor data stays masked (it lives on the [[Vendor Record]], Admin-only).
- **Posture changes while open** (a vendor at this store lapses mid-session): the snapshot reflects current state — stale compliance posture is the one thing this surface can't show wrong.

## Open questions

- **Soft-delete/archive vs. hard remove** for a location (inherited from [[Location Management]]).
- **Can a location belong to more than one region?** Default: one (inherited).
- **Inline requirements editing here vs. link-out** to [[Requirements Configuration]] — default link-out (single editor).
- **Deactivation handling** of active vendors — reassign vs. archive (above).
- **Non-Admin self-serve export** of the location snapshot — default yes, Standard-data only.

## Links

- [[Location Management]] — the locations surface this is the detail page for; where stores are created/edited/grouped
- [[Bulk Location Import]] — the primary creation path that seeds these records
- [[Requirements Configuration]] — the canonical editor for this location's override; supplies the resolved set Zone 2 displays
- [[User Management]] — where the store's managers are assigned (Zone 4)
- [[Vendor Record]] — drill destination from Zone 3; the single-vendor sibling of this record
- [[Manager Home Dashboard]] · [[Corporate Command Center]] · [[Regional District View]] — surfaces whose roll-ups this single-store truth reconciles with
- [[Invite Vendor Workflow]] — launched by the store-scoped Invite action
- [[Add Existing Vendor to Locations]] — how an already-approved vendor is associated to this store without re-onboarding (Zone 3)
- [[Audit Export Generation]] — the location-scoped compliance export
- [[Status Vocabulary]] — the per-location vendor statuses Zone 3 renders
- [[AI Verification Engine]] — rules-only re-evaluation when a location override tightens
- [[Audit Trail]] — the location-targeted events Zone 5 surfaces
- [[Document Storage & Security]] — retention of a deactivated record; Standard-only export for non-Admins
- [[Platform Systems & Tenancy]] — tenant isolation; location count drives billing
- [[Roles & Permissions]] — the role-scoped visibility and editing this enforces
- [[Search]] — a drill-in destination from location search results
