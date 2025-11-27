'use client';

import * as React from 'react';
import { Menu, MenuButton, MenuItems, MenuItem, Transition } from '@headlessui/react';
import { cn } from '@/lib/utils/cn';

interface DropdownMenuProps {
    children: React.ReactNode;
}

export function DropdownMenu({ children }: DropdownMenuProps) {
    return (
        <Menu as="div" className="relative inline-block text-left">
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
    const alignmentClasses = {
        start: side === 'bottom' ? 'origin-top-left left-0' : 'origin-bottom-left left-0',
        center: side === 'bottom' ? 'origin-top left-1/2 -translate-x-1/2' : 'origin-bottom left-1/2 -translate-x-1/2',
        end: side === 'bottom' ? 'origin-top-right right-0' : 'origin-bottom-right right-0',
    };

    const spacingClasses = side === 'bottom' ? 'mt-2' : 'mb-2 bottom-full';

    return (
        <Transition
            enter="transition ease-out duration-100"
            enterFrom="transform opacity-0 scale-95"
            enterTo="transform opacity-100 scale-100"
            leave="transition ease-in duration-75"
            leaveFrom="transform opacity-100 scale-100"
            leaveTo="transform opacity-0 scale-95"
        >
            <MenuItems
                className={cn(
                    'absolute z-50 min-w-[8rem] overflow-hidden rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                    'shadow-lg',
                    'focus:outline-none',
                    spacingClasses,
                    alignmentClasses[align],
                    className,
                )}
            >
                <div className="p-1">{children}</div>
            </MenuItems>
        </Transition>
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
