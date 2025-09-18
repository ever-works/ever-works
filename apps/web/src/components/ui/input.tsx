'use client';

import React, { InputHTMLAttributes, useId } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    helperText?: string;
    variant?: 'default' | 'form';
}

const Input = ({ className, type, label, error, helperText, id, variant = 'default', ...props }: InputProps) => {
    const inputReactId = useId();
    const inputId = id || inputReactId;

    return (
        <div className="w-full">
            {label && (
                <label htmlFor={inputId} className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {label}
                </label>
            )}
            <input
                type={type}
                id={inputId}
                className={cn(
                    'w-full rounded-lg transition-colors outline-none',
                    'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                    'border border-border dark:border-border-dark',
                    'focus:border-primary',
                    'disabled:bg-surface-tertiary dark:disabled:bg-surface-tertiary-dark disabled:text-text-muted dark:disabled:text-text-muted-dark disabled:cursor-not-allowed',
                    // Variant-specific styles
                    variant === 'form' && [
                        'px-4 py-2',
                        'bg-surface dark:bg-surface-dark',
                    ],
                    variant === 'default' && [
                        'px-4 py-3',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'focus:ring-2 focus:ring-primary/20',
                        'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                        'duration-200',
                    ],
                    error && variant === 'default' && 'border-danger/50 focus:border-danger focus:ring-danger/20',
                    error && variant === 'form' && 'border-danger/50 focus:border-danger',
                    className,
                )}
                {...props}
            />
            {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
            {helperText && !error && <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">{helperText}</p>}
        </div>
    );
};

export { Input };
