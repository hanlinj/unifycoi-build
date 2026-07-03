import React from 'react';
import { cn } from './cn';

export type AlertTone = 'info' | 'success' | 'attention' | 'danger';

const TONE: Record<AlertTone, string> = {
  info: 'bg-accent-subtle border-accent text-fg',
  success: 'bg-success-subtle border-success text-fg',
  attention: 'bg-attention-subtle border-attention text-fg',
  danger: 'bg-danger-subtle border-danger text-fg',
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
  title?: string;
}

/** Inline alert / banner (also the toast body). Left-accented, token-tinted surface. */
export function Alert({ tone = 'info', title, className, children, ...rest }: AlertProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-md border border-l-4 px-3 py-2 text-sm', TONE[tone], className)}
      {...rest}
    >
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={cn(title && 'mt-0.5', 'text-fg-muted')}>{children}</div>}
    </div>
  );
}
