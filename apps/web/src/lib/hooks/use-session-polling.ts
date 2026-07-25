'use client';

import { useEffect, useRef } from 'react';
import type { AgentRunSession, ListRunSessionsQuery } from '@/lib/api/agents.shared';
import { listRunSessionsAction } from '@/app/actions/agents';

const POLL_INTERVAL_MS = 10_000;

/**
 * Run orchestration (Wave 4 M4) — Sessions-tab polling.
 *
 * Every 10s, and ONLY while at least one visible session is
 * queued/running, re-fetch the sessions list with the current filters
 * and hand the fresh rows to the caller. The interval tears down as
 * soon as nothing is active, so an idle fleet costs zero requests.
 * Poll failures are swallowed — the view keeps the last-known rows
 * until the next tick.
 *
 * Same setInterval-in-effect shape as `use-task-run-polling` (and the
 * older pollers it mirrors: NotificationDropdown, WorkActivity).
 */
export function useSessionPolling(
    sessions: AgentRunSession[],
    query: ListRunSessionsQuery,
    onFreshRows: (rows: AgentRunSession[]) => void,
): void {
    // Refs so a new inline callback/query object per render doesn't tear
    // the interval down and re-create it every 10s render.
    const onFreshRowsRef = useRef(onFreshRows);
    useEffect(() => {
        onFreshRowsRef.current = onFreshRows;
    }, [onFreshRows]);
    const queryRef = useRef(query);
    useEffect(() => {
        queryRef.current = query;
    }, [query]);

    const hasActiveRun = sessions.some((s) => s.status === 'queued' || s.status === 'running');

    useEffect(() => {
        if (!hasActiveRun) return;
        let cancelled = false;
        let inFlight = false;

        const tick = async () => {
            if (inFlight) return; // never stack slow polls
            inFlight = true;
            try {
                const result = await listRunSessionsAction(queryRef.current);
                if (!cancelled) onFreshRowsRef.current(result.data);
            } catch {
                // Poll is best-effort — keep last-known rows.
            } finally {
                inFlight = false;
            }
        };

        const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [hasActiveRun]);
}
