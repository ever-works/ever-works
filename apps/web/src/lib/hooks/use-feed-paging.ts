'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FEED_MAX_AUTO_PAGES, type FeedEntryDto, type FeedPageDto } from '@ever-works/contracts';

/**
 * Live Feed — keyset paging backwards through history.
 *
 * Owns the loaded entries, the next cursor and the two stops (the 90-day
 * history floor the API enforces, and a cap of 20 pages per visit). Every
 * merge de-duplicates by entry id, so a page boundary that moves while new
 * activity lands at the head can never show an entry twice. Older pages load
 * when a sentinel comes within 400px of the viewport, and through an explicit
 * `loadOlder()` for keyboard and assistive-technology users.
 */

export type FeedFetchResult =
    | { success: true; data: FeedPageDto }
    | { success: false; error: string };

export type FeedPageFetcher = (cursor: string | null) => Promise<FeedFetchResult>;

export type FeedPagingStatus = 'loading' | 'ready' | 'error';

export type FeedEndReason = 'history' | 'pageCap' | null;

/** Append an older page, skipping ids already on screen. */
export function appendFeedEntries(current: FeedEntryDto[], older: FeedEntryDto[]): FeedEntryDto[] {
    if (older.length === 0) return current;
    const seen = new Set(current.map((entry) => entry.id));
    const additions = older.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
    });
    return additions.length === 0 ? current : [...current, ...additions];
}

/** Put newer entries on top, skipping ids already on screen, keeping newest first. */
export function prependFeedEntries(current: FeedEntryDto[], newer: FeedEntryDto[]): FeedEntryDto[] {
    if (newer.length === 0) return current;
    const seen = new Set(current.map((entry) => entry.id));
    const additions = newer.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
    });
    if (additions.length === 0) return current;
    return [...additions, ...current].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}

interface UseFeedPagingOptions {
    /** Identity of the current filter set; a change resets to the first page. */
    filterKey: string;
    fetchPage: FeedPageFetcher;
    /** A server-rendered first page for the `filterKey` at mount, used instead of a fetch. */
    initialPage?: FeedPageDto | null;
    /** While false nothing is fetched (e.g. saved filters are still being restored). */
    enabled?: boolean;
    maxPages?: number;
}

export interface FeedPaging {
    entries: FeedEntryDto[];
    status: FeedPagingStatus;
    hasMore: boolean;
    loadingOlder: boolean;
    olderFailed: boolean;
    pagesLoaded: number;
    endReason: FeedEndReason;
    reload: () => void;
    loadOlder: () => void;
    refreshHead: () => Promise<void>;
    /** Attach to an element after the last entry to page automatically. */
    sentinelRef: (node: Element | null) => void;
}

