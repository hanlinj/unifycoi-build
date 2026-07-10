// DEV ONLY. Prints the vendor token URL to the server console in place of sending an email,
// so the tokenized vendor flow can be exercised without a real ESP wired up (SEC-1).
//
// Hard-guarded: this is a no-op whenever NODE_ENV === 'production', so it can never leak a
// vendor link to a server log in production. Called at each raw-token mint site.

export function logDevInviteUrl(rawToken: string, purpose: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  // eslint-disable-next-line no-console
  console.log(
    `\n📨 DEV ONLY — would have emailed (${purpose}). Vendor link:\n   ${base}/v/${rawToken}\n`
  );
}
