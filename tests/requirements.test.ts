import { randomUUID } from 'crypto';
import {
  computeRequirements,
  resolveRequirements,
  isStricter,
  type RuleRow,
} from '@/lib/requirements/resolver';
import {
  getRequirements,
  setRequirementRule,
  getPrecedence,
  setPrecedence,
} from '@/lib/services/requirements';
import { applyTemplate, seedTemplates } from '@/lib/requirements/templates';
import {
  setupTestDb,
  seedTenant,
  seedTenantUser,
  seedLocation,
  seedRequirementSettings,
  seedRequirementRule,
  seedTemplate,
} from './helpers';

// ─── isStricter ───────────────────────────────────────────────────────────────

describe('isStricter', () => {
  test('numeric: higher number is stricter', () => {
    expect(isStricter('2000000', '1000000')).toBe(true);
    expect(isStricter('1000000', '2000000')).toBe(false);
    expect(isStricter('1000000', '1000000')).toBe(false);
  });

  test('boolean: true is stricter than false', () => {
    expect(isStricter('true', 'false')).toBe(true);
    expect(isStricter('false', 'true')).toBe(false);
    expect(isStricter('true', 'true')).toBe(false);
  });

  test('same value is not stricter', () => {
    expect(isStricter('500000', '500000')).toBe(false);
    expect(isStricter('false', 'false')).toBe(false);
  });
});

// ─── computeRequirements (pure) ────────────────────────────────────────────────

const orgRule = (key: string, value: string, id = randomUUID()): RuleRow => ({
  id, scope_type: 'org', scope_ref: null, requirement_key: key, required_value: value,
});
const tradeRule = (key: string, value: string, trade: string, id = randomUUID()): RuleRow => ({
  id, scope_type: 'trade', scope_ref: trade, requirement_key: key, required_value: value,
});
const locRule = (key: string, value: string, locationId: string, id = randomUUID()): RuleRow => ({
  id, scope_type: 'location', scope_ref: locationId, requirement_key: key, required_value: value,
});

describe('computeRequirements — no overrides', () => {
  test('org-only rule is returned as-is', () => {
    const id = randomUUID();
    const result = computeRequirements([orgRule('coverage.gl.each_occurrence', '1000000', id)], [], [], {}, 'strictest');
    expect(result['coverage.gl.each_occurrence']).toEqual({ required_value: '1000000', scope: 'org', rule_id: id });
  });

  test('returns empty matrix when no rules and no floor', () => {
    expect(computeRequirements([], [], [], {}, 'strictest')).toEqual({});
  });

  test('missing key is absent from matrix', () => {
    const result = computeRequirements([orgRule('coverage.gl.each_occurrence', '1000000')], [], [], {}, 'strictest');
    expect(result['other.key']).toBeUndefined();
  });
});

describe('computeRequirements — trade overrides', () => {
  test('trade override replaces org for that key', () => {
    const tId = randomUUID();
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '1000000')],
      [tradeRule('coverage.gl.each_occurrence', '2000000', 'roofing', tId)],
      [], {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toEqual({ required_value: '2000000', scope: 'trade', rule_id: tId });
  });

  test('trade override can introduce a key not in org', () => {
    const result = computeRequirements(
      [],
      [tradeRule('coverage_required.professional_liability', 'true', 'electrical')],
      [], {}, 'strictest'
    );
    expect(result['coverage_required.professional_liability']).toMatchObject({ scope: 'trade', required_value: 'true' });
  });
});

describe('computeRequirements — location overrides', () => {
  test('location override replaces org for that key', () => {
    const lId = randomUUID();
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '1000000')],
      [],
      [locRule('coverage.gl.each_occurrence', '3000000', 'loc-1', lId)],
      {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toEqual({ required_value: '3000000', scope: 'location', rule_id: lId });
  });

  test('location override can introduce a key not in org', () => {
    const result = computeRequirements(
      [],
      [],
      [locRule('endorsement.primary_noncontributory', 'true', 'loc-1')],
      {}, 'strictest'
    );
    expect(result['endorsement.primary_noncontributory']).toMatchObject({ scope: 'location', required_value: 'true' });
  });
});

