# System: Status Vocabulary

> The **single source of truth** for vendor status — the exact values, what each means, the flags that layer on top, and the explicit transitions between them. Originally defined inline in [[Invite Vendor Workflow]]; **promoted here as canonical.** Every surface and workflow uses these exact values — define once, reference everywhere.
> Scope: this is the **vendor** state machine. The **tenant** lifecycle (Provisioning → Active → Suspended → Offboarded) is a separate machine — see [[Platform Systems & Tenancy]]. Don't conflate them.

## The canonical statuses

A vendor is always in exactly one of these (per location; overall is derived — see Per-location below):

| Status | Meaning | Set when |
|---|---|---|
| **Invited/Pending** | Invite created; vendor hasn't started. | [[Invite Vendor Workflow]] sends the invite. |
| **Onboarding** | Vendor is actively providing documents. | Vendor opens the tokenized link ([[Vendor Onboarding Workflow]]). |
| **Under Review** | All documents submitted; verification done; awaiting the Admin's call. | Vendor submits; [[Document Verification]] runs. |
| **Approved** | Meets the effective requirements; hireable. | An **Admin** approves ([[Document Verification]] — only Admin approves). |
| **Expired** | A required policy is **past its expiration date** — coverage lapsed. | A policy's date passes with no valid renewal ([[Renewal & Expiration Chase]]). |
| **Non-Compliant** | A **current** document **fails a requirement** for a non-date reason. | Post-approval drift — a rule tightens and re-evaluation fails ([[Requirements Configuration]]). |
| **Declined** | An Admin **hard-rejected** the vendor (distinct from requesting a correction). | Admin rejects in [[Document Verification]]. *(Proposed — see Decisions to confirm.)* |

> **Two distinctions that matter most:**
> - **Expired vs. Non-Compliant** — *date-driven lapse* vs. *requirement failure for a non-date reason*. A vendor can conceptually be both; the headline **leads with Expired** (no coverage is the more severe state). Both pull the vendor out of "hireable" and onto the risk queue.
> - **Declined vs. Expired/Non-Compliant** — **Declined** is an Admin rejecting a vendor who was **never approved**; Expired/Non-Compliant are **post-approval** states.

## Flags & sub-states (modifiers, not statuses)

These **layer on top of** a status — they don't replace it. This is what keeps the core set small (MISSION: simplicity wins).

