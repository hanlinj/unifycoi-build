# System: Audit Trail

> A **cross-cutting systems** doc (not a screen). The **defensibility backbone** — MISSION #2. Every meaningful action is logged **immutably** so an operator can always say *why* a vendor was approved, rejected, or flagged. This consolidates the logging requirements scattered across the workflow docs into one canonical model. It isn't a surface, but it *surfaces* on the [[Vendor Record]] timeline and powers the [[Corporate Command Center]] export.

## Why it exists

Defensibility is non-negotiable for a compliance product. AI assists, automates, and recommends — but humans decide, and **both** the AI input and the human decision are recorded. The test the whole system is built to pass: *"Can we prove our compliance status, and justify every call, right now?"* The audit trail is what makes the answer yes.

## What gets logged (event taxonomy)

Consolidated from every workflow. Each category below produces audit entries:

- **Vendor lifecycle** — invited, onboarding started, documents submitted, and **every status transition** in the shared vocabulary (`Invited/Pending → Onboarding → Under Review → Approved → Expired → Non-Compliant`).
- **Location associations** — a vendor **added to a new location** (actor = initiating user), the rules-only re-evaluation it triggers, and the **Admin's per-location activation** (actor = Admin, with the AI recommendation shown) — see [[Add Existing Vendor to Locations]]. The activation is a logged decision parallel to an approval.
- **Document events** — each upload; each **extraction** (what was read, from which document, with confidence); each resubmission and version; supersession of an old document by a renewal.
- **Verification events** — each requirement evaluation (**Pass / Deficient / Uncertain**) and the **AI recommendation + its reasoning** (see [[Document Verification]]).
- **Decisions** — **approve, reject, override** — each with **actor, reason, timestamp**; deficiency correction requests sent.
- **Renewal / expiration** — reminders sent (60/30/14/7/1), renewals received, **auto-continues with the Admin awareness notification**, lapses, lapse-recoveries (see [[Renewal & Expiration Chase]]).
- **Requirement changes** — edits to requirements, trade/location overrides, precedence policy, template applications, and any **re-evaluation** they trigger — each with a **required reason/note** (see [[Requirements Configuration]]).
- **Access events** — **every access to Sensitive data** (who viewed/downloaded ACH/TIN, when), user invites and role changes, and **exports generated** (see [[Document Storage & Security]]).
- **Platform / support** — **impersonation** sessions and **every action taken under impersonation**, attributed to the **real platform user**, not the client (see [[Platform Systems & Tenancy]]).
- **Communications** — notifications/reminders sent to vendors and staff (the fact + a reference to what was sent).
- **Data lifecycle** — deletions and purges: what, when, by whom, and why.

## Anatomy of an audit entry

Every entry carries:

| Field | Notes |
|---|---|
| **id** | Unique, sequential. |
| **tenant** | Scopes the entry; never crosses tenants. |
| **timestamp** | Server time, immutable. |
| **actor** | The user (with role) — or **`system`** / **`AI`** for automated actions. Impersonation records the real platform user. |
| **action** | What happened (e.g. `vendor.approved`, `document.extracted`, `requirement.changed`). |
| **target** | What it acted on (vendor / document / requirement / location / user). |
| **before → after** | For changes, the prior and new values. |
| **reason / note** | Required where a human exercises judgment (override, reject, requirement change). |
| **source** | UI / API / system / impersonation. |
| **AI detail** | For AI events: confidence and the reasoning the human saw. |

## Properties

- **Append-only / immutable.** Entries are **never edited or deleted**. A correction is a *new* entry, not an overwrite. *(Default-confirm — this is the right posture for compliance; calling it out because it shapes the persistence design.)*
- **Tenant-isolated.** Every entry is scoped to its tenant; no cross-tenant visibility (see [[Platform Systems & Tenancy]]).
- **Attributed.** Every entry has an actor. System and AI actions are labeled as such; impersonated actions attribute to the real platform user.
- **Retained** per the **7-year schedule** in [[Document Storage & Security]]. A **purge** is itself a controlled, logged event — never a silent delete.
- **Tamper-evident** (ideal) — integrity-protected so entries can't be silently altered. *(Mechanism deferred — flagged in Open questions.)*

> **Decision to confirm:** should the audit trail be retained **longer than the documents** it describes? Audit records often need to outlive the underlying files (a dispute can surface years after a document is gone). Default for now: **same 7-year schedule** as documents; flag whether the trail warrants a longer window.

