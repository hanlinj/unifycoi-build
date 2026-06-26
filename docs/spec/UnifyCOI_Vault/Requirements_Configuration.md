# Screen / Workflow: Requirements Configuration

> Tenant-altitude **surface + workflow**. Where an **Admin** views and tunes the insurance/coverage requirements vendors are verified against. Seeded at provisioning from a platform template; editable **within guardrails**. Admin-only.

## Scenario

Acme's admin opens Requirements. The "Standard Self-Storage" template is already applied. The platform floor (minimum limits, mandatory COI/W-9, required additional-insured endorsement) is shown locked. The admin raises general liability limits above the floor, adds a higher requirement for roofers (trade override), and adds an extra coverage at their Spokane location (location override). They set the org's precedence policy so the stricter rule wins on any conflict.

## Preconditions

- User is an **Admin** (only Admins edit requirements — see [[Roles & Permissions]]).
- Tenant has a requirements set (applied from template at [[New Client Provisioning Workflow]]).

## The model: layered requirements

Effective requirement for a given vendor resolves in layers:

1. **Org base** — the default set for the whole tenant (from the template).
2. **Trade override** — adjustments for a trade (e.g. roofers need higher limits).
3. **Location override** — adjustments for a specific location/region.

**Conflict resolution:** when a trade override and a location override touch the **same field**, an org-level **precedence policy** (Admin-set) decides: *Strictest wins* (default), *Location wins*, or *Trade wins*. The resolved value can **never fall below the platform guardrail floor**.

## Guardrails (platform floor — locked)

Set per template at the platform level; visible but not editable by the client:
- **Minimum coverage limits** — client may raise, never lower.
- **Mandatory document types** — e.g. COI, W-9 always required; cannot be removed.
- **Required endorsements** — e.g. additional insured; cannot be removed.

The Admin can always make requirements **stricter** (higher limits, more docs, more endorsements, more overrides) — never weaker than the floor.

## What an Admin configures

- **Coverage requirements** — types (GL, auto, workers' comp, umbrella, etc.), limits, and which are required.
- **Required documents** — COI, W-9, ACH, licenses/certs; which are mandatory. (Some locked by guardrail; Admin can add more, and vary by trade — e.g. electricians must provide a license.)
- **Required endorsements** — additional insured, waiver of subrogation, etc.
- **Trade overrides** — per trade (uses the Primary Niche enum from [[Invite Vendor Workflow]]).
- **Location overrides** — per location/region.
- **Precedence policy** — strictest / location / trade.

## Surface layout

- **Org base** panel (the default set), with locked floor values clearly marked.
- **Overrides** — list of trade overrides and location overrides, each showing what it changes vs. base.
- **Precedence** setting.
- A **"preview effective requirements"** tool: pick a trade + location and see the resolved rule set the AI will verify against — critical for an Admin to trust the matrix.

## Edge & error states

- **Attempt to set below floor:** blocked with a clear message naming the guardrail minimum.
- **Removing a mandatory doc/endorsement:** not allowed (locked).
- **Overlapping overrides with no conflict:** merge cleanly (each governs different fields).
- **Changing requirements with vendors already approved:** define behavior — does tightening a rule re-flag already-approved vendors as non-compliant? *(Default: yes, re-evaluate and flag; this is the safe compliance behavior. Confirm.)* The re-evaluation runs **rules-only against stored extracted values** — no re-extraction, since the documents are unchanged (see [[AI Verification Engine]] → reuse). The **same rules-only mechanism** evaluates an already-approved vendor against a **new location's** matrix when they're associated to it ([[Add Existing Vendor to Locations]]).
- **Template updated at platform level later:** does it push to existing tenants? *(Default: no auto-push; platform applies deliberately. Confirm.)*

## End state

- The tenant's effective requirement matrix is updated; future verifications use it.
- Re-evaluation of existing vendors triggered if rules tightened (per decision above).

## Open questions

- Re-evaluation behavior when rules change (above).
- Whether requirement changes need an audit reason/note (likely yes for defensibility).

## Links

- [[New Client Provisioning Workflow]] — applies the template that seeds this
- [[Roles & Permissions]] — Admin-only editing
- [[Document Verification]] — consumes the effective requirements (Segment 4)
- [[AI Verification Engine]] — the rules engine compares extracted values against the resolved matrix produced here
- [[Add Existing Vendor to Locations]] — resolves a new location's matrix to re-evaluate an already-approved vendor against it
- [[Invite Vendor Workflow]] — trade enum used by trade overrides
