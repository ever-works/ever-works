import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FeedEntryDto, FeedPageDto } from '@ever-works/contracts';
import {
    FEED_HEAD_GAP_MAX_PAGES,
    appendFeedEntries,
    feedHeadJoins,
    prependFeedEntries,
    useFeedPaging,
    type FeedFetchResult,
} from './use-feed-paging';

const entry = (id: string, createdAt: string): FeedEntryDto => ({
    id,
    createdAt,
    kind: 'work',
    status: 'completed',
    actionType: 'task_created',
    actor: { kind: 'user', label: null },
    narration: { key: 'taskCreated', params: { actor: '', hasSubject: 'no' } },
    target: null,
});

const page = (items: FeedEntryDto[], nextCursor: string | null): FeedPageDto => ({
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    historyFloor: '2026-06-15T00:00:00.000Z',
});

const ok = (data: FeedPageDto): FeedFetchResult => ({ success: true, data });

describe('feed entry merging', () => {
    const a = entry('a', '2026-09-13T11:00:00.000Z');
    const b = entry('b', '2026-09-13T10:00:00.000Z');
    const c = entry('c', '2026-09-13T09:00:00.000Z');

    it('appends an older page without repeating an entry already on screen', () => {
        expect(appendFeedEntries([a, b], [b, c]).map((e) => e.id)).toEqual(['a', 'b', 'c']);
        const current = [a];
        expect(appendFeedEntries(current, [a])).toBe(current);
    });

    it('puts newer entries on top, newest first, without duplicates', () => {
        const newest = entry('n', '2026-09-13T11:30:00.000Z');
        expect(prependFeedEntries([a, b], [newest, a]).map((e) => e.id)).toEqual(['n', 'a', 'b']);
    });

    it('tells whether a head page joins up with the entries on screen', () => {
        const newer = entry('n1', '2026-09-13T11:30:00.000Z');
        const newest = entry('n2', '2026-09-13T11:45:00.000Z');
        // Reached the end of history: nothing can be missing.
        expect(feedHeadJoins([a, b], [newest, newer], false)).toBe(true);
        // Shares an entry with the screen.
        expect(feedHeadJoins([a, b], [newest, a], true)).toBe(true);
        // Ends strictly older than the newest entry on screen.
        expect(feedHeadJoins([a, b], [newest, c], true)).toBe(true);
        // Ends newer than the screen with more behind it: a gap.
        expect(feedHeadJoins([a, b], [newest, newer], true)).toBe(false);
        // Same instant as the newest entry, different record: not proven joined.
        expect(feedHeadJoins([a, b], [newest, entry('same', a.createdAt)], true)).toBe(false);
        // Nothing on screen to join.
        expect(feedHeadJoins([], [newest], true)).toBe(false);
    });
});

