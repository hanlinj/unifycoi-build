import React from 'react';
import { cn } from './cn';

// Status pill tones (soft tint + colored text). Compliance mapping: approved→success,
// expiring→attention, expired/non-compliant→danger, under-review→info, onboarding→neutral.
export type BadgeTone = 'success' | 'attention' | 'danger' | 'info' | 'neutral';

const TONE: Record<BadgeTone, string> = {
  success: 'bg-success-soft text-success',
  attention: 'bg-attention-soft text-[#A6791A]',
  danger: 'bg-danger-soft text-[#C0392E]',
  info: 'bg-info-soft text-info-ink',
  neutral: 'bg-surface-2 text-fg-muted',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded-pill px-3 py-1.5 text-xs font-semibold leading-none whitespace-nowrap', TONE[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}
