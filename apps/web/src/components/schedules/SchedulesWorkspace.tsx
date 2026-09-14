'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, List, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { getSchedulePage, getScheduleHealth } from '@/app/actions/dashboard/schedules';
import type { ScheduleEntry, ScheduleHealthSummary, SchedulePage } from '@/lib/api/schedules';
import { PageHeader } from '@/components/common/PageHeader';
import { ScheduleHealthBanner } from './ScheduleHealthBanner';
import { ScheduleWorkspaceRow } from './ScheduleWorkspaceRow';
import { SchedulesDegradedNotice } from './SchedulesDegradedNotice';
import { SchedulesEmptyState } from './SchedulesEmptyState';
import { SchedulesFilters } from './SchedulesFilters';
import {
    EMPTY_SCHEDULE_FILTERS,
    filtersFromSearchParams,
    hasActiveFilters,
    pageParamsFor,
    type SchedulesFilterState,
} from './schedules-filters.shared';

/** Re-read the list at least this often while the page is open (FR-10). */
const REFRESH_MS = 60_000;
/** Never re-read more pages than this on a background refresh. */
const MAX_REFRESH_PAGES = 10;

function offsetFrom(page: SchedulePage | null): number {
    if (!page?.generatedAt) return 0;
    const server = Date.parse(page.generatedAt);
    return Number.isNaN(server) ? 0 : server - Date.now();
}

/**
 * The Schedules workspace — every Schedule the workspace owns, from every
 * source, on one paged list with health and row controls.
 *
 * It reads the same projection as the Activity page's Schedules tab (which
 * stays exactly as it is) through the paged endpoint. The list, the health
 * banner and each failure load and fail independently; filters live in the
 * URL; the list re-reads every 60 seconds and whenever the tab regains focus.
 */
