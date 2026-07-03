import React from 'react';
import { cn } from './cn';

export interface ActionRowProps {
  icon?: React.ReactNode;
  /** Bold lead text (e.g. a count or subject). */
  title: React.ReactNode;
  /** Muted trailing description. */
  description?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  className?: string;
}

/** "Action areas" list row (icon · bold title · muted description · chevron). Maps onto the
 *  exception-first Command Center: each risk item that needs attention is one row. */
export function ActionRow({ icon, title, description, trailing, onClick, href, className }: ActionRowProps) {
  const inner = (
    <>
      {icon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-fg-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-fg">{title}</span>
        {description != null && <span className="text-fg-muted"> {description}</span>}
      </span>
      {trailing ?? <span aria-hidden className="text-fg-subtle">›</span>}
    </>
  );
  const base = cn('flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-surface transition-colors', className);
  if (href) return <a href={href} className={base}>{inner}</a>;
  return <button type="button" onClick={onClick} className={base}>{inner}</button>;
}
