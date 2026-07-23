'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface InfoPopoverProps {
    /** Bold heading inside the panel. */
    title: string;
    /** Explanatory body copy. Rendered as a single paragraph. */
    body: string;
    /** Accessible name for the trigger button. */
    ariaLabel: string;
    /**
     * Which horizontal edge the panel is anchored to. `start` (default)
     * grows to the right of the icon, `end` grows to the left — use it
     * when the trigger sits near the right edge of its container.
     */
    align?: 'start' | 'end';
    className?: string;
}

/**
 * Click-to-open explainer attached to an ⓘ icon.
 *
 * Deliberately not the hover-only `Tooltip` in `./tooltip`: that one takes
 * a short `content` string and caps at `max-w-56`, which is right for a
 * label hint and wrong for a paragraph the user needs time to read.
 * Click-to-open also makes the content reachable on touch devices and
 * keyboard-navigable.
 */
export function InfoPopover({
    title,
    body,
    ariaLabel,
    align = 'start',
    className,
}: InfoPopoverProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLSpanElement>(null);
    const panelId = useId();

    useEffect(() => {
        if (!open) return;

        const onPointerDown = (event: MouseEvent | TouchEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };

        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <span ref={containerRef} className={cn('relative inline-flex', className)}>
            <button
                type="button"
                aria-label={ariaLabel}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                onClick={() => setOpen((prev) => !prev)}
                className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    'text-text-muted dark:text-text-muted-dark',
                    'hover:text-text dark:hover:text-text-dark transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                )}
                data-testid="info-popover-trigger"
            >
                <Info className="w-3.5 h-3.5" />
            </button>

            {open && (
                <span
                    id={panelId}
                    role="dialog"
                    aria-label={title}
                    className={cn(
                        'absolute z-50 top-full mt-2 w-72 max-w-[min(18rem,calc(100vw-2rem))]',
                        'rounded-lg border p-3 shadow-lg text-left',
                        'bg-card dark:bg-gray-900',
                        'border-card-border dark:border-border-secondary-dark',
                        align === 'end' ? 'right-0' : 'left-0',
                    )}
                    data-testid="info-popover-panel"
                >
                    <span className="flex items-start justify-between gap-2">
                        <span className="text-xs font-semibold text-text dark:text-text-dark">
                            {title}
                        </span>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label={ariaLabel}
                            className="shrink-0 text-text-muted hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </span>
                    <span className="mt-1.5 block text-xs leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                        {body}
                    </span>
                </span>
            )}
        </span>
    );
}
