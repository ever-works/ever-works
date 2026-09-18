'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type {
    RunLedgerFilters,
    RunLedgerGranularity,
    RunLedgerPage,
    RunLedgerStatus,
    RunLedgerWindow,
    RunWindowStats,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { getRunStatsAction, getRunsAction } from '@/app/actions/runs';
import { RunReceiptPanel } from './RunReceiptPanel';
import { RunsCalendarBar, formatWindowLabel } from './RunsCalendarBar';
import { RunsEmptyState, type RunsEmptyVariant } from './RunsEmptyState';
import { RunsFilters, type RunsAgentOption } from './RunsFilters';
import { RunsRail } from './RunsRail';
import { RunsShortcutSheet } from './RunsShortcutSheet';
import { RunsTable } from './RunsTable';
import {
    RUNS_GRANULARITY_STORAGE_KEY,
    RUNS_POLL_INTERVAL_MS,
    buildRunsSearch,
    countActiveFilters,
    hasOpenRuns,
    isTypingTarget,
    mergeRefreshedRows,
    parseRunsViewState,
    stepAnchorDate,
    windowIncludesNow,
    type RunsViewState,
} from './runs.shared';

/**
 * Runs ledger (AW-09) — the ledger's client shell.
 *
 * Owns the view (granularity, anchor date, filters, open receipt). On its own
 * page it mirrors all of it into the URL, so a view is shareable and survives
 * a reload; only the granularity is remembered between visits. The list and
 * the rail load independently — either can fail without blanking the other.
 * While the window includes now and a listed run is still in flight, both
 * refresh every 5 seconds; a refresh merges rows by id, so it never moves the
 * scroll position, the focused row or the open receipt.
 *
 * EMBEDDED MODE (the Activity page's Runs view, and the Agents Activity
 * sub-tab's Ledger view): the host owns the URL, because a page that hosts
 * several views has exactly one writer for it. Pass `syncUrl={false}` and the
 * shell reports every view change through `onViewChange` instead of writing
 * `history` itself, stops rendering its own `?` sheet (the host extends that
 * one with its own shortcuts) and stops claiming `/` and `?` on the keyboard.
 * Everything else — calendar, filters, table, rail, receipt, live poll and the
 * `←/→ t d/w/m j/k Enter Esc` keys — behaves identically in both modes.
 */
