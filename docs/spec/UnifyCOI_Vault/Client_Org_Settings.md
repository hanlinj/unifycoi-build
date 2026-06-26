# Surface: Client Org Settings (Profile · Notifications · Approval Routing)

> Tenant-altitude **settings** surface. Bundles three smaller config areas. Admin-managed. Several parts are **proposed defaults** to confirm, not yet hard decisions.

## Org profile

- Org name, primary contact, address/branding basics.
- Editable by **Admin**. (Plan/billing is platform-side and manual — see [[Platform Systems & Tenancy]].)

## Approval routing

Because **only Admins approve** vendors (see [[Roles & Permissions]]), routing is simple by default:
- The AI verifies a vendor's docs (see [[Document Verification]], Segment 4) and routes anything **ready to approve** or **needs a human decision** to an **Admin approval queue** (surfaced on the [[Corporate Command Center]]).
- **Default:** all Admins share one approval queue.
- **Optional (confirm):** assign approvals to a specific Admin, or route by region. Likely unnecessary at first.

## Notification settings

Who hears about what. **Proposed defaults** (all confirmable / adjustable):
- **Store Manager:** status changes on vendors *they* invited (onboarding progress, approved, deficiency, bounced invite).
- **District Manager:** the above for their region, plus region-level at-risk alerts.
- **Admin:** items needing approval, expirations/non-compliance, and failed onboarding org-wide.
- **Vendor:** invite, what's missing, reminders, approved confirmation (see [[Vendor Onboarding Workflow]], Segment 5).

Channels: email to start (matches the manual/white-glove model). Reminder cadence for renewals/chasing is defined in [[Renewal & Expiration Chase]] (Segment 4).

## Open questions

- Per-user notification opt-outs vs org-level only.
- Whether approval routing by region/assignment is needed at launch (default: no).
- Branding scope (logo on vendor-facing emails/portal?).

## Links

- [[Roles & Permissions]] — who manages settings; Admin-only approval
- [[Corporate Command Center]] — where the approval queue lives
- [[Document Verification]] · [[Renewal & Expiration Chase]] — what triggers notifications (Segment 4)
- [[Vendor Onboarding Workflow]] — vendor-facing comms (Segment 5)
