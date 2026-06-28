# System: AI Verification Engine

> A **cross-cutting systems** doc (not a screen). The **technical internals** of the engine whose *behavior* is specified in [[Document Verification]]. That doc owns what the engine does and how outcomes route to the Admin; **this doc owns how it works**: the Claude Vision extraction approach, the structured-output field schema, how per-field confidence is derived and thresholded into **Pass / Deficient / Uncertain**, and how the rules engine compares extracted values to the resolved effective requirement matrix from [[Requirements Configuration]].
> Stack: **Next.js 14** (server-side API routes / background job), **SQLite + better-sqlite3**, **Claude Vision** (server-side via the Anthropic API), **JWT** for the internal-user surfaces that read its results. It is a **compliance system first** ([[MISSION]] #1) — when unsure it produces **Uncertain → human**, never a guessed Pass.

## Where this runs (boundaries)

- The engine is **server-side only**. It is invoked by [[Vendor Onboarding Workflow]] on submit/resubmit, by [[Renewal & Expiration Chase]] on a renewal upload, by [[Requirements Configuration]] on a rule change, and by [[Add Existing Vendor to Locations]] on a new-location association (both rule-change and location-add are **rules-only** — no document, no extraction).
- Vendor uploads reach it through the **tokenized, no-login** path (the token is the credential — see [[Document Storage & Security]]); the engine itself authenticates nothing vendor-side.
- The surfaces that **read** the engine's results — the [[Vendor Record]] review workbench, the [[Corporate Command Center]] — are **JWT-gated internal-user** surfaces (Admin / District / Store, role-scoped per [[Roles & Permissions]]).
- Extraction is **asynchronous**: submission enqueues a verification run; the vendor gets the neutral "we'll review and reach out" confirmation immediately ([[Vendor Onboarding Workflow]]) without waiting on Vision latency.

## Pipeline (one verification run)

A run is the unit of work. It always produces a persisted, audited result.

1. **Ingest** — load the submitted document artifact(s) for the vendor; identify expected doc types from the resolved requirements.
2. **Extract** — Claude Vision reads each document into the structured field schema (below), with a self-rated confidence per field.
3. **Corroborate** — targeted second extraction on **critical** and **low-confidence** fields; confidence is reconciled (the hybrid model below).
4. **Resolve requirements** — obtain the **effective requirement matrix** for the vendor's trade × each assigned location from [[Requirements Configuration]].
5. **Compare (rules engine)** — evaluate each required item against the extracted values, per location.
6. **Classify** — each requirement → **Pass / Deficient / Uncertain** from (comparison result × confidence).
7. **Roll up** — per-location outcome, then the derived overall result ([[Status Vocabulary]]).
8. **Route & recommend** — clean → "recommend approve"; deficiencies / uncertain → Admin, flagged ([[Document Verification]] owns the routing).
9. **Log** — every extraction, evaluation, and recommendation to the [[Audit Trail]], attributed to `AI` / `system`.

> Steps 1–3 are skipped on a **rule-change re-evaluation** and on a **location-add re-evaluation** (the document hasn't changed in either case — only the rule or the location set did) — see *Reuse* below. Renewals run the full pipeline because the document is new.

## Extraction — Claude Vision approach

- **Single primary pass, structured output.** Each document image/PDF page is sent to a vision-capable Claude model with a **forced structured-output schema** (tool-use / JSON-schema mode), not free-text-then-parse. The model returns the typed object directly; we never regex prose.
- **No separate OCR layer.** Vision reads the document semantically — layout-agnostic — which is what makes it robust to the non-standard COI layouts below. (An OCR-fallback path is an Open question, not a v1 dependency.)
- **Document-type aware.** The schema branch is selected by expected doc type (COI / W-9 / ACH); the model is also asked to confirm the document *is* that type, so a mis-uploaded document is caught (a W-9 photographed where a COI was expected → flagged, not silently parsed as a COI).
- **Per-field provenance.** Every extracted leaf carries its `value`, a `confidence`, and a short `source` snippet (page + the text it was read from) so the Admin can see *where* a value came from on the [[Vendor Record]], and the [[Audit Trail]] can record it.
- **Model is pinned in config.** The exact model id and prompt/schema live behind a version stamp on each extraction (supports later re-extraction migrations) — see Open questions.

## Structured-output field schema

Every leaf field is an object: `{ value, confidence: 0–1, band: high|med|low, source: { page, snippet }, corroborated: bool }`. Shown below as `field*` for the leaf shape; the structure is what the coder builds the schema and SQLite columns around. **Sensitive** fields (full TIN, account/routing) are tagged for field-level encryption and log redaction ([[Document Storage & Security]]).

### COI (ACORD 25)

```
coi:
  certificate_date            field*
  producer                    field*           # agency name/contact
  named_insured               field*           # the vendor's business entity
  insured_address             field*
  insurers: [ { letter: A–F, carrier_name field*, naic field* } ]
  policies: [
    {
      coverage_type           field*           # enum: general_liability | automobile_liability |
                                                #       umbrella_excess | workers_comp | employers_liability |
                                                #       professional_liability | pollution | other
      insurer_letter          field*           # links to insurers[]
      policy_number           field*
      effective_date          field*
      expiration_date         field*           # extracted here; the GATE is upstream (see note)
      limits: { <limit_key>: field*, ... }      # keyed by limit type, see below
      additional_insured      field*  (bool)
      additional_insured_scope field* (blanket|scheduled)
      waiver_of_subrogation   field*  (bool)
      primary_noncontributory field*  (bool)
    }
  ]
  additional_insured_entities field*  (list)   # who is named, if scheduled
  description_of_operations   field*           # free text — endorsement language often hides here
  certificate_holder          field*           # name + address
```

Limit keys by coverage type — **GL:** `each_occurrence`, `damage_to_rented_premises`, `med_exp`, `personal_adv_injury`, `general_aggregate`, `products_completed_ops_aggregate`. **Auto:** `combined_single_limit`, `bi_per_person`, `bi_per_accident`, `property_damage`. **Umbrella/Excess:** `each_occurrence`, `aggregate`. **Workers' comp / EL:** `per_statute` (bool), `el_each_accident`, `el_disease_each_employee`, `el_disease_policy_limit`.

> **Expiration extraction vs. the expiration gate.** The engine *extracts* every policy's `expiration_date` — it's needed for [[Renewal & Expiration Chase]] monitoring and to cross-check the vendor's attestation. But **expiration is not an engine outcome**: an objectively-expired document is bounced to the vendor at the upload step ([[Vendor Onboarding Workflow]] → expiration gate) and never reaches the Admin. The engine's only expiration job here is the **attestation cross-check** edge below.

### W-9

```
w9:
  legal_name                  field*
  business_name               field*           # DBA, if any
  federal_tax_classification  field*           # enum
  tin: { type field* (SSN|EIN), value field* SENSITIVE }
  address                     field*
  signature_present           field*  (bool)
  signature_date              field*
```

### ACH / banking

```
ach:
  account_holder_name         field*
  bank_name                   field*
  routing_number              field*  SENSITIVE
  account_number              field*  SENSITIVE
  account_type                field*  (checking|savings)
  voided_check_present        field*  (bool)
  authorization_signature     field*  (bool)
```

> W-9 and ACH carry **light verification** (presence, legibility, that the entity matches the COI's named insured) — they're collected for payment setup, not coverage compliance. The COI drives the substantive compliance evaluation.

## Confidence scoring — the hybrid model *(decision locked this session)*

Per-field confidence drives the **Uncertain** outcome, so it has to be trustworthy on the fields where a confident-wrong read is catastrophic. **Model self-rated confidence alone is not trusted** for those; the engine corroborates them.

**Critical fields** (always corroborated): per-policy **limits**, required **endorsements** (additional insured, waiver of subrogation, primary/non-contributory), **named insured**, **coverage type present**, and **expiration_date**. These are the fields that decide compliance or feed the renewal clock.

The flow:

1. **Self-rate (pass 1).** The primary extraction returns a self-reported confidence per field.
2. **Targeted re-extract (pass 2).** A second extraction runs **only** on (a) any field the model self-rated low, and (b) every critical field — regardless of its self-rating.
3. **Reconcile.** For a re-extracted field, confidence is **agreement-based**: passes agree → high; passes disagree → **forced low** (→ Uncertain), no matter how confident either pass claimed to be. A misread rarely repeats identically, so disagreement is the signal that catches the dangerous case.
4. **Non-critical, non-low fields** keep their pass-1 self-rating.

This buys most of the safety of full corroboration at close to single-pass cost — the second pass touches a subset of fields, only when warranted ([[MISSION]] #1 accuracy over speed; #8 simplicity — we don't double every call).

### Confidence → band → outcome

Confidence is **per-field internally; surfaced to the Admin as a band + the flag** (the locked default from [[Document Verification]]). Bands: **high ≥ 0.90**, **med 0.75–0.90**, **low < 0.75**.

Outcome is two-dimensional — the rules-engine **comparison result** crossed with **confidence**:

| Comparison result | Confidence | Outcome |
|---|---|---|
| Meets requirement | high / med | **Pass** |
| Fails requirement | high / med | **Deficient** |
| Meets **or** fails | **low** (or a needed field unreadable) | **Uncertain** |
| Indeterminate (needed value missing/illegible) | any | **Uncertain** |
| Required document not present at all | n/a | **Deficient (missing)** |

> **Decision to confirm:** the band cutoffs (0.90 / 0.75) and the critical-field list are **tunable config defaults**, not hardcoded. Start here; tune against the 10-package test dataset before launch. Surfacing to the Admin stays **band + flag**, never a raw decimal (avoids false precision in the review workbench).

## Rules engine — comparing extracted values to the effective matrix

The rules engine is a **pure, deterministic function**: `(extracted_values, resolved_requirement_matrix) → per-requirement outcomes`. No model call, no side effects — same inputs always yield the same outcomes (essential for the [[Audit Trail]] and for the rules-only re-evaluation below).

**Requirement resolution is upstream.** [[Requirements Configuration]] owns the layered resolution — **org base → trade override → location override**, the Admin-set **precedence policy** (strictest / location / trade), never below the **platform floor**. The engine consumes the *already-resolved* matrix for a given trade × location; it does not re-implement precedence. A vendor on multiple locations is evaluated against **each location's** resolved matrix.

Comparison operators by requirement type:

| Requirement | Operator |
|---|---|
| **Coverage limit** (per limit key) | extracted amount **≥** required amount, matched by `coverage_type` + limit key. |
| **Required coverage present** | a policy of the required `coverage_type` exists on the COI. |
| **Required endorsement** | the endorsement flag is `true`. **Blanket** additional-insured satisfies; **scheduled** must name the operator/location entity (entity match — see below). |
| **Named insured** | normalized match between `named_insured` and the vendor's business entity (case/punct/suffix-normalized; near-miss → Uncertain, clear mismatch → Deficient). |
| **Required document** | the doc type was submitted and legible; else **Deficient (missing)**. |

- **Entity matching** (named insured, scheduled additional insured) is normalized + fuzzy; a high-similarity-but-not-exact match is **Uncertain → human**, not an auto-pass (a wrong-entity certificate is a real risk). *(Decision to confirm: match strictness threshold.)*
- **Roll-up:** a vendor-location passes when **every** required item there is Pass; any Deficient → deficient at that location; any Uncertain (no Deficient) → uncertain there. Overall status is **derived** per [[Status Vocabulary]] (Approved at all / *N of M* / in-pipeline leads).

## Advisory flags — observations outside the requirement matrix

The rules engine produces `requirement_evaluations` (Pass / Deficient / Uncertain per requirement key). Some engine-derived observations are material for human review but have no counterpart in the requirement matrix and must not affect the compliance roll-up. These are **advisory flags** — a distinct output channel emitted alongside evaluations, never instead of them.

**Advisory flags do not change the overall recommendation or vendor status.** A vendor whose every requirement evaluation is Pass still receives recommendation `approve` even if the engine emits a `warn`-severity advisory. The Admin sees the advisory in the [[Vendor Record]] workbench as a separate lane and decides what to do before clicking approve.

**Shape:** `{ key: string, severity: info | warn, message: string, evidence: string }`

- `key` — stable, lowercase_snake identifier (e.g. `coverage_continuity`, `personal_ach_account`).
- `severity` — `warn` when human action is likely warranted; `info` for low-stakes observations.
- `message` — one human-readable sentence surfaced in the workbench.
- `evidence` — the extracted field value(s) that triggered the flag, for traceability.

**When the engine emits advisory flags (examples):**

| Key | Trigger |
|---|---|
| `coverage_continuity` | Policy effective date with a new carrier implies a gap vs. the prior carrier's inferred expiration (annual cycle). The engine cannot confirm a lapse from the submitted document; it flags and defers to the Admin. |
| `personal_ach_account` | ACH `account_holder_name` is an individual name while the vendor's W-9 `federal_tax_classification` is LLC/Corp — or vice versa, W-9 is Individual/sole proprietor and the name is personal. Surfaced as a payment-risk signal. |
| `limits_below_preferred` | A coverage limit meets the requirement floor but falls below a configurable preferred threshold (future tuning; not v1). The requirement evaluation is Pass; the advisory notes the margin. |

**Advisory flags are NOT emitted by rules-only re-evaluations** (rule-change, location-add). Those paths compare stored values against the requirement matrix only; they have no extraction pass from which to observe these patterns.

## Robustness — non-standard layouts & multi-policy certificates

- **Multi-policy is native, not special-cased.** `policies` is an **array**; one COI carrying GL + auto + umbrella + workers' comp produces four policy objects. Each is matched to the requirement it satisfies by `coverage_type`; a single certificate can satisfy several requirements at once.
- **Layout independence.** Because Vision reads semantically rather than by fixed coordinates, non-ACORD or carrier-custom certificate layouts extract into the same schema. Fields that genuinely can't be located come back **low-confidence → Uncertain**, never guessed.
- **Endorsement language in free text.** Required endorsements are frequently described in **Description of Operations** rather than the checkbox grid. The engine reads both; if endorsement intent is present but non-standard/ambiguous, it's **Uncertain → human** (matches [[Document Verification]]'s "endorsement language present but non-standard" example).
- **Umbrella / excess stacking.** When a required GL aggregate is short on the GL policy alone but an umbrella/excess policy is present, the engine does **not** auto-stack underlying + excess in v1 — it surfaces the situation to the Admin (Deficient or Uncertain with a note) for a judgment call. *(Decision to confirm: whether to model excess-over-underlying stacking later.)*
- **Mixed-validity multi-policy** is the upstream gate's job (an expired required policy bounces to the vendor; [[Vendor Onboarding Workflow]]); the engine evaluates the policies that arrive current.

## Reuse — renewals & rule-change re-evaluation

The **same extraction schema, confidence model, and rules engine** serve all three triggers; only the front of the pipeline differs.

- **Onboarding / resubmission** — full pipeline (extract → corroborate → resolve → compare → classify). A resubmission re-extracts only the changed document (collect-once; [[Document Verification]] deficiency loop).
- **Renewal** — a **new document** arrives via [[Renewal & Expiration Chase]], so the **full pipeline runs** (re-extract + re-verify against *current* requirements, which may have tightened since last approval). Clean → auto-continue; deficient → normal deficiency routing.
- **Rule-change re-evaluation** *(decision locked this session)* — when an Admin tightens a requirement, the document **hasn't changed**, only the rule has. The engine re-runs **the rules engine only, against the stored extracted values** — **no new Vision call**. This is:
  - **Deterministic** — re-evaluating an unchanged document against an unchanged rule always yields the same result; a stored value never silently shifts in the audit log.
  - **Cheap & bulk-able** — a single rule change can sweep hundreds of approved vendors instantly without API cost.
  - **Honest about provenance** — it relies on the extraction that was verified at approval time.

  A vendor that now fails flips to **Non-Compliant** (post-approval drift, distinct from onboarding *Deficient* — [[Status Vocabulary]]) and surfaces on the [[Corporate Command Center]] risk queue. Curing it requires a **new document**, which re-enters the full pipeline via the chase machinery ([[Renewal & Expiration Chase]] reuses the same loop for rule-change cures).

- **Location add** *(third rules-only trigger)* — when an already-approved vendor is associated with a **new location** ([[Add Existing Vendor to Locations]]), the documents **haven't changed**, only the location set has. The engine runs **the rules engine only, against the stored extracted values**, this time resolving the **new location's** effective requirement matrix — **no new Vision call**. Same deterministic / cheap / honest-about-provenance properties as rule-change re-eval. Difference in disposition: a shortfall here is a **Deficient finding at a location in Under Review** (the vendor was never approved *there*), **not** Non-Compliant drift; and a clean result yields a **recommendation the Admin activates**, not an auto-continue (see that doc's locked decision). A cure requires a new document through the full pipeline, re-verified across all the vendor's locations.

> Because rule-change re-eval is rules-only, the persisted extraction is **first-class data**, not a throwaway. The data model below stores it so re-evaluation has something to read.

## Persistence (better-sqlite3, tenant-partitioned)

Everything is scoped by `tenant_id` and queried within it ([[Document Storage & Security]] — partitioning is structural, not UI filtering).

- **`extractions`** — `id, tenant_id, document_id, doc_type, model_id, extraction_version, payload_json, created_at`. One row per document per extraction; `payload_json` holds the typed schema with per-field confidence/band/source. The **latest** extraction per document is what rule-change re-eval reads.
- **Sensitive fields** (full TIN, account/routing) are **field-level encrypted** — stored separately or as ciphertext within the payload, never in plaintext, never written to logs ([[Document Storage & Security]]).
- **`verification_runs`** — `id, tenant_id, vendor_id, trigger (onboarding|resubmission|renewal|rule_change|location_add), engine_version, recommendation (approve|deficiencies|uncertain), created_at`.
- **`requirement_evaluations`** — `id, tenant_id, run_id, vendor_id, location_id, requirement_key, required_value, extracted_value_ref, comparison_result, confidence_band, outcome (pass|deficient|uncertain), note`. The per-location, per-requirement grain the [[Vendor Record]] workbench renders **by document**.
- **`engine_advisories`** — `id, tenant_id, run_id, vendor_id, key, severity (info|warn), message, evidence_json, created_at`. Advisory flags produced during a full pipeline run. Not written by rules-only re-evaluations. Does not affect the run's `recommendation` field.

Extraction and engine versions are stamped so a future schema/model upgrade can selectively re-extract stored documents (the deferred re-extract-on-version-bump path) without disturbing this run's record.

## Audit integration

The engine emits the events [[Audit Trail]] expects, attributed to `AI` / `system`:

- `document.extracted` — what was read, from which document, with **confidence** and the corroboration outcome.
- `requirement.evaluated` — extracted vs. required, comparison result, band, and the **Pass / Deficient / Uncertain** outcome.
- `ai.advisory` — key, severity, message, and evidence for each advisory flag emitted; logged alongside evaluations so the full picture of the run is in the audit trail.
- `ai.recommendation` — the run's overall recommendation and the reasoning shown to the Admin at decision time.

These are what make "humans remain in control" provable ([[MISSION]] #2, #4): an approval/override entry can show the **AI recommendation the human saw** when they clicked. Sensitive values are **redacted** in audit payloads.

## Edge & error states

- **Extraction fails entirely** (corrupt/illegible upload) → re-upload request to the **vendor** at the onboarding step, **not** an Uncertain to the Admin (save Admin attention; [[Document Verification]]).
- **Low confidence across the board** (bad scan) → a single "please re-upload a clearer photo" to the vendor, rather than flooding the Admin with Uncertain items.
- **Wrong document type** (a W-9 where a COI was expected) → bounced to the vendor as a mismatch; only *ambiguous* cases route to the Admin.
- **Required doc missing** → Deficient (missing); drafted correction request ([[Document Verification]]).
- **Engine disagrees with the vendor's confirmed expiration** → the vendor attested a date that conflicts with the extracted one → **Uncertain to the Admin** (possible vendor or extraction error); the attestation does not override a clear conflict.
- **Vision API failure / timeout** → run is retried with backoff and stays queued; it never resolves a vendor as Pass/Deficient on a failed call, and never loses the submission ([[Document Storage & Security]] — never drop a successful upload).
- **Conflicting policies on one COI** → each policy evaluated against its corresponding requirement; rolled up to the vendor result.
- **Concurrent runs for one vendor** (e.g. a renewal lands mid-review) → runs are ordered; the latest run supersedes, and supersession is logged (no ambiguous "current" result).

## Decisions locked (this session)

- **Confidence is hybrid-derived** — model self-rating as the base signal; **targeted second-pass corroboration** on critical fields (limits, endorsements, named insured, coverage presence, expiration) and on any low-self-rated field; disagreement forces **low → Uncertain**. Surfaced to the Admin as a **band + flag**, per-field internally.
- **Rule-change re-evaluation is rules-only** against **stored extracted values** — no new Vision call; deterministic, cheap, bulk-able. **Location-add re-evaluation** ([[Add Existing Vendor to Locations]]) is the same rules-only mechanism against a new location's matrix. Renewals (new document) re-extract; cures require a new document through the full pipeline.

## Open questions

- **Band cutoffs & critical-field list** — tune the 0.90 / 0.75 defaults and the corroboration set against the 10-package test dataset before launch.
- **Model id + prompt/schema version pinning** — which vision model, and the re-extract-on-version-bump migration (deferred; the version stamp is built now).
- **Self-rated-confidence calibration** — whether non-critical self-ratings need empirical calibration once real volume exists.
- **Entity-match strictness** — the threshold for named-insured / scheduled-AI matching (near-miss → Uncertain vs. Deficient).
- **Umbrella/excess stacking** — whether to model excess-over-underlying limit satisfaction in a later version (v1 routes to the Admin).
- **OCR fallback** — whether a non-Vision extraction path is ever needed (not a v1 dependency).
- **Whole-vendor vs. per-location expiry** when one required policy lapses (tracked on [[Renewal & Expiration Chase]]; the engine evaluates per-location either way).

## Links

- [[Document Verification]] — the **behavior** this engine implements; owns outcome routing, the deficiency loop, and approve/reject
- [[Requirements Configuration]] — resolves and supplies the **effective requirement matrix** the rules engine compares against
- [[Vendor Onboarding Workflow]] — triggers a run on submit/resubmit; owns the upstream **expiration gate** the engine defers to
- [[Renewal & Expiration Chase]] — triggers a full re-extraction on renewal; reuses the rules engine for rule-change cures
- [[Add Existing Vendor to Locations]] — the third rules-only trigger; re-evaluates stored extractions against a new location's matrix
- [[Status Vocabulary]] — the Pass/Deficient/Uncertain findings and Under Review → Approved / Non-Compliant states this produces
- [[Document Storage & Security]] — stores the extracted fields; field-level encryption and tenant partitioning the engine writes within
- [[Audit Trail]] — receives the extraction, evaluation, and recommendation events, attributed to AI/system
- [[Vendor Record]] — renders the per-document, per-requirement evaluations as the Admin review workbench
- [[Corporate Command Center]] — shows Under Review volume and the post-approval Non-Compliant risk queue
- [[Roles & Permissions]] — JWT-gated, role-scoped access to the engine's results
- [[MISSION]] — #1 accuracy over speed and #2 defensibility are why the engine corroborates and logs everything
