'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Info, Lightbulb, Loader2, Plus, Search, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { browserApiFetch } from '@/lib/api/browser-api';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    MEMORY_FACT_ACTIVE_MAX,
    MEMORY_FACT_FORGET_ALL_CONFIRMATION,
    MEMORY_FACT_LIST_LIMIT_MAX,
    buildMemoryFactsQuery,
    refusalMessage,
    type MemoryFactDto,
    type MemoryFactListDto,
    type MemoryFactView,
} from '@/lib/api/memory-facts-types';
import { FactComposer, type FactComposerResult } from './FactComposer';
import { FactRow } from './FactRow';
import { ForgetAllDialog } from './ForgetAllDialog';
import { MemoryRail } from './MemoryRail';

interface FactsPanelProps {
    /** First page of the "All" view, server-fetched by the page. */
    initial: MemoryFactListDto;
    /** Opens the existing consolidation review — the "Tidy up" action. */
    onTidyUp?: () => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const UNDO_WINDOW_MS = 10_000;
const SKELETON_ROWS = 6;

type WriteResult = { ok: true; body: unknown } | { ok: false; message: string | null };

/**
 * Memory ▸ Facts (AW-07) — the atomic tier of Memory, listed.
 *
 * What an owner can do here: see every fact the workspace's agents carry,
 * find one by meaning, add one, correct one in place, pin one so it rides on
 * every run, forget one (with a 10-second Undo and a 30-day restore window),
 * accept or discard a proposal, and — behind a typed confirmation — forget
 * them all.
 *
 * ## Transport
 *
 * Every call goes through `browserApiFetch` to the `/api/memory/facts` BFF,
 * which turns the per-tab workspace selector into the API's scope header. A
 * raw `fetch()` would carry no selector and the BFF answers 400 — facts are
 * never silently read or written in the wrong workspace.
 *
 * ## Optimism, deliberately uneven
 *
 * Pin, forget, restore, accept and discard move the row immediately and roll
 * back if the API refuses. An EDIT is not optimistic: a failed save must
 * never look saved, so the composer keeps the text until the API confirms.
 *
 * ## States
 *
 * Loaded, searching by meaning, searching by exact words (with the note that
 * says so), empty workspace, empty view, no results, memory full, loading
 * (six skeleton rows while a view loads for the first time — the search box
 * stays focusable and keeps what was typed) and a failed load with Retry.
 *
 * Keys: `/` focuses the search box; `G` then `F` jumps to the first fact.
 */
export function FactsPanel({ initial, onTidyUp }: FactsPanelProps) {
    const t = useTranslations('dashboard.memoryPage.facts');
    const tForgetAll = useTranslations('dashboard.memoryPage.forgetAllDialog');

    const [data, setData] = useState<MemoryFactListDto>(initial);
    const [view, setView] = useState<MemoryFactView>('all');
    const [query, setQuery] = useState('');
    // The query the rendered `data` actually answers — distinguishes "no
    // results for X" from "results for the previous keystroke still showing".
    const [answeredQuery, setAnsweredQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [skeleton, setSkeleton] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [composer, setComposer] = useState<{ prefill: string } | null>(null);
    const [forgetAllOpen, setForgetAllOpen] = useState(false);
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
    const [actionError, setActionError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const searchRef = useRef<HTMLInputElement>(null);
    const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
    const inflightRef = useRef<AbortController | null>(null);
    const didMount = useRef(false);
    // The view and query the panel is showing NOW. A write that finishes after
    // the owner switched views must refetch the view they are looking at, not
    // the one that was showing when they clicked — a closure over `view` would
    // reload "All" into the Forgotten view.
    const viewRef = useRef(view);
    const queryRef = useRef(query);
    viewRef.current = view;
    queryRef.current = query;

    const searching = answeredQuery.trim().length > 0;

    // ─── fetching ───────────────────────────────────────────────────────────

    const runFetch = useCallback(
        async (next: {
            view: MemoryFactView;
            query: string;
            cursor?: string;
            showSkeleton?: boolean;
        }) => {
            inflightRef.current?.abort();
            const controller = new AbortController();
            inflightRef.current = controller;
            setLoading(true);
            if (next.showSkeleton) setSkeleton(true);
            try {
                const res = await browserApiFetch(
                    `/api/memory/facts${buildMemoryFactsQuery({
                        q: next.query,
                        view: next.view,
                        limit: MEMORY_FACT_LIST_LIMIT_MAX,
                        cursor: next.cursor,
                    })}`,
                    {
                        method: 'GET',
                        headers: { Accept: 'application/json' },
                        cache: 'no-store',
                        signal: controller.signal,
                    },
                );
                if (inflightRef.current !== controller) return;
                if (!res.ok) {
                    setLoadFailed(true);
                    return;
                }
                const body = (await res.json()) as MemoryFactListDto;
                if (inflightRef.current !== controller) return;
                setLoadFailed(false);
                setAnsweredQuery(next.query.trim());
                setData((previous) =>
                    next.cursor ? { ...body, facts: [...previous.facts, ...body.facts] } : body,
                );
            } catch {
                // An aborted request lands here too, and is intentionally a no-op.
                if (inflightRef.current === controller && !controller.signal.aborted) {
                    setLoadFailed(true);
                }
            } finally {
                if (inflightRef.current === controller) {
                    setLoading(false);
                    setSkeleton(false);
                }
            }
        },
        [],
    );

    const refresh = useCallback(
        () => runFetch({ view: viewRef.current, query: queryRef.current }),
        [runFetch],
    );

    // Debounced refetch on typing; the server already rendered the first page.
    useEffect(() => {
        if (!didMount.current) {
            didMount.current = true;
            return;
        }
        const handle = setTimeout(
            () => void runFetch({ view: viewRef.current, query: queryRef.current }),
            SEARCH_DEBOUNCE_MS,
        );
        return () => clearTimeout(handle);
        // `view` changes fetch immediately in `selectView`; only typing debounces.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    const selectView = (next: MemoryFactView) => {
        if (next === view) return;
        viewRef.current = next;
        setView(next);
        setActionError(null);
        setData((previous) => ({ ...previous, facts: [], total: 0, nextCursor: undefined }));
        void runFetch({ view: next, query, showSkeleton: true });
    };

    // ─── keyboard ───────────────────────────────────────────────────────────

    useEffect(() => {
        let pendingG = 0;
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            if (
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                tag === 'input' ||
                tag === 'textarea' ||
                tag === 'select' ||
                target?.isContentEditable
            ) {
                return;
            }
            if (event.key === '/') {
                event.preventDefault();
                searchRef.current?.focus();
                return;
            }
            const key = event.key.toLowerCase();
            if (key === 'g') {
                pendingG = Date.now();
                return;
            }
            if (key === 'f' && pendingG && Date.now() - pendingG < 1000) {
                pendingG = 0;
                event.preventDefault();
                (rowRefs.current.find(Boolean) ?? searchRef.current)?.focus();
                return;
            }
            pendingG = 0;
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const moveFocus = (index: number, direction: -1 | 1) => {
        const next = rowRefs.current[index + direction];
        next?.focus();
    };

    // ─── writes ─────────────────────────────────────────────────────────────

    const write = useCallback(
        async (path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<WriteResult> => {
            try {
                const res = await browserApiFetch(path, {
                    method,
                    headers: {
                        Accept: 'application/json',
                        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    },
                    cache: 'no-store',
                    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                });
                const text = await res.text().catch(() => '');
                let parsed: unknown = null;
                try {
                    parsed = text ? JSON.parse(text) : null;
                } catch {
                    parsed = null;
                }
                if (!res.ok) return { ok: false, message: refusalMessage(parsed) };
                return { ok: true, body: parsed };
            } catch {
                return { ok: false, message: null };
            }
        },
        [],
    );

    const markBusy = (id: string, busy: boolean) =>
        setBusyIds((previous) => {
            const next = new Set(previous);
            if (busy) next.add(id);
            else next.delete(id);
            return next;
        });

    /** Remove a row now; put it (and the counts) back if the API refuses. */
    const optimisticRemove = async (
        fact: MemoryFactDto,
        path: string,
        onSuccess?: (body: unknown) => void,
    ) => {
        const snapshot = data;
        setActionError(null);
        markBusy(fact.id, true);
        setData((previous) => ({
            ...previous,
            facts: previous.facts.filter((row) => row.id !== fact.id),
            total: Math.max(0, previous.total - 1),
        }));
        const result = await write(path, 'POST');
        markBusy(fact.id, false);
        if (!result.ok) {
            setData(snapshot);
            setActionError(result.message ?? t('actionFailed'));
            return;
        }
        onSuccess?.(result.body);
        void refresh();
    };

    const createFact = async (body: string): Promise<FactComposerResult> => {
        const result = await write('/api/memory/facts', 'POST', { body });
        if (!result.ok) return { ok: false, message: result.message };
        setComposer(null);
        // A new fact is active: show it at the top of "All", outside any search.
        setView('all');
        if (query) {
            setQuery('');
            setAnsweredQuery('');
        }
        await runFetch({ view: 'all', query: '' });
        return { ok: true };
    };

    const editFact = async (fact: MemoryFactDto, body: string): Promise<FactComposerResult> => {
        const result = await write(`/api/memory/facts/${encodeURIComponent(fact.id)}`, 'PATCH', {
            body,
        });
        if (!result.ok) return { ok: false, message: result.message };
        const updated = result.body as MemoryFactDto;
        setData((previous) => ({
            ...previous,
            facts: previous.facts.map((row) =>
                row.id === fact.id
                    ? { ...row, ...updated, score: row.score, literalMatch: row.literalMatch }
                    : row,
            ),
        }));
        return { ok: true };
    };

    const togglePin = async (fact: MemoryFactDto) => {
        const snapshot = data;
        setActionError(null);
        markBusy(fact.id, true);
        const pinned = !fact.pinned;
        setData((previous) => ({
            ...previous,
            counts: {
                ...previous.counts,
                pinned: Math.max(0, previous.counts.pinned + (pinned ? 1 : -1)),
            },
            facts: previous.facts
                .map((row) => (row.id === fact.id ? { ...row, pinned } : row))
                // Unpinning inside the Pinned view takes the row out of it.
                .filter((row) => view !== 'pinned' || row.pinned),
        }));
        const result = await write(`/api/memory/facts/${encodeURIComponent(fact.id)}`, 'PATCH', {
            pinned,
        });
        markBusy(fact.id, false);
        if (!result.ok) {
            setData(snapshot);
            setActionError(result.message ?? t('actionFailed'));
        }
    };

    const restoreFact = async (fact: MemoryFactDto, fromUndo = false) => {
        if (fromUndo) {
            const result = await write(
                `/api/memory/facts/${encodeURIComponent(fact.id)}/restore`,
                'POST',
            );
            if (!result.ok) {
                setActionError(result.message ?? t('actionFailed'));
                return;
            }
            toast.success(t('restoredToast'));
            void refresh();
            return;
        }
        await optimisticRemove(
            fact,
            `/api/memory/facts/${encodeURIComponent(fact.id)}/restore`,
            () => toast.success(t('restoredToast')),
        );
    };

    const forgetFact = (fact: MemoryFactDto) =>
        optimisticRemove(fact, `/api/memory/facts/${encodeURIComponent(fact.id)}/forget`, () => {
            toast(t('forgottenToast'), {
                duration: UNDO_WINDOW_MS,
                action: { label: t('undo'), onClick: () => void restoreFact(fact, true) },
            });
        });

    const acceptFact = (fact: MemoryFactDto) =>
        optimisticRemove(fact, `/api/memory/facts/${encodeURIComponent(fact.id)}/accept`);

    const discardFact = (fact: MemoryFactDto) =>
        optimisticRemove(fact, `/api/memory/facts/${encodeURIComponent(fact.id)}/discard`);

    const forgetAll = async (): Promise<boolean> => {
        const result = await write('/api/memory/facts/forget-all', 'POST', {
            confirm: MEMORY_FACT_FORGET_ALL_CONFIRMATION,
        });
        if (!result.ok) return false;
        const forgotten = (result.body as { forgotten?: number } | null)?.forgotten ?? 0;
        setForgetAllOpen(false);
        toast.success(tForgetAll('done', { count: forgotten }));
        await refresh();
        return true;
    };

    const copyStarterPrompt = async () => {
        try {
            await navigator.clipboard?.writeText(t('emptyStarterPrompt'));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // The prompt stays selectable on screen.
        }
    };

    // ─── render ─────────────────────────────────────────────────────────────

    const { facts, counts, total } = data;
    const liveCount = counts.active + counts.proposed;
    const memoryFull = counts.active >= MEMORY_FACT_ACTIVE_MAX;
    const workspaceEmpty = !searching && view === 'all' && facts.length === 0 && liveCount === 0;
    rowRefs.current = [];

    return (
        <section
            id="facts"
            data-testid="memory-facts-panel"
            aria-labelledby="memory-facts-title"
            className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]"
        >
            <MemoryRail counts={counts} view={view} onSelectView={selectView} />

            <div className="flex flex-col gap-3 min-w-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                        <h2
                            id="memory-facts-title"
                            className="text-base font-semibold text-text dark:text-text-dark"
                        >
                            {t('title')}
                        </h2>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {liveCount > 0 && (
                            <button
                                type="button"
                                data-testid="memory-facts-forget-all"
                                onClick={() => setForgetAllOpen(true)}
                                className={cn(
                                    'inline-flex items-center rounded-lg border px-3 py-2 text-sm transition-colors',
                                    'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                                    'text-text dark:text-text-dark hover:border-red-500/40',
                                )}
                            >
                                {t('forgetAll')}
                            </button>
                        )}
                        <button
                            type="button"
                            data-testid="memory-facts-add"
                            onClick={() => setComposer({ prefill: '' })}
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                                'bg-primary text-white hover:bg-primary/90 dark:bg-white dark:text-gray-900 dark:hover:bg-white/90',
                            )}
                        >
                            <Plus className="w-4 h-4" strokeWidth={1.5} aria-hidden />
                            {t('addFact')}
                        </button>
                    </div>
                </div>

                {memoryFull && (
                    <div
                        role="status"
                        data-testid="memory-facts-full"
                        className="flex items-start justify-between gap-3 flex-wrap rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm"
                    >
                        <div className="flex items-start gap-2">
                            <AlertTriangle
                                className="w-4 h-4 mt-0.5 text-amber-600"
                                strokeWidth={1.5}
                                aria-hidden
                            />
                            <div>
                                <p className="font-medium text-text dark:text-text-dark">
                                    {/* A number, not a pre-formatted string: the
                                        message formats it in the request locale
                                        on server and client alike. */}
                                    {t('capacityFullTitle', { max: MEMORY_FACT_ACTIVE_MAX })}
                                </p>
                                <p className="text-text-muted dark:text-text-muted-dark">
                                    {t('capacityFullBody')}
                                </p>
                            </div>
                        </div>
                        {onTidyUp && (
                            <button
                                type="button"
                                data-testid="memory-facts-tidy-up"
                                onClick={onTidyUp}
                                className="inline-flex items-center rounded-lg border px-3 py-1.5 text-sm bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9 text-text dark:text-text-dark"
                            >
                                {t('tidyUp')}
                            </button>
                        )}
                    </div>
                )}

                {composer && (
                    <div className="rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark p-3">
                        <FactComposer
                            key={composer.prefill}
                            testId="memory-facts-composer"
                            initialBody={composer.prefill}
                            submitLabel={t('addFact')}
                            onCancel={() => setComposer(null)}
                            onSubmit={createFact}
                        />
                    </div>
                )}

                <div className="relative">
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark pointer-events-none"
                        strokeWidth={1.5}
                        aria-hidden
                    />
                    <input
                        ref={searchRef}
                        data-testid="memory-facts-search"
                        type="search"
                        aria-label={t('searchLabel')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('searchPlaceholder')}
                        className={cn(
                            'w-full text-sm rounded-lg transition-colors outline-none pl-9 pr-9 py-2.5',
                            'bg-card dark:bg-card-primary-dark border border-card-border dark:border-white/9',
                            'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                            'focus:border-primary dark:focus:border-white/20 focus:ring-2 focus:ring-primary-800/20',
                        )}
                    />
                    {loading && !skeleton && (
                        <Loader2
                            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark animate-spin"
                            strokeWidth={1.5}
                            aria-hidden
                        />
                    )}
                </div>

                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('shortcutsHint')}
                </p>

                {searching && !data.semantic && (
                    <div
                        role="note"
                        data-testid="memory-facts-degraded"
                        className="flex items-center gap-2 flex-wrap rounded-lg border border-card-border dark:border-white/9 bg-surface-secondary/50 dark:bg-white/5 px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        <Info className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                        <span>{t('degradedSearchNote')}</span>
                        <Link
                            href={ROUTES.DASHBOARD_PLUGINS}
                            data-testid="memory-facts-degraded-cta"
                            className="font-medium text-primary dark:text-white hover:underline"
                        >
                            {t('degradedSearchCta')}
                        </Link>
                    </div>
                )}

                {actionError && (
                    <div
                        role="alert"
                        data-testid="memory-facts-action-error"
                        className="flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400"
                    >
                        <span>{actionError}</span>
                        <button
                            type="button"
                            onClick={() => setActionError(null)}
                            aria-label={t('cancel')}
                            className="shrink-0"
                        >
                            <X className="w-4 h-4" strokeWidth={1.5} aria-hidden />
                        </button>
                    </div>
                )}

                {loadFailed && (
                    <div
                        role="alert"
                        data-testid="memory-facts-load-error"
                        className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400"
                    >
                        <span>{t('loadFailed')}</span>
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            className="font-medium underline"
                        >
                            {t('retry')}
                        </button>
                    </div>
                )}

                <div data-testid="memory-facts-list" aria-busy={loading || undefined}>
                    {skeleton ? (
                        <ul className="flex flex-col gap-2" aria-hidden>
                            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                                <li
                                    key={index}
                                    data-testid="memory-facts-skeleton"
                                    className="h-[68px] rounded-lg border border-card-border dark:border-white/9 bg-surface-secondary/60 dark:bg-white/5 animate-pulse"
                                />
                            ))}
                        </ul>
                    ) : facts.length > 0 ? (
                        <ul className="flex flex-col gap-2">
                            {facts.map((fact, index) => (
                                <li key={fact.id}>
                                    <FactRow
                                        ref={(element) => {
                                            rowRefs.current[index] = element;
                                        }}
                                        fact={fact}
                                        busy={busyIds.has(fact.id)}
                                        onMoveFocus={(direction) => moveFocus(index, direction)}
                                        onEdit={editFact}
                                        onTogglePin={(row) => void togglePin(row)}
                                        onForget={(row) => void forgetFact(row)}
                                        onRestore={(row) => void restoreFact(row)}
                                        onAccept={(row) => void acceptFact(row)}
                                        onDiscard={(row) => void discardFact(row)}
                                    />
                                </li>
                            ))}
                        </ul>
                    ) : searching ? (
                        <div
                            data-testid="memory-facts-no-results"
                            className="flex flex-col items-center gap-3 py-10 text-center"
                        >
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('noResultsTitle', { query: answeredQuery })}
                            </p>
                            <div className="flex items-center gap-2 flex-wrap justify-center">
                                <button
                                    type="button"
                                    data-testid="memory-facts-clear-search"
                                    onClick={() => setQuery('')}
                                    className="inline-flex items-center rounded-lg border px-3 py-1.5 text-sm bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9 text-text dark:text-text-dark"
                                >
                                    {t('clearSearch')}
                                </button>
                                <button
                                    type="button"
                                    data-testid="memory-facts-add-query"
                                    onClick={() => setComposer({ prefill: answeredQuery })}
                                    className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium bg-primary text-white dark:bg-white dark:text-gray-900"
                                >
                                    {t('addQueryAsFact', { query: answeredQuery })}
                                </button>
                            </div>
                        </div>
                    ) : workspaceEmpty ? (
                        <div
                            data-testid="memory-facts-empty"
                            className="flex flex-col items-center gap-3 py-10 px-4 text-center"
                        >
                            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-surface-secondary dark:bg-card-primary-dark">
                                <Lightbulb
                                    className="w-5 h-5 text-text-muted dark:text-text-muted-dark"
                                    strokeWidth={1.5}
                                    aria-hidden
                                />
                            </span>
                            <div>
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {t('emptyTitle')}
                                </p>
                                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark max-w-md">
                                    {t('emptySubtitle')}
                                </p>
                            </div>
                            <button
                                type="button"
                                data-testid="memory-facts-add-first"
                                onClick={() => setComposer({ prefill: '' })}
                                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-primary text-white dark:bg-white dark:text-gray-900"
                            >
                                <Plus className="w-4 h-4" strokeWidth={1.5} aria-hidden />
                                {t('addFact')}
                            </button>
                            <div className="w-full max-w-md text-left">
                                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('emptyStarterPromptLabel')}
                                </p>
                                <div className="mt-1 flex items-start gap-2 rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark p-3">
                                    <p className="flex-1 text-sm text-text dark:text-text-dark">
                                        {t('emptyStarterPrompt')}
                                    </p>
                                    <button
                                        type="button"
                                        data-testid="memory-facts-copy-prompt"
                                        onClick={() => void copyStarterPrompt()}
                                        className="shrink-0 text-xs font-medium text-primary dark:text-white"
                                    >
                                        {copied ? t('copied') : t('copyPrompt')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <p
                            data-testid="memory-facts-empty-view"
                            className="py-8 text-center text-sm text-text-muted dark:text-text-muted-dark"
                        >
                            {view === 'pinned'
                                ? t('emptyPinned')
                                : view === 'proposed'
                                  ? t('emptyProposed')
                                  : view === 'forgotten'
                                    ? t('emptyForgotten')
                                    : t('emptyTitle')}
                        </p>
                    )}
                </div>

                {!skeleton && facts.length > 0 && !searching && (
                    <div className="flex items-center justify-center gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                        <span data-testid="memory-facts-showing">
                            {t('showingCount', { shown: facts.length, total })}
                        </span>
                        {data.nextCursor && (
                            <button
                                type="button"
                                data-testid="memory-facts-load-more"
                                disabled={loading}
                                onClick={() =>
                                    void runFetch({ view, query, cursor: data.nextCursor })
                                }
                                className="font-medium text-primary dark:text-white disabled:opacity-60"
                            >
                                {t('loadMore')}
                            </button>
                        )}
                    </div>
                )}
            </div>

            <ForgetAllDialog
                open={forgetAllOpen}
                counts={{ active: counts.active, proposed: counts.proposed }}
                onCancel={() => setForgetAllOpen(false)}
                onConfirm={forgetAll}
            />
        </section>
    );
}
