# Surface: Corporate Command Center

> A **surface** (noun) — a place corporate/compliance users land to oversee risk across the whole portfolio.
> Counterpart to the operational [[Manager Home Dashboard]]: same data, different question, different lead.

## Role & question

**Primary role:** Corporate compliance / risk / ops leadership (COO, VP/Director of Ops or Compliance, ownership). Regional managers may have a scoped version — defined in [[Regional District View]] (region-scoped, oversight actions removed).
**The one question they need answered:** *"Is the portfolio compliant — and what's about to break?"*

This surface is about **risk oversight**, not getting a single job done. Its user isn't hiring a plumber; they're answerable for the compliance posture of dozens to hundreds of facilities and need to catch lapses before they become liability.

> **Surface contrast:** the [[Manager Home Dashboard]] is operational and leads with "who can I hire / are my invites moving." This surface is exceptions-first — it leads with what needs attention. Don't reuse the manager hierarchy here.

## Job

Answer, at a glance:
1. Are we compliant right now? (portfolio posture, provable)
2. What needs attention, ranked by risk? (expired/expiring, non-compliant, stalled)
3. Where is the risk concentrated? (by location, region, trade)
4. Can I prove it on demand? (audit-ready export)

## Information hierarchy

**Exceptions first** — this is the surface the mission's exception-based principle was written for. Routine "everything's fine" recedes; risk leads. Ranking, top to bottom:

1. **Risk / needs-attention queue** — every at-risk item across the portfolio, ranked by severity and time-to-lapse (expired now → expiring soon → non-compliant → stalled onboarding). This is the reason corporate opens the screen.
2. **Portfolio posture** — the headline compliance number(s) and trend, with breakdown by location/region so risk concentration is obvious.
3. **Pipeline & throughput** — aggregate onboarding/renewal flow; a health check, not a to-do list (individual chasing is the manager's job).

If nothing needs attention, the risk queue says so explicitly — "no open compliance risks across N facilities" — because for this user, a credible all-clear is the product.

## Zones

### Zone 1 — Risk Queue (primary)
- **Shows:** all at-risk vendors org-wide — Expired, expiring within thresholds, Non-Compliant (missing endorsements, low limits, lapsed policy), and stalled invites/onboarding. Ranked by severity × time-to-lapse, with the affected location(s).
- **Why:** the core "what's about to break?" answer.
- **Priority:** Primary, top of screen.
- **Actions:** drill to [[Vendor Record]]; filter by severity/location/trade; trigger/confirm system renewal chase; assign/route to a manager.
- **Empty state:** "No open compliance risks across N facilities."

### Zone 2 — Portfolio Posture
- **Shows:** org-wide compliance rate + trend; breakdown by location and region; deltas (improving/declining).
- **Why:** answers "are we compliant?" and "where is risk concentrated?"
- **Priority:** Primary–secondary.
- **Actions:** drill into a location/region; export/audit snapshot.
- **Empty state:** "No data yet — posture appears once vendors are onboarded."

### Zone 3 — Pipeline & Throughput
- **Shows:** aggregate counts in each pipeline stage (Invited → Onboarding → Under Review → Approved), renewal volume, and where things stall.
- **Why:** a system-health view — is onboarding flowing, are renewals keeping pace.
- **Priority:** Secondary.
- **Actions:** drill into a stage; see stalls by location.
- **Empty state:** "No vendors in progress."

## Scope & filters

Multi-location is the whole point of this surface:
- Default scope is the **entire org**; drill down to region → location.
- Filters: severity, status, trade, location/region, time-to-lapse window.
- Roll-ups must reconcile with manager-level views (the same vendor's status reads identically here and on the [[Manager Home Dashboard]]).

## Global actions

- **Export / audit snapshot** — produce a point-in-time, defensible compliance record (directly serves the "prove it on demand" job and the defensibility principle); runs the [[Audit Export Generation]] workflow at org/region/location scope.
- **Manage requirements** — set/adjust the coverage requirements vendors are verified against. *(May warrant its own [[Requirements Configuration]] workflow.)*
- Search — org-wide vendor/location search ([[Search]]).

## States

- **First-run / empty:** pre-onboarding org → guide toward setup (requirements, locations, first invites) rather than empty risk widgets.
- **Loading:** render the risk queue first (the reason they're here), then posture, then pipeline.
- **High volume:** risk queue is rank-and-paginate; posture summarizes with drill-down; never an undifferentiated wall.
- **Error:** isolate failures per zone; a broken pipeline feed must not blank the risk queue.

## Refresh

Risk queue and posture should reflect current state and update without manual refresh — stale risk data is the one thing this surface can't afford. *(Confirm: live vs. refresh-on-load.)*

## Open questions to confirm

- Does requirements configuration live here, or in its own surface/workflow?
- Severity thresholds (what counts as "expiring soon" — 30/60/90d?) — org-set or per-location?
- What exactly goes in the audit export, and in what format? — **resolved:** PDF + CSV, contents = event trail + resolved requirements + posture (now + full history); see [[Audit Export Generation]].

## Links

- [[Manager Home Dashboard]] — the operational, throughput-first counterpart
- [[Regional District View]] — the region-scoped variant of this surface for District Managers
- [[Reports & Analytics]] — the deliberate historical/forecast/roster counterpart to this real-time, exception-first surface
- [[Vendor Record]] — drill-down destination from any risk-queue row
- [[Vendor Onboarding Workflow]] — what in-pipeline vendors are doing
- [[Requirements Configuration]] — (proposed) where coverage requirements are defined
- [[Audit Export Generation]] — the export/audit-snapshot workflow this surface launches
- [[Search]] — the org-wide vendor/location search this surface invokes
- [[Navigation]] — the Admin/District sidebar; this surface is their default landing
