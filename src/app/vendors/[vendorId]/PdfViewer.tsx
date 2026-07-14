'use client';

// In-app PDF renderer (Gate 2 restyle — replaces the native <iframe> embed). Fetches the
// already-audited document bytes from the existing admin-only serve route (unchanged: same
// route, same auth, same document.viewed audit event — this component only changes how the
// bytes get displayed once they arrive) and renders every page to a stacked <canvas> in a
// vertically scrollable container, so the layout is continuous-scroll-all-pages by construction
// (built from block-level DOM elements I control) rather than delegated to whichever native PDF
// plugin the browser happens to have, which was the source of the inconsistent
// thumbnail/page-rail rendering this replaces.
//
// pdfjs-dist's worker is not SSR-safe (references browser-only globals at module scope) — both
// the library import AND the worker configuration happen inside this effect, which never runs
// during server rendering. The component itself is also loaded via next/dynamic({ ssr: false })
// at its one call site (DocumentsAccordion.tsx) as a second, belt-and-suspenders guarantee.

import { useEffect, useRef, useState } from 'react';

type Status = 'loading' | 'ready' | 'error';

export function PdfViewer({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;

    async function render() {
      try {
        // Dynamic import — must not evaluate during SSR. This effect body only ever runs
        // client-side, so this is already safe without next/dynamic, which is applied at the
        // call site as a second layer.
        const pdfjsLib = await import('pdfjs-dist');

        // Worker config: served as a plain static file from /public (copied there by
        // scripts/copy-pdf-worker.js on every `npm install`), NOT routed through webpack's
        // asset-module pipeline. The `new URL(..., import.meta.url)` pattern looks cleaner but
        // makes Next.js's production Terser pass try to re-minify this already-minified ESM
        // file and fail ("'import'/'export' cannot be used outside of module code") — confirmed
        // by an actual `next build` failure. A plain /public path bypasses that pipeline
        // entirely; no CDN dependency either way (this app self-hosts its font for the same
        // no-runtime-CDN reason — see layout.tsx).
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Failed to fetch document (HTTP ${res.status})`);
        const bytes = await res.arrayBuffer();
        if (cancelled) return;

        const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled || !container) return;

        container.innerHTML = '';
        const containerWidth = container.clientWidth || 760;

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          if (cancelled) return;
          const page = await doc.getPage(pageNum);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = containerWidth / unscaledViewport.width;
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.marginBottom = '10px';
          canvas.style.boxShadow = '0 0 0 1px #d0d7de';
          container.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
        }

        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage((err as Error).message || 'Unknown error');
        }
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div>
      {status === 'loading' && (
        <p style={{ padding: 24, textAlign: 'center', color: '#57606a', fontSize: 13 }}>
          Loading document…
        </p>
      )}
      {status === 'error' && (
        <p style={{ padding: 24, textAlign: 'center', color: '#cf222e', fontSize: 13 }}>
          Could not render this document{errorMessage ? ` — ${errorMessage}` : '.'}
        </p>
      )}
      {/* Continuous vertical scroll, all pages — built from block-level canvases I append
          myself, not delegated to a native PDF plugin's own layout heuristics. */}
      <div
        ref={containerRef}
        style={{
          maxHeight: 800,
          overflowY: status === 'ready' ? 'auto' : 'hidden',
          overflowX: 'hidden',
          padding: status === 'ready' ? 12 : 0,
          background: '#f6f8fa',
          display: status === 'error' ? 'none' : 'block',
        }}
      />
    </div>
  );
}
