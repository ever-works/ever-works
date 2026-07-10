'use client';

import * as React from 'react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
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

/**
 * Colour tokens per variant. Radius, sizing, focus, and disabled
 * treatment live in the shared base classes below so every variant
 * renders the same control shape — heights and focus ring match the
 * Input/Select primitives (h-8/h-9, focus-visible ring), with a
 * slightly tighter rounded-md radius for buttons.
 */
const buttonVariants = {
    primary:
        'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark',
    secondary:
        'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark border border-border dark:border-border-dark text-button-primary-foreground dark:text-button-primary-foreground-dark',
    ghost: 'bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-text dark:text-text-dark',
    danger: 'bg-danger hover:bg-danger/90 text-white',
    unstyled: '',
};

/** Control heights aligned with the Input (h-8/h-9) and Select (h-8/h-9) primitives. */
const buttonSizes = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-4 text-sm',
    lg: 'h-11 px-6 text-base',
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
        const classes =
            variant === 'unstyled'
                ? cn(className)
                : cn(
                      'inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:focus-visible:ring-white/20',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      '[&_svg]:shrink-0',
                      buttonVariants[variant],
                      buttonSizes[size],
                      fullWidth && 'w-full',
                      className,
                  );
        const content = children as React.ReactNode;
        const spinner = loading ? (
            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : null;

        // Security: prevent reverse tabnapping — automatically inject noopener/noreferrer when target="_blank"
        const safeRel =
            target === '_blank' ? [rel, 'noopener', 'noreferrer'].filter(Boolean).join(' ') : rel;

        if (href && !disabled) {
            return (
                <LinkComponent href={href} className={classes} target={target} rel={safeRel}>
                    {spinner}
                    {content}
                </LinkComponent>
            );
        }

        return (
            <button
                ref={ref}
                disabled={disabled || loading}
                className={classes}
                type={type || 'button'}
                {...props}
            >
                {spinner}
                {content}
            </button>
        );
    },
);

Button.displayName = 'Button';