## Who can read it (access)

From the [[Roles & Permissions]] matrix — the trail honors the same scoping as everything else:

| Role | Audit access |
|---|---|
| **Admin** | Full, org-wide. |
| **District Manager** | View, **region** scope. |
| **Store Manager** | **None.** |
| **Vendor** | None — no access to the internal trail. |
| **Platform staff** | Via **logged impersonation** only. |

Sensitive-data **access events** are themselves visible to Admins — so "who looked at the banking info" is answerable.

## Where it surfaces

- **[[Vendor Record]] → Zone 5** — the per-vendor chronological **timeline**: every event for that vendor, in order.
- **[[Corporate Command Center]] → export** — the org / region / location **"prove it on demand"** record.

## Export ("prove it on demand")

A **point-in-time, defensible** record drawn from this trail. The full generation workflow — scope model, role rules, contents, formats, delivery — is its own doc: **[[Audit Export Generation]]** (promoted from this section). In brief:

- **Scope:** vendor, location, region, whole org, or full tenant (offboard).
- **Contents:** the relevant event trail **plus** the current resolved requirements and the compliance posture **as of generation** — so the export stands on its own as proof. Time semantics are **now + full history** (no as-of-date reconstruction in v1).
- **Format:** **both** — a **PDF** human/auditor-facing snapshot and a **CSV** for structured data.
- Generating one is itself a **logged access event** (recorded here, attributed to the generating user).

> This **resolves** the open export-format question on the [[Corporate Command Center]] (PDF + CSV) and the "what goes in the export" question (contents above; detail in [[Audit Export Generation]]).

## AI and the trail

Because AI **recommends** and humans **decide**, both are recorded: an approval or override entry shows the **AI recommendation and reasoning the human saw** at the moment of the call. This is what makes "humans remain in control" (MISSION #4) provable rather than asserted — you can always show that a person made the decision, and what they were shown when they made it.

## Edge & error states

- **Logging must not fail silently.** If an action succeeds, its audit entry must persist. If logging itself fails, surface it — a successful action with no trail is a defensibility hole.
- **High volume.** The trail grows large; index by tenant / vendor / time; the per-vendor timeline and exports **paginate or stream** rather than loading everything.
- **Clock integrity.** Timestamps come from server time, never the client.
- **Purge vs. legal hold.** A scheduled purge may need to be **paused by a legal hold** (active dispute/audit). Coordinate with [[Document Storage & Security]] — a hold overrides purge-eligibility.
- **Concurrent actions.** Entries are ordered deterministically (sequential id + timestamp) so a busy moment doesn't produce an ambiguous sequence.

## Open questions

- Export format — default **both** (above); confirm if one is preferred.
- Audit retention vs. document retention — same 7 years, or longer for the trail (above)?
- Tamper-evidence mechanism specifics (deferred).
- Are routine logins / **standard**-data reads logged, or only Sensitive access? Default: **Sensitive access always; standard at a lighter grain** (see [[Document Storage & Security]]).
- Requirement-change reason/note — default **mandatory** (resolves the open item in [[Requirements Configuration]]); confirm.

## Links

- [[Document Verification]] — logs extractions, evaluations, AI recommendations, and approve/reject/override decisions
- [[AI Verification Engine]] — emits the `document.extracted`, `requirement.evaluated`, and `ai.recommendation` events (attributed to AI/system, Sensitive values redacted)
- [[Renewal & Expiration Chase]] — logs reminders, renewals, auto-continues, lapses, recoveries
- [[Add Existing Vendor to Locations]] — logs the association, the location-add re-evaluation, and the Admin's per-location activation decision
- [[Requirements Configuration]] — requirement changes logged with a required reason
- [[Document Storage & Security]] — retention schedule, Sensitive-access logging, tamper-evidence, purge
- [[Platform Systems & Tenancy]] — impersonation logged and attributed to the real platform user
- [[Vendor Record]] — the per-vendor timeline surface (Zone 5)
- [[Corporate Command Center]] — the org-wide export surface ("prove it on demand")
- [[Audit Export Generation]] — the export workflow this trail feeds (promoted from the Export section above)
- [[Reports & Analytics]] — shares this export plumbing; provides aggregate/management analytics distinct from the evidentiary trail
- [[Roles & Permissions]] — who can read the trail
