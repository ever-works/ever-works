import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    READ_BATCH_WINDOW_MS,
    READ_DWELL_MS,
    useChangelogReadTracker,
    type ChangelogReadFlushResult,
} from './use-changelog-read-tracker';

/**
 * What's new (AW-14) — the read tracker decides when a reader has actually
 * seen an entry and how often that is written. Every threshold here is a
 * number in the spec (FR-16, FR-17, FR-48), so each one is pinned.
 */

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;

class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = [];
    readonly observed = new Set<Element>();
    constructor(readonly callback: ObserverCallback) {
        FakeIntersectionObserver.instances.push(this);
    }
    observe(element: Element) {
        this.observed.add(element);
    }
    unobserve(element: Element) {
        this.observed.delete(element);
    }
    disconnect() {
        this.observed.clear();
    }
}

function latestObserver(): FakeIntersectionObserver {
    const observer = FakeIntersectionObserver.instances.at(-1);
    if (!observer) throw new Error('no observer');
    return observer;
}

function setVisibility(element: Element, ratio: number) {
    act(() => {
        latestObserver().callback([
            {
                target: element,
                isIntersecting: ratio > 0,
                intersectionRatio: ratio,
            } as IntersectionObserverEntry,
        ]);
    });
}

function makeCards(count: number): Element[] {
    return Array.from({ length: count }, () => document.createElement('article'));
}

