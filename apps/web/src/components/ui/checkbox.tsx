'use client';

import React, { InputHTMLAttributes, useId } from 'react';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
    label?: string;
    description?: string;
    error?: string;
    variant?: 'default' | 'form';
}

const Checkbox = ({
    className,
    label,
    description,
    error,
    id,
    variant = 'default',
    ...props
}: CheckboxProps) => {
    const checkboxReactId = useId();
    const checkboxId = id || checkboxReactId;

    return (
        <div className="w-full">
            <label htmlFor={checkboxId} className="flex items-center gap-3 cursor-pointer">
                <input
                    type="checkbox"
                    id={checkboxId}
                    className={cn(
                        'w-4 h-4 mt-0.5 rounded border transition-colors',
                        'border-border dark:border-border-dark',
                        'text-primary focus:ring-primary focus:ring-2 focus:ring-offset-0',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        // Variant-specific styles
                        variant === 'form' && ['bg-surface dark:bg-surface-dark'],
                        variant === 'default' && [
                            'bg-surface-secondary dark:bg-surface-secondary-dark',
                        ],
                        error && 'border-danger/50 focus:ring-danger/20',
                        className,
                    )}
                    {...props}
                />
                {(label || description) && (
                    <div className="flex-1">
                        {label && (
                            <span className="text-sm font-medium text-text dark:text-text-dark">
                                {label}
                            </span>
                        )}
                        {description && (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                {description}
                            </p>
                        )}
                    </div>
                )}
            </label>
            {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
        </div>
    );
};

export { Checkbox };
