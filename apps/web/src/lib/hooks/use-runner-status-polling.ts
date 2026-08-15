'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetRunnerStatusView } from '@/lib/api/fleet';
import { getFleetRunnerStatusAction } from '@/app/actions/settings/fleet';

/** Fallback cadence used until the first payload advertises its own. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface RunnerStatusPollingResult {
    status: FleetRunnerStatusView | null;
    /** True until the FIRST response settles — never during re-polls. */
    loading: boolean;
    /** Last poll failure, or null. The previous status keeps rendering. */
    error: string | null;
    /** Force an immediate re-read (the popover's "refresh now"). */
    refresh: () => void;
}

/**
 * Runner status polling for the sidebar pill.
 *
 * Same `setInterval`-in-effect shape as `use-session-polling` and
 * `use-task-run-polling`, with three differences that matter here:
 *
 *   1. **The SERVER owns the cadence.** The interval comes from
 *      `refreshIntervalSec` in the payload, not from a constant in this
 *      file, so the "Refreshes every 30s" caption cannot drift from the
 *      real behaviour and an operator can slow every client at once if
 *      this read ever becomes expensive.
 *   2. **It polls unconditionally while mounted**, unlike the sessions
 *      poller which stops when nothing is active. A runner going offline
 *      is precisely the event the pill exists to show, and it is
 *      invisible from the last payload — "nothing is happening" is not a
 *      reason to stop looking.
 *   3. **A failed poll keeps the last-known status** and surfaces the
 *      error separately. Blanking the pill on one bad request would make
 *      a momentary network blip look like the runner disappeared.
 */
export function useRunnerStatusPolling(
    initialStatus: FleetRunnerStatusView | null = null,
): RunnerStatusPollingResult {
    const [status, setStatus] = useState<FleetRunnerStatusView | null>(initialStatus);
    const [loading, setLoading] = useState(initialStatus === null);
    const [error, setError] = useState<string | null>(null);

    // Ref so a slow poll cannot stack behind another one, and so the
    // effect below does not need it as a dependency.
    const inFlight = useRef(false);
    const cancelled = useRef(false);

    const tick = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const result = await getFleetRunnerStatusAction();
            if (cancelled.current) return;
            if (result.success) {
                setStatus(result.data);
                setError(null);
            } else {
                setError(result.error);
            }
        } catch {
            if (!cancelled.current) setError('Failed to load runner status');
        } finally {
            inFlight.current = false;
            if (!cancelled.current) setLoading(false);
        }
    }, []);

    const intervalMs =
        typeof status?.refreshIntervalSec === 'number' && status.refreshIntervalSec > 0
            ? status.refreshIntervalSec * 1000
            : DEFAULT_POLL_INTERVAL_MS;

    useEffect(() => {
        cancelled.current = false;
        // Read once on mount so the pill is correct before the first
        // interval elapses — a 30s blank on every page load would make
        // the indicator useless for the most common visit.
        void tick();
        const interval = setInterval(() => void tick(), intervalMs);
        return () => {
            cancelled.current = true;
            clearInterval(interval);
        };
    }, [tick, intervalMs]);

    const refresh = useCallback(() => {
        void tick();
    }, [tick]);

    return { status, loading, error, refresh };
}