export function SchedulesWorkspace({
    initialPage,
    initialHealth,
    initialFailed = false,
    initialHealthFailed = false,
}: {
    initialPage: SchedulePage | null;
    initialHealth: ScheduleHealthSummary | null;
    initialFailed?: boolean;
    initialHealthFailed?: boolean;
}) {
    const t = useTranslations('dashboard.schedules');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const filters = useMemo(
        () =>
            filtersFromSearchParams(
                searchParams ? new URLSearchParams(searchParams.toString()) : null,
            ),
        [searchParams],
    );

    const [items, setItems] = useState<ScheduleEntry[]>(initialPage?.items ?? []);
    const [page, setPage] = useState<SchedulePage | null>(initialPage);
    const [pagesLoaded, setPagesLoaded] = useState(1);
    const [failed, setFailed] = useState(initialFailed);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [health, setHealth] = useState<ScheduleHealthSummary | null>(initialHealth);
    const [healthFailed, setHealthFailed] = useState(initialHealthFailed);
    const [serverOffsetMs, setServerOffsetMs] = useState(() => offsetFrom(initialPage));
    const knownAgents = useRef(new Map<string, string>());
    const firstRender = useRef(true);

    for (const row of items) {
        if (row.agentId && row.agentName) knownAgents.current.set(row.agentId, row.agentName);
    }
    const agents = [...knownAgents.current.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const load = useCallback(
        async (pageCount: number, showSpinner: boolean) => {
            if (showSpinner) setLoading(true);
            const collected: ScheduleEntry[] = [];
            let last: SchedulePage | null = null;
            let cursor: string | null = null;
            let loaded = 0;
            try {
                do {
                    const response = await getSchedulePage({ ...pageParamsFor(filters), cursor });
                    if (!response.ok) {
                        setFailed(true);
                        return;
                    }
                    last = response.page;
                    collected.push(...response.page.items);
                    cursor = response.page.nextCursor;
                    loaded += 1;
                } while (cursor && loaded < Math.min(pageCount, MAX_REFRESH_PAGES));
                setFailed(false);
                setItems(collected);
                setPage(last);
                setPagesLoaded(Math.max(1, loaded));
                setServerOffsetMs(offsetFrom(last));
            } finally {
                if (showSpinner) setLoading(false);
            }
        },
        [filters],
    );

    const loadHealth = useCallback(async () => {
        const response = await getScheduleHealth();
        if (response.ok) {
            setHealth(response.summary);
            setHealthFailed(false);
        } else {
            setHealthFailed(true);
        }
    }, []);

    // A filter change starts again from the first page.
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        void load(1, true);
    }, [load]);

    // Background refresh: every minute, and as soon as the tab is visible again.
    const pagesRef = useRef(pagesLoaded);
    pagesRef.current = pagesLoaded;
    useEffect(() => {
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            void load(pagesRef.current, false);
            void loadHealth();
        };
        const timer = window.setInterval(refresh, REFRESH_MS);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [load, loadHealth]);

    const setFilters = useCallback(
        (next: SchedulesFilterState) => {
            const params = new URLSearchParams(searchParams?.toString() ?? '');
            for (const [key, value] of [
                ['source', next.source],
                ['status', next.status],
                ['health', next.health],
                ['agent', next.agent],
                ['q', next.q],
            ] as const) {
                if (value) params.set(key, value);
                else params.delete(key);
            }
            const query = params.toString();
            router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const loadMore = async () => {
        if (!page?.nextCursor) return;
        setLoadingMore(true);
        try {
            const response = await getSchedulePage({
                ...pageParamsFor(filters),
                cursor: page.nextCursor,
            });
            if (response.ok) {
                setItems((current) => [...current, ...response.page.items]);
                setPage(response.page);
                setPagesLoaded((count) => count + 1);
            }
        } finally {
            setLoadingMore(false);
        }
    };

    const onRowChanged = (updated?: ScheduleEntry) => {
        if (updated) {
            setItems((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        }
        void load(pagesRef.current, false);
        void loadHealth();
    };

    const header = (
        <PageHeader
            icon={CalendarClock}
            title={t('title')}
            subtitle={t('pageSubtitle')}
            tone="primary"
            actions={
                <Link
                    href={ROUTES.DASHBOARD_ACTIVITY}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-secondary dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                >
                    <List className="h-3.5 w-3.5" />
                    {t('backToActivity')}
                </Link>
            }
        />
    );

    if (failed && items.length === 0) {
        return (
            <div className="space-y-6" data-testid="schedules-workspace">
                {header}
                <div
                    data-testid="schedules-workspace-failed"
                    className="flex flex-col items-center justify-center py-16 text-center"
                >
                    <h3 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('errors.listFailed')}
                    </h3>
                    <p className="mt-1 max-w-md text-sm text-text-muted dark:text-text-muted-dark">
                        {t('errors.listFailedBody')}
                    </p>
                    <button
                        type="button"
                        onClick={() => void load(1, true)}
                        className="mt-3 text-sm font-medium text-primary hover:underline"
                    >
                        {t('retry')}
                    </button>
                </div>
            </div>
        );
    }

    const nothingScheduled =
        page !== null && page.unfilteredTotal === 0 && !hasActiveFilters(filters);

    return (
        <div className="space-y-4" data-testid="schedules-workspace">
            {header}

            <ScheduleHealthBanner summary={health} failed={healthFailed} />

            {nothingScheduled ? (
                <SchedulesEmptyState variant="nothing" />
            ) : (
                <>
                    <SchedulesFilters value={filters} agents={agents} onChange={setFilters} />

                    {page && (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="schedules-summary-line"
                        >
                            {t('summaryLine', {
                                total: page.total,
                                active: page.countsByStatus.active ?? 0,
                                paused: page.countsByStatus.paused ?? 0,
                            })}
                        </p>
                    )}

                    <SchedulesDegradedNotice
                        sources={page?.degradedSources ?? []}
                        onRetry={() => void load(pagesLoaded, true)}
                    />

                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted dark:text-text-muted-dark">
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            {t('loading')}
                        </div>
                    ) : items.length === 0 ? (
                        <SchedulesEmptyState
                            variant="filtered"
                            unfilteredTotal={page?.unfilteredTotal ?? 0}
                            onClear={() => setFilters(EMPTY_SCHEDULE_FILTERS)}
                        />
                    ) : (
                        <div role="table" aria-label={t('title')} className="space-y-2">
                            <div
                                role="row"
                                className="hidden grid-cols-[1.6fr_0.9fr_1.1fr_0.9fr_0.8fr_auto_auto_auto] gap-4 px-4 text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark @3xl/main:grid"
                            >
                                <span role="columnheader">{t('columns.schedule')}</span>
                                <span role="columnheader">{t('columns.agent')}</span>
                                <span role="columnheader">{t('columns.cadence')}</span>
                                <span role="columnheader">{t('columns.next')}</span>
                                <span role="columnheader">{t('columns.last')}</span>
                                <span role="columnheader">{t('columns.health')}</span>
                                <span role="columnheader">{t('columns.status')}</span>
                                <span role="columnheader" className="w-8" />
                            </div>
                            {items.map((schedule) => (
                                <ScheduleWorkspaceRow
                                    key={schedule.id}
                                    schedule={schedule}
                                    serverOffsetMs={serverOffsetMs}
                                    onChanged={onRowChanged}
                                />
                            ))}
                        </div>
                    )}

                    {page && items.length > 0 && (
                        <div className="flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                            <span data-testid="schedules-showing-range">
                                {t('showingRange', { shown: items.length, total: page.total })}
                            </span>
                            {page.nextCursor && (
                                <button
                                    type="button"
                                    data-testid="schedules-load-more"
                                    disabled={loadingMore}
                                    onClick={() => void loadMore()}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-text hover:bg-surface-secondary disabled:opacity-60 dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                                >
                                    {loadingMore && (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    )}
                                    {t('loadMore')}
                                </button>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
