'use client';

// A minimal popover, purpose-built for the filter bar's pickers. NOT the design-system Menu:
// Menu's own popover panel is a child of the caller's DOM position, and the filter chip needs
// its outer pill visual to be `overflow: hidden` (for the flush rounded-corner look) — nesting
// Menu's absolutely-positioned panel inside that clipped container silently clips the panel
// itself off-screen (confirmed live: the panel exists in the DOM with display:block, but sits
// entirely below the 27px-tall clipped box, so elementFromPoint at its center hits the table
// header underneath, not the panel — every click on it was landing on the table). This popover
// is always rendered as a sibling of the clipped visual, inside a plain (non-clipping)
// `position: relative` wrapper, so it's never subject to an ancestor's overflow:hidden.
//
// Also: Tailwind `preflight` is off app-wide (tailwind.config.ts), so a bare <button> keeps the
// browser's native 3D chrome (confirmed live: `border: 2px outset black`, `appearance: auto`,
// `background: buttonface`) unless explicitly reset. PopoverRow resets it; Menu/MenuItem do not
// (a separate, pre-existing gap — out of scope here, this file doesn't touch that primitive).

import { useEffect, useRef } from 'react';
import { cn } from '@/components/ui';

/** Closes on outside mousedown or Esc while `active`. Attach the returned ref to the element
 *  that should be treated as "inside" (clicks inside it never count as outside). */
export function useOutsideClose(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, onClose]);
  return ref;
}

/** The floating surface — white background, hairline border, rounded, subtle shadow. Always
 *  position this as a sibling of whatever visual needs its own overflow-hidden, never a child
 *  of it (see module doc). */
export function PopoverPanel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      role="menu"
      className={cn(
        'absolute left-0 top-full z-20 mt-1 overflow-hidden rounded-ctl border-solid border-[0.5px] border-border bg-surface shadow-overlay',
        className
      )}
    >
      {children}
    </div>
  );
}

/** A plain single-select row — no border, no native button chrome (explicitly reset since
 *  preflight is off), hover tints the row. */
export function PopoverRow({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'block w-full appearance-none border-0 bg-transparent px-3.5 py-2 text-left text-sm text-fg outline-none',
        'hover:bg-surface-2',
        active && 'bg-surface-2 font-semibold'
      )}
    >
      {children}
    </button>
  );
}
