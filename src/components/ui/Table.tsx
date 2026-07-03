import React from 'react';
import { cn } from './cn';

/** Composable table matching the design system (uppercase micro-headers, row rules, hover). */
export function Table({ className, children, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm text-fg', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...rest}>{children}</thead>;
}

export function TBody({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest}>{children}</tbody>;
}

export function TR({ className, children, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('[&:hover>td]:bg-surface-2', className)} {...rest}>{children}</tr>;
}

export interface THProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  sort?: 'asc' | 'desc' | null; // null = sortable but unsorted; undefined = not sortable
}

export function TH({ sort, className, children, ...rest }: THProps) {
  const sortable = sort !== undefined;
  return (
    <th
      scope="col"
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : sortable ? 'none' : undefined}
      className={cn(
        'border-b border-border px-3 pb-[14px] text-left text-[11px] font-bold uppercase tracking-[0.07em] text-fg-muted',
        sortable && 'cursor-pointer select-none',
        className
      )}
      {...rest}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && <span aria-hidden className="text-[#C3C4CA]">{sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : '↕'}</span>}
      </span>
    </th>
  );
}

export function TD({ className, children, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-border px-3 py-[15px] align-middle transition-colors', className)} {...rest}>{children}</td>;
}
