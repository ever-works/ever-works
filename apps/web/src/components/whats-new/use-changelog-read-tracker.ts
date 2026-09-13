'use client';

import { useEffect, useState } from 'react';
import { CHANGELOG_LIMITS } from '@ever-works/contracts/api';

/** Spec FR-16 — share of a card that must be visible. */
export const READ_VISIBILITY_THRESHOLD = 0.5;
/** Spec FR-16 — continuous visibility before an entry counts as read. */
export const READ_DWELL_MS = 1000;
/** Spec FR-17 — at most one write per window. */
export const READ_BATCH_WINDOW_MS = 2000;
/** Spec FR-48 — a failed write is retried this many times, then dropped. */
export const READ_MAX_RETRIES = 2;

export interface ChangelogReadFlushResult {
    success: boolean;
    unreadCount?: number;
}

export interface ChangelogReadTrackerOptions {
    /** Persist a batch of at most 25 slugs. Should resolve with a result rather than reject. */
    flush: (slugs: string[]) => Promise<ChangelogReadFlushResult>;
    /** Called as soon as entries count as read, so their cards can drop the unread dot. */
    onRead?: (slugs: string[]) => void;
    /** Called with the server's fresh unread count after a successful write. */
    onUnreadCount?: (count: number) => void;
}

export interface ChangelogReadTracker {
    /**
     * Start watching `element` for the entry `slug`, or stop watching it when
     * `element` is `null`. Register only UNREAD entries. Stable across renders.
     */
    track: (slug: string, element: Element | null) => void;
    /** Mark entries read right away (an explicit open or a followed call-to-action). */
    markRead: (slugs: string[]) => void;
}

interface PendingSlug {
    slug: string;
    attempts: number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The tracker's state machine, created once per mounted panel. Kept outside
 * React state on purpose: none of it is rendered, and a re-render must never
 * restart a dwell clock or drop a pending batch.
 */
function createReadTrackerEngine(initialOptions: ChangelogReadTrackerOptions) {
    let options = initialOptions;
    const getOptions = () => options;
    let observer: IntersectionObserver | null = null;
    let batchTimer: Timer | null = null;
    let active = false;
    const elementsBySlug = new Map<string, Element>();
    const slugsByElement = new Map<Element, string>();
    const dwellTimers = new Map<string, Timer>();
    /** Slugs already counted as read in this mount — never queued twice. */
    const marked = new Set<string>();
    const queue: PendingSlug[] = [];

    const stopDwell = (slug: string) => {
        const timer = dwellTimers.get(slug);
        if (timer !== undefined) {
            clearTimeout(timer);
            dwellTimers.delete(slug);
        }
    };

    const send = (batch: PendingSlug[]) => {
        if (batch.length === 0) {
            return;
        }
        const retry = () => {
            const again = batch
                .filter((item) => item.attempts < READ_MAX_RETRIES)
                .map((item) => ({ slug: item.slug, attempts: item.attempts + 1 }));
            if (again.length === 0) {
                // Dropped silently (spec FR-48): the entry re-marks next time it is seen.
                return;
            }
            if (!active) {
                // The panel is gone, so there is no window to wait for; retry
                // now, still bounded by the attempt count.
                send(again);
                return;
            }
            queue.push(...again);
            schedule();
        };
        let request: Promise<ChangelogReadFlushResult>;
        try {
            request = getOptions().flush(batch.map((item) => item.slug));
        } catch {
            retry();
            return;
        }
        void Promise.resolve(request)
            .then((result) => {
                if (!result?.success) {
                    retry();
                    return;
                }
                if (typeof result.unreadCount === 'number') {
                    getOptions().onUnreadCount?.(result.unreadCount);
                }
            })
            .catch(retry);
    };

    /** Send one window's worth (at most 25) and schedule the rest. */
    const drainWindow = () => {
        batchTimer = null;
        send(queue.splice(0, CHANGELOG_LIMITS.markReadBatchMax));
        schedule();
    };

    function schedule() {
        if (batchTimer !== null || queue.length === 0) {
            return;
        }
        batchTimer = setTimeout(drainWindow, READ_BATCH_WINDOW_MS);
    }

    /** Send everything pending now, 25 at a time — on unmount and on tab hide. */
    const flushAll = () => {
        if (batchTimer !== null) {
            clearTimeout(batchTimer);
            batchTimer = null;
        }
        while (queue.length > 0) {
            send(queue.splice(0, CHANGELOG_LIMITS.markReadBatchMax));
        }
    };

    const markRead = (slugs: string[]) => {
        const fresh = [...new Set(slugs)].filter((slug) => !marked.has(slug));
        if (fresh.length === 0) {
            return;
        }
        for (const slug of fresh) {
            marked.add(slug);
            stopDwell(slug);
            queue.push({ slug, attempts: 0 });
        }
        getOptions().onRead?.(fresh);
        schedule();
    };

    const onIntersections = (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
            const slug = slugsByElement.get(entry.target);
            if (!slug || marked.has(slug)) {
                continue;
            }
            const visible =
                entry.isIntersecting && entry.intersectionRatio >= READ_VISIBILITY_THRESHOLD;
            if (!visible) {
                stopDwell(slug);
            } else if (!dwellTimers.has(slug)) {
                dwellTimers.set(
                    slug,
                    setTimeout(() => {
                        dwellTimers.delete(slug);
                        markRead([slug]);
                    }, READ_DWELL_MS),
                );
            }
        }
    };

