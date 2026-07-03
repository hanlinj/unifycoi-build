import React from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'attention' | 'danger';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-surface text-fg-muted border-border',
  accent: 'bg-accent-subtle text-accent-fg border-transparent',
  success: 'bg-success-subtle text-success-fg border-transparent',
  attention: 'bg-attention-subtle text-attention-fg border-transparent',
  danger: 'bg-danger-subtle text-danger-fg border-transparent',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** Status pill. Compliance mapping (consumer's choice): approved→success, expiring→attention,
 *  expired/non-compliant→danger, under-review→accent, onboarding→neutral. */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
