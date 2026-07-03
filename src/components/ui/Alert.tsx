import React from 'react';
import { Info, CheckCircle2, AlertTriangle, ShieldAlert, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

export type AlertTone = 'info' | 'success' | 'attention' | 'danger';

const TONE: Record<AlertTone, { box: string; title: string; text: string; icon: string; defaultIcon: LucideIcon }> = {
  info: { box: 'bg-info-soft border-[rgba(110,139,232,0.22)]', title: 'text-info-ink', text: 'text-[#5568B4]', icon: 'text-info', defaultIcon: Info },
  success: { box: 'bg-success-soft border-[rgba(47,162,106,0.22)]', title: 'text-[#1E7A4D]', text: 'text-[#3B8F63]', icon: 'text-success', defaultIcon: CheckCircle2 },
  attention: { box: 'bg-attention-soft border-[rgba(215,154,42,0.28)]', title: 'text-[#8A6412]', text: 'text-[#9A7420]', icon: 'text-attention', defaultIcon: AlertTriangle },
  danger: { box: 'bg-danger-soft border-[rgba(224,87,76,0.24)]', title: 'text-[#B23A2E]', text: 'text-[#B85045]', icon: 'text-danger', defaultIcon: ShieldAlert },
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
      className={cn('flex items-start gap-3 rounded-card border px-[18px] py-[15px]', t.box, className)}
      {...rest}
    >
      <span className={cn('mt-0.5 flex-none', t.icon)}>{icon ?? <Icon size={18} strokeWidth={2} />}</span>
      <div>
        {title && <h4 className={cn('mb-0.5 text-sm font-bold', t.title)}>{title}</h4>}
        {children && <p className={cn('text-[13px]', t.text)}>{children}</p>}
      </div>
    </div>
  );
}