describe('computeRequirements — precedence=strictest', () => {
  test('location wins when location is stricter than trade', () => {
    const lId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('coverage.gl.each_occurrence', '2000000', 'roofing')],
      [locRule('coverage.gl.each_occurrence', '3000000', 'loc-1', lId)],
      {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '3000000', scope: 'location', rule_id: lId });
  });

  test('trade wins when trade is stricter than location', () => {
    const tId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('coverage.gl.each_occurrence', '5000000', 'roofing', tId)],
      [locRule('coverage.gl.each_occurrence', '2000000', 'loc-1')],
      {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '5000000', scope: 'trade', rule_id: tId });
  });

  test('boolean strictness: true beats false', () => {
    const lId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('endorsement.waiver_of_subrogation', 'false', 'roofing')],
      [locRule('endorsement.waiver_of_subrogation', 'true', 'loc-1', lId)],
      {}, 'strictest'
    );
    expect(result['endorsement.waiver_of_subrogation']).toMatchObject({ required_value: 'true', scope: 'location' });
  });

  test('equal values: location wins as tiebreaker', () => {
    const lId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('coverage.gl.each_occurrence', '1000000', 'roofing')],
      [locRule('coverage.gl.each_occurrence', '1000000', 'loc-1', lId)],
      {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ scope: 'location', rule_id: lId });
  });
});

describe('computeRequirements — precedence=location', () => {
  test('location always wins, even when less strict', () => {
    const lId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('coverage.gl.each_occurrence', '5000000', 'roofing')],
      [locRule('coverage.gl.each_occurrence', '500000', 'loc-1', lId)],
      {}, 'location'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '500000', scope: 'location', rule_id: lId });
  });
});

describe('computeRequirements — precedence=trade', () => {
  test('trade always wins, even when less strict', () => {
    const tId = randomUUID();
    const result = computeRequirements(
      [],
      [tradeRule('coverage.gl.each_occurrence', '200000', 'roofing', tId)],
      [locRule('coverage.gl.each_occurrence', '3000000', 'loc-1')],
      {}, 'trade'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '200000', scope: 'trade', rule_id: tId });
  });
});

describe('computeRequirements — floor enforcement', () => {
  test('floor provides value when no rules exist for a key', () => {
    const result = computeRequirements([], [], [], { 'doc_required.coi': 'true' }, 'strictest');
    expect(result['doc_required.coi']).toEqual({ required_value: 'true', scope: 'floor', rule_id: null });
  });

  test('floor clamps a resolved value that falls below it', () => {
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '100000')],
      [], [],
      { 'coverage.gl.each_occurrence': '500000' },
      'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toEqual({ required_value: '500000', scope: 'floor', rule_id: null });
  });

  test('floor does not clamp a value that meets or exceeds it', () => {
    const id = randomUUID();
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '2000000', id)],
      [], [],
      { 'coverage.gl.each_occurrence': '500000' },
      'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '2000000', scope: 'org', rule_id: id });
  });

  test('floor clamps even when trade wins over org but is still below floor', () => {
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '200000')],
      [tradeRule('coverage.gl.each_occurrence', '300000', 'roofing')],
      [],
      { 'coverage.gl.each_occurrence': '500000' },
      'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toEqual({ required_value: '500000', scope: 'floor', rule_id: null });
  });

  test('multiple floor keys all appear in matrix when no rules', () => {
    const floor = { 'doc_required.coi': 'true', 'endorsement.additional_insured': 'true' };
    const result = computeRequirements([], [], [], floor, 'strictest');
    expect(result['doc_required.coi']).toMatchObject({ scope: 'floor' });
    expect(result['endorsement.additional_insured']).toMatchObject({ scope: 'floor' });
  });
});

describe('computeRequirements — latest-per-key deduplication', () => {
  test('when multiple org rows for same key, first (newest) row wins', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    // Rules are passed newest-first (as the DB query returns them)
    const result = computeRequirements(
      [
        { id: id1, scope_type: 'org', scope_ref: null, requirement_key: 'coverage.gl.each_occurrence', required_value: '2000000' },
        { id: id2, scope_type: 'org', scope_ref: null, requirement_key: 'coverage.gl.each_occurrence', required_value: '1000000' },
      ],
      [], [], {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '2000000', rule_id: id1 });
  });
});

