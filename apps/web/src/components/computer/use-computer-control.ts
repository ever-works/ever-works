'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerControlDecision, ComputerControlStateView } from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import {
    COMPUTER_CONTROL_POLL_MS,
    describeControlRefusal,
    isControlStateView,
    serverClockOffsetMs,
    type ComputerControlRefusalView,
} from './computer-session.shared';

/**
 * Agent computers — control of the machine, as one live view holds it.
 *
 * The platform is the only authority on who holds control (a compare-and-set
 * on the machine's row), so this hook never decides anything: it reads the
 * control state through the BFF while the view is live — often enough that an
 * incoming request or an automatic give-back shows within a few seconds — and
 * sends the person's acts (take over, ask, hand over, keep, extend, give back),
 * adopting whatever state the platform answers with, a refusal included.
 *
 * `serverOffsetMs` lets countdowns run on the platform's clock rather than
 * trusting the viewer's.
 */

export interface ComputerControlTarget {
    agentId: string;
    /** The live view; null before it opened. */
    sessionId: string | null;
    /** Read and act only while the view is live. */
    enabled: boolean;
}

export interface ComputerControlDeps {
    fetchImpl?: typeof fetch;
    now?: () => number;
    pollMs?: number;
}

export interface ComputerControlApi {
    state: ComputerControlStateView | null;
    /** The last refusal, until the next successful act. */
    refusal: ComputerControlRefusalView | null;
    /** An act is on its way. */
    busy: boolean;
    serverOffsetMs: number;
    takeOver: () => Promise<void>;
    requestControl: () => Promise<void>;
    giveBack: () => Promise<void>;
    answer: (decision: ComputerControlDecision) => Promise<void>;
    keep: () => Promise<void>;
    extend: () => Promise<void>;
    /** Re-read now (e.g. when the relay said the mode changed). */
    refresh: () => void;
}

function json(body: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

export function useComputerControl(
    target: ComputerControlTarget,
    deps: ComputerControlDeps = {},
): ComputerControlApi {
    const { agentId, sessionId, enabled } = target;
    const [state, setState] = useState<ComputerControlStateView | null>(null);
    const [refusal, setRefusal] = useState<ComputerControlRefusalView | null>(null);
    const [busy, setBusy] = useState(false);
    const [serverOffsetMs, setServerOffsetMs] = useState(0);
    const [tick, setTick] = useState(0);
    const depsRef = useRef(deps);
    useEffect(() => {
        depsRef.current = deps;
    });
    /** Answers for a view that is no longer this one are dropped. */
    const viewRef = useRef<string | null>(null);

    const base = sessionId ? `/api/agents/${agentId}/computer/sessions/${sessionId}/control` : null;

    const adopt = useCallback((view: string, next: unknown) => {
        // Only a real control state is adopted — never an error body or an empty answer.
        if (viewRef.current !== view || !isControlStateView(next)) return;
        const now = depsRef.current.now ?? (() => Date.now());
        setState(next);
        setServerOffsetMs(serverClockOffsetMs(next, now()));
    }, []);

    useEffect(() => {
        viewRef.current = enabled ? sessionId : null;
        if (!enabled || !base || !sessionId) {
            setState(null);
            setRefusal(null);
            return;
        }
        let stopped = false;
        const view = sessionId;
        const read = async () => {
            try {
                const doFetch = depsRef.current.fetchImpl ?? browserApiFetch;
                const res = await doFetch(base, { method: 'GET' });
                if (stopped) return;
                if (res.ok) adopt(view, await res.json().catch(() => null));
            } catch {
                // The next read tries again; the view itself is unaffected.
            }
        };
        void read();
        const timer = setInterval(
            () => void read(),
            depsRef.current.pollMs ?? COMPUTER_CONTROL_POLL_MS,
        );
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [base, sessionId, enabled, tick, adopt]);

    const act = useCallback(
        async (path: string, init: RequestInit) => {
            const view = viewRef.current;
            if (!base || !view) return;
            const doFetch = depsRef.current.fetchImpl ?? browserApiFetch;
            setBusy(true);
            try {
                const res = await doFetch(`${base}${path}`, init);
                if (res.status === 204) {
                    setRefusal(null);
                    setTick((n) => n + 1);
                    return;
                }
                const body = await res.json().catch(() => null);
                if (res.ok) {
                    setRefusal(null);
                    adopt(view, body);
                    return;
                }
                const described = describeControlRefusal(res.status, body);
                if (viewRef.current === view) setRefusal(described);
                adopt(view, described.state);
            } catch {
                if (viewRef.current === view) setRefusal({ reason: 'failed', state: null });
            } finally {
                setBusy(false);
            }
        },
        [base, adopt],
    );

    const takeOver = useCallback(() => act('', json({})), [act]);
    const requestControl = useCallback(() => act('', json({ request: true })), [act]);
    const giveBack = useCallback(() => act('', { method: 'DELETE' }), [act]);
    const answer = useCallback(
        (decision: ComputerControlDecision) => {
            const requestId = state?.request?.requestId;
            return requestId ? act('/handover', json({ requestId, decision })) : Promise.resolve();
        },
        [act, state?.request?.requestId],
    );
    const keep = useCallback(() => act('/keep', { method: 'POST' }), [act]);
    const extend = useCallback(() => act('/extend', { method: 'POST' }), [act]);
    const refresh = useCallback(() => setTick((n) => n + 1), []);

    return {
        state,
        refusal,
        busy,
        serverOffsetMs,
        takeOver,
        requestControl,
        giveBack,
        answer,
        keep,
        extend,
        refresh,
    };
}
