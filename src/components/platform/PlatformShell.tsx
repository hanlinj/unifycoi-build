'use client';

// The SEPARATE platform shell (invariant #12): its own sidebar + header, NOT the tenant
// AppShell. Rendered only for platform users under /platform (the layout gates auth). The
// tenant chrome never renders here (shouldShowChrome('/platform') === false).

import { usePathname } from 'next/navigation';
import { Hexagon, Building2, PlusCircle, CreditCard, Activity, Settings, LogOut, type LucideIcon } from 'lucide-react';
import { PLATFORM_NAV, isPlatformItemActive } from '@/lib/platform-nav';
import { cn } from '@/components/ui';

const ICONS: Record<string, LucideIcon> = {
  building: Building2,
  'plus-circle': PlusCircle,
  'credit-card': CreditCard,
  activity: Activity,
  settings: Settings,
};

export function PlatformShell({ userName, userRole, children }: { userName: string; userRole: string; children: React.ReactNode }) {
  const pathname = usePathname() ?? '/platform';

  return (
    <div className="ds-canvas flex min-h-screen font-sans text-fg">
      <nav aria-label="Platform" className="flex w-[236px] flex-none flex-col gap-1 border-r border-border bg-surface px-3 py-5">
        <div className="mb-5 flex items-center gap-2.5 px-2">
          <span className="grid h-9 w-9 place-items-center rounded-ctl bg-action">
            <Hexagon size={18} strokeWidth={2} className="text-white" />
          </span>
          <div>
            <div className="text-[15px] font-extrabold leading-none tracking-[-0.02em]">UnifyCOI</div>
            <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-muted">Platform</div>
          </div>
        </div>

        {PLATFORM_NAV.map((item) => {
          const Icon = ICONS[item.icon] ?? Building2;
          if (item.soon) {
            return (
              <span key={item.href} aria-disabled className="flex cursor-default items-center gap-2.5 rounded-ctl px-2.5 py-2 text-sm font-medium text-fg-muted opacity-55">
                <Icon size={17} strokeWidth={2} />
                <span className="flex-1">{item.label}</span>
                <span className="rounded-pill bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-muted">Soon</span>
              </span>
            );
          }
          const active = isPlatformItemActive(pathname, item.href);
          return (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-ctl px-2.5 py-2 text-sm font-semibold transition-colors',
                active ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
              )}
            >
              <Icon size={17} strokeWidth={2} className={active ? 'text-accent' : ''} />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-surface px-6">
          <div className="flex-1" />
          <div className="text-right text-[13px] leading-tight">
            <div className="font-semibold text-fg">{userName}</div>
            <div className="text-[11px] capitalize text-fg-muted">Platform {userRole}</div>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-ctl border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-fg hover:bg-surface-2">
              <LogOut size={14} strokeWidth={2.5} /> Log out
            </button>
          </form>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
