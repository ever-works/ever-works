'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { getActivityLog } from '@/app/actions/activity-log';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityTable } from '@/components/activity-log/ActivityTable';
import { ActivityFilters } from '@/components/activity-log/ActivityFilters';
import { ActivityEmptyState } from '@/components/activity-log/ActivityEmptyState';
import { toast } from 'sonner';
import { Download } from 'lucide-react';

const POLL_INTERVAL = 5000;
const ITEMS_PER_PAGE = 25;

interface ActivityClientProps {
    initialActivities: ActivityLogEntry[];
    totalActivities: number;
}

export function ActivityClient({ initialActivities, totalActivities }: ActivityClientProps) {
    const t = useTranslations('dashboard.activity');
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    // Initialise filters from URL query params
    const [activities, setActivities] = useState<ActivityLogEntry[]>(initialActivities);
    const [total, setTotal] = useState(totalActivities);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(() => {
        const p = parseInt(searchParams.get('page') || '1', 10);
        return Number.isFinite(p) && p >= 1 ? p : 1;
    });

    const [actionType, setActionType] = useState<string>(searchParams.get('actionType') || '');
    const [status, setStatus] = useState<string>(searchParams.get('status') || '');
    const [search, setSearch] = useState(searchParams.get('search') || '');
    const [debouncedSearch, setDebouncedSearch] = useState(search);

    const requestIdRef = useRef(0);
    const hasMountedRef = useRef(false);
    const hasActiveFilters = actionType !== '' || status !== '' || debouncedSearch !== '';

    // Sync filters → URL query params
    useEffect(() => {
        if (!hasMountedRef.current) {
            hasMountedRef.current = true;
            return;
        }
        const params = new URLSearchParams();
        if (actionType) params.set('actionType', actionType);
        if (status) params.set('status', status);
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (page > 1) params.set('page', String(page));
        const query = params.toString();
        router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
    }, [actionType, status, debouncedSearch, page, pathname, router]);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const fetchActivities = useCallback(
        async (currentPage: number, silent = false) => {
            const currentRequestId = ++requestIdRef.current;
            if (!silent) setLoading(true);
            try {
                const response = await getActivityLog({
                    actionType: actionType || undefined,
                    status: status || undefined,
                    search: debouncedSearch || undefined,
                    limit: ITEMS_PER_PAGE,
                    offset: (currentPage - 1) * ITEMS_PER_PAGE,
                });

                if (currentRequestId === requestIdRef.current && response.success) {
                    setActivities(response.activities);
                    setTotal(response.total);
                }
            } catch (error) {
                if (currentRequestId === requestIdRef.current && !silent) {
                    console.error('Failed to fetch activities:', error);
                    toast.error(t('fetchFailed'));
                }
            } finally {
                if (currentRequestId === requestIdRef.current && !silent) {
                    setLoading(false);
                }
            }
        },
        [actionType, status, debouncedSearch, t],
    );

    // Refetch on filter/search change (non-silent)
    useEffect(() => {
        setPage(1);
        fetchActivities(1);
    }, [fetchActivities]);

    // Polling — silent refresh, paused when tab is hidden
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;

        const startPolling = () => {
            interval = setInterval(() => {
                if (!document.hidden) {
                    fetchActivities(page, true);
                }
            }, POLL_INTERVAL);
        };

        const handleVisibility = () => {
            clearInterval(interval);
            if (!document.hidden) {
                // Immediately refresh when returning to tab, then resume polling
                fetchActivities(page, true);
                startPolling();
            }
        };

        startPolling();
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [fetchActivities, page]);

    const handlePageChange = (newPage: number) => {
        setPage(newPage);
        fetchActivities(newPage);
    };

    const handleClearFilters = () => {
        setActionType('');
        setStatus('');
        setSearch('');
        setDebouncedSearch('');
    };

    const handleExport = async () => {
        const params = new URLSearchParams();
        if (actionType) params.set('actionType', actionType);
        if (status) params.set('status', status);
        if (debouncedSearch) params.set('search', debouncedSearch);
        const query = params.toString();

        try {
            const response = await fetch(`/api/activity-log/export${query ? `?${query}` : ''}`, {
                method: 'GET',
            });

            if (!response.ok) {
                throw new Error('Export failed');
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'activity-log.csv';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch {
            toast.error(t('exportFailed'));
        }
    };

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-text-muted dark:text-text-muted-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                <button
                    onClick={handleExport}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                >
                    <Download className="w-4 h-4" />
                    {t('actions.export')}
                </button>
            </div>

            <ActivityFilters
                actionType={actionType}
                onActionTypeChange={setActionType}
                status={status}
                onStatusChange={setStatus}
                search={search}
                onSearchChange={setSearch}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={handleClearFilters}
            />

            {activities.length === 0 && !loading ? (
                <ActivityEmptyState
                    filtered={hasActiveFilters}
                    onClearFilters={handleClearFilters}
                />
            ) : (
                <>
                    <ActivityTable activities={activities} loading={loading} />

                    {totalPages > 1 && (
                        <div className="flex items-center justify-between">
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('showing', {
                                    from: (page - 1) * ITEMS_PER_PAGE + 1,
                                    to: Math.min(page * ITEMS_PER_PAGE, total),
                                    total,
                                })}
                            </p>
                            <div className="flex items-center gap-3">
                                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('pagination.pageOf', { page, total: totalPages })}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handlePageChange(page - 1)}
                                        disabled={page <= 1}
                                        className="px-3 py-1.5 text-sm rounded-md border border-border dark:border-border-dark disabled:opacity-50 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                    >
                                        {t('pagination.previous')}
                                    </button>
                                    <button
                                        onClick={() => handlePageChange(page + 1)}
                                        disabled={page >= totalPages}
                                        className="px-3 py-1.5 text-sm rounded-md border border-border dark:border-border-dark disabled:opacity-50 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                    >
                                        {t('pagination.next')}
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
