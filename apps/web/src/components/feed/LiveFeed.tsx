'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { FEED_KINDS, type FeedActorSummaryDto, type FeedPageDto } from '@ever-works/contracts';
import { getFeedActors, getFeedPage } from '@/app/actions/feed';
import { useRouter } from '@/i18n/navigation';
import { ActivityViewHeader } from '@/components/activity-log/ActivityViewHeader';
import { useFeedPaging } from '@/lib/hooks/use-feed-paging';
import { useFeedUpdates, type FeedUpdateTransport } from '@/lib/hooks/use-feed-updates';
import { FeedAgentPicker } from './FeedAgentPicker';
import { FeedFilters } from './FeedFilters';
import { FeedList } from './FeedList';
import { FeedEmptyState, FeedErrorState, FeedFilteredEmptyState, FeedSkeleton } from './FeedStates';
import {
    EMPTY_FEED_FILTERS,
    feedFiltersToQuery,
    hasFeedFilterParams,
    isFeedFiltered,
    parseFeedFilters,
    readStoredFeedFilters,
    toggleFeedAgent,
    toggleFeedKind,
    writeStoredFeedFilters,
    type FeedFilterState,
} from './feed-filters';
import { feedTargetHref } from './feed-href';

interface LiveFeedProps {
    /** Server-rendered first page for the filters in the URL, when the view was requested directly. */
    initialPage?: FeedPageDto | null;
    initialActors?: FeedActorSummaryDto[] | null;
    /** Reports the filter query string so the host page can keep one URL writer. */
    onFiltersChange?: (query: string) => void;
    /** Switches the host page to the Activity log. */
    onOpenActivityLog: () => void;
    /** Replaceable source of "something new" signals; defaults to a 10-second refresh. */
    transport?: FeedUpdateTransport;
}

const RELATIVE_TIME_TICK_MS = 30_000;

function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function safeLocalStorage(): Storage | undefined {
    try {
        return typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
        return undefined;
    }
}

/**
 * Live Feed — the narrated view of the activity log, mounted as a view of the
 * Activity page. Reads existing activity records only: newest first, filterable
 * by agent and kind, paged backwards through 90 days, refreshed on a timer
 * that a push transport can later replace through `transport`.
 */
