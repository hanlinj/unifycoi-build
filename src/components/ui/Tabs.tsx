'use client';

import React from 'react';
import { cn } from './cn';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

/** Segmented tabs (pill container; active tab is a raised surface card). Matches the spec. */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('inline-flex gap-1 rounded-ctl bg-surface-2 p-1', className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'inline-flex items-center gap-2 rounded-[9px] px-[14px] py-2 text-[13px] font-semibold transition-all duration-100',
              active ? 'bg-surface text-fg shadow-raise' : 'text-fg-muted hover:text-fg'
            )}
          >
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  'rounded-pill px-[7px] py-0.5 text-[11px] font-bold',
                  active ? 'bg-accent text-accent-ink' : 'bg-[rgba(139,140,147,0.16)] text-fg-muted'
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
