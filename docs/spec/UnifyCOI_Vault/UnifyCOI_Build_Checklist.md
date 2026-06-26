# UnifyCOI — Master Build Checklist & Q&A Plan

> Living inventory of every surface, workflow, and system the agentic coder will need.
> We work through it in **segmented Q&A sessions**: I ask, you answer, I produce the spec doc.
> Status: ✅ drafted · 🟡 partial/needs update · ⬜ not started

> **✅ ALL SEGMENTS COMPLETE.** Segments 1–7 are drafted and cross-reconciled (Segment 5 absorbed into the vendor onboarding flow). The spec vault is build-ready. Remaining items are flagged inline as *decisions to confirm* and two optional standalone promotions (`[[Deficiency Loop]]`, `[[Approve Reject Decision]]`, currently embedded in `Document_Verification.md`). 29 spec docs.
>
> **▶ Coder compile target:** `IMPLEMENTATION_BRIEF.md` (meta-file, not a spec — sits outside the link-graph like `_CONTINUE.md`). It projects this vault into stack · MVP scope · DB schema · routes · API endpoints · build order · a *do-not-invent* guardrail · and v1 defaults for every open item. It is **derived** — if it and a spec doc disagree, the spec doc wins and the brief is regenerated.

---

## Three altitudes (the mental model)

UnifyCOI has **three tenancy levels** — keep them distinct everywhere:

1. **Platform** — UnifyCOI itself (you). Signs on client orgs, manages tenants, billing, the whole fleet.
2. **Client org (tenant)** — e.g. Acme Storage (34 stores), New Age Storage (60 stores). Isolated from each other.
3. **Within a tenant** — Corporate → Regional → Store Manager users, plus the operator's vendors.

Cross-cutting: **Vendors** (may touch multiple locations, possibly multiple tenants).

---

## Segment 1 — Platform & Multi-Tenant Deployment  ✅
*The container. Define first.*

**Decisions locked:** white-glove provisioning · CSV import is **locations + primary store manager only** (no separate people sheet) · admins & district managers added manually by you during setup · vendors **fully isolated per tenant** · requirements from **reusable platform templates** · billing **manual** (location count × $90 reference) · invites sent manually during onboarding · churn = **suspend + retain + export on demand**.

- ✅ Platform Super-Admin Console (surface) — `Platform_Super_Admin_Console.md` (exception-first; fleet-attention lens added in Segment 3)
- ✅ New Client Provisioning (workflow) — `New_Client_Provisioning_Workflow.md`
- ✅ Bulk Location Import — locations + primary manager — `Bulk_Location_Import.md`
- ✅ Tenant isolation · billing · lifecycle · support · monitoring — `Platform_Systems_and_Tenancy.md`
- 🟡 Requirements **template applied** at provisioning; client-side editing → Segment 2
- 🟡 Support / impersonation — model defined (logged); granularity to confirm
- 🟡 Per-tenant health & monitoring — proposed (console Zone 3; also feeds the Zone 1 attention queue); matures over time

*Still open (small):* data-retention duration after offboard · whether platform needs multiple staff roles · removing stores via re-upload vs. manual.

---

## Segment 2 — Client Org Setup  ✅
*What an operator's admin configures once their tenant exists.*

**Decisions locked:** requirements **editable within platform guardrails** (locked floor, client raises) · requirements vary by **both trade and location** (layered matrix) · conflicts resolved by **Admin-set precedence policy** (default strictest-wins) · **only Admin approves** vendors · **District Manager** = view + invite + manage users in their region (no approve) · internal users managed by **Admin (org-wide) + District Managers (region)**.

- ✅ Org profile — `Client_Org_Settings.md`
- ✅ Location / facility management (+ regions/grouping) — `Location_Management.md`
- ✅ Location Record — `Location_Record.md` (promoted to standalone from `Location_Management.md`)
- ✅ Requirements Configuration (matrix + guardrails + precedence) — `Requirements_Configuration.md`
- ✅ Document-type configuration — folded into `Requirements_Configuration.md` (required docs, per-trade)
- ✅ Internal user management & invites — `User_Management.md`
- ✅ Roles & permissions matrix — `Roles_and_Permissions.md`
- 🟡 Approval routing — simple default (shared Admin queue) in `Client_Org_Settings.md`; per-region routing optional/confirm
- 🟡 Notification settings — proposed defaults in `Client_Org_Settings.md`; confirm opt-outs/channels

