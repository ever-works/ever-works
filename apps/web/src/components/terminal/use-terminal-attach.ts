'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Terminal attach hook (streaming-terminal M7).
 *
 * Drives the five-state machine the whole feature's failure UX hangs
 * on — every state is VISIBLY distinct, `refused` ≠ `cannot-connect`:
 *
 *   'starting'        token minting / socket opening
 *   'attached'        live: replay landed, tail streaming
 *   'ended'           the pinned exit arrived (reason surfaced)
 *   'cannot-connect'  no provider / socket failed / token 503
 *   'refused'         authorization said no (401/403/404)
 *
 * Flow: proxy-mint attach token (the proxy also computes the absolute
 * ws URL server-side) → open WS → FIRST message is the auth frame →
 * bytes flow. All seams (fetch, WebSocket ctor) are injectable for
 * jsdom tests.
 */
export type TerminalAttachState = 'starting' | 'attached' | 'ended' | 'cannot-connect' | 'refused';

export interface TerminalAttachCallbacks {
    onBytes: (bytes: Uint8Array) => void;
    onExit?: (reason: string, code: number) => void;
    onBanner?: (message: string) => void;
}

export interface TerminalAttachApi {
    state: TerminalAttachState;
    endedReason: string | null;
    role: 'driver' | 'viewer' | null;
    /** Send raw keystrokes (no-op unless attached AND driver). */
    sendInput: (data: string) => void;
    sendResize: (cols: number, rows: number) => void;
    /** Re-run the whole attach flow (Reconnect button). */
    reconnect: () => void;
}

export interface TerminalAttachDeps {
    fetchImpl?: typeof fetch;
    webSocketImpl?: typeof WebSocket;
}

export function useTerminalAttach(
    agentId: string,
    runId: string,
    callbacks: TerminalAttachCallbacks,
    deps: TerminalAttachDeps = {},
): TerminalAttachApi {
    const [state, setState] = useState<TerminalAttachState>('starting');
    const [endedReason, setEndedReason] = useState<string | null>(null);
    const [role, setRole] = useState<'driver' | 'viewer' | null>(null);
    const [nonce, setNonce] = useState(0);
    const socketRef = useRef<WebSocket | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;

    useEffect(() => {
        let cancelled = false;
        let socket: WebSocket | null = null;
        const doFetch = deps.fetchImpl ?? fetch;
        const WS = deps.webSocketImpl ?? WebSocket;

        setState('starting');
        setEndedReason(null);

        void (async () => {
            let token: string;
            let wsUrl: string;
            try {
                const res = await doFetch(
                    `/api/agents/${agentId}/runs/${runId}/terminal/attach-token`,
                    { method: 'POST' },
                );
                if (res.status === 401 || res.status === 403 || res.status === 404) {
                    if (!cancelled) setState('refused');
                    return;
                }
                if (!res.ok) {
                    if (!cancelled) setState('cannot-connect');
                    return;
                }
                const body = (await res.json()) as {
                    token: string;
                    wsUrl: string;
                    role: 'driver' | 'viewer';
                };
                token = body.token;
                wsUrl = body.wsUrl;
                if (!cancelled) setRole(body.role);
            } catch {
                if (!cancelled) setState('cannot-connect');
                return;
            }
            if (cancelled) return;

            try {
                socket = new WS(wsUrl);
            } catch {
                setState('cannot-connect');
                return;
            }
            socketRef.current = socket;

            socket.onopen = () => {
                socket?.send(JSON.stringify({ kind: 'auth', token }));
                if (!cancelled) setState('attached');
            };
            socket.onmessage = (event) => {
                try {
                    const frame = JSON.parse(String(event.data)) as {
                        kind: string;
                        data?: string;
                        message?: string;
                        reason?: string;
                        code?: number;
                    };
                    if (frame.kind === 'stdout' && typeof frame.data === 'string') {
                        const raw = atob(frame.data);
                        const bytes = new Uint8Array(raw.length);
                        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                        callbacksRef.current.onBytes(bytes);
                    } else if (frame.kind === 'error' && typeof frame.message === 'string') {
                        callbacksRef.current.onBanner?.(frame.message);
                    } else if (frame.kind === 'exit') {
                        const reason = frame.reason ?? 'closed';
                        if (!cancelled) {
                            setEndedReason(reason);
                            setState('ended');
                        }
                        callbacksRef.current.onExit?.(reason, frame.code ?? -1);
                    }
                } catch {
                    // garbage frame — drop, never crash the pane
                }
            };
            socket.onclose = (event) => {
                if (cancelled) return;
                setState((prev) => {
                    if (prev === 'ended' || prev === 'refused') return prev;
                    // 4001 = auth refusal from the gateway; everything else
                    // is a transport problem.
                    return event.code === 4001 ? 'refused' : 'cannot-connect';
                });
            };
            socket.onerror = () => {
                if (!cancelled) {
                    setState((prev) => (prev === 'ended' ? prev : 'cannot-connect'));
                }
            };
        })();

        return () => {
            cancelled = true;
            socketRef.current = null;
            try {
                socket?.close();
            } catch {
                // already gone
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId, runId, nonce]);

    const sendInput = useCallback(
        (data: string) => {
            const socket = socketRef.current;
            if (!socket || socket.readyState !== socket.OPEN || role !== 'driver') return;
            socket.send(JSON.stringify({ kind: 'stdin', data: btoa(data) }));
        },
        [role],
    );

    const sendResize = useCallback(
        (cols: number, rows: number) => {
            const socket = socketRef.current;
            if (!socket || socket.readyState !== socket.OPEN || role !== 'driver') return;
            socket.send(JSON.stringify({ kind: 'resize', cols, rows }));
        },
        [role],
    );

    const reconnect = useCallback(() => setNonce((n) => n + 1), []);

    return { state, endedReason, role, sendInput, sendResize, reconnect };
}
