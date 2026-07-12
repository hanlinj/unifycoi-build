/**
 * generate-fixtures.ts
 *
 * Generates 30 clean baseline PDFs (10 vendors × 3 docs: COI / W-9 / ACH).
 * All content is drawn via page.drawText() — no AcroForm widgets — so Vision
 * reads exactly what is printed.  Idempotent: re-running overwrites with the
 * same data.
 *
 * Usage:  npx tsx scripts/generate-fixtures.ts
 *
 * Reference authority: test-fixtures/UnifyCOI_TestReference.pdf
 */

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';

// ── Vendor data table ──────────────────────────────────────────────────────────
// All values transcribed from UnifyCOI_TestReference.pdf.
// operator_name is the required certificate_holder value from ORG_REQUIREMENTS.

const OPERATOR = 'StoreSafe Capital Partners LLC';
const OPERATOR_ADDR = '3100 Ironwood Dr, Suite 500, Coeur d\'Alene, ID 83815';

interface WCLimits {
  el_each_accident: string;
  el_disease_each_employee: string;
  el_disease_policy_limit: string;
}

interface Policy {
  coverage_type: 'general_liability' | 'automobile_liability' | 'umbrella_excess' | 'workers_comp';
  insurer_letter: string;
  carrier: string;
  policy_number: string;
  effective: string;
  expiration: string;
  limits: string;              // display string for GL/Auto/Umbrella limits column
  wc_limits?: WCLimits;       // three-part WC limits; required when coverage_type=workers_comp and policy_number set
  additional_insured: boolean | null;  // null = absent (row missing entirely)
}

interface VendorData {
  fixture_dir: string;
  // COI
  coi_named_insured: string;          // what appears on COI (may differ from legal name)
  coi_insured_address: string;
  coi_producer: string;
  coi_cert_holder: string;            // the field we're fixing — printed in content stream
  coi_cert_holder_addr: string;
  coi_date: string;
  coi_insurers: { letter: string; carrier: string }[];
  coi_policies: Policy[];
  coi_description_of_ops: string;
  // W-9
  w9_legal_name: string;
  w9_business_name: string | null;    // DBA / line 2
  w9_classification: string;          // checked box label
  w9_tin_type: 'SSN' | 'EIN';
  w9_tin: string;
  w9_address: string;
  // ACH
  ach_holder: string;
  ach_bank: string;
  ach_routing: string;
  ach_account: string;
  ach_type: 'Checking' | 'Savings';
}

