// Platform (super-admin) sidebar — SEPARATE from the tenant nav (invariant #12). Pure + tested.
// "Tenants" (Slice 2) and "Provisioning" (Slice 4) are built; the rest are shown as
// planned/disabled (NOT dead links — they never navigate) and get enabled as their slices land.
// Full intended set per Platform_Super_Admin_Console.md.

export interface PlatformNavItem {
  label: string;
  href: string;
  icon: string; // resolved to a lucide icon in the shell
  soon?: boolean; // planned, not yet built → rendered disabled
}

export const PLATFORM_NAV: PlatformNavItem[] = [
  { label: 'Tenants', href: '/platform', icon: 'building' },
  { label: 'Provisioning', href: '/platform/provisioning', icon: 'plus-circle' },
  { label: 'Billing', href: '/platform/billing', icon: 'credit-card', soon: true },
  { label: 'Health', href: '/platform/health', icon: 'activity', soon: true },
  { label: 'Settings', href: '/platform/settings', icon: 'settings', soon: true },
];

/** Active-state for a platform nav item. Tenants owns the fleet AND tenant-detail routes. */
export function isPlatformItemActive(pathname: string, href: string): boolean {
  if (href === '/platform') return pathname === '/platform' || pathname.startsWith('/platform/tenants');
  return pathname === href || pathname.startsWith(`${href}/`);
}
