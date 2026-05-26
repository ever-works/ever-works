'use client';

import { cn } from '@/lib/utils/cn';

/**
 * Lightweight placeholder shown while `ItemsPageClient` fetches the
 * Work's items + taxonomy from the API (which in turn clones the
 * data repo). Keeps the page shell — title, tabs, search input,
 * sticky actions — visible immediately so the user sees forward
 * motion instead of a frozen route.
 */
export function ItemsListSkeleton({ rows = 8 }: { rows?: number }) {
    return (
        <div
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"
            aria-hidden="true"
            data-testid="items-list-skeleton"
        >
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        'rounded-lg border border-border dark:border-border-dark',
                        'bg-muted/30 dark:bg-muted/10 p-4 animate-pulse',
                        'h-[160px] flex flex-col gap-3',
                    )}
                >
                    <div className="h-4 w-2/3 rounded bg-muted/60 dark:bg-muted/30" />
                    <div className="h-3 w-full rounded bg-muted/50 dark:bg-muted/20" />
                    <div className="h-3 w-5/6 rounded bg-muted/50 dark:bg-muted/20" />
                    <div className="mt-auto flex gap-2">
                        <div className="h-5 w-14 rounded-full bg-muted/50 dark:bg-muted/20" />
                        <div className="h-5 w-20 rounded-full bg-muted/40 dark:bg-muted/20" />
                    </div>
                </div>
            ))}
        </div>
    );
}
