'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetKillSwitchState } from '@/lib/api/fleet';
import { getFleetKillSwitchAction } from '@/app/actions/settings/fleet';

/** The API has no cadence field for this read; match the runner pill. */
export const KILL_SWITCH_POLL_INTERVAL_MS = 30_000;

export interface KillSwitchPollingResult {
    state: FleetKillSwitchState | null;
    /** True until the FIRST response settles — never during re-polls. */
    loading: boolean;
    /** Last poll failure, or null. The previous state keeps rendering. */
    error: string | null;
    /** Force an immediate re-read. */
    refresh: () => void;
}

/**
 * Panic controls (EW-778) — poll the platform-wide stop flag.
 *
 * Same shape as `use-runner-status-polling`, for the same reasons: it
 * polls unconditionally while mounted (an operator throwing the switch
 * is precisely the event the banner exists to show, and it is invisible
 * from the last payload), and a failed poll keeps the last-known state
 * rather than blanking it. The server-side page hands in the first
 * paint so the banner is correct before the first tick.
 */
export function useKillSwitchPolling(
    initialState: FleetKillSwitchState | null = null,
    initialError: string | null = null,
): KillSwitchPollingResult {
    const [state, setState] = useState<FleetKillSwitchState | null>(initialState);
    const [loading, setLoading] = useState(initialState === null && initialError === null);
    const [error, setError] = useState<string | null>(initialError);

    const inFlight = useRef(false);
    const cancelled = useRef(false);

    const tick = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const result = await getFleetKillSwitchAction();
            if (cancelled.current) return;
            if (result.success) {
                setState(result.data);
                setError(null);
            } else {
                setError(result.error);
            }
        } catch {
            if (!cancelled.current) setError('Failed to read the stop flag');
        } finally {
            inFlight.current = false;
            if (!cancelled.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        cancelled.current = false;
        void tick();
        const interval = setInterval(() => void tick(), KILL_SWITCH_POLL_INTERVAL_MS);
        return () => {
            cancelled.current = true;
            clearInterval(interval);
        };
    }, [tick]);

    const refresh = useCallback(() => {
        void tick();
    }, [tick]);

    return { state, loading, error, refresh };
}
