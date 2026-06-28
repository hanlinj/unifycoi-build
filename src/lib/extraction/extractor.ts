// Claude Vision extractor — Phase 4.
//
// Two-pass hybrid confidence model:
//   Pass 1: full extraction with self-rated confidence per field.
//   Pass 2: targeted corroboration of critical fields + any low-confidence fields.
//   Reconcile: agreement → band='high'; disagreement → band='low'.
//   Non-corroborated fields keep their pass-1 self-rating → band.
//
// Escalation: if any critical field is low-band after corroboration, re-extract
// those specific fields with VISION_MODEL_ESCALATION (Opus 4.8).
//
// Sensitive fields (TIN, routing_number, account_number) are encrypted with
// encryptField() immediately after extraction — never stored or logged in plaintext.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { encryptField } from '@/lib/crypto/field';
import { COI_TOOL, W9_TOOL, ACH_TOOL, CORROBORATE_TOOL } from './schema';
import type {
  DocType, ConfBand, FieldValue,
  RawField, RawFieldStr, RawFieldNum, RawFieldBool,
  RawCOIExtraction, RawW9Extraction, RawACHExtraction,
  ProcessedCOIExtraction, ProcessedW9Extraction, ProcessedACHExtraction,
  ProcessedExtraction, CorrobTarget,
} from './types';

// ── Clock injection (allows test harness to freeze date for expiration gate) ──

let _dateOverride: Date | null = null;

export function setEngineDateOverride(date: Date | null): void {
  _dateOverride = date;
}

export function getEngineDate(): Date {
  return _dateOverride ? new Date(_dateOverride) : new Date();
}

