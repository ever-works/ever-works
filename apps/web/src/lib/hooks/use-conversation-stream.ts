'use client';

import { useEffect, useRef } from 'react';
import type { ConversationMessageView, ConversationStreamEvent } from '@ever-works/contracts';
import { parseWorkspacePath, withWorkspaceScopeQuery } from '@/lib/workspace-scope';

/** How often the panel re-reads the Conversation when live delivery is unavailable (FR-23). */
export const CONVERSATION_POLL_FALLBACK_MS = 30_000;

export interface ConversationStreamHandlers {
    /** A message the stream pushed: new, or one whose send status changed. */
    onMessage: (message: ConversationMessageView) => void;
    /**
     * Re-read the Conversation. Called on the 30 s fallback timer, and once
     * whenever the stream (re)opens — the stream announces only what changes
     * after it opened, so anything that landed while it was down is fetched.
     */
    onResync: () => void;
}

export interface ConversationStreamOptions {
    /**
     * Hold live delivery while the Conversation is out of sight — the docked
     * panel closed or collapsed, where it stays mounted to keep its state.
     * The stream is closed and the fallback poll stops; un-pausing opens the
     * stream again and catches up once on whatever landed in between.
     */
    paused?: boolean;
}

/** The same-origin stream URL for a Conversation, carrying the tab's workspace selector. */
export function conversationStreamUrl(conversationId: string, pathname: string): string {
    const href = `/api/conversations/stream?conversationId=${encodeURIComponent(conversationId)}`;
    try {
        return withWorkspaceScopeQuery(href, parseWorkspacePath(pathname));
    } catch {
        // A path that is not a workspace path at all: leave the carrier off,
        // which is personal — the same answer a link with no selector gets.
        return href;
    }
}

/**
 * Live delivery for the open Conversation (FR-22, FR-23), modelled on
 * `use-inbox-stream.ts`: an `EventSource` on the BFF stream, and a quiet
 * 30-second poll whenever that is unavailable or drops. The downgrade never
 * shows an error.
 *
 * Unlike the inbox hook, a dropped stream is not given up for good: the API
 * closes every stream after ten minutes by design, so each fallback tick also
 * tries to reopen it, and polling stops as soon as it is back.
 *
 * While `paused`, nothing is held open: no stream and no poll timer. Resuming
 * the same Conversation re-reads it exactly once, whether the stream comes
 * back, fails to, or the browser has no `EventSource` at all.
 */
export function useConversationStream(
    conversationId: string | null,
    handlers: ConversationStreamHandlers,
    options: ConversationStreamOptions = {},
): void {
    const paused = options.paused === true;
    const handlersRef = useRef(handlers);
    useEffect(() => {
        handlersRef.current = handlers;
    });

    // The Conversation whose delivery was paused, so un-pausing it (and only
    // it) is told apart from opening a Conversation for the first time.
    const pausedFor = useRef<string | null>(null);

    useEffect(() => {
        if (!conversationId) return;
        const streamId = conversationId;
        if (paused) {
            // The previous run's cleanup already closed the stream and the poll.
            pausedFor.current = streamId;
            return;
        }
        const resumed = pausedFor.current === streamId;
        pausedFor.current = null;

        let disposed = false;
        // One re-read owed after a resume, paid by whichever comes first: the
        // stream opening, or the stream failing and the poll taking over.
        let catchUpOwed = resumed;
        let source: EventSource | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        function stopPolling() {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
        }

        function catchUpOnce() {
            if (!catchUpOwed) return;
            catchUpOwed = false;
            handlersRef.current.onResync();
        }

        function startPolling() {
            if (pollTimer || disposed) return;
            pollTimer = setInterval(() => {
                handlersRef.current.onResync();
                open();
            }, CONVERSATION_POLL_FALLBACK_MS);
        }

        function open() {
            if (disposed || source || typeof EventSource === 'undefined') return;
            try {
                const next = new EventSource(
                    conversationStreamUrl(streamId, window.location.pathname),
                );
                source = next;
                next.onopen = () => {
                    stopPolling();
                    catchUpOwed = false;
                    handlersRef.current.onResync();
                };
                next.addEventListener('message', (event: MessageEvent<string>) => {
                    const parsed = parseStreamEvent(event.data);
                    if (parsed && parsed.conversationId === streamId) {
                        handlersRef.current.onMessage(parsed.message);
                    }
                });
                next.onerror = () => {
                    // Dropped, refused or closed by the server's lifetime cap:
                    // close it (no browser auto-retry storm) and poll instead.
                    next.close();
                    if (source === next) source = null;
                    catchUpOnce();
                    startPolling();
                };
            } catch {
                source = null;
                catchUpOnce();
                startPolling();
            }
        }

        if (typeof EventSource === 'undefined') {
            catchUpOnce();
            startPolling();
        } else {
            open();
        }

        return () => {
            disposed = true;
            source?.close();
            source = null;
            stopPolling();
        };
    }, [conversationId, paused]);
}

function parseStreamEvent(data: string): ConversationStreamEvent | null {
    try {
        const parsed = JSON.parse(data) as Partial<ConversationStreamEvent>;
        if (parsed?.type !== 'message' || !parsed.message || !parsed.conversationId) return null;
        return parsed as ConversationStreamEvent;
    } catch {
        return null;
    }
}
