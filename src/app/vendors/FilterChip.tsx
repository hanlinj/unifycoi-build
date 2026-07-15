'use client';

import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { cn } from '@/components/ui';
import {
  FILTER_ATTRIBUTES,
  OPERATORS_BY_TYPE,
  DEFAULT_OPERATOR_BY_TYPE,
  operatorLabel,
  attributeDef,
  type VendorFilter,
  type FilterOption,
} from '@/lib/vendors/filters';
import { PopoverPanel, PopoverRow, useOutsideClose } from './Popover';

interface Props {
  filter: VendorFilter;
  options: FilterOption[];
  /** Attribute keys already used by OTHER chips — excluded from the attribute-switch picker
   *  (one filter per attribute; see FilterBar). */
  usedAttributes: string[];
  /** True only for the render right after this chip was created via [+] — opens the value
   *  picker immediately. Read once at mount (the useState below); a later prop change has no
   *  effect, which is the point — auto-open happens exactly once per chip instance. */
  autoOpenValue: boolean;
  onChange: (next: VendorFilter) => void;
  onRemove: () => void;
}

type Segment = 'attribute' | 'operator' | 'value';

// One reset, shared by every segment in the flush pill — preflight is off app-wide, so a bare
// <button> keeps the browser's native 3D chrome unless explicitly stripped (confirmed live:
// border: 2px outset black, appearance: auto, background: buttonface).
const SEGMENT = 'appearance-none border-0 bg-transparent px-2.5 py-1.5 text-[13px] text-left outline-none hover:bg-surface-2 inline-flex items-center gap-1';

export function FilterChip({ filter, options, usedAttributes, autoOpenValue, onChange, onRemove }: Props) {
  const def = attributeDef(filter.attribute);
  const type = def?.type ?? 'enum';
  const [openSegment, setOpenSegment] = useState<Segment | null>(autoOpenValue ? 'value' : null);
  const close = () => setOpenSegment(null);
  const ref = useOutsideClose(openSegment !== null, close);

  function toggle(segment: Segment) {
    setOpenSegment((s) => (s === segment ? null : segment));
  }

  const valueLabel =
    filter.values.length === 0
      ? 'Select…'
      : filter.values.length === 1
      ? options.find((o) => o.value === filter.values[0])?.label ?? filter.values[0]
      : `${filter.values.length} selected`;

  function toggleValue(v: string) {
    const next = filter.values.includes(v) ? filter.values.filter((x) => x !== v) : [...filter.values, v];
    onChange({ ...filter, values: next });
  }

  return (
    <div ref={ref} className="relative inline-flex">
      {/* The ONE visual container — single border, rounded, clipped. Segments are flush inside
          it with hairline dividers; popovers below are siblings of THIS div, never children of
          it, so they're never clipped by its overflow-hidden (see Popover.tsx's module doc). */}
      <div className="inline-flex items-stretch overflow-hidden rounded-pill border-solid border-[0.5px] border-border bg-surface text-fg">
        <button type="button" onClick={() => toggle('attribute')} className={cn(SEGMENT, 'font-semibold')}>
          {def?.label ?? filter.attribute} <ChevronDown size={12} strokeWidth={2.5} className="text-fg-muted" />
        </button>
        <span className="my-1.5 w-[0.5px] shrink-0 bg-border" aria-hidden />
        <button type="button" onClick={() => toggle('operator')} className={cn(SEGMENT, 'text-fg-muted')}>
          {operatorLabel(type, filter.operator)} <ChevronDown size={12} strokeWidth={2.5} />
        </button>
        <span className="my-1.5 w-[0.5px] shrink-0 bg-border" aria-hidden />
        <button type="button" onClick={() => toggle('value')} className={SEGMENT}>
          {valueLabel} <ChevronDown size={12} strokeWidth={2.5} className="text-fg-muted" />
        </button>
        <span className="my-1.5 w-[0.5px] shrink-0 bg-border" aria-hidden />
        <button
          type="button"
          aria-label={`Remove ${def?.label ?? filter.attribute} filter`}
          onClick={onRemove}
          className="appearance-none border-0 bg-transparent px-2 text-fg-muted outline-none hover:bg-surface-2 hover:text-danger"
        >
          <X size={13} strokeWidth={2.5} />
        </button>
      </div>

      {openSegment === 'attribute' && (
        <PopoverPanel className="min-w-[160px] py-1">
          {FILTER_ATTRIBUTES.filter((a) => a.key === filter.attribute || !usedAttributes.includes(a.key)).map((a) => (
            <PopoverRow
              key={a.key}
              active={a.key === filter.attribute}
              onClick={() => {
                close();
                if (a.key === filter.attribute) return;
                // Switching attribute resets operator + values (a different attribute's values
                // are a different universe, and the default operator applies fresh).
                onChange({ attribute: a.key, operator: DEFAULT_OPERATOR_BY_TYPE[a.type], values: [] });
              }}
            >
              {a.label}
            </PopoverRow>
          ))}
        </PopoverPanel>
      )}

      {openSegment === 'operator' && (
        <PopoverPanel className="min-w-[140px] py-1">
          {OPERATORS_BY_TYPE[type].map((o) => (
            <PopoverRow
              key={o.operator}
              active={o.operator === filter.operator}
              onClick={() => {
                close();
                onChange({ ...filter, operator: o.operator });
              }}
            >
              {o.label}
            </PopoverRow>
          ))}
        </PopoverPanel>
      )}

      {openSegment === 'value' && (
        <PopoverPanel className="w-[220px]">
          <div className="max-h-[280px] overflow-y-auto py-0.5">
            {options.length === 0 ? (
              <p className="px-3.5 py-2 text-sm text-fg-muted">No options in scope.</p>
            ) : (
              options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-center gap-2 px-3.5 py-1.5 text-sm text-fg hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={filter.values.includes(opt.value)}
                    onChange={() => toggleValue(opt.value)}
                    className="accent-accent"
                  />
                  {opt.label}
                </label>
              ))
            )}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
