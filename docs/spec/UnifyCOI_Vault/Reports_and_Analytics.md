# Surface: Reports & Analytics

> A **surface** (noun) — where corporate/ops leadership **deliberately pulls** historical, forecast, and roster analytics to plan, report upward, and fix systemic gaps. Distinct from the two things it could be confused with: the [[Corporate Command Center]] (real-time, exception-first, "what's about to break *now*") and the [[Audit Trail]] export (evidentiary, point-in-time, "prove *this* vendor's status"). Reports is the considered, parameterized, **aggregate** view neither of those provides.
> **This session's decisions:** a **curated set of fixed, purpose-built reports** (no query/report builder — depth over breadth, MISSION #8); **on-demand view + export** for v1 (scheduled delivery architected-for but deferred, like SMS).

## Role & question

**Primary role:** Corporate compliance / risk / ops leadership — the economic buyer (COO, VP/Director of Ops or Compliance, ownership). **District Managers** get a **region-scoped subset**. **Store Managers** are not the audience — their work is operational and lives on the [[Manager Home Dashboard]].
**The one question:** *"Show me the trends, the forecast, and the roster — so I can plan ahead, report up, and see where compliance is systematically breaking."*

This surface is for **deliberate analysis**, not daily firefighting. Its user isn't reacting to a lapse (that's the Command Center); they're preparing a board update, forecasting next quarter's renewals, or spotting that one trade keeps failing the same requirement.

> **Surface contrast — three things, kept distinct:**
> - **[[Corporate Command Center]]** — *real-time, exception-first.* Leads with what needs attention now. You watch it.
> - **Reports & Analytics** *(this surface)* — *deliberate, historical/forecast/roster.* You pull it when you have a question about trend, horizon, or inventory.
> - **[[Audit Trail]] export** — *evidentiary, granular.* The defensible record of events and decisions for a specific vendor/scope. Reports is **management analytics**, not legal proof; for "prove it on demand," that's the audit export. They **share the export plumbing** (PDF + CSV) but answer different questions.

## What it is (locked this session)

A **fixed catalog** of reports, each parameterized and exportable — **not** a builder, **not** saved custom queries. The set is small and opinionated, mapped to the mission's questions and the buyer's needs. On-demand only for v1.

## The report catalog

Each report: what it answers, its parameters, and how it differs from the real-time view.

