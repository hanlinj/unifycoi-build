import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { withTransaction } from '@/lib/db/transaction';
import { logAudit } from '@/lib/audit';
import { parseCSV } from '@/lib/csv';
import type { Scope } from '@/lib/scope';

export interface Location {
  id: string;
  tenant_id: string;
  region_id: string | null;
  name: string;
  address: string | null;
  status: string;
  created_at: string;
}

export interface LocationWithRegion extends Location {
  region_name: string | null;
}

export interface CreateLocationInput {
  name: string;
  address?: string;
  regionId?: string;
}

export interface UpdateLocationInput {
  name?: string;
  address?: string;
  regionId?: string | null;
  status?: 'active' | 'archived';
}

export interface ImportRow {
  rowIndex: number;
  storeName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  region?: string;
  managerFirstName?: string;
  managerLastName?: string;
  managerEmail?: string;
}

export interface ImportResult {
  created: number;
  managersCreated: number;
  managersFound: number;
  failed: number;
  failures: { row: number; reasons: string[] }[];
}

async function recordBillingSnapshot(db: Db, tenantId: string): Promise<void> {
  const tenant = await db.selectFrom('tenants').select('monthly_rate_cents').where('id', '=', tenantId).executeTakeFirst();
  if (!tenant) return;
  const tdb = new TenantDB(db, tenantId);
  const countRow = await tdb.get<{ count: string }>("SELECT COUNT(*) as count FROM locations WHERE tenant_id = $1 AND status = 'active'");
  const count = Number(countRow!.count);
  // seq, not created_at: two locations created in the same millisecond (e.g. provisioning's
  // batch) would tie on the timestamp and resolve arbitrarily; seq (bigserial, Stage 4's
  // rowid replacement — Postgres has no stable implicit row-order id) is a reliable,
  // monotonically-increasing insertion-order tiebreaker (Slice 5a — this flag drives the
  // billing quantity-sync worker's trigger).
  const last = await tdb.get<{ billable_locations: number }>('SELECT billable_locations FROM billing_snapshots WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1');
  const changed = !last || last.billable_locations !== count;
  await tdb.insert('billing_snapshots', {
    id: randomUUID(),
    billable_locations: count,
    amount_cents: count * tenant.monthly_rate_cents,
    changed,
    created_at: new Date(),
  });
}

