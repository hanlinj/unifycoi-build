# Audit Coverage Report — Phase 7, Slice A

> Defensibility-grade completeness check on audit logging across every tenant-scoped
> mutation built in Phases 1–6. Per `Audit_Trail.md`: every meaningful action is logged
> immutably, attributed (system/ai/user/vendor/platform), tenant-isolated, with **Sensitive
> values redacted** in payloads (invariant #10).
>
> Method: inventoried every `TenantDB.insert/update/del`, `txTdb.*`, and raw
> `db.prepare(INSERT|UPDATE|DELETE)` write in `src/`, then cross-referenced each against the
> `logAudit()` call sites. Generated 2026-06-29 (Phase 7).

## Summary

| Metric | Count |
|---|---|
| Total tenant-scoped mutation sites | 27 |
| Covered before Phase 7 | 24 |
| **MISSING — fixed this phase** | **3** |
| Sensitive leaks in payloads | 0 |
| Derived/child writes intentionally not separately audited (documented) | 3 |

Result after fixes: **zero MISSING, zero Sensitive leaks.**

> The kickoff anticipated 2 MISSING gaps. The pass surfaced a **third** (`tenant.settings_changed`)
> — a tenant name/billing-rate change that was writing no audit event. Fixed inline; flagged
> here and in the checkpoint for review.

## Coverage table

Legend — Sensitive?: whether full TIN / ACH account / routing could appear in the audit
payload. Must always be **no** (invariant #10).

| # | Mutation (file : function) | Table(s) written | event_type | actor_type | Sensitive? |
|---|---|---|---|---|---|
| 1 | `services/vendors.ts` createVendorInvite | vendors, invites, vendor_locations, notifications | `vendor.invited` | user | no |
| 2 | `app/v/[token]/route.ts` GET (open_link) | vendor_locations | `vendor.onboarding_started` ⟵ **FIXED** | vendor | no |
| 3 | `app/v/[token]/documents/route.ts` POST | documents, extractions | `document.extracted` | vendor | no¹ |
| 4 | `app/v/[token]/documents/route.ts` POST (expiry gate) | documents (state) | `document.bounced_expired` | vendor | no |
| 5 | `app/v/[token]/submit/route.ts` POST | notifications, vendor_locations (fsm submit) | `vendor.submitted` | vendor | no |
| 6 | `services/decision.ts` applyDecision(approve) | vendor_locations | `vendor.approved` | user | no |
| 7 | `services/decision.ts` applyDecision(reject) | vendor_locations | `vendor.declined` | user | no |
| 8 | `services/decision.ts` applyDecision(request_correction) | vendor_locations, invites, notifications | `vendor.correction_requested` | user | no |
| 9 | `services/decision.ts` acceptUncertainEvaluation | (audit-only; no table write) | `evaluation.uncertain_accepted` | user | no² |
| 10 | `services/add-to-locations.ts` addVendorToLocations | vendor_locations | `vendor.location_added` | user | no |
| 11 | `verification/run.ts` runVerification | verification_runs, requirement_evaluations, engine_advisories | `ai.recommendation` + `ai.advisory` | ai | no³ |
| 12 | `requirements/re-eval.ts` reevaluateOnRuleChange | vendor_locations | `vendor.non_compliant_rule_change` + `requirement.reeval_triggered` | system / ai | no |
| 13 | `services/locations.ts` createLocation | locations, billing_snapshots | `location.created` | user | no |
| 14 | `services/locations.ts` updateLocation | locations | `location.updated` | user | no |
| 15 | `services/locations.ts` importLocations | locations, users, user_locations, regions | `locations.bulk_imported` | user | no |
| 16 | `services/tenants.ts` createTenant | tenants, billing_snapshots, requirement_settings | `tenant.created` | platform | no |
| 17 | `services/tenants.ts` updateTenant(lifecycle) | tenants | `tenant.lifecycle_changed` | platform | no |
| 18 | `services/tenants.ts` updateTenant(name/rate) | tenants | `tenant.settings_changed` ⟵ **FIXED** | platform | no |
| 19 | `services/tenants.ts` impersonateTenant | (audit-only; issues token) | `impersonation.started` | platform | no |
| 20 | `services/users.ts` createUser | users, user_regions, user_locations | `user.created` | user | no |
| 21 | `services/users.ts` updateUser | users, user_regions, user_locations | `user.updated` | user | no |
| 22 | `services/users.ts` inviteUser | users | `user.invited` | user | no |
| 23 | `services/requirements.ts` changeRequirementRule | requirement_rules | `requirement.rule_changed` | user | no |
| 24 | `services/requirements.ts` changePrecedence | requirement_settings | `requirement.precedence_changed` | user | no |
| 25 | `requirements/templates.ts` applyTemplate | requirement_rules, requirement_settings, tenants | `requirement.template_applied` ⟵ **FIXED** | user¹ | no |
| 26 | `requirements/templates.ts` findOrCreateRegion (via import) | regions | — (see Documented item D1) | — | — |
| 27 | `services/{locations,tenants}.ts` recordBillingSnapshot | billing_snapshots | — (see Documented item D2) | — | — |

¹ Sensitive extracted fields (full TIN, ACH account/routing) live as **ciphertext inside
  `extractions.payload_json`** and are never copied into the audit payload — `document.extracted`
  logs document id / doc_type / counts only.
² The accept event logs the Admin's free-text *reasoning* (their judgment), not any Sensitive
  document field.
³ `ai.recommendation` logs run id, trigger, recommendation, and **counts** — not field values.
  See Documented item D3 on per-evaluation grain.

## Gaps fixed this phase (the 3 MISSING)

1. **`vendor.onboarding_started`** — `app/v/[token]/route.ts`. The `open_link` FSM transition
   (Invited/Pending → Onboarding) fired with no audit row. The spec explicitly lists
   "onboarding started" as a vendor-lifecycle event. Fixed: log on the transition, actor =
   vendor.
2. **`requirement.template_applied`** — `requirements/templates.ts` `applyTemplate`. Template
   application seeds org rules + the floor snapshot and stamps the tenant, with no audit. The
   spec lists "template applications" as a logged requirement-change event. Fixed: log after the
   transaction. Actor = **user** (¹): the docstring said "platform user or admin," but
   `requirement_rules.created_by` FK references tenant `users(id)`, so the applying actor is
   necessarily a tenant admin, not the platform user. Corrected the actor_type accordingly.
3. **`tenant.settings_changed`** — `services/tenants.ts` `updateTenant`. Name and
   `monthly_rate_cents` updates wrote no audit (only lifecycle changes were logged). A billing-rate
   change with no trail is a defensibility hole. Fixed: log with before→after for each changed
   field, actor = platform. *(Surfaced during the pass; not in the kickoff's anticipated 2.)*

## Documented items — audited at parent grain, not separately (review these)

These are writes that do **not** emit their own audit event. Each is argued below; flagged for
review per the user's instruction to decide whether the rationale is sound or the gap needs closing.

- **D1 — Region auto-create (`findOrCreateRegion`).** During bulk location import a region row is
  created on-demand if a named region doesn't exist. **Rationale for no separate event:** region
  creation is a side-effect of an import that is itself audited as `locations.bulk_imported`, and
  a region carries no compliance state of its own (it's an org-structure grouping; it gains meaning
  only through the locations placed in it, which are audited). **Counter-argument:** an org-structure
  mutation arguably deserves its own `region.created` row for completeness, and the bulk-import
  event does not currently enumerate which regions were auto-created. **Recommendation:** acceptable
  for v1; if you want strict org-structure provenance, add `region.created` (cheap, low-volume).

- **D2 — Billing snapshot (`recordBillingSnapshot`).** A `billing_snapshots` row is written whenever
  the active-location count may have changed (location create/archive, tenant create). **Rationale
  for no separate event:** the snapshot is a *derived figure* (billable_locations × rate), not a
  human/AI action; the action that caused it (`location.created`, `tenant.created`, etc.) is audited,
  and the snapshot table is itself an append-only historical record with `changed` flags.
  **Recommendation:** sound — auditing a derived rollup would duplicate the parent event with no new
  defensibility value.

- **D3 — Per-requirement-evaluation grain (Q2 from kickoff).** The spec's audit taxonomy says "each
  requirement evaluation (Pass/Deficient/Uncertain)" is auditable. Current code persists every
  evaluation as an immutable row in `requirement_evaluations` (tenant-scoped, queryable by `run_id`,
  capturing outcome / confidence_band / comparison_result / note per requirement) and logs a
  **run-level** `ai.recommendation` event with counts — it does **not** mirror each evaluation into
  `audit_events`. **This is a code-vs-spec divergence.** Resolution taken (recommended, pending your
  override): treat `requirement_evaluations` as the canonical per-evaluation record and keep the
  run-level audit event, rather than double-writing each finding into `audit_events`. The evaluation
  table already satisfies the substance of the spec (every finding is recorded immutably and
  attributable to its run); duplicating into the audit log adds rows without adding provable facts.
  **To reverse:** emit one `requirement.evaluated` audit row per evaluation in `verification/run.ts`.

## Note — platform-altitude writes (out of scope for tenant audit)

`platform_users`, `requirement_templates` (seeded at startup via `seedTemplates`), and the raw
`tenants` INSERT carry no `tenant_id` for the *platform* actor's own provisioning of the platform.
Tenant-scoped consequences of provisioning (tenant.created, template_applied) ARE audited under the
new tenant's id. Platform-user CRUD audit (if/when built) is a separate concern not in Phases 1–6.

## Regression guard

`tests/phase7-audit-coverage.test.ts` exercises each audited service mutation against a real
in-memory DB and asserts the expected `event_type` row appears (and, for a sample, that no
Sensitive pattern appears in the payload). A new service mutation that ships without its audit
event — or a removed `logAudit` call — fails that test.
