'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerControlDecision, ComputerControlStateView } from '@ever-works/contracts';
import {
    COMPUTER_CONTROL_POLL_MS,
    serverClockOffsetMs,
} from '../../computer/computer-session.shared';
import {
    desktopClient,
    type DesktopBrowserControlResult,
    type DesktopBrowserGrant,
    type DesktopResult,
} from './desktop.shared';

/**
 * Desktop view & control (FL-07 P2, FR-36, FR-42) — control of the computer as
 * the Desktop tab's view holds it.
 *
 * The platform (AW-11's arbiter: one compare-and-set on the machine's row) is
 * the only authority on who holds control, so this hook decides nothing: it
 * reads the state while the view is live, often enough that a request or an
 * automatic give-back shows within seconds, sends the person's acts, and hands
 * the tab any fresh grant an act answered (`driver` after a won take, `viewer`
 * after giving it back) so the tab re-attaches with it.
 */

export interface DesktopControlApi {
    state: ComputerControlStateView | null;
    /** The last refusal's hint, until the next successful act. */
    refusal: string | null;
    busy: boolean;
    serverOffsetMs: number;
    /** Take control — call only after the person confirmed it (the route needs `confirm: true`). */
    take: () => Promise<void>;
    request: () => Promise<void>;
    giveBack: () => Promise<void>;
    answer: (decision: ComputerControlDecision) => Promise<void>;
    keep: () => Promise<void>;
    extend: () => Promise<void>;
    refresh: () => void;
}

export function useDesktopControl(input: {
    nodeId: string;
    viewId: string | null;
    enabled: boolean;
    /** A grant an act answered: re-attach with it. */
    onGrant: (grant: DesktopBrowserGrant) => void;
}): DesktopControlApi {
    const { nodeId, viewId, enabled } = input;
    const [state, setState] = useState<ComputerControlStateView | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [serverOffsetMs, setServerOffsetMs] = useState(0);
    const [tick, setTick] = useState(0);
    const onGrantRef = useRef(input.onGrant);
    useEffect(() => {
        onGrantRef.current = input.onGrant;
    });

    const adopt = useCallback((next: ComputerControlStateView | null) => {
        if (!next) return;
        setState(next);
        setServerOffsetMs(serverClockOffsetMs(next, Date.now()));
    }, []);

    useEffect(() => {
        if (!enabled || !viewId) {
            setState(null);
            return;
        }
        let cancelled = false;
        const read = async () => {
            const result = await desktopClient.control(nodeId, viewId);
            if (cancelled) return;
            if (result.ok) adopt(result.data);
        };
        void read();
        const timer = setInterval(() => void read(), COMPUTER_CONTROL_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [adopt, enabled, nodeId, viewId, tick]);

    const act = useCallback(
        async (run: (id: string) => Promise<DesktopResult<DesktopBrowserControlResult>>) => {
            if (!viewId) return;
            setBusy(true);
            try {
                const result = await run(viewId);
                if (result.ok) {
                    setRefusal(null);
                    adopt(result.data.state);
                    if (result.data.attach) onGrantRef.current(result.data.attach);
                    return;
                }
                setRefusal(result.error.hint ?? null);
                const carried = result.error.details?.state;
                if (carried && typeof carried === 'object')
                    adopt(carried as ComputerControlStateView);
            } finally {
                setBusy(false);
            }
        },
        [adopt, viewId],
    );

    return {
        state,
        refusal,
        busy,
        serverOffsetMs,
        take: () => act((id) => desktopClient.takeControl(nodeId, id, { confirm: true })),
        request: () => act((id) => desktopClient.takeControl(nodeId, id, { request: true })),
        giveBack: () => act((id) => desktopClient.giveBack(nodeId, id)),
        answer: (decision) =>
            act((id) => {
                const requestId = state?.request?.requestId;
                if (!requestId) {
                    return Promise.resolve<DesktopResult<DesktopBrowserControlResult>>({
                        ok: false,
                        error: { code: 'invalid', hint: null, details: {}, status: 0 },
                    });
                }
                return desktopClient.answer(nodeId, id, { requestId, decision });
            }),
        keep: () => act((id) => desktopClient.keep(nodeId, id)),
        extend: () => act((id) => desktopClient.extend(nodeId, id)),
        refresh: () => setTick((value) => value + 1),
    };
}
