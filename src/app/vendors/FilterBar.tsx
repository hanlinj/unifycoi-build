'use client';

// Filter bar for /vendors. Committed filters (ones with at least one value) live entirely in
// the URL — read via useSearchParams(), the single source of truth, so browser back/forward
// and deep links (e.g. a future Expired-vendors stat card -> /vendors?status=expired) just
// work without any local state getting stale. A filter with zero values selected ("Select…")
// carries no filtering information, so it's never written to the URL — it's tracked in a small
// local `pending` list purely so its chip keeps rendering while the user picks values.
//
// `pending` stores the FULL filter (attribute + operator), not just the attribute key — an
// earlier version tracked attribute keys only and always reconstructed a pending chip with the
// type's default operator, which silently discarded an operator change made before any value
// was picked (choosing "is none of" then immediately re-rendered as "is any of"). Caught live
// via Playwright, not by inspection.

import { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
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
import { PopoverPanel, PopoverRow, useOutsideClose } from './Popover';

interface Props {
  filterOptions: VendorFilterOptions;
}

export function FilterBar({ filterOptions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committed = filtersFromSearchParams(searchParams);

  const [pending, setPending] = useState<VendorFilter[]>([]);
  const [newestAttribute, setNewestAttribute] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useOutsideClose(addOpen, () => setAddOpen(false));

  const filters: VendorFilter[] = [
    ...committed,
    ...pending.filter((f) => !committed.some((c) => c.attribute === f.attribute)),
  ];

  function pushUrl(next: VendorFilter[]) {
    const qs = filtersToSearchParams(next).toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function addFilter(attributeKey: string) {
    const def = FILTER_ATTRIBUTES.find((d) => d.key === attributeKey);
    if (!def) return;
    setAddOpen(false);
    setNewestAttribute(attributeKey);
    setPending((p) => [...p, { attribute: attributeKey, operator: DEFAULT_OPERATOR_BY_TYPE[def.type], values: [] }]);
  }

  function updateFilter(oldAttribute: string, next: VendorFilter) {
    if (next.attribute !== oldAttribute) setNewestAttribute(next.attribute);
    setPending((p) => p.filter((f) => f.attribute !== oldAttribute && f.attribute !== next.attribute));
    const withoutThis = committed.filter((f) => f.attribute !== oldAttribute && f.attribute !== next.attribute);
    if (next.values.length > 0) {
      pushUrl([...withoutThis, next]);
    } else {
      // Zero values — not written to the URL; kept pending (full filter, including whatever
      // operator was just picked) so the chip neither vanishes nor forgets the operator choice.
      setPending((p) => [...p, next]);
      pushUrl(withoutThis);
    }
  }

  function removeFilter(attribute: string) {
    setPending((p) => p.filter((f) => f.attribute !== attribute));
    if (committed.some((f) => f.attribute === attribute)) {
      pushUrl(committed.filter((f) => f.attribute !== attribute));
    }
  }

  function clearAll() {
    setPending([]);
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
        <div ref={addRef} className="relative inline-flex">
          <button
            type="button"
            aria-label="Add filter"
            onClick={() => setAddOpen((o) => !o)}
            className="flex h-8 w-8 appearance-none items-center justify-center rounded-ctl border border-border bg-surface text-fg-muted outline-none hover:bg-surface-2 hover:text-fg"
          >
            <Plus size={15} strokeWidth={2.5} />
          </button>
          {addOpen && (
            <PopoverPanel className="min-w-[160px] py-1">
              {availableAttributes.map((a) => (
                <PopoverRow key={a.key} onClick={() => addFilter(a.key)}>{a.label}</PopoverRow>
              ))}
            </PopoverPanel>
          )}
        </div>
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
          className="appearance-none border-0 bg-transparent text-[13px] font-semibold text-accent outline-none hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
