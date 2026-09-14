'use client';

import { useEffect, useRef } from 'react';

/**
 * Live Feed — "something new may have been written" signals.
 *
 * The seam between the feed and HOW it learns about new activity. A
 * transport only ever calls `notify()`; the feed answers by re-reading its
 * newest page and merging what it has not seen, so every transport shares
 * the same dedupe and ordering rules. This is the same shape the inbox uses
 * (`useInboxStream`: a stream that nudges, with a timer as the fallback), so
 * a push transport can replace the timer below without touching the feed.
 */
export type FeedUpdateTransport = (notify: () => void) => () => void;

/** Default refresh cadence while no push transport is wired. */
export const FEED_REFRESH_INTERVAL_MS = 10_000;

/**
 * Timer transport: notifies every `intervalMs` while the page is visible,
 * and once immediately when a hidden page becomes visible again.
 */
export function createFeedPollTransport(
    intervalMs: number = FEED_REFRESH_INTERVAL_MS,
    doc:
        | Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
        | undefined = typeof document === 'undefined' ? undefined : document,
): FeedUpdateTransport {
    return (notify) => {
        const tick = () => {
            if (!doc?.hidden) notify();
        };
        const timer = setInterval(tick, intervalMs);
        const onVisibility = () => {
            if (!doc?.hidden) notify();
        };
        doc?.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearInterval(timer);
            doc?.removeEventListener('visibilitychange', onVisibility);
        };
    };
}

/**
 * Subscribe `onUpdate` to a transport while `enabled`. The latest callback is
 * always used without re-subscribing, so a re-render never restarts a timer
 * or reopens a connection.
 */
export function useFeedUpdates(
    onUpdate: () => void,
    options: { enabled: boolean; transport?: FeedUpdateTransport },
): void {
    const callbackRef = useRef(onUpdate);
    const transportRef = useRef<FeedUpdateTransport | undefined>(options.transport);
    useEffect(() => {
        callbackRef.current = onUpdate;
        transportRef.current = options.transport;
    });

    useEffect(() => {
        if (!options.enabled) return;
        const transport = transportRef.current ?? createFeedPollTransport();
        return transport(() => callbackRef.current());
    }, [options.enabled]);
}
