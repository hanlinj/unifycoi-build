import React from 'react';
import { cn } from './cn';

/** Composable table primitives matching the ref data tables (muted header, subtle row rules). */
export function Table({ className, children, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full text-sm text-fg border-collapse', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('text-fg-muted', className)} {...rest}>{children}</thead>;
}

export function TBody({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest}>{children}</tbody>;
}

export function TR({ className, children, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border-muted last:border-0', className)} {...rest}>{children}</tr>;
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
      className={cn('px-3 py-2 text-left font-semibold border-b border-border', sortable && 'cursor-pointer select-none', className)}
      {...rest}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && <span aria-hidden className="text-fg-subtle">{sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : '↕'}</span>}
      </span>
    </th>
  );
}

export function TD({ className, children, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...rest}>{children}</td>;
}
