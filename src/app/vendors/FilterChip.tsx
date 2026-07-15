'use client';

import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui';
import {
  FILTER_ATTRIBUTES,
  OPERATORS_BY_TYPE,
  DEFAULT_OPERATOR_BY_TYPE,
  operatorLabel,
  attributeDef,
  type VendorFilter,
  type FilterOption,
} from '@/lib/vendors/filters';

interface Props {
  filter: VendorFilter;
  options: FilterOption[];
  /** Attribute keys already used by OTHER chips — excluded from the attribute-switch picker
   *  (one filter per attribute; see FilterBar). */
  usedAttributes: string[];
  /** True only for the render right after this chip was created via [+] — opens the value
   *  picker immediately so picking an attribute flows straight into picking values. Read once
   *  at mount (see the local useState below); changing it later has no effect, which is the
   *  point — a freshly created chip auto-opens exactly once, never again on a later re-render. */
  autoOpenValue: boolean;
  onChange: (next: VendorFilter) => void;
  onRemove: () => void;
}

const segment = 'px-2.5 py-1 text-[13px] hover:bg-surface-2 focus:outline-none';

export function FilterChip({ filter, options, usedAttributes, autoOpenValue, onChange, onRemove }: Props) {
  const def = attributeDef(filter.attribute);
  const type = def?.type ?? 'enum';
  const [valueOpen, setValueOpen] = useState(autoOpenValue);

  const valueLabel =
    filter.values.length === 0
      ? 'Select…'
      : filter.values.length === 1
      ? options.find((o) => o.value === filter.values[0])?.label ?? filter.values[0]
      : `${filter.values.length} selected`;

  function toggleValue(v: string) {
    const next = filter.values.includes(v)
      ? filter.values.filter((x) => x !== v)
      : [...filter.values, v];
    onChange({ ...filter, values: next });
  }

  return (
    <div className="inline-flex items-center overflow-hidden rounded-pill border border-border bg-surface text-fg">
      {/* Attribute segment — reopens the attribute picker (switching resets operator + values,
          since a different attribute's values are a different universe). */}
      <Menu
        align="left"
        trigger={
          <button type="button" className={`${segment} inline-flex items-center gap-1 font-semibold`}>
            {def?.label ?? filter.attribute} <ChevronDown size={12} strokeWidth={2.5} className="text-fg-muted" />
          </button>
        }
      >
        {FILTER_ATTRIBUTES.filter((a) => a.key === filter.attribute || !usedAttributes.includes(a.key)).map((a) => (
          <MenuItem
            key={a.key}
            onClick={() => {
              if (a.key === filter.attribute) return;
              // Switching attribute changes this chip's key in FilterBar's list (attribute IS
              // the key), so this component unmounts and a fresh one mounts for the new
              // attribute — autoOpenValue (driven by FilterBar's newestAttribute) reopens the
              // value picker on that new instance; no local re-open call belongs here.
              onChange({ attribute: a.key, operator: DEFAULT_OPERATOR_BY_TYPE[a.type], values: [] });
            }}
          >
            {a.label}
          </MenuItem>
        ))}
      </Menu>

      <span className="h-4 w-px bg-border" />

      {/* Operator segment. */}
      <Menu
        align="left"
        trigger={<button type="button" className={`${segment} inline-flex items-center gap-1 text-fg-muted`}>
          {operatorLabel(type, filter.operator)} <ChevronDown size={12} strokeWidth={2.5} />
        </button>}
      >
        {OPERATORS_BY_TYPE[type].map((o) => (
          <MenuItem key={o.operator} onClick={() => onChange({ ...filter, operator: o.operator })}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>

      <span className="h-4 w-px bg-border" />

      {/* Value segment — multi-select checkboxes; stays open while toggling (closeOnItemClick
          false), unlike the single-select attribute/operator pickers above. */}
      <Menu
        align="left"
        closeOnItemClick={false}
        open={valueOpen}
        onOpenChange={setValueOpen}
        trigger={
          <button type="button" className={`${segment} inline-flex items-center gap-1`}>
            {valueLabel} <ChevronDown size={12} strokeWidth={2.5} className="text-fg-muted" />
          </button>
        }
      >
        <div className="max-h-[280px] w-[220px] overflow-y-auto py-0.5">
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
      </Menu>

      <button
        type="button"
        aria-label={`Remove ${def?.label ?? filter.attribute} filter`}
        onClick={onRemove}
        className="flex h-full items-center px-2 text-fg-muted hover:bg-surface-2 hover:text-danger"
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
}