*Still open (small):* re-evaluate already-approved vendors when rules tighten? · template updates push to live tenants? · location archive vs hard-delete · branding on vendor-facing comms.

---

## Segment 3 — Surfaces (Dashboards & Records)  ✅

**Decisions locked (this session):** Vendor Record review workbench is laid out **by document** (each upload with extracted values + the requirements it sources; deficient/uncertain flagged within each) · multi-location result shows **one overall status** in the header (with an "N of M locations" count when mixed) and a **per-location breakdown on drill-in** · the Vendor Record is **one role-scoped surface**, not separate manager/admin screens (managers read-only + sensitive data masked; Admin gets the workbench).

**Reports/Analytics (this session):** a **curated set of fixed, purpose-built reports** (Posture Over Time · Expiration/Renewal Forecast · Vendor Roster & Coverage · Onboarding Funnel · Deficiency/Exception Analysis · Audit-Readiness Summary) — **not a query builder** (depth over breadth); **on-demand view + export (PDF/CSV) for v1**, scheduled delivery architected-for but **deferred** (rides the Notifications digest rails). Distinct from the real-time Command Center and the evidentiary Audit export; Sensitive data excluded; corporate/District surface (Store Managers use the dashboards). Spec: `Reports_and_Analytics.md`.

**Regional/District (this session):** **not a distinct surface** — a District Manager gets **region-scoped instances of both the Manager Home Dashboard (operational) and the Corporate Command Center (oversight)**, with a documented action-delta (no approve, no requirements edit, region-scoped + Standard-only export); scope enforced server-side; default landing **oversight-first** (confirm in Segment 7). Spec: `Regional_District_View.md`.

**Platform Super-Admin Dashboard (this session):** **not a separate doc** — it *is* the Segment 1 `Platform_Super_Admin_Console.md`. Enhanced to be **exception-first**: added a **Fleet Attention** primary zone (stalled provisioning · suspended/non-payment · deteriorating compliance-health · AI-pipeline trouble · support backlog · unreconciled billing · offboarding in flight), the platform-altitude analogue of the Command Center risk queue; demoted the tenant list to Zone 2. Fixed the `[[Platform Super Admin Console]]` link mismatch across the vault.

- ✅ Store Manager Dashboard — operational, "who can I hire / are invites moving"
- ✅ Corporate Command Center — exception-first, portfolio risk
- ✅ Vendor Record (detail + Admin approve/reject workbench) — `Vendor_Record.md`
- ✅ Regional / District view (scoped variant — region-scoped reuse of both dashboards) — `Regional_District_View.md`
- ✅ Platform Super-Admin Dashboard — **same surface as** `Platform_Super_Admin_Console.md` (Segment 1); enhanced this session with a fleet-attention lens
- ✅ Location/Facility Record — `Location_Record.md`
- ✅ Reports / Analytics — `Reports_and_Analytics.md`

*Resolved:* what's on the Vendor Record → **identity/status header · by-document review workbench · per-location drill-in · documents (role-masked) · audit timeline.** · Regional a distinct surface or scoped corporate? → **scoped reuse of both dashboards, no new surface** (`Regional_District_View.md`).
*Still open:* location-by-location vs. satisfied-set approval. (Sensitive-data masking → **resolved Admin-only** in `Document_Storage_and_Security.md`.)

---

## Segment 4 — Core Workflows (Verbs)  ✅