describe('computeRequirements — all three scopes', () => {
  test('all three scopes present — org + trade + location', () => {
    const oId = randomUUID();
    const tId = randomUUID();
    const lId = randomUUID();
    // Different keys so they don't conflict; shows all three scopes can contribute
    const result = computeRequirements(
      [orgRule('coverage.gl.each_occurrence', '1000000', oId)],
      [tradeRule('coverage.gl.general_aggregate', '4000000', 'roofing', tId)],
      [locRule('endorsement.additional_insured', 'true', 'loc-1', lId)],
      {}, 'strictest'
    );
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ scope: 'org', rule_id: oId });
    expect(result['coverage.gl.general_aggregate']).toMatchObject({ scope: 'trade', rule_id: tId });
    expect(result['endorsement.additional_insured']).toMatchObject({ scope: 'location', rule_id: lId });
  });
});

// ─── resolveRequirements (DB-backed) ──────────────────────────────────────────

describe('resolveRequirements (DB-backed)', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;
  let loc: ReturnType<typeof seedLocation>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    loc = seedLocation(db, tenant.id);
    seedRequirementSettings(db, tenant.id, { precedence_policy: 'strictest' });
  });
  afterEach(() => db.close());

  test('returns empty matrix when no rules', () => {
    const result = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('org rules are resolved', () => {
    seedRequirementRule(db, tenant.id, admin.id, { requirement_key: 'coverage.gl.each_occurrence', required_value: '1000000' });
    const result = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '1000000', scope: 'org' });
  });

  test('trade rules apply only for matching trade', () => {
    seedRequirementRule(db, tenant.id, admin.id, {
      scope_type: 'trade', scope_ref: 'roofing',
      requirement_key: 'coverage.gl.each_occurrence', required_value: '5000000',
    });
    const resultRoofing = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'roofing', locationId: loc.id, precedence: 'strictest' });
    const resultPlumbing = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    expect(resultRoofing['coverage.gl.each_occurrence']).toMatchObject({ required_value: '5000000', scope: 'trade' });
    expect(resultPlumbing['coverage.gl.each_occurrence']).toBeUndefined();
  });

  test('location rules apply only for matching location', () => {
    const loc2 = seedLocation(db, tenant.id, { name: 'Second Store' });
    seedRequirementRule(db, tenant.id, admin.id, {
      scope_type: 'location', scope_ref: loc.id,
      requirement_key: 'endorsement.additional_insured', required_value: 'true',
    });
    const resultLoc1 = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    const resultLoc2 = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc2.id, precedence: 'strictest' });
    expect(resultLoc1['endorsement.additional_insured']).toMatchObject({ scope: 'location' });
    expect(resultLoc2['endorsement.additional_insured']).toBeUndefined();
  });

  test('floor from requirement_settings is applied', () => {
    seedRequirementSettings(db, tenant.id, {
      floor_json: JSON.stringify({ 'coverage.gl.each_occurrence': '500000' }),
    });
    // No rules — floor provides the value
    const result = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '500000', scope: 'floor' });
  });

  test('archived location still resolves (location rules are scope-ref matched, not status-checked)', () => {
    const archived = seedLocation(db, tenant.id, { name: 'Archived Store', status: 'archived' });
    seedRequirementRule(db, tenant.id, admin.id, {
      scope_type: 'location', scope_ref: archived.id,
      requirement_key: 'coverage.gl.each_occurrence', required_value: '2000000',
    });
    const result = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: archived.id, precedence: 'strictest' });
    expect(result['coverage.gl.each_occurrence']).toMatchObject({ required_value: '2000000', scope: 'location' });
  });

  test('isolates rules by tenant', () => {
    const otherTenant = seedTenant(db, { id: randomUUID(), name: 'Other Tenant' });
    const otherAdmin = seedTenantUser(db, otherTenant.id, { email: 'other@example.com' });
    seedRequirementRule(db, otherTenant.id, otherAdmin.id, {
      requirement_key: 'coverage.gl.each_occurrence', required_value: '9999999',
    });
    const result = resolveRequirements(db, { tenantId: tenant.id, vendorTrade: 'plumbing', locationId: loc.id, precedence: 'strictest' });
    expect(result['coverage.gl.each_occurrence']).toBeUndefined();
  });
});

// ─── getRequirements service ──────────────────────────────────────────────────

