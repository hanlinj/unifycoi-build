// Copies the pdfjs-dist worker into public/ as a plain static asset, bypassing Next.js's
// webpack/Terser build pipeline entirely for this one file. Required because routing the
// worker through the standard `new URL(..., import.meta.url)` webpack-asset pattern makes
// Next.js's production minifier try to re-minify an already-minified ESM file, which fails
// with "'import'/'export' cannot be used outside of module code" (Terser doesn't parse it as
// a module in that pass). Serving it untouched from /public sidesteps that entirely.
//
// Runs on every `npm install` (see package.json's "postinstall") so it stays in sync with
// whatever pdfjs-dist version is pinned — the copied file itself is gitignored, not committed,
// same as anything else derived from node_modules.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const destDir = path.join(__dirname, '..', 'public');
const dest = path.join(destDir, 'pdf.worker.min.mjs');

if (!fs.existsSync(src)) {
  console.warn('[copy-pdf-worker] pdfjs-dist worker not found at', src, '— skipping.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('[copy-pdf-worker] copied pdf.worker.min.mjs -> public/pdf.worker.min.mjs');
