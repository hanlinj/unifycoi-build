import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

export type ActionTone = 'danger' | 'attention' | 'info' | 'neutral';

const ICON_TILE: Record<ActionTone, string> = {
  danger: 'bg-danger-soft text-danger',
  attention: 'bg-attention-soft text-attention',
  info: 'bg-info-soft text-info-ink',
  neutral: 'bg-surface-2 text-fg-muted',
};

export interface ActionRowProps {
  icon?: React.ReactNode;
  /** tone of the icon tile (severity). */
  tone?: ActionTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  className?: string;
}

/** "Action areas" row (tone icon tile · bold title · muted description · chevron). Maps onto
 *  the exception-first Command Center: each risk item needing attention is one row. */
export function ActionRow({ icon, tone = 'neutral', title, description, trailing, onClick, href, className }: ActionRowProps) {
  const inner = (
    <>
      {icon && <span className={cn('grid h-[38px] w-[38px] flex-none place-items-center rounded-[11px]', ICON_TILE[tone])}>{icon}</span>}
      <span className="min-w-0 flex-1 text-sm">
        <b className="font-bold text-fg">{title}</b>
        {description != null && <span className="text-fg-muted"> {description}</span>}
      </span>
      {trailing ?? <ChevronRight size={18} strokeWidth={2.5} className="flex-none text-[#C3C4CA]" />}
    </>
  );
  const base = cn('flex w-full items-center gap-3.5 rounded-xl px-1 py-3.5 text-left transition-colors hover:bg-surface-2', className);
  if (href) return <a href={href} className={base}>{inner}</a>;
  return <button type="button" onClick={onClick} className={base}>{inner}</button>;
}
