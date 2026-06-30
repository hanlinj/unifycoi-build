// Default landing per role (Navigation.md). District is oversight-first (Command Center),
// Store is operational (Dashboard), Admin oversight-first, Platform → the platform shell.
// Pure + tested; the root route uses it to redirect after authentication.

export function landingPathFor(input: { type: 'tenant' | 'platform'; role: string }): string {
  if (input.type === 'platform') return '/platform';
  switch (input.role) {
    case 'admin':
    case 'district_manager':
      return '/command-center';
    case 'store_manager':
      return '/dashboard';
    default:
      return '/dashboard';
  }
}
