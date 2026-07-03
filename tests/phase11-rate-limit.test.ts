// Phase 11 · Slice 2 — Login rate limiting + soft lockout (SEC-9).
// Rolling-window counters over login_attempts: per-email soft lock (clears on success),
// per-IP rolling throttle (survives a single success). Generic 429, no factor revealed.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import {
  checkLoginRate,
  recordLoginFailure,
  clearLoginFailuresForEmail,
  loginRateConfig,
  type LoginRateConfig,
} from '@/lib/auth/rate-limit';
import { getRawDb, closeDb } from '@/lib/db/client';

const CFG: LoginRateConfig = { maxPerEmail: 5, maxPerIp: 30, windowSeconds: 900 };
const T0 = new Date('2026-07-03T12:00:00.000Z');
const at = (secondsAfter: number) => new Date(T0.getTime() + secondsAfter * 1000);

function migrate(db: Database.Database): void {
  const dir = path.join(process.cwd(), 'src', 'migrations');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

// ── limiter core (pure, injected config) ────────────────────────────────────────

describe('checkLoginRate · per-email soft lockout', () => {
  test('allows up to the threshold, blocks the attempt after it', () => {
    const db = setupTestDb();
    const key = { email: 'user@x.test', ip: '10.0.0.1' };
    for (let i = 0; i < 4; i++) recordLoginFailure(db, key, at(i));
    expect(checkLoginRate(db, key, at(5), CFG).allowed).toBe(true); // 4 failures < 5
    recordLoginFailure(db, key, at(5)); // 5th failure
    const decision = checkLoginRate(db, key, at(6), CFG);
    expect(decision.allowed).toBe(false); // 5 >= 5 → locked
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('email scope is case/whitespace-normalized', () => {
    const db = setupTestDb();
    for (let i = 0; i < 5; i++) recordLoginFailure(db, { email: '  User@X.test ', ip: '10.0.0.1' }, at(i));
    expect(checkLoginRate(db, { email: 'user@x.test', ip: '9.9.9.9' }, at(6), CFG).allowed).toBe(false);
  });
});

describe('checkLoginRate · per-IP rolling throttle', () => {
  test('trips at the IP threshold independent of email (distinct emails, one IP)', () => {
    const db = setupTestDb();
    const ip = '203.0.113.7';
    for (let i = 0; i < 30; i++) recordLoginFailure(db, { email: `u${i}@x.test`, ip }, at(i));
    // Each email has 1 failure (< 5) but the IP has 30 → a brand-new email from this IP is blocked.
    const decision = checkLoginRate(db, { email: 'fresh@x.test', ip }, at(31), CFG);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('clearing + window semantics', () => {
  test('success clears the email scope but NOT the IP scope', () => {
    const db = setupTestDb();
    const ip = '198.51.100.5';
    // 30 failures across distinct emails from one IP → IP blocked.
    for (let i = 0; i < 30; i++) recordLoginFailure(db, { email: `u${i}@x.test`, ip }, at(i));
    // A success for one of those emails clears only its email rows.
    clearLoginFailuresForEmail(db, 'u0@x.test');
    // IP window still has 30 → still blocked (one success must not wipe an attacker's IP count).
    expect(checkLoginRate(db, { email: 'u0@x.test', ip }, at(31), CFG).allowed).toBe(false);
  });

  test('a per-email soft lock clears immediately on success', () => {
    const db = setupTestDb();
    const key = { email: 'locked@x.test', ip: '10.0.0.9' };
    for (let i = 0; i < 5; i++) recordLoginFailure(db, key, at(i));
    expect(checkLoginRate(db, key, at(6), CFG).allowed).toBe(false);
    clearLoginFailuresForEmail(db, key.email);
    expect(checkLoginRate(db, key, at(6), CFG).allowed).toBe(true);
  });

  test('failures older than the window no longer count (rolling self-lift)', () => {
    const db = setupTestDb();
    const key = { email: 'stale@x.test', ip: '10.0.0.2' };
    for (let i = 0; i < 5; i++) recordLoginFailure(db, key, at(i)); // all near T0
    expect(checkLoginRate(db, key, at(10), CFG).allowed).toBe(false);
    // Past the window → the old failures age out → unlocked.
    expect(checkLoginRate(db, key, at(CFG.windowSeconds + 10), CFG).allowed).toBe(true);
  });

  test('retryAfter reflects when the block lifts (~window minus elapsed)', () => {
    const db = setupTestDb();
    const key = { email: 'retry@x.test', ip: '10.0.0.3' };
    for (let i = 0; i < 5; i++) recordLoginFailure(db, key, at(0)); // all at T0
    const decision = checkLoginRate(db, key, at(100), CFG);
    expect(decision.allowed).toBe(false);
    // Oldest failure at T0 ages out at T0+900; now is T0+100 → ~800s left.
    expect(decision.retryAfterSeconds).toBeGreaterThan(790);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(800);
  });

  test('the decision exposes no factor field (email vs IP is not revealed)', () => {
    const db = setupTestDb();
    const key = { email: 'x@x.test', ip: '10.0.0.4' };
    for (let i = 0; i < 5; i++) recordLoginFailure(db, key, at(i));
    expect(Object.keys(checkLoginRate(db, key, at(6), CFG)).sort()).toEqual(['allowed', 'retryAfterSeconds']);
  });
});

describe('loginRateConfig · env defaults', () => {
  test('honors the documented defaults (5 / 30 / 900)', () => {
    expect(loginRateConfig()).toEqual({ maxPerEmail: 5, maxPerIp: 30, windowSeconds: 900 });
  });
});

// ── login route integration ─────────────────────────────────────────────────────

describe('POST /api/auth/login · throttle wiring', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (req: Request) => Promise<any>;
  let db: Database.Database;

  beforeAll(() => {
    db = getRawDb();
    migrate(db);
    const t = seedTenant(db, { name: 'Rate Co' });
    seedTenantUser(db, t.id, { email: 'admin@rate.test', password: 'correct-horse-battery', role: 'admin' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    POST = require('@/app/api/auth/login/route').POST;
  });
  afterAll(() => closeDb());
  // Each test starts from clean throttle state. (The email scope is IP-independent by
  // design, so failures from a prior test would otherwise carry the account's soft lock over.)
  beforeEach(() => db.exec('DELETE FROM login_attempts'));

  function login(email: string, password: string, ip: string): Promise<Response> {
    return POST(
      new Request('http://t/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password }),
      })
    );
  }

  test('5 wrong-password attempts (same email+IP) → 6th is a generic 429 with Retry-After', async () => {
    const ip = '100.64.0.1';
    for (let i = 0; i < 5; i++) {
      const res = await login('admin@rate.test', 'wrong', ip);
      expect(res.status).toBe(401);
    }
    const blocked = await login('admin@rate.test', 'wrong', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = await blocked.json();
    // Generic — must not name the factor.
    expect(body.error).toBe('Too many attempts. Please try again later.');
    expect(body.error.toLowerCase()).not.toContain('email');
    expect(body.error.toLowerCase()).not.toContain('ip');
  });

  test('a successful login clears the per-email counter', async () => {
    const ip = '100.64.0.2';
    for (let i = 0; i < 4; i++) expect((await login('admin@rate.test', 'wrong', ip)).status).toBe(401);
    // Correct password (4 failures < 5, not yet locked) → success clears the email counter.
    expect((await login('admin@rate.test', 'correct-horse-battery', ip)).status).toBe(200);
    // Four more failures would be the 5th..8th if the counter hadn't cleared; instead it's 1..4.
    for (let i = 0; i < 4; i++) expect((await login('admin@rate.test', 'wrong', ip)).status).toBe(401);
    // Still under threshold → a correct login still works (would be 429 if success hadn't cleared).
    expect((await login('admin@rate.test', 'correct-horse-battery', ip)).status).toBe(200);
  });

  test('per-IP throttle trips across distinct (unknown) emails from one IP', async () => {
    const ip = '100.64.0.3';
    for (let i = 0; i < 30; i++) expect((await login(`ghost${i}@rate.test`, 'wrong', ip)).status).toBe(401);
    // 30 IP failures → even a brand-new email from this IP is throttled.
    expect((await login('newcomer@rate.test', 'wrong', ip)).status).toBe(429);
  });
});
