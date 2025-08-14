'use client';

import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg' | 'icon';
    fullWidth?: boolean;
    asChild?: boolean;
    href?: string;
    loading?: boolean;
}

const buttonVariants = {
    primary: 'bg-primary hover:bg-primary-hover text-white',
    secondary:
        'bg-surface-secondary dark:bg-surface-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark border border-border dark:border-border-dark text-text dark:text-text-dark',
    ghost: 'bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-text dark:text-text-dark',
    danger: 'bg-danger hover:bg-danger/90 text-white',
};

const buttonSizes = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-3',
    lg: 'px-6 py-3',
    icon: 'p-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    (
        {
            className,
            variant = 'primary',
            size = 'md',
            fullWidth = false,
            asChild = false,
            href,
            loading = false,
            disabled,
            children,
            ...props
        },
        ref,
    ) => {
        const classes = cn(
            'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            buttonVariants[variant],
            buttonSizes[size],
            fullWidth && 'w-full',
            className,
        );

        if (href && !disabled) {
            return (
                <Link href={href} className={classes}>
                    {loading && (
                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    )}
                    {children}
                </Link>
            );
        }

        return (
            <button ref={ref} disabled={disabled || loading} className={classes} {...props}>
                {loading && (
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
                {children}
            </button>
        );
    },
);

Button.displayName = 'Button';
