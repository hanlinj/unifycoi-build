import React from 'react';
import { cn } from './cn';

/** Bordered surface card (border-defined, minimal shadow — Primer-family). */
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card border border-border bg-canvas shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-between px-4 py-3 border-b border-border', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold text-fg', className)} {...rest}>{children}</h2>;
}

export function CardBody({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...rest}>{children}</div>;
}

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  selected?: boolean;
  className?: string;
}

/** KPI stat card (uppercase muted label · large value · optional delta). Matches the ref dashboards. */
export function StatCard({ label, value, delta, selected, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-card border bg-canvas px-4 py-3',
        selected ? 'border-accent ring-1 ring-accent' : 'border-border',
        className
      )}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-fg">{value}</div>
      {delta != null && <div className="mt-1 text-xs text-fg-muted">{delta}</div>}
    </div>
  );
}
