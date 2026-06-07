import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * EW-641 slice A — workbench layout primitive.
 *
 * Three-column CSS grid: left tree pane (default 280px, min 200px,
 * max 400px), center editor pane (1fr, fills the rest), and an optional
 * right panel (default 320px, hidden when `right` is omitted — this
 * slot is reserved for Phase 2's AI side panel and the slice-A workbench
 * keeps it empty so the editor stretches to fill the row).
 *
 * Server component by default — it accepts arbitrary `ReactNode`
 * children and never opens a client boundary itself, so consumers can
 * mix RSC (data-fetched tree slots) with `'use client'` editors freely.
 *
 * The chrome (rounded border, card-tone background, padding) mirrors
 * the surrounding dashboard sections (see `KbShell`, `KbTreePanel`
 * empty-state, the works-detail tabs panel) so this primitive snaps
 * into place visually without a custom container wrapper at the page
 * level.
 */
export interface WorkbenchShellProps {
    left: ReactNode;
    center: ReactNode;
    right?: ReactNode;
    className?: string;
}

export function WorkbenchShell({ left, center, right, className }: WorkbenchShellProps) {
    const hasRight = right !== undefined && right !== null && right !== false;
    return (
        <div
            data-testid="kb-workbench-shell"
            className={cn(
                'grid w-full gap-4',
                // Single-column on small screens; the workbench is genuinely
                // unusable below ~md so we collapse rather than try to squeeze
                // three panes into a phone-width viewport.
                'grid-cols-1',
                hasRight
                    ? 'md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)_minmax(260px,320px)]'
                    : 'md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]',
                'md:[&>*]:max-w-full',
                className,
            )}
        >
            <aside
                data-testid="kb-workbench-left"
                className={cn(
                    'rounded-lg border border-border dark:border-border-dark',
                    'bg-card/50 dark:bg-card-primary-dark/30',
                    'min-h-[24rem] overflow-hidden',
                )}
            >
                {left}
            </aside>

            <section
                data-testid="kb-workbench-center"
                className={cn(
                    'rounded-lg border border-border dark:border-border-dark',
                    'bg-card/50 dark:bg-card-primary-dark/30',
                    'min-h-[24rem] overflow-hidden flex flex-col',
                )}
            >
                {center}
            </section>

            {hasRight ? (
                <aside
                    data-testid="kb-workbench-right"
                    className={cn(
                        'rounded-lg border border-border dark:border-border-dark',
                        'bg-card/50 dark:bg-card-primary-dark/30',
                        'min-h-[24rem] overflow-hidden',
                    )}
                >
                    {right}
                </aside>
            ) : null}
        </div>
    );
}
