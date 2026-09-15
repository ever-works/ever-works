'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSearchKind, WorkspaceSearchResponse } from '@ever-works/contracts/api';
import { browserApiFetch } from '@/lib/api/browser-api';

export const WORKSPACE_SEARCH_DEBOUNCE_MS = 150;
export const WORKSPACE_SEARCH_TIMEOUT_MS = 3500;
export const WORKSPACE_SEARCH_THROTTLE_PAUSE_MS = 5000;
export const WORKSPACE_SEARCH_MIN_LENGTH = 2;

export type WorkspaceSearchStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'timeout'
    | 'error'
    | 'offline'
    | 'throttled';

export interface UseWorkspaceSearchOptions {
    query: string;
    /** Only search while the palette is open. */
    enabled: boolean;
    kinds?: WorkspaceSearchKind[];
    perKindLimit?: number;
    /** `${kind}:${sourceId}` keys opened recently (ranking boost). */
    recent?: string[];
    /**
     * Anything that changes which workspace the tab is in. A change discards
     * results and re-runs the query, because results never cross workspaces.
     */
    scopeKey?: string;
    debounceMs?: number;
    timeoutMs?: number;
    /** Test seam. */
    fetcher?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface UseWorkspaceSearchResult {
    status: WorkspaceSearchStatus;
    /** The last good response — kept on screen through a timeout, error or throttle. */
    response: WorkspaceSearchResponse | null;
    /** True when `response` belongs to an earlier query than the one on screen. */
    stale: boolean;
    /** Re-issue the current query immediately. */
    retry: () => void;
}

function isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Debounced, abortable workspace search for the command palette.
 *
 * - no request below two trimmed characters, and none while offline;
 * - one request in flight — a newer query aborts the older one, and a
 *   response for a superseded query is discarded;
 * - a request that has not answered within 3.5 s is aborted (status
 *   `timeout`), keeping the previous results visible;
 * - a 429 pauses requests for five seconds (status `throttled`);
 * - an `offline` query is re-issued when the browser comes back online.
 */
export function useWorkspaceSearch(options: UseWorkspaceSearchOptions): UseWorkspaceSearchResult {
    const {
        query,
        enabled,
        kinds,
        perKindLimit,
        recent,
        scopeKey,
        debounceMs = WORKSPACE_SEARCH_DEBOUNCE_MS,
        timeoutMs = WORKSPACE_SEARCH_TIMEOUT_MS,
        fetcher = browserApiFetch as (input: string, init: RequestInit) => Promise<Response>,
    } = options;

    const [status, setStatus] = useState<WorkspaceSearchStatus>('idle');
    const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null);
    const [attempt, setAttempt] = useState(0);
    const requestIdRef = useRef(0);
    const controllerRef = useRef<AbortController | null>(null);
    const throttledUntilRef = useRef(0);
    const fetcherRef = useRef(fetcher);
    useEffect(() => {
        fetcherRef.current = fetcher;
    });

    const trimmed = query.trim();
    const kindsKey = (kinds ?? []).join(',');
    const recentKey = (recent ?? []).join(',');

    // A workspace change invalidates everything on screen.
    useEffect(() => {
        setResponse(null);
    }, [scopeKey]);

    useEffect(() => {
        if (!enabled || trimmed.length < WORKSPACE_SEARCH_MIN_LENGTH) {
            controllerRef.current?.abort();
            requestIdRef.current += 1;
            setStatus('idle');
            if (!enabled) setResponse(null);
            return undefined;
        }
        if (isOffline()) {
            controllerRef.current?.abort();
            requestIdRef.current += 1;
            setStatus('offline');
            return undefined;
        }

        const requestId = ++requestIdRef.current;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const waitMs = Math.max(debounceMs, throttledUntilRef.current - Date.now());
        setStatus((current) =>
            current === 'throttled' && waitMs > debounceMs ? current : 'loading',
        );

        const debounce = setTimeout(() => {
            controllerRef.current?.abort();
            const controller = new AbortController();
            controllerRef.current = controller;
            let timedOut = false;
            timeout = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs);

            const params = new URLSearchParams({ q: trimmed });
            for (const kind of kindsKey ? kindsKey.split(',') : []) params.append('kinds', kind);
            if (perKindLimit) params.set('perKindLimit', String(perKindLimit));
            for (const key of recentKey ? recentKey.split(',') : []) params.append('recent', key);

            fetcherRef
                .current(`/api/workspace-search?${params.toString()}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                    credentials: 'include',
                })
                .then(async (res) => {
                    if (requestId !== requestIdRef.current) return;
                    if (res.status === 429) {
                        throttledUntilRef.current = Date.now() + WORKSPACE_SEARCH_THROTTLE_PAUSE_MS;
                        setStatus('throttled');
                        return;
                    }
                    if (!res.ok) {
                        setStatus('error');
                        return;
                    }
                    const body = (await res.json()) as WorkspaceSearchResponse;
                    if (requestId !== requestIdRef.current) return;
                    setResponse({
                        ...body,
                        groups: Array.isArray(body.groups) ? body.groups : [],
                        degradedKinds: Array.isArray(body.degradedKinds) ? body.degradedKinds : [],
                    });
                    setStatus('ready');
                })
                .catch(() => {
                    if (requestId !== requestIdRef.current) return;
                    if (timedOut) {
                        setStatus('timeout');
                    } else if (!controller.signal.aborted) {
                        setStatus(isOffline() ? 'offline' : 'error');
                    }
                })
                .finally(() => {
                    if (timeout) clearTimeout(timeout);
                });
        }, waitMs);

        return () => {
            clearTimeout(debounce);
        };
    }, [
        enabled,
        trimmed,
        kindsKey,
        perKindLimit,
        recentKey,
        scopeKey,
        debounceMs,
        timeoutMs,
        attempt,
    ]);

    // Abort anything still in flight on unmount.
    useEffect(() => () => controllerRef.current?.abort(), []);

    // Coming back online re-issues the query that went offline; nothing else
    // would, because the query on screen has not changed.
    const statusRef = useRef(status);
    useEffect(() => {
        statusRef.current = status;
    }, [status]);
    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onOnline = () => {
            if (statusRef.current === 'offline') setAttempt((value) => value + 1);
        };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, []);

    const retry = useCallback(() => setAttempt((value) => value + 1), []);

    const stale = response !== null && response.query !== trimmed.slice(0, 128);

    return { status, response, stale, retry };
}