export function useFeedPaging({
    filterKey,
    fetchPage,
    initialPage,
    enabled = true,
    maxPages = FEED_MAX_AUTO_PAGES,
}: UseFeedPagingOptions): FeedPaging {
    const [entries, setEntries] = useState<FeedEntryDto[]>(() => initialPage?.items ?? []);
    const [status, setStatus] = useState<FeedPagingStatus>(initialPage ? 'ready' : 'loading');
    const [cursor, setCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
    const [hasMore, setHasMore] = useState<boolean>(initialPage?.hasMore ?? false);
    const [pagesLoaded, setPagesLoaded] = useState<number>(initialPage ? 1 : 0);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [olderFailed, setOlderFailed] = useState(false);

    const fetchRef = useRef(fetchPage);
    // Declared before the loading effect below, so it always sees the latest fetcher.
    useEffect(() => {
        fetchRef.current = fetchPage;
    });
    /** Bumped on every reset so a slow response for old filters is dropped. */
    const generationRef = useRef(0);
    const loadingOlderRef = useRef(false);
    /** The filter set the server-rendered page belongs to, until it is used or superseded. */
    const initialKeyRef = useRef<string | null>(initialPage ? filterKey : null);

    const loadFirst = useCallback(async () => {
        const generation = ++generationRef.current;
        loadingOlderRef.current = false;
        setLoadingOlder(false);
        setOlderFailed(false);
        setStatus('loading');
        const result = await fetchRef
            .current(null)
            .catch(() => ({ success: false, error: 'load-failed' }) as FeedFetchResult);
        if (generation !== generationRef.current) return;
        if (!result.success) {
            setEntries([]);
            setHasMore(false);
            setCursor(null);
            setPagesLoaded(0);
            setStatus('error');
            return;
        }
        setEntries(appendFeedEntries([], result.data.items));
        setCursor(result.data.nextCursor);
        setHasMore(result.data.hasMore && result.data.nextCursor !== null);
        setPagesLoaded(1);
        setStatus('ready');
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const initialKey = initialKeyRef.current;
        initialKeyRef.current = null;
        // The server already rendered this filter set's first page.
        if (initialKey !== null && initialKey === filterKey) return;
        void loadFirst();
    }, [enabled, filterKey, loadFirst]);

    const reachedCap = pagesLoaded >= maxPages;

    const loadOlder = useCallback(() => {
        if (loadingOlderRef.current || !hasMore || !cursor || status !== 'ready' || reachedCap)
            return;
        loadingOlderRef.current = true;
        setLoadingOlder(true);
        setOlderFailed(false);
        const generation = generationRef.current;
        void fetchRef
            .current(cursor)
            .catch(() => ({ success: false, error: 'load-failed' }) as FeedFetchResult)
            .then((result) => {
                if (generation !== generationRef.current) return;
                loadingOlderRef.current = false;
                setLoadingOlder(false);
                if (!result.success) {
                    if (result.error === 'invalid-cursor') {
                        // A cursor the API no longer accepts: start over from page one.
                        void loadFirst();
                        return;
                    }
                    setOlderFailed(true);
                    return;
                }
                setEntries((current) => appendFeedEntries(current, result.data.items));
                setCursor(result.data.nextCursor);
                setHasMore(result.data.hasMore && result.data.nextCursor !== null);
                setPagesLoaded((count) => count + 1);
            });
    }, [cursor, hasMore, loadFirst, reachedCap, status]);

    const refreshHead = useCallback(async () => {
        if (status === 'loading') return;
        const generation = generationRef.current;
        const result = await fetchRef
            .current(null)
            .catch(() => ({ success: false, error: 'load-failed' }) as FeedFetchResult);
        if (generation !== generationRef.current || !result.success) return;
        if (status === 'error') {
            // The feed recovered on its own: show the fresh first page.
            setEntries(appendFeedEntries([], result.data.items));
            setCursor(result.data.nextCursor);
            setHasMore(result.data.hasMore && result.data.nextCursor !== null);
            setPagesLoaded(1);
            setStatus('ready');
            return;
        }
        setEntries((current) => prependFeedEntries(current, result.data.items));
    }, [status]);

    const observerRef = useRef<IntersectionObserver | null>(null);
    const loadOlderRef = useRef(loadOlder);
    useEffect(() => {
        loadOlderRef.current = loadOlder;
    });

    const sentinelRef = useCallback((node: Element | null) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!node || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(
            (records) => {
                if (records.some((record) => record.isIntersecting)) loadOlderRef.current();
            },
            { rootMargin: '400px' },
        );
        observer.observe(node);
        observerRef.current = observer;
    }, []);

    useEffect(() => () => observerRef.current?.disconnect(), []);

    let endReason: FeedEndReason = null;
    if (status === 'ready' && entries.length > 0) {
        if (!hasMore) endReason = 'history';
        else if (reachedCap) endReason = 'pageCap';
    }

    return {
        entries,
        status,
        hasMore: hasMore && !reachedCap,
        loadingOlder,
        olderFailed,
        pagesLoaded,
        endReason,
        reload: () => void loadFirst(),
        loadOlder,
        refreshHead,
        sentinelRef,
    };
}
