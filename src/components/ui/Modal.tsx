'use client';

import React from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

/** Dialog with overlay. Esc closes; overlay click closes; content click doesn't. */
export function Modal({ open, onClose, title, children, footer, className }: ModalProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,18,22,0.4)] p-4"
      onClick={onClose}
      data-testid="modal-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('w-full max-w-[420px] overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_24px_60px_-20px_rgba(17,18,22,0.4)]', className)}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-[22px] pt-5">
            <h2 className="text-base font-bold text-fg">{title}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-surface-2 text-fg-muted hover:text-fg"
            >
              <X size={15} strokeWidth={2.5} />
            </button>
          </div>
        )}
        <div className="px-[22px] py-[18px] text-sm text-[#5B5C63]">{children}</div>
        {footer && <div className="flex justify-end gap-2.5 px-[22px] pb-[22px]">{footer}</div>}
      </div>
    </div>
  );
}
