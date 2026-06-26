# System: Notifications & Communications

> A **cross-cutting systems** doc (not a screen). The machinery under MISSION #3 (minimize human chase-work) and #7 (remove the middleman): the platform communicates **directly** with whoever needs to act — vendor, manager, or Admin — so a store manager is never a courier. **Email only for v1.** **Exception-based:** risks and action-needed items go out immediately; routine awareness is **batched into a digest** so nobody is flooded.
> Communication exists *only* to support compliance workflows — this is **not** a chat, email, or collaboration tool (MISSION non-goal).

## What it's for

Every message answers the role's question and moves work forward. The guiding contract (MISSION trust-through-clarity): each notification makes clear **what's needed, why, what happens next, and who owns the next action.** Information flows straight to the person who can act on it — the platform asks the vendor for documents, explains a deficiency, and alerts an Admin to risk, without routing through a human relay.

## Channel: email (v1)

- **All notifications are email** — vendors and internal users alike. The vendor already gives an email at invite; every vendor action (onboard, renew, correct) is reached through a **tokenized link in an email** — no login (see [[Vendor Onboarding Workflow]]).
- **SMS is a deliberate future extension**, not v1. Vendors are tradespeople on a phone between jobsites, so SMS is the strongest later addition; the event model below is channel-agnostic so adding SMS doesn't require reworking it. *(This resolves the deferred channel question in [[Renewal & Expiration Chase]]: email only for now.)*

## Two tiers: immediate vs. digest

The decision that keeps the product from becoming noise at portfolio scale:

- **Immediate** — anything **time-sensitive, risk-bearing, or action-needed** goes out the moment it happens.
- **Digest** — **routine / informational / awareness** items are **batched** into a periodic summary (default **daily**) so an Admin overseeing hundreds of facilities isn't pinged on every routine event.

The flood this solves is specifically **internal**: a clean auto-continue renewal across a large portfolio would otherwise generate constant "FYI" emails. Those now land in the digest. **Exceptions never wait for the digest.**

> **Vendor-facing messages are effectively always immediate** — each vendor receives only a handful of messages about their *own* onboarding, so there's no flood to batch. The digest is an **internal** (manager/Admin) mechanism.

> **Decision to confirm:** digest cadence — default **daily**. Allow weekly, or per-user configurable? (See Preferences.)

## Event catalog

Consolidated from every workflow. Tier shown for the **internal** recipient; vendor-facing items are immediate.

| Event | Recipient(s) | Tier | Purpose |
|---|---|---|---|
| Invite sent | Vendor | Immediate | The invite + tokenized onboarding link. |
| Invite reminder (aging Pending) | Vendor | Immediate (scheduled) | System nudges so the manager doesn't chase. |
| Invite bounced | Inviter | **Immediate** | Action: fix the address and resend ([[Invite Vendor Workflow]]). |
| Onboarding drop-off nudge | Vendor | Immediate (scheduled) | Resume the unfinished submission. |
| Submission received / under review | Vendor | Immediate | Reassuring confirmation; no internal status exposed. |
| Vendor ready for review | Admin | **Digest** | Routine throughput — "here's today's review queue." |
| New-location association ready for activation | Admin | **Digest** | The [[Add Existing Vendor to Locations]] review item — an approved vendor re-evaluated at a new location, awaiting the Admin's activation click. |
| Vendor activated at a new location | Initiating manager (if not the Admin) | **Digest** | Awareness for the manager who requested the add — they can now hire the vendor at that store. |
| Correction request (deficiency) | Vendor | Immediate | Plain-language fix request the Admin sends ([[Document Verification]]). |
| Deficient renewal | Admin | **Immediate** | Exception — a renewal didn't clear. |
| Renewal request + ladder reminders (60/30/14/7/1) | Vendor | Immediate (scheduled) | The autonomous renewal chase ([[Renewal & Expiration Chase]]). |
| Clean auto-continue renewal | Admin | **Digest** | The awareness item — *this was the flood; now batched.* |
| Imminent lapse (vendor unresponsive) | Admin + assigned manager | **Immediate** | Exception — a lapse is approaching. |
| Lapse (vendor → Expired) | Admin + assigned manager | **Immediate** | Exception — coverage gone; vendor pulled from hireable. |
| Lapse recovered | Admin | **Digest** | Good news, routine. |
| Re-evaluation flags vendor Non-Compliant (rule tightened) | Admin | **Immediate** | Exception — new risk surfaced ([[Requirements Configuration]]). |
| Daily digest | Admin / corporate (+ managers, scoped) | (the digest itself) | The batched routine summary. |

