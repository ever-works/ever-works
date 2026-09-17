import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CONVERSATION_POLL_FALLBACK_MS,
    conversationStreamUrl,
    useConversationStream,
} from './use-conversation-stream';

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string, data: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent<string>);
        }
    }

    close() {
        this.closed = true;
    }
}

/**
 * Live delivery (FR-22, FR-23): new messages arrive through the stream; when
 * the stream is unavailable or drops, the panel polls every 30 s without
 * showing an error, and goes back to the stream as soon as it reopens.
 */
describe('useConversationStream', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.instances = [];
        vi.stubGlobal('EventSource', FakeEventSource);
        window.history.replaceState({}, '', '/org/ever/works');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it('opens the stream with the tab workspace and delivers its messages', () => {
        const onMessage = vi.fn();
        const onResync = vi.fn();
        renderHook(() => useConversationStream('c-1', { onMessage, onResync }));

        const source = FakeEventSource.instances[0];
        expect(source.url).toBe('/api/conversations/stream?conversationId=c-1&scope=org%3Aever');
        source.onopen?.();
        expect(onResync).toHaveBeenCalledTimes(1);

        source.emit('message', { type: 'message', conversationId: 'c-1', message: { id: 'm-1' } });
        source.emit('message', { type: 'message', conversationId: 'c-2', message: { id: 'm-2' } });
        source.emit('message', 'not an event');
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith({ id: 'm-1' });
    });

    it('degrades to a quiet 30 s poll when the stream drops, then returns to the stream', () => {
        const onResync = vi.fn();
        renderHook(() => useConversationStream('c-1', { onMessage: vi.fn(), onResync }));
        const first = FakeEventSource.instances[0];

        first.onerror?.();
        expect(first.closed).toBe(true);
        vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS);
        expect(onResync).toHaveBeenCalledTimes(1);

        // The tick also tried the stream again; once it opens, polling stops.
        const second = FakeEventSource.instances[1];
        expect(second).toBeDefined();
        second.onopen?.();
        const resyncs = onResync.mock.calls.length;
        vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 3);
        expect(onResync).toHaveBeenCalledTimes(resyncs);
    });

    it('polls when the browser has no EventSource at all', () => {
        vi.stubGlobal('EventSource', undefined);
        const onResync = vi.fn();
        renderHook(() => useConversationStream('c-1', { onMessage: vi.fn(), onResync }));
        vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 2);
        expect(onResync).toHaveBeenCalledTimes(2);
    });

    it('opens nothing before the Conversation exists, and closes everything on unmount', () => {
        const { rerender, unmount } = renderHook(
            ({ id }: { id: string | null }) =>
                useConversationStream(id, { onMessage: vi.fn(), onResync: vi.fn() }),
            { initialProps: { id: null as string | null } },
        );
        expect(FakeEventSource.instances).toHaveLength(0);
        rerender({ id: 'c-1' });
        expect(FakeEventSource.instances).toHaveLength(1);
        unmount();
        expect(FakeEventSource.instances[0].closed).toBe(true);
    });

    describe('while the docked panel is closed or collapsed', () => {
        type Props = { paused: boolean };

        function renderPausable(onResync = vi.fn(), initialProps: Props = { paused: false }) {
            const onMessage = vi.fn();
            const view = renderHook(
                ({ paused }: Props) =>
                    useConversationStream('c-1', { onMessage, onResync }, { paused }),
                { initialProps },
            );
            return { ...view, onMessage, onResync };
        }

        it('closes the stream on collapse and holds nothing open while collapsed', () => {
            const { rerender, onResync } = renderPausable();
            const live = FakeEventSource.instances[0];
            live.onopen?.();
            expect(onResync).toHaveBeenCalledTimes(1);

            rerender({ paused: true });
            expect(live.closed).toBe(true);

            // No reconnect attempts and no fallback re-reads while out of sight.
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 4);
            expect(FakeEventSource.instances).toHaveLength(1);
            expect(onResync).toHaveBeenCalledTimes(1);
        });

        it('stops the fallback poll on collapse when the stream had already dropped', () => {
            const { rerender, onResync } = renderPausable();
            FakeEventSource.instances[0].onerror?.();
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS);
            expect(onResync).toHaveBeenCalledTimes(1);
            const attempts = FakeEventSource.instances.length;

            rerender({ paused: true });
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 4);
            expect(onResync).toHaveBeenCalledTimes(1);
            expect(FakeEventSource.instances).toHaveLength(attempts);
            expect(FakeEventSource.instances.every((source) => source.closed)).toBe(true);
        });

        it('reopens the stream on reopen and catches up exactly once', () => {
            const { rerender, onResync, onMessage } = renderPausable();
            FakeEventSource.instances[0].onopen?.();
            rerender({ paused: true });
            onResync.mockClear();

            rerender({ paused: false });
            const resumed = FakeEventSource.instances[1];
            expect(resumed).toBeDefined();
            expect(resumed.closed).toBe(false);
            expect(resumed.url).toBe(
                '/api/conversations/stream?conversationId=c-1&scope=org%3Aever',
            );

            resumed.onopen?.();
            expect(onResync).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 3);
            expect(onResync).toHaveBeenCalledTimes(1);

            // Delivery is live again.
            resumed.emit('message', {
                type: 'message',
                conversationId: 'c-1',
                message: { id: 'm-9' },
            });
            expect(onMessage).toHaveBeenCalledWith({ id: 'm-9' });
        });

        it('still catches up once on reopen when the stream cannot come back', () => {
            const { rerender, onResync } = renderPausable();
            FakeEventSource.instances[0].onopen?.();
            rerender({ paused: true });
            onResync.mockClear();

            rerender({ paused: false });
            FakeEventSource.instances[1].onerror?.();
            expect(onResync).toHaveBeenCalledTimes(1);

            // Then the ordinary quiet poll, not a second immediate re-read.
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS - 1);
            expect(onResync).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1);
            expect(onResync).toHaveBeenCalledTimes(2);
        });

        it('pauses and resumes the poll when the browser has no EventSource', () => {
            vi.stubGlobal('EventSource', undefined);
            const { rerender, onResync } = renderPausable();
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS);
            expect(onResync).toHaveBeenCalledTimes(1);

            rerender({ paused: true });
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 3);
            expect(onResync).toHaveBeenCalledTimes(1);

            rerender({ paused: false });
            expect(onResync).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS);
            expect(onResync).toHaveBeenCalledTimes(3);
        });

        it('opens nothing for a panel that starts collapsed, and catches up once when it opens', () => {
            const { rerender, onResync } = renderPausable(vi.fn(), { paused: true });
            vi.advanceTimersByTime(CONVERSATION_POLL_FALLBACK_MS * 2);
            expect(FakeEventSource.instances).toHaveLength(0);
            expect(onResync).not.toHaveBeenCalled();

            rerender({ paused: false });
            expect(FakeEventSource.instances).toHaveLength(1);
            FakeEventSource.instances[0].onopen?.();
            expect(onResync).toHaveBeenCalledTimes(1);
        });

        it('does not treat a first stream failure as a resume', () => {
            const { onResync } = renderPausable();
            FakeEventSource.instances[0].onerror?.();
            expect(onResync).not.toHaveBeenCalled();
        });
    });

    it('leaves the scope carrier off a path that is not a workspace path', () => {
        expect(conversationStreamUrl('c-1', '/org/')).toBe(
            '/api/conversations/stream?conversationId=c-1',
        );
        expect(conversationStreamUrl('c-1', '/works')).toBe(
            '/api/conversations/stream?conversationId=c-1&scope=personal',
        );
    });
});