describe('getRequirements', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    seedRequirementSettings(db, tenant.id);
  });
  afterEach(() => db.close());

  test('returns layered rules grouped by scope', () => {
    const loc = seedLocation(db, tenant.id);
    seedRequirementRule(db, tenant.id, admin.id, { scope_type: 'org', requirement_key: 'doc_required.coi', required_value: 'true' });
    seedRequirementRule(db, tenant.id, admin.id, { scope_type: 'trade', scope_ref: 'plumbing', requirement_key: 'coverage.gl.each_occurrence', required_value: '2000000' });
    seedRequirementRule(db, tenant.id, admin.id, { scope_type: 'location', scope_ref: loc.id, requirement_key: 'endorsement.additional_insured', required_value: 'true' });

    const { rules, precedence } = getRequirements(db, tenant.id);
    expect(rules.org).toHaveLength(1);
    expect(rules.trade).toHaveLength(1);
    expect(rules.location).toHaveLength(1);
    expect(precedence).toBe('strictest');
  });

  test('dedups to current rules only when key changed multiple times', () => {
    seedRequirementRule(db, tenant.id, admin.id, { requirement_key: 'coverage.gl.each_occurrence', required_value: '1000000' });
    // Add a newer row for same key
    db.prepare(
      `INSERT INTO requirement_rules (id, tenant_id, scope_type, scope_ref, requirement_key, required_value, created_by, reason, created_at)
       VALUES (?, ?, 'org', NULL, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), tenant.id, 'coverage.gl.each_occurrence', '2000000', admin.id, 'Raise', new Date(Date.now() + 1000).toISOString());

    const { rules } = getRequirements(db, tenant.id);
    expect(rules.org).toHaveLength(1);
    expect(rules.org[0].required_value).toBe('2000000');
  });
});

// ─── setRequirementRule service ───────────────────────────────────────────────

describe('setRequirementRule', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    seedRequirementSettings(db, tenant.id);
  });
  afterEach(() => db.close());

  test('creates an org rule', async () => {
    const rule = await setRequirementRule(db, tenant.id, {
      scope: 'org', scope_ref: null,
      requirement_key: 'coverage.gl.each_occurrence',
      required_value: '1000000',
      reason: 'Initial setup',
    }, admin.id);
    expect(rule.scope_type).toBe('org');
    expect(rule.required_value).toBe('1000000');
  });

  test('logs audit event with old and new values', async () => {
    seedRequirementRule(db, tenant.id, admin.id, { requirement_key: 'coverage.gl.each_occurrence', required_value: '1000000' });
    await setRequirementRule(db, tenant.id, {
      scope: 'org', scope_ref: null,
      requirement_key: 'coverage.gl.each_occurrence',
      required_value: '2000000',
      reason: 'Raising limit',
    }, admin.id);

    const event = db.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'requirement.rule_changed' ORDER BY created_at DESC LIMIT 1").get() as { payload_json: string } | undefined;
    expect(event).toBeTruthy();
    const payload = JSON.parse(event!.payload_json);
    expect(payload.old_value).toBe('1000000');
    expect(payload.new_value).toBe('2000000');
    expect(payload.reason).toBe('Raising limit');
  });

  test('rejects if value is below floor', async () => {
    seedRequirementSettings(db, tenant.id, {
      floor_json: JSON.stringify({ 'coverage.gl.each_occurrence': '500000' }),
    });
    await expect(
      setRequirementRule(db, tenant.id, {
        scope: 'org', scope_ref: null,
        requirement_key: 'coverage.gl.each_occurrence',
        required_value: '100000',
        reason: 'Should fail',
      }, admin.id)
    ).rejects.toMatchObject({ status: 422 });
  });

  test('rejects invalid trade in scope_ref', async () => {
    await expect(
      setRequirementRule(db, tenant.id, {
        scope: 'trade', scope_ref: 'not_a_valid_trade',
        requirement_key: 'coverage.gl.each_occurrence',
        required_value: '2000000',
        reason: 'Test',
      }, admin.id)
    ).rejects.toMatchObject({ status: 400 });
  });

  test('rejects location scope_ref that does not exist', async () => {
    await expect(
      setRequirementRule(db, tenant.id, {
        scope: 'location', scope_ref: 'nonexistent-loc-id',
        requirement_key: 'coverage.gl.each_occurrence',
        required_value: '2000000',
        reason: 'Test',
      }, admin.id)
    ).rejects.toMatchObject({ status: 404 });
  });

  test('accepts valid location scope_ref', async () => {
    const loc = seedLocation(db, tenant.id);
    const rule = await setRequirementRule(db, tenant.id, {
      scope: 'location', scope_ref: loc.id,
      requirement_key: 'endorsement.additional_insured',
      required_value: 'true',
      reason: 'Spokane extra requirement',
    }, admin.id);
    expect(rule.scope_ref).toBe(loc.id);
    expect(rule.scope_type).toBe('location');
  });

  test('creates rule for valid trade', async () => {
    const rule = await setRequirementRule(db, tenant.id, {
      scope: 'trade', scope_ref: 'roofing',
      requirement_key: 'coverage.gl.each_occurrence',
      required_value: '5000000',
      reason: 'Roofers need more coverage',
    }, admin.id);
    expect(rule.scope_ref).toBe('roofing');
  });
});

// ─── precedence ───────────────────────────────────────────────────────────────

describe('getPrecedence / setPrecedence', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    seedRequirementSettings(db, tenant.id);
  });
  afterEach(() => db.close());

  test('defaults to strictest', () => {
    expect(getPrecedence(db, tenant.id)).toBe('strictest');
  });

  test('setPrecedence updates the policy', () => {
    setPrecedence(db, tenant.id, 'location', admin.id);
    expect(getPrecedence(db, tenant.id)).toBe('location');
  });

  test('setPrecedence logs audit event', () => {
    setPrecedence(db, tenant.id, 'trade', admin.id);
    const event = db.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'requirement.precedence_changed'").get() as { payload_json: string } | undefined;
    expect(event).toBeTruthy();
    const payload = JSON.parse(event!.payload_json);
    expect(payload.old_policy).toBe('strictest');
    expect(payload.new_policy).toBe('trade');
  });

  test('setPrecedence works even when no requirement_settings row exists yet', () => {
    const tenant2 = seedTenant(db, { id: randomUUID(), name: 'T2' });
    const admin2 = seedTenantUser(db, tenant2.id, { email: 'a2@x.com' });
    // No seedRequirementSettings for tenant2
    setPrecedence(db, tenant2.id, 'location', admin2.id);
    expect(getPrecedence(db, tenant2.id)).toBe('location');
  });
});

// ─── template seeding and applyTemplate ───────────────────────────────────────

describe('seedTemplates', () => {
  let db: ReturnType<typeof setupTestDb>;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(() => db.close());

  test('inserts platform templates', () => {
    seedTemplates(db);
    const rows = db.prepare('SELECT id, name FROM requirement_templates ORDER BY name').all() as { id: string; name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map(r => r.name)).toContain('Standard Self-Storage');
    expect(rows.map(r => r.name)).toContain('Premium Self-Storage');
  });

  test('is idempotent — safe to call multiple times', () => {
    seedTemplates(db);
    seedTemplates(db);
    const rows = db.prepare('SELECT id FROM requirement_templates').all();
    const count = rows.length;
    seedTemplates(db);
    expect((db.prepare('SELECT id FROM requirement_templates').all()).length).toBe(count);
  });
});

describe('applyTemplate', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
    seedTemplates(db);
  });
  afterEach(() => db.close());

  test('seeds org-level rules from template defaults', () => {
    applyTemplate(db, tenant.id, 'tpl_standard_self_storage', admin.id);
    const rules = db.prepare(
      "SELECT requirement_key, required_value FROM requirement_rules WHERE tenant_id = ? AND scope_type = 'org'"
    ).all(tenant.id) as { requirement_key: string; required_value: string }[];
    expect(rules.length).toBeGreaterThan(0);
    const keys = rules.map(r => r.requirement_key);
    expect(keys).toContain('doc_required.coi');
    expect(keys).toContain('coverage.general_liability.each_occurrence');
  });

  test('stores floor in requirement_settings', () => {
    applyTemplate(db, tenant.id, 'tpl_standard_self_storage', admin.id);
    const settings = db.prepare('SELECT floor_json FROM requirement_settings WHERE tenant_id = ?').get(tenant.id) as { floor_json: string } | undefined;
    expect(settings?.floor_json).toBeTruthy();
    const floor = JSON.parse(settings!.floor_json);
    expect(floor['doc_required.coi']).toBe('true');
  });

  test('records applied_template_id on tenant', () => {
    applyTemplate(db, tenant.id, 'tpl_standard_self_storage', admin.id);
    const t = db.prepare('SELECT applied_template_id FROM tenants WHERE id = ?').get(tenant.id) as { applied_template_id: string } | undefined;
    expect(t?.applied_template_id).toBe('tpl_standard_self_storage');
  });

  test('throws 404 for unknown template', () => {
    expect(() => applyTemplate(db, tenant.id, 'no-such-template', admin.id))
      .toThrow(expect.objectContaining({ status: 404 }));
  });
});
