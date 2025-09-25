'use client';

import * as React from 'react';
import {
    Dialog as HeadlessDialog,
    DialogPanel,
    DialogTitle,
    Description,
    Transition,
    TransitionChild,
} from '@headlessui/react';
import { cn } from '@/lib/utils/cn';
import { X } from 'lucide-react';

interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
    return (
        <Transition show={open}>
            <HeadlessDialog onClose={() => onOpenChange(false)} className="relative z-50">
                {/* Backdrop */}
                <TransitionChild
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/50 dark:bg-black/70" />
                </TransitionChild>

                {/* Dialog content */}
                <div className="fixed inset-0 overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4">
                        {children}
                    </div>
                </div>
            </HeadlessDialog>
        </Transition>
    );
}

interface DialogContentProps {
    children: React.ReactNode;
    className?: string;
}

export function DialogContent({ children, className }: DialogContentProps) {
    return (
        <TransitionChild
            enter="ease-out duration-300"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
        >
            <DialogPanel
                className={cn(
                    'relative bg-surface dark:bg-surface-dark',
                    'rounded-lg shadow-xl',
                    'w-full max-w-lg',
                    'p-6',
                    className,
                )}
            >
                {children}
            </DialogPanel>
        </TransitionChild>
    );
}

interface DialogHeaderProps {
    children: React.ReactNode;
    className?: string;
}

export function DialogHeader({ children, className }: DialogHeaderProps) {
    return <div className={cn('mb-4', className)}>{children}</div>;
}

interface DialogTitleProps {
    children: React.ReactNode;
    className?: string;
}

export { DialogTitle };

interface DialogDescriptionProps {
    children: React.ReactNode;
    className?: string;
}

export function DialogDescription({ children, className }: DialogDescriptionProps) {
    return (
        <Description
            className={cn(
                'text-sm text-text-secondary dark:text-text-secondary-dark mt-1',
                className,
            )}
        >
            {children}
        </Description>
    );
}

interface DialogFooterProps {
    children: React.ReactNode;
    className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
    return <div className={cn('flex justify-end gap-3 mt-6', className)}>{children}</div>;
}

interface DialogCloseProps {
    onClose: () => void;
}

export function DialogClose({ onClose }: DialogCloseProps) {
    return (
        <button
            onClick={onClose}
            className={cn(
                'absolute right-4 top-4',
                'rounded-sm opacity-70 ring-offset-background transition-opacity',
                'hover:opacity-100',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                'disabled:pointer-events-none',
            )}
        >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
        </button>
    );
}
