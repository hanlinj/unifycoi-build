# System / Workflow: Renewal & Expiration Chase

> The autonomous loop that keeps approved vendors current. **Time-triggered, vendor-direct, exception-surfacing.** It closes the lifecycle — Invite → Onboarding → Verification → Approval — into a *maintained* loop, so coverage never lapses silently.
> Part system, part workflow: the happy path has **no human initiator** (the clock triggers it) and **no human approver for clean renewals** (they auto-continue). Humans see only exceptions.

## What it does

For every **Approved** vendor, continuously:

1. **Monitor** the confirmed expiration date(s) captured at onboarding (and updated on each renewal) — see [[Vendor Onboarding Workflow]].
2. **Chase** the renewal before a policy lapses, vendor-direct, on an escalating cadence.
3. **Re-verify** the renewed document against current effective requirements via [[Document Verification]].
4. **Auto-continue** a clean renewal — no fresh approval gate — and **notify the Admin for awareness**.
5. **Surface only exceptions** — deficient renewals, unresponsive vendors, and actual lapses — to the people who need them.

This is the mission's "autonomous coordinator" thesis in one workflow: the system keeps vendors compliant and quietly hands a human only what genuinely needs judgment (MISSION #3 minimize human chase-work, #11 exception-based operations).

## Trigger & cadence

The chase is driven by each policy's **expiration date**, on a fixed escalating ladder:

| Days before expiry | Action |
|---|---|
| **60** | First renewal request to the vendor (vendor-direct, tokenized). Chase begins. |
| **30** | Reminder (if not yet renewed). |
| **14** | Reminder, tone escalates ("your coverage expires soon"). |
| **7** | Reminder; the vendor's manager/Admin gain visibility that a lapse is approaching. |
| **1** | Final reminder; imminent-lapse exception raised. |
| **0 (expiry passes)** | Status → **Expired**; lapse-recovery chase continues (below). |

- **Per-policy tracks.** A vendor with GL expiring in September and auto expiring in December has **two independent chase tracks**. Each policy is chased as *its* date approaches.
- The vendor's **"valid through"** on the [[Vendor Record]] is the **earliest** upcoming expiration across required policies.
- This 60-day lead aligns the chase with the [[Corporate Command Center]] "expiring soon" window and the [[Manager Home Dashboard]] needs-attention backstop — the dashboards surface what the chase is already working.

> **Decision to confirm:** the ladder is a **fixed default** for now (you chose 60/30/14/7/1). Org-configurable lead time + cadence is a plausible later addition; flagged, not built.

## The chase (happy path — fully autonomous)