describe('useFeedPaging', () => {
    const e1 = entry('e1', '2026-09-13T11:00:00.000Z');
    const e2 = entry('e2', '2026-09-13T10:00:00.000Z');
    const e3 = entry('e3', '2026-09-13T09:00:00.000Z');

    it('loads the first page, then older pages, never showing an entry twice', async () => {
        const fetchPage = vi
            .fn<(cursor: string | null) => Promise<FeedFetchResult>>()
            .mockResolvedValueOnce(ok(page([e1, e2], 'c1')))
            // The boundary moved: e2 comes back again on the next page.
            .mockResolvedValueOnce(ok(page([e2, e3], null)));

        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));

        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(fetchPage).toHaveBeenLastCalledWith(null);
        expect(result.current.hasMore).toBe(true);
        expect(result.current.endReason).toBeNull();

        act(() => result.current.loadOlder());
        await waitFor(() =>
            expect(result.current.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']),
        );
        expect(fetchPage).toHaveBeenLastCalledWith('c1');
        expect(result.current.hasMore).toBe(false);
        expect(result.current.endReason).toBe('history');
    });

    it('uses a server-rendered first page instead of fetching', async () => {
        const fetchPage = vi.fn();
        const { result } = renderHook(() =>
            useFeedPaging({ filterKey: 'kinds=work', fetchPage, initialPage: page([e1], null) }),
        );
        expect(result.current.status).toBe('ready');
        expect(result.current.entries).toEqual([e1]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchPage).not.toHaveBeenCalled();
    });

    it('fetches nothing while disabled, then loads when enabled', async () => {
        const fetchPage = vi.fn().mockResolvedValue(ok(page([e1], null)));
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) =>
                useFeedPaging({ filterKey: '', fetchPage, enabled }),
            { initialProps: { enabled: false } },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchPage).not.toHaveBeenCalled();
        rerender({ enabled: true });
        await waitFor(() => expect(result.current.entries).toEqual([e1]));
    });

    it('resets to the first page when the filters change', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(ok(page([e1, e2], 'c1')))
            .mockResolvedValueOnce(ok(page([e3], null)));
        const { result, rerender } = renderHook(
            ({ filterKey }: { filterKey: string }) => useFeedPaging({ filterKey, fetchPage }),
            { initialProps: { filterKey: '' } },
        );
        await waitFor(() => expect(result.current.entries).toHaveLength(2));
        rerender({ filterKey: 'failed=1' });
        await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['e3']));
        expect(fetchPage).toHaveBeenLastCalledWith(null);
    });

    it('stops at the page cap and reports it as the end', async () => {
        let n = 0;
        const fetchPage = vi.fn(async () => {
            n += 1;
            return ok(
                page(
                    [entry(`p${n}`, `2026-09-13T${String(11 - n).padStart(2, '0')}:00:00.000Z`)],
                    `c${n}`,
                ),
            );
        });
        const { result } = renderHook(() =>
            useFeedPaging({ filterKey: '', fetchPage, maxPages: 2 }),
        );
        await waitFor(() => expect(result.current.status).toBe('ready'));
        act(() => result.current.loadOlder());
        await waitFor(() => expect(result.current.pagesLoaded).toBe(2));

        expect(result.current.hasMore).toBe(false);
        expect(result.current.endReason).toBe('pageCap');
        act(() => result.current.loadOlder());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('reloads from the first page when the cursor is refused', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(ok(page([e1], 'stale')))
            .mockResolvedValueOnce({ success: false, error: 'invalid-cursor' })
            .mockResolvedValueOnce(ok(page([e1, e2], null)));
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        act(() => result.current.loadOlder());
        await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['e1', 'e2']));
        expect(fetchPage).toHaveBeenNthCalledWith(3, null);
    });

    it('keeps the loaded entries and flags the failure when an older page fails', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(ok(page([e1], 'c1')))
            .mockResolvedValueOnce({ success: false, error: 'load-failed' });
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        act(() => result.current.loadOlder());
        await waitFor(() => expect(result.current.olderFailed).toBe(true));
        expect(result.current.entries).toEqual([e1]);
        expect(result.current.status).toBe('ready');
    });

    it('shows the error state when the first page fails, and recovers on a refresh', async () => {
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce({ success: false, error: 'load-failed' })
            .mockResolvedValueOnce(ok(page([e1], null)));
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.entries).toEqual([]);
        await act(() => result.current.refreshHead());
        expect(result.current.status).toBe('ready');
        expect(result.current.entries).toEqual([e1]);
    });

    it('merges new activity at the head on refresh without duplicates', async () => {
        const newest = entry('new', '2026-09-13T11:59:00.000Z');
        const fetchPage = vi
            .fn()
            .mockResolvedValueOnce(ok(page([e1, e2], 'c1')))
            .mockResolvedValueOnce(ok(page([newest, e1], 'c0')));
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        await act(() => result.current.refreshHead());
        expect(result.current.entries.map((e) => e.id)).toEqual(['new', 'e1', 'e2']);
        // The refresh does not move the older-page cursor.
        expect(result.current.hasMore).toBe(true);
    });

    /** A server over a newest-first list, paging by position the way the keyset cursor does. */
    const serverOver = (all: () => FeedEntryDto[], size: number) =>
        vi.fn(async (cursor: string | null) => {
            const list = all();
            const start = cursor ? list.findIndex((e) => e.id === cursor) + 1 : 0;
            const items = list.slice(start, start + size);
            const more = start + size < list.length;
            return ok(page(items, more ? items[items.length - 1].id : null));
        });
    const at = (minute: number) =>
        `2026-09-13T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
    const history = (prefix: string, count: number, newestMinute: number) =>
        Array.from({ length: count }, (_, i) => entry(`${prefix}${i}`, at(newestMinute - i)));

    it('follows a head refresh down to the screen when more than a page arrived, skipping nothing', async () => {
        const older = history('old', 6, 600);
        let all = older;
        const fetchPage = serverOver(() => all, 2);
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(result.current.entries.map((e) => e.id)).toEqual(['old0', 'old1']);

        // Five new records land: more than two pages' worth.
        const arrived = history('new', 5, 700);
        all = [...arrived, ...older];
        await act(() => result.current.refreshHead());
        expect(result.current.entries.map((e) => e.id)).toEqual([
            ...arrived.map((e) => e.id),
            'old0',
            'old1',
        ]);

        // Paging older continues exactly below what was already on screen.
        for (let i = 0; i < 2 && result.current.hasMore; i++) {
            act(() => result.current.loadOlder());
            await waitFor(() => expect(result.current.loadingOlder).toBe(false));
        }
        await waitFor(() => expect(result.current.hasMore).toBe(false));
        expect(result.current.entries.map((e) => e.id)).toEqual(all.map((e) => e.id));
    });

    it('restarts from the fresh head when too much arrived to follow, so older paging still reaches everything', async () => {
        const older = history('old', 4, 600);
        let all = older;
        const fetchPage = serverOver(() => all, 1);
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        act(() => result.current.loadOlder());
        await waitFor(() => expect(result.current.entries).toHaveLength(2));

        const arrived = history('new', FEED_HEAD_GAP_MAX_PAGES + 3, 900);
        all = [...arrived, ...older];
        fetchPage.mockClear();
        await act(() => result.current.refreshHead());

        // One head page plus the most it may follow, and no further.
        expect(fetchPage).toHaveBeenCalledTimes(FEED_HEAD_GAP_MAX_PAGES + 1);
        const shown = arrived.slice(0, FEED_HEAD_GAP_MAX_PAGES + 1).map((e) => e.id);
        expect(result.current.entries.map((e) => e.id)).toEqual(shown);
        expect(result.current.pagesLoaded).toBe(FEED_HEAD_GAP_MAX_PAGES + 1);

        while (result.current.hasMore) {
            act(() => result.current.loadOlder());
            await waitFor(() => expect(result.current.loadingOlder).toBe(false));
        }
        expect(result.current.entries.map((e) => e.id)).toEqual(all.map((e) => e.id));
    });

    it('takes the cursor of a head refresh that fills an empty feed with more than a page', async () => {
        let all: FeedEntryDto[] = [];
        const fetchPage = serverOver(() => all, 2);
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(result.current.hasMore).toBe(false);

        all = history('new', 3, 700);
        await act(() => result.current.refreshHead());
        expect(result.current.entries.map((e) => e.id)).toEqual(['new0', 'new1']);
        expect(result.current.hasMore).toBe(true);

        act(() => result.current.loadOlder());
        await waitFor(() =>
            expect(result.current.entries.map((e) => e.id)).toEqual(['new0', 'new1', 'new2']),
        );
    });

    it('leaves the screen untouched when following the head fails, and fills the gap on the next refresh', async () => {
        const older = history('old', 2, 600);
        let all = older;
        let failNextOlder = false;
        const server = serverOver(() => all, 1);
        const fetchPage = vi.fn(async (cursor: string | null) => {
            if (cursor !== null && failNextOlder) {
                failNextOlder = false;
                return { success: false, error: 'load-failed' } as FeedFetchResult;
            }
            return server(cursor);
        });
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));

        all = [...history('new', 2, 700), ...older];
        failNextOlder = true;
        await act(() => result.current.refreshHead());
        expect(result.current.entries.map((e) => e.id)).toEqual(['old0']);

        await act(() => result.current.refreshHead());
        expect(result.current.entries.map((e) => e.id)).toEqual(['new0', 'new1', 'old0']);
    });

    it('runs one head refresh at a time', async () => {
        const older = history('old', 2, 600);
        let all = older;
        const server = serverOver(() => all, 1);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetchPage = vi.fn(async (cursor: string | null) => {
            if (all !== older) await gate;
            return server(cursor);
        });
        const { result } = renderHook(() => useFeedPaging({ filterKey: '', fetchPage }));
        await waitFor(() => expect(result.current.status).toBe('ready'));

        all = [...history('new', 1, 700), ...older];
        fetchPage.mockClear();
        let first: Promise<void> = Promise.resolve();
        act(() => {
            first = result.current.refreshHead();
        });
        await act(() => result.current.refreshHead());
        expect(fetchPage).toHaveBeenCalledTimes(1);
        release();
        await act(() => first);
        expect(result.current.entries.map((e) => e.id)).toEqual(['new0', 'old0']);
    });
});
