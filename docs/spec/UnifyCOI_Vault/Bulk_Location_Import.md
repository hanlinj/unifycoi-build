# Screen / Workflow: Bulk Location Import

> A **workflow** (verb). Reused in two places: inside [[New Client Provisioning Workflow]] (platform altitude, white-glove) and by a tenant **Admin** later to add locations in bulk. Spec is the same; only who runs it and the scope differ.

## Scenario

Acme Storage has 34 stores. Instead of typing each one, the operator's store list — including each store's primary manager — is uploaded as a spreadsheet. The system validates it, shows a preview with any bad rows flagged, imports the good ones, and produces the manager list that invites are sent from.

## Preconditions

- Run by a **platform admin** (during provisioning) or a tenant **Admin** (post-handoff).
- A target tenant exists; the importer is scoped to that tenant.

## File format (CSV / spreadsheet)

One row per store. Columns:

| Column | Required | Notes / validation |
|---|---|---|
| Store Name | Yes | Unique within the tenant. |
| Address | Yes | Street address. |
| City | Yes | |
| State | Yes | 2-letter or full; normalize. |
| ZIP | Yes | Valid postal format. |
| Region / District | No | Free text or matched to existing region; used for DM scoping & roll-ups. Blank = unassigned. |
| Manager First Name | No* | Primary store manager. |
| Manager Last Name | No* | |
| Manager Email | No* | Valid email. *If any manager field is filled, email is required.* |

A downloadable **template file** with these headers should be provided on the screen so clients send the right shape.

> Only the **primary** store manager belongs in this sheet. Secondary/assistant managers, admins, and district managers are added separately (admins/DMs by the platform during provisioning; assistants by the client admin afterward in [[User Management]]).

## Steps (happy path)

1. Download the template (optional) and/or upload the filled CSV/XLSX.
2. System parses and **validates** every row.
3. **Preview** screen: valid rows shown ready to import; invalid rows flagged inline with the specific reason (missing field, bad email, bad ZIP, duplicate store name).
4. Import the valid rows. (Default: **partial import** — good rows go in, bad rows are held.)
5. **Result summary:** N locations created, M manager records created, K rows failed (downloadable error report to fix and re-upload).
6. Created managers land in the invite list as **Not yet invited**, ready for manual invites (in provisioning) or auto-surfaced for the admin to invite.

## What it creates

- One **Location** record per valid row (with region/district if provided).
- One **Store Manager** user record per unique manager email, associated with that store. Status: pre-invite/**Invited**.

## Edge & error states

- **Same manager on multiple stores:** dedupe by email -> one user associated with multiple locations (don't create duplicates).
- **Duplicate store name within tenant:** flag the row; don't silently merge.
- **Re-importing / updating:** define whether a re-upload updates existing locations or only adds new ones. *(Default: add-only; updates are manual. Confirm.)*
- **Manager email already a user in this tenant:** associate the existing user with the new store; don't create a second account.
- **Partial vs all-or-nothing:** default partial (import valid, report invalid). *(Confirm preference.)*
- **Wrong/malformed file (bad headers, empty, not a spreadsheet):** reject with a clear message pointing to the template.
- **Very large files:** show progress; process reliably for 60+ rows.

## Links

- [[New Client Provisioning Workflow]] — primary caller (platform altitude)
- [[User Management]] — where the imported managers get invited / where assistants are added
- [[Location Record]] — the entity each row creates
