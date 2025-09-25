'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    label?: string;
    error?: string;
    helperText?: string;
    variant?: 'default' | 'form';
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
    ({ className, label, error, helperText, variant = 'default', children, id, ...props }, ref) => {
        const selectId = id || React.useId();

        return (
            <div className="w-full">
                {label && (
                    <label
                        htmlFor={selectId}
                        className="block text-sm font-medium text-text dark:text-text-dark mb-2"
                    >
                        {label}
                    </label>
                )}
                <div className="relative">
                    <select
                        id={selectId}
                        className={cn(
                            'w-full rounded-lg transition-colors outline-none appearance-none cursor-pointer',
                            'text-text dark:text-text-dark',
                            'border border-border dark:border-border-dark',
                            'focus:border-primary',
                            'disabled:bg-surface-tertiary dark:disabled:bg-surface-tertiary-dark',
                            'disabled:text-text-muted dark:disabled:text-text-muted-dark disabled:cursor-not-allowed',
                            // Variant-specific styles
                            variant === 'form' && [
                                'px-4 py-2 pr-10',
                                'bg-surface dark:bg-surface-dark',
                            ],
                            variant === 'default' && [
                                'px-4 py-3 pr-10',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                                'focus:ring-2 focus:ring-primary/20',
                                'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                                'duration-200',
                            ],
                            error &&
                                variant === 'default' &&
                                'border-danger/50 focus:border-danger focus:ring-danger/20',
                            error && variant === 'form' && 'border-danger/50 focus:border-danger',
                            className,
                        )}
                        ref={ref}
                        {...props}
                    >
                        {children}
                    </select>
                    {/* Dropdown arrow icon */}
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                        <svg
                            className="h-5 w-5 text-text-muted dark:text-text-muted-dark"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                        >
                            <path
                                fillRule="evenodd"
                                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                                clipRule="evenodd"
                            />
                        </svg>
                    </div>
                </div>
                {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
                {helperText && !error && (
                    <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {helperText}
                    </p>
                )}
            </div>
        );
    },
);
Select.displayName = 'Select';

export { Select };