const VENDORS: VendorData[] = [
  // ── 01 PeakGuard ─────────────────────────────────────────────────────────────
  {
    fixture_dir: 'PeakGuard (Perfect)',
    coi_named_insured: 'PeakGuard Facility Services LLC',
    coi_insured_address: '4875 N Atlas Dr, Suite 200, Coeur d\'Alene, ID 83815',
    coi_producer: 'Cascade Risk Advisors LLC',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Travelers Casualty & Surety Co' },
      { letter: 'B', carrier: 'Zurich American Insurance Co' },
      { letter: 'C', carrier: 'Liberty Mutual Insurance Co' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Travelers Casualty & Surety Co', policy_number: 'TRV-GL-2026-884412',   effective: '01/01/2026', expiration: '01/01/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'B', carrier: 'Zurich American Insurance Co',   policy_number: 'ZUR-AUTO-2026-554891', effective: '01/01/2026', expiration: '01/01/2027', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'Travelers Casualty & Surety Co', policy_number: 'TRV-UMB-2026-221078',  effective: '01/01/2026', expiration: '01/01/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'C', carrier: 'Liberty Mutual Insurance Co',    policy_number: 'LM-WC-2026-770345',    effective: '01/01/2026', expiration: '01/01/2027', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract.',
    w9_legal_name: 'PeakGuard Facility Services LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '47-3821904',
    w9_address: '4875 N Atlas Dr, Suite 200, Coeur d\'Alene, ID 83815',
    ach_holder: 'PeakGuard Facility Services LLC',
    ach_bank: 'Banner Bank',
    ach_routing: '125108085',
    ach_account: '4401882953',
    ach_type: 'Checking',
  },

  // ── 02 RidgeLine ─────────────────────────────────────────────────────────────
  {
    fixture_dir: 'RidgeLine Tree (Perfect)',
    coi_named_insured: 'Ridgeline Tree & Arbor Services LLC',
    coi_insured_address: '7201 E Seltice Way, Unit 12, Post Falls, ID 83854',
    coi_producer: 'Northwest Ag & Specialty Insurance',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Nationwide Mutual Insurance Co' },
      { letter: 'B', carrier: 'Philadelphia Consolidated Holding' },
      { letter: 'C', carrier: 'Employers Holdings Inc' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Nationwide Mutual Insurance Co',      policy_number: 'NW-GL-2026-339175',     effective: '03/01/2026', expiration: '03/01/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Nationwide Mutual Insurance Co',      policy_number: 'NW-AUTO-2026-447822',   effective: '03/01/2026', expiration: '03/01/2027', limits: '$1,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'B', carrier: 'Philadelphia Consolidated Holding',  policy_number: 'PHLY-UMB-2026-108834', effective: '03/01/2026', expiration: '03/01/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'C', carrier: 'Employers Holdings Inc',             policy_number: 'EMP-WC-2026-682901',    effective: '03/01/2026', expiration: '03/01/2027', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'ISA Certified Arborist. Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract.',
    w9_legal_name: 'Ridgeline Tree & Arbor Services LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '82-5094317',
    w9_address: '7201 E Seltice Way, Unit 12, Post Falls, ID 83854',
    ach_holder: 'Ridgeline Tree & Arbor Services LLC',
    ach_bank: 'Idaho Central Credit Union',
    ach_routing: '324377516',
    ach_account: '7712039486',
    ach_type: 'Checking',
  },

  // ── 03 Clearwater — WC absent, exemption claimed ──────────────────────────────
  {
    fixture_dir: 'Clearwater (Errors)',
    coi_named_insured: 'Clearwater Landscape & Grounds LLC',
    coi_insured_address: '2250 N Government Way, Bay 4, Coeur d\'Alene, ID 83814',
    coi_producer: 'Inland Empire Insurance Brokers',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Cincinnati Insurance Company' },
      { letter: 'B', carrier: 'Markel American Insurance Co' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Cincinnati Insurance Company', policy_number: 'CIN-GL-2026-804521',   effective: '01/15/2026', expiration: '01/15/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Cincinnati Insurance Company', policy_number: 'CIN-AUTO-2026-916340', effective: '01/15/2026', expiration: '01/15/2027', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'B', carrier: 'Markel American Insurance Co', policy_number: 'MKL-UMB-2026-237791', effective: '01/15/2026', expiration: '01/15/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      // workers_comp: intentionally absent — blank section, no data
      { coverage_type: 'workers_comp', insurer_letter: '', carrier: '', policy_number: '', effective: '', expiration: '', limits: '', additional_insured: null },
    ],
    coi_description_of_ops: 'Owner claims sole-owner exemption from Workers\' Compensation per Idaho IC 72-212. Zero employees on payroll. Exemption documentation on file with owner.',
    w9_legal_name: 'Clearwater Landscape & Grounds LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '35-7162048',
    w9_address: '2250 N Government Way, Bay 4, Coeur d\'Alene, ID 83814',
    ach_holder: 'Clearwater Landscape & Grounds LLC',
    ach_bank: 'Glacier Bank',
    ach_routing: '092905278',
    ach_account: '5508841237',
    ach_type: 'Checking',
  },

  // ── 04 Summit Pro — 7 defects ─────────────────────────────────────────────────
  {
    fixture_dir: 'Summit Pro (Errors)',
    // COI named insured is DBA only — intentional defect
    coi_named_insured: 'Summit Pro Plumbing',
    coi_insured_address: '1148 E Mullan Ave, Post Falls, ID 83854',
    coi_producer: 'High Country Insurance Group',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Acuity A Mutual Insurance Co' },
      { letter: 'B', carrier: 'Employers Assurance Corp' },
    ],
    coi_policies: [
      // GL below minimum — $500K occ / $1M agg; ADD'L INSRD = No
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Acuity A Mutual Insurance Co', policy_number: 'ACU-GL-2026-571340',   effective: '02/01/2026', expiration: '02/01/2027', limits: '$500,000 / $1,000,000',   additional_insured: false },
      // Auto below minimum — $500K CSL; ADD'L INSRD = No
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Acuity A Mutual Insurance Co', policy_number: 'ACU-AUTO-2026-612087', effective: '02/01/2026', expiration: '02/01/2027', limits: '$500,000 CSL',            additional_insured: false },
      // Umbrella entirely absent
      // WC below minimum — $500K on all three sub-limits; ADD'L INSRD = No
      { coverage_type: 'workers_comp',        insurer_letter: 'B', carrier: 'Employers Assurance Corp',    policy_number: 'EAC-WC-2026-304418',  effective: '02/01/2026', expiration: '02/01/2027', limits: '$500,000', wc_limits: { el_each_accident: '$500,000', el_disease_each_employee: '$500,000', el_disease_policy_limit: '$500,000' }, additional_insured: false },
    ],
    // No "additional insured" language in description
    coi_description_of_ops: 'Operations: Commercial plumbing and mechanical services.',
    w9_legal_name: 'Summit Pro Plumbing & Mechanical LLC',
    w9_business_name: 'Summit Pro Plumbing',
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '61-4473829',
    w9_address: '1148 E Mullan Ave, Post Falls, ID 83854',
    // ACH payee is the owner personally — intentional defect
    ach_holder: 'Travis K. Bowman',
    ach_bank: 'Numerica Credit Union',
    ach_routing: '325182737',
    ach_account: '3309154872',
    ach_type: 'Checking',
  },

  // ── 05 Apex — all policies expired ───────────────────────────────────────────
  {
    fixture_dir: 'Apex Electric (Error)',
    coi_named_insured: 'Apex Electrical Contractors LLC',
    coi_insured_address: '3340 N Ramsey Rd, Suite 6, Coeur d\'Alene, ID 83815',
    coi_producer: 'Silver Valley Insurance Group',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '11/15/2025',   // certificate date matches policy expiry
    coi_insurers: [
      { letter: 'A', carrier: 'West American Insurance Co' },
      { letter: 'B', carrier: 'ICW National Insurance Co' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'West American Insurance Co', policy_number: 'WAI-GL-2025-490812',   effective: '11/15/2024', expiration: '11/15/2025', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'West American Insurance Co', policy_number: 'WAI-AUTO-2025-601334', effective: '11/15/2024', expiration: '11/15/2025', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'West American Insurance Co', policy_number: 'WAI-UMB-2025-788209', effective: '11/15/2024', expiration: '11/15/2025', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'B', carrier: 'ICW National Insurance Co',  policy_number: 'ICW-WC-2025-114772',  effective: '11/15/2024', expiration: '11/15/2025', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract.',
    w9_legal_name: 'Apex Electrical Contractors LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '20-8834501',
    w9_address: '3340 N Ramsey Rd, Suite 6, Coeur d\'Alene, ID 83815',
    ach_holder: 'Apex Electrical Contractors LLC',
    ach_bank: 'Mountain West Bank',
    ach_routing: '124002971',
    ach_account: '6614027839',
    ach_type: 'Checking',
  },

  // ── 06 Four Seasons — policies expire 13 days after reference date ─────────────
  {
    fixture_dir: 'Four Seasons HVAC (Error)',
    coi_named_insured: 'Four Seasons HVAC & Mechanical LLC',
    coi_insured_address: '905 W Dalton Ave, Unit 3, Coeur d\'Alene, ID 83815',
    coi_producer: 'Panhandle Commercial Insurance',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Berkley One Insurance Company' },
      { letter: 'B', carrier: 'Pinnacol Assurance' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Berkley One Insurance Company', policy_number: 'BKO-GL-2026-223948',   effective: '04/22/2025', expiration: '04/22/2026', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Berkley One Insurance Company', policy_number: 'BKO-AUTO-2026-441207', effective: '04/22/2025', expiration: '04/22/2026', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'Berkley One Insurance Company', policy_number: 'BKO-UMB-2026-558819', effective: '04/22/2025', expiration: '04/22/2026', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'B', carrier: 'Pinnacol Assurance',            policy_number: 'PIN-WC-2026-097634',  effective: '04/22/2025', expiration: '04/22/2026', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract. Policies expire 04/22/2026.',
    w9_legal_name: 'Four Seasons HVAC & Mechanical LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '45-2190836',
    w9_address: '905 W Dalton Ave, Unit 3, Coeur d\'Alene, ID 83815',
    ach_holder: 'Four Seasons HVAC & Mechanical LLC',
    ach_bank: 'Banner Bank',
    ach_routing: '125108085',
    ach_account: '8823041756',
    ach_type: 'Checking',
  },

  // ── 07 Iron Gate — wrong certificate holder (intentional defect) ───────────────
  {
    fixture_dir: 'Iron Gate Security (Error)',
    coi_named_insured: 'Iron Gate Security Solutions LLC',
    coi_insured_address: '612 W Haycraft Ave, Suite B, Coeur d\'Alene, ID 83815',
    coi_producer: 'Evergreen Business Insurance LLC',
    // DEFECT: cert holder is wrong operator entity
    coi_cert_holder: 'Cascade Self Storage Partners LP',
    coi_cert_holder_addr: '1800 W Kathleen Ave, Suite 300, Coeur d\'Alene, ID 83815',
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Hanover Insurance Company' },
      { letter: 'B', carrier: 'State Compensation Insurance Fund' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Hanover Insurance Company',          policy_number: 'HAN-GL-2026-339017',   effective: '01/01/2026', expiration: '01/01/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Hanover Insurance Company',          policy_number: 'HAN-AUTO-2026-512280', effective: '01/01/2026', expiration: '01/01/2027', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'Hanover Insurance Company',          policy_number: 'HAN-UMB-2026-688441', effective: '01/01/2026', expiration: '01/01/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'B', carrier: 'State Compensation Insurance Fund', policy_number: 'SCIF-WC-2026-203915', effective: '01/01/2026', expiration: '01/01/2027', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract.',
    w9_legal_name: 'Iron Gate Security Solutions LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '83-6740122',
    w9_address: '612 W Haycraft Ave, Suite B, Coeur d\'Alene, ID 83815',
    ach_holder: 'Iron Gate Security Solutions LLC',
    ach_bank: 'Glacier Bank',
    ach_routing: '092905278',
    ach_account: '2290183647',
    ach_type: 'Checking',
  },

  // ── 08 ProClean — ADD'L INSRD = No on GL and Auto ─────────────────────────────
  {
    fixture_dir: 'ProClean (Error)',
    coi_named_insured: 'ProClean Commercial Services LLC',
    coi_insured_address: '890 W Kathleen Ave, Unit 7, Coeur d\'Alene, ID 83815',
    coi_producer: 'Benchmark Insurance Services',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Travelers Property Casualty Co' },
      { letter: 'B', carrier: 'Applied Underwriters Inc' },
    ],
    coi_policies: [
      // DEFECT: additional_insured = false on GL and Auto
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Travelers Property Casualty Co', policy_number: 'TPC-GL-2026-774033',   effective: '02/15/2026', expiration: '02/15/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: false },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Travelers Property Casualty Co', policy_number: 'TPC-AUTO-2026-891204', effective: '02/15/2026', expiration: '02/15/2027', limits: '$2,000,000 CSL',           additional_insured: false },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'Travelers Property Casualty Co', policy_number: 'TPC-UMB-2026-102877', effective: '02/15/2026', expiration: '02/15/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'B', carrier: 'Applied Underwriters Inc',       policy_number: 'APU-WC-2026-338812',  effective: '02/15/2026', expiration: '02/15/2027', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    // DEFECT: no AI language in description of operations
    coi_description_of_ops: 'Commercial janitorial and cleaning services. Operations include daily, weekly, and periodic deep-cleaning contracts.',
    w9_legal_name: 'ProClean Commercial Services LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '91-3057489',
    w9_address: '890 W Kathleen Ave, Unit 7, Coeur d\'Alene, ID 83815',
    ach_holder: 'ProClean Commercial Services LLC',
    ach_bank: 'Idaho Central Credit Union',
    ach_routing: '324377516',
    ach_account: '3301847265',
    ach_type: 'Checking',
  },

  // ── 09 Timberline — compliant, advisory: coverage_continuity ──────────────────
  {
    fixture_dir: 'Timberline Painting (Error)',
    coi_named_insured: 'Timberline Painting & Coatings LLC',
    coi_insured_address: '488 N Idahline Rd, Bay 2, Post Falls, ID 83854',
    coi_producer: 'Mountain West Risk Partners',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Employers Mutual Casualty Co' },
      { letter: 'B', carrier: 'Accident Fund Insurance Co' },
    ],
    coi_policies: [
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Employers Mutual Casualty Co', policy_number: 'EMC-GL-2026-118804',   effective: '04/03/2026', expiration: '04/03/2027', limits: '$2,000,000 / $4,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Employers Mutual Casualty Co', policy_number: 'EMC-AUTO-2026-229017', effective: '04/03/2026', expiration: '04/03/2027', limits: '$2,000,000 CSL',           additional_insured: true  },
      { coverage_type: 'umbrella_excess',      insurer_letter: 'A', carrier: 'Employers Mutual Casualty Co', policy_number: 'EMC-UMB-2026-340128', effective: '04/03/2026', expiration: '04/03/2027', limits: '$5,000,000 / $5,000,000', additional_insured: false },
      { coverage_type: 'workers_comp',         insurer_letter: 'B', carrier: 'Accident Fund Insurance Co',   policy_number: 'AFC-WC-2026-451339',  effective: '04/03/2026', expiration: '04/03/2027', limits: '$1,000,000', wc_limits: { el_each_accident: '$1,000,000', el_disease_each_employee: '$1,000,000', el_disease_policy_limit: '$1,000,000' }, additional_insured: false },
    ],
    coi_description_of_ops: 'Certificate holder is named as Additional Insured on General Liability and Automobile Liability policies per written contract. New carrier effective 04/03/2026.',
    w9_legal_name: 'Timberline Painting & Coatings LLC',
    w9_business_name: null,
    w9_classification: 'Limited liability company — Tax classification: S',
    w9_tin_type: 'EIN',
    w9_tin: '38-4918763',
    w9_address: '488 N Idahline Rd, Bay 2, Post Falls, ID 83854',
    ach_holder: 'Timberline Painting & Coatings LLC',
    ach_bank: 'Numerica Credit Union',
    ach_routing: '325182737',
    ach_account: '9920384751',
    ach_type: 'Checking',
  },

  // ── 10 Kowalski — sole proprietor, multiple defects ───────────────────────────
  {
    fixture_dir: 'Kowalski Handyman (Error)',
    // COI named insured: DBA only (intentional defect)
    coi_named_insured: 'Kowalski Handyman Services',
    coi_insured_address: '29 W Dalton Ave, Coeur d\'Alene, ID 83815',
    coi_producer: 'Direct Choice Insurance',
    coi_cert_holder: OPERATOR,
    coi_cert_holder_addr: OPERATOR_ADDR,
    coi_date: '04/09/2026',
    coi_insurers: [
      { letter: 'A', carrier: 'Progressive Casualty Insurance Co' },
    ],
    coi_policies: [
      // GL meets floor ($1M/$2M) but below preferred ($2M/$4M) — pass at current requirements
      { coverage_type: 'general_liability',   insurer_letter: 'A', carrier: 'Progressive Casualty Insurance Co', policy_number: 'PRG-GL-2026-667104',   effective: '03/01/2026', expiration: '03/01/2027', limits: '$1,000,000 / $2,000,000',  additional_insured: true  },
      { coverage_type: 'automobile_liability', insurer_letter: 'A', carrier: 'Progressive Casualty Insurance Co', policy_number: 'PRG-AUTO-2026-780219', effective: '03/01/2026', expiration: '03/01/2027', limits: '$1,000,000 CSL',           additional_insured: true  },
      // Umbrella absent, WC absent — intentional defects
    ],
    // No AI language beyond what's checked; no WC exemption claim in description
    coi_description_of_ops: 'Handyman and general repair services. Sole proprietor — no employees.',
    // W-9: individual, SSN
    w9_legal_name: 'Randy L. Kowalski',
    w9_business_name: 'Kowalski Handyman Services',
    w9_classification: 'Individual/sole proprietor',
    w9_tin_type: 'SSN',
    w9_tin: '541-74-8812',
    w9_address: '29 W Dalton Ave, Coeur d\'Alene, ID 83815',
    // ACH: personal account (defect)
    ach_holder: 'Randy L. Kowalski',
    ach_bank: 'Mountain West Bank',
    ach_routing: '124002971',
    ach_account: '1104839201',
    ach_type: 'Checking',
  },
];

// ── Drawing helpers ─────────────────────────────────────────────────────────────

const BLACK  = rgb(0, 0, 0);
const GRAY   = rgb(0.5, 0.5, 0.5);
const LGRAY  = rgb(0.85, 0.85, 0.85);
const WHITE  = rgb(1, 1, 1);

interface DrawCtx {
  page: PDFPage;
  reg: PDFFont;
  bold: PDFFont;
  W: number;
  H: number;
}

function box(c: DrawCtx, x: number, y: number, w: number, h: number, fill?: Parameters<typeof rgb>[0] extends number ? ReturnType<typeof rgb> : never) {
  c.page.drawRectangle({
    x, y, width: w, height: h,
    borderColor: BLACK, borderWidth: 0.5,
    color: fill ?? WHITE,
  });
}

function label(c: DrawCtx, text: string, x: number, y: number, size = 6, font?: PDFFont, color = BLACK) {
  if (!text) return;
  c.page.drawText(text, { x, y, size, font: font ?? c.reg, color });
}

function checkbox(c: DrawCtx, x: number, y: number, checked: boolean | null) {
  const sz = 7;
  box(c, x, y, sz, sz);
  if (checked === true) {
    // draw X
    c.page.drawLine({ start: { x, y }, end: { x: x + sz, y: y + sz }, thickness: 0.8, color: BLACK });
    c.page.drawLine({ start: { x, y: y + sz }, end: { x: x + sz, y }, thickness: 0.8, color: BLACK });
  }
}

function hline(c: DrawCtx, x1: number, x2: number, y: number) {
  c.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: BLACK });
}

function vline(c: DrawCtx, x: number, y1: number, y2: number) {
  c.page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 0.5, color: BLACK });
}

