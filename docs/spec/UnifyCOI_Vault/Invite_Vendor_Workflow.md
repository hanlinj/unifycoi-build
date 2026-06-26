# Screen / Workflow: Invite Vendor

> Worked example for the screen-doc template. Other workflow docs should follow this shape.
> `[[wikilinks]]` point to related workflow docs in the vault.

## Scenario

A store manager has been tasked with finding a new plumber. The vendor they choose will serve this facility plus three other locations in the area.

The manager is referred to Acme Plumbing (Spokane, WA). After some Q&A about qualifications, availability, and turnaround, the manager decides Acme is a good fit. They explain that all vendors must meet certain requirements (insurance, etc.) before working at the facilities, that it's a simple process, and that the company will need to provide their W-9, COI/insurance declaration, and ACH information for prompt payment. The manager offers to start the process; the contact agrees.

## Preconditions

- The user is authenticated as a **Store Manager**, **Regional/District Manager**, or **Corporate** user. (Vendors cannot invite.)
- The user reaches this from the **Invite** button on the [[Manager Home Dashboard]].
- The user is associated with at least one facility they're authorized to assign vendors to.

> **Decision to confirm:** Can a Store Manager invite a vendor to facilities they don't personally manage? Default assumption below: **no** — the location picker is scoped to facilities the user is authorized for. Regional/Corporate users see a wider scope.

## Fields

| Field | Type | Required | Validation / Notes |
|---|---|---|---|
| Business Name | text | **Required** | Trim whitespace. Used for duplicate detection (see Edge States). |
| Contact First Name | text | **Required** | |
| Contact Last Name | text | **Required** | |
| Contact Title | text | Optional | e.g. "Owner," "Office Manager." |
| Email | email | **Required** | Verified live via 3rd-party API on blur. Green check on valid; inline error on invalid (see below). This is where the invite is sent. |
| Company Phone | tel | **Required** | Primary business line. Format/normalize on entry. |
| Contact Cell Phone | tel | Optional | |
| Primary Niche | **enum (controlled list)** | **Required** | Single-select from a defined trade list (Plumber, HVAC, Electrical, Landscaping, Sprinklers/Irrigation, Paving/Asphalt, Handyman, Security, Cleaning, General Contractor, Gate/Door, Other). Powers manager-hub search by trade ([[Search]]) — must not be free text. |
| Locations | multi-select | **Required (≥1)** | Operator facilities, scoped to the inviter's authorization. Cannot send with zero selected. |
| Custom Notes | textarea | Optional | Free text. e.g. "24-hr service," "fast response," "great prices." |

> **Decision to confirm:** Should the trade list allow a secondary/multiple niches? Default: single primary niche for now; revisit if vendors commonly span trades.

## Steps (happy path)

1. Manager logs into UnifyCOI.
2. From the [[Manager Home Dashboard]], clicks **Invite** → opens the invite flow (modal or dedicated page).
3. Confirms and enters **Business Name**.
4. Confirms and enters **Contact First / Last Name**.
5. Confirms and enters **Contact Title** (optional).
6. Enters **Email**. On blur, the email is verified by the 3rd-party API; a green check mark appears next to the field on success.
7. Confirms and enters **Company Phone**.
8. Enters **Contact Cell Phone** (optional).
9. Selects **Primary Niche** from the trade list.
10. Clicks **Locations** → the facility picker appears (modal or panel) showing the facilities the user is authorized for, each with a checkbox. Manager selects the desired facilities and clicks **Select these locations**; the picker closes and the chosen facilities display as chips/tags under Locations.
11. Enters optional **Custom Notes**.
12. Clicks **Send Invite**. The flow closes / returns to the [[Manager Home Dashboard]], and the invite email is sent to the vendor.
13. The newly invited vendor appears under **Pending** on the [[Manager Home Dashboard]].

## Edge & error states

- **Invalid email (API says bad):** show inline error, no green check, and **block Send** until resolved. (Accuracy over speed — don't fire an invite into a dead address.)
- **Email API unavailable / times out:** don't hard-block on an outage. Allow send with a soft warning ("couldn't verify this address"), and flag the invite as unverified so a bounce is easy to trace. *(Confirm preference.)*
- **Duplicate vendor:** if Business Name and/or email matches an existing vendor in the operator's system, do **not** create a duplicate. Surface the existing vendor and offer to **add the selected facilities to that vendor** instead — this routes into [[Add Existing Vendor to Locations]] (directly supports "collect information once" + "approve once, associate with many locations"). This is the single most important non-happy-path here.
- **Zero locations selected:** Send is disabled with a clear hint; an invite must target at least one facility.
- **Required field missing/invalid:** inline validation; Send disabled until the form is valid.
- **Invite email bounces:** mark the invite's delivery state as bounced and notify the inviter so they can correct the address and resend.
- **Vendor never responds:** a Pending invite should age — define an expiry/reminder cadence (e.g. auto-reminders at N days, status moves to "Expired Invite" after M days). *(Confirm cadence; this connects to the "minimize human chase-work" principle — the system, not the manager, should follow up.)*
- **Resend / cancel:** the inviter can resend the invite or cancel a Pending invite from the dashboard.

## End state

- A vendor record is created (or an existing one is extended with new facilities).
- Vendor status = **Pending** (see shared status vocabulary below).
- A personalized invite email is sent, populated from the Q&A data (company name, contact name, selected locations, etc.).
- The email contains a **tokenized link** to the [[Vendor Onboarding Workflow]] — **no account creation or login required**. The token identifies the vendor/invite and should be single-purpose and expiring.
- The vendor appears under **Pending** on the [[Manager Home Dashboard]].

## Shared status vocabulary

The canonical status set, flags, and transitions now live in [[Status Vocabulary]]. Quick reference:
`Invited/Pending → Onboarding → Under Review → Approved → Expired → Non-Compliant`
(plus invite-delivery sub-states: `Unverified`, `Bounced`, `Expired Invite`.) See [[Status Vocabulary]] for the full state machine.

## Links

- [[Manager Home Dashboard]] — entry point and where Pending appears
- [[Vendor Onboarding Workflow]] — where the tokenized link lands the vendor
- [[Vendor Record]] — the entity created/updated here
- [[Add Existing Vendor to Locations]] — where the duplicate-vendor path routes (add facilities to an existing vendor instead of creating a new record)
