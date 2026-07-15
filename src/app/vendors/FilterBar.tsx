'use client';

// Filter bar for /vendors. Committed filters (ones with at least one value) live entirely in
// the URL — read via useSearchParams(), the single source of truth, so browser back/forward
// and deep links (e.g. a future Expired-vendors stat card -> /vendors?status=expired) just
// work without any local state getting stale. A filter with zero values selected ("Select…")
// carries no filtering information, so it's never written to the URL — it's tracked in a small
// local `pendingAttributes` list purely so its chip keeps rendering while the user picks values.

import { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui';
import {
  FILTER_ATTRIBUTES,
  DEFAULT_OPERATOR_BY_TYPE,
  filtersToSearchParams,
  filtersFromSearchParams,
  type VendorFilter,
  type FilterOption,
} from '@/lib/vendors/filters';
import type { VendorFilterOptions } from '@/app/api/vendors/route';
import { FilterChip } from './FilterChip';

interface Props {
  filterOptions: VendorFilterOptions;
}

export function FilterBar({ filterOptions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committed = filtersFromSearchParams(searchParams);

  const [pendingAttributes, setPendingAttributes] = useState<string[]>([]);
  const [newestAttribute, setNewestAttribute] = useState<string | null>(null);

  const filters: VendorFilter[] = [
    ...committed,
    ...pendingAttributes
      .filter((a) => !committed.some((f) => f.attribute === a))
      .map((a) => {
        const def = FILTER_ATTRIBUTES.find((d) => d.key === a)!;
        return { attribute: a, operator: DEFAULT_OPERATOR_BY_TYPE[def.type], values: [] as string[] };
      }),
  ];

  function pushUrl(next: VendorFilter[]) {
    const qs = filtersToSearchParams(next).toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function addFilter(attributeKey: string) {
    setNewestAttribute(attributeKey);
    setPendingAttributes((p) => [...p, attributeKey]);
  }

  function updateFilter(oldAttribute: string, next: VendorFilter) {
    if (next.attribute !== oldAttribute) setNewestAttribute(next.attribute);
    setPendingAttributes((p) => p.filter((a) => a !== oldAttribute && a !== next.attribute));
    const withoutThis = committed.filter((f) => f.attribute !== oldAttribute && f.attribute !== next.attribute);
    if (next.values.length > 0) {
      pushUrl([...withoutThis, next]);
    } else {
      // Zero values — not written to the URL; kept as a pending chip so it doesn't vanish.
      setPendingAttributes((p) => [...p, next.attribute]);
      pushUrl(withoutThis);
    }
  }

  function removeFilter(attribute: string) {
    setPendingAttributes((p) => p.filter((a) => a !== attribute));
    if (committed.some((f) => f.attribute === attribute)) {
      pushUrl(committed.filter((f) => f.attribute !== attribute));
    }
  }

  function clearAll() {
    setPendingAttributes([]);
    router.push(pathname);
  }

  const usedAttributes = filters.map((f) => f.attribute);
  const availableAttributes = FILTER_ATTRIBUTES.filter((a) => !usedAttributes.includes(a.key));

  function optionsFor(attribute: string): FilterOption[] {
    switch (attribute) {
      case 'status': return filterOptions.status;
      case 'location': return filterOptions.location;
      case 'trade': return filterOptions.trade;
      case 'invitedBy': return filterOptions.invitedBy;
      default: return [];
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {/* Search box slot — Stage 3. Left-of-filters per spec; not rendered yet (nothing to
          leave visible room for until it exists) — dropping <Input placeholder="Search…" /> in
          right here, before the [+] button, is the whole change when that stage lands. */}

      {availableAttributes.length > 0 && (
        <Menu
          align="left"
          trigger={
            <button
              type="button"
              aria-label="Add filter"
              className="flex h-8 w-8 items-center justify-center rounded-ctl border border-border text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <Plus size={15} strokeWidth={2.5} />
            </button>
          }
        >
          {availableAttributes.map((a) => (
            <MenuItem key={a.key} onClick={() => addFilter(a.key)}>{a.label}</MenuItem>
          ))}
        </Menu>
      )}

      {filters.map((f) => (
        <FilterChip
          key={f.attribute}
          filter={f}
          options={optionsFor(f.attribute)}
          usedAttributes={usedAttributes}
          autoOpenValue={f.attribute === newestAttribute}
          onChange={(next) => updateFilter(f.attribute, next)}
          onRemove={() => removeFilter(f.attribute)}
        />
      ))}

      {filters.length > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="text-[13px] font-semibold text-fg-muted hover:text-danger"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
