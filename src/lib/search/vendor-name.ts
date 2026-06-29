// Simple vendor name matching (Search.md v1) behind a swappable interface.
//
// v1 = case- and punctuation-insensitive prefix/substring, computed in-process. The FTS5 /
// fuzzy upgrade (Search.md "deferred") swaps the implementation behind VendorNameMatcher
// without touching callers.

export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface VendorNameMatcher {
  /** true when `query` matches `name` under the v1 rules. Empty query matches everything. */
  matches(name: string, query: string): boolean;
}

export const simpleVendorNameMatcher: VendorNameMatcher = {
  matches(name: string, query: string): boolean {
    const q = normalizeForSearch(query);
    if (q.length === 0) return true;
    return normalizeForSearch(name).includes(q);
  },
};
