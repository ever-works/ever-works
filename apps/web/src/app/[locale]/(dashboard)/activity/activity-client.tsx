'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { getActivityLog, getActivitySummary } from '@/app/actions/activity-log';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityTable } from '@/components/activity-log/ActivityTable';
import { ActivityViewHeader } from '@/components/activity-log/ActivityViewHeader';
import { ActivityFilters } from '@/components/activity-log/ActivityFilters';
import { ActivityEmptyState } from '@/components/activity-log/ActivityEmptyState';
import { ActivityKanbanView } from '@/components/activity-log/ActivityKanbanView';
import { ViewModeSwitch, type ViewMode } from '@/components/works/ViewModeSwitch';
import { SchedulesWorkspace } from '@/components/schedules/SchedulesWorkspace';
import { TriggersManager } from '@/components/schedules/TriggersManager';
import {
    EMPTY_SCHEDULE_FILTERS,
    scheduleFilterParams,
    type SchedulesFilterState,
} from '@/components/schedules/schedules-filters.shared';
import type { ScheduleHealthSummary, SchedulePage } from '@/lib/api/schedules';
import { LiveFeed } from '@/components/feed/LiveFeed';
import {
    feedFiltersToQuery,
    hasFeedFilterParams,
    parseFeedFilters,
} from '@/components/feed/feed-filters';
import type {
    FeedActorSummaryDto,
    FeedPageDto,
    RunLedgerPage,
    RunWindowStats,
} from '@ever-works/contracts';
import { RunsClient } from '@/components/runs/RunsClient';
import { RunsShortcutSheet, type ShortcutRow } from '@/components/runs/RunsShortcutSheet';
import { buildRunsSearch, isTypingTarget, type RunsViewState } from '@/components/runs/runs.shared';
import type { RunsAgentOption } from '@/components/runs/RunsFilters';
import { toast } from 'sonner';
import {
    Activity as ActivityIcon,
    Download,
    Keyboard,
    Loader2,
    List,
    CalendarClock,
    Radio,
    Receipt,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    ACTIVITY_VIEW_KEYS,
    ACTIVITY_VIEW_PARAM,
    isActivityView,
    type ActivityView,
} from './activity-views';

const POLL_INTERVAL = 5000;
const ITEMS_PER_PAGE = 25;
const KANBAN_LIMIT = 500;

/** The server-rendered payload of the Runs view (AW-09), or its empty frame. */
export interface ActivityRunsPayload {
    view: RunsViewState;
    /** Only the server can tell these apart — see `activity/page.tsx`. */
    granularityFromUrl: boolean;
    timeZone: string;
    page: RunLedgerPage | null;
    stats: RunWindowStats | null;
    agents: RunsAgentOption[];
}

/**
 * The Schedules view's server-rendered payload — the filters the link named,
 * plus the first page and the health summary they select. This is the former
 * `/schedules` page's own payload, unchanged.
 */
export interface ActivitySchedulesPayload {
    filters: SchedulesFilterState;
    page: SchedulePage | null;
    failed: boolean;
    health: ScheduleHealthSummary | null;
    healthFailed: boolean;
}

interface ActivityClientProps {
    initialActivities: ActivityLogEntry[];
    totalActivities: number;
    /** Server-rendered Live Feed first page, when the page was opened on `?view=feed`. */
    initialFeedPage?: FeedPageDto | null;
    initialFeedActors?: FeedActorSummaryDto[] | null;
    /** Server-rendered Runs window, when the page was opened on `?view=runs`. */
    runs: ActivityRunsPayload;
    /** Server-rendered Schedules page, when the page was opened on `?view=schedules`. */
    schedules: ActivitySchedulesPayload;
}

/**
 * Activity — ONE page for "what happened in my workspace", across four views:
 * the operation Log, the Runs ledger, the Live Feed and Schedules.
 *
 * This component is the page's single writer of the URL: every view's own
 * state (the Log's filters and page, the feed's agent/kind filters, the
 * ledger's window and filters) is mirrored into `?view=` plus that view's own
 * parameters, and ONLY the active view's parameters are written — so a `status`
 * that means "the run outcome" on one view can never be read back as "the
 * operation status" on another.
 *
 * It also owns the page's keyboard layer and its ONE shortcut sheet. The
 * ledger keeps its own view keys (they only make sense there) and hands its
 * `?`/`/` keys up to this component, so the sheet documents every key the page
 * answers to instead of only the ledger's.
 */
