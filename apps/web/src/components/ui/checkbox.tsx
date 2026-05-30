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
        <div>
            <label
                htmlFor={checkboxId}
                className={cn(
                    'inline-flex items-center gap-2.5 cursor-pointer select-none',
                    'rounded-lg border border-border/60 dark:border-border-dark/60',
                    'bg-card dark:bg-card-primary-dark',
                    'px-2 py-1',
                    'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors',
                    props.disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
                )}
            >
                <input
                    type="checkbox"
                    id={checkboxId}
                    className={cn(
                        'w-3.5 h-3.5 shrink-0 rounded border transition-colors',
                        'border-border dark:border-border-dark',
                        'text-primary focus:ring-primary focus:ring-2 focus:ring-offset-0',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        variant === 'form' && 'bg-surface dark:bg-surface-dark',
                        variant === 'default' && 'bg-surface-secondary dark:bg-surface-secondary-dark',
                        error && 'border-danger/50 focus:ring-danger/20',
                        className,
                    )}
                    {...props}
                />
                {(label || description) && (
                    <div className="flex-1 min-w-0">
                        {label && (
                            <span className="text-xs text-text dark:text-text-dark leading-none">
                                {label}
                            </span>
                        )}
                        {description && (
                            <p className="text-[11px] text-text-muted dark:text-text-muted-dark mt-0.5 leading-snug">
                                {description}
                            </p>
                        )}
                    </div>
                )}
            </label>
            {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </div>
    );
};

export { Checkbox };
