'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PauseCircle, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    INBOX_DECISION_KINDS,
    INBOX_DECISION_PAGE_SIZE,
    INBOX_POLL_INTERVAL_MS,
    buildDecisionsHref,
    decisionConfidencePercent,
    decisionEmptyState,
    decisionRestartKey,
    hasDecisionFilters,
    type InboxDecision,
    type InboxDecisionCounts,
    type InboxDecisionFilters,
    type InboxDecisionTab,
    type InboxReplyOutcome,
} from '@/lib/api/inbox.shared';
import {
    getInboxDecisionCountsAction,
    listInboxDecisionsAction,
    setInboxItemReadAction,
} from '@/app/actions/dashboard/inbox';
import { InboxDecisionDetail, type DecisionOutcomeKey } from './InboxDecisionDetail';
import { InboxTabs } from './InboxTabs';

interface InboxDecisionsClientProps {
    decisions: InboxDecision[];
    /** Rows matching the filters, across all pages. */
    total: number;
    /** Header counts; `null` when they could not be read (never shown as 0). */
    counts: InboxDecisionCounts | null;
    /**
     * Where "Load more" continues: right after the last row of `decisions`,
     * `null` when nothing ranks after it. `undefined` = the API did not
     * report a cursor, and "Load more" falls back to an offset.
     */
    nextCursor?: string | null;
    filters: InboxDecisionFilters;
    /** From `?id=` — the deep link the Inbox, Home and the Task page carry. */
    selectedId?: string;
    /** A failed list read. The queue is then NEVER rendered as empty. */
    loadError?: string | null;
}

const DECISION_TABS: readonly InboxDecisionTab[] = ['open', 'answered', 'archived'];

/** Per-browser memory of the last good open count, shown on the error state. */
const LAST_KNOWN_KEY = 'ever-works:inbox-decisions:last-known-open';

