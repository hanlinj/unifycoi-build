# System: Roles & Permissions

> A **cross-cutting** doc. The canonical role matrix every surface and workflow references for "who can do what." Two altitudes: **platform** (UnifyCOI) and **tenant** (the client org), kept separate. Vendors are external.

## Altitudes

- **Platform roles** belong to UnifyCOI, not to any tenant. See [[Platform Systems & Tenancy]].
- **Tenant roles** belong to exactly one client org and are scoped within it.
- **Vendors** are external, no login; they reach the system only via tokenized links.

## Platform roles (UnifyCOI)

| Role | Can do |
|---|---|
| Platform Owner | Everything: provision/suspend/offboard tenants, billing, requirements templates, impersonate (logged), all platform settings. |
| Platform Staff | Manage tenants, provision, impersonate (logged); finer permissions TBD. |

## Tenant roles (client org)

| Capability | Admin | District Manager | Store Manager |
|---|---|---|---|
| Scope | Whole org | Their region(s) | Their store(s) |
| View vendors / status | All | Region | Store |
| **Invite vendors** | Yes | Yes (region) | Yes (store) |
| **Approve / reject vendors** | **Yes (only Admin approves)** | No | No |
| Edit requirements (within guardrails) | Yes | No | No |
| Set precedence policy | Yes | No | No |
| Manage locations | Yes | View (region) | View (store) |
| **Manage internal users** | Yes (org-wide) | Yes (their region) | No |
| Notification settings | Yes | Own | Own |
| Audit / export | Yes | Region (view) | No |

**Key boundaries:**
- **Only Admin approves.** No manager — store or district — can stamp a vendor compliant. The AI verifies; an Admin makes the call. Manager dashboards have no approve action.
- **District Managers** can view, invite, and manage users **within their region** — but not approve and not touch requirements.
- **Store Managers** invite and monitor within their store(s); they never manage users or requirements.

## Scoping rules

- A user's scope filters everything they see and act on (the [[Manager Home Dashboard]] and [[Corporate Command Center]] both honor it).
- Region/district membership comes from location grouping (see [[Location Management]]).
- Cross-tenant access is impossible by design (see [[Platform Systems & Tenancy]]).

## Open questions

- Multiple Admins per org — assumed yes; any "owner" super-admin among them?
- Can an Admin be scoped to a region, or is Admin always org-wide? (Assumed always org-wide.)
- Read-only / auditor role for ownership or external auditors?

## Links

- [[User Management]] — where these roles are assigned and invited
- [[Requirements Configuration]] — Admin-only editing it governs
- [[Manager Home Dashboard]] · [[Corporate Command Center]] — surfaces that honor scope
- [[Regional District View]] — how the District Manager's region scope and action-delta land on those two surfaces
- [[Platform Systems & Tenancy]] — platform-role detail
- [[Audit Export Generation]] — applies the audit/export rights this matrix grants (Admin full, District region, Store none)
- [[Search]] — clamps every query to the scope this matrix defines, server-side
- [[Navigation]] — decides which sidebar entries each role sees, from this matrix
