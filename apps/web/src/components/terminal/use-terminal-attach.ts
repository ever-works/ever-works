'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserApiFetch } from '@/lib/api/browser-api';
import {
    FleetSessionSocket,
    sessionCloseVerdict,
} from '@/components/fleet/sessions/session-socket';

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
 * ws URL server-side) → REHYDRATE the persisted transcript (M9) → open
 * WS → FIRST message is the auth frame → bytes flow. All seams (fetch,
 * WebSocket ctor) are injectable for jsdom tests.
 *
 * Rehydration (streaming-terminal M9 / founder decision D1): the relay's
 * scrollback is in-memory, byte-bounded and dies with the replica, so
 * before this a closed tab lost the session. The pane now replays the
 * durable server-side transcript first, records the highest `seq` it
 * rendered, and DROPS any live/replayed frame at or below that seq — the
 * relay replays its own backlog on attach, and without the seq gate
 * every rehydrated line would print twice.
 *
 * Rehydration is strictly best-effort: an install with transcripts off,
 * an older API, or any transport hiccup simply yields no history and the
 * pane behaves exactly as it did before M9.
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

export interface TerminalAttachOptions {
    /**
     * Attach read-only (mints a `viewer` token instead of a `driver`
     * one). The relay refuses viewer stdin/resize server-side, so this
     * is a real role, not a UI-only affordance — a second participant
     * can watch a live session without fighting the driver for the
     * keyboard.
     */
    readOnly?: boolean;
    /**
     * What the pane attaches to (FL-04 P1b, CONTRACTS R-21). Absent = the Run
     * named by `agentId` / `runId`, exactly as before. `fleet-session` attaches
     * to a session on a computer through FL-02's viewer gateway: the token is
     * minted from `/api/fleet/sessions/:id/attach-token`, the socket is the
     * returned `wsUrl`, and the five states mean the same things.
     */
    source?: TerminalAttachSource;
}

/** The pane's source when it is not a Run (FL-04 P1b). */
export type TerminalAttachSource = { kind: 'run' } | { kind: 'fleet-session'; sessionId: string };

/** Bound on rehydration paging so a huge transcript cannot spin forever. */
const TRANSCRIPT_MAX_PAGES = 20;

/** Shape of one `GET .../terminal/transcript` page (M9). */
interface TranscriptPageResponse {
    chunks?: Array<{ seq?: number; text?: string; direction?: string }>;
    lastSeq?: number | null;
    hasMore?: boolean;
}