export function LiveFeed({
    initialPage = null,
    initialActors = null,
    onFiltersChange,
    onOpenActivityLog,
    transport,
}: LiveFeedProps) {
    const t = useTranslations('dashboard.feed');
    const router = useRouter();
    const searchParams = useSearchParams();

    const urlHasFilters = hasFeedFilterParams(searchParams);
    const [filters, setFilters] = useState<FeedFilterState>(() =>
        urlHasFilters ? parseFeedFilters(searchParams) : EMPTY_FEED_FILTERS,
    );
    // With no filters in the URL, the last-used ones are restored after mount
    // (localStorage does not exist during the server render). Fetching waits
    // for that so the feed does not load twice.
    const [restored, setRestored] = useState(urlHasFilters);
    const [actors, setActors] = useState<FeedActorSummaryDto[]>(initialActors ?? []);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [limitReached, setLimitReached] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        if (restored) return;
        const stored = readStoredFeedFilters(safeLocalStorage());
        if (stored && isFeedFiltered(stored)) setFilters(stored);
        setRestored(true);
        // Mount-only restore.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const filterKey = feedFiltersToQuery(filters);

    const onFiltersChangeRef = useRef(onFiltersChange);
    useEffect(() => {
        onFiltersChangeRef.current = onFiltersChange;
    });
    useEffect(() => {
        if (!restored) return;
        writeStoredFeedFilters(safeLocalStorage(), filters);
        onFiltersChangeRef.current?.(filterKey);
        // `filterKey` is the identity of `filters`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterKey, restored]);

    useEffect(() => {
        if (initialActors) return;
        let cancelled = false;
        void getFeedActors().then((result) => {
            if (!cancelled && result.success) setActors(result.data.actors);
        });
        return () => {
            cancelled = true;
        };
    }, [initialActors]);

    const fetchPage = useCallback(
        (cursor: string | null) =>
            getFeedPage({
                agentIds: filters.agentIds,
                kinds: filters.kinds,
                failedOnly: filters.failedOnly,
                cursor,
            }),
        // `filterKey` is the identity of `filters`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [filterKey],
    );

    const paging = useFeedPaging({ filterKey, fetchPage, initialPage, enabled: restored });

    useFeedUpdates(
        () => {
            setNow(new Date());
            void paging.refreshHead();
        },
        { enabled: restored && paging.status !== 'loading', transport },
    );

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), RELATIVE_TIME_TICK_MS);
        return () => clearInterval(timer);
    }, []);

    const updateFilters = useCallback((next: FeedFilterState) => {
        setSelectedId(null);
        setFilters(next);
    }, []);

    const handleToggleAgent = useCallback(
        (agentId: string) => {
            const result = toggleFeedAgent(filters, agentId);
            setLimitReached(result.refused);
            if (!result.refused) updateFilters(result.state);
        },
        [filters, updateFilters],
    );

    const clearFilters = useCallback(() => {
        setLimitReached(false);
        updateFilters(EMPTY_FEED_FILTERS);
    }, [updateFilters]);

    const { entries } = paging;
    const selectedIndex = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1;

    const focusEntry = useCallback((id: string) => {
        const row = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="feed-entry"]'),
        ).find((element) => element.dataset.entryId === id);
        if (!row) return;
        const link = row.querySelector<HTMLElement>('[data-testid="feed-entry-link"]');
        (link ?? row).focus({ preventScroll: true });
        row.scrollIntoView?.({ block: 'nearest' });
    }, []);

    const moveSelection = useCallback(
        (delta: number) => {
            if (entries.length === 0) return;
            const from = selectedIndex < 0 ? (delta > 0 ? -1 : 0) : selectedIndex;
            const nextIndex = Math.min(entries.length - 1, Math.max(0, from + delta));
            const next = entries[nextIndex];
            setSelectedId(next.id);
            focusEntry(next.id);
            if (delta > 0 && nextIndex === entries.length - 1 && paging.hasMore) paging.loadOlder();
        },
        [entries, focusEntry, paging, selectedIndex],
    );

    const handlersRef = useRef({
        moveSelection,
        filters,
        updateFilters,
        paging,
        pickerOpen,
        selectedIndex,
    });
    useEffect(() => {
        handlersRef.current = {
            moveSelection,
            filters,
            updateFilters,
            paging,
            pickerOpen,
            selectedIndex,
        };
    });

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            if (isTypingTarget(event.target)) return;
            const current = handlersRef.current;
            if (current.pickerOpen) return;

            const key = event.key;
            if (key === 'j' || key === 'k') {
                event.preventDefault();
                current.moveSelection(key === 'j' ? 1 : -1);
                return;
            }
            if (key === 'Enter' || key === 'o') {
                const entry = current.paging.entries[current.selectedIndex];
                if (!entry) return;
                const target = event.target instanceof HTMLElement ? event.target : null;
                // A focused link or button already handles Enter natively.
                if (key === 'Enter' && target?.closest('a, button')) return;
                const href = feedTargetHref(entry.target);
                if (!href) return;
                event.preventDefault();
                router.push(href);
                return;
            }
            if (key === 'Escape') {
                setSelectedId(null);
                return;
            }
            if (key === 'a') {
                event.preventDefault();
                setPickerOpen(true);
                return;
            }
            if (key === 'x') {
                event.preventDefault();
                current.updateFilters({
                    ...current.filters,
                    failedOnly: !current.filters.failedOnly,
                });
                return;
            }
            if (key === 'L' && event.shiftKey) {
                event.preventDefault();
                current.paging.loadOlder();
                return;
            }
            const digit = Number.parseInt(key, 10);
            if (
                key.length === 1 &&
                digit >= 1 &&
                digit <= FEED_KINDS.length &&
                !current.filters.failedOnly
            ) {
                event.preventDefault();
                current.updateFilters(toggleFeedKind(current.filters, FEED_KINDS[digit - 1]));
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [router]);

    const filtered = isFeedFiltered(filters);
    const failedInView = useMemo(
        () => (filters.failedOnly && paging.status === 'ready' ? entries.length : null),
        [entries.length, filters.failedOnly, paging.status],
    );

    let body: ReactNode;
    if (paging.status === 'loading' || (!restored && initialPage === null)) {
        body = <FeedSkeleton />;
    } else if (paging.status === 'error') {
        body = <FeedErrorState onRetry={paging.reload} onOpenActivityLog={onOpenActivityLog} />;
    } else if (entries.length === 0) {
        body = filtered ? (
            <FeedFilteredEmptyState
                byAgent={filters.agentIds.length > 0}
                onClearFilters={clearFilters}
            />
        ) : (
            <FeedEmptyState />
        );
    } else {
        body = (
            <FeedList
                entries={entries}
                selectedId={selectedId}
                now={now}
                hasMore={paging.hasMore}
                loadingOlder={paging.loadingOlder}
                olderFailed={paging.olderFailed}
                pagesLoaded={paging.pagesLoaded}
                endReason={paging.endReason}
                onLoadOlder={paging.loadOlder}
                onOpenActivityLog={onOpenActivityLog}
                onFocusEntry={setSelectedId}
                sentinelRef={paging.sentinelRef}
            />
        );
    }

    return (
        <section data-testid="live-feed" aria-labelledby="live-feed-title" className="space-y-4">
            <ActivityViewHeader
                titleId="live-feed-title"
                title={t('title')}
                subtitle={t('subtitle')}
                aside={
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('refreshNote')}
                    </span>
                }
            />

            <FeedFilters
                filters={filters}
                actors={actors}
                onToggleAgent={handleToggleAgent}
                onClearAgents={() => {
                    setLimitReached(false);
                    updateFilters({ ...filters, agentIds: [] });
                }}
                onOpenPicker={() => setPickerOpen(true)}
                onToggleKind={(kind) => updateFilters(toggleFeedKind(filters, kind))}
                onToggleFailedOnly={() =>
                    updateFilters({ ...filters, failedOnly: !filters.failedOnly })
                }
                onClearFilters={clearFilters}
                failedInView={failedInView}
                limitReached={limitReached && !pickerOpen}
                filtered={filtered}
            />

            {body}

            <FeedAgentPicker
                open={pickerOpen}
                onOpenChange={(open) => {
                    setPickerOpen(open);
                    if (!open) setLimitReached(false);
                }}
                actors={actors}
                selected={filters.agentIds}
                onToggle={handleToggleAgent}
                onClearAll={() => {
                    setLimitReached(false);
                    updateFilters({ ...filters, agentIds: [] });
                }}
                limitReached={limitReached}
            />
        </section>
    );
}
