// Structured-output field schema — verbatim from AI_Verification_Engine.md.
// Every leaf is { value, confidence, band, source, corroborated }.
// Sensitive fields (TIN value, routing_number, account_number) store ciphertext as value.

export type ConfBand = 'high' | 'med' | 'low';

export interface FieldSource {
  page: number;
  snippet: string;
}

export interface FieldValue<T = string | null> {
  value: T;
  confidence: number;
  band: ConfBand;
  source: FieldSource;
  corroborated: boolean;
}

// As returned by the model (before band/corroborated are computed)
export interface RawField {
  value: string | number | boolean | null;
  confidence: number;
  source: FieldSource;
}

export interface RawFieldStr {
  value: string | null;
  confidence: number;
  source: FieldSource;
}

export interface RawFieldNum {
  value: number | null;
  confidence: number;
  source: FieldSource;
}

export interface RawFieldBool {
  value: boolean | null;
  confidence: number;
  source: FieldSource;
}

// ── COI (ACORD 25) ─────────────────────────────────────────────────────────────

export interface RawInsurer {
  letter: string;
  carrier_name: RawFieldStr;
  naic: RawFieldStr;
}

export interface RawPolicy {
  coverage_type: RawFieldStr;       // general_liability|automobile_liability|umbrella_excess|workers_comp|employers_liability|professional_liability|pollution|other
  insurer_letter: RawFieldStr;
  policy_number: RawFieldStr;
  effective_date: RawFieldStr;
  expiration_date: RawFieldStr;
  limits: Record<string, RawFieldNum>;
  additional_insured: RawFieldBool;
  additional_insured_scope: RawFieldStr;  // blanket|scheduled
  waiver_of_subrogation: RawFieldBool;
  primary_noncontributory: RawFieldBool;
}

export interface RawCOIExtraction {
  document_type_confirmed: string;
  certificate_date: RawFieldStr;
  producer: RawFieldStr;
  named_insured: RawFieldStr;
  insured_address: RawFieldStr;
  insurers: RawInsurer[];
  policies: RawPolicy[];
  additional_insured_entities: RawFieldStr;
  description_of_operations: RawFieldStr;
  certificate_holder: RawFieldStr;
}

// ── W-9 ───────────────────────────────────────────────────────────────────────

export interface RawW9Extraction {
  document_type_confirmed: string;
  legal_name: RawFieldStr;
  business_name: RawFieldStr;
  federal_tax_classification: RawFieldStr;
  tin_type: RawFieldStr;         // SSN|EIN
  tin_value: RawFieldStr;        // SENSITIVE — ciphertext after processing
  address: RawFieldStr;
  signature_present: RawFieldBool;
  signature_date: RawFieldStr;
}

// ── ACH / banking ─────────────────────────────────────────────────────────────

export interface RawACHExtraction {
  document_type_confirmed: string;
  account_holder_name: RawFieldStr;
  bank_name: RawFieldStr;
  routing_number: RawFieldStr;    // SENSITIVE — ciphertext after processing
  account_number: RawFieldStr;    // SENSITIVE — ciphertext after processing
  account_type: RawFieldStr;
  voided_check_present: RawFieldBool;
  authorization_signature: RawFieldBool;
}

// ── Processed payload (what gets stored in extractions.payload_json) ────────────

export interface ProcessedInsurer {
  letter: string;
  carrier_name: FieldValue<string | null>;
  naic: FieldValue<string | null>;
}

export interface ProcessedPolicy {
  coverage_type: FieldValue<string | null>;
  insurer_letter: FieldValue<string | null>;
  policy_number: FieldValue<string | null>;
  effective_date: FieldValue<string | null>;
  expiration_date: FieldValue<string | null>;
  limits: Record<string, FieldValue<number | null>>;
  additional_insured: FieldValue<boolean | null>;
  additional_insured_scope: FieldValue<string | null>;
  waiver_of_subrogation: FieldValue<boolean | null>;
  primary_noncontributory: FieldValue<boolean | null>;
}

export interface ProcessedCOIExtraction {
  doc_type: 'coi';
  document_type_confirmed: string;
  certificate_date: FieldValue<string | null>;
  producer: FieldValue<string | null>;
  named_insured: FieldValue<string | null>;
  insured_address: FieldValue<string | null>;
  insurers: ProcessedInsurer[];
  policies: ProcessedPolicy[];
  additional_insured_entities: FieldValue<string | null>;
  description_of_operations: FieldValue<string | null>;
  certificate_holder: FieldValue<string | null>;
}

export interface ProcessedW9Extraction {
  doc_type: 'w9';
  document_type_confirmed: string;
  legal_name: FieldValue<string | null>;
  business_name: FieldValue<string | null>;
  federal_tax_classification: FieldValue<string | null>;
  tin_type: FieldValue<string | null>;
  tin_value: FieldValue<string | null>;   // ciphertext
  address: FieldValue<string | null>;
  signature_present: FieldValue<boolean | null>;
  signature_date: FieldValue<string | null>;
}

export interface ProcessedACHExtraction {
  doc_type: 'ach';
  document_type_confirmed: string;
  account_holder_name: FieldValue<string | null>;
  bank_name: FieldValue<string | null>;
  routing_number: FieldValue<string | null>;   // ciphertext
  account_number: FieldValue<string | null>;   // ciphertext
  account_type: FieldValue<string | null>;
  voided_check_present: FieldValue<boolean | null>;
  authorization_signature: FieldValue<boolean | null>;
}

export type ProcessedExtraction = ProcessedCOIExtraction | ProcessedW9Extraction | ProcessedACHExtraction;

export type DocType = 'coi' | 'w9' | 'ach';

export interface ExtractionBundle {
  coi?: ProcessedCOIExtraction;
  w9?: ProcessedW9Extraction;
  ach?: ProcessedACHExtraction;
}

// Corroboration target — flat field paths and their pass-1 values
export interface CorrobTarget {
  path: string;   // e.g. "named_insured", "policies.0.limits.each_occurrence"
  pass1Value: string | number | boolean | null;
}

// Corroboration result from the model
export interface CorrobResult {
  verifications: Record<string, RawField>;
}
