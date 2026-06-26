# Surface: Manager Home Dashboard

> Worked example for the **surface** template (the noun counterpart to the verb-style [[Invite Vendor Workflow]]).
> Surfaces are places you land, orient, and branch from — they don't have a happy path or an end state.
> Document them by *what they show, in what priority, and where they lead.*

## Role & question

**Primary role:** Store Manager (also used by Regional/District managers at wider scope — see [[Regional District View]]).
**The one question they need answered:** *"Who can I hire right now — and are my invites moving along?"*

A store manager is not a compliance expert and shouldn't have to be. This surface is **operational**: it gets work done. It exists so the manager can find an approved vendor and keep new invites flowing without interpreting insurance docs, searching their inbox, or calling corporate.

> **Surface contrast:** this is *not* the exception-first surface. Risk oversight — "what's about to break across the portfolio" — lives on the [[Corporate Command Center]]. The manager dashboard leads with throughput (who can I hire, are invites progressing); the corporate dashboard leads with exceptions. Same data, different question, different lead. Don't flatten the two into one pattern.

## Job

Answer, at a glance and without training:
1. Who can I hire? (approved vendors, by trade) — the everyday primary.
2. Are my invites moving along smoothly? (pending / onboarding pipeline)
3. (Backstop) Is there anything I should know before I hire? (a quiet at-risk signal — present, not the headline)

## Information hierarchy

Lead with the everyday operational answer, then the in-flight work, with risk as a visible-but-secondary backstop. Ranking, top to bottom:

1. **Approved vendor directory** — the "who can I hire?" answer; searchable by trade. This is the manager's default landing view and primary use of the screen.
2. **Pending / onboarding pipeline** — the handoff target from [[Invite Vendor Workflow]]; answers "are my invites moving?" Shows where each invited vendor sits and how long it's waited.
3. **Needs-attention backstop** — at-risk items (expiring soon, non-compliant, bounced invites) are *available and visibly flagged*, but they don't lead the screen. A manager should never unknowingly hire a vendor whose COI just lapsed — so the signal stays present (e.g. a persistent count/badge and inline flags on affected vendor rows) even when it isn't the focus.

> If the four metric cards double as a view selector, **default to Approved** (the everyday answer). Keep the needs-attention count loud even while another panel is active — backstop, not headline.

## Zones

### Zone 1 — Approved Vendor Directory (primary)
- **Shows:** all Approved vendors the manager can use, with trade, contact, and the facilities they're approved for.
- **Why:** the core "who can I hire?" answer — the reason the manager opens this screen.
- **Priority:** Primary. The main browse/search area; the default view.
- **Actions:** search/filter by trade (uses the Primary Niche enum from the invite flow), by facility, by name ([[Search]]); view → [[Vendor Record]].
- **Empty state:** "No approved vendors yet — invite your first vendor." (First-run operators live here.)

### Zone 2 — Pending / Onboarding Pipeline
- **Shows:** vendors with status Invited/Pending, Onboarding, or Under Review, with where each is in the pipeline and how long they've waited.
- **Why:** answers "are my invites moving along smoothly?" — the manager's second job.
- **Priority:** Secondary (high — this is half the manager's daily attention).
- **Actions:** view status; resend or cancel a Pending invite; nudge.
- **Empty state:** "No pending vendors. Invite one to get started." (Points at the global Invite action.)

### Zone 3 — Needs-Attention Backstop
- **Shows:** vendors that are Expired, expiring within a threshold (e.g. 30 days), Non-Compliant, plus invite failures (Bounced, Expired Invite).
- **Why:** a safety net so the manager doesn't hire against a lapsed vendor — *not* the portfolio risk view (that's corporate's job).
- **Priority:** Tertiary in placement, but its **count stays persistently visible** and affected vendors are flagged inline in the directory.
- **Actions:** view vendor → [[Vendor Record]]; resend/correct a bounced invite → re-enters [[Invite Vendor Workflow]]; request renewal (system-driven, with a manual nudge available).
- **Empty state:** "All vendors current." (Quiet confirmation, not a hero banner.)

## Scope & filters

Multi-location is first-class, so scope is a top-level control, not a buried filter:
- **Store Manager:** scoped to the facilities they're authorized for; if more than one, a facility selector (All / specific facility).
- **Regional/District:** their region's facilities, with roll-up and drill-down.
- Status filters (Approved / Pending / Needs attention) and trade filters apply within the current scope.

## Global actions

- **Invite** — primary action, always visible. Launches [[Invite Vendor Workflow]].
- Search — global vendor search across the current scope ([[Search]]).
- (Secondary, role-dependent) jump to [[Corporate Command Center]] for users with that access.

## States

- **First-run / empty:** no vendors at all → collapse to a single welcome + prominent **Invite**. Don't show three empty zones.
- **Loading:** skeleton per zone; render the directory first (the primary view), then pipeline and backstop as data arrives.
- **High volume:** the directory is search-first when large; Pending paginates; the backstop summarizes to a count + flags rather than a long list.
- **Error:** if a data source fails, show the failure in that zone only — never let one zone's error blank the whole dashboard.

## Refresh

Surface should reflect current state on load; pending counts and the at-risk backstop count ideally update without a manual refresh, since both drive the manager's decisions. *(Confirm: live vs. refresh-on-load.)*

## Links

- [[Invite Vendor Workflow]] — launched by the global Invite action; feeds Zone 2
- [[Vendor Onboarding Workflow]] — what a Pending vendor is currently doing
- [[Vendor Record]] — the detail destination from any vendor row
- [[Corporate Command Center]] — the org-wide, exception-first counterpart surface
- [[Regional District View]] — the region-scoped variant a District Manager uses alongside the Command Center
- [[Search]] — the scoped lookup powering this surface's search-first directory and global vendor search
- [[Navigation]] — the Store Manager sidebar; this surface is the default landing
