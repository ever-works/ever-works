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
                <label htmlFor={inputId} className="block text-sm font-medium text-text mb-2">
                    {label}
                </label>
            )}
            <input
                type={type}
                id={inputId}
                className={cn(
                    'w-full px-4 py-3',
                    'text-text placeholder-text-muted',
                    'bg-surface-secondary',
                    'border border-border',
                    'rounded-lg',
                    'transition-colors duration-200',
                    'outline-none',
                    'focus:border-primary',
                    'focus:ring-2 focus:ring-primary/20',
                    'hover:border-border-secondary',
                    'disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed',
                    error && 'border-danger/50 focus:border-danger focus:ring-danger/20',
                    className,
                )}
                {...props}
            />
            {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
            {helperText && !error && <p className="mt-1.5 text-xs text-text-muted">{helperText}</p>}
        </div>
    );
};

export { Input };
