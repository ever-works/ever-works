'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FleetGitIdentity } from '@ever-works/contracts';
import { getGitIdentityAction } from '@/app/actions/fleet-task-handoff';

/** A computer's git identity as a card or a line reads it: loading, the identity, or why it could not be read. */
export type GitIdentityState =
    | { kind: 'loading' }
    | { kind: 'ready'; identity: FleetGitIdentity }
    | { kind: 'error'; code: string | null; hint: string | null };

/**
 * Tasks on computers (FL-15 P2) — read one computer's git identity (the
 * platform keeps the machine's answer 60 s), re-read on demand (`refresh`,
 * which asks the machine again) and after a fix (`replace`).
 */
export function useGitIdentity(nodeId: string | null): {
    state: GitIdentityState;
    refresh: () => void;
    replace: (identity: FleetGitIdentity) => void;
} {
    const [state, setState] = useState<GitIdentityState>({ kind: 'loading' });

    const load = useCallback(
        async (fresh: boolean) => {
            if (!nodeId) return;
            setState({ kind: 'loading' });
            const result = await getGitIdentityAction(nodeId, fresh);
            setState(
                result.success
                    ? { kind: 'ready', identity: result.data }
                    : { kind: 'error', code: result.code, hint: result.hint },
            );
        },
        [nodeId],
    );

    useEffect(() => {
        void load(false);
    }, [load]);

    return {
        state,
        refresh: () => void load(true),
        replace: (identity) => setState({ kind: 'ready', identity }),
    };
}
