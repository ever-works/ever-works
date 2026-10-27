'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetSessionAttachRole, FleetSessionNotice } from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import {
    FleetSessionSocket,
    sessionCloseVerdict,
    type SessionSocketClose,
    type SessionSocketDeps,
} from './session-socket';
import {
    heldLineCount,
    holdInput,
    sessionReconnectDelayMs,
    SESSION_RECONNECTING_AFTER_MS,
    type SessionErrorRead,
} from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, spec §5.4, FR-21 … FR-26) — the detail
 * page's attach: one {@link FleetSessionSocket} at a time, re-made on a role
 * switch (viewer ↔ driver is a fresh token, never a page reload) and on a
 * dropped stream.
 *
 *  - **States** — `starting` · `attached` · `reconnecting` (the stream dropped
 *    and has not come back for {@link SESSION_RECONNECTING_AFTER_MS}) ·
 *    `ended` · `refused` (the platform said no; `error` says why) ·
 *    `detached` (the page let go).
 *  - **Held input** — a driver whose stream drops keeps what it types (up to
 *    16 KiB) and is OFFERED it once the stream is back ("You typed 3 lines
 *    while offline · Send them · Discard"); it is never sent on its own.
 *  - **Notices** — the kill switch's `paused` / `resumed`, the drain
 *    countdown, the slow-viewer drop, the newest driver's size and the
 *    `replay` restart (the renderer is cleared before the fresh replay).
 *  - **Bandwidth** — bytes received, and bytes a second over the last second.
 *
 * A watcher's `sendInput` is a no-op (the relay and the node refuse it again).
 */
export type SessionAttachState =
    | 'starting'
    | 'attached'
    | 'reconnecting'
    | 'ended'
    | 'refused'
    | 'detached';

export interface SessionAttachCallbacks {
    onBytes(bytes: Uint8Array): void;
    /** The stream restarts with a fresh replay: clear the terminal first. */
    onClear?(): void;
    onExit?(code: number): void;
}

export interface SessionAttachOptions {
    sessionId: string;
    role: FleetSessionAttachRole;
    /** False keeps the hook idle (an ended session shows its kept screen instead). */
    enabled: boolean;
    /** The renderer's current size. */
    size: () => { cols: number; rows: number };
    deps?: Partial<SessionSocketDeps>;
}

export interface SessionAttachApi {
    state: SessionAttachState;
    /** The role the platform granted for the current stream. */
    role: FleetSessionAttachRole | null;
    error: SessionErrorRead | null;
    /** The kill switch's reason while it blocks input (`''` when none was given), else null. */
    paused: string | null;
    /** When a drain ends this session (ms since the epoch), else null. */
    drainEndsAt: number | null;
    /** The node dropped this browser for being slow; it reconnects. */
    slow: boolean;
    exitCode: number | null;
    heldLines: number;
    sendHeld(): void;
    discardHeld(): void;
    /** A refusal the relay sent back for an input this role may not send. */
    refusedHint: string | null;
    bytesIn: number;
    bytesPerSecond: number;
    sendInput(data: string): void;
    sendResize(cols: number, rows: number): void;
    reconnect(): void;
}

export function useSessionAttach(
    options: SessionAttachOptions,
    callbacks: SessionAttachCallbacks,
): SessionAttachApi {
    const { sessionId, role, enabled } = options;
    const [state, setState] = useState<SessionAttachState>(enabled ? 'starting' : 'detached');
    const [granted, setGranted] = useState<FleetSessionAttachRole | null>(null);
    const [error, setError] = useState<SessionErrorRead | null>(null);
    const [paused, setPaused] = useState<string | null>(null);
    const [drainEndsAt, setDrainEndsAt] = useState<number | null>(null);
    const [slow, setSlow] = useState(false);
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [held, setHeld] = useState('');
    const [heldOffered, setHeldOffered] = useState(false);
    const [refusedHint, setRefusedHint] = useState<string | null>(null);
    const [bytesIn, setBytesIn] = useState(0);
    const [bytesPerSecond, setBytesPerSecond] = useState(0);
    const [nonce, setNonce] = useState(0);

    const socketRef = useRef<FleetSessionSocket | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;
    const sizeRef = useRef(options.size);
    sizeRef.current = options.size;
    const heldRef = useRef('');
    heldRef.current = held;
    const droppedRef = useRef(false);

    useEffect(() => {
        if (!enabled) {
            setState('detached');
            return;
        }
        let cancelled = false;
        let attempt = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectingTimer: ReturnType<typeof setTimeout> | null = null;
        let lastBytes = 0;
        const meter = setInterval(() => {
            const socket = socketRef.current;
            if (!socket) return;
            setBytesIn(socket.bytesIn);
            setBytesPerSecond(Math.max(0, socket.bytesIn - lastBytes));
            lastBytes = socket.bytesIn;
        }, 1_000);

        const deps: SessionSocketDeps = {
            fetchImpl: options.deps?.fetchImpl ?? browserApiFetch,
            ...(options.deps?.webSocketImpl ? { webSocketImpl: options.deps.webSocketImpl } : {}),
        };

        const connect = () => {
            if (cancelled) return;
            lastBytes = 0;
            const socket = new FleetSessionSocket(
                sessionId,
                role,
                {
                    onRole: (next) => {
                        if (!cancelled) setGranted(next);
                    },
                    onAttached: () => {
                        if (cancelled) return;
                        attempt = 0;
                        if (reconnectingTimer) clearTimeout(reconnectingTimer);
                        reconnectingTimer = null;
                        setError(null);
                        setSlow(false);
                        setState('attached');
                        if (heldRef.current.length > 0) setHeldOffered(true);
                        droppedRef.current = false;
                    },
                    onBytes: (bytes) => callbacksRef.current.onBytes(bytes),
                    onExit: (code) => {
                        if (cancelled) return;
                        setExitCode(code);
                        callbacksRef.current.onExit?.(code);
                    },
                    onNotice: (notice) => {
                        if (!cancelled) applyNotice(notice);
                    },
                    onRefused: (hint) => {
                        if (!cancelled) setRefusedHint(hint);
                    },
                    onClosed: (close) => {
                        if (!cancelled) onClosed(socket, close);
                    },
                },
                deps,
                () => sizeRef.current(),
            );
            socketRef.current = socket;
            void socket.open();
        };

        const applyNotice = (notice: FleetSessionNotice) => {
            switch (notice.notice) {
                case 'paused':
                    setPaused(notice.reason ?? '');
                    return;
                case 'resumed':
                    setPaused(null);
                    return;
                case 'drain':
                    setDrainEndsAt(Date.now() + notice.seconds * 1000);
                    return;
                case 'slow-viewer':
                    setSlow(true);
                    return;
                case 'replay':
                    callbacksRef.current.onClear?.();
                    return;
                default:
                    return;
            }
        };

        const onClosed = (socket: FleetSessionSocket, close: SessionSocketClose) => {
            if (socketRef.current === socket) socketRef.current = null;
            const verdict = sessionCloseVerdict(close, false);
            if (verdict === 'ended') {
                setState('ended');
                return;
            }
            if (verdict === 'refused') {
                setError(
                    close.mintError ??
                        close.attachError ?? {
                            code:
                                close.linkReason && close.linkReason !== 'normal'
                                    ? close.linkReason
                                    : 'internal',
                            hint: close.hint,
                            details: {},
                            status: 0,
                        },
                );
                setState('refused');
                return;
            }
            // retry: hold input meanwhile; say "reconnecting" only if it does not come back soon.
            droppedRef.current = true;
            if (!reconnectingTimer) {
                reconnectingTimer = setTimeout(() => {
                    reconnectingTimer = null;
                    if (!cancelled) setState('reconnecting');
                }, SESSION_RECONNECTING_AFTER_MS);
            }
            const delay = sessionReconnectDelayMs(attempt);
            attempt += 1;
            retryTimer = setTimeout(connect, delay);
        };

        setState('starting');
        setError(null);
        setExitCode(null);
        droppedRef.current = false;
        connect();

        return () => {
            cancelled = true;
            clearInterval(meter);
            if (retryTimer) clearTimeout(retryTimer);
            if (reconnectingTimer) clearTimeout(reconnectingTimer);
            socketRef.current?.close();
            socketRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, role, enabled, nonce]);

    const sendInput = useCallback((data: string) => {
        const socket = socketRef.current;
        if (socket?.granted === 'viewer') return;
        if (socket?.sendInput(data)) return;
        // Not attached right now (a drop, a reconnect): hold it, to offer later.
        if (droppedRef.current || !socket?.isAttached)
            setHeld((current) => holdInput(current, data));
    }, []);

    const sendResize = useCallback((cols: number, rows: number) => {
        socketRef.current?.sendResize(cols, rows);
    }, []);

    const sendHeld = useCallback(() => {
        const socket = socketRef.current;
        if (socket && heldRef.current.length > 0 && socket.sendInput(heldRef.current)) {
            setHeld('');
            setHeldOffered(false);
        }
    }, []);

    const discardHeld = useCallback(() => {
        setHeld('');
        setHeldOffered(false);
    }, []);

    const reconnect = useCallback(() => setNonce((n) => n + 1), []);

    return {
        state,
        role: granted,
        error,
        paused,
        drainEndsAt,
        slow,
        exitCode,
        heldLines: heldOffered ? heldLineCount(held) : 0,
        sendHeld,
        discardHeld,
        refusedHint,
        bytesIn,
        bytesPerSecond,
        sendInput,
        sendResize,
        reconnect,
    };
}
