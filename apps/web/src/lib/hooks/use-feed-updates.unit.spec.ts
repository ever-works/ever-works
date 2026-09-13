import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
    createFeedPollTransport,
    useFeedUpdates,
    type FeedUpdateTransport,
} from './use-feed-updates';

describe('feed update transports', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function fakeDocument(hidden = false) {
        const listeners = new Set<() => void>();
        return {
            hidden,
            addEventListener: (_: string, listener: () => void) => listeners.add(listener),
            removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
            fire: () => listeners.forEach((listener) => listener()),
            listeners,
        };
    }

    it('notifies on every interval while visible and stops when unsubscribed', () => {
        const doc = fakeDocument();
        const notify = vi.fn();
        const unsubscribe = createFeedPollTransport(10_000, doc as unknown as Document)(notify);

        vi.advanceTimersByTime(30_000);
        expect(notify).toHaveBeenCalledTimes(3);

        unsubscribe();
        vi.advanceTimersByTime(30_000);
        expect(notify).toHaveBeenCalledTimes(3);
        expect(doc.listeners.size).toBe(0);
    });

    it('stays quiet while the page is hidden and catches up when it becomes visible', () => {
        const doc = fakeDocument(true);
        const notify = vi.fn();
        createFeedPollTransport(10_000, doc as unknown as Document)(notify);

        vi.advanceTimersByTime(30_000);
        expect(notify).not.toHaveBeenCalled();

        doc.hidden = false;
        doc.fire();
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('subscribes a replaceable transport only while enabled, with the latest callback', () => {
        let emit: (() => void) | null = null;
        const unsubscribe = vi.fn();
        const transport: FeedUpdateTransport = (notify) => {
            emit = notify;
            return unsubscribe;
        };
        const first = vi.fn();
        const second = vi.fn();

        const { rerender } = renderHook(
            ({ onUpdate, enabled }: { onUpdate: () => void; enabled: boolean }) =>
                useFeedUpdates(onUpdate, { enabled, transport }),
            { initialProps: { onUpdate: first, enabled: false } },
        );
        expect(emit).toBeNull();

        rerender({ onUpdate: first, enabled: true });
        rerender({ onUpdate: second, enabled: true });
        emit!();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        rerender({ onUpdate: second, enabled: false });
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
