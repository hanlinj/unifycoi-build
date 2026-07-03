'use client';

import React from 'react';
import { cn } from './cn';
import { Badge } from './Badge';

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

/** Underline tabs (blue active underline + optional count badge) — matches the ref sections. */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('flex gap-6 border-b border-border', className)}>
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
              'inline-flex items-center gap-2 -mb-px border-b-2 px-1 py-2 text-sm font-medium transition-colors',
              active ? 'border-accent text-accent-fg' : 'border-transparent text-fg-muted hover:text-fg'
            )}
          >
            {t.label}
            {t.count != null && <Badge tone={active ? 'accent' : 'neutral'}>{t.count}</Badge>}
          </button>
        );
      })}
    </div>
  );
}