## Recipients & scoping

Honors the [[Roles & Permissions]] scope — everyone is notified only about vendors in their scope:

- **Admin** — org-wide.
- **District Manager** — their region.
- **Store Manager** — their store(s); the assigned/inviting manager gets the backstop alerts (bounce, imminent lapse, lapse) for their vendors.
- **Vendor** — only about their own onboarding/renewal.

## Preferences & opt-outs

- **Exception/risk notifications are not opt-out-able** — a lapse alert or a blocking deficiency can't be silenced; compliance integrity depends on them.
- **Routine/digest** items are adjustable — a user can change digest cadence or opt out of purely informational items, but **never** suppress risk.
- Notification settings scope from the [[Roles & Permissions]] matrix (Admin org-wide; District/Store own). Defaults proposed in [[Client Org Settings]].

> **Decision to confirm:** exact opt-out granularity (per-event vs. all-routine on/off). Default: **all-routine toggle + cadence**; exceptions always on.

## Tone & content

MISSION UX north star — write for a busy operations manager or a tradesperson, **never** an insurance professional:

- **Plain language, no jargon** — especially vendor-facing. A vendor sees "your certificate needs to list Storage Star as additional insured," not endorsement codes.
- **Professional, friendly, direct.** Every message: what's needed, why, what's next, who owns it.
- **Personalized** from workflow data (company, contact, locations) — the invite and correction requests are populated, not generic.
- **Vendors never see internal compliance status** — confirmations are reassuring and neutral ([[Vendor Onboarding Workflow]]).

## Branding

> **Decision (addresses the open item in [[Client Org Settings]]):** **vendor-facing** emails are branded as the **operator** (the tenant — "Storage Star needs a few documents"), because the vendor knows the operator, not UnifyCOI. **Internal** emails may carry UnifyCOI branding. Confirm whether operators can supply a logo/from-name.

## Delivery & reliability

- **Bounce handling** — a bounced invite marks the delivery state and immediately notifies the inviter to correct and resend (see [[Invite Vendor Workflow]]).
- **Delivery state** is tracked per message; failures are visible, not silent.
- **Every send is logged** to the [[Audit Trail]] (the communications events — fact + reference to what was sent). Notifications are the *communicate* leg; the audit trail is the *record* leg.
- Standard email deliverability hygiene (SPF/DKIM, a real from-domain) — noted, not over-specified here.

## Edge & error states

- **Dedupe / storm prevention** — when several routine events hit at once, the digest covers them; don't fire five separate emails where one digest line suffices.
- **Empty digest** — skip the send (or a brief "all clear"); don't email an empty summary.
- **Vendor replies to a no-reply email** — this isn't a comms platform; an auto-response points them back to their tokenized link or their operator contact.
- **Recipient has no/invalid email** — surface it to the inviter/Admin; don't drop the obligation silently.
- **Exception during a digest window** — never held for the digest; sent immediately regardless.

## Open questions

- Digest cadence — daily default; weekly or per-user configurable? (above)
- Opt-out granularity — all-routine toggle vs. per-event (above).
- Vendor-facing branding — operator logo/from-name supplied how (above).
- SMS as a second channel — future; architected for, not built.
- Reply handling — fully no-reply, or a monitored support address?

## Links

- [[Invite Vendor Workflow]] — invite + reminder + bounce events
- [[Vendor Onboarding Workflow]] — tokenized links, drop-off nudges, submission confirmation
- [[Document Verification]] — correction-request (deficiency) messaging
- [[Add Existing Vendor to Locations]] — activation-ready (Admin) and initiator-awareness (manager) events; its deficient-path correction request rides the vendor-facing rails
- [[Renewal & Expiration Chase]] — the renewal ladder, auto-continue awareness, lapse alerts (channel resolved here)
- [[Requirements Configuration]] — re-evaluation / Non-Compliant alerts
- [[Audit Trail]] — every notification is logged here
- [[Roles & Permissions]] — recipient scoping and notification settings
- [[Client Org Settings]] — where notification defaults and branding are configured
- [[Corporate Command Center]] · [[Manager Home Dashboard]] — surfaces that show the risks these alerts mirror
- [[Reports & Analytics]] — a deferred scheduled-report delivery would ride these digest rails
- [[Audit Export Generation]] — async "export ready" delivery rides these rails; a deferred scheduled export would too
