// Simple location name matching (Search.md v1), behind a swappable interface mirroring
// VendorNameMatcher — the same FTS5-later seam. v1 = case/punctuation-insensitive substring.

import { normalizeForSearch } from './vendor-name';

export interface LocationNameMatcher {
  /** true when `query` matches `name` under the v1 rules. Empty query matches everything. */
  matches(name: string, query: string): boolean;
}

export const simpleLocationNameMatcher: LocationNameMatcher = {
  matches(name: string, query: string): boolean {
    const q = normalizeForSearch(query);
    if (q.length === 0) return true;
    return normalizeForSearch(name).includes(q);
  },
};
