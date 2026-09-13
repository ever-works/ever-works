import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FeedEntryDto, FeedPageDto } from '@ever-works/contracts';
import {
    appendFeedEntries,
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
});
