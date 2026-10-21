'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Laptop } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { FixOnComputerDialog } from '@/components/fleet/tasks/FixOnComputerDialog';

/**
 * Tasks on computers (FL-15 P1, spec FR-1, §5.1, T-06) — **Fix with an agent
 * on this computer**, beside **Run with agent** on Task detail. Rendered only
 * when the server said both fleet flags are on and the person has a computer
 * (`FixOnComputerSlot`); `F` opens it on Task detail (`hotkey`), never while
 * typing in a field.
 */
export function FixOnComputerButton({
    taskId,
    taskSlug,
    compact = false,
    hotkey = false,
    className,
}: {
    taskId: string;
    taskSlug: string;
    /** The card-sized icon button (the board's ⋯ menu uses the label instead). */
    compact?: boolean;
    /** Bind `F` (Task detail only). */
    hotkey?: boolean;
    className?: string;
}) {
    const t = useTranslations('fleet.taskHandoff');
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!hotkey) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'f' && event.key !== 'F') return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
            event.preventDefault();
            setOpen(true);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [hotkey]);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={t('button')}
                aria-label={compact ? t('button') : undefined}
                aria-keyshortcuts={hotkey ? 'F' : undefined}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border border-border/60 dark:border-border-dark/60 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors',
                    compact ? 'p-1.5' : 'px-3 py-1.5',
                    className,
                )}
                data-testid="fleet-handoff-button"
            >
                <Laptop className="h-3.5 w-3.5" aria-hidden="true" />
                {!compact && <span>{t('button')}</span>}
            </button>
            <FixOnComputerDialog taskId={taskId} taskSlug={taskSlug} open={open} onOpenChange={setOpen} />
        </>
    );
}