export function RunsClient({
    initialView,
    granularityFromUrl,
    timeZone,
    initialPage,
    initialStats,
    agents,
    syncUrl = true,
    onViewChange,
    searchRef: hostSearchRef,
    showShortcutSheet = true,
    onShowShortcuts,
}: {
    initialView: RunsViewState;
    /** False when the URL named no granularity, so the remembered one may apply. */
    granularityFromUrl: boolean;
    timeZone: string;
    initialPage: RunLedgerPage | null;
    initialStats: RunWindowStats | null;
    agents: RunsAgentOption[];
    /** False when the host page owns the URL (embedded views). */
    syncUrl?: boolean;
    /** The host's single URL writer. Required with `syncUrl={false}`. */
    onViewChange?: (view: RunsViewState) => void;
    /** The host's ref, so the host's own `/` shortcut focuses this search box. */
    searchRef?: RefObject<HTMLInputElement | null>;
    /** False when the host renders the (extended) shortcut sheet itself. */
    showShortcutSheet?: boolean;
    /**
     * What the calendar bar's keyboard button opens. The host's sheet lists the
     * keys of EVERY view it hosts, so the ledger hands the click up rather than
     * opening a ledger-only list — the icon stays exactly where it was.
     */
    onShowShortcuts?: () => void;
}) {
    const t = useTranslations('dashboard.runsPage');
    const locale = useLocale();

    const [view, setView] = useState<RunsViewState>(initialView);
    const [page, setPage] = useState<RunLedgerPage | null>(initialPage);
    // A missing payload is only an ERROR when the other one arrived: the host
    // server-rendered this window and one half of it failed. When BOTH are
    // missing the host never fetched (it switched to this view client-side), so
    // the first load below is already on its way and the honest state is
    // "loading", not a retry banner that flashes before the fetch lands.
    const hostFetched = initialPage !== null || initialStats !== null;
    const [listError, setListError] = useState(initialPage === null && initialStats !== null);
    const [listLoading, setListLoading] = useState(!hostFetched);
    const [loadingMore, setLoadingMore] = useState(false);
    const [stats, setStats] = useState<RunWindowStats | null>(initialStats);
    const [statsError, setStatsError] = useState(initialStats === null && initialPage !== null);
    const [statsLoading, setStatsLoading] = useState(!hostFetched);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const ownSearchRef = useRef<HTMLInputElement>(null);
    const searchRef = hostSearchRef ?? ownSearchRef;
    // Separate sequences so a stale list response never overwrites a newer
    // one, and a list retry never orphans an in-flight rail request.
    const listSeq = useRef(0);
    const statsSeq = useRef(0);
    // `onViewChange` must not be a dependency of the effects that set the view
    // (the host re-renders on every report), so it is reached through a ref.
    const onViewChangeRef = useRef(onViewChange);
    useEffect(() => {
        onViewChangeRef.current = onViewChange;
    }, [onViewChange]);

    const rows = useMemo(() => page?.rows ?? [], [page]);
    const ledgerWindow: RunLedgerWindow = page?.window ??
        stats?.window ?? {
            granularity: view.granularity,
            anchorDate: view.date ?? new Date().toISOString().slice(0, 10),
            from: '',
            to: '',
            timezone: timeZone,
            clamped: false,
        };

    const query = useMemo(
        () => ({
            granularity: view.granularity,
            date: view.date ?? undefined,
            timezone: timeZone,
            filters: view.filters,
        }),
        [view.granularity, view.date, view.filters, timeZone],
    );

    // ── The address bar outranks a replayed server render ─────────────
    // The mirror below rewrites the history entry without re-rendering the
    // server page, so that entry keeps the payload of the view the page was
    // LOADED with, and Back/Forward onto it replays that payload (the App
    // Router's back/forward cache ignores stale time). `initialView` can
    // therefore be older than the URL; on mount the URL wins, and the load
    // effect fetches its window. Mount only: afterwards the view drives the
    // URL, never the reverse.
    //
    // Embedded mode skips it: there the host parsed the same address bar on
    // the server AND on the client, so `initialView` already IS the URL, and
    // the address bar may be carrying a SIBLING view's params (the Log tab's
    // `status`, say) that this parser would read as its own.
    useEffect(() => {
        if (!syncUrl) return;
        const fromUrl = parseRunsViewState(new URLSearchParams(window.location.search));
        if (buildRunsSearch(fromUrl) !== buildRunsSearch(initialView)) setView(fromUrl);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── URL mirror (own page) / view report (embedded) ────────────────
    // A same-document history write, not `router.replace`: a router
    // navigation only commits the URL when its RSC transition commits — a
    // server render of this page that nothing uses (the actions below
    // refetch the window) — so under load the address bar trailed the view
    // by seconds. The App Router patches `history.replaceState`, so
    // `useSearchParams` / `usePathname` still follow. `location.pathname` is
    // the address bar's own path: a `/org/<slug>` prefix is kept, and there
    // is no locale segment to keep (`localePrefix: 'never'`).
    // Nothing to write while the view is still the object the page mounted
    // with. Not a "first run" flag: StrictMode (`next dev`) re-runs this
    // effect after the App Router's effect cleanup has put the browser's
    // unpatched `replaceState` back, and a write then would wipe the router's
    // history state for this entry.
    const mountedView = useRef(view);
    useEffect(() => {
        if (view === mountedView.current) return;
        if (!syncUrl) {
            onViewChangeRef.current?.(view);
            return;
        }
        window.history.replaceState(
            null,
            '',
            `${window.location.pathname}?${buildRunsSearch(view)}`,
        );
    }, [view, syncUrl]);

    // ── Remembered granularity (never the window) ─────────────────────
    useEffect(() => {
        // A granularity the address bar names wins, including on a replayed
        // render of a visit whose URL named none when the server saw it.
        // Embedded mode has no address bar of its own to consult: the host
        // tells us through `granularityFromUrl`, and its params are not ours
        // to re-read.
        if (granularityFromUrl || (syncUrl && new URLSearchParams(window.location.search).has('g')))
            return;
        try {
            const saved = localStorage.getItem(RUNS_GRANULARITY_STORAGE_KEY);
            if ((saved === 'week' || saved === 'month') && saved !== initialView.granularity) {
                setView((current) => ({ ...current, granularity: saved }));
            }
        } catch {
            // Storage unavailable (private mode) — the default stands.
        }
    }, [granularityFromUrl, initialView.granularity, syncUrl]);

    // ── Load list + rail whenever the window or filters change ────────
    const load = useCallback(
        async (target: 'both' | 'list' | 'stats' = 'both') => {
            const tasks: Promise<void>[] = [];
            if (target !== 'stats') {
                const seq = ++listSeq.current;
                setListLoading(true);
                tasks.push(
                    getRunsAction(query)
                        .then((next) => {
                            if (seq !== listSeq.current) return;
                            setPage(next);
                            setListError(false);
                            setFocusedIndex(-1);
                        })
                        .catch(() => {
                            // Keep the previous window on screen; say so.
                            if (seq === listSeq.current) setListError(true);
                        })
                        .finally(() => {
                            if (seq === listSeq.current) setListLoading(false);
                        }),
                );
            }
            if (target !== 'list') {
                const seq = ++statsSeq.current;
                setStatsLoading(true);
                tasks.push(
                    getRunStatsAction(query)
                        .then((next) => {
                            if (seq !== statsSeq.current) return;
                            setStats(next);
                            setStatsError(false);
                        })
                        .catch(() => {
                            if (seq === statsSeq.current) setStatsError(true);
                        })
                        .finally(() => {
                            if (seq === statsSeq.current) setStatsLoading(false);
                        }),
                );
            }
            await Promise.all(tasks);
        },
        [query],
    );

    // The server already handed us a window, so the mount IS the first load
    // and the effect below must not re-fetch it. An embedded view that the
    // host switched to client-side has no server payload, so it does fetch —
    // otherwise the Runs view would open on an error banner and wait for a
    // filter change that may never come.
    const firstLoad = useRef(hostFetched);
    useEffect(() => {
        if (firstLoad.current) {
            firstLoad.current = false;
            return;
        }
        void load();
    }, [load]);

    // ── Live refresh while something in this window is still running ──
    const live =
        !listError &&
        ledgerWindow.from !== '' &&
        windowIncludesNow(ledgerWindow) &&
        hasOpenRuns(rows);
    useEffect(() => {
        if (!live) return;
        let inFlight = false;
        const timer = setInterval(() => {
            if (inFlight || (typeof document !== 'undefined' && document.hidden)) return;
            inFlight = true;
            const seq = listSeq.current;
            Promise.all([getRunsAction(query), getRunStatsAction(query)])
                .then(([nextPage, nextStats]) => {
                    if (seq !== listSeq.current) return;
                    setPage((current) =>
                        current
                            ? {
                                  ...nextPage,
                                  rows: mergeRefreshedRows(current.rows, nextPage.rows),
                                  // Keep the cursor of the pages already loaded.
                                  nextCursor: current.nextCursor,
                              }
                            : nextPage,
                    );
                    setStats(nextStats);
                })
                .catch(() => undefined)
                .finally(() => {
                    inFlight = false;
                });
        }, RUNS_POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [live, query]);

    // ── View mutations ────────────────────────────────────────────────
    const setGranularity = useCallback((granularity: RunLedgerGranularity) => {
        setView((current) => ({ ...current, granularity }));
        try {
            localStorage.setItem(RUNS_GRANULARITY_STORAGE_KEY, granularity);
        } catch {
            // Storage unavailable — the choice still applies to this visit.
        }
    }, []);

    const step = useCallback(
        (direction: -1 | 1) => {
            setView((current) => ({
                ...current,
                date: stepAnchorDate(ledgerWindow.anchorDate, current.granularity, direction),
            }));
        },
        [ledgerWindow.anchorDate],
    );

    const goToday = useCallback(() => setView((current) => ({ ...current, date: null })), []);

    const setFilters = useCallback(
        (filters: RunLedgerFilters) => setView((current) => ({ ...current, filters })),
        [],
    );

    const filterStatus = useCallback(
        (status: RunLedgerStatus | null) =>
            setView((current) => ({
                ...current,
                filters: { ...current.filters, statuses: status ? [status] : undefined },
            })),
        [],
    );

    const openReceipt = useCallback((runId: string, index?: number) => {
        if (index !== undefined) setFocusedIndex(index);
        setView((current) => ({ ...current, runId }));
    }, []);

    const closeReceipt = useCallback(() => setView((current) => ({ ...current, runId: null })), []);

    const loadMore = useCallback(async () => {
        if (!page?.nextCursor) return;
        setLoadingMore(true);
        const seq = listSeq.current;
        try {
            const next = await getRunsAction({ ...query, cursor: page.nextCursor });
            if (seq !== listSeq.current) return;
            setPage((current) =>
                current
                    ? {
                          ...current,
                          rows: [
                              ...current.rows,
                              ...next.rows.filter(
                                  (row) => !current.rows.some((known) => known.id === row.id),
                              ),
                          ],
                          nextCursor: next.nextCursor,
                          total: next.total,
                      }
                    : next,
            );
        } catch {
            // The button stays; a second click retries.
        } finally {
            setLoadingMore(false);
        }
    }, [page, query]);

    // ── Keyboard layer ────────────────────────────────────────────────
    const focusRow = useCallback((index: number) => {
        setFocusedIndex(index);
        const element = document.querySelector<HTMLElement>(
            `[data-testid="runs-row"][data-row-index="${index}"]`,
        );
        element?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isTypingTarget(event.target)) return;
            // While a dialog is open its own keys (Esc, Tab) belong to it.
            if (view.runId || shortcutsOpen) return;
            const handled = handleShortcut(event.key);
            if (handled) event.preventDefault();
        };
        const handleShortcut = (key: string): boolean => {
            switch (key) {
                case 'ArrowLeft':
                    step(-1);
                    return true;
                case 'ArrowRight':
                    step(1);
                    return true;
                case 't':
                    goToday();
                    return true;
                case 'd':
                    setGranularity('day');
                    return true;
                case 'w':
                    setGranularity('week');
                    return true;
                case 'm':
                    setGranularity('month');
                    return true;
                case 'j':
                    if (rows.length === 0) return false;
                    focusRow(Math.min(focusedIndex + 1, rows.length - 1));
                    return true;
                case 'k':
                    if (rows.length === 0) return false;
                    focusRow(Math.max(focusedIndex - 1, 0));
                    return true;
                case 'o':
                case 'Enter':
                    if (focusedIndex < 0 || !rows[focusedIndex]) return false;
                    openReceipt(rows[focusedIndex].id, focusedIndex);
                    return true;
                case 'Escape':
                    if (focusedIndex < 0) return false;
                    setFocusedIndex(-1);
                    return true;
                case '/':
                    // The host owns `/` in embedded mode: it focuses whichever
                    // surface's search box is on screen, ours included.
                    if (!showShortcutSheet) return false;
                    searchRef.current?.focus();
                    return true;
                case '?':
                    if (!showShortcutSheet) return false;
                    setShortcutsOpen(true);
                    return true;
                default:
                    return false;
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [
        view.runId,
        shortcutsOpen,
        step,
        goToday,
        setGranularity,
        rows,
        focusedIndex,
        focusRow,
        openReceipt,
        showShortcutSheet,
        searchRef,
    ]);

    // ── Render ────────────────────────────────────────────────────────
    const activeFilters = countActiveFilters(view.filters);
    const windowLabel = formatWindowLabel(ledgerWindow, locale);
    const emptyVariant: RunsEmptyVariant =
        activeFilters > 0 ? 'filters' : page?.everRan === false ? 'never' : 'window';

    return (
        <div className="w-full space-y-4" data-testid="runs-page">
            <RunsCalendarBar
                window={ledgerWindow}
                granularity={view.granularity}
                onGranularityChange={setGranularity}
                onStep={step}
                onToday={goToday}
                onShowShortcuts={onShowShortcuts ?? (() => setShortcutsOpen(true))}
            />
            <RunsFilters
                ref={searchRef}
                filters={view.filters}
                agents={agents}
                onChange={setFilters}
            />

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <section aria-busy={listLoading} className="space-y-3 min-w-0">
                    {listError && (
                        <div
                            className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2"
                            role="alert"
                            data-testid="runs-list-error"
                        >
                            <p className="text-sm text-text dark:text-text-dark">
                                {t('errors.loadWindow')}
                            </p>
                            <p className="text-xs text-text-muted">{t('errors.stateKept')}</p>
                            <Button variant="secondary" size="sm" onClick={() => void load('list')}>
                                {t('errors.retry')}
                            </Button>
                        </div>
                    )}

                    {listLoading && rows.length === 0 && (
                        <p
                            className="flex items-center gap-2 text-xs text-text-muted"
                            role="status"
                        >
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                            {t(`loading.${view.granularity}`)}
                        </p>
                    )}

                    {page && rows.length === 0 && !listLoading && (
                        <RunsEmptyState
                            variant={emptyVariant}
                            granularity={view.granularity}
                            onClearFilters={() => setFilters({})}
                        />
                    )}

                    {rows.length > 0 && (
                        <>
                            <RunsTable
                                rows={rows}
                                caption={
                                    activeFilters > 0
                                        ? t('table.captionFiltered', {
                                              window: windowLabel,
                                              count: activeFilters,
                                          })
                                        : t('table.caption', { window: windowLabel })
                                }
                                timeZone={ledgerWindow.timezone}
                                focusedIndex={focusedIndex}
                                onFocusRow={setFocusedIndex}
                                onOpen={openReceipt}
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                                <span data-testid="runs-showing">
                                    {t('showingCount', {
                                        shown: rows.length,
                                        total: page?.total ?? rows.length,
                                    })}
                                </span>
                                {page?.nextCursor && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => void loadMore()}
                                        disabled={loadingMore}
                                        data-testid="runs-load-more"
                                    >
                                        {loadingMore && (
                                            <Loader2
                                                className="w-3.5 h-3.5 mr-1 animate-spin"
                                                aria-hidden
                                            />
                                        )}
                                        {t('loadMore')}
                                    </Button>
                                )}
                            </div>
                        </>
                    )}
                </section>

                <RunsRail
                    stats={stats}
                    granularity={view.granularity}
                    error={statsError}
                    loading={statsLoading}
                    onRetry={() => void load('stats')}
                    onFilterStatus={filterStatus}
                />
            </div>

            <RunReceiptPanel
                runId={view.runId}
                timeZone={ledgerWindow.timezone}
                onClose={closeReceipt}
            />
            {showShortcutSheet && (
                <RunsShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
            )}
        </div>
    );
}
