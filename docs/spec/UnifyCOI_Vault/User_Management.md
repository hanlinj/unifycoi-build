# Screen / Workflow: User Management

> Tenant-altitude **surface + workflow**. Where internal users (Admins, District Managers, Store Managers, assistants) are added, invited, scoped, and managed. Reached from a **Users** panel in the admin/DM sidebar. Also the invite mechanism reused by [[New Client Provisioning Workflow]].

## Scenario

After Acme goes live, the admin opens **Users**. Store managers from the import are already listed (invited during onboarding). The admin adds an assistant manager to the Coeur d'Alene store and invites a new District Manager for the north region. A District Manager, logged in, can add an assistant manager within their own region but can't touch other regions.

## Preconditions

- User is an **Admin** (org-wide) or a **District Manager** (their region only). Store Managers cannot manage users. See [[Roles & Permissions]].

## Who can manage whom

- **Admin:** add/invite/edit/deactivate any user org-wide; assign any role.
- **District Manager:** add/invite/edit users **within their region** (e.g. assistant/secondary store managers); cannot create Admins or manage other regions.
- Approval authority is unaffected — managing users never grants vendor-approval power (Admin-only).

## Fields (add/invite a user)

| Field | Required | Notes |
|---|---|---|
| First / Last name | Yes | |
| Email | Yes | Verified; invite is sent here. Unique within tenant. |
| Role | Yes | Admin · District Manager · Store Manager (DM can assign DM/SM within region, not Admin). |
| Scope | Yes | Admin = org-wide (implicit); District Manager = region(s); Store Manager = store(s). |
| Title (optional) | No | e.g. Assistant Manager. |

## Steps (happy path)

1. Open **Users** (sidebar). See current users with role, scope, and invite status.
2. **Add user** -> enter fields above.
3. Send invite -> user receives an email to set their password and log in. (Same invite mechanics used in provisioning.)
4. User appears with status **Invited** -> **Active** on acceptance.

## Statuses

`Invited -> Active -> Deactivated` (deactivated retains history but blocks login).

## Edge & error states

- **Duplicate email in tenant:** don't create a second account; offer to edit the existing user.
- **DM acting outside region:** blocked; scope selector only shows their region.
- **Removing the last Admin:** blocked — an org must always have at least one Admin.
- **Reassigning scope:** changing a user's region/store updates what they see immediately.
- **Deactivating a user mid-work:** their invited vendors and history remain; reassign ownership if needed.
- **Assistant vs primary manager:** multiple managers can be attached to one store (primary from import + assistants added here).

## End state

- User exists, scoped, with an invite sent; becomes Active on acceptance; visible in the Users list.

## Links

- [[Roles & Permissions]] — the capability matrix this enforces
- [[New Client Provisioning Workflow]] — reuses this invite mechanism
- [[Bulk Location Import]] — seeds primary store managers that appear here
- [[Location Management]] — regions/stores that define scope
