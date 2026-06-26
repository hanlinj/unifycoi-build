# Screen / Workflow: Add Existing Vendor to Locations

> The **"collect once"** verb (MISSION #6). An already-**Approved** vendor is associated with **more locations without re-collecting documents** — their stored documents are re-evaluated against each new location's resolved requirement matrix, and the **Admin activates** the vendor at each location they satisfy. The payoff of "approve once, associate with many" ([[MISSION]] #5, #6): vendor knowledge is reused across the portfolio instead of re-onboarded per store.
> Verb-style workflow doc; follows the shape of [[Invite Vendor Workflow]] and [[Vendor Onboarding Workflow]]. `[[wikilinks]]` point to related docs.

## Scenario

Storage Star already uses Acme Plumbing — approved months ago for two Spokane facilities, COI and W-9 on file, banking set up. A district manager opens a third store and wants Acme there too. They don't re-invite Acme or ask for paperwork again. From Acme's [[Vendor Record]] they pick **Add to additional locations**, select the new store, and submit. UnifyCOI re-checks Acme's *existing* documents against that store's requirements — instantly, with no new upload and no message to the vendor — and tells the Admin: *"Acme's documents meet this location's requirements — recommend activate."* The Admin clicks **Activate**; Acme is now hireable at the third store. Acme never knew it happened. (Had the new store required a $2M GL limit Acme's $1M certificate doesn't meet, the Admin would instead see a flagged deficiency and could request a better certificate — the only thing that ever reaches the vendor.)

## What makes this different from a new vendor

A new vendor is **collected, verified, and approved** from scratch ([[Invite Vendor Workflow]] → [[Vendor Onboarding Workflow]] → [[Document Verification]]). This verb **reuses everything already collected**:

- **No re-collection.** The vendor is not contacted and uploads nothing. The documents on file are the inputs.
- **No re-extraction.** Because the documents are unchanged, the engine runs **rules-only against the stored extracted values** — the same mechanism as a rule-change re-evaluation, no new Vision call (see [[AI Verification Engine]] → reuse; this is its third trigger, `location_add`).
- **Re-evaluated per new location.** Each new location resolves its **own** effective requirement matrix (org base → trade override → location override, precedence policy, never below the platform floor — [[Requirements Configuration]]). The vendor's stored values are compared against each, independently.
- **Admin activates, every location.** A clean re-evaluation produces a **recommendation**, not an automatic approval. The Admin activates the vendor at each new location — *(decision locked this session — see below)*.

## Preconditions

- The vendor is **Approved at ≥ 1 existing location** with documents on file. This verb extends an existing approval; it does not create one. A vendor still in onboarding just gets the new locations added to their in-flight invite instead.
- The vendor's coverage is **currently valid** (not [[Status Vocabulary|Expired]]). You can't extend lapsed coverage to a new store — restore coverage first (the [[Renewal & Expiration Chase]] handles the lapse), then add the location.
- The initiating user is in scope for the target location(s): **Admin** (org-wide), **District Manager** (their region), or **Store Manager** (their store) — same scoping as inviting (see [[Roles & Permissions]]). Initiating ≠ activating: only an **Admin activates** (below).
- The target locations are not already associated with this vendor (duplicates are a no-op — see Edge states).

## Entry points

Two paths, one workflow:

1. **From the [[Vendor Record]]** — the **Add to additional locations** global action. The deliberate path: an Admin or in-scope manager pulls up a known vendor and extends them to more stores.
2. **From [[Invite Vendor Workflow]] (duplicate detection)** — when a manager tries to "invite" a vendor whose business name/email already exists, the invite flow recognizes the duplicate and offers to **add the selected facilities to the existing vendor** instead of creating a second record. That offer routes here. This is the safeguard that stops the same vendor being onboarded twice (MISSION #6).

Both land in the same location-association run described below.

## Steps (happy path)

1. **Open the add-to-locations action** from one of the entry points above. The vendor's identity, trade, and current approved locations are shown for context.
2. **Pick the new location(s).** A facility picker — the same component as the invite flow's location picker — scoped to the facilities the initiating user is authorized for. Locations the vendor already covers are shown as already-associated and can't be re-picked.
3. **Submit.** For each newly picked location, the system creates a **pending vendor-location association** and enqueues a **rules-only re-evaluation** (`location_add` run) of the vendor's stored extractions against that location's resolved requirement matrix. No document upload, no vendor contact.
4. **Engine re-evaluates per location.** For each new location, the rules engine produces per-requirement **Pass / Deficient / Uncertain** outcomes and a roll-up recommendation — exactly the [[Document Verification]] verification model, minus extraction (the values already exist). Each new vendor-location enters **Under Review** with its recommendation.
5. **Admin reviews and activates, per location.** On the [[Vendor Record]] workbench, the Admin sees each new location's result:
   - **Clean** → recommendation *"Documents meet this location's requirements — recommend activate."* The Admin clicks **Activate**; the vendor → **Approved** at that location and becomes hireable there.
   - **Deficient / Uncertain** → flagged for the Admin, who works it (request a better document, override, or leave open) — see Outcomes below.
6. **The vendor is now associated** with the activated locations. Their **overall** status re-derives (e.g. *"Approved · 3 of 3 locations"*). The vendor was never contacted. Everything is logged.

## Outcomes per new location (what the Admin sees, and how it routes)

The re-evaluation classifies the new location exactly as [[Document Verification]] classifies an onboarding submission — same outcomes, same routing — the only difference is the inputs are stored values, not a fresh upload.

### Clean — stored documents satisfy the new location
- The new vendor-location sits in **Under Review** with *"recommend activate."*
- **The Admin activates it** — a deliberate per-location approval click, **every association** *(locked decision below)*. Fast, because the recommendation does the analysis; the human still makes the call.
- On activate: vendor → **Approved** at that location; appears in the [[Manager Home Dashboard]] "who can I hire" directory for that store; counts toward [[Corporate Command Center]] posture.

### Deficient — stored documents fall short at the new location
- The new location resolves a **stricter** requirement than the vendor's documents meet (e.g. a $2M GL location when the vendor carries $1M; a required endorsement this location adds). Routes to the **Admin, flagged**, on the [[Vendor Record]] — *"General liability limit is $1M; this location requires $2M."*
- **Curing it requires a better document**, and the only way to get one is from the vendor. The Admin sends the engine-drafted correction request ([[Document Verification]] → deficiency loop; **Admin-initiated** by default per the locked Q2 decision). This is the **one case where the vendor is contacted** — and the request **reuses the chase machinery** ([[Renewal & Expiration Chase]]): vendor-direct, tokenized, no-login, escalating reminders.
- The replacement document is **new**, so it runs the **full pipeline** (re-extract + re-verify) and is re-evaluated **across all the vendor's locations** — same as a renewal. An upgraded certificate only helps existing approvals; any regression would surface there too.
- Until cured, the vendor is **Approved at the locations they satisfy and open at the deficient one** — the deficient location's per-location status is **Under Review** (or **Onboarding · Action Needed** once a correction is requested), while the overall stays **Approved · N of M**. The vendor is hireable where they qualify (MISSION #5 per-location honesty; #13 don't let admin friction block work elsewhere).
- The Admin may also **override** the deficiency (e.g. accept the lower limit for this store) with a logged reason ([[Document Verification]] → approve/reject; MISSION #4 humans in control).

### Uncertain — the stored evaluation can't be called at the new location
- A stored value the engine flagged low-confidence at onboarding (e.g. a non-standard endorsement) may be **Pass at a lenient location and Uncertain at one that requires that endorsement**. Routes to the **Admin, flagged for a human read** — never silently passed (MISSION #1).
- The Admin verifies from the document on file, then activates or requests a clarifying document.

> **A new-location shortfall is a *Deficient finding*, not *Non-Compliant*.** The vendor has never been approved at this location, so they aren't *drifting* out of compliance there — they simply don't qualify *yet*. **Non-Compliant** stays reserved for **post-approval drift** at a location the vendor *was* approved at ([[Status Vocabulary]]). Keeping this line clean is why the new location enters **Under Review**, not Non-Compliant.

## Decision locked this session — Admin activates every association

A clean re-evaluation **does not auto-activate.** Even when the vendor's stored documents cleanly meet a new location's requirements, **an Admin clicks Activate** for that location.

- **Why** — *"only Admin approves, every time"* governs whether a vendor is **hireable at a location**, and a **new location relationship is a new place the vendor becomes hireable.** Treating it as a per-location approval keeps that principle intact (Segment 4 Q1).
- **Contrast with renewals** — a clean **renewal** *auto-continues* without an Admin click ([[Renewal & Expiration Chase]]), because it maintains an **existing** approved relationship. A location-add **creates a new** relationship, so it is **not** auto-continued. *(This is the deliberate asymmetry: renewals maintain; associations establish.)*
- **What this costs and buys** — it adds one Admin click per new location. The recommendation makes the click fast, and the activation is logged with the recommendation the Admin saw — so the gain is full defensibility on every place the vendor is approved (MISSION #2, #4).

## Expiration (not re-gated here)

The onboarding **expiration gate** ([[Vendor Onboarding Workflow]]) fires when a vendor *uploads* a document. This verb uploads nothing — the documents on file were already gated and the dates already attested. So:

- The re-evaluation reads the **stored, already-confirmed expiration date(s)**; it does not re-prompt the vendor and does not re-gate.
- A precondition keeps this safe: the vendor must be **currently valid** (not Expired) to add locations at all. A vendor whose coverage has lapsed can't be extended to a new store until coverage is restored.
- When a **cure document** is uploaded (deficient path above), *that* upload goes through the normal expiration gate like any submission.

## Sensitive data

Nothing changes here — no new collection, so no new exposure. Masking and access are unchanged from the [[Vendor Record]]: a District or Store Manager who initiates an add still never sees banking/tax contents (Admin-only, server-side — [[Document Storage & Security]], [[Roles & Permissions]]). Adding a vendor to a location does **not** widen who can see Sensitive data; it widens which stores can hire them.

## Status & state transitions

Adds two transitions to the canonical machine ([[Status Vocabulary]]); introduces **no new status**.

| From | Event | To (per location) |
|---|---|---|
| *(no association at this location)* | Vendor added to a new location; `location_add` rules-only re-eval runs | **Under Review** (per-location) |
| Under Review *(location-add)* | Admin **activates** | **Approved** (at that location) |

- The deficient/uncertain sub-paths reuse the existing [[Document Verification]] transitions (Under Review → *Action Needed* on a correction request → Under Review on the cure document → Approved on activation).
- **Overall status is derived** (the [[Vendor Record]] header rule): approved at every assigned location → **Approved**; approved at some with a new one still in-pipeline → **Approved · N of M locations** (drill in for which). The existing approved locations stay hireable throughout (MISSION #13).

## End state

- The vendor is associated with the new location(s); each is either **Approved** (Admin-activated) or **in-pipeline** (deficient/uncertain, being worked).
- No duplicate vendor record was created; documents were collected **once** and reused (MISSION #6).
- The vendor was contacted **only if** a new location required a better document.
- Every step is logged: the association created, the `location_add` re-evaluation and its per-requirement results, the Admin's activation decision (with the recommendation they saw), and any correction request — all to the [[Audit Trail]].

## Edge & error states

- **Location already associated:** shown as already-covered in the picker; can't be re-added (no-op). If the vendor is currently *deficient/expired* at a location, that's worked through the existing loops, not by re-adding.
- **Vendor not yet Approved anywhere:** this verb isn't offered — manage their locations through the in-flight [[Invite Vendor Workflow]] / [[Vendor Onboarding Workflow]] instead.
- **Vendor currently Expired:** adding locations is blocked until coverage is restored (can't extend lapsed coverage). The action explains why and points to the renewal in progress.
- **Multiple new locations, mixed results:** each is evaluated and activated independently — the vendor can be activated at the ones they satisfy in the same pass while a deficient one stays open and chases a correction. Per-location truth on the [[Vendor Record]] drill-in.
- **Stored documents would be deficient at *every* new location:** still valid to do — the Admin gets the flagged deficiencies and one correction request (a single better document can satisfy several locations at once); the vendor isn't activated anywhere new until cured.
- **Cure document also affects existing locations:** the new document runs the full pipeline and re-verifies across all assigned locations (renewal semantics). An upgrade preserves existing approvals; a regression would surface as a deficiency there too — caught, not hidden.
- **A renewal lands mid-association** (the vendor's policy renews while a new-location add is pending): runs are ordered; the renewal's new extraction supersedes, and the pending location-add re-evaluates against the **superseding** values, logged ([[AI Verification Engine]] → concurrent runs).
- **Requirement change at a target location mid-association:** the activation decision is made against the **resolved matrix at activation time**; if it changes before the Admin activates, the re-evaluation refreshes and the Admin sees current findings.
- **Initiator lacks scope for a picked location:** the picker never offers out-of-scope locations; a stale/raced selection is rejected server-side ([[Roles & Permissions]]).
- **Removing a location association** (un-associating a vendor from a store) is a separate action governed by [[Location Management]] retention; the vendor's record and audit trail are retained per the [[Document Storage & Security]] schedule.

## Shared status vocabulary

Canonical set, flags, and transitions live in [[Status Vocabulary]]. This verb uses the existing values and adds the two `location_add` transitions above. Quick reference:
`Invited/Pending → Onboarding → Under Review → Approved → Expired → Non-Compliant`

## Open questions

- **Bulk add** — adding one vendor to many locations at once is supported; adding **many vendors** to a location in one action (the inverse) is a plausible later convenience, not built. Flagged.
- **District-initiated, Admin-activated handoff** — a District/Store Manager initiates an add but only an Admin activates. Confirm the initiating manager gets an awareness notification on activation (default: yes, digest — so they know they can now hire). Tracked in [[Notifications & Communications]].
- **Same-trade assumption** — the vendor's trade is fixed at the record level; a new location override for that trade is what varies. A vendor working a *different* trade at a new store is out of scope (re-invite as that trade). Confirm.

## Links

- [[Vendor Record]] — hosts the **Add to additional locations** action and the per-location activation workbench; the surface this verb acts on
- [[Invite Vendor Workflow]] — the duplicate-detection entry point that routes an existing vendor here instead of creating a second record
- [[Vendor Onboarding Workflow]] — the full collect path this verb deliberately skips; owns the expiration gate that does *not* re-fire here
- [[Document Verification]] — supplies the Pass/Deficient/Uncertain model, the deficiency loop, and the per-location activation decision this reuses
- [[AI Verification Engine]] — runs the **rules-only** re-evaluation (`location_add` trigger) against stored extractions; no new Vision call
- [[Requirements Configuration]] — resolves each new location's effective requirement matrix the stored values are compared against
- [[Renewal & Expiration Chase]] — its chase machinery is reused to request a cure document on a deficient new location; defines the auto-continue this verb deliberately does *not* mirror
- [[Status Vocabulary]] — the per-location statuses and the two transitions this adds; Deficient-vs-Non-Compliant line
- [[Manager Home Dashboard]] · [[Corporate Command Center]] — where a newly-activated vendor surfaces (directory; posture)
- [[Location Record]] — the new location's Zone 3 gains this vendor on activation
- [[Notifications & Communications]] — the activation-ready and (optional) initiator-awareness events
- [[Audit Trail]] — logs the association, the re-evaluation, and the Admin activation with the recommendation shown
- [[Roles & Permissions]] — who can initiate (in-scope) vs. activate (Admin only)
- [[MISSION]] — #5 multi-location first-class, #6 collect once, #13 don't let admin friction block work
