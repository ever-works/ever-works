'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Work } from '@/lib/api/work';
import { WorkList } from '@/components/works/WorkList';
import { WorksKanbanView } from '@/components/works/WorksKanbanView';
import { ViewModeSwitch, type ViewMode } from '@/components/works/ViewModeSwitch';
import { EmptyState } from '@/components/common/EmptyState';
import { ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import { getWorks } from '@/app/actions/dashboard/works';
import { getWorkStats } from '@/app/actions/dashboard/works';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

const MIN_SEARCH_CHARS = 3;
const DEBOUNCE_MS = 300;
const KANBAN_LIMIT = 500;

interface WorksClientProps {
    initialWorks: Work[];
    totalWorks: number;
    initialStats: {
        totalWorks: number;
        totalItems: number;
        generatingCount: number;
    };
}

export default function WorksClient({ initialWorks, totalWorks, initialStats }: WorksClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const t = useTranslations('dashboard.works');
    const [works, setWorks] = useState<Work[]>(initialWorks);
    const [total, setTotal] = useState(totalWorks);
    const [loading, setLoading] = useState(false);
    const initialQuery = searchParams.get('q') ?? '';
    const [searchQuery, setSearchQuery] = useState(initialQuery);
    const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
    const [page, setPage] = useState(1);
    const [stats, setStats] = useState(initialStats);
    const [kanbanWorks, setKanbanWorks] = useState<Work[]>([]);
    const [kanbanLoading, setKanbanLoading] = useState(false);
    const kanbanRequestIdRef = useRef(0);
    const itemsPerPage = 20;
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [viewMode, setViewMode] = useState<ViewMode>(() => {
        if (typeof window === 'undefined') return 'card';
        return (localStorage.getItem('works-view-mode') as ViewMode) || 'card';
    });

    const handleViewModeChange = (mode: ViewMode) => {
        setViewMode(mode);
        localStorage.setItem('works-view-mode', mode);
    };

    // Handle query params: ?focus=search or ?q=searchterm
    useEffect(() => {
        const q = searchParams.get('q');
        if (q) {
            setSearchQuery(q);
            setDebouncedQuery(q);
            searchInputRef.current?.focus();
            const url = new URL(window.location.href);
            url.searchParams.delete('q');
            window.history.replaceState({}, '', url.toString());
        } else if (searchParams.get('focus') === 'search' && searchInputRef.current) {
            searchInputRef.current.focus();
            const url = new URL(window.location.href);
            url.searchParams.delete('focus');
            window.history.replaceState({}, '', url.toString());
        }
    }, [searchParams]);

    // Request tracking to ignore stale responses
    const requestIdRef = useRef(0);
    const isInitialMount = useRef(true);

    const performSearch = useCallback(
        async (query: string, currentPage: number) => {
            // Increment request ID to track this specific request
            const currentRequestId = ++requestIdRef.current;

            setLoading(true);
            try {
                const response = await getWorks({
                    search: query || undefined,
                    limit: itemsPerPage,
                    offset: (currentPage - 1) * itemsPerPage,
                });

                // Only update state if this is still the latest request
                if (currentRequestId === requestIdRef.current && response.success) {
                    setWorks(response.works);
                    setTotal(response.total);
                }
            } catch (error) {
                // Only show error if this is still the latest request
                if (currentRequestId === requestIdRef.current) {
                    console.error('Failed to search works:', error);
                    toast.error(t('searchFailed'));
                }
            } finally {
                // Only clear loading if this is still the latest request
                if (currentRequestId === requestIdRef.current) {
                    setLoading(false);
                }
            }
        },
        [itemsPerPage, t],
    );

    const refreshStats = useCallback(async () => {
        try {
            const response = await getWorkStats();
            if (response.success) {
                setStats({
                    totalWorks: response.totalWorks,
                    totalItems: response.totalItems,
                    generatingCount: response.generatingCount,
                });
            }
        } catch (error) {
            console.error('Failed to refresh Work stats:', error);
        }
    }, []);

    const fetchKanbanWorks = useCallback(
        async (query: string) => {
            const currentRequestId = ++kanbanRequestIdRef.current;
            setKanbanLoading(true);
            try {
                const response = await getWorks({
                    search: query || undefined,
                    limit: KANBAN_LIMIT,
                    offset: 0,
                });
                if (currentRequestId === kanbanRequestIdRef.current && response.success) {
                    setKanbanWorks(response.works);
                }
            } catch (error) {
                if (currentRequestId === kanbanRequestIdRef.current) {
                    console.error('Failed to fetch kanban works:', error);
                    toast.error(t('searchFailed'));
                }
            } finally {
                if (currentRequestId === kanbanRequestIdRef.current) {
                    setKanbanLoading(false);
                }
            }
        },
        [t],
    );

    // Debounce search query
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(searchQuery);
        }, DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Perform search when debounced query changes
    useEffect(() => {
        // Skip initial mount to avoid duplicate fetch
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        // Search when query is empty (to reset) or has MIN_SEARCH_CHARS+ characters
        if (debouncedQuery === '' || debouncedQuery.length >= MIN_SEARCH_CHARS) {
            setPage(1); // Reset to first page on new search
            performSearch(debouncedQuery, 1);
        }
    }, [debouncedQuery, performSearch]);

    useEffect(() => {
        if (viewMode === 'kanban') {
            void fetchKanbanWorks(debouncedQuery);
        }
    }, [viewMode, debouncedQuery, fetchKanbanWorks]);

    const handlePageChange = async (newPage: number) => {
        setPage(newPage);
        performSearch(debouncedQuery, newPage);
    };

    useEffect(() => {
        const interval = setInterval(
            () => {
                if (!document.hidden) {
                    void refreshStats();
                }
            },
            stats.generatingCount > 0 ? 3000 : 30000,
        );

        return () => clearInterval(interval);
    }, [refreshStats, stats.generatingCount]);

    const totalPages = Math.ceil(total / itemsPerPage);
    const hasWorks = works.length > 0;
    const summaryCards = [
        {
            label: t('summary.totalWorks'),
            value: stats.totalWorks,
            accent: 'text-blue-600 dark:text-blue-300',
            active: false,
        },
        {
            label: t('summary.generating'),
            value: stats.generatingCount,
            accent: 'text-primary',
            active: stats.generatingCount > 0,
        },
        {
            label: t('summary.totalItems'),
            value: stats.totalItems,
            accent: 'text-emerald-600 dark:text-emerald-300',
            active: false,
        },
    ];

    return (
        <div className="w-full">
            <div className="mb-8 flex flex-col gap-4 @lg/main:flex-row @lg/main:items-start @lg/main:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    {summaryCards.map((card) => (
                        <div
                            key={card.label}
                            className={cn(
                                'rounded-lg border px-3 py-2 bg-card dark:bg-card-primary-dark text-left min-w-[120px]',
                                'border-border dark:border-border-dark transition-colors',
                                card.active &&
                                    'border-primary/40 shadow-[0_0_0_1px_rgba(59,130,246,0.08)]',
                            )}
                        >
                            <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                {card.label}
                            </p>
                            <p
                                className={cn(
                                    'mt-1 text-lg font-semibold',
                                    card.accent,
                                    card.active && 'animate-pulse',
                                )}
                            >
                                {card.value.toLocaleString()}
                            </p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Search and Actions Bar */}
            <div className="flex flex-col @sm/main:flex-row gap-4 mb-8">
                <div className="flex-1">
                    <div className="relative">
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder={t('search')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className={cn(
                                'w-full px-4 py-2 pl-10 rounded-lg',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                'focus:outline-none focus:ring-2 focus:ring-primary',
                            )}
                        />
                        <svg
                            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted dark:text-text-muted-dark"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                            />
                        </svg>
                    </div>
                </div>

                <Link
                    href={ROUTES.DASHBOARD_WORKS_NEW}
                    className={cn(
                        'px-6 py-2 rounded-lg font-medium transition-colors inline-flex items-center gap-2',
                        'bg-black dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-sm',
                    )}
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m8-8H4"
                        />
                    </svg>
                    {t('create')}
                </Link>
            </div>

            {/* Work Count + View Mode Switch */}
            {total > 0 && (
                <div className="mb-4 flex items-center justify-between gap-2">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('showing', { current: works.length, total })}
                    </p>
                    <ViewModeSwitch
                        mode={viewMode}
                        onChange={handleViewModeChange}
                        cardLabel={t('viewMode.card')}
                        kanbanLabel={t('viewMode.kanban')}
                    />
                </div>
            )}

            {/* Works List / Kanban */}
            {loading ? (
                <div className="flex justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
            ) : hasWorks ? (
                <>
                    {viewMode === 'kanban' ? (
                        kanbanLoading ? (
                            <div className="flex justify-center py-12">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                            </div>
                        ) : (
                            <WorksKanbanView works={kanbanWorks} />
                        )
                    ) : (
                        <WorkList
                            initialWorks={works}
                            onUpdate={(updatedWorks) => setWorks(updatedWorks)}
                        />
                    )}

                    {/* Pagination — hidden in kanban mode */}
                    {viewMode !== 'kanban' && totalPages > 1 && (
                        <div className="mt-8 flex justify-center">
                            <nav className="flex gap-2">
                                <button
                                    onClick={() => handlePageChange(page - 1)}
                                    disabled={page === 1}
                                    className={cn(
                                        'px-4 py-2 rounded-lg transition-colors',
                                        'border border-border dark:border-border-dark',
                                        page === 1
                                            ? 'text-text-muted dark:text-text-muted-dark cursor-not-allowed'
                                            : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                    )}
                                >
                                    {t('pagination.previous')}
                                </button>

                                {/* Page Numbers */}
                                <div className="flex gap-1">
                                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                        let pageNum;
                                        if (totalPages <= 5) {
                                            pageNum = i + 1;
                                        } else if (page <= 3) {
                                            pageNum = i + 1;
                                        } else if (page >= totalPages - 2) {
                                            pageNum = totalPages - 4 + i;
                                        } else {
                                            pageNum = page - 2 + i;
                                        }

                                        return (
                                            <button
                                                key={pageNum}
                                                onClick={() => handlePageChange(pageNum)}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg transition-colors',
                                                    pageNum === page
                                                        ? 'bg-primary text-white'
                                                        : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                                )}
                                            >
                                                {pageNum}
                                            </button>
                                        );
                                    })}
                                </div>

                                <button
                                    onClick={() => handlePageChange(page + 1)}
                                    disabled={page === totalPages}
                                    className={cn(
                                        'px-4 py-2 rounded-lg transition-colors',
                                        'border border-border dark:border-border-dark',
                                        page === totalPages
                                            ? 'text-text-muted dark:text-text-muted-dark cursor-not-allowed'
                                            : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                    )}
                                >
                                    {t('pagination.next')}
                                </button>
                            </nav>
                        </div>
                    )}
                </>
            ) : (
                <EmptyState
                    title={t('empty.notFound.title')}
                    description={
                        searchQuery
                            ? t('empty.notFound.withSearch')
                            : t('empty.notFound.withoutSearch')
                    }
                    action={{
                        label: t('empty.action'),
                        onClick: () => {
                            router.push(ROUTES.DASHBOARD_WORKS_NEW);
                        },
                    }}
                />
            )}
        </div>
    );
}
