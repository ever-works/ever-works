'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getActivityFeed } from '@/app/actions/dashboard/activity-feed';
import type {
    FeedCategory,
    FeedDegradedReason,
    FeedEntry,
    FeedResponse,
} from '@/lib/api/works/activity-feed.types';
import { DegradedBanner } from './DegradedBanner';
import { FeedFilterChips } from './FeedFilterChips';
import { FeedRow } from './FeedRow';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';

interface ActivityFeedClientProps {
    workId: string;
    initialCategory: FeedCategory;
}

const POLL_INTERVAL = 5000;
const PAGE_LIMIT = 25;

export function ActivityFeedClient({ workId, initialCategory }: ActivityFeedClientProps) {
    const t = useTranslations('dashboard.workDetail.activity');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [category, setCategory] = useState<FeedCategory>(initialCategory);
    const [entries, setEntries] = useState<FeedEntry[] | null>(null);
    const [degraded, setDegraded] = useState<FeedDegradedReason | undefined>();
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const requestIdRef = useRef(0);
    const pollFailuresRef = useRef(0);

    const fetchFeed = useCallback(
        async (
            cat: FeedCategory,
            options: { silent?: boolean; cursor?: string | null; append?: boolean } = {},
        ): Promise<void> => {
            const { silent = false, cursor = null, append = false } = options;
            if (!silent && !append) setRefreshing(true);
            if (append) setLoadingMore(true);
            const currentRequestId = ++requestIdRef.current;
            try {
                const result = await getActivityFeed(workId, {
                    category: cat,
                    limit: PAGE_LIMIT,
                    ...(cursor && { cursor }),
                });
                // Discard if a newer request has been issued in the meantime.
                if (currentRequestId !== requestIdRef.current) return;
                if (result.success) {
                    const data: FeedResponse = result.data;
                    setEntries((current) =>
                        append && current ? [...current, ...data.entries] : data.entries,
                    );
                    setNextCursor(data.nextCursor ?? null);
                    // Pull-mode degraded reasons surface here; push-mode and
                    // disabled responses leave the field undefined so the
                    // banner stays hidden.
                    setDegraded(data.degraded?.directorySite);
                    setError(null);
                    pollFailuresRef.current = 0;
                } else {
                    setError(result.error);
                    pollFailuresRef.current += 1;
                }
            } finally {
                if (currentRequestId === requestIdRef.current) {
                    if (!silent && !append) setRefreshing(false);
                    if (append) setLoadingMore(false);
                }
            }
        },
        [workId],
    );

    // Initial fetch + refetch on category change.
    useEffect(() => {
        void fetchFeed(category, { silent: false });
    }, [category, fetchFeed]);

    // Polling — silent refresh, paused when tab is hidden. Back off on
    // repeated failures so a broken API does not get hammered every 5s.
    useEffect(() => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let cancelled = false;

        const scheduleNextPoll = () => {
            const multiplier = Math.min(6, 1 + pollFailuresRef.current);
            timeout = setTimeout(() => {
                if (cancelled) return;
                if (!document.hidden) {
                    void fetchFeed(category, { silent: true }).finally(scheduleNextPoll);
                } else {
                    scheduleNextPoll();
                }
            }, POLL_INTERVAL * multiplier);
        };

        const handleVisibility = () => {
            if (!document.hidden) {
                void fetchFeed(category, { silent: true });
            }
        };

        scheduleNextPoll();
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            cancelled = true;
            if (timeout) clearTimeout(timeout);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [category, fetchFeed]);

    const handleCategoryChange = useCallback(
        (next: FeedCategory) => {
            setCategory(next);
            setEntries(null);
            setNextCursor(null);
            const params = new URLSearchParams(Array.from(searchParams.entries()));
            if (next === 'all') {
                params.delete('category');
            } else {
                params.set('category', next);
            }
            const query = params.toString();
            router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const handleManualRefresh = useCallback(() => {
        setNextCursor(null);
        void fetchFeed(category, { silent: false });
    }, [category, fetchFeed]);

    const handleLoadMore = useCallback(() => {
        if (!nextCursor || loadingMore) return;
        void fetchFeed(category, { cursor: nextCursor, append: true });
    }, [category, fetchFeed, loadingMore, nextCursor]);

    const isInitialLoading = entries === null && !error;
    // When the pull-mode sync is permanently broken (template hasn't shipped
    // the endpoint, or admin disabled it), dim the website-only chips so the
    // user doesn't keep clicking into an empty Users/Submissions/Reports tab.
    const isDirectorySyncBroken =
        degraded?.reason === 'disabled' || degraded?.reason === 'not_provisioned';

    return (
        <div className="space-y-4">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleManualRefresh}
                    disabled={refreshing}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors',
                        'border-border dark:border-border-dark',
                        'bg-card dark:bg-card-primary-dark/30',
                        'text-text-secondary dark:text-text-secondary-dark',
                        'hover:bg-muted/30 dark:hover:bg-muted/10',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                        refreshing && 'opacity-60 cursor-not-allowed',
                    )}
                    aria-label={t('actions.refresh')}
                >
                    <svg
                        className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                    </svg>
                    {t('actions.refresh')}
                </button>
            </header>

            <FeedFilterChips
                value={category}
                onChange={handleCategoryChange}
                directorySiteDisabled={isDirectorySyncBroken}
            />

            {degraded && <DegradedBanner degraded={degraded} />}

            {error && (
                <div
                    role="alert"
                    className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error"
                >
                    {error}
                </div>
            )}

            {isInitialLoading && <SkeletonList />}

            {!isInitialLoading && entries && entries.length === 0 && <EmptyState />}

            {!isInitialLoading && entries && entries.length > 0 && (
                <>
                    <ul className="space-y-2">
                        {entries.map((entry) => (
                            <li key={`${entry.source}-${entry.id}`}>
                                <FeedRow entry={entry} workId={workId} />
                            </li>
                        ))}
                    </ul>
                    {nextCursor && (
                        <div className="flex justify-center pt-2">
                            <button
                                type="button"
                                onClick={handleLoadMore}
                                disabled={loadingMore}
                                className={cn(
                                    'inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                                    'border-border dark:border-border-dark',
                                    'bg-card dark:bg-card-primary-dark/30',
                                    'text-text-secondary dark:text-text-secondary-dark',
                                    'hover:bg-muted/30 dark:hover:bg-muted/10',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                    loadingMore && 'opacity-60 cursor-not-allowed',
                                )}
                            >
                                {loadingMore ? t('actions.loadingMore') : t('actions.loadMore')}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