function coverageLabel(type: string): string {
  switch (type) {
    case 'general_liability':   return 'COMMERCIAL GENERAL LIABILITY';
    case 'automobile_liability': return 'AUTOMOBILE LIABILITY';
    case 'umbrella_excess':      return 'UMBRELLA / EXCESS LIABILITY';
    case 'workers_comp':         return 'WORKERS COMPENSATION AND EMPLOYERS LIABILITY';
    default: return type.toUpperCase();
  }
}

// ── COI generator ──────────────────────────────────────────────────────────────

async function generateCOI(v: VendorData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: DrawCtx = { page, reg, bold, W: 612, H: 792 };

  const ML = 36; const MR = 576; const W = MR - ML;

  // ── Header ────────────────────────────────────────────────────────────────────
  label(c, 'ACORD 25 (2016/03)', ML, 774, 7, bold);
  label(c, 'CERTIFICATE OF LIABILITY INSURANCE', ML + 140, 774, 9, bold);
  label(c, `DATE (MM/DD/YYYY): ${v.coi_date}`, MR - 120, 774, 7, reg);
  hline(c, ML, MR, 769);

  // ── Top info band: THIS CERTIFICATE IS ISSUED... ──────────────────────────────
  label(c, 'THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY AND CONFERS NO RIGHTS UPON THE CERTIFICATE', ML, 762, 5.5, reg);
  label(c, 'HOLDER. THIS CERTIFICATE DOES NOT AFFIRMATIVELY OR NEGATIVELY AMEND, EXTEND OR ALTER THE COVERAGE', ML, 756, 5.5, reg);
  label(c, 'AFFORDED BY THE POLICIES BELOW.', ML, 750, 5.5, reg);
  hline(c, ML, MR, 746);

  // ── Producer / Insured two-column ─────────────────────────────────────────────
  const midX = ML + W / 2;
  vline(c, midX, 670, 746);
  hline(c, ML, MR, 670);

  label(c, 'PRODUCER', ML + 2, 740, 6, bold);
  label(c, v.coi_producer, ML + 2, 726, 7, reg);

  label(c, 'INSURED', midX + 2, 740, 6, bold);
  label(c, v.coi_named_insured, midX + 2, 726, 7, bold);
  // wrap address if needed
  const addrParts = v.coi_insured_address.split(', ');
  if (addrParts.length >= 3) {
    label(c, addrParts.slice(0, 2).join(', '), midX + 2, 716, 7, reg);
    label(c, addrParts.slice(2).join(', '), midX + 2, 707, 7, reg);
  } else {
    label(c, v.coi_insured_address, midX + 2, 716, 7, reg);
  }

  // ── Insurers section ──────────────────────────────────────────────────────────
  label(c, 'INSURER(S) AFFORDING COVERAGE', ML + 2, 664, 6, bold);
  label(c, 'NAIC #', MR - 50, 664, 6, bold);
  hline(c, ML, MR, 660);
  let iy = 650;
  for (const ins of v.coi_insurers) {
    label(c, `INSURER ${ins.letter}:  ${ins.carrier}`, ML + 2, iy, 7, reg);
    iy -= 11;
  }
  hline(c, ML, MR, iy - 2);

  // ── Coverage table ────────────────────────────────────────────────────────────
  // Column x positions
  const colType   = ML;
  const colInsr   = ML + 160;
  const colPol    = ML + 185;
  const colEff    = ML + 305;
  const colExp    = ML + 360;
  const colLimits = ML + 415;
  const colAI     = MR  - 28;

  const hdrY = iy - 4;
  label(c, 'TYPE OF INSURANCE', colType + 1, hdrY, 5.5, bold);
  label(c, 'INSR', colInsr + 1, hdrY, 5.5, bold);
  label(c, 'POLICY NUMBER', colPol + 1, hdrY, 5.5, bold);
  label(c, 'EFFECTIVE', colEff + 1, hdrY, 5.5, bold);
  label(c, 'EXPIRATION', colExp + 1, hdrY, 5.5, bold);
  label(c, 'LIMITS', colLimits + 1, hdrY, 5.5, bold);
  label(c, "ADD'L INSRD", colAI - 10, hdrY, 5, bold);
  hline(c, ML, MR, hdrY - 2);

  let py = hdrY - 14;
  for (const p of v.coi_policies) {
    // Absent coverage (blank policy_number): omit entirely — no header, no data row.
    // The description of operations carries any exemption claim.
    if (!p.policy_number) continue;

    // Coverage type header row
    label(c, coverageLabel(p.coverage_type), colType + 1, py, 6, bold);
    py -= 10;

    // Data row
    if (p.policy_number) {
      label(c, p.insurer_letter, colInsr + 1, py, 7, reg);
      label(c, p.policy_number, colPol + 1, py, 7, reg);
      label(c, p.effective, colEff + 1, py, 7, reg);
      label(c, p.expiration, colExp + 1, py, 7, reg);

      if (p.wc_limits) {
        // Three separately-labeled WC sub-limit rows so Vision can extract each field
        label(c, `E.L. EACH ACCIDENT: ${p.wc_limits.el_each_accident}`, colLimits + 1, py, 5.5, reg);
        py -= 9;
        label(c, `E.L. DISEASE - EA EMPLOYEE: ${p.wc_limits.el_disease_each_employee}`, colLimits + 1, py, 5.5, reg);
        py -= 9;
        label(c, `E.L. DISEASE - POLICY LIMIT: ${p.wc_limits.el_disease_policy_limit}`, colLimits + 1, py, 5.5, reg);
        py -= 5;
      } else {
        label(c, p.limits, colLimits + 1, py, 6.5, reg);
        // ADD'L INSRD checkbox only on GL / Auto / Umbrella rows
        if (p.additional_insured !== null) {
          checkbox(c, colAI, py - 2, p.additional_insured);
        }
      }
    }
    py -= 14;
  }
  hline(c, ML, MR, py - 2);

  // ── Description of Operations ─────────────────────────────────────────────────
  const descY = py - 4;
  label(c, 'DESCRIPTION OF OPERATIONS / LOCATIONS / VEHICLES', ML + 1, descY, 6, bold);
  // word-wrap description into ~90-char lines
  const words = v.coi_description_of_ops.split(' ');
  let line = '';
  let lineY = descY - 11;
  for (const word of words) {
    if ((line + ' ' + word).length > 100) {
      label(c, line.trim(), ML + 2, lineY, 7, reg);
      lineY -= 10;
      line = word;
    } else {
      line += (line ? ' ' : '') + word;
    }
  }
  if (line) label(c, line.trim(), ML + 2, lineY, 7, reg);
  const descBottom = Math.min(lineY - 6, 170);
  hline(c, ML, MR, descBottom);

  // ── Certificate Holder / Cancellation ────────────────────────────────────────
  const holderMid = ML + W * 0.45;
  vline(c, holderMid, 90, descBottom);
  hline(c, ML, MR, 90);

  label(c, 'CERTIFICATE HOLDER', ML + 2, descBottom - 10, 6, bold);
  // ★ The money line — cert_holder printed in content stream, not AcroForm
  label(c, v.coi_cert_holder, ML + 2, descBottom - 22, 8, bold);
  label(c, v.coi_cert_holder_addr.split(', ').slice(0, 2).join(', '), ML + 2, descBottom - 32, 7, reg);
  label(c, v.coi_cert_holder_addr.split(', ').slice(2).join(', '), ML + 2, descBottom - 41, 7, reg);

  label(c, 'CANCELLATION', holderMid + 2, descBottom - 10, 6, bold);
  label(c, 'SHOULD ANY OF THE ABOVE DESCRIBED POLICIES BE CANCELLED', holderMid + 2, descBottom - 20, 5.5, reg);
  label(c, 'BEFORE THE EXPIRATION DATE THEREOF, NOTICE WILL BE', holderMid + 2, descBottom - 27, 5.5, reg);
  label(c, 'DELIVERED IN ACCORDANCE WITH THE POLICY PROVISIONS.', holderMid + 2, descBottom - 34, 5.5, reg);
  label(c, 'AUTHORIZED REPRESENTATIVE', holderMid + 2, descBottom - 50, 6, bold);

  // ── Footer ────────────────────────────────────────────────────────────────────
  label(c, 'ACORD 25 (2016/03)  © 1988-2016 ACORD CORPORATION. All rights reserved.', ML, 82, 5.5, reg, GRAY);

  return doc.save();
}

