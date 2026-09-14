'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, RotateCw, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

export type HomeBlockState = 'loading' | 'ready' | 'empty' | 'failed';

interface HomeBlockShellProps {
    /** Stable id; the heading id and the test id derive from it. */
    blockId: string;
    title: ReactNode;
    icon: LucideIcon;
    state: HomeBlockState;
    /** Right-hand header content, typically the link to the owning surface. */
    headerAction?: ReactNode;
    /** Rendered after the title inside the heading row (a suffix such as an overdue count). */
    titleSuffix?: ReactNode;
    /** What the block would show — rendered when `state === 'empty'`. */
    empty?: ReactNode;
    /** The block's name inside the failure sentence, e.g. "today's schedule". */
    failedLabel: string;
    onRetry?: () => void;
    /** Skeleton rows while loading; sized like the populated block. */
    skeletonRows?: number;
    className?: string;
    children?: ReactNode;
}

/**
 * Home (AW-19) — the frame every morning block renders in: a named landmark
 * region whose accessible name is its visible heading, a header link to the
 * surface that owns the data, and exactly one of a skeleton, the content, an
 * empty state or an error card.
 *
 * Empty and failed are different structures, not the same card with other
 * words: empty says what would appear here; failed is an alert with a Retry,
 * so a broken source can never pass for a quiet morning.
 */
export function HomeBlockShell({
    blockId,
    title,
    icon: Icon,
    state,
    headerAction,
    titleSuffix,
    empty,
    failedLabel,
    onRetry,
    skeletonRows = 3,
    className,
    children,
}: HomeBlockShellProps) {
    const t = useTranslations('dashboard.home.block');
    const headingId = `home-${blockId}-heading`;

    return (
        <section
            aria-labelledby={headingId}
            aria-busy={state === 'loading' || undefined}
            data-testid={`home-block-${blockId}`}
            data-state={state}
            className={cn(
                'rounded-xl border border-card-border dark:border-white/8 bg-card dark:bg-card-primary-dark/60 p-4',
                className,
            )}
        >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Icon
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-text-secondary dark:text-text-secondary-dark"
                    />
                    <h2
                        id={headingId}
                        className="truncate text-sm font-semibold uppercase tracking-wide text-text dark:text-text-dark"
                    >
                        {title}
                    </h2>
                    {titleSuffix}
                </div>
                {state !== 'failed' && headerAction ? (
                    <div className="shrink-0 text-xs">{headerAction}</div>
                ) : null}
            </div>

            {state === 'loading' ? (
                <div data-testid={`home-block-${blockId}-skeleton`} className="space-y-2">
                    <span className="sr-only">{t('loading')}</span>
                    {Array.from({ length: skeletonRows }, (_, index) => (
                        <div
                            key={index}
                            aria-hidden="true"
                            className="h-8 animate-pulse rounded-md bg-surface-secondary dark:bg-white/6"
                        />
                    ))}
                </div>
            ) : state === 'failed' ? (
                <div
                    role="alert"
                    data-testid={`home-block-${blockId}-error`}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5"
                >
                    <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
                    <p className="min-w-0 flex-1 text-sm text-text dark:text-text-dark">
                        {t('errorTitle', { block: failedLabel })}
                    </p>
                    {onRetry ? (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 dark:border-white/12 px-2.5 py-1 text-xs font-medium text-text dark:text-text-dark hover:border-border dark:hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                            <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                            {t('retry')}
                        </button>
                    ) : null}
                </div>
            ) : state === 'empty' ? (
                <div data-testid={`home-block-${blockId}-empty`} className="py-2">
                    {empty}
                </div>
            ) : (
                children
            )}
        </section>
    );
}