**Decisions locked (this session):** **only Admin approves, every time** — no auto-approve, no one-click queue; AI verifies + recommends, human always clicks (Q1). · **Deficiencies route to the Admin, flagged**, with a system-drafted plain-language correction request the Admin sends (Q2). · **Expiration is an objective gate handled at the vendor's upload step** — vendor confirms extracted expiration date(s); an expired policy bounces back to the vendor and **never reaches the Admin** (dates aren't open to interpretation). · Deficiency loop is **system-chased** once the Admin sets it in motion. · **Renewal chase cadence: 60/30/14/7/1** days before expiry, vendor-direct, autonomous. · **A clean renewal of an already-approved vendor auto-continues** (no fresh approval gate) **but notifies the Admin** for awareness + audit — distinct from a new approval. · **Add-to-locations ("collect once"):** an already-approved vendor associated to a new location is re-evaluated **rules-only against stored extractions** against that location's matrix (no re-collection, no re-extraction — third `location_add` trigger of the engine's reuse path); **the Admin activates every new-location association** — clean associations are **not** auto-continued (a new location is a new place the vendor becomes hireable → a per-location approval; the deliberate asymmetry with renewals, which *maintain* an existing relationship). A new-location shortfall is a **Deficient finding** (Under Review), not Non-Compliant; the only cure is a better document, requested via the chase loop. · **Audit/Export Generation:** the **"prove it on demand"** verb — one engine, scope = vendor/location/region/org (+ full-tenant offboard); **PDF + CSV both**; contents = event trail + resolved requirements + posture; **time semantics = now + full history** (as-of-date reconstruction deferred). Sensitive data **Admin-only and excluded-by-default** (Admin opt-in with reason, extra-logged); non-Admin = Standard-only. Small scope sync, large scope async + notify; scheduled delivery deferred. Generation is itself a logged access event.

- ✅ Invite Vendor — `Invite_Vendor_Workflow.md`
- ✅ Vendor Onboarding (vendor-facing, tokenized, no-login) — `Vendor_Onboarding_Workflow.md`
- ✅ COI / Document Verification (the AI engine flow) — `Document_Verification.md`
- 🟡 Deficiency & Correction Loop — **embedded** in `Document_Verification.md`; promote to standalone `[[Deficiency Loop]]` later
- ✅ Renewal / Expiration Chase — autonomous, exception-surfacing — `Renewal_and_Expiration_Chase.md`
- 🟡 Approve / Reject Decision (with human override) — **embedded** in `Document_Verification.md`; review surface is the [[Vendor Record]] (Segment 3); promote to standalone `[[Approve Reject Decision]]` later
- ✅ Add Existing Vendor to Locations ("collect once") — `Add_Existing_Vendor_to_Locations.md`
- ✅ Audit / Export Generation — `Audit_Export_Generation.md` (promoted from the [[Audit Trail]] Export section)

*Resolved:* how much AI decides vs. routes to a human → **AI never approves new vendors; verifies + recommends; Admin decides every time. Objective gates (expiration) handled without a human; judgment cases flagged to the Admin.** · renewal trigger + cadence → **60/30/14/7/1 ladder, per-policy, vendor-direct; clean renewals auto-continue + notify Admin.** · "expiring soon" threshold (was open on the Command Center) → **60-day lead, aligned to the chase.** · confidence-threshold model → **per-field, hybrid-derived (self-rate + targeted corroboration on critical/low fields), surfaced as a band + flag** (`AI_Verification_Engine.md`). · **per-location approval semantics** (was open) → **status + approval are per-location; overall derives to N of M; a vendor is hireable where they satisfy. Adding to a new location is a per-location, Admin-activated decision** (`Add_Existing_Vendor_to_Locations.md`). · **audit-export contents + format** (was open on the Command Center) → **PDF + CSV; event trail + resolved requirements + posture; now + full history** (`Audit_Export_Generation.md`).
*Still open:* whole-vendor vs per-location expiry when one required policy lapses · grace period before Expired-removal (default none) · expiring-soon-at-onboarding threshold · whether Admin can opt into auto-sending routine correction requests · whether a manager who initiates an add gets an activation-awareness notification (default yes, digest). · audit-export Sensitive opt-in default (exclude-by-default for Admin) · sync→async export threshold · scheduled/recurring export delivery (deferred) · PDF integrity stamp (ties to audit tamper-evidence).

---

## Segment 5 — Vendor-Facing Portal  ✅ *(absorbed — no standalone surface, by design)*
*The tradesperson's experience. Mobile-first, no login. There is deliberately **no vendor account/dashboard/login** — the whole experience is the tokenized [[Vendor Onboarding Workflow]], reused for renewals/corrections. Closed out in that doc's "Vendor portal scope (Segment 5)" section.*

