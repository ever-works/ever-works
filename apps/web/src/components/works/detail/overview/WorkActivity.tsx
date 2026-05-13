'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { getActivityFeed } from '@/app/actions/dashboard/activity-feed';
import type { FeedEntry } from '@/lib/api/works/activity-feed.types';

interface WorkActivityProps {
    workId: string;
}

const OVERVIEW_LIMIT = 5;
const POLL_INTERVAL = 5000;

/**
 * Compact "Recent activity" card shown on the Work Overview tab (EW-120).
 *
 * Pulls the top N entries from the same `/api/works/:id/activity-feed`
 * aggregator the full Activity Feed tab uses, with the same polling +
 * `document.hidden` pause pattern. The full tab is one click away via
 * the "View all →" link.
 */
export function WorkActivity({ workId }: WorkActivityProps) {
    const t = useTranslations('dashboard.workDetail.activity');

    const [entries, setEntries] = useState<FeedEntry[] | null>(null);
    const requestIdRef = useRef(0);

    const fetchFeed = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        const result = await getActivityFeed(workId, { limit: OVERVIEW_LIMIT });
        if (currentRequestId !== requestIdRef.current) return;
        if (result.success) {
            setEntries(result.data.entries);
        }
    }, [workId]);

    useEffect(() => {
        void fetchFeed();
    }, [fetchFeed]);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;
        const startPolling = () => {
            interval = setInterval(() => {
                if (!document.hidden) void fetchFeed();
            }, POLL_INTERVAL);
        };
        const handleVisibility = () => {
            clearInterval(interval);
            if (!document.hidden) {
                void fetchFeed();
                startPolling();
            }
        };
        startPolling();
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [fetchFeed]);

    const isInitialLoading = entries === null;
    const isEmpty = entries !== null && entries.length === 0;

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <header className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <Link
                    href={ROUTES.DASHBOARD_WORK_ACTIVITY(workId)}
                    className="text-xs font-medium text-primary hover:underline"
                >
                    {t('actions.viewAll')} &rarr;
                </Link>
            </header>

            {isInitialLoading && (
                <div className="space-y-3" aria-busy="true" aria-hidden="true">
                    {Array.from({ length: 3 }).map((_, idx) => (
                        <div key={idx} className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-muted dark:bg-muted/30 animate-pulse" />
                            <div className="flex-1 space-y-2">
                                <div className="h-3 w-2/3 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                                <div className="h-2 w-1/4 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {isEmpty && (
                <p className="text-sm text-text-muted dark:text-text-muted-dark text-center py-8">
                    {t('empty.title')}
                </p>
            )}

            {!isInitialLoading && entries && entries.length > 0 && (
                <ul className="space-y-3">
                    {entries.map((entry) => (
                        <li key={`${entry.source}-${entry.id}`} className="flex gap-3">
                            <span
                                className={cn(
                                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                                    entry.source === 'platform-activity-log' &&
                                        'bg-info/10 text-info',
                                    entry.source === 'generation-history' &&
                                        'bg-success/10 text-success',
                                )}
                                aria-hidden="true"
                            >
                                <svg
                                    className="h-4 w-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M3 12h3l3-9 6 18 3-9h3"
                                    />
                                </svg>
                            </span>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                    {entry.summary}
                                </p>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                    {formatDistanceToNow(new Date(entry.timestamp), {
                                        addSuffix: true,
                                    })}
                                </p>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
