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

    it('leaves the scope carrier off a path that is not a workspace path', () => {
        expect(conversationStreamUrl('c-1', '/org/')).toBe(
            '/api/conversations/stream?conversationId=c-1',
        );
        expect(conversationStreamUrl('c-1', '/works')).toBe(
            '/api/conversations/stream?conversationId=c-1&scope=personal',
        );
    });
});
