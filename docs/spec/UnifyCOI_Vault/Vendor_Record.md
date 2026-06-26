# Surface: Vendor Record

> The detail surface for a single vendor — created by [[Invite Vendor Workflow]], completed by [[Vendor Onboarding Workflow]], populated by [[Document Verification]], and the place the **Admin approves or rejects**. The drill-in destination from both the [[Manager Home Dashboard]] and the [[Corporate Command Center]].
> A **surface** (noun): you land, orient, and act. It has no single happy path; document it by *what it shows, in what priority, per role, and where it leads.* One record, **role-scoped** — see below.

## Role & question

One record, three readers, three questions:

- **Admin** — *"Should I approve this vendor, and can I defend the call?"* Gets the full review-and-approve workbench, every finding, the audit trail, and the sensitive data (ACH/TIN).
- **Store / District Manager** — *"Where is this vendor, and can I use them?"* Read-only operational view: status, trade, contact, which of their locations the vendor covers. **No approve action** (see [[Roles & Permissions]]); sensitive banking/tax data **masked**.
- **Corporate / compliance (non-admin)** — *"What's this vendor's posture and history?"* Read + audit/export within scope.

The record adapts by role — it does not become three different screens. Same entity, same status, scoped visibility and actions.

> **Surface contrast:** the dashboards answer portfolio/operational questions *across* vendors; the Vendor Record is the *single-vendor* truth they both drill into. A vendor's status must read **identically** here and on either dashboard (the roll-ups reconcile — MISSION multi-location is first-class).

## What it shows (information hierarchy)

Lead with identity + status, then — for an Admin reviewing — the decision workbench, then the supporting detail, then the history. Ranking, top to bottom:

1. **Identity & status header** — who the vendor is and where they stand right now. The one-line answer for a manager; the orientation for an Admin.
2. **Review workbench** *(Admin, when Under Review)* — the findings, **organized by document**, that drive approve/reject.
3. **Per-location compliance** — the multi-location truth, summarized in the header and expanded here on drill-in.
4. **Documents on file** — the actual artifacts, role-masked.
5. **Activity & audit timeline** — every event, for defensibility.

## Zones

### Zone 1 — Identity & Status header (always)
- **Shows:** business name, primary trade, contact (name/title/email/phone), assigned locations, and the **overall status** in the shared vocabulary. When the vendor is assigned to multiple locations with mixed results, the status summarizes with a count — e.g. *"Approved · 3 of 4 locations"* — and the breakdown lives in Zone 3.
- **Why:** the at-a-glance answer every role needs first.
- **Status headline rule:** approved at every assigned location → **Approved**; approved at some → **Approved · N of M locations** (drill in for which); none yet → the in-pipeline status (Onboarding / Under Review).
- **Actions:** role-dependent global actions (below).

### Zone 2 — Review workbench (Admin · Under Review)
The approve/reject decision happens here. Organized **by document** (Q1 decision): each uploaded document is a section showing what the engine read and how it measured up.

- **Per document** (COI, W-9, ACH, license): the **viewable artifact**, the **extracted values** [[Document Verification]] pulled from it, and the **requirement findings sourced from that document** — each marked **Pass / Deficient / Uncertain**, with extracted-vs-required shown inline.
  - *Example — COI section:* GL limit $2M (req $1M) ✓ · Auto $1M (req $1M) ✓ · Additional-insured endorsement ✓ · Waiver of subrogation **Uncertain — verify** · Expiration 2026-09-14 (vendor-confirmed).
- **Deficiencies and Uncertain items are flagged prominently within their document** — the by-document organization never buries a problem. An Admin can see at a glance which documents are clean and which need attention (MISSION exception-based, applied inside the chosen layout).
- **Engine recommendation:** the roll-up call — *"All requirements met — recommend approve"* or *"1 deficiency, 1 item to verify."* A recommendation, never an auto-decision (Q1: Admin clicks every time).
- **Actions (Admin):** **Approve** · **Reject** (with reason) · **Request correction** (sends the engine-drafted plain-language fix request — see [[Document Verification]] deficiency loop) · **Override** a specific deficiency (with reason; logged).
- **Note:** expiration never appears here as a deficiency to judge — it was gated at upload in [[Vendor Onboarding Workflow]]. The confirmed expiration date shows as context, not a decision.
- **Also serves location-add activation:** when an approved vendor is [[Add Existing Vendor to Locations|added to a new location]], the same by-document workbench shows the **stored** documents re-evaluated against the **new location's** requirements (rules-only — no re-upload, no re-gated expiration). The Admin's action there is **Activate at [location]** (clean) or work the flagged deficiency; clean associations are not auto-activated.

### Zone 3 — Per-location compliance (drill-in)
- **Shows:** the breakdown behind the header's roll-up — for each assigned location, whether the vendor **satisfies that location's effective requirements**, and if not, what's short. (A $1M COI passes a $1M location, is deficient at a $2M location — see [[Document Verification]] multi-location handling.)
- **Why:** multi-location honesty without cluttering the header. The vendor is hireable at the locations they satisfy.
- **Actions:** drill from a location to the specific requirement that fails there.

