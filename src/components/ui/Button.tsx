import React from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'success' | 'danger' | 'default' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT: Record<ButtonVariant, string> = {
  // primary = the brand action (provision, create). success = affirmative (approve).
  primary: 'bg-accent text-white border border-transparent hover:bg-accent-emphasis',
  success: 'bg-success text-white border border-transparent hover:bg-success-emphasis',
  danger: 'bg-danger text-white border border-transparent hover:bg-danger-emphasis',
  default: 'bg-canvas text-fg border border-border hover:bg-surface',
  ghost: 'bg-transparent text-fg border border-transparent hover:bg-surface',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
};

/** Button primitive. Variants map to semantic tokens; sizes match the compact ops-dashboard density. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:pointer-events-none',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    />
  );
});