// Normalize date strings to YYYY-MM-DD whether they arrive as ISO or US slash format.
export function toIsoDateStr(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// ── Anthropic client (lazy init — avoids crashing unit tests without API key) ──

let _client: Anthropic | null = null;

function getClient(apiKeyOverride?: string): Anthropic {
  const key = apiKeyOverride ?? env.anthropic.apiKey;
  if (!key) throw new Error('ANTHROPIC_API_KEY is required for extraction');
  // Don't cache when an override key is provided
  if (!_client) {
    _client = new Anthropic({ apiKey: key });
  }
  return apiKeyOverride ? new Anthropic({ apiKey: apiKeyOverride }) : _client;
}

// ── Confidence helpers ─────────────────────────────────────────────────────────

export function toBand(confidence: number): ConfBand {
  if (confidence >= env.engine.confBandHigh) return 'high';
  if (confidence >= env.engine.confBandMed) return 'med';
  return 'low';
}

const NULL_SOURCE = { page: 0, snippet: '' } as const;

function strField(raw: RawFieldStr | undefined | null, band: ConfBand, corroborated: boolean): FieldValue<string | null> {
  if (!raw) return { value: null, confidence: 0, band, source: NULL_SOURCE, corroborated };
  return { value: raw.value, confidence: raw.confidence, band, source: raw.source, corroborated };
}

function numField(raw: RawFieldNum | undefined | null, band: ConfBand, corroborated: boolean): FieldValue<number | null> {
  if (!raw) return { value: null, confidence: 0, band, source: NULL_SOURCE, corroborated };
  return { value: raw.value, confidence: raw.confidence, band, source: raw.source, corroborated };
}

function boolField(raw: RawFieldBool | undefined | null, band: ConfBand, corroborated: boolean): FieldValue<boolean | null> {
  if (!raw) return { value: null, confidence: 0, band, source: NULL_SOURCE, corroborated };
  return { value: raw.value, confidence: raw.confidence, band, source: raw.source, corroborated };
}

// ── Corroboration target collectors ──────────────────────────────────────────

const CONF_THRESH = () => env.engine.confBandMed;

function coiCriticalPaths(raw: RawCOIExtraction): CorrobTarget[] {
  const t: CorrobTarget[] = [
    { path: 'named_insured', pass1Value: raw.named_insured.value },
    { path: 'certificate_holder', pass1Value: raw.certificate_holder.value },
  ];
  raw.policies.forEach((p, i) => {
    t.push(
      { path: `policies.${i}.coverage_type`, pass1Value: p.coverage_type.value },
      { path: `policies.${i}.expiration_date`, pass1Value: p.expiration_date.value },
      { path: `policies.${i}.additional_insured`, pass1Value: p.additional_insured.value },
      { path: `policies.${i}.waiver_of_subrogation`, pass1Value: p.waiver_of_subrogation.value },
      { path: `policies.${i}.primary_noncontributory`, pass1Value: p.primary_noncontributory.value },
    );
    Object.entries(p.limits).forEach(([k, v]) => {
      t.push({ path: `policies.${i}.limits.${k}`, pass1Value: v.value });
    });
  });
  return t;
}

function coiLowConfPaths(raw: RawCOIExtraction): CorrobTarget[] {
  const t: CorrobTarget[] = [];
  const thresh = CONF_THRESH();
  const add = (path: string, f: RawField) => {
    if (f.confidence < thresh) t.push({ path, pass1Value: f.value });
  };
  add('certificate_date', raw.certificate_date);
  add('producer', raw.producer);
  add('insured_address', raw.insured_address);
  add('additional_insured_entities', raw.additional_insured_entities);
  add('description_of_operations', raw.description_of_operations);
  raw.policies.forEach((p, i) => {
    add(`policies.${i}.policy_number`, p.policy_number);
    add(`policies.${i}.effective_date`, p.effective_date);
    add(`policies.${i}.additional_insured_scope`, p.additional_insured_scope);
  });
  return t;
}

function w9CriticalPaths(raw: RawW9Extraction): CorrobTarget[] {
  return [
    { path: 'legal_name', pass1Value: raw.legal_name.value },
    { path: 'federal_tax_classification', pass1Value: raw.federal_tax_classification.value },
    { path: 'tin_type', pass1Value: raw.tin_type.value },
  ];
}

function w9LowConfPaths(raw: RawW9Extraction): CorrobTarget[] {
  const t: CorrobTarget[] = [];
  const thresh = CONF_THRESH();
  if (raw.business_name.confidence < thresh) t.push({ path: 'business_name', pass1Value: raw.business_name.value });
  if (raw.address.confidence < thresh) t.push({ path: 'address', pass1Value: raw.address.value });
  return t;
}

function achCriticalPaths(raw: RawACHExtraction): CorrobTarget[] {
  return [
    { path: 'account_holder_name', pass1Value: raw.account_holder_name.value },
    { path: 'account_type', pass1Value: raw.account_type.value },
  ];
}

function achLowConfPaths(raw: RawACHExtraction): CorrobTarget[] {
  const t: CorrobTarget[] = [];
  if (raw.bank_name.confidence < CONF_THRESH()) t.push({ path: 'bank_name', pass1Value: raw.bank_name.value });
  return t;
}

function dedup(targets: CorrobTarget[]): CorrobTarget[] {
  return [...new Map(targets.map((t) => [t.path, t])).values()];
}

// ── API call helpers ───────────────────────────────────────────────────────────

async function callVision(
  pdfB64: string,
  tool: typeof COI_TOOL | typeof W9_TOOL | typeof ACH_TOOL,
  prompt: string,
  model: string,
  client: Anthropic
): Promise<unknown> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [tool as Anthropic.Tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } } as Anthropic.DocumentBlockParam,
        { type: 'text', text: prompt },
      ],
    }],
  });
  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    throw new Error(`Model did not call tool ${tool.name}`);
  }
  return (block as Anthropic.ToolUseBlock).input;
}

async function callCorroboration(
  pdfB64: string,
  targets: CorrobTarget[],
  model: string,
  client: Anthropic
): Promise<Record<string, RawField>> {
  if (targets.length === 0) return {};
  const fieldList = targets.map((t) => `  "${t.path}": first pass read ${JSON.stringify(t.pass1Value)}`).join('\n');
  const prompt = `The following fields were extracted from this document in a first pass. Please independently verify each one using the verify_fields tool.\n\nFields to verify:\n${fieldList}\n\nReport what you actually see in the document for each field. Agreement or disagreement with the first pass is fine — just be accurate.`;
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    tools: [CORROBORATE_TOOL as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'verify_fields' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } } as Anthropic.DocumentBlockParam,
        { type: 'text', text: prompt },
      ],
    }],
  });
  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return {};
  const result = (block as Anthropic.ToolUseBlock).input as { verifications?: Record<string, RawField> };
  return result.verifications ?? {};
}

// ── Reconciliation ─────────────────────────────────────────────────────────────

function valuesAgree(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return String(a) === String(b);
}