async function findOrCreateRegion(tdb: TenantDB, regionName: string): Promise<string> {
  // COLLATE NOCASE -> lower() (Stage 0's catalogued rework spot)
  const existing = await tdb.get<{ id: string }>(
    'SELECT id FROM regions WHERE tenant_id = $1 AND lower(name) = lower($2)',
    [regionName]
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await tdb.insert('regions', { id, name: regionName.trim() });
  return id;
}

export async function createLocation(
  db: Db,
  tenantId: string,
  input: CreateLocationInput,
  actorId: string
): Promise<LocationWithRegion> {
  const tdb = new TenantDB(db, tenantId);
  const id = randomUUID();
  const now = new Date();

  await tdb.insert('locations', {
    id,
    region_id: input.regionId ?? null,
    name: input.name.trim(),
    address: input.address ?? null,
    status: 'active',
    created_at: now,
  });

  await recordBillingSnapshot(db, tenantId);

  await logAudit(db, {
    tenantId,
    actorType: 'user',
    actorId,
    eventType: 'location.created',
    targetType: 'location',
    targetId: id,
    payload: { name: input.name },
  });

  return (await getLocationById(db, tenantId, id))!;
}

export async function listLocations(
  db: Db,
  tenantId: string,
  scope: Scope
): Promise<LocationWithRegion[]> {
  const tdb = new TenantDB(db, tenantId);

  if (scope.locationIds === null) {
    return tdb.all<LocationWithRegion>(
      `SELECT l.id, l.tenant_id, l.region_id, l.name, l.address, l.status, l.created_at,
              r.name as region_name
       FROM locations l LEFT JOIN regions r ON r.id = l.region_id
       WHERE l.tenant_id = $1 ORDER BY l.name`
    );
  }

  if (scope.locationIds.length === 0) return [];

  // tenant_id is bound as $1 (TenantDB's contract); locationIds start at $2.
  const placeholders = scope.locationIds.map((_, i) => `$${i + 2}`).join(',');
  return tdb.all<LocationWithRegion>(
    `SELECT l.id, l.tenant_id, l.region_id, l.name, l.address, l.status, l.created_at,
            r.name as region_name
     FROM locations l LEFT JOIN regions r ON r.id = l.region_id
     WHERE l.tenant_id = $1 AND l.id IN (${placeholders})
     ORDER BY l.name`,
    scope.locationIds
  );
}

export async function getLocationById(
  db: Db,
  tenantId: string,
  locationId: string
): Promise<LocationWithRegion | null> {
  const tdb = new TenantDB(db, tenantId);
  const row = await tdb.get<LocationWithRegion>(
    `SELECT l.id, l.tenant_id, l.region_id, l.name, l.address, l.status, l.created_at,
            r.name as region_name
     FROM locations l LEFT JOIN regions r ON r.id = l.region_id
     WHERE l.tenant_id = $1 AND l.id = $2`,
    [locationId]
  );
  return row ?? null;
}

export async function updateLocation(
  db: Db,
  tenantId: string,
  locationId: string,
  input: UpdateLocationInput,
  actorId: string
): Promise<LocationWithRegion> {
  const tdb = new TenantDB(db, tenantId);
  const existing = await tdb.get<Location>('SELECT id, status FROM locations WHERE tenant_id = $1 AND id = $2', [locationId]);
  if (!existing) throw Object.assign(new Error('Location not found'), { status: 404 });

  if (input.name !== undefined) {
    await tdb.update('locations', { name: input.name.trim() }, { id: locationId });
  }
  if (input.address !== undefined) {
    await tdb.update('locations', { address: input.address }, { id: locationId });
  }
  if ('regionId' in input) {
    await tdb.update('locations', { region_id: input.regionId ?? null }, { id: locationId });
  }
  if (input.status !== undefined && input.status !== existing.status) {
    await tdb.update('locations', { status: input.status }, { id: locationId });
    await recordBillingSnapshot(db, tenantId);

    const eventType = input.status === 'archived' ? 'location.archived' : 'location.unarchived';
    await logAudit(db, { tenantId, actorType: 'user', actorId, eventType, targetType: 'location', targetId: locationId });
  } else {
    await logAudit(db, {
      tenantId, actorType: 'user', actorId,
      eventType: 'location.updated', targetType: 'location', targetId: locationId,
      payload: { changes: Object.keys(input) },
    });
  }

  return (await getLocationById(db, tenantId, locationId))!;
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

const US_STATE_ABBREVS: Record<string, string> = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA',
  colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS',
  kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA',
  michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT',
  nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ',
  'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND',
  ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI',
  'south carolina':'SC', 'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT',
  vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV',
  wisconsin:'WI', wyoming:'WY', 'district of columbia':'DC',
};

function normalizeState(s: string): string {
  const lower = s.trim().toLowerCase();
  if (US_STATE_ABBREVS[lower]) return US_STATE_ABBREVS[lower];
  if (/^[A-Za-z]{2}$/.test(s.trim())) return s.trim().toUpperCase();
  return s.trim();
}

function isValidZip(zip: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(zip.trim());
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const HEADER_ALIASES: Record<string, string> = {
  'store name': 'storeName',
  'location name': 'storeName',
  'name': 'storeName',
  'address': 'address',
  'street address': 'address',
  'city': 'city',
  'state': 'state',
  'zip': 'zip',
  'zip code': 'zip',
  'postal code': 'zip',
  'region': 'region',
  'district': 'region',
  'region / district': 'region',
  'region/district': 'region',
  'manager first name': 'managerFirstName',
  'first name': 'managerFirstName',
  'manager last name': 'managerLastName',
  'last name': 'managerLastName',
  'manager email': 'managerEmail',
  'email': 'managerEmail',
};

function mapHeaders(rawHeaders: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of rawHeaders) {
    const key = HEADER_ALIASES[h.trim().toLowerCase()];
    if (key) map[h] = key;
  }
  return map;
}

function validateImportRow(row: Record<string, string>, headerMap: Record<string, string>): { row: Partial<ImportRow>; reasons: string[] } {
  const get = (key: string) => {
    for (const [raw, mapped] of Object.entries(headerMap)) {
      if (mapped === key) return row[raw]?.trim() ?? '';
    }
    return '';
  };

  const reasons: string[] = [];
  const storeName = get('storeName');
  const address = get('address');
  const city = get('city');
  const state = get('state');
  const zip = get('zip');
  const region = get('region');
  const managerFirstName = get('managerFirstName');
  const managerLastName = get('managerLastName');
  const managerEmail = get('managerEmail');

  if (!storeName) reasons.push('Missing required field: Store Name');
  if (!address) reasons.push('Missing required field: Address');
  if (!city) reasons.push('Missing required field: City');
  if (!state) reasons.push('Missing required field: State');
  if (!zip) reasons.push('Missing required field: ZIP');
  else if (!isValidZip(zip)) reasons.push(`Invalid ZIP format: ${zip}`);
  if (managerEmail && !isValidEmail(managerEmail)) reasons.push(`Invalid email: ${managerEmail}`);
  if ((managerFirstName || managerLastName) && !managerEmail) reasons.push('Manager email is required when manager name is provided');

  return {
    row: { storeName, address, city, state, zip, region, managerFirstName, managerLastName, managerEmail },
    reasons,
  };
}

export function parseImportCSV(csvText: string): {
  rows: ImportRow[];
  headerErrors: string[];
} {
  const parsed = parseCSV(csvText);
  if (parsed.headers.length === 0) return { rows: [], headerErrors: ['Empty file'] };

  const headerMap = mapHeaders(parsed.headers);
  if (!Object.values(headerMap).includes('storeName')) {
    return { rows: [], headerErrors: ['Missing required column: Store Name (or Location Name)'] };
  }
  if (!Object.values(headerMap).includes('address')) {
    return { rows: [], headerErrors: ['Missing required column: Address'] };
  }

  const rows: ImportRow[] = parsed.rows.map((rawRow, i) => {
    const { row } = validateImportRow(rawRow, headerMap);
    return { rowIndex: i + 2, ...row } as ImportRow;
  });

  return { rows, headerErrors: [] };
}

export async function bulkImportLocations(
  db: Db,
  tenantId: string,
  csvText: string,
  actorId: string
): Promise<ImportResult> {
  const { rows, headerErrors } = parseImportCSV(csvText);
  if (headerErrors.length > 0) {
    throw Object.assign(new Error(headerErrors.join('; ')), { status: 400 });
  }

  const tdb = new TenantDB(db, tenantId);
  const result: ImportResult = { created: 0, managersCreated: 0, managersFound: 0, failed: 0, failures: [] };

  // Collect existing store names for dedup check
  const existingNames = new Set(
    (await tdb.all<{ name: string }>('SELECT name FROM locations WHERE tenant_id = $1')).map((r) => r.name.toLowerCase())
  );

  // Track imported names in this batch for intra-batch dedup
  const batchNames = new Set<string>();

  const parsed = parseCSV(csvText);
  const headerMap = mapHeaders(parsed.headers);

  // Sequential for...of, not Promise.all: each row's dedup check reads existingNames/batchNames
  // mutated by the PREVIOUS row's own insert — running rows concurrently would let two rows
  // with the same store name both pass the dedup check before either commits.
  for (const row of parsed.rows) {
    const { row: validatedRow, reasons } = validateImportRow(row, headerMap);
    const { storeName, address, city, state, zip, region, managerFirstName, managerLastName, managerEmail } = validatedRow;
    const actualRowNum = parsed.rows.indexOf(row) + 2;

    const allReasons = [...reasons];

    const nameKey = (storeName ?? '').toLowerCase();
    if (storeName && (existingNames.has(nameKey) || batchNames.has(nameKey))) {
      allReasons.push(`Duplicate store name: ${storeName}`);
    }

    if (allReasons.length > 0) {
      result.failed++;
      result.failures.push({ row: actualRowNum, reasons: allReasons });
      continue;
    }

    // Import this row inside a transaction (withTransaction — never open one directly, see
    // src/lib/db/transaction.ts).
    await withTransaction(db, async (trx) => {
      const txTdb = new TenantDB(trx, tenantId);
      batchNames.add(nameKey!);

      let regionId: string | null = null;
      if (region) regionId = await findOrCreateRegion(txTdb, region);

      const normalizedState = normalizeState(state!);
      const fullAddress = `${address}, ${city}, ${normalizedState} ${zip}`.trim();
      const locationId = randomUUID();
      const now = new Date();

      await txTdb.insert('locations', {
        id: locationId,
        region_id: regionId,
        name: storeName,
        address: fullAddress,
        status: 'active',
        created_at: now,
      });
      existingNames.add(nameKey!);
      result.created++;

      if (managerEmail) {
        // COLLATE NOCASE -> lower() (Stage 0's catalogued rework spot)
        const existing = await txTdb.get<{ id: string }>(
          'SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)',
          [managerEmail]
        );
        let managerId: string;

        if (existing) {
          managerId = existing.id;
          result.managersFound++;
        } else {
          managerId = randomUUID();
          const managerName = [managerFirstName, managerLastName].filter(Boolean).join(' ') || managerEmail;
          await txTdb.insert('users', {
            id: managerId,
            email: managerEmail.toLowerCase().trim(),
            name: managerName,
            role: 'store_manager',
            password_hash: null,
            status: 'invited',
            created_at: now,
          });
          result.managersCreated++;
        }

        await txTdb.insert('user_locations', { user_id: managerId, location_id: locationId }, { orIgnore: true });
      }
    });
  }

  if (result.created > 0) {
    await recordBillingSnapshot(db, tenantId);
    await logAudit(db, {
      tenantId, actorType: 'user', actorId,
      eventType: 'locations.bulk_imported',
      payload: { created: result.created, managers_created: result.managersCreated, failed: result.failed },
    });
  }

  return result;
}
