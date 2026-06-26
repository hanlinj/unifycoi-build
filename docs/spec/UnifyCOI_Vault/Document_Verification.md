# System / Workflow: Document Verification

> The AI engine — **the heart of the product.** Runs the moment a vendor submits via [[Vendor Onboarding Workflow]]. Extracts document data, verifies it against the operator's effective requirements, and classifies each requirement as pass / deficient / uncertain. **Only an Admin approves** — the engine verifies and recommends; a human always makes the call (MISSION #1 accuracy over speed, #4 humans in control).
> Part system, part workflow. Embeds the **deficiency & correction loop** and the **approve/reject decision** (each forward-linked for later standalone treatment).

## What it does

For one vendor, against the **effective requirement matrix** resolved for their trade × assigned location(s) (see [[Requirements Configuration]]):

1. **Extract** — read each submitted document (COI, W-9, ACH, license) via AI vision parsing: carrier, policy types, limits, named insured, endorsements, expiration dates, TIN, etc.
2. **Verify** — compare extracted values against each effective requirement.
3. **Classify** — mark every requirement **Pass**, **Deficient**, or **Uncertain**.
4. **Route** — clean → Admin review-and-approve; deficiencies → Admin, flagged, with a drafted correction request; uncertain → Admin, flagged for a human read.
5. **Log** — record every extraction, value, comparison, recommendation, and decision for defensibility (MISSION #2).

It is a **compliance system first, workflow system second**. When unsure, it asks for review — it never approves on a guess.

## Inputs

- The vendor's submitted documents from [[Vendor Onboarding Workflow]].
- The **effective requirements** for this vendor — the layered resolution (org base → trade override → location override, precedence policy, never below platform floor) from [[Requirements Configuration]]. A vendor on multiple locations is verified against each location's resolved requirements.
- The vendor's **confirmed expiration date(s)** — already attested at the onboarding step.

## The verification model (per requirement)

Each individual requirement resolves to one of three outcomes:

| Outcome | Meaning | Example |
|---|---|---|
| **Pass** | Extracted value clearly meets the requirement, high confidence. | GL limit $2M ≥ required $1M; additional-insured endorsement present. |
| **Deficient** | Extracted value clearly **fails** the requirement. | GL limit $500K < required $1M; required endorsement missing; wrong named insured. |
| **Uncertain** | The engine can't confidently determine pass/fail — low extraction confidence, ambiguous wording, illegible region. | Endorsement language present but non-standard; a limit obscured in a blurry scan. |

A vendor's overall result is the roll-up across every required item for every assigned location.

> Expiration is deliberately **not** in this table as an Admin-facing outcome. It's an **objective gate handled upstream** at the vendor's upload step (see [[Vendor Onboarding Workflow]] → Expiration gate). An expired policy never reaches verification's Admin routing — dates aren't open to interpretation, so a human is never asked to judge one. Everything in the table above *can* warrant judgment or an exception, so it routes to the Admin.

## Outcome routing (what reaches the Admin, and how)

Per the locked decisions: **every approval is a deliberate Admin action**, and **all deficiencies go to the Admin flagged** (expiration excepted, handled upstream).

### Clean — all Pass
- The vendor sits in **Under Review** with an engine recommendation: *"All requirements met — recommend approve."*
- The Admin still **reviews and clicks approve, every time.** No auto-approve, no skip. The recommendation makes the click fast; it doesn't replace the human (Q1 decision).
- See **Approve / reject decision** below.

### Deficient — one or more clear fails
- Routes to the **Admin, flagged**, on the [[Vendor Record]]. The Admin sees exactly what's wrong, in plain language: *"General liability limit is $500K; this location requires $1M."*
- The engine **drafts a plain-language correction request** the Admin can send to the vendor in one click (or edit first). The Admin — not the system autonomously — decides to send it, grant an exception/override, or reject (Q2 decision: deficiencies go to the Admin).
- Why the system drafts it: the Admin should never have to author an insurance explanation themselves — the engine knows the rule and the gap, so it writes the ask; the human approves it. (MISSION #7 remove the middleman in *content*, #4 human keeps control of the *send*.)
- See **Deficiency & correction loop** below.

### Uncertain — can't call it
- Routes to the **Admin, flagged for review**, with the engine's reasoning, the extracted snippet, and its confidence shown. *"Couldn't confirm the waiver-of-subrogation endorsement — please verify."*
- Never silently passed or failed (MISSION #1 — never approve on a guess; when uncertain, request human review).

> **Confidence & human handoff** — the engine attaches a confidence signal to each extraction/verification. High-confidence pass/fail flows as Pass/Deficient; anything below threshold becomes **Uncertain → human**. *(Resolved: confidence is **per-field, hybrid-derived** — model self-rating plus targeted second-pass corroboration on critical fields and low-confidence fields — and surfaced to the Admin as a **band (high/med/low) plus the flag**, never a raw number. Technical internals in [[AI Verification Engine]].)*

## Deficiency & correction loop (embedded — `[[Deficiency Loop]]` later)

When the Admin sends a correction request:

1. **Request** — vendor receives a plain-language explanation of what's missing/insufficient and how to fix it (e.g. *"Your certificate needs to list Storage Star as an additional insured. Ask your agent to add this and re-upload."*). No insurance jargon they must decode.
2. **Resubmit** — the vendor re-enters [[Vendor Onboarding Workflow]] in a resubmission state (status surfaces as **Onboarding** with an internal *Action Needed* flag — see that doc's status note) and uploads the corrected document. Collect-once holds: they only re-provide what changed, not the whole packet.
3. **Re-verify** — the engine re-runs extraction + verification on the resubmitted document against the same effective requirements.
4. **Re-route** — clean now → back to the Admin's review-and-approve; still deficient → loop again; uncertain → flagged. The vendor moves back to **Under Review** on a clean resubmission.
5. The loop is **system-chased** — reminders if the vendor stalls — so the Admin isn't manually following up (MISSION #3). The Admin set it in motion; the system carries it.

> **Decision to confirm:** does the correction request go out **Admin-initiated** (Admin clicks send on the drafted request) or may the Admin set a standing *"auto-send routine correction requests"* policy? Per Q2 the default is **Admin-initiated** (deficiencies go to the Admin). Flagging the policy option for later since it directly serves "minimize human chase-work" if the Admin opts in.

## Approve / reject decision (embedded — `[[Approve Reject Decision]]` later)

The terminal human step. **Admin-only** (see [[Roles & Permissions]] — no manager, store or district, can approve).

- The Admin works the review queue from the [[Vendor Record]]: the engine's findings are laid out **by source document** (each upload with its extracted values and the requirements it sources), every item marked Pass/Deficient/Uncertain with extracted-vs-required shown inline, and deficient/uncertain items flagged prominently within their document — so the call is fast, grounded in the actual artifact, and never buries a problem.
- **Approve** — Admin confirms; vendor → **Approved**; appears in the [[Manager Home Dashboard]] "who can I hire" directory and counts toward portfolio posture on the [[Corporate Command Center]].
- **Reject** — Admin declines with a reason (logged); vendor is not approved. *(Decision to confirm: reject vs. send-back-for-correction as distinct actions — default: "request correction" is the soft path, "reject" is the hard stop.)*
- **Exception / override** — the Admin may approve despite a deficiency (e.g. accept a slightly lower limit, grant a temporary waiver). The override **and its reason are logged** (MISSION #2 defensibility, #4 humans in control — authorized users can override; AI explains, human decides).
- Every decision — approve, reject, override, the reason, who and when — is written to the audit trail.

> **Renewals are not re-approvals.** "Admin approves every time" governs a vendor's *first* approval. A clean **renewal** of an already-approved vendor auto-continues without a fresh Admin click — the Admin is notified for awareness and it's logged. See [[Renewal & Expiration Chase]]. A *deficient* renewal, though, falls back into the normal deficiency routing above.

> **Where the Admin does this:** the per-vendor review happens on the [[Vendor Record]] (Segment 3, not yet drafted). The [[Corporate Command Center]] pipeline shows the *volume* in Under Review; the actual approve/reject workbench is the Vendor Record. Flagging so Segment 3 makes the Vendor Record the review surface.

## Multi-location handling

A vendor assigned to several locations is verified against **each location's effective requirements**. If location A requires $1M and location B (a location override) requires $2M, a $1M COI **passes A, is deficient for B**. *(Decision to confirm: is the vendor "Approved" per-location, or globally once they meet the strictest assigned location? Default: track per-location compliance; the vendor is hireable at the locations they satisfy. This preserves "approve once, associate with many" while staying honest about where they actually qualify.)*

## Re-evaluation (rules change after approval)

Per [[Requirements Configuration]], when an Admin tightens a rule, already-approved vendors are re-evaluated. A vendor that no longer meets the raised bar flips to **Non-Compliant** (distinct from onboarding *Deficient* — Non-Compliant is post-approval drift) and surfaces on the [[Corporate Command Center]] risk queue. The same routing applies. This re-evaluation is **rules-only against the stored extracted values** — the document hasn't changed, so no new extraction runs; curing it requires a fresh document through the full pipeline (see [[AI Verification Engine]] → reuse).

## Adding an approved vendor to a new location (rules-only)

When an already-approved vendor is associated with a **new location** ([[Add Existing Vendor to Locations]]), the engine re-evaluates their **stored extracted values** against that location's resolved requirements — **rules-only, no re-extraction** (the documents are unchanged; only the location set grew). Each new vendor-location enters **Under Review** with a recommendation, routed exactly like an onboarding result:

- **Clean** → *"recommend activate"*; the **Admin activates** the vendor at that location (a deliberate per-location approval — clean associations are **not** auto-continued, distinct from renewals; see that doc's locked decision).
- **Deficient / Uncertain** → flagged to the Admin; the deficiency loop applies, and the only cure is a **better document** requested from the vendor (which then runs the full pipeline and re-verifies across all the vendor's locations).

A shortfall at a brand-new location is a **Deficient finding** (the vendor was never approved there), **not Non-Compliant** — Non-Compliant stays reserved for post-approval drift at a location the vendor *was* approved at.

## Defensibility / audit

Every step is logged so an operator can always say **why** a vendor was approved, rejected, or flagged (MISSION #2):
- Each extraction (what was read, from which document, confidence).
- Each verification (extracted vs. required, the outcome).
- Each engine recommendation.
- Each Admin decision (approve/reject/override) with reason, actor, timestamp.
- Each correction request sent and each resubmission.

This audit trail is what the [[Corporate Command Center]] export draws on for "prove it on demand."

## Edge & error states

- **Extraction fails entirely** (corrupt/illegible upload): route to vendor as a re-upload request at the onboarding step, not to the Admin as Uncertain. Save Admin attention for genuine judgment.
- **Conflicting policies on one COI:** verify each policy against its corresponding requirement; roll up to the vendor result.
- **Requirement has no matching document:** the required doc wasn't provided → Deficient (missing), correction request drafted.
- **Engine disagreement with vendor-confirmed expiration:** the vendor attested a date that conflicts with what the engine reads → flag as Uncertain for the Admin (possible vendor error or extraction error). The attestation doesn't override a clear conflict.
- **Low confidence across the board** (bad scan quality): prefer a single "please re-upload a clearer photo" to the vendor over flooding the Admin with Uncertain items.

## Open questions

- Confidence threshold model — **resolved: per-field, hybrid-derived, surfaced as a band + flag** (see [[AI Verification Engine]]).
- Per-location vs. global approval semantics (above).
- Whether the Admin can opt into auto-sending routine correction requests (above).
- Reject vs. send-back as distinct terminal actions (above).
- Expiring-soon-at-onboarding threshold (see [[Vendor Onboarding Workflow]]).

## Links

- [[AI Verification Engine]] — the technical internals of this engine: extraction schema, confidence model, rules engine, persistence
- [[Vendor Onboarding Workflow]] — submits the documents that trigger this; owns the upstream expiration gate
- [[Requirements Configuration]] — supplies the effective requirement matrix this verifies against
- [[Add Existing Vendor to Locations]] — reuses this verification model (rules-only) to evaluate an approved vendor against a new location's requirements
- [[Roles & Permissions]] — only Admin approves; manager dashboards have no approve action
- [[Vendor Record]] — the Admin's review-and-approve surface (Segment 3)
- [[Corporate Command Center]] — shows Under Review volume and post-approval risk; consumes the audit trail for export
- [[Manager Home Dashboard]] — where an Approved vendor lands in "who can I hire"
- [[Invite Vendor Workflow]] — defines the shared status vocabulary used here
