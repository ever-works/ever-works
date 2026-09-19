'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getSchedulePage, getScheduleHealth } from '@/app/actions/dashboard/schedules';
import type { ScheduleEntry, ScheduleHealthSummary, SchedulePage } from '@/lib/api/schedules';
import { ActivityViewHeader } from '@/components/activity-log/ActivityViewHeader';
import { ScheduleHealthBanner } from './ScheduleHealthBanner';
import { ScheduleWorkspaceRow } from './ScheduleWorkspaceRow';
import { SchedulesCreateMenu } from './SchedulesCreateMenu';
import { SchedulesDegradedNotice } from './SchedulesDegradedNotice';
import { SchedulesEmptyState } from './SchedulesEmptyState';
import { SchedulesFilters } from './SchedulesFilters';
import { ScheduleSourceChips } from './ScheduleSourceChips';
import {
    EMPTY_SCHEDULE_FILTERS,
    filtersFromSearchParams,
    hasActiveFilters,
    pageParamsFor,
    scheduleFilterParams,
    type SchedulesFilterState,
} from './schedules-filters.shared';

/** Re-read the list at least this often while the list is open (FR-10). */
const REFRESH_MS = 60_000;
/** Never re-read more pages than this on a background refresh. */
const MAX_REFRESH_PAGES = 10;

function offsetFrom(page: SchedulePage | null): number {
    if (!page?.generatedAt) return 0;
    const server = Date.parse(page.generatedAt);
    return Number.isNaN(server) ? 0 : server - Date.now();
}

/**
 * The Schedules list — every Schedule the workspace owns, from every source,
 * on one paged list with filters, health and row controls.
 *
 * It reads the paged projection through `getSchedulePage`. The list, the health
 * banner and each failure load and fail independently; the list re-reads every
 * 60 seconds and whenever the tab regains focus.
 *
 * WHERE IT LIVES: this was the `/schedules` page, and it is now the Schedules
 * view of the Activity page — one surface instead of two near-identical ones.
 * The filters are therefore the HOST's to own: with `syncUrl={false}` the list
 * reports every filter change through `onFiltersChange` and writes nothing
 * itself, because a page that hosts several views has exactly one writer for
 * its address bar (and the host has to keep `?view=schedules` in the URL while
 * this component's own `router.replace` would drop it).
 */
