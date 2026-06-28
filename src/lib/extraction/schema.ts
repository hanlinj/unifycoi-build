// Tool-use JSON schemas for forced structured output from Claude Vision.
// These are sent as input_schema in the tools array.

const sourceShape = {
  type: 'object' as const,
  required: ['page', 'snippet'],
  properties: {
    page: { type: 'number' },
    snippet: { type: 'string', description: 'Short verbatim excerpt (≤50 chars) from the document' },
  },
};

const strField = {
  type: 'object' as const,
  required: ['value', 'confidence', 'source'],
  properties: {
    value: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: sourceShape,
  },
};

const numField = {
  type: 'object' as const,
  required: ['value', 'confidence', 'source'],
  properties: {
    value: { type: ['number', 'null'], description: 'Numeric value without currency symbols or commas' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: sourceShape,
  },
};

const boolField = {
  type: 'object' as const,
  required: ['value', 'confidence', 'source'],
  properties: {
    value: { type: ['boolean', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: sourceShape,
  },
};

const limitsField = {
  type: 'object' as const,
  description: 'Limit fields keyed by limit type (e.g. each_occurrence, general_aggregate, combined_single_limit)',
  additionalProperties: numField,
};

const policyShape = {
  type: 'object' as const,
  properties: {
    coverage_type: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], enum: ['general_liability', 'automobile_liability', 'umbrella_excess', 'workers_comp', 'employers_liability', 'professional_liability', 'pollution', 'other', null] } } },
    insurer_letter: strField,
    policy_number: strField,
    effective_date: strField,
    expiration_date: strField,
    limits: limitsField,
    additional_insured: boolField,
    additional_insured_scope: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'blanket or scheduled' } } },
    waiver_of_subrogation: boolField,
    primary_noncontributory: boolField,
  },
};

export const COI_TOOL = {
  name: 'extract_coi',
  description: 'Extract structured data from a Certificate of Insurance (COI / ACORD 25) document.',
  input_schema: {
    type: 'object' as const,
    required: [
      'document_type_confirmed', 'certificate_date', 'producer', 'named_insured',
      'insured_address', 'insurers', 'policies', 'additional_insured_entities',
      'description_of_operations', 'certificate_holder',
    ],
    properties: {
      document_type_confirmed: {
        type: 'string',
        description: "Confirm document type: 'coi'. If this is NOT a COI, return 'w9', 'ach', or 'unknown'.",
      },
      certificate_date: strField,
      producer: strField,
      named_insured: strField,
      insured_address: strField,
      insurers: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            letter: { type: 'string' },
            carrier_name: strField,
            naic: strField,
          },
        },
      },
      policies: {
        type: 'array' as const,
        items: policyShape,
      },
      additional_insured_entities: strField,
      description_of_operations: strField,
      certificate_holder: strField,
    },
  },
};

export const W9_TOOL = {
  name: 'extract_w9',
  description: 'Extract structured data from a W-9 tax form.',
  input_schema: {
    type: 'object' as const,
    required: [
      'document_type_confirmed', 'legal_name', 'business_name',
      'federal_tax_classification', 'tin_type', 'tin_value',
      'address', 'signature_present', 'signature_date',
    ],
    properties: {
      document_type_confirmed: {
        type: 'string',
        description: "Confirm document type: 'w9'. If this is NOT a W-9, return 'coi', 'ach', or 'unknown'.",
      },
      legal_name: strField,
      business_name: strField,
      federal_tax_classification: {
        ...strField,
        properties: {
          ...strField.properties,
          value: {
            type: ['string', 'null'],
            description: "One of: Individual/sole proprietor, Single-member LLC, C Corporation, S Corporation, Partnership, Trust/estate, LLC-C, LLC-S, LLC-P, or Other",
          },
        },
      },
      tin_type: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'SSN or EIN' } } },
      tin_value: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'The full TIN/SSN/EIN as printed (will be encrypted at rest)' } } },
      address: strField,
      signature_present: boolField,
      signature_date: strField,
    },
  },
};

export const ACH_TOOL = {
  name: 'extract_ach',
  description: 'Extract structured data from an ACH / direct deposit / banking authorization form.',
  input_schema: {
    type: 'object' as const,
    required: [
      'document_type_confirmed', 'account_holder_name', 'bank_name',
      'routing_number', 'account_number', 'account_type',
      'voided_check_present', 'authorization_signature',
    ],
    properties: {
      document_type_confirmed: {
        type: 'string',
        description: "Confirm document type: 'ach'. If this is NOT an ACH form, return 'coi', 'w9', or 'unknown'.",
      },
      account_holder_name: strField,
      bank_name: strField,
      routing_number: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'Routing number as printed (will be encrypted at rest)' } } },
      account_number: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'Account number as printed (will be encrypted at rest)' } } },
      account_type: { ...strField, properties: { ...strField.properties, value: { type: ['string', 'null'], description: 'checking or savings' } } },
      voided_check_present: boolField,
      authorization_signature: boolField,
    },
  },
};

// Tool for targeted corroboration (pass 2) — flat field paths
export const CORROBORATE_TOOL = {
  name: 'verify_fields',
  description: 'Independently verify specific fields from the document.',
  input_schema: {
    type: 'object' as const,
    required: ['verifications'],
    properties: {
      verifications: {
        type: 'object' as const,
        description: 'Object keyed by field path (e.g. "named_insured", "policies.0.expiration_date"), each with value + confidence + source.',
        additionalProperties: {
          type: 'object' as const,
          required: ['value', 'confidence', 'source'],
          properties: {
            value: { description: 'The field value as you read it, or null if absent/illegible' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            source: sourceShape,
          },
        },
      },
    },
  },
};
