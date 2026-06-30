// Base URL for a server component's self-fetch back to its own API.
//
// The self-fetch targets THIS server, which in dev (and behind a TLS-terminating proxy) listens
// on HTTP. Honor a proxy's x-forwarded-proto when present; otherwise default to http outside
// production. The previous `host.startsWith('localhost') ? http : https` heuristic broke any
// non-localhost host (e.g. a Tailscale IP / LAN address) by forcing https against the http dev
// server → ERR_SSL_PACKET_LENGTH_TOO_LONG.

export function requestBaseUrl(h: { get(name: string): string | null }): string {
  const host = h.get('host') ?? 'localhost:3000';
  const proto =
    h.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}`;
}
