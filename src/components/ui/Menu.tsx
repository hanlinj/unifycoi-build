'use client';

import React from 'react';
import { cn } from './cn';

export interface MenuProps {
  /** The trigger element (e.g. a kebab button). Its onClick is wrapped to toggle the menu. */
  trigger: React.ReactElement;
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Whether clicking inside the menu body closes it. Default true (a single-select action
   *  list, e.g. FleetRoster's row menu). Set false for multi-select content (e.g. a filter's
   *  checkbox value picker) that must stay open while several items are toggled — outside
   *  click and Esc still close it either way. */
  closeOnItemClick?: boolean;
  /** Controlled open state, for callers that need to open/close the menu programmatically
   *  (e.g. auto-opening a just-created filter's value picker). Uncontrolled (internal state)
   *  when omitted — existing callers are unaffected. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Dropdown menu. Closes on outside click, Esc, or (by default) selecting an item. */
export function Menu({ trigger, children, align = 'right', className, closeOnItemClick = true, open: openProp, onOpenChange }: MenuProps) {
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = React.useCallback(
    (next: boolean | ((o: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(open) : next;
      setOpenState(resolved);
      onOpenChange?.(resolved);
    },
    [open, onOpenChange]
  );
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, setOpen]);

  const triggerWithToggle = React.cloneElement(trigger, {
    onClick: () => setOpen((o: boolean) => !o),
    'aria-haspopup': 'menu',
    'aria-expanded': open,
  });

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      {triggerWithToggle}
      {open && (
        <div
          role="menu"
          onClick={closeOnItemClick ? () => setOpen(false) : undefined}
          className={cn(
            'absolute z-20 mt-1 min-w-[160px] overflow-hidden rounded-ctl border border-border bg-surface py-1 shadow-overlay',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps {
  href?: string;
  onClick?: () => void;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}

export function MenuItem({ href, onClick, tone = 'default', children }: MenuItemProps) {
  const cls = cn(
    'block w-full px-3.5 py-2 text-left text-sm hover:bg-surface-2',
    tone === 'danger' ? 'text-danger' : 'text-fg'
  );
  if (href) return <a role="menuitem" href={href} className={cls}>{children}</a>;
  return <button role="menuitem" type="button" onClick={onClick} className={cls}>{children}</button>;
}
