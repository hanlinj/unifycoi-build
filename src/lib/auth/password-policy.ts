// Shared password-length policy (Phase 11 rule, extracted so it's importable client-side too —
// e.g. the reset/invite-accept page's inline validation — instead of restated. Zero deps, so it
// is safe to bundle into a 'use client' component (unlike password-reset.ts, which transitively
// pulls in better-sqlite3/crypto/the notification queue).

export const MIN_PASSWORD_LENGTH = 8;

export function isPasswordValid(password: string): boolean {
  return !!password && password.length >= MIN_PASSWORD_LENGTH;
}
