'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResolvedMergePolicy } from '@ever-works/contracts';
import { isResolvedMergePolicy } from '@/lib/merge-policy';

export interface UseMergePolicyResult {
    resolution: ResolvedMergePolicy | null;
    isLoading: boolean;
    error: string | null;
    /** Re-fetch after a write, so the chain reflects the new owner. */
    refresh: () => void;
}

/**
 * Merge-policy matrix (Wave 3, D4) — read the EFFECTIVE policy plus its
 * resolution chain for a Work and/or an Agent.
 *
 * Wraps `GET /api/merge-policy/resolve` (proxied at
 * `app/api/merge-policy/resolve/route.ts`). Both ids are optional but at
 * least one is required by the endpoint, so the hook stays idle rather
 * than firing a call it knows will 400.
 *
 * Deliberately plain `useState` + `fetch` rather than SWR: this is a
 * settings card that re-reads after its own writes, so a shared cache
 * would be a source of staleness rather than a saving. An in-flight
 * generation counter drops responses from superseded requests, which is
 * what makes "save then refresh" safe to click twice.
 */
export function useMergePolicy(params: {
    workId?: string | null;
    agentId?: string | null;
    organizationId?: string | null;
}): UseMergePolicyResult {
    const { workId, agentId, organizationId } = params;
    const [resolution, setResolution] = useState<ResolvedMergePolicy | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    const generation = useRef(0);

    const refresh = useCallback(() => setNonce((n) => n + 1), []);

    useEffect(() => {
        if (!workId && !agentId && !organizationId) {
            setResolution(null);
            setIsLoading(false);
            setError(null);
            return;
        }
        const current = ++generation.current;
        const search = new URLSearchParams();
        if (workId) search.set('workId', workId);
        if (agentId) search.set('agentId', agentId);
        if (organizationId) search.set('organizationId', organizationId);

        setIsLoading(true);
        setError(null);
        void (async () => {
            try {
                // eslint-disable-next-line no-restricted-syntax -- EW-790 baseline: unaudited, may be a real scope bug
                const response = await fetch(`/api/merge-policy/resolve?${search.toString()}`, {
                    credentials: 'include',
                    cache: 'no-store',
                });
                if (generation.current !== current) return;
                if (!response.ok) {
                    setError('Could not load the effective merge policy.');
                    setResolution(null);
                    return;
                }
                const json: unknown = await response.json();
                if (generation.current !== current) return;
                if (!isResolvedMergePolicy(json)) {
                    setError('Could not load the effective merge policy.');
                    setResolution(null);
                    return;
                }
                setResolution(json);
            } catch {
                if (generation.current !== current) return;
                setError('Could not load the effective merge policy.');
                setResolution(null);
            } finally {
                if (generation.current === current) setIsLoading(false);
            }
        })();
    }, [workId, agentId, organizationId, nonce]);

    return { resolution, isLoading, error, refresh };
}
