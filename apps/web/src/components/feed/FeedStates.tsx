'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Bot, History, Radio, Target } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

const primaryButton =
    'inline-flex items-center gap-1.5 rounded-lg bg-button-primary dark:bg-button-primary-dark px-3 py-1.5 text-xs font-medium text-white dark:text-black hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const secondaryButton =
    'inline-flex items-center gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const panel =
    'flex flex-col items-center gap-3 rounded-xl border border-dashed border-border dark:border-border-dark px-6 py-12 text-center';

/** First paint while the first page loads — the same height as real rows, so nothing shifts. */
export function FeedSkeleton({ rows = 6 }: { rows?: number }) {
    return (
        <div data-testid="feed-skeleton" aria-hidden="true" className="space-y-1">
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
                    <span className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark" />
                    <span className="h-4 flex-1 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
                    <span className="h-4 w-16 animate-pulse rounded-full bg-surface-secondary dark:bg-surface-secondary-dark" />
                    <span className="h-3 w-24 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
                </div>
            ))}
        </div>
    );
}

/** Nothing has ever happened in this scope. */
export function FeedEmptyState() {
    const t = useTranslations('dashboard.feed.empty');
    return (
        <div data-testid="feed-empty" className={panel}>
            <Radio
                aria-hidden="true"
                className="h-8 w-8 text-text-muted dark:text-text-muted-dark"
            />
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h3>
            <p className="max-w-md text-sm text-text-muted dark:text-text-muted-dark">
                {t('body')}
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Link href={ROUTES.DASHBOARD_AGENT_NEW} className={primaryButton}>
                    <Bot aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('createAgent')}
                </Link>
                <Link href={ROUTES.DASHBOARD_MISSIONS_NEW} className={secondaryButton}>
                    <Target aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('startMission')}
                </Link>
            </div>
        </div>
    );
}

/** Filters that match nothing. The feed keeps refreshing, so later activity still appears. */
export function FeedFilteredEmptyState({
    byAgent,
    onClearFilters,
}: {
    byAgent: boolean;
    onClearFilters: () => void;
}) {
    const t = useTranslations('dashboard.feed');
    return (
        <div data-testid="feed-empty-filtered" className={panel}>
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                {byAgent ? t('emptyFiltered.title') : t('emptyFiltered.titleGeneric')}
            </h3>
            <p className="max-w-md text-sm text-text-muted dark:text-text-muted-dark">
                {t('emptyFiltered.body')}
            </p>
            <button type="button" onClick={onClearFilters} className={secondaryButton}>
                {t('filters.clearFilters')}
            </button>
        </div>
    );
}

/** The first page could not be read. No partial list is shown. */
export function FeedErrorState({
    onRetry,
    onOpenActivityLog,
}: {
    onRetry: () => void;
    onOpenActivityLog: () => void;
}) {
    const t = useTranslations('dashboard.feed.error');
    return (
        <div data-testid="feed-error" role="alert" className={panel}>
            <AlertTriangle aria-hidden="true" className="h-8 w-8 text-danger" />
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h3>
            <p className="max-w-md text-sm text-text-muted dark:text-text-muted-dark">
                {t('body')}
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={onRetry} className={primaryButton}>
                    {t('retry')}
                </button>
                <button type="button" onClick={onOpenActivityLog} className={secondaryButton}>
                    {t('openActivityLog')}
                </button>
            </div>
        </div>
    );
}

/** The end of what the feed reads: the 90-day floor, or the per-visit page cap. */
export function FeedEndCard({
    reason,
    onOpenActivityLog,
}: {
    reason: 'history' | 'pageCap';
    onOpenActivityLog: () => void;
}) {
    const t = useTranslations('dashboard.feed.end');
    return (
        <section
            data-testid="feed-end"
            data-reason={reason}
            aria-labelledby="feed-end-title"
            className="flex flex-col items-center gap-2 py-8 text-center"
        >
            <div className="flex w-full items-center gap-3 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                <span aria-hidden="true" className="h-px flex-1 bg-border dark:bg-border-dark" />
                <History aria-hidden="true" className="h-3.5 w-3.5" />
                <h3 id="feed-end-title" className="text-xs font-medium">
                    {reason === 'history' ? t('title') : t('pageCapTitle')}
                </h3>
                <span aria-hidden="true" className="h-px flex-1 bg-border dark:bg-border-dark" />
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('body')}</p>
            <button type="button" onClick={onOpenActivityLog} className={secondaryButton}>
                {t('openActivityLog')}
            </button>
        </section>
    );
}
