'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    decodeComputerFrame,
    encodeComputerFrame,
    type ComputerChannel,
    type ComputerCloseReason,
    type ComputerInputFrame,
    type ComputerMode,
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
 * Taking control rides the SAME view and socket model: once the page holds
 * control it asks for a driving token (`?role=controller`, which the platform
 * mints only to the view holding control) and swaps the watching socket for a
 * driving one — the new socket takes over only once it is open, so a swap
 * that fails leaves the watching view exactly as it was. `mode` follows the
 * relay's `mode` frames; `sendInput` sends the person's input on the current
 * socket (the relay forwards it only while this view holds control).
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
    /** The view's mode as the relay last said: `controlling` while this view holds control. */
    mode: ComputerMode;
    /** Whether the socket in use is a driving one (swapped in after control was taken). */
    driving: boolean;
    /** Ask for a driving socket now that this view holds control. A no-op when already driving. */
    upgradeToController: () => void;
    /** Send one input frame on the current socket. False when there is no open socket to send it on. */
    sendInput: (frame: ComputerInputFrame) => boolean;
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
    const [mode, setMode] = useState<ComputerMode>('watching');
    const [driving, setDriving] = useState(false);
    /** The socket frames are sent on now; replaced when a driving socket takes over. */
    const socketRef = useRef<WebSocket | null>(null);
    /** Set by the running view: swaps in a driving socket. */
    const upgradeRef = useRef<(() => void) | null>(null);
    const callbacksRef = useRef(callbacks);
    const sessionRef = useRef<string | null>(null);
    /** Sessions already ended from here (the owner's End session, or a release below). */
    const endedRef = useRef<Set<string>>(new Set());
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
        let openedId: string | null = null;
        // True once any frame arrived over the socket: the relay authenticated
        // this viewer, so the platform's last-viewer grace ends the session
        // when the viewer goes. Before that the platform has no viewer to wait
        // for, and a session opened here would hold a slot on the machine
        // until it expired.
        let attached = false;
        const ended = endedRef.current;
        /**
         * End the session this run opened when the view cannot (or will no
         * longer) attach to it. Once per session; never after the view
         * attached (see `attached`) or after it was already ended.
         */
        const release = () => {
            const id = openedId;
            if (!id || attached || ended.has(id)) return;
            ended.add(id);
            try {
                void doFetch(`/api/agents/${agentId}/computer/sessions/${id}`, {
                    method: 'DELETE',
                    // Survives the page being navigated away from.
                    keepalive: true,
                }).catch(() => undefined);
            } catch {
                // no transport (the page is going away): expiry is the floor
            }
        };

        setSessionId(null);
        sessionRef.current = null;
        socketRef.current = null;
        upgradeRef.current = null;
        setRefusal(null);
        setEndReason(null);
        setStats(null);
        setLastStatsAt(null);
        setLastFrameAt(null);
        setBanners([]);
        setMode('watching');
        setDriving(false);
        if (!enabled || !nodeId || !channel) {
            setState('idle');
            setOpenedAt(null);
            return;
        }
        setState('opening');
        setOpenedAt(now());

        void (async () => {
            let sessionIdOpened: string;
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
                if (res.ok && typeof body?.sessionId === 'string') openedId = body.sessionId;
                if (cancelled) {
                    // Opened after this view was abandoned: nobody will attach to it.
                    release();
                    return;
                }
                if (!openedId) {
                    const described = res.ok
                        ? ({ kind: 'cannot-connect' } as const)
                        : describeOpenRefusal(res.status, body);
                    setRefusal(described);
                    setState(described.kind === 'cannot-connect' ? 'cannot-connect' : 'refused');
                    return;
                }
                sessionIdOpened = openedId;
            } catch {
                if (!cancelled) setState('cannot-connect');
                return;
            }
            sessionRef.current = sessionIdOpened;
            setSessionId(sessionIdOpened);

            let token: string;
            let wsUrl: string;
            try {
                const res = await doFetch(
                    `/api/agents/${agentId}/computer/sessions/${sessionIdOpened}/attach-token`,
                    {
                        method: 'POST',
                    },
                );
                if (cancelled) {
                    release();
                    return;
                }
                if (!res.ok) {
                    setRefusal(describeOpenRefusal(res.status, await res.json().catch(() => null)));
                    setState(
                        res.status === 401 || res.status === 403 || res.status === 404
                            ? 'refused'
                            : 'cannot-connect',
                    );
                    release();
                    return;
                }
                const body = (await res.json()) as { token: string; wsUrl: string };
                token = body.token;
                wsUrl = body.wsUrl;
            } catch {
                if (!cancelled) setState('cannot-connect');
                release();
                return;
            }
            if (cancelled || !WS) {
                if (!WS && !cancelled) setState('cannot-connect');
                release();
                return;
            }

            const wire = (ws: WebSocket, wsToken: string, onAccepted?: () => void) => {
                ws.onopen = () => {
                    ws.send(JSON.stringify({ kind: 'auth', token: wsToken }));
                    if (onAccepted) {
                        // A driving socket takes over only once it is open.
                        onAccepted();
                        return;
                    }
                    if (!cancelled) setState((prev) => (prev === 'opening' ? 'connecting' : prev));
                };
                ws.onmessage = (event) => {
                    // A socket that was swapped out (or is not yet swapped in) says nothing.
                    if (cancelled || ws !== socket || typeof event.data !== 'string') return;
                    const frame = decodeComputerFrame(event.data);
                    if (!frame) return;
                    attached = true;
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
                        case 'mode':
                            setMode(frame.mode);
                            break;
                        case 'end':
                            setEndReason(frame.reason);
                            setState('ended');
                            break;
                        default:
                            break;
                    }
                };
                ws.onclose = (event) => {
                    if (cancelled || ws !== socket) return;
                    setState((prev) => {
                        if (prev === 'ended' || prev === 'refused') return prev;
                        return event.code === 4001 ? 'refused' : 'cannot-connect';
                    });
                    // Closed before the relay accepted this viewer (a refused token,
                    // a dropped connection): Reconnect opens a fresh session.
                    release();
                };
                ws.onerror = () => {
                    if (!cancelled && ws === socket) {
                        setState((prev) => (prev === 'ended' ? prev : 'cannot-connect'));
                    }
                };
            };

            try {
                socket = new WS(wsUrl);
            } catch {
                setState('cannot-connect');
                release();
                return;
            }
            socketRef.current = socket;
            wire(socket, token);

            const viewId = sessionIdOpened;
            const SocketImpl = WS;
            let upgrading = false;
            let upgraded = false;
            upgradeRef.current = () => {
                if (cancelled || upgrading || upgraded) return;
                upgrading = true;
                void (async () => {
                    try {
                        const res = await doFetch(
                            `/api/agents/${agentId}/computer/sessions/${viewId}/attach-token?role=controller`,
                            { method: 'POST' },
                        );
                        if (cancelled || !res.ok) return;
                        const body = (await res.json()) as {
                            token?: string;
                            wsUrl?: string;
                            role?: string;
                        };
                        // The platform decides: without control it mints a watching token, and
                        // the watching socket already in use stays.
                        if (cancelled || body.role !== 'driver' || !body.token || !body.wsUrl)
                            return;
                        const next = new SocketImpl(body.wsUrl);
                        wire(next, body.token, () => {
                            if (cancelled) {
                                next.close();
                                return;
                            }
                            const previous = socket;
                            socket = next;
                            socketRef.current = next;
                            upgraded = true;
                            setDriving(true);
                            try {
                                previous?.close();
                            } catch {
                                // already gone
                            }
                        });
                    } catch {
                        // The watching socket keeps working; the next attempt tries again.
                    } finally {
                        upgrading = false;
                    }
                })();
            };
        })();

        return () => {
            cancelled = true;
            upgradeRef.current = null;
            try {
                socket?.close();
            } catch {
                // already gone
            }
            release();
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
        if (sessionRef.current) endedRef.current.add(sessionRef.current);
        call('', { method: 'DELETE' });
        setEndReason('closed-by-user');
        setState('ended');
    }, [call]);
    const reconnect = useCallback(() => setNonce((n) => n + 1), []);
    const upgradeToController = useCallback(() => upgradeRef.current?.(), []);
    const sendInput = useCallback((frame: ComputerInputFrame): boolean => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== 1) return false;
        const wire = encodeComputerFrame(frame);
        if (wire === null) return false;
        try {
            ws.send(wire);
            return true;
        } catch {
            return false;
        }
    }, []);

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
        mode,
        driving,
        upgradeToController,
        sendInput,
    };
}
