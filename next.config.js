/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only: allow cross-origin /_next requests when reaching the dev server over Tailscale/LAN
  // (silences the cross-origin warning + keeps HMR/asset loading working off-localhost).
  allowedDevOrigins: ['100.96.232.48'],
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