export function SchedulesWorkspace({
    initialPage,
    initialHealth,
    initialFailed = false,
    initialHealthFailed = false,
    syncUrl = true,
    filters: hostFilters,
    onFiltersChange,
    createTriggerRef,
}: {
    initialPage: SchedulePage | null;
    initialHealth: ScheduleHealthSummary | null;
    initialFailed?: boolean;
    initialHealthFailed?: boolean;
    /** False when the host page owns the URL (the Activity page's Schedules view). */
    syncUrl?: boolean;
    /** The host's filter state; required with `syncUrl={false}`. */
    filters?: SchedulesFilterState;
    /** The host's single URL writer. Required with `syncUrl={false}`. */
    onFiltersChange?: (filters: SchedulesFilterState) => void;
    /** Lets the "Create" menu open the inbound-trigger dialog below the list. */
    createTriggerRef?: RefObject<(() => void) | null>;
}) {
    const t = useTranslations('dashboard.schedules');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const urlFilters = useMemo(
        () =>
            filtersFromSearchParams(
                searchParams ? new URLSearchParams(searchParams.toString()) : null,
            ),
        [searchParams],
    );
    // One source of truth per mode: the host's state when embedded, the address
    // bar when this list is the page.
    const filters = hostFilters ?? urlFilters;

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
    /**
     * Did the server hand this instance a result — a page, or a recorded
     * failure to retry? See the mount effect below for why the answer decides
     * whether the first load happens here.
     */
    const hostFetched = initialPage !== null || initialFailed;
    /**
     * Every read that writes the list (a filter change, a background refresh,
     * a row change, load more) takes the next generation, and only a response
     * whose generation is still the latest may touch state. A slow older read
     * that lands after a newer one is dropped instead of replacing its rows.
     */
    const generation = useRef(0);

    for (const row of items) {
        if (row.agentId && row.agentName) knownAgents.current.set(row.agentId, row.agentName);
    }
    const agents = [...knownAgents.current.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const load = useCallback(
        async (pageCount: number, showSpinner: boolean) => {
            const request = ++generation.current;
            const isCurrent = () => request === generation.current;
            if (showSpinner) setLoading(true);
            let collected: ScheduleEntry[] = [];
            let last: SchedulePage | null = null;
            let cursor: string | null = null;
            let loaded = 0;
            try {
                do {
                    const response = await getSchedulePage({ ...pageParamsFor(filters), cursor });
                    if (!isCurrent()) return;
                    if (!response.ok) {
                        setFailed(true);
                        return;
                    }
                    last = response.page;
                    collected = [...collected, ...response.page.items];
                    cursor = response.page.nextCursor;
                    loaded += 1;
                } while (cursor && loaded < Math.min(pageCount, MAX_REFRESH_PAGES));
                setFailed(false);
                setItems(collected);
                setPage(last);
                setPagesLoaded(Math.max(1, loaded));
                setServerOffsetMs(offsetFrom(last));
            } finally {
                // The latest read owns the spinner — including when a
                // superseded read was the one that raised it.
                if (isCurrent()) setLoading(false);
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
    //
    // The mount is the first load only when the SERVER actually delivered one.
    // As the `/schedules` page it always had: either a page or a recorded
    // failure, and in both cases re-fetching on mount would duplicate the read
    // (or stamp on the retry screen). As the Activity page's Schedules view it
    // often has neither — the reader switched to the tab client-side, so the
    // page was rendered for a different view — and then there is nothing to
    // show until this runs. Without the distinction the tab renders its
    // "no match" empty state over an unfetched list.
    const firstRender = useRef(hostFetched);
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        void load(1, true);
        // The health summary comes from a second read that the page also made
        // on the server; the embedded mount owes it too, rather than waiting for
        // the 60 s background refresh to notice.
        if (!hostFetched) void loadHealth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            if (!syncUrl) {
                onFiltersChange?.(next);
                return;
            }
            const params = new URLSearchParams(searchParams?.toString() ?? '');
            const owned = ['source', 'status', 'health', 'agent', 'active', 'q'];
            for (const key of owned) params.delete(key);
            for (const [key, value] of scheduleFilterParams(next)) params.set(key, value);
            const query = params.toString();
            router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
        },
        [pathname, router, searchParams, syncUrl, onFiltersChange],
    );

    const loadMore = async () => {
        if (!page?.nextCursor) return;
        const request = ++generation.current;
        setLoadingMore(true);
        try {
            const response = await getSchedulePage({
                ...pageParamsFor(filters),
                cursor: page.nextCursor,
            });
            if (request !== generation.current) return;
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

    // The SECTION header every Activity view carries — the Live Feed's own,
    // small enough to sit under the page's `h1` instead of competing with it.
    // The button on its right is "Create"; the one that used to link back to
    // Activity is gone, because linking to the page this list already lives on
    // was a self-link.
    const header = (
        <ActivityViewHeader
            title={t('title')}
            subtitle={t('pageSubtitle')}
            aside={<SchedulesCreateMenu onNewTrigger={() => createTriggerRef?.current?.()} />}
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
                    <ScheduleSourceChips
                        value={filters}
                        counts={page?.unfilteredCountsBySourceType ?? page?.countsBySourceType}
                        total={page?.unfilteredTotal ?? items.length}
                        onSourceChange={(source) => setFilters({ ...filters, source })}
                        onActiveOnlyChange={(activeOnly) => setFilters({ ...filters, activeOnly })}
                    />

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
