'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { getActivityLog } from '@/app/actions/activity-log';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityTable } from '@/components/activity-log/ActivityTable';
import { ActivityFilters } from '@/components/activity-log/ActivityFilters';
import { ActivityEmptyState } from '@/components/activity-log/ActivityEmptyState';
import { toast } from 'sonner';
import { Download } from 'lucide-react';

const POLL_INTERVAL = 30000;
const ITEMS_PER_PAGE = 25;

interface ActivityClientProps {
    initialActivities: ActivityLogEntry[];
    totalActivities: number;
}

export function ActivityClient({ initialActivities, totalActivities }: ActivityClientProps) {
    const t = useTranslations('dashboard.activity');
    const [activities, setActivities] = useState<ActivityLogEntry[]>(initialActivities);
    const [total, setTotal] = useState(totalActivities);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);

    // Filters
    const [actionType, setActionType] = useState<string>('');
    const [status, setStatus] = useState<string>('');
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    const requestIdRef = useRef(0);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const fetchActivities = useCallback(
        async (currentPage: number) => {
            const currentRequestId = ++requestIdRef.current;
            setLoading(true);
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
                if (currentRequestId === requestIdRef.current) {
                    console.error('Failed to fetch activities:', error);
                    toast.error(t('fetchFailed'));
                }
            } finally {
                if (currentRequestId === requestIdRef.current) {
                    setLoading(false);
                }
            }
        },
        [actionType, status, debouncedSearch, t],
    );

    // Refetch on filter/search change
    useEffect(() => {
        setPage(1);
        fetchActivities(1);
    }, [fetchActivities]);

    // Polling for updates
    useEffect(() => {
        const interval = setInterval(() => fetchActivities(page), POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchActivities, page]);

    const handlePageChange = (newPage: number) => {
        setPage(newPage);
        fetchActivities(newPage);
    };

    const handleExport = async () => {
        try {
            const params = new URLSearchParams();
            if (actionType) params.set('actionType', actionType);
            if (status) params.set('status', status);
            if (debouncedSearch) params.set('search', debouncedSearch);
            const query = params.toString();
            window.open(`/api/activity-log/export${query ? `?${query}` : ''}`, '_blank');
        } catch (error) {
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
            />

            {activities.length === 0 && !loading ? (
                <ActivityEmptyState />
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
                    )}
                </>
            )}
        </div>
    );
}
