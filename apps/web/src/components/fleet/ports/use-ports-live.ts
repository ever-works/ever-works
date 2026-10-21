'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FLEET_PORT_LIST_REFRESH_MS, FLEET_PORT_WATCH_MAX, type FleetPortsListResponse } from '@ever-works/contracts';
import { portsClient, type PortsErrorRead } from './ports.shared';

/**
 * Servers and ports (FL-10, FR-5, FR-6) — the Ports tab's live list: read
 * every 5 s while the tab is VISIBLE (a hidden browser tab stops asking the
 * machine), at once when it becomes visible again, and after every change to
 * the watched ports of "Open a port…".
 *
 * On a refusal the last list is KEPT (spec FR-18: under the kill switch the
 * list stays as last known, with the stop banner) and the error is reported
 * beside it; `slow` turns on when the first answer takes longer than 10 s
 * ("build-01 has not answered yet").
 */
export function usePortsLive(nodeId: string, enabled = true) {
    const [list, setList] = useState<FleetPortsListResponse | null>(null);
    const [error, setError] = useState<PortsErrorRead | null>(null);
    const [loading, setLoading] = useState(true);
    const [slow, setSlow] = useState(false);
    const [watch, setWatch] = useState<number[]>([]);
    const inFlight = useRef(false);
    const watchRef = useRef<number[]>(watch);
    watchRef.current = watch;

    const reload = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const result = await portsClient.list(nodeId, watchRef.current);
            if (result.ok) {
                setList(result.data);
                setError(null);
            } else {
                setError(result.error);
            }
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }, [nodeId]);

    useEffect(() => {
        if (!enabled) return;
        const slowTimer = setTimeout(() => setSlow(true), 10_000);
        void reload().finally(() => clearTimeout(slowTimer));
        const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
        const timer = setInterval(() => {
            if (visible()) void reload();
        }, FLEET_PORT_LIST_REFRESH_MS);
        const onVisibility = () => {
            if (visible()) void reload();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearTimeout(slowTimer);
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [enabled, reload]);

    const addWatch = useCallback(
        (port: number) => {
            setWatch((current) => {
                const next =
                    current.includes(port) || current.length >= FLEET_PORT_WATCH_MAX ? current : [...current, port];
                watchRef.current = next;
                return next;
            });
            // Read now, with the new watch list, rather than in up to 5 s.
            setTimeout(() => void reload(), 0);
        },
        [reload],
    );
    const removeWatch = useCallback((port: number) => {
        setWatch((current) => {
            const next = current.filter((value) => value !== port);
            watchRef.current = next;
            return next;
        });
    }, []);

    return { list, error, loading, slow, watch, addWatch, removeWatch, reload };
}