    const track = (slug: string, element: Element | null) => {
        const previous = elementsBySlug.get(slug);
        if (previous === element) {
            return;
        }
        if (previous) {
            observer?.unobserve(previous);
            slugsByElement.delete(previous);
            elementsBySlug.delete(slug);
            stopDwell(slug);
        }
        if (!element) {
            return;
        }
        elementsBySlug.set(slug, element);
        slugsByElement.set(element, slug);
        observer?.observe(element);
    };

    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            flushAll();
        }
    };

    const start = () => {
        active = true;
        if (typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function') {
            observer = new window.IntersectionObserver(onIntersections, {
                threshold: [0, READ_VISIBILITY_THRESHOLD, 1],
            });
            for (const element of slugsByElement.keys()) {
                observer.observe(element);
            }
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
    };

    const stop = () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        observer?.disconnect();
        observer = null;
        for (const timer of dwellTimers.values()) {
            clearTimeout(timer);
        }
        dwellTimers.clear();
        active = false;
        flushAll();
    };

    /** Swap in the latest callbacks without restarting any clock or batch. */
    const setOptions = (next: ChangelogReadTrackerOptions) => {
        options = next;
    };

    return { track, markRead, start, stop, setOptions };
}

/**
 * What's new (AW-14) — records entries as read as the reader scrolls past
 * them.
 *
 * - An entry is read once at least half of its card has been continuously
 *   visible for 1000 ms (spec FR-16). Scrolling away earlier resets the
 *   clock.
 * - Read marks are batched: at most one write every 2000 ms, carrying at
 *   most 25 slugs (spec FR-17). Anything left over goes in the next window.
 * - Pending marks are flushed immediately when the panel unmounts and when
 *   the tab is hidden, so closing the panel never loses a read.
 * - A failed write is retried at most twice, then dropped silently. Nothing
 *   is ever surfaced to the reader (spec FR-48).
 *
 * No interval is created: every timer is a one-shot tied to an entry or to
 * a pending batch (spec FR-31).
 */
export function useChangelogReadTracker(
    options: ChangelogReadTrackerOptions,
): ChangelogReadTracker {
    const [engine] = useState(() => createReadTrackerEngine(options));

    useEffect(() => {
        engine.setOptions(options);
    });

    useEffect(() => {
        engine.start();
        return () => engine.stop();
    }, [engine]);

    return { track: engine.track, markRead: engine.markRead };
}