async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe('useChangelogReadTracker', () => {
    const originalObserver = window.IntersectionObserver;
    let flush: ReturnType<typeof vi.fn<(slugs: string[]) => Promise<ChangelogReadFlushResult>>>;
    let onRead: ReturnType<typeof vi.fn<(slugs: string[]) => void>>;
    let onUnreadCount: ReturnType<typeof vi.fn<(count: number) => void>>;

    beforeEach(() => {
        vi.useFakeTimers();
        FakeIntersectionObserver.instances = [];
        // @ts-expect-error — test double
        window.IntersectionObserver = FakeIntersectionObserver;
        flush = vi.fn<(slugs: string[]) => Promise<ChangelogReadFlushResult>>(async () => ({
            success: true,
            unreadCount: 7,
        }));
        onRead = vi.fn<(slugs: string[]) => void>();
        onUnreadCount = vi.fn<(count: number) => void>();
    });

    afterEach(() => {
        vi.useRealTimers();
        window.IntersectionObserver = originalObserver;
    });

    function mount() {
        return renderHook(() => useChangelogReadTracker({ flush, onRead, onUnreadCount }));
    }

    function trackAll(
        result: ReturnType<typeof mount>['result'],
        cards: Element[],
        prefix = 'entry',
    ) {
        act(() => {
            cards.forEach((card, index) => result.current.track(`${prefix}-${index}`, card));
        });
    }

    it('FR-16: 50% visible for 999 ms does not mark the entry read', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 0.5);
        await advance(READ_DWELL_MS - 1);
        setVisibility(card, 0);
        await advance(READ_BATCH_WINDOW_MS * 2);

        expect(onRead).not.toHaveBeenCalled();
        expect(flush).not.toHaveBeenCalled();
    });

    it('FR-16: less than half visible never starts the clock', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 0.49);
        await advance(READ_DWELL_MS * 5);

        expect(onRead).not.toHaveBeenCalled();
    });

    it('FR-16: 50% visible for 1000 ms marks the entry read and writes it', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 0.5);
        await advance(READ_DWELL_MS);
        expect(onRead).toHaveBeenCalledWith(['entry-0']);

        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith(['entry-0']);
        expect(onUnreadCount).toHaveBeenCalledWith(7);
    });

    it('FR-16: scrolling away resets the dwell clock', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 1);
        await advance(600);
        setVisibility(card, 0);
        setVisibility(card, 1);
        await advance(600);

        expect(onRead).not.toHaveBeenCalled();
        await advance(400);
        expect(onRead).toHaveBeenCalledTimes(1);
    });

    it('FR-17: two entries read within one 2000 ms window go out as one batched call', async () => {
        const { result } = mount();
        const cards = makeCards(2);
        trackAll(result, cards);

        setVisibility(cards[0], 1);
        await advance(READ_DWELL_MS);
        setVisibility(cards[1], 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush.mock.calls[0][0].sort()).toEqual(['entry-0', 'entry-1']);
    });

    it('FR-17: 30 entries go out as two calls, the first carrying exactly 25', async () => {
        const { result } = mount();
        const cards = makeCards(30);
        trackAll(result, cards);

        for (const card of cards) setVisibility(card, 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush.mock.calls[0][0]).toHaveLength(25);

        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0]).toHaveLength(5);
    });

    /** Make every write wait until the test settles it, in the order the writes were made. */
    function deferWrites() {
        const pending: ((result: ChangelogReadFlushResult) => void)[] = [];
        flush.mockImplementation(
            () => new Promise<ChangelogReadFlushResult>((resolve) => pending.push(resolve)),
        );
        return async (index: number, result: ChangelogReadFlushResult) => {
            await act(async () => {
                pending[index](result);
                await vi.advanceTimersByTimeAsync(0);
            });
        };
    }

    it('FR-17: a batch due while a write is outstanding waits for it, then goes out at once', async () => {
        const settleWrite = deferWrites();
        const { result } = mount();
        const cards = makeCards(2);
        trackAll(result, cards);

        setVisibility(cards[0], 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(1);

        setVisibility(cards[1], 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS * 3);
        expect(flush, 'no second write while the first is outstanding').toHaveBeenCalledTimes(1);

        await settleWrite(0, { success: true, unreadCount: 5 });
        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0]).toEqual(['entry-1']);

        await settleWrite(1, { success: true, unreadCount: 4 });
        expect(onUnreadCount.mock.calls.map(([count]) => count)).toEqual([5, 4]);
    });

    it('unmount with more than 25 pending sends the batches one after another, so the last count wins', async () => {
        const settleWrite = deferWrites();
        const { result, unmount } = mount();
        const cards = makeCards(30);
        trackAll(result, cards);

        for (const card of cards) setVisibility(card, 1);
        await advance(READ_DWELL_MS);

        unmount();
        expect(flush, 'only one write outstanding at a time').toHaveBeenCalledTimes(1);
        expect(flush.mock.calls[0][0]).toHaveLength(25);

        await settleWrite(0, { success: true, unreadCount: 5 });
        expect(flush, 'the rest goes out without waiting for a window').toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0]).toHaveLength(5);

        await settleWrite(1, { success: true, unreadCount: 0 });
        expect(onUnreadCount.mock.calls.map(([count]) => count)).toEqual([5, 0]);
        expect(onUnreadCount).toHaveBeenLastCalledWith(0);
    });

    it('FR-48: a failed write is retried after it settles, never alongside a newer write', async () => {
        const settleWrite = deferWrites();
        const { result } = mount();
        const cards = makeCards(2);
        trackAll(result, cards);

        setVisibility(cards[0], 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);
        setVisibility(cards[1], 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(1);

        await settleWrite(0, { success: false });
        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0].sort()).toEqual(['entry-0', 'entry-1']);

        await advance(READ_BATCH_WINDOW_MS * 3);
        expect(flush).toHaveBeenCalledTimes(2);
        await settleWrite(1, { success: true, unreadCount: 0 });
        expect(onUnreadCount).toHaveBeenCalledTimes(1);
        expect(onUnreadCount).toHaveBeenCalledWith(0);
    });

    it('FR-18: an entry already marked is never written twice', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 1);
        await advance(READ_DWELL_MS);
        setVisibility(card, 0);
        setVisibility(card, 1);
        await advance(READ_DWELL_MS);
        act(() => result.current.markRead(['entry-0']));
        await advance(READ_BATCH_WINDOW_MS * 3);

        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('flushes pending read marks immediately on unmount', async () => {
        const { result, unmount } = mount();
        const cards = makeCards(2);
        trackAll(result, cards);

        setVisibility(cards[0], 1);
        setVisibility(cards[1], 1);
        await advance(READ_DWELL_MS);
        expect(flush).not.toHaveBeenCalled();

        unmount();
        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush.mock.calls[0][0].sort()).toEqual(['entry-0', 'entry-1']);
    });

    it('flushes pending read marks immediately when the tab is hidden', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 1);
        await advance(READ_DWELL_MS);

        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        visibility.mockRestore();

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith(['entry-0']);
    });

    it('FR-48: a failing write is retried twice, then dropped silently', async () => {
        flush.mockImplementation(async () => ({ success: false }));
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(1);

        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(2);
        await advance(READ_BATCH_WINDOW_MS);
        expect(flush).toHaveBeenCalledTimes(3);

        await advance(READ_BATCH_WINDOW_MS * 5);
        expect(flush).toHaveBeenCalledTimes(3);
        expect(onUnreadCount).not.toHaveBeenCalled();
    });

    it('FR-48: a rejected write counts as a failure and is retried, never thrown', async () => {
        flush.mockRejectedValueOnce(new Error('network')).mockResolvedValue({
            success: true,
            unreadCount: 2,
        });
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);

        setVisibility(card, 1);
        await advance(READ_DWELL_MS);
        await advance(READ_BATCH_WINDOW_MS);
        await advance(READ_BATCH_WINDOW_MS);

        expect(flush).toHaveBeenCalledTimes(2);
        expect(onUnreadCount).toHaveBeenCalledWith(2);
    });

    it('stops watching a card whose element is released', async () => {
        const { result } = mount();
        const [card] = makeCards(1);
        trackAll(result, [card]);
        expect(latestObserver().observed.has(card)).toBe(true);

        setVisibility(card, 1);
        act(() => result.current.track('entry-0', null));
        await advance(READ_DWELL_MS * 3);

        expect(latestObserver().observed.has(card)).toBe(false);
        expect(onRead).not.toHaveBeenCalled();
    });
});
