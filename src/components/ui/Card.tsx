import React from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from './cn';

/** Section panel — the large rounded container. Hairline border only, no decorative shadow. */
export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section className={cn('rounded-panel border border-border bg-surface p-6', className)} {...rest}>
      {children}
    </section>
  );
}

/** Content card — the medium rounded surface (radius-card). */
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card border border-border bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-between border-b border-border px-5 py-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-[15px] font-bold text-fg', className)} {...rest}>{children}</h2>;
}

export function CardBody({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...rest}>{children}</div>;
}

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  /** delta color intent (default muted; success = up/green, danger = needs-action). */
  deltaTone?: 'muted' | 'success' | 'danger';
  /** Selected/highlighted card (one per row) — blue border + blue value, not a filled block. */
  feature?: boolean;
  /** Value emphasis independent of `feature` — 'danger' colors just the number red (e.g. a
   *  count that's only bad when non-zero); default is neutral. Ignored when `feature` is set
   *  (feature's blue takes precedence, same as before this prop existed). */
  valueTone?: 'neutral' | 'danger';
  /** Number size/weight. 'lg' is a bigger, blacker, tighter-leading number for plain KPI
   *  strips with no delta (e.g. Command Center's stat strip). 'default' is unchanged from
   *  this component's original look (used by /gallery). */
  size?: 'default' | 'lg';
  /** Makes the whole card a link (e.g. "Total vendors" → /vendors). Adds a hover wash in the
   *  existing accent tint token — unlinked cards (no href) get no hover affordance at all. */
  href?: string;
  className?: string;
}

const DELTA: Record<NonNullable<StatCardProps['deltaTone']>, string> = {
  muted: 'text-fg-muted',
  success: 'text-success',
  danger: 'text-danger',
};

const VALUE_SIZE: Record<NonNullable<StatCardProps['size']>, string> = {
  default: 'text-[34px] font-extrabold',
  lg: 'text-[32px] font-black',
};

/** KPI stat card. `feature` = the selected metric (blue border + blue value); others are neutral.
 *  The trend-arrow badge only renders alongside a `delta` — a plain count with no delta gets a
 *  plain card, no decorative icon. */
export function StatCard({
  label,
  value,
  delta,
  deltaTone = 'muted',
  feature,
  valueTone = 'neutral',
  size = 'default',
  href,
  className,
}: StatCardProps) {
  const card = (
    <div
      className={cn(
        'relative flex min-h-[130px] flex-col justify-between rounded-card border bg-surface p-[18px] transition-colors',
        feature ? 'border-accent' : 'border-border',
        href && 'hover:bg-accent-soft',
        className
      )}
    >
      {delta != null && (
        <span
          className={cn(
            'absolute right-4 top-4 grid h-[34px] w-[34px] place-items-center rounded-full border',
            feature ? 'border-transparent bg-accent-soft' : 'border-border bg-surface-2'
          )}
        >
          <ArrowUpRight size={15} strokeWidth={2.5} className={feature ? 'text-accent' : 'text-fg-muted'} />
        </span>
      )}
      <div className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.09em] text-fg-muted">
        {label}
      </div>
      <div
        className={cn(
          VALUE_SIZE[size],
          'leading-none tracking-[-0.03em] tabular-nums',
          feature ? 'text-accent' : valueTone === 'danger' ? 'text-danger' : 'text-fg'
        )}
      >
        {value}
      </div>
      {delta != null && (
        <div className={cn('flex items-center gap-1 text-xs font-semibold', feature ? 'text-accent' : DELTA[deltaTone])}>
          {delta}
        </div>
      )}
    </div>
  );

  return href ? (
    <Link href={href} className="block no-underline">
      {card}
    </Link>
  ) : (
    card
  );
}
