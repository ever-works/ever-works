'use client';

import { useEffect, useRef } from 'react';
import type { AgentRunSessionDetail } from '@/lib/api/agents.shared';
import { getRunSessionDetailAction } from '@/app/actions/agents';

const POLL_INTERVAL_MS = 5_000;

/**
 * Session detail (Feature K) — live-follow poll for the drill-in page.
 *
 * Every 5s, and ONLY while the run is open (queued/running) or parked on
 * a human (awaitingInput), re-fetch the detail and hand it to the caller
 * together with the cursor the caller asked to follow from. The interval
 * tears down as soon as the run goes terminal, so a finished session
 * costs zero requests. Poll failures are swallowed — the view keeps the
 * last-known state until the next tick.
 *
 * Same setInterval-in-effect + refs shape as `use-session-polling`.
 */
export function useSessionDetailPolling(
    runId: string,
    isLive: boolean,
    getCursor: () => string | undefined,
    onFresh: (detail: AgentRunSessionDetail, afterCursor: string | undefined) => void,
): void {
    // Refs so new inline callbacks per render don't tear the interval
    // down and re-create it.
    const onFreshRef = useRef(onFresh);
    useEffect(() => {
        onFreshRef.current = onFresh;
    }, [onFresh]);
    const getCursorRef = useRef(getCursor);
    useEffect(() => {
        getCursorRef.current = getCursor;
    }, [getCursor]);

    useEffect(() => {
        if (!isLive) return;
        let cancelled = false;
        let inFlight = false;

        const tick = async () => {
            if (inFlight) return; // never stack slow polls
            inFlight = true;
            try {
                const cursor = getCursorRef.current();
                const detail = await getRunSessionDetailAction(runId, cursor ? { cursor } : {});
                if (!cancelled) onFreshRef.current(detail, cursor);
            } catch {
                // Poll is best-effort — keep last-known state.
            } finally {
                inFlight = false;
            }
        };

        const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [runId, isLive]);
}
