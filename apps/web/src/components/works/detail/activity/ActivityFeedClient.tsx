'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getActivityFeed } from '@/app/actions/dashboard/activity-feed';
import type { FeedCategory, FeedEntry, FeedResponse } from '@/lib/api/works/activity-feed.types';
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
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const requestIdRef = useRef(0);

    const fetchFeed = useCallback(
        async (cat: FeedCategory, silent = false): Promise<void> => {
            if (!silent) setRefreshing(true);
            const currentRequestId = ++requestIdRef.current;
            try {
                const result = await getActivityFeed(workId, {
                    category: cat,
                    limit: PAGE_LIMIT,
                });
                // Discard if a newer request has been issued in the meantime.
                if (currentRequestId !== requestIdRef.current) return;
                if (result.success) {
                    const data: FeedResponse = result.data;
                    setEntries(data.entries);
                    setError(null);
                } else {
                    setError(result.error);
                }
            } finally {
                if (!silent && currentRequestId === requestIdRef.current) {
                    setRefreshing(false);
                }
            }
        },
        [workId],
    );

    // Initial fetch + refetch on category change.
    useEffect(() => {
        void fetchFeed(category, false);
    }, [category, fetchFeed]);

    // Polling — silent refresh, paused when tab is hidden. Mirrors the
    // pattern used by /dashboard/activity (apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx).
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;

        const startPolling = () => {
            interval = setInterval(() => {
                if (!document.hidden) {
                    void fetchFeed(category, true);
                }
            }, POLL_INTERVAL);
        };

        const handleVisibility = () => {
            clearInterval(interval);
            if (!document.hidden) {
                void fetchFeed(category, true);
                startPolling();
            }
        };

        startPolling();
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [category, fetchFeed]);

    const handleCategoryChange = useCallback(
        (next: FeedCategory) => {
            setCategory(next);
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
        void fetchFeed(category, false);
    }, [category, fetchFeed]);

    const isInitialLoading = entries === null && !error;

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

            <FeedFilterChips value={category} onChange={handleCategoryChange} />

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
                <ul className="space-y-2">
                    {entries.map((entry) => (
                        <li key={`${entry.source}-${entry.id}`}>
                            <FeedRow entry={entry} workId={workId} />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
