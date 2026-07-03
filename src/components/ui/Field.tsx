import React from 'react';
import { cn } from './cn';

const CONTROL = cn(
  'w-full rounded-md border border-border bg-canvas text-fg placeholder:text-fg-subtle',
  'px-3 h-8 text-sm transition-colors',
  'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
  'disabled:opacity-50 disabled:bg-surface'
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...rest }, ref) {
    return <input ref={ref} type={type} className={cn(CONTROL, className)} {...rest} />;
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={cn(CONTROL, 'h-auto py-2', className)} {...rest} />;
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, 'pr-8', className)} {...rest}>
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

/** Label + control + help/error. Error takes precedence over help and is announced to AT. */
export function FormField({ label, htmlFor, required, error, help, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
        {required && <span className="text-danger-fg"> *</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger-fg">{error}</p>
      ) : help ? (
        <p className="text-xs text-fg-muted">{help}</p>
      ) : null}
    </div>
  );
}
