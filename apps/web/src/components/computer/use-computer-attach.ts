'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    decodeComputerFrame,
    type ComputerChannel,
    type ComputerCloseReason,
    type ComputerQuality,
    type ComputerScreenFrame,
    type ComputerStatsFrame,
    type TerminalFrame,
} from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { describeOpenRefusal, type ComputerOpenRefusal } from './computer-session.shared';

/**
 * Agent computers — the live-view hook, the terminal attach hook's sibling
 * (`components/terminal/use-terminal-attach.ts`).
 *
 * One flow, every step through a BFF route so no API origin or token lives
 * in client code before the socket opens:
 *
 *   open the session (POST …/sessions)  →  refusal? stop, say why
 *   mint the attach token (POST …/attach-token, the BFF builds the socket URL)
 *   open the socket  →  FIRST message is the auth frame, never a URL
 *   frames flow: pictures to the stage, terminal frames to the renderer,
 *   stats to the strip, banners to the page, `end` pins why it stopped.
 *
 * States are visibly distinct: `opening` (asking for a view), `connecting`
 * (socket up, no picture yet), `live`, `ended` (with the platform's reason),
 * `refused` (a named refusal from the platform), `cannot-connect`.
 *
 * Every seam (fetch, WebSocket, clock) is injectable for jsdom tests.
 */

export type ComputerAttachState =
    | 'idle'
    | 'opening'
    | 'connecting'
    | 'live'
    | 'ended'
    | 'refused'
    | 'cannot-connect';

export interface ComputerAttachCallbacks {
    onPicture: (frame: ComputerScreenFrame) => void;
    onTerminal?: (frame: TerminalFrame) => void;
}

export interface ComputerAttachDeps {
    fetchImpl?: typeof fetch;
    webSocketImpl?: typeof WebSocket;
    now?: () => number;
}

export interface ComputerAttachTarget {
    agentId: string;
    nodeId: string | null;
    channel: ComputerChannel | null;
    quality: ComputerQuality;
    /** False renders nothing and opens nothing (a pre-open state is on screen). */
    enabled: boolean;
}

export interface ComputerAttachApi {
    state: ComputerAttachState;
    sessionId: string | null;
    refusal: ComputerOpenRefusal | null;
    endReason: ComputerCloseReason | null;
    stats: ComputerStatsFrame | null;
    /** Epoch ms of the last stats frame (the machine's clock is stale without them). */
    lastStatsAt: number | null;
    /** Epoch ms of the last picture or terminal output. */
    lastFrameAt: number | null;
    /** When this view started opening (for the "has not answered yet" line). */
    openedAt: number | null;
    /** Banners the machine or the platform published (newest last, capped). */
    banners: string[];
    refresh: () => void;
    setQuality: (quality: ComputerQuality) => void;
    /** End the view on the platform (the owner's "End session"). */
    endSession: () => void;
    /** Open a fresh view (Reconnect / Try again). */
    reconnect: () => void;
}

const MAX_BANNERS = 5;