| Flag | Sits on | Means |
|---|---|---|
| **Action Needed** | Onboarding | The Admin requested a correction; the vendor must resubmit. *(Canonicalizes the onboarding sub-state question — it's a flag, not a new status.)* |
| **Expiring Soon** | Approved | Within the 60-day renewal window ([[Renewal & Expiration Chase]]). Still Approved/hireable — a risk signal, not a status change. |
| **Deficient** / **Uncertain** | Under Review | Per-requirement verification findings that flag the vendor for the Admin's attention. Finding-level, not statuses. |
| **Unverified** | Invited/Pending | Email couldn't be verified at send; invite sent anyway, flagged ([[Invite Vendor Workflow]]). |
| **Bounced** | Invited/Pending | Invite email bounced; inviter notified to fix and resend. |
| **Expired Invite** | Invited/Pending | Pending too long with no response; the invite aged out. |

> **Why these are flags, not statuses:** "Deficient" during onboarding is a *finding* the Admin resolves, not a place the vendor lives. **Non-Compliant** is reserved for *post-approval* requirement failure. Keeping Deficient finding-level and Non-Compliant post-approval prevents the two from blurring.

## Per-location status

Status is tracked **per vendor-location** (a vendor may pass a $1M location and be deficient at a $2M one — see [[Document Verification]] multi-location handling). The vendor's **overall / displayed** status is **derived** (the [[Vendor Record]] header rule):

- Approved at **every** assigned location → **Approved**.
- Approved at **some** → **Approved · N of M locations** (drill in for which).
- Any location still in-pipeline → the in-pipeline status leads.

> The **location-by-location vs. satisfied-set approval** *action* (can an Admin approve some locations now and leave others open?) is still open — but it doesn't change this vocabulary. Tracked as an open item on the [[Vendor Record]].

## State transitions

The canonical machine. `system` / `AI` / `Admin` / `Vendor` marks who drives each transition.

| From | Event | To |
|---|---|---|
| *(none)* | Admin/manager sends invite | **Invited/Pending** |
| *(no association at a location)* | Approved vendor added to a new location; rules-only re-eval ([[Add Existing Vendor to Locations]]) | **Under Review** *(at that location)* |
| Under Review *(location-add)* | Admin **activates** at that location | **Approved** *(at that location)* |
| Invited/Pending | Vendor opens tokenized link | **Onboarding** |
| Invited/Pending | Ages out (no response) | Invited/Pending + *Expired Invite* flag |
| Onboarding | Vendor submits all documents | **Under Review** |
| Under Review | Admin **approves** | **Approved** |
| Under Review | Admin **requests correction** (deficiency) | **Onboarding** + *Action Needed* |
| Under Review | Admin **rejects** | **Declined** |
| Onboarding *(Action Needed)* | Vendor resubmits | **Under Review** (re-verify) |
| Approved | Policy date passes, no valid renewal | **Expired** |
| Approved | Rule tightens; re-evaluation fails | **Non-Compliant** |
| Approved | Enters 60-day renewal window | Approved + *Expiring Soon* (no status change) |
| Approved | Clean renewal before expiry | **Approved** (auto-continue; new expiration) |
| Expired | Clean current document re-verified | **Approved** (lapse recovery) |
| Non-Compliant | Compliant document provided | **Approved** |
| Declined | Admin re-invites (fresh start) | **Invited/Pending** |

**Terminal-ish states:** **Approved** is the steady state the system works to reach and maintain. **Declined** is terminal unless an Admin deliberately re-invites. **Expired** and **Non-Compliant** are *recoverable* — the chase keeps working them back toward Approved.

## Where each status surfaces (pointers, not duplication)

- **[[Manager Home Dashboard]]** — Approved directory · Pending/Onboarding pipeline · needs-attention backstop (Expired, Expiring Soon, Non-Compliant, Bounced, Expired Invite).
- **[[Corporate Command Center]]** — pipeline stages (Invited → Onboarding → Under Review → Approved) · risk queue (Expired → Expiring Soon → Non-Compliant → stalled).
- **[[Vendor Record]]** — the per-vendor status header + what the record emphasizes in each state.

## Relationship to tenant lifecycle

A vendor's status lives **inside** a tenant. When a tenant is **Suspended** ([[Platform Systems & Tenancy]]), vendor statuses **freeze** — retained, not editable — and resume when the tenant returns to Active. Tenant state and vendor status are independent machines that never share values.

## Decisions to confirm

- **Declined** as a canonical terminal status (proposed above) — confirms the hard-reject path distinct from request-correction.
- An **Archived / Removed** status for vendors an Admin deliberately removes (vs. Declined)? Default: removal is an action that retains the record per the [[Document Storage & Security]] schedule; no separate live status. Confirm whether removed vendors need a visible terminal status.
- **Action Needed** as a flag on Onboarding (vs. its own status) — defaulted as a flag; confirm.
- Whether **Expiring Soon** is surfaced to managers (helps them avoid hiring against a near-lapse) — leaning yes.

## Links

- [[Invite Vendor Workflow]] — originally defined this vocabulary; creates Invited/Pending + delivery flags
- [[Vendor Onboarding Workflow]] — Onboarding, Action Needed, → Under Review
- [[Add Existing Vendor to Locations]] — adds the two location-add transitions; a new-location shortfall is a Deficient finding (Under Review), not Non-Compliant
- [[Document Verification]] — Under Review findings, Approved/Declined decisions
- [[Renewal & Expiration Chase]] — Expiring Soon, Expired, lapse recovery
- [[Requirements Configuration]] — re-evaluation → Non-Compliant
- [[Vendor Record]] — per-location derivation + per-status emphasis
- [[Manager Home Dashboard]] · [[Corporate Command Center]] — surfaces that render these
- [[Platform Systems & Tenancy]] — the separate tenant lifecycle
- [[Search]] — filters on and displays these statuses/flags inline in results
