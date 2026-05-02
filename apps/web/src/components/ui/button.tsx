'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Link } from '@/i18n/navigation';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'unstyled';
    size?: 'sm' | 'md' | 'lg' | 'icon';
    fullWidth?: boolean;
    asChild?: boolean;
    href?: string;
    loading?: boolean;
    target?: string;
    rel?: string;
}

type ButtonLinkProps = {
    href: string;
    className?: string;
    target?: string;
    rel?: string;
    children?: ReactNode;
};

const LinkComponent = Link as unknown as React.ComponentType<ButtonLinkProps>;

const buttonVariants = {
    primary:
        'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark rounded-sm',
    secondary:
        'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark border border-border dark:border-border-dark text-button-primary-foreground dark:text-button-primary-foreground-dark rounded-sm',
    ghost: 'bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-text dark:text-text-dark rounded-sm',
    danger: 'bg-danger hover:bg-danger/90 text-white rounded-sm',
    unstyled: '',
};

const buttonSizes = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-2',
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
            type,
            target,
            rel,
            ...props
        },
        ref,
    ) => {
        const classes = cn(
            'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-medium transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            buttonVariants[variant],
            buttonSizes[size],
            fullWidth && 'w-full',
            className,
        );

        if (href && !disabled) {
            return (
                <LinkComponent
                    href={href}
                    className={cn(variant === 'unstyled' ? '' : classes, className)}
                    target={target}
                    rel={rel}
                >
                    {loading && (
                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    )}
                    {children}
                </LinkComponent>
            );
        }

        return (
            <button
                ref={ref}
                disabled={disabled || loading}
                className={cn(variant === 'unstyled' ? '' : classes, className)}
                type={type || 'button'}
                {...props}
            >
                {loading && (
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
                {children}
            </button>
        );
    },
);

Button.displayName = 'Button';