export function useComputerAttach(
    target: ComputerAttachTarget,
    callbacks: ComputerAttachCallbacks,
    deps: ComputerAttachDeps = {},
): ComputerAttachApi {
    const [state, setState] = useState<ComputerAttachState>('idle');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<ComputerOpenRefusal | null>(null);
    const [endReason, setEndReason] = useState<ComputerCloseReason | null>(null);
    const [stats, setStats] = useState<ComputerStatsFrame | null>(null);
    const [lastStatsAt, setLastStatsAt] = useState<number | null>(null);
    const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
    const [openedAt, setOpenedAt] = useState<number | null>(null);
    const [banners, setBanners] = useState<string[]>([]);
    const [nonce, setNonce] = useState(0);
    const callbacksRef = useRef(callbacks);
    const sessionRef = useRef<string | null>(null);
    const depsRef = useRef(deps);
    // Synced after render, never during it. Declared before the session
    // effect below, so that effect always reads this render's seams.
    useEffect(() => {
        callbacksRef.current = callbacks;
        depsRef.current = deps;
    });
    // Quality changes go to the open session; they never re-open it.
    const initialQualityRef = useRef(target.quality);

    const { agentId, nodeId, channel, enabled } = target;

    useEffect(() => {
        const doFetch = depsRef.current.fetchImpl ?? browserApiFetch;
        const WS =
            depsRef.current.webSocketImpl ?? (typeof WebSocket === 'undefined' ? null : WebSocket);
        const now = depsRef.current.now ?? (() => Date.now());
        let cancelled = false;
        let socket: WebSocket | null = null;

        setSessionId(null);
        sessionRef.current = null;
        setRefusal(null);
        setEndReason(null);
        setStats(null);
        setLastStatsAt(null);
        setLastFrameAt(null);
        setBanners([]);
        if (!enabled || !nodeId || !channel) {
            setState('idle');
            setOpenedAt(null);
            return;
        }
        setState('opening');
        setOpenedAt(now());

        void (async () => {
            let openedId: string;
            try {
                const res = await doFetch(`/api/agents/${agentId}/computer/sessions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        nodeId,
                        channels: [channel],
                        quality: initialQualityRef.current,
                    }),
                });
                const body = (await res.json().catch(() => null)) as { sessionId?: string } | null;
                if (cancelled) return;
                if (!res.ok || typeof body?.sessionId !== 'string') {
                    const described = res.ok
                        ? ({ kind: 'cannot-connect' } as const)
                        : describeOpenRefusal(res.status, body);
                    setRefusal(described);
                    setState(described.kind === 'cannot-connect' ? 'cannot-connect' : 'refused');
                    return;
                }
                openedId = body.sessionId;
            } catch {
                if (!cancelled) setState('cannot-connect');
                return;
            }
            sessionRef.current = openedId;
            setSessionId(openedId);

            let token: string;
            let wsUrl: string;
            try {
                const res = await doFetch(
                    `/api/agents/${agentId}/computer/sessions/${openedId}/attach-token`,
                    {
                        method: 'POST',
                    },
                );
                if (cancelled) return;
                if (!res.ok) {
                    setRefusal(describeOpenRefusal(res.status, await res.json().catch(() => null)));
                    setState(
                        res.status === 401 || res.status === 403 || res.status === 404
                            ? 'refused'
                            : 'cannot-connect',
                    );
                    return;
                }
                const body = (await res.json()) as { token: string; wsUrl: string };
                token = body.token;
                wsUrl = body.wsUrl;
            } catch {
                if (!cancelled) setState('cannot-connect');
                return;
            }
            if (cancelled || !WS) {
                if (!WS && !cancelled) setState('cannot-connect');
                return;
            }

            try {
                socket = new WS(wsUrl);
            } catch {
                setState('cannot-connect');
                return;
            }
            socket.onopen = () => {
                socket?.send(JSON.stringify({ kind: 'auth', token }));
                if (!cancelled) setState((prev) => (prev === 'opening' ? 'connecting' : prev));
            };
            socket.onmessage = (event) => {
                if (cancelled || typeof event.data !== 'string') return;
                const frame = decodeComputerFrame(event.data);
                if (!frame) return;
                switch (frame.kind) {
                    case 'frame':
                        setLastFrameAt(now());
                        setState((prev) => (prev === 'ended' ? prev : 'live'));
                        callbacksRef.current.onPicture(frame);
                        break;
                    case 'terminal':
                        setLastFrameAt(now());
                        setState((prev) => (prev === 'ended' ? prev : 'live'));
                        callbacksRef.current.onTerminal?.(frame.frame);
                        break;
                    case 'stats':
                        setStats(frame);
                        setLastStatsAt(now());
                        break;
                    case 'error':
                        setBanners((prev) => [...prev, frame.message].slice(-MAX_BANNERS));
                        break;
                    case 'end':
                        setEndReason(frame.reason);
                        setState('ended');
                        break;
                    default:
                        break;
                }
            };
            socket.onclose = (event) => {
                if (cancelled) return;
                setState((prev) => {
                    if (prev === 'ended' || prev === 'refused') return prev;
                    return event.code === 4001 ? 'refused' : 'cannot-connect';
                });
            };
            socket.onerror = () => {
                if (!cancelled) setState((prev) => (prev === 'ended' ? prev : 'cannot-connect'));
            };
        })();

        return () => {
            cancelled = true;
            try {
                socket?.close();
            } catch {
                // already gone
            }
        };
    }, [agentId, nodeId, channel, enabled, nonce]);

    const call = useCallback(
        (path: string, init: RequestInit) => {
            const id = sessionRef.current;
            if (!id) return;
            const doFetch = depsRef.current.fetchImpl ?? browserApiFetch;
            void doFetch(`/api/agents/${agentId}/computer/sessions/${id}${path}`, init).catch(
                () => undefined,
            );
        },
        [agentId],
    );

    const refresh = useCallback(() => call('/refresh', { method: 'POST' }), [call]);
    const setQuality = useCallback(
        (quality: ComputerQuality) => {
            initialQualityRef.current = quality;
            call('', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quality }),
            });
        },
        [call],
    );
    const endSession = useCallback(() => {
        call('', { method: 'DELETE' });
        setEndReason('closed-by-user');
        setState('ended');
    }, [call]);
    const reconnect = useCallback(() => setNonce((n) => n + 1), []);

    return {
        state,
        sessionId,
        refusal,
        endReason,
        stats,
        lastStatsAt,
        lastFrameAt,
        openedAt,
        banners,
        refresh,
        setQuality,
        endSession,
        reconnect,
    };
}