function readLastKnownOpen(): number | null {
    try {
        const raw = window.sessionStorage.getItem(LAST_KNOWN_KEY);
        const value = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function writeLastKnownOpen(value: number): void {
    try {
        window.sessionStorage.setItem(LAST_KNOWN_KEY, String(value));
    } catch {
        // Private mode / storage disabled: the error state simply has no hint.
    }
}

/** Keys that should not steal typing inside a form control. */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * My Decisions — the Inbox read as a decision queue (`/inbox?view=decisions`).
 *
 * The rows are Inbox items (questions, approvals, escalations) ranked by
 * the API: work stopped behind it first, then escalation confidence, then
 * oldest first. Answering goes through the Inbox reply, which closes the
 * record behind the item and hands the answer to the parked or live run —
 * so this view and the message view can never disagree about what was
 * decided.
 *
 * Two deliberate honesty rules:
 *   - a failed read renders an error, never an empty queue ("nothing needs
 *     you" and "we could not ask" must not look the same);
 *   - the header counts are absent until they are known, never `0`.
 *
 * The counts refresh every 30 s while the tab is visible and not at all
 * while it is hidden; the list itself refreshes when the page revalidates
 * after an answer.
 *
 * "Load more" pages by cursor (the position of the last row held), never
 * by how many rows are held: the queue is live, and an offset into a
 * re-ranked queue skips a decision whenever one ahead of it is answered
 * elsewhere. A page that arrives after the list was re-read from the
 * server is dropped rather than stitched onto rows it does not follow.
 *
 * Whichever decision is on screen counts as opened (the first one, a
 * deep-linked one, or one walked to), so its unread mark clears and its
 * first view is recorded without needing a click.
 */
export function InboxDecisionsClient({
    decisions,
    total,
    counts,
    nextCursor,
    filters,
    selectedId,
    loadError,
}: InboxDecisionsClientProps) {
    const t = useTranslations('dashboard.inbox.decisions');
    const tInbox = useTranslations('dashboard.inbox');
    const router = useRouter();

    const [rows, setRows] = useState<InboxDecision[]>(decisions);
    const [rowTotal, setRowTotal] = useState(total);
    const [cursor, setCursor] = useState<string | null | undefined>(nextCursor);
    const [headerCounts, setHeaderCounts] = useState<InboxDecisionCounts | null>(counts);
    const [activeId, setActiveId] = useState<string | null>(
        selectedId && decisions.some((row) => row.id === selectedId)
            ? selectedId
            : (decisions[0]?.id ?? null),
    );
    // Decisions answered in this session keep their detail (and the line
    // saying what happened to the work) after they leave the open queue.
    const [answered, setAnswered] = useState<Record<string, InboxDecision>>({});
    const [outcomes, setOutcomes] = useState<Record<string, DecisionOutcomeKey>>({});
    const [announcement, setAnnouncement] = useState('');
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [search, setSearch] = useState(filters.q ?? '');
    const [lastKnownOpen, setLastKnownOpen] = useState<number | null>(null);
    const sendingRef = useRef(false);
    const listRef = useRef<HTMLUListElement>(null);
    // Bumped whenever the server hands down a fresh first page, so a "Load
    // more" page requested against the previous list is recognised as stale.
    const listGenerationRef = useRef(0);
    // The on-screen decision the read flip was last sent for.
    const markedReadRef = useRef<string | null>(null);

    useEffect(() => {
        listGenerationRef.current += 1;
        setRows(decisions);
        setRowTotal(total);
        setCursor(nextCursor);
        setActiveId((current) => {
            if (current && (decisions.some((row) => row.id === current) || answered[current])) {
                return current;
            }
            if (selectedId && decisions.some((row) => row.id === selectedId)) return selectedId;
            return decisions[0]?.id ?? null;
        });
        // `answered` is read, not tracked: a re-sync must not be re-run by
        // the answer that caused it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [decisions, total, nextCursor, selectedId]);

    useEffect(() => {
        setHeaderCounts(counts);
    }, [counts]);

    useEffect(() => {
        setSearch(filters.q ?? '');
    }, [filters.q]);

    useEffect(() => {
        if (headerCounts) writeLastKnownOpen(headerCounts.open);
    }, [headerCounts]);

    useEffect(() => {
        if (loadError) setLastKnownOpen(readLastKnownOpen());
    }, [loadError]);

    // Counts-only refresh: every 30 s while visible, once on becoming
    // visible again, never while hidden or while an answer is in flight.
    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            if (sendingRef.current || document.visibilityState !== 'visible') return;
            const next = await getInboxDecisionCountsAction();
            if (!cancelled && next) setHeaderCounts(next);
        };
        const timer = setInterval(() => void refresh(), INBOX_POLL_INTERVAL_MS);
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, []);

    const active = useMemo(
        () =>
            rows.find((row) => row.id === activeId) ??
            (activeId ? answered[activeId] : null) ??
            null,
        [rows, activeId, answered],
    );
    const activeIndex = rows.findIndex((row) => row.id === activeId);
    const activeUnreadId = active?.unread ? active.id : null;

    // Opening is looking, whatever put the decision on screen: the first
    // row, a deep link, the walker or a click. The read flip also records
    // the first view server-side. It is sent once each time a decision
    // comes on screen, never again while it stays there.
    useEffect(() => {
        if (activeId !== markedReadRef.current) markedReadRef.current = null;
    }, [activeId]);

    useEffect(() => {
        if (!activeUnreadId || markedReadRef.current === activeUnreadId) return;
        markedReadRef.current = activeUnreadId;
        setRows((prev) =>
            prev.map((candidate) =>
                candidate.id === activeUnreadId ? { ...candidate, unread: false } : candidate,
            ),
        );
        void setInboxItemReadAction(activeUnreadId, false).catch(() => undefined);
    }, [activeUnreadId]);

    const navigate = useCallback(
        (next: Partial<InboxDecisionFilters>) => {
            router.push(buildDecisionsHref({ ...filters, ...next }));
        },
        [filters, router],
    );

    const select = useCallback((row: InboxDecision) => {
        setActiveId(row.id);
        // Keep the selection linkable without refetching the page.
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('id', row.id);
            window.history.replaceState(window.history.state, '', url.toString());
        } catch {
            // A URL the browser will not rewrite is not worth failing a click.
        }
        // The read flip follows from the selection (the effect above).
    }, []);

    const moveBy = useCallback(
        (step: number) => {
            if (rows.length === 0) return;
            const from = activeIndex === -1 ? (step > 0 ? -1 : rows.length) : activeIndex;
            const target = rows[from + step];
            if (target) select(target);
        },
        [activeIndex, rows, select],
    );

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === 'Escape') {
                listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
                return;
            }
            if (isTypingTarget(event.target)) return;
            if (event.key === 'j' || event.key === ']') {
                event.preventDefault();
                moveBy(1);
            } else if (event.key === 'k' || event.key === '[') {
                event.preventDefault();
                moveBy(-1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [moveBy]);

    const handleSendingChange = useCallback((sending: boolean) => {
        sendingRef.current = sending;
    }, []);

    // After an answer: re-read the header counts in the background. An
    // unknown result (or a failed call) keeps the counts already on screen.
    const refreshHeaderCounts = useCallback(async () => {
        try {
            const next = await getInboxDecisionCountsAction();
            if (next) setHeaderCounts(next);
        } catch {
            // Best-effort: the page refresh re-reads them anyway.
        }
    }, []);

    const handleReplied = useCallback(
        (outcome: InboxReplyOutcome) => {
            const key = decisionRestartKey(outcome);
            const current = rows.find((row) => row.id === outcome.item.id);
            if (current) {
                const merged: InboxDecision = { ...current, ...outcome.item };
                setAnswered((prev) => ({ ...prev, [merged.id]: merged }));
                setRows((prev) => prev.map((row) => (row.id === merged.id ? merged : row)));
            }
            setOutcomes((prev) => ({ ...prev, [outcome.item.id]: key }));
            const agentName = current?.decision.agentName ?? null;
            const sentence =
                key === 'resumed'
                    ? agentName
                        ? t('resolution.resumed', { agent: agentName })
                        : t('resolution.resumedUnnamed')
                    : t(`resolution.${key}`);
            setAnnouncement(sentence);
            if (key === 'failed') toast.error(sentence);
            else toast.success(sentence);
            void refreshHeaderCounts();
            router.refresh();
        },
        [refreshHeaderCounts, router, rows, t],
    );

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        const generation = listGenerationRef.current;
        setIsLoadingMore(true);
        try {
            const page = await listInboxDecisionsAction(
                cursor === undefined
                    ? { ...filters, limit: INBOX_DECISION_PAGE_SIZE, offset: rows.length }
                    : {
                          ...filters,
                          limit: INBOX_DECISION_PAGE_SIZE,
                          ...(cursor ? { cursor } : {}),
                      },
            );
            // The server re-read the list while this page was on its way:
            // the page continues a list that is no longer on screen, and
            // appending it would leave a gap between the two.
            if (generation !== listGenerationRef.current) return;
            setRows((prev) => {
                const seen = new Set(prev.map((row) => row.id));
                return [...prev, ...page.data.filter((row) => !seen.has(row.id))];
            });
            setRowTotal(page.meta.total);
            if (cursor !== undefined) setCursor(page.meta.nextCursor ?? null);
        } catch {
            toast.error(t('loadMoreError'));
        } finally {
            setIsLoadingMore(false);
        }
    }, [cursor, filters, isLoadingMore, rows.length, t]);

    const handleSearch = useCallback(
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const q = search.trim();
            navigate({ q: q || undefined });
        },
        [navigate, search],
    );

    const filtered = hasDecisionFilters(filters);
    const remaining = Math.max(0, rowTotal - rows.length);
    // With a cursor the server says whether more follows; the count only
    // labels the button (it can lag the live queue by a row or two).
    const canLoadMore = cursor === undefined ? remaining > 0 : cursor !== null;

    return (
        <div className="p-4 sm:p-6 lg:p-8" data-testid="inbox-page">
            <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {headerCounts && (
                    <div
                        className="flex shrink-0 items-center gap-2 text-xs font-medium"
                        data-testid="decisions-counts"
                    >
                        <span
                            className="rounded-full bg-blue-600 px-2.5 py-1 text-white"
                            data-testid="decisions-open-count"
                        >
                            {t('counts.open', { count: headerCounts.open })}
                        </span>
                        {headerCounts.blocking > 0 && (
                            <span
                                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
                                data-testid="decisions-blocking-count"
                            >
                                <PauseCircle className="w-3.5 h-3.5" />
                                {t('counts.blocking', { count: headerCounts.blocking })}
                            </span>
                        )}
                    </div>
                )}
            </header>

            <InboxTabs view="decisions" />

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1" role="tablist" aria-label={t('title')}>
                    {DECISION_TABS.map((tab) => (
                        <Button
                            key={tab}
                            href={buildDecisionsHref({ ...filters, tab })}
                            variant={filters.tab === tab ? 'primary' : 'ghost'}
                            size="sm"
                            role="tab"
                            aria-selected={filters.tab === tab}
                            data-testid={`decisions-tab-${tab}`}
                        >
                            {t(`tabs.${tab}`)}
                        </Button>
                    ))}
                </div>

                <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={handleSearch}
                    aria-label={t('filters.label')}
                >
                    <label className="sr-only" htmlFor="decisions-kind">
                        {t('filters.kind')}
                    </label>
                    <select
                        id="decisions-kind"
                        value={filters.kind ?? ''}
                        onChange={(event) =>
                            navigate({
                                kind:
                                    (event.target.value as InboxDecisionFilters['kind']) ||
                                    undefined,
                            })
                        }
                        className="h-8 rounded-md border border-border dark:border-border-dark bg-transparent px-2 text-sm text-text dark:text-text-dark"
                        data-testid="decisions-filter-kind"
                    >
                        <option value="">{t('filters.allKinds')}</option>
                        {INBOX_DECISION_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                                {tInbox(`kind.${kind}`)}
                            </option>
                        ))}
                    </select>
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 w-3.5 h-3.5 -translate-y-1/2 text-text-secondary dark:text-text-secondary-dark" />
                        <input
                            type="search"
                            value={search}
                            maxLength={200}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('filters.search')}
                            aria-label={t('filters.search')}
                            className="h-8 w-52 rounded-md border border-border dark:border-border-dark bg-transparent pl-7 pr-2 text-sm text-text dark:text-text-dark"
                            data-testid="decisions-filter-search"
                        />
                    </div>
                    {(['agentId', 'taskId', 'missionId'] as const).map((key) =>
                        filters[key] ? (
                            <button
                                key={key}
                                type="button"
                                onClick={() => navigate({ [key]: undefined })}
                                className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark px-2 py-0.5 text-xs text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/6"
                                aria-label={`${t(`filters.${key}`)} — ${t('filters.remove')}`}
                                data-testid={`decisions-filter-chip-${key}`}
                            >
                                {t(`filters.${key}`)}
                                <X className="w-3 h-3" />
                            </button>
                        ) : null,
                    )}
                    {filtered && (
                        <Link
                            href={buildDecisionsHref({ tab: filters.tab })}
                            className="text-xs font-medium text-primary hover:underline"
                            data-testid="decisions-clear-filters"
                        >
                            {t('filters.clear')}
                        </Link>
                    )}
                </form>
            </div>

            <p aria-live="polite" className="sr-only" data-testid="decisions-live-region">
                {announcement}
            </p>

            {loadError ? (
                <DecisionsErrorState
                    lastKnownOpen={lastKnownOpen}
                    onRetry={() => router.refresh()}
                />
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-4">
                    <div className="space-y-3">
                        <ul
                            ref={listRef}
                            className="rounded-xl border border-border dark:border-border-dark divide-y divide-border dark:divide-border-dark overflow-hidden"
                            data-testid="decisions-list"
                        >
                            {rows.length === 0 && (
                                <li>
                                    <DecisionsEmptyState
                                        tab={filters.tab}
                                        filtered={filtered}
                                        lastRaisedAt={headerCounts?.lastRaisedAt ?? null}
                                    />
                                </li>
                            )}
                            {rows.map((row) => (
                                <li key={row.id}>
                                    <DecisionCard
                                        decision={row}
                                        active={row.id === activeId}
                                        onSelect={select}
                                    />
                                </li>
                            ))}
                        </ul>
                        {canLoadMore && (
                            <Button
                                variant="secondary"
                                size="sm"
                                fullWidth
                                onClick={() => void handleLoadMore()}
                                disabled={isLoadingMore}
                                data-testid="decisions-load-more"
                            >
                                {isLoadingMore && <Loader2 className="w-4 h-4 animate-spin" />}
                                {t('loadMore', {
                                    count: Math.min(
                                        INBOX_DECISION_PAGE_SIZE,
                                        Math.max(1, remaining),
                                    ),
                                })}
                            </Button>
                        )}
                        {rows.length > 1 && (
                            <p className="text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                {t('detail.keyboardHint')}
                            </p>
                        )}
                    </div>

                    <section
                        className="rounded-xl border border-border dark:border-border-dark p-5 min-h-[20rem]"
                        data-testid="inbox-detail"
                    >
                        {!active ? (
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {t('detail.none')}
                            </p>
                        ) : (
                            <InboxDecisionDetail
                                decision={active}
                                position={activeIndex === -1 ? null : activeIndex + 1}
                                total={rowTotal}
                                outcome={outcomes[active.id] ?? null}
                                onPrevious={activeIndex > 0 ? () => moveBy(-1) : null}
                                onNext={
                                    activeIndex === -1
                                        ? rows[0]
                                            ? () => select(rows[0])
                                            : null
                                        : activeIndex < rows.length - 1
                                          ? () => moveBy(1)
                                          : null
                                }
                                onSendingChange={handleSendingChange}
                                onReplied={handleReplied}
                            />
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}

/** One row of the queue. */
function DecisionCard({
    decision,
    active,
    onSelect,
}: {
    decision: InboxDecision;
    active: boolean;
    onSelect: (row: InboxDecision) => void;
}) {
    const t = useTranslations('dashboard.inbox.decisions');
    const tInbox = useTranslations('dashboard.inbox');
    const context = decision.decision;
    const confidence = decisionConfidencePercent(context.confidence);
    const byline = [context.agentName, context.taskTitle].filter(Boolean).join(' · ');

    return (
        <button
            type="button"
            onClick={() => onSelect(decision)}
            aria-current={active}
            data-testid="decision-row"
            data-blocking={context.blocking ? 'true' : 'false'}
            className={cn(
                'w-full text-left px-4 py-3 transition-colors',
                active
                    ? 'bg-surface-secondary dark:bg-card-secondary-dark'
                    : 'hover:bg-surface-secondary dark:hover:bg-card-primary-dark',
            )}
        >
            <div className="flex items-center gap-2 min-w-0">
                {decision.unread && (
                    <span
                        className="shrink-0 w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400"
                        aria-label={tInbox('unreadDot')}
                    />
                )}
                <span
                    className={cn(
                        'truncate text-sm',
                        decision.unread
                            ? 'font-semibold text-text dark:text-text-dark'
                            : 'text-text dark:text-text-secondary-dark',
                    )}
                >
                    {decision.title}
                </span>
            </div>
            {byline && (
                <p className="mt-1 truncate text-xs text-text-secondary dark:text-text-secondary-dark">
                    {byline}
                </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="rounded-full border border-border/60 dark:border-white/10 px-1.5 py-0.5">
                    {tInbox(`kind.${decision.kind}`)}
                </span>
                {context.blocking && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
                        <PauseCircle className="w-3 h-3" />
                        {t('card.blocking')}
                    </span>
                )}
                <span>
                    {confidence === null
                        ? t('card.notScored')
                        : t('card.confidence', { percent: confidence })}
                </span>
                {context.dormant && <span>{t('card.dormant')}</span>}
                <ShowDateTime value={decision.createdAt} />
            </div>
        </button>
    );
}

/** The four ways an empty list can be honest. */
function DecisionsEmptyState({
    tab,
    filtered,
    lastRaisedAt,
}: {
    tab: InboxDecisionTab;
    filtered: boolean;
    lastRaisedAt: string | null;
}) {
    const t = useTranslations('dashboard.inbox.decisions');
    const box = 'p-8 text-center text-sm text-text-secondary dark:text-text-secondary-dark';

    if (filtered) {
        return (
            <div className={box} data-testid="decisions-empty-filtered">
                {t('empty.filteredTitle')}
            </div>
        );
    }
    if (tab === 'answered') {
        return (
            <div className={box} data-testid="decisions-empty-answered">
                {t('empty.answeredTitle')}
            </div>
        );
    }
    if (tab === 'archived') {
        return (
            <div className={box} data-testid="decisions-empty-archived">
                {t('empty.archivedTitle')}
            </div>
        );
    }

    const state = decisionEmptyState(lastRaisedAt);
    if (state.kind === 'first-run') {
        return (
            <div className={cn(box, 'space-y-2')} data-testid="decisions-empty-first-run">
                <p className="font-medium text-text dark:text-text-dark">
                    {t('empty.firstRunTitle')}
                </p>
                <p>{t('empty.firstRunBody')}</p>
                <p>{t('empty.firstRunHint')}</p>
                <Link
                    href={ROUTES.DASHBOARD_AGENTS}
                    className="inline-block text-xs font-medium text-primary hover:underline"
                >
                    {t('empty.openAgents')}
                </Link>
            </div>
        );
    }
    return (
        <div className={cn(box, 'space-y-2')} data-testid={`decisions-empty-${state.kind}`}>
            <CheckCircle2 className="mx-auto w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            <p className="font-medium text-text dark:text-text-dark">{t('empty.quietTitle')}</p>
            {state.kind === 'quiet' && (
                <>
                    <p>{t('empty.quietBody')}</p>
                    <Link
                        href={ROUTES.DASHBOARD_ACTIVITY}
                        className="inline-block text-xs font-medium text-primary hover:underline"
                    >
                        {t('empty.reviewActivity')}
                    </Link>
                    <p className="text-xs">{t('empty.quietFootnote', { days: state.days })}</p>
                </>
            )}
        </div>
    );
}

/** A failed read. Deliberately never an empty queue. */
function DecisionsErrorState({
    lastKnownOpen,
    onRetry,
}: {
    lastKnownOpen: number | null;
    onRetry: () => void;
}) {
    const t = useTranslations('dashboard.inbox.decisions');
    return (
        <div
            className="rounded-xl border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/10 p-8 text-center text-sm text-red-800 dark:text-red-300 space-y-2"
            role="alert"
            data-testid="decisions-error"
        >
            <AlertTriangle className="mx-auto w-6 h-6" />
            <p className="font-medium">{t('error.title')}</p>
            <p>{t('error.body')}</p>
            <Button variant="secondary" size="sm" onClick={onRetry} data-testid="decisions-retry">
                {t('error.retry')}
            </Button>
            {lastKnownOpen !== null && (
                <p className="text-xs" data-testid="decisions-last-known">
                    {t('error.lastKnown', { count: lastKnownOpen })}
                </p>
            )}
        </div>
    );
}
