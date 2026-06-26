# Surface: Regional / District View

> A **scoping variant**, not a new screen. The Regional/District Manager (one role, two names — canonical role: **District Manager**, see [[Roles & Permissions]]) is served by **region-scoped instances of two existing surfaces** — the [[Manager Home Dashboard]] (operational) and the [[Corporate Command Center]] (oversight) — never a third dashboard.
> This doc defines what the District version *changes*: the **scope clamp**, the **action-delta** against the full versions, the **default landing**, and **region roll-up/drill-down**. It deliberately does **not** re-specify zones — those live in the two parent surfaces; this only says how they narrow for a District.

## Role & question

**Primary role:** District Manager — accountable for a **region** (a group of stores), sitting between the single-store Store Manager and org-wide corporate. Per [[Roles & Permissions]] they can **view, invite, and manage users — all region-scoped** — but **cannot approve vendors, edit requirements, or set precedence**.

A District Manager has **two questions**, which is exactly why they get two surfaces:
- *Operational* — "Who can I hire across my region, and are my invites moving?" → region-scoped [[Manager Home Dashboard]].
- *Oversight* — "What's about to break across my stores, and where is risk concentrated?" → region-scoped [[Corporate Command Center]].

The distinctive district lens — **store-vs-store comparison within the region** ("which of my 12 stores is the laggard?") — falls out of the Command Center's posture-by-location breakdown once it's scoped to a single region. No new view is needed to express it.

## Decision (locked this session)

**Scoped reuse of both existing surfaces — no distinct Regional dashboard.** The District Manager is granted region-scoped instances of the Manager Home Dashboard and the Corporate Command Center, with the action-delta below. This matches what both parent docs already assert ([[Manager Home Dashboard]]: "also used by Regional/District managers at wider scope"; [[Corporate Command Center]]: "regional managers may have a scoped version") and honors [[MISSION]] #8 (simplicity wins) — no third surface pattern to build or keep reconciled.

> Resolves the Segment 3 open question *"is Regional a distinct surface or just Corporate scoped down?"* — answer: **scoped reuse of both**, so the District keeps the operational half a Command-Center-only approach would drop.

## Scope clamp

Everything a District sees and acts on is filtered to **their region(s)** — enforced **server-side**, not by UI hiding (the same posture as [[Document Storage & Security]] masking: data outside scope is *not sent to the client*).

- **Region membership** comes from location grouping in [[Location Management]] (locations roll up into regions/districts; that grouping *is* the scope). A region reassignment updates a District's scope **immediately** (per [[Location Management]] edge states).
- **Drill-down stops at the region boundary** — a District can drill region → store → [[Vendor Record]], but never sees a store, vendor, or posture number outside their region.
- **Roll-ups reconcile with the Admin's org view** — the same vendor's status reads identically on the District's surfaces and the Admin's ([[Corporate Command Center]] roll-up rule). The District sees a *subset*, never a *different truth*.
- **Multi-region District** — a District may own more than one region; their scope is the union, with a region selector (All my regions / a specific region), mirroring the Store Manager's facility selector on the [[Manager Home Dashboard]]. *(Decision to confirm: is multi-region assignment supported in v1, or one region per District?)*

## Action-delta (what the District version removes or changes)

Against the **full** versions of each surface. The role matrix itself is canonical in [[Roles & Permissions]]; this is just how it lands on these two surfaces.

### Region-scoped Corporate Command Center

| Element | Full (corporate/Admin) | District version |
|---|---|---|
| Scope | Whole org | **Region** (union of assigned regions) |
| Risk queue (Zone 1) | Org-wide at-risk vendors | Region's at-risk vendors; same severity × time-to-lapse ranking |
| Portfolio posture (Zone 2) | Org rate + region/location breakdown | **Region** rate + **per-store** breakdown (the store-vs-store lens) |
| Pipeline (Zone 3) | Org throughput | Region throughput |
| Drill to [[Vendor Record]] | Yes (Admin approves there) | Yes, **view-only re: approval** — no approve action (Admin-only) |
| Trigger/confirm renewal chase | Yes | **Yes** (not an approval; within scope) |
| Assign/route to a manager | Yes | **Yes**, within region |
| **Manage requirements** | Yes | **Removed** (Admin-only — no edit, no precedence) |
| **Export / audit snapshot** | Org, incl. Sensitive | **Region-scoped, Standard-data only** — see export note |

### Region-scoped Manager Home Dashboard

| Element | Full (store manager) | District version |
|---|---|---|
| Scope | Their store(s) | **Region** (all stores in scope), with roll-up + store drill-down |
| Approved directory (Zone 1) | Store's approved vendors | All approved vendors usable across the region |
| Pending/onboarding pipeline (Zone 2) | Store | Region |
| Needs-attention backstop (Zone 3) | Store | Region |
| Invite (global action) | Store scope | **Region scope** (kept) |
| Manage users | Not available | **Region user management** (kept — a District capability the Store Manager lacks; via [[User Management]]) |