// Returns {band, corroborated} for a field given the corroboration result map
function fieldBand(
  path: string,
  pass1Conf: number,
  pass1Value: unknown,
  corrobResult: Record<string, RawField>
): { band: ConfBand; corroborated: boolean } {
  const corr = corrobResult[path];
  if (!corr) return { band: toBand(pass1Conf), corroborated: false };
  if (valuesAgree(pass1Value, corr.value)) return { band: 'high', corroborated: true };
  return { band: 'low', corroborated: true };  // disagreement → forced low
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const COI_PROMPT = `Extract all fields from this Certificate of Insurance (COI / ACORD 25 form) using the extract_coi tool.

For each field:
- value: exact value found, or null if absent/illegible
- confidence: 0.0–1.0 (1.0 = clearly printed; 0.75–0.89 = some ambiguity; <0.75 = unclear/reconstructed)
- source.page: page number (1-indexed)
- source.snippet: verbatim excerpt ≤50 chars

For limits: numeric amount only, no $ or commas (e.g. 1000000 not $1,000,000).

IMPORTANT — use these EXACT key names for limits:

General Liability limits:
  each_occurrence, damage_to_rented_premises, med_exp, personal_adv_injury, general_aggregate, products_completed_ops_aggregate

Automobile Liability limits:
  combined_single_limit, bi_per_person, bi_per_accident, property_damage

Umbrella / Excess Liability limits:
  each_occurrence, aggregate

Workers Compensation / Employers Liability limits:
  per_statute (bool — is the "Per Statute" box checked?), el_each_accident, el_disease_each_employee, el_disease_policy_limit

For endorsements (additional_insured, waiver_of_subrogation, primary_noncontributory):
- true: checkbox clearly marked (X or filled) OR endorsement explicitly stated in Description of Operations
- false: checkbox is EMPTY/BLANK and there is no such endorsement language in Description of Operations
- null: ambiguous or impossible to determine
IMPORTANT: An empty box is false, not true. Only mark true if you can clearly see a mark inside the checkbox.

For certificate_holder: extract ONLY the entity name (the first line), NOT the address. If the field contains a name followed by an address, return only the name.

Set document_type_confirmed to 'coi'. If this is NOT a COI, return the actual type.`;

const W9_PROMPT = `Extract all fields from this W-9 form using the extract_w9 tool.

For each field:
- value: exact value, or null if absent/illegible
- confidence: 0.0–1.0
- source.page and source.snippet (verbatim ≤50 chars)

For tin_value: extract the exact TIN/SSN/EIN as printed.
For federal_tax_classification: exact label from the form.

Set document_type_confirmed to 'w9'. If this is NOT a W-9, return the actual type.`;

const ACH_PROMPT = `Extract all fields from this ACH / direct deposit authorization form using the extract_ach tool.

For each field:
- value: exact value, or null if absent/illegible
- confidence: 0.0–1.0
- source.page and source.snippet (verbatim ≤50 chars)

For routing_number and account_number: extract the exact numbers as printed.

Set document_type_confirmed to 'ach'. If this is NOT an ACH form, return the actual type.`;

// ── Build processed payloads ───────────────────────────────────────────────────

function buildCOI(raw: RawCOIExtraction, corr: Record<string, RawField>): ProcessedCOIExtraction {
  // Optional-chain on f so undefined/null fields default to confidence=0, value=null
  const fb = (path: string, f: RawField | undefined | null) =>
    fieldBand(path, f?.confidence ?? 0, f?.value ?? null, corr);

  return {
    doc_type: 'coi',
    document_type_confirmed: raw.document_type_confirmed,
    certificate_date: strField(raw.certificate_date, ...bandPair(fb('certificate_date', raw.certificate_date))),
    producer: strField(raw.producer, ...bandPair(fb('producer', raw.producer))),
    named_insured: strField(raw.named_insured, ...bandPair(fb('named_insured', raw.named_insured))),
    insured_address: strField(raw.insured_address, ...bandPair(fb('insured_address', raw.insured_address))),
    insurers: raw.insurers.map((ins) => ({
      letter: ins.letter,
      carrier_name: strField(ins.carrier_name, toBand(ins.carrier_name.confidence), false),
      naic: strField(ins.naic, toBand(ins.naic.confidence), false),
    })),
    policies: raw.policies.map((p, i) => ({
      coverage_type: strField(p.coverage_type, ...bandPair(fb(`policies.${i}.coverage_type`, p.coverage_type))),
      insurer_letter: strField(p.insurer_letter, toBand(p.insurer_letter.confidence), false),
      policy_number: strField(p.policy_number, ...bandPair(fb(`policies.${i}.policy_number`, p.policy_number))),
      effective_date: strField(p.effective_date, ...bandPair(fb(`policies.${i}.effective_date`, p.effective_date))),
      expiration_date: strField(p.expiration_date, ...bandPair(fb(`policies.${i}.expiration_date`, p.expiration_date))),
      limits: Object.fromEntries(
        Object.entries(p.limits).map(([k, v]) => [
          k,
          numField(v, ...bandPair(fb(`policies.${i}.limits.${k}`, v))),
        ])
      ),
      additional_insured: boolField(p.additional_insured, ...bandPair(fb(`policies.${i}.additional_insured`, p.additional_insured))),
      additional_insured_scope: strField(p.additional_insured_scope, ...bandPair(fb(`policies.${i}.additional_insured_scope`, p.additional_insured_scope))),
      waiver_of_subrogation: boolField(p.waiver_of_subrogation, ...bandPair(fb(`policies.${i}.waiver_of_subrogation`, p.waiver_of_subrogation))),
      primary_noncontributory: boolField(p.primary_noncontributory, ...bandPair(fb(`policies.${i}.primary_noncontributory`, p.primary_noncontributory))),
    })),
    additional_insured_entities: strField(raw.additional_insured_entities, ...bandPair(fb('additional_insured_entities', raw.additional_insured_entities))),
    description_of_operations: strField(raw.description_of_operations, ...bandPair(fb('description_of_operations', raw.description_of_operations))),
    certificate_holder: strField(raw.certificate_holder, ...bandPair(fb('certificate_holder', raw.certificate_holder))),
  };
}

function buildW9(raw: RawW9Extraction, corr: Record<string, RawField>): ProcessedW9Extraction {
  const fb = (path: string, f: RawField) => fieldBand(path, f.confidence, f.value, corr);
  const tinCipher = raw.tin_value.value ? encryptField(raw.tin_value.value) : null;
  return {
    doc_type: 'w9',
    document_type_confirmed: raw.document_type_confirmed,
    legal_name: strField(raw.legal_name, ...bandPair(fb('legal_name', raw.legal_name))),
    business_name: strField(raw.business_name, ...bandPair(fb('business_name', raw.business_name))),
    federal_tax_classification: strField(raw.federal_tax_classification, ...bandPair(fb('federal_tax_classification', raw.federal_tax_classification))),
    tin_type: strField(raw.tin_type, ...bandPair(fb('tin_type', raw.tin_type))),
    tin_value: { value: tinCipher, confidence: raw.tin_value.confidence, band: toBand(raw.tin_value.confidence), source: raw.tin_value.source, corroborated: false },
    address: strField(raw.address, ...bandPair(fb('address', raw.address))),
    signature_present: boolField(raw.signature_present, toBand(raw.signature_present.confidence), false),
    signature_date: strField(raw.signature_date, toBand(raw.signature_date.confidence), false),
  };
}

function buildACH(raw: RawACHExtraction, corr: Record<string, RawField>): ProcessedACHExtraction {
  const fb = (path: string, f: RawField) => fieldBand(path, f.confidence, f.value, corr);
  const routingCipher = raw.routing_number.value ? encryptField(raw.routing_number.value) : null;
  const accountCipher = raw.account_number.value ? encryptField(raw.account_number.value) : null;
  return {
    doc_type: 'ach',
    document_type_confirmed: raw.document_type_confirmed,
    account_holder_name: strField(raw.account_holder_name, ...bandPair(fb('account_holder_name', raw.account_holder_name))),
    bank_name: strField(raw.bank_name, ...bandPair(fb('bank_name', raw.bank_name))),
    routing_number: { value: routingCipher, confidence: raw.routing_number.confidence, band: toBand(raw.routing_number.confidence), source: raw.routing_number.source, corroborated: false },
    account_number: { value: accountCipher, confidence: raw.account_number.confidence, band: toBand(raw.account_number.confidence), source: raw.account_number.source, corroborated: false },
    account_type: strField(raw.account_type, ...bandPair(fb('account_type', raw.account_type))),
    voided_check_present: boolField(raw.voided_check_present, toBand(raw.voided_check_present.confidence), false),
    authorization_signature: boolField(raw.authorization_signature, toBand(raw.authorization_signature.confidence), false),
  };
}

// Spread helper — converts {band, corroborated} to positional tuple [band, corroborated]
function bandPair(r: { band: ConfBand; corroborated: boolean }): [ConfBand, boolean] {
  return [r.band, r.corroborated];
}

// ── Find low-band critical paths after corroboration ──────────────────────────

function lowBandCriticals(processed: ProcessedCOIExtraction): string[] {
  const paths: string[] = [];
  if (processed.named_insured.band === 'low') paths.push('named_insured');
  if (processed.certificate_holder.band === 'low') paths.push('certificate_holder');
  processed.policies.forEach((p, i) => {
    if (p.coverage_type.band === 'low') paths.push(`policies.${i}.coverage_type`);
    if (p.expiration_date.band === 'low') paths.push(`policies.${i}.expiration_date`);
    if (p.additional_insured.band === 'low') paths.push(`policies.${i}.additional_insured`);
    if (p.waiver_of_subrogation.band === 'low') paths.push(`policies.${i}.waiver_of_subrogation`);
    if (p.primary_noncontributory.band === 'low') paths.push(`policies.${i}.primary_noncontributory`);
    Object.entries(p.limits).forEach(([k, v]) => {
      if (v.band === 'low') paths.push(`policies.${i}.limits.${k}`);
    });
  });
  return paths;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface ExtractionResult {
  payload: ProcessedExtraction;
  modelId: string;
  escalated: boolean;
}

export async function extractDocument(
  pdfBytes: Buffer,
  docType: DocType,
  opts: { modelOverride?: string; apiKeyOverride?: string } = {}
): Promise<ExtractionResult> {
  const client = getClient(opts.apiKeyOverride);
  const model = opts.modelOverride ?? env.anthropic.visionModelPrimary;
  const pdfB64 = pdfBytes.toString('base64');

  if (docType === 'coi') {
    const raw = await callVision(pdfB64, COI_TOOL, COI_PROMPT, model, client) as RawCOIExtraction;
    const allTargets = dedup([...coiCriticalPaths(raw), ...coiLowConfPaths(raw)]);
    const corr = await callCorroboration(pdfB64, allTargets, model, client);
    let processed = buildCOI(raw, corr);

    const lowCritPaths = lowBandCriticals(processed);
    if (lowCritPaths.length > 0) {
      const escalModel = env.anthropic.visionModelEscalation;
      const escalTargets: CorrobTarget[] = lowCritPaths.map((p) => ({ path: p, pass1Value: null }));
      const escalCorr = await callCorroboration(pdfB64, escalTargets, escalModel, client);
      // Escalation results take precedence over primary corroboration for those paths
      processed = buildCOI(raw, { ...corr, ...escalCorr });
      return { payload: processed, modelId: model, escalated: true };
    }
    return { payload: processed, modelId: model, escalated: false };

  } else if (docType === 'w9') {
    const raw = await callVision(pdfB64, W9_TOOL, W9_PROMPT, model, client) as RawW9Extraction;
    const allTargets = dedup([...w9CriticalPaths(raw), ...w9LowConfPaths(raw)]);
    const corr = await callCorroboration(pdfB64, allTargets, model, client);
    return { payload: buildW9(raw, corr), modelId: model, escalated: false };

  } else {
    const raw = await callVision(pdfB64, ACH_TOOL, ACH_PROMPT, model, client) as RawACHExtraction;
    const allTargets = dedup([...achCriticalPaths(raw), ...achLowConfPaths(raw)]);
    const corr = await callCorroboration(pdfB64, allTargets, model, client);
    return { payload: buildACH(raw, corr), modelId: model, escalated: false };
  }
}

// ── Expiration gate ────────────────────────────────────────────────────────────
// Fires AFTER extraction, BEFORE verification run enqueue (invariant #6).

export function checkExpirationGate(
  extraction: ProcessedCOIExtraction
): { passed: boolean; expiredPolicies: string[] } {
  const referenceDate = getEngineDate();
  const expiredPolicies: string[] = [];
  for (const policy of extraction.policies) {
    const expStr = policy.expiration_date?.value;
    if (!expStr) continue;
    const isoStr = toIsoDateStr(expStr);
    const expDate = isoStr ? new Date(isoStr + 'T00:00:00Z') : new Date(expStr);
    if (isNaN(expDate.getTime())) continue;
    if (expDate < referenceDate) {
      expiredPolicies.push(`${policy.coverage_type?.value ?? 'unknown'} (expires ${expStr})`);
    }
  }
  return { passed: expiredPolicies.length === 0, expiredPolicies };
}