// ── W-9 generator ─────────────────────────────────────────────────────────────

async function generateW9(v: VendorData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: DrawCtx = { page, reg, bold, W: 612, H: 792 };

  const ML = 36; const MR = 576;

  // ── Header ────────────────────────────────────────────────────────────────────
  label(c, 'Form W-9', ML, 774, 14, bold);
  label(c, "(Rev. October 2018)  Department of the Treasury — Internal Revenue Service", ML, 760, 7, reg);
  label(c, "Request for Taxpayer Identification Number and Certification", ML + 180, 774, 9, bold);
  hline(c, ML, MR, 750);

  let y = 738;

  // ── Line 1: Legal name ────────────────────────────────────────────────────────
  label(c, '1  Name (as shown on your income tax return). Name is required on this line; do not leave this line blank.', ML, y, 6.5, reg);
  y -= 13;
  box(c, ML, y, MR - ML, 14);
  label(c, v.w9_legal_name, ML + 3, y + 4, 9, bold);
  y -= 18;

  // ── Line 2: Business name ─────────────────────────────────────────────────────
  label(c, '2  Business name/disregarded entity name, if different from above', ML, y, 6.5, reg);
  y -= 13;
  box(c, ML, y, MR - ML, 14);
  if (v.w9_business_name) label(c, v.w9_business_name, ML + 3, y + 4, 9, reg);
  y -= 20;

  // ── Line 3: Federal tax classification ────────────────────────────────────────
  label(c, '3  Check appropriate box for federal tax classification of the person whose name is entered on line 1.', ML, y, 6.5, reg);
  y -= 14;

  const classifications = [
    'Individual/sole proprietor',
    'C Corporation',
    'S Corporation',
    'Partnership',
    'Trust/estate',
    'Limited liability company',
  ];
  const llcNote = '  Tax classification (C=C corp, S=S corp, P=Partnership):';

  for (const cls of classifications) {
    const isLLC = cls === 'Limited liability company';
    const isSoleOrIndividual = v.w9_classification.toLowerCase().includes('individual') || v.w9_classification.toLowerCase().includes('sole');
    const isChecked = v.w9_classification.toLowerCase().includes(cls.toLowerCase());

    checkbox(c, ML, y, isChecked);
    label(c, cls, ML + 10, y + 1, 7, reg);
    if (isLLC && isChecked) {
      label(c, llcNote, ML + 10 + 105, y + 1, 7, reg);
      const tcLetter = v.w9_classification.includes('S') ? 'S' : v.w9_classification.includes('C') ? 'C' : 'P';
      label(c, tcLetter, ML + 10 + 105 + (llcNote.length * 3.5), y + 1, 8, bold);
    }
    y -= 12;
  }
  y -= 4;
  hline(c, ML, MR, y);
  y -= 14;

  // ── Line 5/6: Address ─────────────────────────────────────────────────────────
  label(c, '5  Address (number, street, and apt. or suite no.) — See instructions', ML, y, 6.5, reg);
  y -= 13;
  box(c, ML, y, MR - ML, 14);
  const addrParts = v.w9_address.split(', ');
  label(c, addrParts.slice(0, 2).join(', '), ML + 3, y + 4, 8, reg);
  y -= 18;
  label(c, '6  City, state, and ZIP code', ML, y, 6.5, reg);
  y -= 13;
  box(c, ML, y, MR - ML, 14);
  label(c, addrParts.slice(2).join(', '), ML + 3, y + 4, 8, reg);
  y -= 22;
  hline(c, ML, MR, y);
  y -= 18;

  // ── Part I: TIN ───────────────────────────────────────────────────────────────
  label(c, 'Part I', ML, y, 10, bold);
  label(c, '  Taxpayer Identification Number (TIN)', ML + 40, y, 8, reg);
  y -= 14;
  label(c, v.w9_tin_type === 'SSN'
    ? 'Social security number (SSN)'
    : 'Employer identification number (EIN)',
    ML, y, 7, bold);
  y -= 13;

  // TIN boxes
  if (v.w9_tin_type === 'SSN') {
    // SSN format: XXX - XX - XXXX
    const parts = v.w9_tin.split('-');
    let tx = ML;
    for (let i = 0; i < (parts[0]?.length ?? 3); i++) { box(c, tx, y, 16, 18); tx += 16; }
    label(c, '—', tx, y + 6, 9, reg); tx += 12;
    for (let i = 0; i < (parts[1]?.length ?? 2); i++) { box(c, tx, y, 16, 18); tx += 16; }
    label(c, '—', tx, y + 6, 9, reg); tx += 12;
    for (let i = 0; i < (parts[2]?.length ?? 4); i++) { box(c, tx, y, 16, 18); tx += 16; }
    // print digits
    const digits = v.w9_tin.replace(/-/g, '');
    let dx = ML;
    for (let i = 0; i < digits.length; i++) {
      if (i === 3 || i === 5) dx += 12;  // skip separators
      label(c, digits[i], dx + 5, y + 6, 9, bold);
      dx += 16;
    }
  } else {
    // EIN format: XX - XXXXXXX
    const parts = v.w9_tin.split('-');
    let tx = ML;
    for (let i = 0; i < (parts[0]?.length ?? 2); i++) { box(c, tx, y, 16, 18); tx += 16; }
    label(c, '—', tx, y + 6, 9, reg); tx += 12;
    for (let i = 0; i < (parts[1]?.length ?? 7); i++) { box(c, tx, y, 16, 18); tx += 16; }
    // print digits
    const digits = v.w9_tin.replace(/-/g, '');
    let dx = ML;
    for (let i = 0; i < digits.length; i++) {
      if (i === (parts[0]?.length ?? 2)) dx += 12;
      label(c, digits[i], dx + 5, y + 6, 9, bold);
      dx += 16;
    }
  }
  y -= 28;
  hline(c, ML, MR, y);
  y -= 18;

  // ── Part II: Certification ────────────────────────────────────────────────────
  label(c, 'Part II', ML, y, 10, bold);
  label(c, '  Certification', ML + 40, y, 8, reg);
  y -= 14;
  const certText = 'Under penalties of perjury, I certify that: (1) The number shown on this form is my correct taxpayer identification number, and (2) I am not subject to backup withholding.';
  label(c, certText, ML, y, 6.5, reg);
  y -= 26;
  label(c, 'Signature of U.S. person:', ML, y, 7, reg);
  hline(c, ML + 110, MR - 80, y);
  label(c, `Date: ${v.coi_date}`, MR - 75, y, 7, reg);
  y -= 18;

  // ── Footer ────────────────────────────────────────────────────────────────────
  label(c, 'Form W-9 (Rev. 10-2018)  Cat. No. 10231X', ML, 50, 6, reg, GRAY);
  label(c, 'www.irs.gov/FormW9', MR - 80, 50, 6, reg, GRAY);

  return doc.save();
}

