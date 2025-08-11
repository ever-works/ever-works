'use client';

import React, { InputHTMLAttributes, useId } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    helperText?: string;
}

const Input = ({ className, type, label, error, helperText, id, ...props }: InputProps) => {
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
                    'w-full px-4 py-3',
                    'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                    'border border-border dark:border-border-dark',
                    'rounded-lg',
                    'transition-colors duration-200',
                    'outline-none',
                    'focus:border-primary',
                    'focus:ring-2 focus:ring-primary/20',
                    'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                    'disabled:bg-surface-tertiary dark:disabled:bg-surface-tertiary-dark disabled:text-text-muted dark:disabled:text-text-muted-dark disabled:cursor-not-allowed',
                    error && 'border-danger/50 focus:border-danger focus:ring-danger/20',
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
