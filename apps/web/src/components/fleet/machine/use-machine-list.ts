'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetLinkError } from '@ever-works/contracts';
import type { MachineCallResult } from './use-machine-action';

/**
 * Machine actions (FL-09, FR-6, FR-9, FR-19) — one machine list read on an
 * interval while the tab is visible (Services every 30 s, Processes every
 * 5 s), at once after an act, and never in a hidden tab.
 *
 * The last good answer is KEPT when a later read is refused: under the kill
 * switch, or while the computer drops off for a moment, the list stays
 * readable with the reason shown above it ("last known"), instead of
 * blanking a table a person was reading.
 */
export function useMachineList<T>(load: () => Promise<MachineCallResult<T>>, intervalMs: number) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<FleetLinkError | null>(null);
    const [loading, setLoading] = useState(true);
    const [slow, setSlow] = useState(false);
    const loadRef = useRef(load);
    loadRef.current = load;
    const inFlight = useRef(false);

    const refresh = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const slowTimer = setTimeout(() => setSlow(true), 10_000);
        try {
            const result = await loadRef.current();
            if (result.ok) {
                setData(result.data);
                setError(null);
            } else {
                setError(result.error);
            }
        } catch {
            setError({ code: 'internal', hint: '' });
        } finally {
            clearTimeout(slowTimer);
            setSlow(false);
            setLoading(false);
            inFlight.current = false;
        }
    }, []);

    useEffect(() => {
        void refresh();
        const tick = () => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh();
        };
        const timer = setInterval(tick, intervalMs);
        const onVisible = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [intervalMs, refresh]);

    return { data, error, loading, slow, refresh };
}