export function useTerminalAttach(
    agentId: string,
    runId: string,
    callbacks: TerminalAttachCallbacks,
    deps: TerminalAttachDeps = {},
    options: TerminalAttachOptions = {},
): TerminalAttachApi {
    const readOnly = options.readOnly === true;
    const fleetSessionId =
        options.source?.kind === 'fleet-session' ? options.source.sessionId : null;
    const [state, setState] = useState<TerminalAttachState>('starting');
    const [endedReason, setEndedReason] = useState<string | null>(null);
    const [role, setRole] = useState<'driver' | 'viewer' | null>(null);
    const [nonce, setNonce] = useState(0);
    const socketRef = useRef<WebSocket | null>(null);
    /** The fleet-session source's stream (FL-04 P1b); null for a Run. */
    const fleetSocketRef = useRef<FleetSessionSocket | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;
    /**
     * Highest transcript `seq` already rendered from the persisted
     * replay. Live + relay-replayed frames at or below it are dropped so
     * rehydrated output never double-prints. -1 = nothing rehydrated.
     */
    const hydratedSeqRef = useRef(-1);

    useEffect(() => {
        let cancelled = false;
        let socket: WebSocket | null = null;
        const doFetch = deps.fetchImpl ?? browserApiFetch;
        const WS = deps.webSocketImpl ?? WebSocket;

        if (fleetSessionId) {
            // FL-04 P1b: a session on a computer. Same five states; no Run
            // transcript to rehydrate (the node replays its own scrollback).
            setState('starting');
            setEndedReason(null);
            const fleetSocket = new FleetSessionSocket(
                fleetSessionId,
                readOnly ? 'viewer' : 'driver',
                {
                    onRole: (granted) => {
                        if (!cancelled) setRole(granted);
                    },
                    onAttached: () => {
                        if (!cancelled) setState('attached');
                    },
                    onBytes: (bytes) => callbacksRef.current.onBytes(bytes),
                    onExit: (code) => {
                        if (cancelled) return;
                        setEndedReason('exit');
                        setState('ended');
                        callbacksRef.current.onExit?.('exit', code);
                    },
                    onRefused: (hint) => {
                        if (hint) callbacksRef.current.onBanner?.(hint);
                    },
                    onNotice: (notice) => {
                        if (notice.notice === 'paused') {
                            callbacksRef.current.onBanner?.(notice.reason ?? 'paused');
                        }
                    },
                    onClosed: (close) => {
                        if (cancelled) return;
                        const verdict = sessionCloseVerdict(close, false);
                        setState((prev) => {
                            if (prev === 'ended') return prev;
                            if (verdict === 'ended') return 'ended';
                            if (verdict === 'refused') return 'refused';
                            return 'cannot-connect';
                        });
                    },
                },
                { fetchImpl: doFetch, webSocketImpl: WS },
                () => ({ cols: 120, rows: 32 }),
            );
            fleetSocketRef.current = fleetSocket;
            void fleetSocket.open();
            return () => {
                cancelled = true;
                fleetSocketRef.current = null;
                fleetSocket.close();
            };
        }

        setState('starting');
        setEndedReason(null);
        hydratedSeqRef.current = -1;

        /**
         * Replay the persisted transcript into the renderer, page by
         * page, and return the highest seq rendered (-1 for none).
         * Never throws: history is a bonus, the live session is the
         * product.
         */
        const rehydrate = async (): Promise<number> => {
            let fromSeq = 0;
            let highest = -1;
            for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page++) {
                if (cancelled) return highest;
                let body: TranscriptPageResponse;
                try {
                    const res = await doFetch(
                        `/api/agents/${agentId}/runs/${runId}/terminal/transcript?fromSeq=${fromSeq}`,
                        { method: 'GET' },
                    );
                    if (!res.ok) return highest;
                    body = (await res.json()) as TranscriptPageResponse;
                } catch {
                    return highest;
                }
                const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
                if (chunks.length === 0) return highest;

                for (const chunk of chunks) {
                    if (typeof chunk?.text !== 'string') continue;
                    // Text was stored decoded + redacted server-side, so
                    // it goes to the renderer as UTF-8 — no base64 leg.
                    callbacksRef.current.onBytes(new TextEncoder().encode(chunk.text));
                    if (typeof chunk.seq === 'number' && chunk.seq > highest) {
                        highest = chunk.seq;
                    }
                }

                if (!body?.hasMore) return highest;
                const next = typeof body.lastSeq === 'number' ? body.lastSeq + 1 : fromSeq;
                // Guard against a server that reports hasMore without
                // advancing — never loop on the same page.
                if (next <= fromSeq) return highest;
                fromSeq = next;
            }
            return highest;
        };

        void (async () => {
            let token: string;
            let wsUrl: string;
            try {
                const res = await doFetch(
                    `/api/agents/${agentId}/runs/${runId}/terminal/attach-token${
                        readOnly ? '?role=viewer' : ''
                    }`,
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

            // M9: durable history BEFORE the live tail, so the pane reads
            // in chronological order and the seq gate below can dedupe
            // the relay's own attach-time replay against it.
            hydratedSeqRef.current = await rehydrate();
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
                        seq?: number;
                        data?: string;
                        message?: string;
                        reason?: string;
                        code?: number;
                    };
                    if (frame.kind === 'stdout' && typeof frame.data === 'string') {
                        // Already rendered from the persisted transcript —
                        // the relay replays its scrollback on attach, and
                        // without this gate every rehydrated line prints
                        // twice.
                        if (typeof frame.seq === 'number' && frame.seq <= hydratedSeqRef.current) {
                            return;
                        }
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
    }, [agentId, runId, nonce, readOnly, fleetSessionId]);

    const sendInput = useCallback(
        (data: string) => {
            if (fleetSocketRef.current) {
                fleetSocketRef.current.sendInput(data);
                return;
            }
            const socket = socketRef.current;
            if (!socket || socket.readyState !== socket.OPEN || role !== 'driver') return;
            socket.send(JSON.stringify({ kind: 'stdin', data: btoa(data) }));
        },
        [role],
    );

    const sendResize = useCallback(
        (cols: number, rows: number) => {
            if (fleetSocketRef.current) {
                fleetSocketRef.current.sendResize(cols, rows);
                return;
            }
            const socket = socketRef.current;
            if (!socket || socket.readyState !== socket.OPEN || role !== 'driver') return;
            socket.send(JSON.stringify({ kind: 'resize', cols, rows }));
        },
        [role],
    );

    const reconnect = useCallback(() => setNonce((n) => n + 1), []);

    return { state, endedReason, role, sendInput, sendResize, reconnect };
}
