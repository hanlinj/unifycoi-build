'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from './cn';

export interface PaginationProps {
  page: number; // 1-based
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Optional "1–50 of 128" summary. */
  summary?: React.ReactNode;
  className?: string;
}

/** Prev / numbered / next pager. Hidden page controls when there is a single page. */
export function Pagination({ page, pageCount, onPageChange, summary, className }: PaginationProps) {
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const go = (p: number) => { if (p >= 1 && p <= pageCount && p !== page) onPageChange(p); };

  return (
    <nav aria-label="Pagination" className={cn('flex items-center justify-between gap-4 text-sm', className)}>
      <span className="text-fg-muted">{summary}</span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}
            className="grid h-8 w-8 place-items-center rounded-ctl border border-border-strong bg-surface text-fg-muted hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            <ChevronLeft size={16} strokeWidth={2.5} />
          </button>
          {pages.map((p) => (
            <button
              key={p} type="button" aria-label={`Page ${p}`} aria-current={p === page ? 'page' : undefined} onClick={() => go(p)}
              className={cn(
                'grid h-8 min-w-8 place-items-center rounded-ctl border px-2 text-sm font-semibold',
                p === page ? 'border-transparent bg-action text-white' : 'border-border-strong bg-surface text-fg hover:bg-surface-2'
              )}
            >
              {p}
            </button>
          ))}
          <button
            type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => go(page + 1)}
            className="grid h-8 w-8 place-items-center rounded-ctl border border-border-strong bg-surface text-fg-muted hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
        </div>
      )}
    </nav>
  );
}