### Zone 4 — Documents on file
- **Shows:** every submitted artifact (COI, W-9, ACH, license) with submission date and the confirmed expiration date(s) where applicable.
- **Sensitive data is role-masked — Admin-only:** ACH/banking and full TIN are visible only to **Admins**. A District or Store Manager sees that a W-9 and ACH are *on file*, not their contents (see [[Roles & Permissions]] and [[Document Storage & Security]]).
- **Actions:** view/download an artifact (authorized roles); see version history when a document was resubmitted through the correction loop.

### Zone 5 — Activity & audit timeline
- **Shows:** the full chronological trail — invited, onboarded, each extraction and verification result, each engine recommendation, each Admin decision (approve/reject/override + reason + actor + timestamp), each correction request and resubmission, each notification sent.
- **Why:** the defensibility backbone (MISSION #2). This is what the [[Corporate Command Center]] export draws on to "prove it on demand."
- **Actions:** export this vendor's record (point-in-time, defensible).

## States (what the record emphasizes, by status)

- **Invited/Pending:** header + a quiet "waiting on the vendor to start"; resend/cancel invite available. Workbench empty.
- **Onboarding:** header + progress ("2 of 3 documents received"); no decision yet.
- **Under Review:** **Zone 2 leads** — this is the Admin's reason to be here.
- **Approved:** header leads with the approval and the **earliest upcoming expiration** ("valid through 2026-09-14"); workbench collapses to a read-only record of the approved findings. Managers can confidently hire.
- **Expired / Non-Compliant:** the **deficiency and what's needed lead** — post-approval drift (lapsed policy or a tightened rule, per [[Requirements Configuration]] re-evaluation). Surfaces on the [[Corporate Command Center]] risk queue; the record shows exactly what broke and the path back.

## Global actions (role-dependent)

- **Approve / Reject / Request correction / Override** — Admin only, when Under Review (Zone 2).
- **Resend / cancel invite** — inviter, when Pending → re-enters [[Invite Vendor Workflow]].
- **Add to additional locations** — "collect once": associate this approved vendor with more facilities without re-onboarding ([[Add Existing Vendor to Locations]]). Stored documents are re-evaluated (rules-only) against each new location's requirements; an **Admin activates** the vendor at each location they satisfy. In-scope managers can initiate; only an Admin activates.
- **Export record** — point-in-time defensible export (any audit-authorized role within scope) via [[Audit Export Generation]].

## Scope

Honors role scope throughout (see [[Roles & Permissions]]):
- A **Store Manager** can open the record only for a vendor assigned to one of their facilities, and sees the operational view (masked sensitive data, no approve).
- A **District Manager** — same, region-wide.
- An **Admin** — any vendor in the tenant, full workbench.
- Cross-tenant access is impossible (vendors are per-tenant isolated — see [[Platform Systems & Tenancy]]).

## Edge & error states

- **Document failed to extract:** that document's section shows a re-upload request rather than a finding; the Admin isn't asked to judge an unreadable scan (it bounced to the vendor — see [[Vendor Onboarding Workflow]]).
- **Resubmitted document:** Zone 4 keeps version history; Zone 2 reflects the re-verified result; Zone 5 logs both submissions.
- **Mixed multi-location result:** header shows the count; Zone 3 carries the per-location detail. Approving applies to the locations the vendor satisfies. *(Decision to confirm: can an Admin approve location-by-location, or only the satisfied set at once? Default: approve the satisfied set; deficient locations stay open and chase corrections.)*
- **Manager opens a sensitive-data vendor:** banking/tax masked; attempting to view full values is blocked by role, not just hidden in UI.
- **Status changes while open** (e.g. a renewal lapses mid-session): the record reflects current state; stale compliance data is the one thing this surface can't show wrong.

## Open questions

- Location-by-location approval vs. satisfied-set approval (above).
- Masking rules + which roles see full ACH/TIN — **resolved: Admin-only**, enforced server-side, in [[Document Storage & Security]].
- Does "Add to additional locations" live as an action here, a standalone workflow, or both? — **resolved: both** — the action here launches the [[Add Existing Vendor to Locations]] workflow; in-scope managers initiate, an **Admin activates** each new location.
- Whether managers see a "valid through" date on Approved vendors (likely yes — helps them avoid hiring against a near-lapse) without seeing compliance internals.

## Links

- [[Invite Vendor Workflow]] — creates this record
- [[Add Existing Vendor to Locations]] — the "Add to additional locations" action launches this workflow; activation happens on this record's workbench
- [[Audit Export Generation]] — the per-vendor export launched from Zone 5
- [[Vendor Onboarding Workflow]] — completes it; owns the upstream expiration gate
- [[Document Verification]] — populates the workbench; defines Pass/Deficient/Uncertain and the deficiency/approve routing
- [[Requirements Configuration]] — the effective requirements each finding is measured against (per location)
- [[Roles & Permissions]] — role-scoped visibility, sensitive-data masking, Admin-only approval
- [[Manager Home Dashboard]] · [[Corporate Command Center]] — the surfaces that drill into this record
- [[Platform Systems & Tenancy]] — per-tenant vendor isolation
- [[Search]] — a drill-in destination from vendor search results