### 1. Compliance Posture Over Time
- **Answers:** is our compliance trajectory improving or declining? (the *time series* behind the Command Center's current number)
- **Shows:** approved / at-risk / non-compliant counts and compliant-% as a **trend** over the selected range, with breakdown by location, region, and trade.
- **Distinct from:** the Command Center shows *current* posture + a delta; this shows the curve.

### 2. Expiration & Renewal Forecast
- **Answers:** what's coming due, and when? (forward-looking planning horizon)
- **Shows:** policies expiring in the next 30 / 60 / 90 days (and beyond), by location / trade / vendor, with each one's renewal-chase state on the 60/30/14/7/1 ladder (per-policy tracks — see [[Renewal & Expiration Chase]]).
- **Distinct from:** the Command Center risk queue surfaces "expiring soon *now*"; this is the **planning forecast** ("Q3 has 40 renewals concentrated in two regions").

### 3. Vendor Roster & Coverage
- **Answers:** who do we have, where, with what coverage? (the inventory)
- **Shows:** every vendor in scope — trade, approved locations, coverage summary (limits/endorsements carried), and status. The directory **as a deliverable** (e.g. for a procurement or insurer review).
- **Sensitive data excluded** — coverage facts only, never ACH/TIN (see Common mechanics).

### 4. Onboarding Throughput & Funnel
- **Answers:** how efficiently is onboarding flowing, and where does it stall? (operational efficiency over time)
- **Shows:** the funnel Invited → Onboarding → Under Review → Approved with **conversion rates, time-in-stage, and drop-off**, by location / region / inviting manager / period.
- **Distinct from:** the Command Center pipeline is a current-state health check; this is the **historical funnel with rates and durations**.

### 5. Deficiency & Exception Analysis
- **Answers:** *why* do submissions fail, and is it systemic? (continuous improvement)
- **Shows:** the most common deficiency types (missing endorsement, low limit, wrong named insured, expired-at-submission) ranked, sliced by trade and location, over time — so corporate can fix root causes ("roofers keep missing waiver of subrogation → adjust guidance").
- **Distinct from:** serves MISSION #11 (exception-based ops) at the *aggregate* level — patterns, not individual exceptions.

### 6. Audit-Readiness Summary
- **Answers:** can we show leadership/an insurer our compliance health at a glance? (management-facing posture summary)
- **Shows:** a digestible org/region summary — posture, coverage gaps, open exceptions, renewal exposure — formatted for a non-operator reader.
- **Distinct from:** this is a **management summary**, not the evidentiary record. For the defensible, event-level proof of a specific vendor or scope, use the [[Audit Trail]] export — this report **links out** to it rather than reproducing it.

## Common mechanics

- **Parameters (all reports):** **scope** (org / region / location, clamped to the user's role scope — see [[Roles & Permissions]]), **date range**, and **trade filter** where relevant.
- **Export:** **PDF** (leadership-facing) and **CSV** (data) — reusing the [[Audit Trail]] export plumbing. Non-Admin exports are **Standard-data only**, consistent with the [[Regional District View]] and [[Location Record]] export rules.
- **Sensitive data never appears in any report** — these are aggregate/roster/coverage views; ACH and full TIN are out of scope entirely ([[Document Storage & Security]]).
- **Read-only.** Reports observe; they never mutate state. No approve, no edit, no invite from here.
- **Every report generation / export is a logged access event** ([[Audit Trail]]) — who pulled what, when, at what scope.

## Scope & role access

- **Admin** — org-wide; all reports.
- **District Manager** — the same catalog, **region-scoped** (their stores only); Standard-data export.
- **Store Manager** — **not a Reports audience** by default; their store-level operational view is the [[Manager Home Dashboard]] / [[Location Record]]. *(Decision to confirm: give Store Managers a single store-roster report, or none? Default: none — keep Reports a corporate/district surface.)*
- Cross-tenant access impossible (tenant-partitioned — [[Platform Systems & Tenancy]]).

## States

- **First-run / empty:** pre-data org → explain that reports populate once vendors are onboarded, rather than empty charts.
- **Loading:** parameterized queries can be heavier than a dashboard tile; show per-report loading, render results progressively.
- **High volume:** large rosters/forecasts paginate on screen and are best consumed via CSV export; trend charts aggregate by an appropriate bucket (day/week/month) for the range.
- **Error:** isolate per report; a failed query on one report never blanks the catalog.

## Deferred (architected-for, not built in v1)

- **Scheduled delivery** — a recurring report (e.g. a Monday-morning posture summary or a monthly renewal forecast) **emailed** to corporate, riding the existing [[Notifications & Communications]] digest rails (email-only, scoped). Deferred exactly like SMS: the report-generation + export layer is built so adding a scheduler later doesn't rework it. *(The strongest planned extension.)*
- **Query / report builder** and **custom saved reports** — explicitly **out of scope for v1** (depth over breadth; a generic BI tool is a non-goal).

## Open questions

- **Confirm the catalog** — are these six the right v1 set? Any to cut (e.g. fold Audit-Readiness into the audit export) or add?
- **Store Manager access** — single store-roster report vs. none (above); default none.
- **Scheduling priority** — deferred by default; promote into v1 if a scheduled exec summary is a launch must-have.
- **Billing/cost analytics** — location-count/spend is **platform billing**, not tenant compliance; treat as out of scope here unless an operator-facing cost report is wanted later.
- **Per-report format** — default both PDF + CSV everywhere; confirm if some reports are CSV-only (roster) or PDF-only (audit-readiness summary).

## Links

- [[Corporate Command Center]] — the real-time, exception-first counterpart; Reports is the deliberate-analysis surface
- [[Audit Trail]] — shares the PDF/CSV export plumbing; owns the evidentiary "prove it on demand" record that the Audit-Readiness report links to
- [[Audit Export Generation]] — the evidentiary export workflow the Audit-Readiness report links out to (distinct from these management reports)
- [[Renewal & Expiration Chase]] — the per-policy expiration data the Renewal Forecast report draws on
- [[Document Verification]] — the deficiency findings the Exception Analysis report aggregates
- [[Status Vocabulary]] — the statuses every posture/funnel report counts
- [[Requirements Configuration]] — the requirements coverage reports measure against
- [[Regional District View]] — region-scoped reports for a District Manager
- [[Manager Home Dashboard]] · [[Location Record]] — where Store Managers get their operational/store views instead
- [[Notifications & Communications]] — the rails a deferred scheduled-report delivery would ride
- [[Document Storage & Security]] — Sensitive data excluded; Standard-only export for non-Admins
- [[Roles & Permissions]] — role-scoped access this enforces
- [[MISSION]] — #8 simplicity / depth over breadth (why fixed reports, not a builder); the three questions the catalog answers
- [[Navigation]] — the Reports sidebar entry (org for Admin, region/Standard-only for District)
