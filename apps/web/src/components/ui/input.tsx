'use client';

import { InputHTMLAttributes, useId, useRef } from 'react';
import { cn } from '@/lib/utils';
import { ChevronUp, ChevronDown } from 'lucide-react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    helperText?: string;
    variant?: 'default' | 'form';
}

const Input = ({
    className,
    type,
    label,
    error,
    helperText,
    id,
    variant = 'default',
    ...props
}: InputProps) => {
    const inputReactId = useId();
    const inputId = id || inputReactId;
    const inputRef = useRef<HTMLInputElement>(null);
    const isNumber = type === 'number';

    const handleStep = (direction: 'up' | 'down') => {
        const input = inputRef.current;
        if (!input) return;
        const step = Number(input.step) || 1;
        const current = Number(input.value) || 0;
        const min = input.min !== '' ? Number(input.min) : -Infinity;
        const max = input.max !== '' ? Number(input.max) : Infinity;
        const newValue =
            direction === 'up' ? Math.min(current + step, max) : Math.max(current - step, min);
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        setter?.call(input, String(newValue));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const inputElement = (
        <input
            ref={isNumber ? inputRef : undefined}
            type={type}
            id={inputId}
            className={cn(
                'w-full text-sm rounded-lg transition-colors outline-none',
                'bg-card dark:bg-card-primary-dark',
                'border border-card-border dark:border-white/9',
                'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                'focus:border-primary dark:focus:border-white/9',
                'disabled:bg-surface-tertiary dark:disabled:bg-white/9 disabled:text-text-muted dark:disabled:text-text-muted-dark disabled:cursor-not-allowed',
                isNumber &&
                    '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none pr-8',
                // Variant-specific styles
                variant === 'form' && ['px-4 py-2'],
                variant === 'default' && [
                    'px-4 py-2',
                    'focus:ring-2 focus:ring-primary-800/20',
                    'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                    'duration-200',
                ],
                error &&
                    variant === 'default' &&
                    'border-danger/50 focus:border-danger focus:ring-danger/20',
                error && variant === 'form' && 'border-danger/50 focus:border-danger',
                className,
            )}
            {...props}
        />
    );

    return (
        <div className="w-full">
            {label && (
                <label
                    htmlFor={inputId}
                    className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                >
                    {label}
                </label>
            )}
            {isNumber ? (
                <div className="relative">
                    {inputElement}
                    <div className="absolute right-0 inset-y-0 flex flex-col border-l border-card-border dark:border-white/9 rounded-r-lg overflow-hidden">
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-label="Increment"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                handleStep('up');
                            }}
                            disabled={props.disabled}
                            className={cn(
                                'flex-1 flex items-center justify-center px-1 cursor-pointer',
                                'text-text-muted dark:text-text-muted-dark',
                                'hover:bg-primary/10 hover:text-primary',
                                'disabled:opacity-40 disabled:cursor-not-allowed',
                                'transition-colors border-b border-card-border dark:border-white/9',
                            )}
                        >
                            <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-label="Decrement"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                handleStep('down');
                            }}
                            disabled={props.disabled}
                            className={cn(
                                'flex-1 flex items-center justify-center px-1 cursor-pointer',
                                'text-text-muted dark:text-text-muted-dark',
                                'hover:bg-primary/10 hover:text-primary',
                                'disabled:opacity-40 disabled:cursor-not-allowed',
                                'transition-colors',
                            )}
                        >
                            <ChevronDown className="w-3 h-3" />
                        </button>
                    </div>
                </div>
            ) : (
                inputElement
            )}
            {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
            {helperText && !error && (
                <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {helperText}
                </p>
            )}
        </div>
    );
};

export { Input };