> **Export note.** [[Roles & Permissions]] grants a District **audit/export at region scope (view)**. The locked [[Document Storage & Security]] decision is that **only an Admin can export records containing Sensitive data**. So a District export is **region-scoped and Standard-data only** (compliance posture, statuses, COI/coverage facts — no ACH/full-TIN). *(Decision to confirm: may a District generate the PDF/CSV region snapshot themselves, or only view the audit timeline and request an export from an Admin? Default: generate, Standard-data only.)*

## Default landing

A District is a "mini-corporate for their region" — the role exists for **cross-store risk oversight** more than single-job throughput. Default home is therefore the **region-scoped Command Center (oversight-first)**, with the region-scoped Manager Home Dashboard one tap away for the operational half.

> **Resolved (Segment 7):** **oversight-first** — the District's default landing is the region-scoped [[Corporate Command Center]], with the region-scoped [[Manager Home Dashboard]] one tap away. The District sidebar is defined in [[Navigation]].

## What a District does **not** get

- **No approve/reject** — only an Admin stamps a vendor compliant ([[Roles & Permissions]], [[Document Verification]]). The District can see findings and route, not decide.
- **No requirements editing or precedence policy** — Admin-only ([[Requirements Configuration]]).
- **No org-wide scope** — never sees outside their region; no other region's stores, vendors, posture, or pipeline.
- **No Sensitive data export** and no Sensitive-field contents (masked server-side; managers see Sensitive docs as *on file*, not contents — [[Document Storage & Security]]).
- **No platform-altitude anything** — the platform console and tenant lifecycle are a separate altitude entirely.

> **Not to be confused with a region-scoped Admin.** [[Roles & Permissions]] assumes Admin is always org-wide; the **District Manager is the region-scoped oversight role**. Don't model "Admin scoped to a region" — that's this role.

## Region roll-up & drill-down

- **Posture by store within region** is the District's primary oversight artifact — the Command Center Zone 2 breakdown, scoped, becomes a ranked store comparison (compliant % / open risks per store).
- **Drill path:** region → store → [[Vendor Record]] (vendor detail) or the store's [[Location Record]] (Segment 3, not yet built — forward link).
- **Status semantics are unchanged** — per-location status with a derived overall ([[Status Vocabulary]]); the District just sees the locations in their region. A vendor approved at a store outside the region but also working a store inside it shows **only the in-region location's status** to the District.

## States & refresh

Inherited from the two parent surfaces — nothing new. First-run/empty, loading order (risk queue first on the Command Center; directory first on the Manager Home), high-volume pagination, and per-zone error isolation all carry over, scoped to the region. Live-vs-refresh follows the same open item as the parents.

## Edge & error states

- **District with no stores yet / empty region:** show the parent surfaces' empty states scoped to the region ("no approved vendors in your region yet"), not org-level setup guidance (that's the Admin's job).
- **Region reassignment mid-session:** scope updates immediately ([[Location Management]]); a vendor/store that leaves the District's region drops from their view, one that joins appears.
- **Vendor spanning in- and out-of-region locations:** the District sees only their region's location rows and that location's per-location status — never the out-of-region picture.
- **District tries to act out of scope** (reach a vendor/store/export outside region): blocked **server-side** and logged as a scope-violation security event ([[Audit Trail]]).
- **Export requested with Sensitive data in scope:** the Standard-only export proceeds; Sensitive contents are excluded, not just masked in the PDF.

## Open questions

- **Default landing** — **resolved: oversight-first** (region-scoped Command Center); sidebar in [[Navigation]].
- **Multi-region District** — supported in v1, or one region per District? (above)
- **District export** — self-generate the Standard-data region snapshot, or view-only + request from Admin? (above)
- **Whether thresholds differ** — does a District see the same "expiring soon" 60-day window as corporate? Default: **yes**, identical thresholds; the only difference is scope.

## Links

- [[Corporate Command Center]] — the oversight surface this scopes to a region (risk queue, posture, pipeline)
- [[Manager Home Dashboard]] — the operational surface this scopes to a region (directory, pipeline, backstop)
- [[Reports & Analytics]] — the District also gets a region-scoped subset of the report catalog
- [[Roles & Permissions]] — the canonical District Manager capabilities and scope this enforces
- [[Location Management]] — region/district grouping defines the scope; reassignment updates it
- [[Vendor Record]] — drill destination from either scoped surface (view-only re: approval for a District)
- [[Status Vocabulary]] — per-location status + derived overall the District sees within their region
- [[Document Storage & Security]] — server-side scope/masking; Sensitive export is Admin-only
- [[Audit Export Generation]] — the region-scoped, Standard-only export workflow this scopes
- [[Document Verification]] — why a District can route but not approve (only Admin approves)
- [[MISSION]] — #5 multi-location first-class, #8 simplicity wins (why this is a variant, not a new surface)
- [[Search]] — region-scoped vendor/location search inherited from both dashboards
- [[Navigation]] — the District sidebar (oversight-first) built from these region-scoped instances
