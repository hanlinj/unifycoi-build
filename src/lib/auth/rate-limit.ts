// Login rate limiting + soft lockout (SEC-9). DB-backed rolling window over the
// login_attempts failure log. Route-agnostic on purpose: the login route uses it now, and
// Slice 3's password-reset request endpoint reuses the same limiter (share a limiter key).
//
// Model (see migration 010): one row per FAILED attempt per scope. The lock is DERIVED —
// within the window, count(scope) >= max(scope) means blocked. Blocked attempts are NOT
// recorded, so a quiet window ages out and the soft lock self-lifts. A successful login
// clears the email scope; the IP scope is a rolling window and survives a single success.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { env } from '@/lib/env';

export interface LoginRateConfig {
  maxPerEmail: number;
  maxPerIp: number;
  windowSeconds: number;
}

/** Config from env (LOGIN_MAX_PER_EMAIL=5, LOGIN_MAX_PER_IP=30, window=15m by default). */
export function loginRateConfig(): LoginRateConfig {
  return {
    maxPerEmail: env.auth.login.maxPerEmail,
    maxPerIp: env.auth.login.maxPerIp,
    windowSeconds: env.auth.login.windowSeconds,
  };
}

export interface LoginRateKey {
  email: string;
  ip: string;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the block would lift (0 when allowed). A generic hint — it does NOT
   *  reveal which factor (email vs IP) tripped; callers must keep the response generic. */
  retryAfterSeconds: number;
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Evaluate one scope. Returns retry-after seconds (>0 when blocked, 0 when allowed).
 * When blocked, the block lifts once enough of the oldest failures age out of the window
 * to drop the in-window count below `max` — that is the failure at index (len - max).
 */
function evalScope(
  db: Database.Database,
  scopeType: 'email' | 'ip',
  scopeKey: string,
  windowStartIso: string,
  max: number,
  windowSeconds: number,
  nowMs: number
): number {
  const rows = db
    .prepare(
      `SELECT created_at FROM login_attempts
       WHERE scope_type = ? AND scope_key = ? AND created_at > ?
       ORDER BY created_at ASC`
    )
    .all(scopeType, scopeKey, windowStartIso) as { created_at: string }[];

  if (rows.length < max) return 0;
  const pivot = rows[rows.length - max]; // oldest failure that must age out to reach max-1
  const unblockMs = new Date(pivot.created_at).getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((unblockMs - nowMs) / 1000));
}

/** Check BEFORE attempting a login. Blocked if either the email OR the IP scope is over. */
export function checkLoginRate(
  db: Database.Database,
  key: LoginRateKey,
  now: Date = new Date(),
  cfg: LoginRateConfig = loginRateConfig()
): RateDecision {
  const nowMs = now.getTime();
  const windowStartIso = new Date(nowMs - cfg.windowSeconds * 1000).toISOString();

  const emailRetry = evalScope(db, 'email', normEmail(key.email), windowStartIso, cfg.maxPerEmail, cfg.windowSeconds, nowMs);
  const ipRetry = evalScope(db, 'ip', key.ip, windowStartIso, cfg.maxPerIp, cfg.windowSeconds, nowMs);

  const retryAfterSeconds = Math.max(emailRetry, ipRetry);
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

/** Record ONE failed attempt against both the email and IP scopes. */
export function recordLoginFailure(db: Database.Database, key: LoginRateKey, now: Date = new Date()): void {
  const iso = now.toISOString();
  const stmt = db.prepare(
    `INSERT INTO login_attempts (id, scope_type, scope_key, created_at) VALUES (?, ?, ?, ?)`
  );
  stmt.run(randomUUID(), 'email', normEmail(key.email), iso);
  stmt.run(randomUUID(), 'ip', key.ip, iso);
}

/**
 * Clear the EMAIL scope for an address. Called on a successful login (clears the soft
 * lock), and it is the same seam a future platform-dashboard operator-unlock will call.
 * Deliberately does NOT touch the IP scope — the rolling IP window must survive one
 * success so a valid login can't wipe an attacker's IP count.
 */
export function clearLoginFailuresForEmail(db: Database.Database, email: string): void {
  db.prepare(`DELETE FROM login_attempts WHERE scope_type = 'email' AND scope_key = ?`).run(normEmail(email));
}
