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
import { FeedStatusSelect } from './FeedStatusSelect';
import { FeedTable } from './FeedTable';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';
import type { FeedStatusFilter } from './feed-status';

interface ActivityFeedClientProps {
    workId: string;
    initialCategory: FeedCategory;
    initialStatus?: FeedStatusFilter;
}

const POLL_INTERVAL = 5000;
const PAGE_LIMIT = 25;

export function ActivityFeedClient({
    workId,
    initialCategory,
    initialStatus = 'all',
}: ActivityFeedClientProps) {
    const t = useTranslations('dashboard.workDetail.activity');
    // Filtered-empty copy reuses the global activity-log translations.
    const tActivity = useTranslations('dashboard.activity');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [category, setCategory] = useState<FeedCategory>(initialCategory);
    const [statusFilter, setStatusFilter] = useState<FeedStatusFilter>(initialStatus);
    const [entries, setEntries] = useState<FeedEntry[] | null>(null);
    const [degraded, setDegraded] = useState<FeedDegradedReason | undefined>();
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const requestIdRef = useRef(0);
    const pollFailuresRef = useRef(0);
    const entriesCountRef = useRef(0);

    useEffect(() => {
        entriesCountRef.current = entries?.length ?? 0;
    }, [entries]);

    const fetchFeed = useCallback(
        async (
            cat: FeedCategory,
            options: { silent?: boolean; cursor?: string | null; append?: boolean } = {},
        ): Promise<boolean> => {
            const { silent = false, cursor = null, append = false } = options;
            if (!silent && !append) setRefreshing(true);
            if (append) setLoadingMore(true);
            const currentRequestId = ++requestIdRef.current;
            try {
                // Silent polls must re-fetch everything already on screen — a
                // plain first-page refresh would wipe entries loaded through
                // the pager. 200 is the API's max page size.
                const limit =
                    silent && !append
                        ? Math.min(200, Math.max(PAGE_LIMIT, entriesCountRef.current))
                        : PAGE_LIMIT;
                const result = await getActivityFeed(workId, {
                    category: cat,
                    limit,
                    ...(cursor && { cursor }),
                });
                // Discard if a newer request has been issued in the meantime.
                if (currentRequestId !== requestIdRef.current) return false;
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
                    return true;
                } else {
                    setError(result.error);
                    pollFailuresRef.current += 1;
                    return false;
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

    const handleStatusChange = useCallback(
        (next: FeedStatusFilter) => {
            // Status narrows the already-loaded entries client-side (the feed
            // API only filters by category), so no refetch — just URL sync.
            setStatusFilter(next);
            const params = new URLSearchParams(Array.from(searchParams.entries()));
            if (next === 'all') {
                params.delete('status');
            } else {
                params.set('status', next);
            }
            const query = params.toString();
            router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const handleManualRefresh = useCallback(() => {
        setNextCursor(null);
        setPage(1);
        void fetchFeed(category, { silent: false });
    }, [category, fetchFeed]);

    const isInitialLoading = entries === null && !error;
    // Directory-site entries carry no status, so they only show under "all".
    const visibleEntries =
        statusFilter === 'all' || !entries
            ? entries
            : entries.filter((entry) => 'status' in entry && entry.status === statusFilter);

    // Pagination mirrors /activity, but the feed API is cursor-based: pages
    // slice the entries loaded so far, and stepping past the last loaded page
    // fetches the next cursor batch first.
    const filteredCount = visibleEntries?.length ?? 0;
    const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_LIMIT));
    const pagedEntries = visibleEntries
        ? visibleEntries.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)
        : null;

    // Back to the first page when the visible set changes wholesale.
    useEffect(() => {
        setPage(1);
    }, [category, statusFilter]);

    // Clamp when the list shrinks under the current page (e.g. a filter cut
    // it down, or a failed append left the page count unchanged). Functional
    // update: a filter change queues setPage(1) from the reset effect above in
    // the same flush, and clamping to the render-scope `page` would overwrite
    // that reset with a stale value.
    useEffect(() => {
        if (page > totalPages) setPage((current) => Math.min(current, totalPages));
    }, [page, totalPages]);

    const handlePreviousPage = useCallback(() => {
        setPage((current) => Math.max(1, current - 1));
    }, []);

    const handleNextPage = useCallback(async () => {
        if (page < totalPages) {
            setPage(page + 1);
            return;
        }
        if (!nextCursor || loadingMore) return;
        const loaded = await fetchFeed(category, { cursor: nextCursor, append: true });
        if (loaded) setPage((current) => current + 1);
    }, [category, fetchFeed, loadingMore, nextCursor, page, totalPages]);
    // When the pull-mode sync is permanently broken (template hasn't shipped
    // the endpoint, or admin disabled it), dim the website-only chips so the
    // user doesn't keep clicking into an empty Users/Submissions/Reports tab.
    const isDirectorySyncBroken =
        degraded?.reason === 'disabled' || degraded?.reason === 'not_provisioned';

    return (
        <div className="space-y-4">
            <header className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <div className="flex items-center justify-end gap-3 flex-wrap">
                    <FeedStatusSelect value={statusFilter} onChange={handleStatusChange} />
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
                </div>
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
                    {pagedEntries && pagedEntries.length > 0 ? (
                        <FeedTable entries={pagedEntries} workId={workId} />
                    ) : (
                        <div className="rounded-lg border border-border dark:border-border-dark px-6 py-10 text-center">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {tActivity('empty.noResults')}
                            </p>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {tActivity('empty.noResultsDescription')}
                            </p>
                        </div>
                    )}
                    {(totalPages > 1 || nextCursor) && (
                        <div className="flex items-center justify-between">
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {tActivity('showing', {
                                    from: filteredCount === 0 ? 0 : (page - 1) * PAGE_LIMIT + 1,
                                    to: Math.min(page * PAGE_LIMIT, filteredCount),
                                    total: filteredCount,
                                })}
                            </p>
                            <div className="flex items-center gap-3">
                                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {tActivity('pagination.pageOf', { page, total: totalPages })}
                                </span>
                                <div className="flex gap-1.5">
                                    <button
                                        type="button"
                                        onClick={handlePreviousPage}
                                        disabled={page <= 1}
                                        className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                    >
                                        {tActivity('pagination.previous')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleNextPage()}
                                        disabled={
                                            (page >= totalPages && !nextCursor) || loadingMore
                                        }
                                        className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                    >
                                        {tActivity('pagination.next')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