export function ActivityClient({
    initialActivities,
    totalActivities,
    initialFeedPage = null,
    initialFeedActors = null,
    runs,
    schedules,
}: ActivityClientProps) {
    const t = useTranslations('dashboard.activity');
    const tRuns = useTranslations('dashboard.runsPage');
    const tFeed = useTranslations('dashboard.feed');
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

    // Which view. localStorage is the primary persistence; the `?view=` query
    // param enables shareable links and is kept in sync by the URL-sync effect
    // below.
    //
    // Initialise to a deterministic default (the URL ?view= param, else 'log')
    // so server and first client render agree — the persisted localStorage
    // value is restored in the mount effect below to avoid a hydration
    // mismatch.
    const [activeView, setActiveView] = useState<ActivityView>(() => {
        const fromUrl = searchParams.get(ACTIVITY_VIEW_PARAM);
        return isActivityView(fromUrl) ? fromUrl : 'log';
    });

    // The Runs ledger owns its window, filters and open receipt; it reports
    // every change here so this component stays the single URL writer. Seeded
    // from the URL the parser ran on the server, so a shared link paints the
    // exact window it names.
    const [runsView, setRunsView] = useState<RunsViewState>(runs.view);
    const runsSearchRef = useRef<HTMLInputElement>(null);
    const logSearchRef = useRef<HTMLInputElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    // The Schedules list owns its filters, but not the address bar: this
    // component is the page's single URL writer, so the list reports through
    // `onFiltersChange` and the state lives here — which is also what keeps a
    // schedule filter alive while the reader visits another view and comes
    // back. Seeded from the URL the server parsed, so a shared link paints the
    // exact list it names.
    const [scheduleFilters, setScheduleFilters] = useState<SchedulesFilterState>(
        schedules.filters ?? EMPTY_SCHEDULE_FILTERS,
    );
    // Lets the list's "Create" menu open the inbound-trigger dialog below it.
    const triggerCreateRef = useRef<(() => void) | null>(null);

    // The Live Feed owns its own filters and reports them here, so this
    // component stays the single writer of the page URL.
    const [feedQuery, setFeedQuery] = useState(() =>
        hasFeedFilterParams(searchParams) ? feedFiltersToQuery(parseFeedFilters(searchParams)) : '',
    );

    // Restore the persisted view after mount (localStorage is unavailable
    // during SSR). The URL ?view= param always wins when present.
    useEffect(() => {
        const fromUrl = searchParams.get(ACTIVITY_VIEW_PARAM);
        if (isActivityView(fromUrl)) return;
        const stored = localStorage.getItem('activity-tab');
        if (isActivityView(stored)) {
            setActiveView(stored);
        }
        // Mount-only restore; intentionally not reactive to searchParams.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleViewChange = useCallback((next: ActivityView) => {
        setActiveView(next);
        if (typeof window !== 'undefined') {
            localStorage.setItem('activity-tab', next);
        }
    }, []);

    const isLogTab = activeView === 'log';
    const isRunsTab = activeView === 'runs';
    const isSchedulesTab = activeView === 'schedules';
    const isFeedTab = activeView === 'feed';
    const hasActiveFilters = actionType !== '' || status !== '' || debouncedSearch !== '';

    // Sync the ACTIVE view's state → URL query params. The parameters are
    // rebuilt from scratch on every run, which is what keeps the four views'
    // vocabularies apart: leaving the Runs view drops `g`/`d`/`agent`/…, so
    // coming back to the Log can never read a run outcome as an operation
    // status.
    useEffect(() => {
        if (!hasMountedRef.current) {
            hasMountedRef.current = true;
            return;
        }
        const params = new URLSearchParams();
        if (activeView === 'runs') {
            params.set(ACTIVITY_VIEW_PARAM, 'runs');
            // The ledger's own view state, as `buildRunsSearch` writes it for
            // the standalone page — the same URLs, one path prefix different.
            for (const [key, value] of new URLSearchParams(buildRunsSearch(runsView))) {
                params.set(key, value);
            }
        } else if (activeView === 'feed') {
            params.set(ACTIVITY_VIEW_PARAM, 'feed');
            for (const [key, value] of new URLSearchParams(feedQuery)) {
                params.set(key, value);
            }
        } else if (activeView === 'schedules') {
            params.set(ACTIVITY_VIEW_PARAM, 'schedules');
            // The list's own filters, written exactly as the `/schedules` page
            // wrote them, so every link and bookmark for that page still names
            // the list it always named.
            for (const [key, value] of scheduleFilterParams(scheduleFilters)) {
                params.set(key, value);
            }
        } else {
            if (actionType) params.set('actionType', actionType);
            if (status) params.set('status', status);
            if (debouncedSearch) params.set('search', debouncedSearch);
            if (page > 1) params.set('page', String(page));
        }
        const query = params.toString();

        // The ledger writes its window into the address bar on every arrow key
        // and every granularity change; the schedules list writes its filters on
        // every chip, select and search keystroke. A `router.replace` for either
        // would ask the App Router for a server render of this page that nothing
        // uses — both views refetch through their own actions — and the address
        // bar would trail the interaction. `location.pathname` is the address
        // bar's own path, so an `/org/<slug>` prefix is kept.
        if (activeView === 'runs' || activeView === 'schedules') {
            window.history.replaceState(
                null,
                '',
                `${window.location.pathname}${query ? `?${query}` : ''}`,
            );
            return;
        }
        router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
    }, [
        activeView,
        runsView,
        feedQuery,
        scheduleFilters,
        actionType,
        status,
        debouncedSearch,
        page,
        pathname,
        router,
    ]);

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
                // The API clamps `limit` to 100 (`Math.min(limit, 100)`, a
                // documented two-layer contract) — so a single request for
                // KANBAN_LIMIT rows silently came back with 100, and the
                // board's per-column counts contradicted the summary cards
                // rendered directly above it. Page in API-max chunks instead,
                // stopping early when the server says there is no more.
                const PAGE = 100;
                const collected: typeof kanbanActivities = [];
                for (let offset = 0; offset < KANBAN_LIMIT; offset += PAGE) {
                    const response = await getActivityLog({
                        actionType: filters.actionType || undefined,
                        status: filters.status || undefined,
                        search: filters.search || undefined,
                        limit: PAGE,
                        offset,
                    });
                    // A newer request superseded this one mid-pagination —
                    // stop fetching AND stop touching state.
                    if (currentRequestId !== kanbanRequestIdRef.current) return;
                    if (!response.success) break;
                    collected.push(...response.activities);
                    // Server said we have everything (short page, or reached
                    // the reported total).
                    if (response.activities.length < PAGE || collected.length >= response.total) {
                        break;
                    }
                }
                if (currentRequestId === kanbanRequestIdRef.current) {
                    setKanbanActivities(collected);
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

    // Fetch for the current page + filters (Log view only)
    useEffect(() => {
        if (!isLogTab) return;
        void fetchActivities(
            page,
            {
                actionType,
                status,
                search: debouncedSearch,
            },
            false,
        );
    }, [isLogTab, page, actionType, status, debouncedSearch, fetchActivities]);

    useEffect(() => {
        if (!isLogTab) return;
        void fetchSummary();
    }, [isLogTab, fetchSummary]);

    // Fetch all activities for kanban view (no pagination)
    useEffect(() => {
        if (isLogTab && viewMode === 'kanban') {
            void fetchKanbanActivities({ actionType, status, search: debouncedSearch });
        }
    }, [isLogTab, viewMode, actionType, status, debouncedSearch, fetchKanbanActivities]);

    // Polling — silent refresh, paused when tab is hidden or when a view with
    // no live log rows is active.
    useEffect(() => {
        if (!isLogTab) return;
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
    }, [isLogTab, fetchActivities, fetchSummary, page, actionType, status, debouncedSearch]);

    // ── Keyboard layer ────────────────────────────────────────────────
    // The page's own keys: switch view, focus the visible search box, open the
    // sheet. The ledger answers `←/→ d w m t j k Enter Esc` itself while it is
    // the visible view; the Live Feed answers its own keys the same way. Every
    // key listed in the sheet has an on-screen control.
    const focusActiveSearch = useCallback(() => {
        if (activeView === 'runs') {
            runsSearchRef.current?.focus();
            return;
        }
        if (activeView === 'log') {
            logSearchRef.current?.focus();
        }
        // The Live Feed's only search box lives inside its agent picker dialog,
        // which the feed itself opens with `a`; Schedules has none.
    }, [activeView]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isTypingTarget(event.target)) return;
            if (shortcutsOpen) return;
            if (event.key === '?') {
                setShortcutsOpen(true);
                event.preventDefault();
                return;
            }
            if (event.key === '/') {
                focusActiveSearch();
                event.preventDefault();
                return;
            }
            const next = ACTIVITY_VIEW_KEYS[event.key];
            if (next) {
                handleViewChange(next);
                event.preventDefault();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [focusActiveSearch, handleViewChange, shortcutsOpen]);

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
            // eslint-disable-next-line no-restricted-syntax -- EW-790 ok
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

    // ── The one shortcut sheet ────────────────────────────────────────
    // The ledger supplies its own rows (it owns those keys); the page adds the
    // keys only IT answers to — switching view — and the Live Feed's, which had
    // never been written down anywhere. Labels come from the namespace that
    // owns the feature, so nothing is duplicated and nothing drifts.
    const extraShortcutRows: ShortcutRow[] = [
        { keys: ['l', 'r', 'f', 's'], label: t('shortcuts.switchView') },
        { keys: ['a'], label: tFeed('filters.agentsGroup') },
        { keys: ['x'], label: tFeed('filters.onlyFailed') },
        { keys: ['1', '…', '5'], label: tFeed('filters.kindsGroup') },
        { keys: ['Shift', 'L'], label: tFeed('loadOlder') },
    ];

    const viewTabs = [
        { key: 'log' as const, icon: List, label: t('viewToggle.log') },
        { key: 'runs' as const, icon: Receipt, label: t('viewToggle.runs') },
        { key: 'feed' as const, icon: Radio, label: t('viewToggle.feed') },
        { key: 'schedules' as const, icon: CalendarClock, label: t('viewToggle.schedules') },
    ];

    return (
        <div className="space-y-6">
            <PageHeader
                icon={ActivityIcon}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="primary"
                actions={
                    <>
                        <div
                            data-testid="activity-view-toggle"
                            className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5"
                        >
                            {viewTabs.map((tab) => {
                                const Icon = tab.icon;
                                const active = activeView === tab.key;
                                return (
                                    <button
                                        key={tab.key}
                                        onClick={() => handleViewChange(tab.key)}
                                        aria-pressed={active}
                                        aria-label={tab.label}
                                        data-testid={`activity-view-${tab.key}`}
                                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                                            active
                                                ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                                : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark'
                                        }`}
                                    >
                                        <Icon className="w-3.5 h-3.5" />
                                        <span className="hidden @xs/main:inline">{tab.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {isLogTab && (
                            <>
                                <ViewModeSwitch
                                    mode={viewMode}
                                    onChange={handleViewModeChange}
                                    cardLabel={t('viewMode.table')}
                                    kanbanLabel={t('viewMode.board')}
                                />
                                <button
                                    onClick={handleExport}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    {t('actions.export')}
                                </button>
                            </>
                        )}
                        {/* The ledger's keyboard button, promoted to the page:
                            it now opens the sheet for EVERY view hosted here. */}
                        <button
                            type="button"
                            onClick={() => setShortcutsOpen(true)}
                            aria-label={tRuns('shortcuts.button')}
                            data-testid="activity-shortcuts-button"
                            className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                        >
                            <Keyboard className="w-4 h-4" aria-hidden />
                        </button>
                    </>
                }
            />

            {isSchedulesTab && (
                <>
                    {/* Schedules list — this IS the `/schedules` page, moved in
                        whole: the same filters (agent / source / status /
                        health / search / active-only), the same columns, the
                        same per-row control menu and the same health banner. It
                        keeps the state and reports changes up, because this
                        component owns the page's address bar. */}
                    <SchedulesWorkspace
                        initialPage={schedules.page}
                        initialHealth={schedules.health}
                        initialFailed={schedules.failed}
                        initialHealthFailed={schedules.healthFailed}
                        syncUrl={false}
                        filters={scheduleFilters}
                        onFiltersChange={setScheduleFilters}
                        createTriggerRef={triggerCreateRef}
                    />
                    {/* Inbound triggers have no row of their own in that list —
                        they are configurations, not scheduled fires — so their
                        write surface sits below it, exactly as before. */}
                    <TriggersManager createRef={triggerCreateRef} />
                </>
            )}

            {isFeedTab && (
                <LiveFeed
                    initialPage={initialFeedPage}
                    initialActors={initialFeedActors}
                    onFiltersChange={setFeedQuery}
                    onOpenActivityLog={() => handleViewChange('log')}
                />
            )}

            {isRunsTab && (
                <>
                    {/* Runs ledger (AW-09) — the executions behind the log, which
                        is the same data the Agents hub's Activity tab lists as
                        Sessions. The cross-link to it rides in the heading's
                        aside slot rather than floating on its own row. */}
                    <ActivityViewHeader
                        title={tRuns('title')}
                        subtitle={tRuns('subtitle')}
                        aside={
                            <Link
                                href={ROUTES.DASHBOARD_AGENTS_ACTIVITY}
                                className="text-xs text-primary hover:underline"
                                data-testid="runs-open-sessions"
                            >
                                {tRuns('openSessions')}
                            </Link>
                        }
                    />
                    <RunsClient
                        initialView={runsView}
                        granularityFromUrl={runs.granularityFromUrl}
                        timeZone={runs.timeZone}
                        initialPage={runs.page}
                        initialStats={runs.stats}
                        agents={runs.agents}
                        syncUrl={false}
                        onViewChange={setRunsView}
                        searchRef={runsSearchRef}
                        showShortcutSheet={false}
                        onShowShortcuts={() => setShortcutsOpen(true)}
                    />
                </>
            )}

            {isLogTab && (
                <>
                    {/* The operation log — the view that gave this page its name,
                        so its heading says which part of Activity it is rather
                        than repeating "Activity". */}
                    <ActivityViewHeader
                        title={t('logHeading.title')}
                        subtitle={t('logHeading.subtitle')}
                    />
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
                        searchInputRef={logSearchRef}
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
                </>
            )}

            <RunsShortcutSheet
                open={shortcutsOpen}
                onClose={() => setShortcutsOpen(false)}
                extraRows={extraShortcutRows}
            />
        </div>
    );
}