- ✅ Tokenized onboarding entry (no account) — `Vendor_Onboarding_Workflow.md` (Preconditions) + tokenized-access model in `Document_Storage_and_Security.md`
- ✅ Guided document upload — COI, W-9, ACH — `Vendor_Onboarding_Workflow.md` (Steps)
- ✅ Resubmission on deficiency — Action-Needed resubmission state in `Vendor_Onboarding_Workflow.md` + deficiency loop in `Document_Verification.md`; renewals reuse the flow (`Renewal_and_Expiration_Chase.md`)
- ✅ Multi-client vendor handling — **onboard once *per client*, not globally** (per-tenant isolation; collect-once only *within* a tenant)
- ✅ Vendor status / "what do I still need to do" view — the guided flow **is** the status view (save-and-resume + confirmation + correction request); no separate page, none possible cross-tenant

*Resolved:* if a vendor onboarded for Acme and New Age also invites them, do they re-submit? → **Yes — re-submit per client.** Vendors are **per-tenant isolated** (locked in `Platform_Systems_and_Tenancy.md` / `Document_Storage_and_Security.md`): two separate vendor records, two document sets, independent onboard/verify; **no cross-tenant document reuse**. Collect-once reuse is **within a tenant only** (`Add_Existing_Vendor_to_Locations.md`).

---

## Segment 6 — Cross-Cutting Systems  ✅

**Decisions locked (this session):** Sensitive data (ACH/banking + full TIN) is **Admin-only — no new Finance/AP role**; masking enforced **server-side** (not just UI); managers see Sensitive docs as *on-file*, not contents. · Retention: **defined 7-year schedule** from when a record goes inactive (vendor removed / doc superseded / tenant offboarded), then **purge-eligible** — refines Platform Systems' "retain indefinitely." · Storage (locked): **document files in S3-compatible object storage on Backblaze B2 behind a `BlobStore` interface (same driver dev + prod, separate buckets/keys; filesystem adapter for tests/CI only), envelope-encrypted app-side, tenant-prefixed keys** + metadata in SQLite + field-level encryption for Sensitive fields, tenant-partitioned. · Audit trail is **append-only / immutable**, tenant-isolated, attributed (system/AI/user), retained on the same 7-yr schedule; **export = PDF + CSV**; **requirement changes require a reason/note.** · Notifications: **email only for v1** (SMS a future channel); **exceptions immediate, routine batched into a daily digest**; exception alerts not opt-out-able; vendor-facing comms **branded as the operator.** · Status vocabulary promoted to a **canonical state machine**: 7 statuses (added terminal **Declined** for hard-reject) + modifier flags (**Action Needed**, **Expiring Soon**, invite-delivery states); status tracked **per-location**, overall **derived**; **Deficient** is a finding-flag (not a status), **Non-Compliant** reserved for post-approval drift.
>
> **AI engine (this session):** confidence is **per-field, hybrid-derived** — model self-rating as the base signal + **targeted second-pass corroboration** on critical fields (limits, endorsements, named insured, coverage presence, expiration) and any low-self-rated field; pass disagreement forces **low → Uncertain**; surfaced to the Admin as a **band + flag** (not a raw decimal). · **Rule-change re-evaluation runs rules-only against stored extracted values** (no new Vision call — deterministic, cheap, bulk-able); **renewals re-extract** the new document; cures require a new document through the full pipeline. Engine extracts COI (ACORD 25) / W-9 / ACH into a typed schema; rules engine is a pure deterministic function over the resolved matrix from [[Requirements Configuration]].
>
> **Search (this session):** v1 matching is **simple** — exact facet filters (trade enum · status + flags · location/region) + **name/contact/address prefix+substring**, no FTS5/fuzzy (deferred behind a service interface; swap to SQLite FTS5 later without changing callers). Searchable = **vendors (primary) + locations**; **document contents / Sensitive fields are not indexed** (reach docs via the vendor). Scope clamped **server-side** per role; tenant-isolated; results carry no Sensitive data. One service feeding the dashboards' existing search/filter actions — not a new surface.

- ✅ Status vocabulary — canonical state machine — `Status_Vocabulary.md`
- ✅ Roles & permissions matrix — `Roles_and_Permissions.md` (Segment 2)
- ✅ Notifications & communications system (email, reminders, escalation) — `Notifications_and_Communications.md`
- ✅ Document storage & security model (sensitive ACH/tax data) — `Document_Storage_and_Security.md`
- ✅ AI verification engine spec (extraction, rules, confidence, human handoff) — `AI_Verification_Engine.md` (behavior in `Document_Verification.md`; technical internals here)
- ✅ Audit trail / logging (defensibility principle) — `Audit_Trail.md`
- ✅ Search (vendor/location, scoped by role & tenant) — `Search.md`

