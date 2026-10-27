'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { appRuntimeOpsClient } from '@/lib/api/app-runtime-ops.client';
import type { AppStatusView } from '@/lib/api/app-runtime.types';

/** Plan §10.2 — every 3 s while a Deployment or a queued op runs, every 30 s otherwise. */
export const APP_STATUS_POLL_BUSY_MS = 3_000;
export const APP_STATUS_POLL_IDLE_MS = 30_000;

/** Deployment states after which nothing more happens on their own (`opStateOf` in the API). */
const SETTLED_DEPLOYMENT_STATES = new Set([
    'READY',
    'ERROR',
    'TIMEOUT',
    'ROLLED_BACK',
    'CANCELED',
    'SUPERSEDED',
]);

/** Whether the status shows something in flight: a Deployment, or an op the tab queued. */
export function isAppStatusBusy(status: AppStatusView | null | undefined): boolean {
    if (!status) return false;
    const deployment = status.currentDeployment;
    if (deployment && deployment.state && !SETTLED_DEPLOYMENT_STATES.has(deployment.state)) {
        return true;
    }
    return (status.requests ?? []).some(
        (request) => request.state === 'queued' || request.state === 'running',
    );
}

/**
 * Lane aw-ops (APW-06 T38) — the Deploy tab's status poll, through the `GET app-status` BFF
 * route. Starts from the server-rendered answer, re-reads every 3 s while anything is in flight
 * and every 30 s otherwise, pauses while the tab is hidden, and stops on unmount. `reload()`
 * re-reads at once (after an action) and restarts the cadence from there.
 *
 * A failed read keeps the last good status — the page never blanks on a transient error.
 */
export function useAppStatusPoll(
    workId: string,
    initial: AppStatusView | null,
    /** `false` ⇒ never poll (the status route is not on this API). Defaults to "an initial answer exists". */
    enabled: boolean = initial !== null,
) {
    const [status, setStatus] = useState<AppStatusView | null>(initial);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const alive = useRef(true);
    const statusRef = useRef<AppStatusView | null>(initial);

    const schedule = useCallback((delayMs: number, run: () => void) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(run, delayMs);
    }, []);

    const read = useCallback(async (): Promise<void> => {
        const result = await appRuntimeOpsClient.getStatus(workId);
        if (!alive.current) return;
        if (result.ok && result.data) {
            statusRef.current = result.data;
            setStatus(result.data);
        }
    }, [workId]);

    const tick = useCallback(async () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule(APP_STATUS_POLL_IDLE_MS, () => void tick());
            return;
        }
        await read();
        if (!alive.current) return;
        schedule(
            isAppStatusBusy(statusRef.current) ? APP_STATUS_POLL_BUSY_MS : APP_STATUS_POLL_IDLE_MS,
            () => void tick(),
        );
    }, [read, schedule]);

    useEffect(() => {
        alive.current = true;
        if (!enabled) {
            return () => {
                alive.current = false;
            };
        }
        schedule(
            isAppStatusBusy(statusRef.current) ? APP_STATUS_POLL_BUSY_MS : APP_STATUS_POLL_IDLE_MS,
            () => void tick(),
        );
        return () => {
            alive.current = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, [enabled, schedule, tick]);

    const reload = useCallback(async () => {
        if (!enabled) return;
        await read();
        if (!alive.current) return;
        schedule(
            isAppStatusBusy(statusRef.current) ? APP_STATUS_POLL_BUSY_MS : APP_STATUS_POLL_IDLE_MS,
            () => void tick(),
        );
    }, [enabled, read, schedule, tick]);

    return { status, reload };
}
