// One role-conditional sidebar definition (Navigation.md). Pure + tested. Entries link ONLY to
// surfaces that exist in v1 — never a door that 404s/403s. Unbuilt destinations (Org Settings,
// Vendors directory, the platform shell) are intentionally absent and banked in launch-prep.

export interface NavItem { label: string; href: string }
export interface NavSection { title?: string; items: NavItem[] }

export function navForRole(role: string): NavSection[] {
  switch (role) {
    case 'admin':
      return [
        { title: 'Monitor', items: [
          { label: 'Home', href: '/command-center' },
          { label: 'Vendors', href: '/vendors' },
          { label: 'Reports', href: '/reports' },
        ] },
        { title: 'Configure', items: [
          { label: 'Requirements', href: '/settings/requirements' },
          { label: 'Locations', href: '/locations' },
          { label: 'Users', href: '/users' },
        ] },
      ];
    case 'district_manager':
      return [{ items: [
        { label: 'Home', href: '/command-center' },
        { label: 'Vendors', href: '/vendors' },
        { label: 'Operations', href: '/dashboard' },
        { label: 'Reports', href: '/reports' },
        { label: 'Locations', href: '/locations' },
        { label: 'Users', href: '/users' },
      ] }];
    case 'store_manager':
      return [{ items: [
        { label: 'Home', href: '/dashboard' },
        { label: 'My Stores', href: '/locations' },
      ] }];
    default:
      return [];
  }
}

/** Whether the tenant app chrome (sidebar + header) should render for a given path.
 *  Hidden on the login screen, the public vendor token flow, the credential-set and
 *  billing-setup landing pages, the root redirect, and the platform placeholder (platform
 *  users get no tenant chrome). */
export function shouldShowChrome(pathname: string): boolean {
  if (pathname === '/' || pathname === '/login') return false;
  if (pathname.startsWith('/reset-password')) return false; // unauthenticated, token-in-URL page
  if (pathname.startsWith('/billing/setup')) return false;  // unauthenticated, token-in-URL page
  if (pathname.startsWith('/v/')) return false;       // public tokenized vendor flow — no leak
  if (pathname.startsWith('/platform')) return false; // platform altitude, separate shell
  return true;
}

/** Active-state test for a nav item against the current path (exact or nested). */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