// ── ACH generator ─────────────────────────────────────────────────────────────

async function generateACH(v: VendorData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: DrawCtx = { page, reg, bold, W: 612, H: 792 };

  const ML = 36; const MR = 576;

  // ── Header ────────────────────────────────────────────────────────────────────
  label(c, 'DIRECT DEPOSIT AUTHORIZATION', ML, 758, 14, bold);
  label(c, 'ACH / Electronic Funds Transfer Authorization Form', ML, 742, 8, reg);
  hline(c, ML, MR, 736);

  let y = 720;

  // ── Account holder ────────────────────────────────────────────────────────────
  label(c, 'ACCOUNT HOLDER / PAYEE NAME', ML, y, 6.5, bold);
  y -= 13;
  box(c, ML, y, MR - ML, 16);
  label(c, v.ach_holder, ML + 3, y + 5, 10, bold);
  y -= 22;

  // ── Bank info ─────────────────────────────────────────────────────────────────
  label(c, 'FINANCIAL INSTITUTION (BANK NAME)', ML, y, 6.5, bold);
  y -= 13;
  box(c, ML, y, MR - ML, 16);
  label(c, v.ach_bank, ML + 3, y + 5, 10, reg);
  y -= 26;

  // ── Routing number ────────────────────────────────────────────────────────────
  label(c, 'ABA ROUTING NUMBER  (9 digits)', ML, y, 6.5, bold);
  y -= 13;
  const routingBoxW = (MR - ML - 10) / 2;
  box(c, ML, y, routingBoxW, 18);
  label(c, v.ach_routing, ML + 6, y + 6, 11, bold);
  y -= 26;

  // ── Account number ────────────────────────────────────────────────────────────
  label(c, 'ACCOUNT NUMBER', ML, y, 6.5, bold);
  y -= 13;
  box(c, ML, y, routingBoxW, 18);
  label(c, v.ach_account, ML + 6, y + 6, 11, bold);
  y -= 26;

  // ── Account type ─────────────────────────────────────────────────────────────
  label(c, 'ACCOUNT TYPE', ML, y, 6.5, bold);
  y -= 14;
  checkbox(c, ML, y, v.ach_type === 'Checking');
  label(c, 'Checking', ML + 12, y + 1, 8, reg);
  checkbox(c, ML + 80, y, v.ach_type === 'Savings');
  label(c, 'Savings', ML + 92, y + 1, 8, reg);
  y -= 22;
  hline(c, ML, MR, y);
  y -= 18;

  // ── Authorization ─────────────────────────────────────────────────────────────
  label(c, 'AUTHORIZATION', ML, y, 8, bold);
  y -= 14;
  const authText = 'I authorize the above-named company to initiate credit entries to my account at the financial institution named above. I certify that the information provided is accurate.';
  const authWords = authText.split(' ');
  let line = '';
  for (const word of authWords) {
    if ((line + ' ' + word).length > 95) {
      label(c, line.trim(), ML, y, 7, reg);
      y -= 10;
      line = word;
    } else {
      line += (line ? ' ' : '') + word;
    }
  }
  if (line) { label(c, line.trim(), ML, y, 7, reg); y -= 10; }
  y -= 12;

  // ── Signature ────────────────────────────────────────────────────────────────
  label(c, 'Authorized Signature:', ML, y, 7, reg);
  hline(c, ML + 95, MR - 100, y);
  label(c, `Date: ${v.coi_date}`, MR - 95, y, 7, reg);
  y -= 16;
  label(c, 'Printed Name:', ML, y, 7, reg);
  hline(c, ML + 65, MR - 100, y);
  y -= 16;
  label(c, 'Title:', ML, y, 7, reg);
  hline(c, ML + 30, MR - 100, y);

  // ── Footer ────────────────────────────────────────────────────────────────────
  label(c, 'ACH Direct Deposit Authorization  |  Retain a copy for your records', ML, 50, 6, reg, GRAY);

  return doc.save();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const fixturesBase = path.join(__dirname, '..', 'test-fixtures', 'vendors');

  console.log('Generating fixtures...\n');

  for (const v of VENDORS) {
    const dir = path.join(fixturesBase, v.fixture_dir);
    fs.mkdirSync(dir, { recursive: true });

    // Derive filename prefix from display name
    const slug = v.coi_named_insured
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');

    // Use the fixture_dir slug for consistent filenames regardless of COI named_insured
    const fileSlug = v.fixture_dir.split(' ')[0];

    const coiPath  = path.join(dir, `${fileSlug}_ACORD25_COI.pdf`);
    const w9Path   = path.join(dir, `${fileSlug}_W9.pdf`);
    const achPath  = path.join(dir, `${fileSlug}_ACH_DirectDeposit.pdf`);

    const coiBytes = await generateCOI(v);
    const w9Bytes  = await generateW9(v);
    const achBytes = await generateACH(v);

    fs.writeFileSync(coiPath,  coiBytes);
    fs.writeFileSync(w9Path,   w9Bytes);
    fs.writeFileSync(achPath,  achBytes);

    console.log(`  ✓  ${v.fixture_dir}`);
    console.log(`       COI  ${path.basename(coiPath)}  (${(coiBytes.length / 1024).toFixed(1)} KB)`);
    console.log(`       W-9  ${path.basename(w9Path)}  (${(w9Bytes.length / 1024).toFixed(1)} KB)`);
    console.log(`       ACH  ${path.basename(achPath)}  (${(achBytes.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`\nDone. ${VENDORS.length * 3} PDFs written to ${fixturesBase}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
