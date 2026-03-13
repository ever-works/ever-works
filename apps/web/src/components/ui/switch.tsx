'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';

export interface SwitchProps {
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    label?: string;
    helperText?: string;
    className?: string;
}

const Switch = React.forwardRef<HTMLDivElement, SwitchProps>(
    ({ checked = false, onChange, disabled = false, label, helperText, className }, ref) => {
        const handleClick = () => {
            if (!disabled && onChange) {
                onChange(!checked);
            }
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
            if (!disabled && onChange && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onChange(!checked);
            }
        };

        return (
            <div className={cn('flex items-center space-x-3 mt-2', className)} ref={ref}>
                <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    disabled={disabled}
                    onClick={handleClick}
                    onKeyDown={handleKeyDown}
                    className={cn(
                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                        'focus:outline-none focus:ring-2 focus:ring-ring dark:focus:ring-ring-dark focus:ring-offset-2',
                        'focus:ring-offset-background dark:focus:ring-offset-background-dark',
                        checked
                            ? 'bg-primary dark:bg-primary-dark'
                            : 'bg-gray-300 dark:bg-gray-600',
                        disabled && 'cursor-not-allowed opacity-50',
                    )}
                >
                    <span
                        className={cn(
                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                            checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
                        )}
                    />
                </button>
                {(label || helperText) && (
                    <div className="flex-1">
                        {label && (
                            <label className="block text-sm font-medium text-text dark:text-text-dark">
                                {label}
                            </label>
                        )}
                        {helperText && (
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-1">
                                {helperText}
                            </p>
                        )}
                    </div>
                )}
            </div>
        );
    },
);
Switch.displayName = 'Switch';

export { Switch };