*Resolved:* sensitive-data access → **Admin-only**. · retention → **7-year schedule, then purge-eligible** (update Platform Systems' open item to match). · audit export format (was open on the Command Center) → **PDF + CSV**. · requirement-change reason (was open on Requirements Config) → **mandatory**. · notification channel (was open on Renewal) → **email v1**. · vendor-comms branding (was open on Client Org Settings) → **operator-branded**. · **search matching** → **simple: facet filters + name prefix/substring; FTS5/fuzzy deferred** (`Search.md`).
*Still open:* managers see COI contents vs status-only (default status-only) · exact retention figure / jurisdiction + legal-hold override · audit retention vs doc retention (longer for the trail?) · tamper-evidence mechanism · key-management specifics · standard-doc access-logging grain (also gates whether search queries are logged) · digest cadence (daily default) + opt-out granularity · search: coverage-aware search + FTS5 promotion trigger + include-inactive default (off) — all deferred. *(Storage mechanism — **resolved: S3-compatible object storage, envelope-encrypted, tenant-prefixed keys**; see `Document_Storage_and_Security.md` / `IMPLEMENTATION_BRIEF.md`.)*

---

## Segment 7 — Navigation / Sidebar (per role)  ✅
*Defined last — nav falls out of which surfaces exist per role. Spec: `Navigation.md`.*

**Decision locked (this session):** **District default landing = oversight-first** (region-scoped Command Center; operational view one tap away) — finalizes the item deferred from `Regional_District_View.md`. · Two shells: **tenant app** (one **role-conditional sidebar** for Admin/District/Store) and a separate **platform app**; **vendors have no nav** (tokenized flow). · Sidebars ordered by each role's MISSION question; **Search + Invite are global chrome**, not destinations; records are reached via destinations/Search, not sidebar entries.

- ✅ Store Manager sidebar — operational-first (Home = Manager Dashboard) — `Navigation.md`
- ✅ Corporate (Admin) sidebar — exception-first + grouped Configure section — `Navigation.md`
- ✅ District sidebar — oversight-first, region-scoped instances — `Navigation.md` (+ `Regional_District_View.md`)
- ✅ Platform Super-Admin sidebar — separate shell; canonicalizes the console's inline sidebar — `Navigation.md`
- ✅ Vendor portal (no nav) — save-and-resume within the tokenized `Vendor_Onboarding_Workflow.md`

*Resolved:* District default landing → **oversight-first** (`Navigation.md` / `Regional_District_View.md`).
*Still open (design-time):* Admin "Operations" top-entry vs. folded · Store Manager "Vendors" entry vs. Search-only · mobile drawer vs. bottom-nav · grouped vs. flat Admin sidebar labels.

---

## Suggested session order

1. **Platform & Deployment** (Segment 1) — the container; unblocks everything
2. **Client Org Setup** (Segment 2) — requirements, locations, users, roles
3. **Workflows** (Segment 4) — onboarding + the verification engine
4. **Vendor Portal** (Segment 5)
5. **Remaining Surfaces** (Segment 3) — Vendor Record, Location Record, Regional, Reports
6. **Cross-Cutting Systems** (Segment 6)
7. **Navigation** (Segment 7) — last, once surfaces are settled

---

## Already drafted (reference)

- ✅ `MISSION.md`
- ✅ `Invite_Vendor_Workflow.md`
- ✅ `Vendor_Onboarding_Workflow.md`
- ✅ `Document_Verification.md`
- ✅ `AI_Verification_Engine.md`
- ✅ `Renewal_and_Expiration_Chase.md`
- ✅ `Add_Existing_Vendor_to_Locations.md`
- ✅ `Audit_Export_Generation.md`
- ✅ `Search.md`
- ✅ `Navigation.md`
- ✅ `Document_Storage_and_Security.md`
- ✅ `Audit_Trail.md`
- ✅ `Notifications_and_Communications.md`
- ✅ `Status_Vocabulary.md`
- ✅ `Manager_Home_Dashboard.md`
- ✅ `Corporate_Command_Center.md`
- ✅ `Vendor_Record.md`
- ✅ `Regional_District_View.md`
- ✅ `Location_Record.md`
- ✅ `Reports_and_Analytics.md`
- (your full `VISION.md`)
