# Screen / Workflow + Record: Location Management

> Tenant-altitude. Covers the **locations surface** (manage stores), the **Location Record** (one store's detail), and how **regions/districts** group them. Locations are first created via [[Bulk Location Import]]; this is where they're maintained afterward.

## Role & question

- **Admin:** "Manage all our stores and how they're grouped into regions."
- **District/Store Manager:** view their scope (no edit).
See [[Roles & Permissions]].

## Locations surface

- **Shows:** all locations in scope — name, address, region/district, primary manager, compliance snapshot, status.
- **Actions (Admin):** add a location (single, manual); bulk add via [[Bulk Location Import]]; edit; assign region; deactivate; open a Location Record.
- **Grouping:** locations roll up into **regions/districts**, which define District Manager scope and corporate roll-ups.
- **Empty state:** "No locations yet — import your stores or add one." -> points at import.

## Location Record (detail)

The single-store detail page — Profile · Requirements in effect · Vendors · People · Activity — is now its own surface. See **[[Location Record]]**.

## Adding / editing

- **Single add (Admin):** Store Name, Address, City, State, ZIP, Region/District, primary Manager (name + email -> invited via [[User Management]]). Same fields as the import row.
- **Bulk add:** [[Bulk Location Import]].
- **Billing link:** location count feeds the manual billing reference (see [[Platform Systems & Tenancy]]); adding/removing flags a billing change.

## Edge & error states

- **Duplicate store name in tenant:** blocked.
- **Deactivating a location with active vendors/pending work:** warn; define handling (reassign or archive). *(Confirm.)*
- **Reassigning region:** updates District Manager scope and roll-ups immediately.
- **Removing a location:** affects billing count — flag it (see lifecycle/billing).

## Open questions

- Soft-delete/archive vs hard remove for locations.
- Can a location belong to more than one region? (Default: one.)

## Links

- [[Bulk Location Import]] — primary creation path
- [[Location Record]] — the single-store detail surface this lists and links into
- [[User Management]] — managers attached to locations; region scope
- [[Requirements Configuration]] — location overrides shown here
- [[Vendor Record]] — vendors associated with this location (Segment 3)
- [[Platform Systems & Tenancy]] — billing tied to location count
