# System / Workflow: Audit Export Generation

> The **"prove it on demand"** verb (MISSION #2 defensibility). Produces a **point-in-time, self-contained, defensible compliance record** for a chosen scope — a vendor, a location, a region, or the whole org. Promotes the **Export** section embedded in [[Audit Trail]] to a standalone workflow, since several surfaces launch it and it has real generation mechanics of its own.
> Part system, part workflow: no new surface — it's **triggered from existing surfaces** ([[Corporate Command Center]], [[Vendor Record]], [[Location Record]], [[Regional District View]]) and runs a generation pipeline. Follows the system/workflow shape of [[Document Verification]] and [[Renewal & Expiration Chase]]. `[[wikilinks]]` point to related docs.

## Scenario

Storage Star's insurer asks for proof that every vendor working its Spokane region carried compliant coverage. The compliance director opens the [[Corporate Command Center]], scopes to the Spokane region, and clicks **Export / audit snapshot**. UnifyCOI assembles the region's vendors, their current statuses, the requirements in force, and the full event trail behind each decision into a **PDF** the insurer can read and a **CSV** for their records — generated in seconds, logged as an access event, and self-describing (who pulled it, when, at what scope). No spreadsheet assembly, no inbox archaeology. Separately, when a dispute arises over whether one paving contractor was covered for a specific job, an Admin exports that **single vendor's** record from the [[Vendor Record]] — the same engine, narrower scope.

## What it produces

One artifact, two formats, always self-contained — it stands on its own as proof without access to the live system:

- **PDF** — the human/auditor-facing **defensible snapshot**: posture, vendors in scope, requirements in force, and the decision/event trail, formatted for a non-operator reader.
- **CSV** — the same record as **structured data** for portability and the auditor's own tooling.

*(Format is **both**, locked in [[Audit Trail]]. Some scopes lean one way — a roster is most useful as CSV, a summary as PDF — but the engine produces both; consumers take what they need.)*

### Contents (what goes in the record)

A scoped export carries everything needed to stand alone:

1. **Metadata header** — tenant, scope, **generation timestamp** (server time), the generating user (with role), the filters applied, the format, and whether Sensitive data was included. This is what makes the artifact self-describing and the export reproducible.
2. **Compliance posture (as of generation)** — the current roll-up for the scope: approved / at-risk / non-compliant counts and compliant-%, broken down by location/region/trade as the scope warrants ([[Status Vocabulary]]).
3. **Requirements in force** — the **resolved effective requirements** for the scope at generation time (org base → trade/location overrides → precedence, platform floor marked) from [[Requirements Configuration]] — so a reader can see *what the vendors were measured against*.
4. **Event trail** — the relevant [[Audit Trail]] entries for the scope: extractions, verifications and their Pass/Deficient/Uncertain outcomes, AI recommendations and the reasoning the human saw, every approve/reject/override with actor + reason + timestamp, correction requests and resubmissions, renewals and auto-continues, lapses, re-evaluations, location associations, and communications sent.
5. **Documents-on-file manifest** — which artifacts (COI/W-9/ACH/license) are on file per vendor, with submission and confirmed-expiration dates, and **version history** (superseded documents are retained and listed — see Edge states). Sensitive contents are governed by the rule below.

## Time semantics — now + full history *(decision locked this session)*

An export reflects **current state at generation time, plus the complete event trail leading to it.** "Here's exactly where we stand today, and the full record of how we got here."

- The **posture** is current (as of the generation timestamp). The **history** is carried by the event trail, which is append-only and therefore already a complete chronological record.
- **No as-of-date reconstruction in v1.** Producing a snapshot of *past* posture ("show our state as it stood on 2025-12-31") by replaying the trail to a chosen date is **architected-for, not built** — the append-only [[Audit Trail]] makes it possible later without rework, deferred like scheduled delivery and SMS. For now, "prove it on demand" means **current posture + full trail**, which satisfies the common audit and dispute needs (the trail already shows what was true and when).

## Scope model

**One generation engine; scope is a parameter**, always clamped to the requesting user's role scope ([[Roles & Permissions]]). The same pipeline serves every entry point — what differs is the breadth of data and which surface launched it.

| Scope | Launched from | Typical use |
|---|---|---|
| **Vendor** | [[Vendor Record]] → Zone 5 | A single vendor's defensible record (a dispute, an insurer query about one contractor). |
| **Location** | [[Location Record]] → export action | One store's compliance record. |
| **Region** | [[Regional District View]] / [[Corporate Command Center]] | A district's vendors and posture (Standard-only for a District — below). |
| **Org** | [[Corporate Command Center]] → Export / audit snapshot | The whole portfolio — the leadership/insurer/audit packet. |
| **Full tenant** | Platform console, on offboard | The complete tenant export the offboard posture promises ([[Platform Systems & Tenancy]] — "suspend + retain + export on demand"), generated by platform staff on the tenant's behalf. |

## Who can generate what

Honors the [[Roles & Permissions]] audit/export rights and the [[Document Storage & Security]] Sensitive rule:

| Role | Scope | Sensitive data |
|---|---|---|
| **Admin** | Any scope in the tenant | **May include** (opt-in, below) |
| **District Manager** | Their region(s) | **Never** — Standard-data only |
| **Store Manager** | **None** — no audit/export right (operational views suffice; [[Roles & Permissions]]) | — |
| **Platform staff** | Full-tenant, via **logged impersonation** or the offboard export, on the tenant's behalf | Per impersonation rules; logged |

- **Store Managers don't generate audit exports.** Their job is operational ("who can I hire") on the [[Manager Home Dashboard]] / [[Location Record]]; the evidentiary record is a corporate/district function.
- A **District** self-generates a **region-scoped, Standard-only** snapshot *(default — inherits the open item in [[Regional District View]]: self-generate vs. view-only + request from Admin)*.

## Sensitive data in exports

The [[Document Storage & Security]] decision is locked: **only an Admin can export records containing Sensitive data** (ACH/full TIN); non-Admin exports are **Standard-data only**. Layered on top, a default for the *audit* artifact specifically:

> **Decision to confirm:** Sensitive data is **excluded by default even for an Admin**, opt-in per export with a reason. An audit/defensibility packet is about *coverage and compliance*, not banking — and handing ACH/TIN to an external auditor or insurer is rarely intended. So the Admin **opts in** to include Sensitive contents, that inclusion is **extra-logged** (a Sensitive-access event), and the export header records it. This is the secure-by-default reading (MISSION #9, minimize exposure). Default off; confirm.

- When Sensitive is excluded, contents are **omitted from the artifact entirely** — not merely masked in the rendered PDF (consistent with the [[Regional District View]] rule: "excluded, not just masked"). The manifest still shows the documents are *on file*.

## Generation is itself a logged event (meta-audit)

Producing an export is an **Access event** in the [[Audit Trail]]: who generated it, when, at what scope, with which filters, in which format, and **whether Sensitive data was included**. Because the trail is append-only, an export's own generation appears in any *later* export that covers it — the act of proving is itself part of the provable record. Sensitive values are never written into these log entries.

## Integrity & defensibility

- **Self-describing.** The metadata header makes the artifact stand on its own — a reader knows exactly what scope, moment, and filters produced it.
- **Server-time, reproducible.** The timestamp is server time, never the client. Re-running the same scope later produces the same record *plus* any events that landed in between — transparently, because the trail only grows (append-only; [[Audit Trail]]).
- **Tamper-evidence is inherited.** The export's trustworthiness rests on the underlying trail being append-only and integrity-protected (the Audit Trail's ideal; its mechanism is a flagged open item there). A PDF integrity stamp (hash/signature) ties to that work — flagged below, not invented here.

## Delivery & performance

- **Small scope (vendor, location)** — generated **synchronously**: click → assemble → download.
- **Large scope (region, org, full tenant, or long histories)** — **queued and generated asynchronously**, with a "your export is ready" notification carrying the download link, riding the [[Notifications & Communications]] rails. *(Decision to confirm: the scope/size threshold that flips sync → async — default by scope as above.)*
- **Scheduled / recurring export delivery** (e.g. a monthly posture packet emailed to leadership) is **deferred — architected-for, not built** — the same deferral as the [[Reports & Analytics]] scheduler and SMS; it would ride the same digest rails. The generation + delivery layer is built so adding a scheduler later doesn't rework it.

## Relationship to Reports & Analytics (shared plumbing, different artifact)

This export and [[Reports & Analytics]] **share the PDF/CSV export plumbing** but answer different questions, and must not be conflated:

- **Audit Export** *(this doc)* — **evidentiary**, event-level, scope-specific **proof**: the trail + requirements + posture for a defensible record.
- **Reports & Analytics** — **management analytics**: aggregate trend/forecast/roster views for planning and reporting up.

The Reports catalog's **Audit-Readiness Summary** is a *management* summary that **links out to this export** for the event-level proof, rather than reproducing it.

## Retention & legal hold

- Exports draw on **retained** data — the **7-year schedule** from when a record goes inactive ([[Document Storage & Security]]). Superseded documents and closed vendors remain exportable through the window, which is the point: a dispute can surface after a relationship ends.
- A **legal hold** pauses purge so the data stays exportable through an active dispute/audit ([[Document Storage & Security]] / [[Audit Trail]] open item). *(Flag: whether a dedicated "dispute/litigation export" mode — tagged and hold-aware — is wanted; not built.)*

## Edge & error states

- **Empty scope** (no vendors/data in scope) → a **valid but empty** export that states "no vendors in scope," not a failed job — an honest record that the scope was clear.
- **Out-of-scope or over-privileged request** (a District requests org scope, or a non-Admin requests Sensitive inclusion) → **blocked server-side** and logged as a scope/security violation ([[Regional District View]], [[Document Storage & Security]]); never silently downgraded without telling the user.
- **Generation fails mid-job** → never emit a partial or misleading artifact; the attempt is logged, retried/queued, and the user is told it didn't complete.
- **Very large org/tenant export** → async; the **CSV streams** and the **PDF summarizes + references** rather than rendering hundreds of thousands of rows (a defensible summary with the structured detail in the CSV).
- **Superseded documents** → **included as history** (retained, provable) with version lineage — the export shows what was on file *and* what replaced it, not just the current document.
- **Tenant Suspended / Offboarded** → export remains available on demand (the whole offboard posture is *suspend + retain + export*); platform staff generate the full-tenant export on the tenant's behalf via the console ([[Platform Systems & Tenancy]]).
- **Concurrent generations** → each export is an **independent point-in-time snapshot**; two run seconds apart may differ if events landed between them — each is internally consistent and stamped with its own generation time.
- **Sensitive included by an Admin** → the extra Sensitive-access logging fires per included record, and the header flags the inclusion, so "who exported banking data, when" is always answerable.

## End state

- A **defensible PDF + CSV** record for the requested scope — downloaded (small scope) or delivered when ready (large scope) — capturing **current posture + the full event trail**.
- The generation is **logged** as an access event, with scope, filters, format, and Sensitive-inclusion recorded.
- The operator can answer the mission's ultimate test on demand: *can we prove our compliance status right now?* ([[MISSION]] #2, and the third "ultimate test" question).

## Open questions

- **As-of-date reconstruction** — deferred; the append-only trail supports adding it later (above).
- **Sensitive opt-in default** — exclude-by-default even for Admins, opt-in with reason (above); confirm.
- **Sync → async threshold** — which scopes/sizes queue (above); default by scope.
- **District self-generate vs. request-from-Admin** — inherits the [[Regional District View]] open item; default self-generate, Standard-only.
- **Scheduled/recurring delivery** — deferred; rides the [[Notifications & Communications]] rails when built.
- **PDF integrity mechanism** (hash/signature) — ties to the [[Audit Trail]] tamper-evidence open item.
- **Dedicated dispute/litigation export mode** (hold-aware, tagged) — flagged, not built.

## Links

- [[Audit Trail]] — owns the event model, retention, and access rules this draws on; this **promotes its embedded Export section** to a standalone workflow
- [[Corporate Command Center]] — the org/region/location trigger surface ("Export / audit snapshot")
- [[Vendor Record]] — the per-vendor trigger (Zone 5 timeline → export)
- [[Location Record]] — the per-location trigger
- [[Regional District View]] — the region-scoped, **Standard-only** District export rule
- [[Reports & Analytics]] — shares the PDF/CSV plumbing; the management-analytics counterpart the Audit-Readiness report links out from
- [[Document Storage & Security]] — Sensitive = Admin-only / non-Admin Standard-only; retention + legal hold the export honors
- [[Roles & Permissions]] — who holds audit/export rights (Admin full, District region-view, Store none)
- [[Platform Systems & Tenancy]] — the offboard "export on demand" full-tenant variant; impersonation rules for platform-generated exports
- [[Notifications & Communications]] — async "export ready" delivery; the rails a deferred scheduler would ride
- [[Requirements Configuration]] — the resolved requirements in force the export includes
- [[Status Vocabulary]] — the statuses the posture section counts
- [[MISSION]] — #2 defensibility; the "prove it on demand" ultimate test
