'use client';

import * as React from 'react';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { cn } from '@/lib/utils/cn';

interface DropdownMenuProps {
    children: React.ReactNode;
}

export function DropdownMenu({ children }: DropdownMenuProps) {
    return (
        <Menu as="div" className="relative inline-block text-left w-full">
            {children}
        </Menu>
    );
}

interface DropdownMenuTriggerProps {
    children: React.ReactNode;
    asChild?: boolean;
    className?: string;
}

export function DropdownMenuTrigger({ children, asChild, className }: DropdownMenuTriggerProps) {
    if (asChild && React.isValidElement(children)) {
        return <MenuButton as={React.Fragment}>{children}</MenuButton>;
    }

    return (
        <MenuButton className={cn('inline-flex items-center justify-center', className)}>
            {children}
        </MenuButton>
    );
}

interface DropdownMenuContentProps {
    children: React.ReactNode;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'bottom';
    className?: string;
}

export function DropdownMenuContent({
    children,
    align = 'start',
    side = 'bottom',
    className,
}: DropdownMenuContentProps) {
    const anchorSide = side === 'bottom' ? 'bottom' : 'top';
    const anchorAlign = align === 'center' ? '' : align === 'start' ? ' start' : ' end';
    const anchorTo = `${anchorSide}${anchorAlign}` as const;

    return (
        <MenuItems
            transition
            portal
            anchor={{ to: anchorTo, gap: 8 }}
            className={cn(
                'z-50 min-w-[8rem] overflow-hidden rounded-lg',
                'bg-surface dark:bg-surface-dark',
                'border border-border dark:border-border-dark',
                'shadow-lg',
                'focus:outline-none',
                // Transition styles
                'transition duration-100 ease-out',
                'data-[closed]:scale-95 data-[closed]:opacity-0',
                'data-[leave]:duration-75 data-[leave]:ease-in',
                className,
            )}
        >
            <div className="p-1">{children}</div>
        </MenuItems>
    );
}

interface DropdownMenuItemProps {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
}

export function DropdownMenuItem({
    children,
    onClick,
    disabled,
    className,
}: DropdownMenuItemProps) {
    return (
        <MenuItem disabled={disabled}>
            {({ active, disabled: itemDisabled }) => (
                <button
                    onClick={onClick}
                    disabled={itemDisabled}
                    className={cn(
                        'relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
                        'transition-colors',
                        active && !itemDisabled && 'bg-surface-hover dark:bg-surface-hover-dark',
                        itemDisabled && 'opacity-50 cursor-not-allowed',
                        className,
                    )}
                >
                    {children}
                </button>
            )}
        </MenuItem>
    );
}

interface DropdownMenuSeparatorProps {
    className?: string;
}

export function DropdownMenuSeparator({ className }: DropdownMenuSeparatorProps) {
    return <div className={cn('-mx-1 my-1 h-px bg-border dark:bg-border-dark', className)} />;
}

interface DropdownMenuLabelProps {
    children: React.ReactNode;
    className?: string;
}

export function DropdownMenuLabel({ children, className }: DropdownMenuLabelProps) {
    return (
        <div
            className={cn(
                'px-2 py-1.5 text-sm font-semibold text-text dark:text-text-dark',
                className,
            )}
        >
            {children}
        </div>
    );
}
