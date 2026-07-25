'use client';

import { useEffect, useRef } from 'react';
import type { Task } from '@/lib/api/tasks';
import { listTasksWithRunsAction } from '@/app/actions/tasks';

const POLL_INTERVAL_MS = 10_000;

/**
 * Kanban run cockpit (Wave 2) — lightweight run-chip polling.
 *
 * Every 10s, and ONLY while at least one visible task carries a
 * queued/running run, re-fetch the task list with the latest-run embed
 * and hand the fresh rows to the caller (which merges run data by task
 * id). The interval tears down as soon as no run is active, so an idle
 * board costs zero requests. Poll failures are swallowed — the board
 * simply keeps the last-known chips until the next tick.
 *
 * Same setInterval-in-effect shape as the existing pollers
 * (`NotificationDropdown`, `WorkActivity`).
 */
export function useTaskRunPolling(tasks: Task[], onFreshRows: (rows: Task[]) => void): void {
    // Keep the callback in a ref so a new inline function per render
    // doesn't tear the interval down and re-create it every 10s render.
    const onFreshRowsRef = useRef(onFreshRows);
    useEffect(() => {
        onFreshRowsRef.current = onFreshRows;
    }, [onFreshRows]);

    const hasActiveRun = tasks.some(
        (task) => task.run && (task.run.status === 'queued' || task.run.status === 'running'),
    );

    useEffect(() => {
        if (!hasActiveRun) return;
        let cancelled = false;
        let inFlight = false;

        const tick = async () => {
            if (inFlight) return; // never stack slow polls
            inFlight = true;
            try {
                const rows = await listTasksWithRunsAction();
                if (!cancelled) onFreshRowsRef.current(rows);
            } catch {
                // Poll is best-effort — keep last-known chips.
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