1. **60 days out**, the system sends the vendor a **renewal request** — vendor-direct, via a tokenized link (the same no-login pattern as [[Vendor Onboarding Workflow]]). The manager is **not** a courier (MISSION #7 remove the middleman).
2. Reminders **escalate** at 30/14/7/1 if the vendor hasn't renewed.
3. The vendor uploads the renewed COI through the tokenized resubmission flow and **confirms the new expiration date(s)** — the same objective **expiration gate** as onboarding (an already-expired replacement bounces back to them, never to the Admin).
4. [[Document Verification]] **re-verifies** the renewed document against the vendor's **current** effective requirements (which may have tightened since the last approval — see [[Requirements Configuration]]).
5. **Clean →** the vendor **auto-continues Approved**, the new expiration date is recorded, and the **Admin is notified for awareness** (and it's written to the audit trail). No approval click. *(Q2 decision.)*

> **Why auto-continue doesn't break "only Admin approves":** a *new* vendor approval is a deliberate Admin decision (see [[Document Verification]] → approve/reject). A **renewal continuation** of an already-vetted vendor whose new document passes clean is a *different action* — routine maintenance, not a fresh approval. It auto-continues, but the Admin notification + audit log preserve defensibility (MISSION #2): the operator can still say exactly when and why coverage continued. The Admin retains control — they can intervene on any notified renewal.

## Exception paths (the point of the workflow)

### Deficient renewal
The renewed document is current but fails a requirement (limit too low, missing endorsement, named insured wrong). This is **not** auto-continued — it routes to the **Admin, flagged**, exactly like any deficiency (see [[Document Verification]] → deficiency loop). The vendor stays Approved on the *old* policy until it expires; if it expires before the deficiency is cured, they lapse to **Expired**.

### Unresponsive vendor / imminent lapse
The vendor doesn't renew as the ladder escalates. By 7 days out, the Admin and the assigned manager gain visibility (the vendor appears in the [[Corporate Command Center]] risk queue under "expiring soon" and the [[Manager Home Dashboard]] backstop). The system keeps chasing — humans are *informed*, not *enlisted to chase*.

### Lapse (expiration passes with no valid renewal)
- Status flips **Approved → Expired** at the expiration date.
- The vendor is **immediately removed from the "who can I hire" directory** on the [[Manager Home Dashboard]] — no one should hire against lapsed coverage. This is the whole reason the loop exists.
- Surfaces at **top severity** on the [[Corporate Command Center]] risk queue ("Expired now").
- The chase **continues as lapse-recovery** — the system keeps requesting a current document; a clean one restores **Approved** (auto-continue + notify, same as a renewal).

> **Decision to confirm:** grace period. Default: **none** — Expired the moment the date passes, removed from hireable instantly (safest compliance posture). Some operators may want a short grace window before removal; flagged as a possible org setting, not built.

## Status semantics (keep these distinct)

- **Expired** — a required policy is **past its expiration date**. Objective, date-driven. Owns the lapse case here.
- **Non-Compliant** — a **current** document **fails a requirement** for a non-date reason (limit, endorsement, named insured) — including post-approval drift when [[Requirements Configuration]] rules tighten.

A vendor can conceptually be both; the **headline leads with Expired** (no coverage is the more severe state). Both pull the vendor out of hireable and onto the risk queue.

## Interaction with requirement changes

A **rule tightening** in [[Requirements Configuration]] triggers re-evaluation (defined there) and can flip an approved vendor to **Non-Compliant**. That re-evaluation is **rules-only against the vendor's stored extracted values** (no re-extraction — the document hasn't changed; see [[AI Verification Engine]]). **Curing** it does require a new document, which **reuses this chase machinery** to request the update from the vendor — same vendor-direct, tokenized, escalating pattern. Difference: the trigger is a *rule change*, not a *date*. Same loop, different cause.

The **same cure path** serves [[Add Existing Vendor to Locations]]: when an approved vendor's stored documents fall short at a **new** location, the Admin's correction request asks the vendor for a better document through this same tokenized loop. (The clean case differs from a renewal — a new-location association is **Admin-activated**, not auto-continued.)

## Notifications (who gets what)

Routine work is quiet; exceptions are loud. *(The notification/communication system itself is a Segment 6 cross-cutting doc — this defines the renewal events it must carry.)*

- **Vendor:** renewal request (60d) + escalating reminders (30/14/7/1); a "thanks, you're current" confirmation on a clean renewal.
- **Admin:** an **awareness** notification on each clean auto-continue; **exception alerts** on a deficient renewal, an imminent lapse, or an actual lapse.
- **Manager (assigned):** backstop visibility as a lapse nears and when it happens — so they don't unknowingly hire a vendor about to (or already) lapse.

## Defensibility / audit

Everything is logged (MISSION #2): each reminder sent, each renewal submitted, each re-verification result, each **auto-continue with its Admin notification**, each lapse, each lapse-recovery. This trail feeds the [[Corporate Command Center]] "prove it on demand" export.

## Edge & error states

- **Vendor renews very early** (e.g. 90 days out, before the chase starts): accept it — verify and update the expiration date; the chase track resets to the new date.
- **Multiple policies, staggered expiries:** independent tracks; a lapse on *one* required policy expires the vendor even if others are current (partial coverage ≠ compliant). *(Confirm: does a single lapsed required policy expire the whole vendor, or only at locations requiring that policy? Default: a required policy lapsing expires the vendor at every location that requires it; per-location truth shows on the [[Vendor Record]] drill-in.)*
- **Renewed doc is for the wrong policy/entity:** treated as a deficiency → Admin, flagged.
- **Vendor unresponsive through lapse-recovery indefinitely:** stays Expired and out of hireable; remains on the risk queue until cured or the vendor is removed by an Admin. *(Confirm: auto-archive a long-lapsed vendor after N days?)*
- **Expiration date itself was wrong** (vendor mis-confirmed at onboarding): the chase fires on the recorded date; a corrected date can be re-confirmed on the next upload. *(Edge; rare given the onboarding confirmation step.)*

## Open questions

- Grace period before Expired-removal (above) — default none.
- Org-configurable cadence later (above) — default fixed ladder.
- Whole-vendor vs. per-location expiry when one required policy lapses (above).
- Auto-archive policy for indefinitely-lapsed vendors (above).
- Channel for vendor reminders — **resolved: email only for v1** (SMS a future extension); see [[Notifications & Communications]].

## Links

- [[Vendor Onboarding Workflow]] — captures the confirmed expiration dates this monitors; its tokenized resubmission flow is reused for renewals
- [[Document Verification]] — re-verifies renewed documents; defines the deficiency routing a bad renewal falls into
- [[AI Verification Engine]] — re-extracts renewals through the full pipeline; runs rules-only for rule-change re-evaluation
- [[Requirements Configuration]] — supplies current requirements (which may have tightened); rule-change re-evaluation reuses this loop
- [[Add Existing Vendor to Locations]] — its deficient-new-location cure reuses this tokenized chase loop; its clean path is Admin-activated, not auto-continued
- [[Vendor Record]] — shows "valid through," the Expired/Non-Compliant states, and the per-location drill-in
- [[Corporate Command Center]] — risk queue where expiring/expired vendors surface by time-to-lapse
- [[Manager Home Dashboard]] — needs-attention backstop; loses Expired vendors from "who can I hire"
- [[Invite Vendor Workflow]] — defines the shared status vocabulary used here
