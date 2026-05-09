'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { getActivityLog, getActivitySummary } from '@/app/actions/activity-log';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityTable } from '@/components/activity-log/ActivityTable';
import { ActivityFilters } from '@/components/activity-log/ActivityFilters';
import { ActivityEmptyState } from '@/components/activity-log/ActivityEmptyState';
import { ActivityKanbanView } from '@/components/activity-log/ActivityKanbanView';
import { ViewModeSwitch, type ViewMode } from '@/components/works/ViewModeSwitch';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';

const POLL_INTERVAL = 5000;
const ITEMS_PER_PAGE = 25;
const KANBAN_LIMIT = 500;

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
    const [summary, setSummary] = useState({
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
    });

    const [kanbanActivities, setKanbanActivities] = useState<ActivityLogEntry[]>([]);
    const [kanbanLoading, setKanbanLoading] = useState(false);

    const requestIdRef = useRef(0);
    const kanbanRequestIdRef = useRef(0);
    const hasMountedRef = useRef(false);
    const [pendingStatusKey, setPendingStatusKey] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>(() => {
        if (typeof window === 'undefined') return 'card';
        return (localStorage.getItem('activity-view-mode') as ViewMode) || 'card';
    });

    const handleViewModeChange = (mode: ViewMode) => {
        setViewMode(mode);
        localStorage.setItem('activity-view-mode', mode);
    };
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
        async (
            currentPage: number,
            filters: { actionType: string; status: string; search: string },
            silent = false,
        ) => {
            const currentRequestId = ++requestIdRef.current;
            if (!silent) setLoading(true);
            try {
                const response = await getActivityLog({
                    actionType: filters.actionType || undefined,
                    status: filters.status || undefined,
                    search: filters.search || undefined,
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
                    setPendingStatusKey(null);
                }
            }
        },
        [t],
    );

    const fetchKanbanActivities = useCallback(
        async (filters: { actionType: string; status: string; search: string }) => {
            const currentRequestId = ++kanbanRequestIdRef.current;
            setKanbanLoading(true);
            try {
                const response = await getActivityLog({
                    actionType: filters.actionType || undefined,
                    status: filters.status || undefined,
                    search: filters.search || undefined,
                    limit: KANBAN_LIMIT,
                    offset: 0,
                });
                if (currentRequestId === kanbanRequestIdRef.current && response.success) {
                    setKanbanActivities(response.activities);
                }
            } catch (error) {
                if (currentRequestId === kanbanRequestIdRef.current) {
                    console.error('Failed to fetch kanban activities:', error);
                }
            } finally {
                if (currentRequestId === kanbanRequestIdRef.current) {
                    setKanbanLoading(false);
                }
            }
        },
        [],
    );

    const fetchSummary = useCallback(async () => {
        const response = await getActivitySummary();
        if (response.success) {
            setSummary(response.counts);
        }
    }, []);

    // Reset pagination on filter/search change
    useEffect(() => {
        setPage(1);
    }, [actionType, status, debouncedSearch]);

    // Fetch for the current page + filters
    useEffect(() => {
        void fetchActivities(
            page,
            {
                actionType,
                status,
                search: debouncedSearch,
            },
            false,
        );
    }, [page, actionType, status, debouncedSearch, fetchActivities]);

    useEffect(() => {
        void fetchSummary();
    }, [fetchSummary]);

    // Fetch all activities for kanban view (no pagination)
    useEffect(() => {
        if (viewMode === 'kanban') {
            void fetchKanbanActivities({ actionType, status, search: debouncedSearch });
        }
    }, [viewMode, actionType, status, debouncedSearch, fetchKanbanActivities]);

    // Polling — silent refresh, paused when tab is hidden
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;

        const startPolling = () => {
            interval = setInterval(() => {
                if (!document.hidden) {
                    void fetchSummary();
                    void fetchActivities(
                        page,
                        {
                            actionType,
                            status,
                            search: debouncedSearch,
                        },
                        true,
                    );
                }
            }, POLL_INTERVAL);
        };

        const handleVisibility = () => {
            clearInterval(interval);
            if (!document.hidden) {
                // Immediately refresh when returning to tab, then resume polling
                void fetchSummary();
                void fetchActivities(
                    page,
                    {
                        actionType,
                        status,
                        search: debouncedSearch,
                    },
                    true,
                );
                startPolling();
            }
        };

        startPolling();
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [fetchActivities, fetchSummary, page, actionType, status, debouncedSearch]);

    const handlePageChange = (newPage: number) => {
        setPage(newPage);
    };

    const handleClearFilters = () => {
        setActionType('');
        setStatus('');
        setSearch('');
        setDebouncedSearch('');
        setPendingStatusKey(null);
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
            setTimeout(() => URL.revokeObjectURL(url), 1000); // Let the browser start the download before revoking the blob URL.
        } catch {
            toast.error(t('exportFailed'));
        }
    };

    const refreshCurrentPage = useCallback(() => {
        void fetchSummary();
        void fetchActivities(
            page,
            {
                actionType,
                status,
                search: debouncedSearch,
            },
            false,
        );
    }, [fetchActivities, fetchSummary, page, actionType, status, debouncedSearch]);

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const summaryCards = [
        { key: 'in_progress', count: summary.in_progress, label: t('filters.statuses.inProgress') },
        { key: 'completed', count: summary.completed, label: t('filters.statuses.completed') },
        { key: 'pending', count: summary.pending, label: t('filters.statuses.pending') },
        { key: 'failed', count: summary.failed, label: t('filters.statuses.failed') },
        { key: 'cancelled', count: summary.cancelled, label: t('filters.statuses.cancelled') },
    ] as const;

    const statusConfig = {
        in_progress: {
            dot: 'bg-info',
            activeBg: 'bg-info/5 dark:bg-info/10',
            activeBorder: 'border-info/40 dark:border-info/30',
        },
        completed: {
            dot: 'bg-success',
            activeBg: 'bg-success/5 dark:bg-success/10',
            activeBorder: 'border-success/40 dark:border-success/30',
        },
        pending: {
            dot: 'bg-warning',
            activeBg: 'bg-warning/5 dark:bg-warning/10',
            activeBorder: 'border-warning/40 dark:border-warning/30',
        },
        failed: {
            dot: 'bg-danger',
            activeBg: 'bg-danger/5 dark:bg-danger/10',
            activeBorder: 'border-danger/40 dark:border-danger/30',
        },
        cancelled: {
            dot: 'bg-amber-500',
            activeBg: 'bg-amber-50 dark:bg-amber-900/10',
            activeBorder: 'border-amber-400/40 dark:border-amber-500/30',
        },
    } as const;

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
                <div className="flex items-center gap-2">
                    <ViewModeSwitch
                        mode={viewMode}
                        onChange={handleViewModeChange}
                        cardLabel={t('viewMode.table')}
                        kanbanLabel={t('viewMode.board')}
                    />
                    <button
                        onClick={handleExport}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                    >
                        <Download className="w-3.5 h-3.5" />
                        {t('actions.export')}
                    </button>
                </div>
            </div>

            <div className="grid gap-2 @sm/main:grid-cols-2 @xl/main:grid-cols-5">
                {summaryCards.map((card) => {
                    const isActive = status === card.key;
                    const config = statusConfig[card.key];

                    return (
                        <button
                            key={card.key}
                            type="button"
                            onClick={() => {
                                if (!isActive) {
                                    setPendingStatusKey(card.key);
                                }
                                setStatus(isActive ? '' : card.key);
                            }}
                            disabled={loading}
                            aria-busy={loading && pendingStatusKey === card.key}
                            className={`rounded-lg cursor-pointer border px-4 py-3.5 text-left transition-all duration-150 ${
                                isActive
                                    ? `${config.activeBorder} ${config.activeBg}`
                                    : 'border-border dark:border-border-dark bg-card dark:bg-card-primary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark'
                            } ${loading ? 'opacity-70 cursor-wait' : ''}`}
                        >
                            <div className="flex items-center gap-1.5 mb-2">
                                <span
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dot}`}
                                />
                                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {card.label}
                                </p>
                                {loading && pendingStatusKey === card.key && (
                                    <Loader2 className="w-3 h-3 animate-spin text-text-muted dark:text-text-muted-dark" />
                                )}
                            </div>
                            <p className="text-xl font-normal tabular-nums text-text dark:text-text-dark">
                                {card.count.toLocaleString()}
                            </p>
                        </button>
                    );
                })}
            </div>

            <ActivityFilters
                actionType={actionType}
                onActionTypeChange={setActionType}
                status={status}
                onStatusChange={setStatus}
                search={search}
                onSearchChange={setSearch}
                loading={loading}
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
                    {viewMode === 'kanban' ? (
                        kanbanLoading ? (
                            <div className="flex justify-center py-16">
                                <Loader2 className="w-6 h-6 animate-spin text-text-muted dark:text-text-muted-dark" />
                            </div>
                        ) : (
                            <ActivityKanbanView
                                activities={kanbanActivities}
                                onStopRequested={refreshCurrentPage}
                            />
                        )
                    ) : (
                        <ActivityTable
                            activities={activities}
                            loading={loading}
                            onStopRequested={refreshCurrentPage}
                        />
                    )}

                    {/* Pagination + view mode switch — hidden in kanban mode */}
                    {viewMode !== 'kanban' && totalPages > 1 && (
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
                                <div className="flex gap-1.5">
                                    <button
                                        onClick={() => handlePageChange(page - 1)}
                                        disabled={page <= 1}
                                        className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                    >
                                        {t('pagination.previous')}
                                    </button>
                                    <button
                                        onClick={() => handlePageChange(page + 1)}
                                        disabled={page >= totalPages}
                                        className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
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
