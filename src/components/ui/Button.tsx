import React from 'react';
import { cn } from './cn';

// Variants: primary/accent both resolve to the single restored blue accent (no second action
// color) — kept as two variant names for call-site stability, not two colors.
export type ButtonVariant = 'primary' | 'accent' | 'danger' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-emphasis',
  accent: 'bg-accent text-white font-bold hover:bg-accent-emphasis',
  danger: 'bg-danger text-white hover:bg-danger-emphasis',
  outline: 'bg-surface text-fg border-border-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-[13px] py-2 text-[13px]',
  md: 'px-[18px] py-[11px] text-sm',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-ctl border border-transparent font-semibold leading-none whitespace-nowrap',
        'transition-[transform,box-shadow,background,filter] duration-100 active:translate-y-px',
        'disabled:bg-surface-2 disabled:text-[#B7B8BE] disabled:border-border disabled:shadow-none disabled:pointer-events-none disabled:font-semibold',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    />
  );
});
