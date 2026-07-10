import React from 'react';
import { Info, CheckCircle2, AlertTriangle, ShieldAlert, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

export type AlertTone = 'info' | 'success' | 'attention' | 'danger';

// Status-pill treatment, not a saturated banner: pale tint + colored icon + the same darker
// tone Badge already uses for text — no border. Same four semantic colors, a fraction of the
// intensity of a filled block.
const TONE: Record<AlertTone, { box: string; text: string; icon: string; defaultIcon: LucideIcon }> = {
  info: { box: 'bg-info-soft', text: 'text-info-ink', icon: 'text-info', defaultIcon: Info },
  success: { box: 'bg-success-soft', text: 'text-success', icon: 'text-success', defaultIcon: CheckCircle2 },
  attention: { box: 'bg-attention-soft', text: 'text-attention', icon: 'text-attention', defaultIcon: AlertTriangle },
  danger: { box: 'bg-danger-soft', text: 'text-danger', icon: 'text-danger', defaultIcon: ShieldAlert },
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  title?: string;
  icon?: React.ReactNode;
}

/** Inline alert / toast body. Soft-tinted surface, tone icon, title + text. */
export function Alert({ tone = 'info', title, icon, className, children, ...rest }: AlertProps) {
  const t = TONE[tone];
  const Icon = t.defaultIcon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-card px-[18px] py-[15px]', t.box, className)}
      {...rest}
    >
      <span className={cn('mt-0.5 flex-none', t.icon)}>{icon ?? <Icon size={18} strokeWidth={2} />}</span>
      <div>
        {title && <h4 className={cn('mb-0.5 text-sm font-bold', t.text)}>{title}</h4>}
        {children && <p className={cn('text-[13px]', t.text)}>{children}</p>}
      </div>
    </div>
  );
}
