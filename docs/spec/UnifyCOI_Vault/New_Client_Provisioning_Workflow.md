# Screen / Workflow: New Client Provisioning (White-Glove)

> A **workflow** (verb) at the **platform altitude**. Run by platform staff to bring a new client org online.
> There is no client-facing signup — onboarding is white-glove. The client receives a ready-to-use tenant.

## Scenario

You sign on Acme Storage — 34 stores. (Next month, New Age Storage — 60 stores.) You create their tenant, apply a standard self-storage requirements template, bulk-import their stores and store managers from a spreadsheet, hand-add their org-level admins and district managers, then send invites and hand off. Acme's team logs in to a working system; they never set anything up themselves.

## Preconditions

- User is an authenticated **platform admin** (UnifyCOI internal).
- Launched from **Provision new client** on the [[Platform Super Admin Console]].
- A client agreement exists (locations count, contacts) — gathered offline.

## Steps (happy path)

1. **Create tenant** — enter org name, primary contact (name, email, phone), notes/plan. Tenant created in status **Provisioning** (isolated from all other tenants).
2. **Apply requirements template** — choose a reusable template from the library (e.g. "Standard Self-Storage"). It seeds the tenant's coverage/COI requirements. The client's admin can fine-tune later. *(If no template fits, build one — see Open questions.)*
3. **Bulk import locations + managers** — upload the client's spreadsheet via [[Bulk Location Import]]. Each row = one store plus its primary manager. Validate, preview, import.
4. **Add org-spanning users** — manually add **Admins** and **District Managers** (name, email, role, scope = whole org or specific region[s]). These are not in the sheet by design.
5. **Review the invite list** — the screen assembles everyone now in the tenant: store managers (from import) + admins/DMs (added). Each shows name, email, role, scope, and invite status (Not yet invited).
6. **Send invites manually** — select who to invite and send. Invites go out during onboarding at your pace; recipients set their own password on accept. (Reuses the internal-user invite mechanics — see [[User Management]].)
7. **Set billing reference** — the screen shows current location count × $90 as the billable figure. Confirm/adjust (billing is **manual** — see [[Platform Systems & Tenancy]]).
8. **Activate** — set tenant status to **Active**. The client is live.

## End state

- Tenant exists, **Active**, fully isolated.
- Locations created from the import; each store has a primary manager record.
- Admins/DMs added; requirements template applied.
- Users exist in **Invited** (or pre-invite) state; invites sent as you choose.
- Billing record set with the current location count.
- After handoff, the client's admin manages everything else themselves (add locations, add secondary/assistant managers) via the [[User Management]] and location panels in their admin dashboard.

## Edge & error states

- **Resumable setup:** provisioning is multi-step — save progress and resume. A half-set-up tenant stays in **Provisioning**, never billed, never live.
- **CSV errors:** handled in [[Bulk Location Import]] (row-level validation, fix-and-reupload).
- **Duplicate org name:** warn; allow if intentional (rare).
- **Manager email collision across roles:** if an imported manager email also matches an admin/DM you add, dedupe to one user with combined scope (don't create two accounts).
- **No suitable requirements template:** start blank or clone-and-edit an existing template; consider saving the result as a new reusable template.
- **Invites not sent:** a tenant can be Active with invites still pending; track who hasn't been invited/accepted on the tenant detail view.

## Open questions to confirm

- Should requirements templates be editable by the client after handoff, or locked? (Segment 2.)
- Minimum to go **Active** — must all managers be invited first, or can you activate and invite progressively? (Default above: progressive.)

## Links

- [[Platform Super Admin Console]] — where this launches
- [[Bulk Location Import]] — step 3
- [[User Management]] — internal-user invites (steps 4-6), reused by tenant admins
- [[Platform Systems & Tenancy]] — billing, isolation, lifecycle
- [[Requirements Configuration]] — what the template seeds (tenant-altitude)
