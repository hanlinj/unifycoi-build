import React from 'react';
import { cn } from './cn';

const CONTROL = cn(
  'w-full rounded-ctl border border-control bg-surface text-fg text-sm',
  'px-[16px] py-[12px] placeholder:text-[#B7B8BE] transition-[border-color,box-shadow] duration-200 ease-out',
  'focus:outline-none focus:border-accent focus:shadow-ring-soft',
  'disabled:opacity-60 disabled:bg-surface-2'
);

// Native-arrow-suppressed select with the design system's chevron (fg-muted).
const SELECT_CHEVRON =
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2357606A' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")] bg-no-repeat bg-[right_14px_center] appearance-none pr-10";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', 'aria-invalid': ai, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={ai}
        className={cn(CONTROL, ai && 'border-danger focus:border-danger shadow-[0_0_0_4px_rgba(207,34,46,0.16)]', className)}
        {...rest}
      />
    );
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={cn(CONTROL, className)} {...rest} />;
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, SELECT_CHEVRON, className)} {...rest}>
        {children}
      </select>
    );
  }
);

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string | null;
  help?: string;
  children: React.ReactNode;
  className?: string;
}

/** Label + control + help/error. Error takes precedence over help and is announced (role=alert). */
export function FormField({ label, htmlFor, required, error, help, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      <label htmlFor={htmlFor} className="mb-[7px] block text-[13px] font-semibold text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-[7px] text-xs font-medium text-danger">{error}</p>
      ) : help ? (
        <p className="mt-[7px] text-xs text-fg-muted">{help}</p>
      ) : null}
    </div>
  );
}
