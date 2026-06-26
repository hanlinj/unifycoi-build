# System: Search

> A **cross-cutting systems** doc (not a surface). The scoped lookup that powers the **"find a vendor / find a location"** actions across the product — the machinery under MISSION #10 (visibility without friction) and the store manager's core question, *"who can I hire right now?"* It isn't a destination of its own; it **feeds the search/filter actions on existing surfaces** ([[Manager Home Dashboard]], [[Corporate Command Center]], [[Regional District View]]) and returns results that drill into the [[Vendor Record]] and [[Location Record]].
> **This session's decision:** v1 matching is **simple** — exact facet filters + name prefix/substring, no full-text engine (FTS5/fuzzy deferred behind the same interface). `[[wikilinks]]` point to related docs.

## What it's for

Each role answers its own question without spreadsheets, inbox searches, or phone calls (MISSION #10):

- **Store / District Manager** — *find an approved vendor to hire*, by trade, by name, within their facilities. The [[Manager Home Dashboard]] directory **is** this search.
- **Corporate / compliance** — *find a specific vendor or location* across the portfolio to check status or drill into a record.

Search is the connective tissue between "I have a question about one vendor/store" and the record that answers it. It never mutates state — it observes and routes.

## What's searchable

| Entity | Searchable fields | Drill-in |
|---|---|---|
| **Vendor** *(primary)* | business name, contact name, **primary trade** (the Primary Niche enum from [[Invite Vendor Workflow]]), **status** (+ flags like *Expiring Soon*), assigned locations | → [[Vendor Record]] |
| **Location** | store name, address (city / state / ZIP), region/district, primary manager | → [[Location Record]] |

- **Not searched in v1:** document contents, extracted coverage values, and **all Sensitive fields**. You reach a document **through its vendor**, not by searching policy text — which keeps the search index free of ACH/TIN entirely (see Sensitive data below). *(Deferred: coverage-aware search like "vendors carrying $2M GL" — flagged.)*
- **Tenant-scoped always.** Cross-tenant results are impossible by construction (see [[Platform Systems & Tenancy]]). The **platform fleet search** (searching *tenants* on the [[Platform Super Admin Console]]) is a different altitude — searching the fleet, not within a tenant — and is out of scope for this doc.

## Matching model — simple *(decision locked this session)*

The dominant interaction is **filtering a directory**, not free-text search, so v1 keeps matching deterministic and cheap:

- **Facet filters (exact match):** **trade** (the controlled enum), **status** (the canonical [[Status Vocabulary]] values, plus flags such as *Expiring Soon* / *Action Needed*), and **location / region**. These are dropdowns/chips, not typed text — no ambiguity.
- **Text match (name/contact/address):** **prefix + substring**, case- and punctuation-normalized — so "acme" finds *Acme Plumbing* and *Acme, Inc.*; "spok" finds the Spokane store. No ranking, no typo tolerance.
- **Ordering:** a simple, stable rule — status priority then alphabetical — not relevance scoring. Predictable beats clever for a "who can I hire" scan (MISSION #8 simplicity).

> **Deferred (architected-for, not built):** **FTS5** (SQLite's full-text search — tokenized, ranked, partial-word) and then **fuzzy / typo tolerance** (so "plumer" still hits). Search is exposed as a **service interface**, so the matching implementation can be swapped to FTS5 later without changing any caller. Promote when a tenant's vendor volume makes simple matching feel thin. *(Same deferral posture as scheduled delivery and SMS.)*

## Scope & tenant enforcement (server-side)

Search honors the [[Roles & Permissions]] scope on **every** query, enforced at the data layer — never as a UI filter:

- **Store Manager** — vendors/locations at **their store(s)** only.
- **District Manager** — their **region**.
- **Admin** — the whole **org**.
- Every query carries `tenant_id` and the requester's scope; results are filtered **before they leave the server**. A manager can never surface an out-of-scope or cross-tenant vendor — **even by typing its exact name** (it simply returns no match; the system never reveals that an out-of-scope record exists). This mirrors the masking rule: blocked by scope, not merely hidden in the UI ([[Document Storage & Security]]).

## Sensitive data in results

- A result row carries **identity, trade, status (+ flags), and covered locations** — at most a coverage *summary*, **never** ACH/banking or full TIN. The **search index excludes Sensitive fields entirely** ([[Document Storage & Security]]) — they aren't indexed, so they can't leak through a result.
- A result row is the **same role-masked view** a manager already sees on the [[Vendor Record]] header. Search widens *findability*, never *visibility*.

## Where it surfaces (one service, many callers)

The same scoped service backs every search/filter affordance; what differs is the scope clamp and which entity leads:

- **[[Manager Home Dashboard]]** — the Approved directory is **search-first** (filter by trade / facility / name); the global **Search** action is vendor lookup across the manager's scope. Vendors lead.
- **[[Corporate Command Center]]** — **org-wide vendor/location search** (the surface's own severity/status/trade/location filters drive the risk queue; the Search action is the find-by-name/trade jump to a record).
- **[[Regional District View]]** — the same, **region-scoped** (the District inherits both dashboards' search at their scope).
- **[[Vendor Record]] · [[Location Record]]** — the drill-in destinations every result routes to.

## Results & drill-in

- **Vendor result** → business name, trade, **status + flags**, covered locations → opens the [[Vendor Record]].
- **Location result** → store name, address, region, a one-line posture snapshot → opens the [[Location Record]].
- **Mixed results** (a term matching both entities) → **grouped by type, vendors first** (the dominant need).
- **Status is shown inline on every vendor row** — *Expiring Soon*, *Expired*, *Non-Compliant* surface right in the result — so a manager never hires against a lapse from a search result (the same backstop the [[Manager Home Dashboard]] enforces).

## States

- **Empty query** → show the **default directory** (in-scope Approved vendors), not a blank box — search opens onto the everyday answer.
- **No matches** → "No vendors match" with the **active filters echoed** and a one-tap **clear-filters**; never a dead end.
- **Large result set** → paginate; the directory is search/filter-first when large (the dashboard's high-volume behavior).
- **Inactive records** → deactivated/archived vendors and locations are **excluded by default**; an explicit **"include inactive"** toggle surfaces them (retained per the [[Document Storage & Security]] schedule) without cluttering "who can I hire." *(Default off — confirm.)*

## Performance & persistence

- **SQLite / better-sqlite3**, tenant-partitioned. Simple matching needs **no separate search engine**: indexed exact-filter columns (trade, status, location/region) plus prefix/substring queries over **normalized name columns**.
- **Normalized search columns** (lowercased, punctuation-stripped business/contact names; normalized address tokens) are maintained **on write**, so prefix/substring stays index-friendly rather than scanning raw text.
- **FTS5 path (deferred):** an `fts` virtual table over the same fields, populated from the same write path and swapped in behind the search service when promoted — callers don't change.

## Edge & error states

- **Vendor spanning multiple locations, partial scope:** a District/Store sees the vendor only if **≥ 1 covered location is in their scope**, and the result reflects the vendor's **per-location status within their scope**, not the org-wide roll-up — honest scoping ([[Status Vocabulary]] per-location).
- **Status changes mid-session:** results reflect current state on the next query; stale status is the one thing a hire-decision result can't show wrong (echoes the dashboards).
- **A Sensitive value typed into search** (someone pastes an account/TIN): **never matches** — Sensitive fields aren't indexed — and the query string isn't treated as Sensitive content to store.
- **Query logging:** search queries are **not Sensitive-access events** (no Sensitive data is returned), so they log at most at the **light standard-access grain** ([[Document Storage & Security]] open item) — not per-query audit noise.
- **Out-of-scope exact-name guess:** returns no match; the system never confirms an out-of-scope or cross-tenant record exists.

## Open questions

- **Coverage-aware / document-field search** ("$2M GL vendors") — deferred; would require careful Sensitive-exclusion before any policy-field indexing.
- **FTS5 promotion trigger** — the tenant scale/quality point where simple matching should give way to full-text (above).
- **Query logging grain** — none vs. light; ties to the standard-access-logging open item in [[Document Storage & Security]].
- **Include-inactive default** — off (above); confirm.
- **Location search for Store Managers** — vendors are the manager's primary need; location search skews corporate/district. Default: vendors primary for managers, locations primary for corporate/district; confirm.

## Links

- [[Manager Home Dashboard]] — the search-first Approved directory and the global vendor-search action this powers
- [[Corporate Command Center]] — the org-wide vendor/location search action this powers
- [[Regional District View]] — the region-scoped variant (inherits both dashboards' search)
- [[Vendor Record]] · [[Location Record]] — the drill-in destinations every result routes to
- [[Invite Vendor Workflow]] — defines the Primary Niche trade enum that powers trade filtering
- [[Status Vocabulary]] — the statuses and flags search filters on and shows inline
- [[Roles & Permissions]] — the role scope every query is clamped to, server-side
- [[Document Storage & Security]] — Sensitive fields excluded from the index; server-side scope; standard-access logging grain
- [[Platform Systems & Tenancy]] — tenant isolation; the separate platform fleet search ([[Platform Super Admin Console]]) is a different altitude
- [[MISSION]] — #10 visibility without friction; the store-manager "who can I hire" question search exists to answer
