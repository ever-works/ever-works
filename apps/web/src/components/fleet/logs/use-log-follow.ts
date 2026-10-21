'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetLogLine, FleetLogsNotice } from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { FleetLogSocket, logCloseVerdict, type LogSocketClose } from './log-socket';
import {
    appendHeld,
    EMPTY_WINDOW,
    prependHeld,
    type HeldWindow,
    type LogFollowPhase,
    type LogsError,
    type LogStopReason,
} from './logs.shared';

/**
 * Logs on computers (FL-08, T-12) — one open log in the browser: the socket,
 * the held lines (≤ 5 000, FR-21), the follow state, Pause (FR-15, held here:
 * arrivals are counted and appended on Resume), the counters the footer reads
 * (bytes, redactions, dropped), the notices, the slow/abandoned timers of
 * spec §5.8 (10 s, 30 s), reconnects with backoff (U8) and the stop reasons
 * (U3 kill switch, U10 gone).
 */

const SLOW_AFTER_MS = 10_000;
const ABANDON_AFTER_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const RETRY_LIMIT = 6;

export interface LogFollowState {
    phase: LogFollowPhase;
    window: HeldWindow;
    /** The batch has arrived (the loading card goes). */
    loaded: boolean;
    /** No answer after 10 s (spec §5.8). */
    slow: boolean;
    following: boolean;
    paused: boolean;
    pausedCount: number;
    bytes: number;
    redactions: number;
    dropped: number;
    stopReason: LogStopReason;
    stopHint: string | null;
    error: LogsError | null;
    /** The journal opened with only this user's entries: the command that widens it (U5). */
    groupHint: string | null;
    /** P2: an older page is on its way / there is none. */
    loadingEarlier: boolean;
    earlierExhausted: boolean;
    earlierUnsupported: boolean;
    /** Lines appended at the bottom since the viewer opened (the "N new lines" pill counts its growth). */
    appended: number;
    /** Lines an older page prepended last (P2: the viewer keeps its scroll position by this many rows). */
    prepended: number;
}

const INITIAL: LogFollowState = {
    phase: 'connecting',
    window: EMPTY_WINDOW,
    loaded: false,
    slow: false,
    following: false,
    paused: false,
    pausedCount: 0,
    bytes: 0,
    redactions: 0,
    dropped: 0,
    stopReason: null,
    stopHint: null,
    error: null,
    groupHint: null,
    loadingEarlier: false,
    earlierExhausted: false,
    earlierUnsupported: false,
    appended: 0,
    prepended: 0,
};

export interface UseLogFollowInput {
    nodeId: string;
    /** The source ids (one, or a merged set). Empty: nothing is opened. */
    sources: readonly string[];
    lines?: number;
    follow?: boolean;
}

export function useLogFollow(input: UseLogFollowInput) {
    const { nodeId, lines = 500, follow = true } = input;
    const key = input.sources.join('\n');
    const [state, setState] = useState<LogFollowState>(INITIAL);
    const socketRef = useRef<FleetLogSocket | null>(null);
    const heldWhilePaused = useRef<FleetLogLine[]>([]);
    const pausedRef = useRef(false);
    const attempt = useRef(0);
    const [generation, setGeneration] = useState(0);

    const reopen = useCallback(() => {
        attempt.current = 0;
        setGeneration((value) => value + 1);
    }, []);

    useEffect(() => {
        const sources = key.length > 0 ? key.split('\n') : [];
        if (sources.length === 0) return undefined;
        let disposed = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let closedByUs = false;
        setState((previous) => ({
            ...INITIAL,
            // A reconnect keeps what is on screen (U8): only a new source starts empty.
            ...(attempt.current > 0 ? { window: previous.window, bytes: previous.bytes, redactions: previous.redactions } : {}),
        }));
        heldWhilePaused.current = [];
        pausedRef.current = false;
        let loaded = false;

        const slowTimer = setTimeout(() => {
            if (!disposed && !loaded) setState((s) => ({ ...s, slow: true }));
        }, SLOW_AFTER_MS);
        const abandonTimer = setTimeout(() => {
            if (disposed || loaded) return;
            // Spec §5.8: after 30 s the request is abandoned with "did not answer".
            closedByUs = true;
            socketRef.current?.close();
            setState((s) => ({
                ...s,
                phase: 'error',
                error: { code: 'unreachable', hint: null, details: { abandoned: true }, status: 0 },
            }));
        }, ABANDON_AFTER_MS);

        const onNotice = (notice: FleetLogsNotice) => {
            setState((s) => {
                switch (notice.kind) {
                    case 'dropped':
                        return { ...s, dropped: s.dropped + (notice.count ?? 0) };
                    case 'group-membership':
                        return { ...s, groupHint: notice.hint ?? null };
                    case 'gone':
                    case 'stopped':
                        return { ...s, following: false, stopReason: notice.kind, stopHint: notice.hint ?? null };
                    case 'kill-switch':
                        return { ...s, following: false, phase: 'stopped', stopReason: 'kill-switch', stopHint: notice.hint ?? null };
                    case 'error':
                        return { ...s, following: false, stopReason: 'not-following', stopHint: notice.hint ?? null };
                    default:
                        return s;
                }
            });
        };

        const socket = new FleetLogSocket(
            { nodeId, sources, lines, follow },
            {
                onPhase: (phase) => {
                    if (disposed) return;
                    if (phase === 'open') {
                        attempt.current = 0;
                        setState((s) => ({ ...s, phase: 'live' }));
                    }
                },
                onLines: (incoming, bytes) => {
                    if (disposed) return;
                    const earlier = incoming.filter((line) => line.earlier === true);
                    const fresh = earlier.length > 0 ? incoming.filter((line) => line.earlier !== true) : incoming;
                    const redactions = incoming.reduce((sum, line) => sum + line.redactions, 0);
                    if (pausedRef.current && fresh.length > 0) heldWhilePaused.current.push(...fresh);
                    setState((s) => {
                        let window = s.window;
                        let prepended = s.prepended;
                        if (earlier.length > 0) {
                            const before = window.lines.length;
                            window = prependHeld(window, earlier);
                            prepended = window.lines.length - before;
                        }
                        const appending = !pausedRef.current && fresh.length > 0;
                        if (appending) window = appendHeld(window, fresh);
                        return {
                            ...s,
                            window,
                            prepended,
                            appended: appending ? s.appended + fresh.length : s.appended,
                            bytes: s.bytes + bytes,
                            redactions: s.redactions + redactions,
                            pausedCount: pausedRef.current ? s.pausedCount + fresh.length : s.pausedCount,
                        };
                    });
                },
                onInitialDone: (done) => {
                    if (disposed) return;
                    loaded = true;
                    clearTimeout(slowTimer);
                    clearTimeout(abandonTimer);
                    setState((s) => ({
                        ...s,
                        loaded: true,
                        slow: false,
                        following: done.following,
                        ...(done.error && done.count === 0
                            ? {
                                  phase: 'error' as const,
                                  error: { code: done.error.code as LogsError['code'], hint: done.error.hint, details: {}, status: 0 },
                              }
                            : {}),
                    }));
                },
                onEarlierDone: (done) => {
                    if (disposed) return;
                    setState((s) => ({
                        ...s,
                        loadingEarlier: false,
                        earlierExhausted: !done.hasMore,
                        earlierUnsupported: done.unsupported === true,
                    }));
                },
                onNotice: (notice) => {
                    if (!disposed) onNotice(notice);
                },
                onResumed: () => {
                    if (!disposed) setState((s) => ({ ...s, phase: 'live' }));
                },
                onClosed: (close: LogSocketClose) => {
                    clearTimeout(slowTimer);
                    clearTimeout(abandonTimer);
                    if (disposed) return;
                    const verdict = logCloseVerdict(close, closedByUs);
                    if (verdict === 'closed') return;
                    if (verdict === 'refused') {
                        const error: LogsError = close.mintError ?? {
                            code: (close.linkReason ?? 'internal') as LogsError['code'],
                            hint: close.hint,
                            details: {},
                            status: 0,
                        };
                        setState((s) => ({
                            ...s,
                            following: false,
                            phase: error.code === 'kill_switch' ? 'stopped' : 'error',
                            stopReason: error.code === 'kill_switch' ? 'kill-switch' : s.stopReason,
                            error,
                        }));
                        return;
                    }
                    if (verdict === 'lost' || attempt.current >= RETRY_LIMIT) {
                        setState((s) => ({ ...s, following: false, phase: 'stopped', stopReason: 'lost' }));
                        return;
                    }
                    // A transient drop: reconnect with backoff, keeping the lines (U8).
                    attempt.current += 1;
                    setState((s) => ({ ...s, phase: 'reconnecting' }));
                    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt.current - 1));
                    retryTimer = setTimeout(() => {
                        if (!disposed) setGeneration((value) => value + 1);
                    }, wait);
                },
            },
            { fetchImpl: browserApiFetch },
        );
        socketRef.current = socket;
        void socket.start();

        // FR-24: navigating away or closing the tab ends the channel (and the node's reader).
        return () => {
            disposed = true;
            closedByUs = true;
            clearTimeout(slowTimer);
            clearTimeout(abandonTimer);
            if (retryTimer) clearTimeout(retryTimer);
            socket.close();
            if (socketRef.current === socket) socketRef.current = null;
        };
    }, [nodeId, key, lines, follow, generation]);

    const pause = useCallback(() => {
        pausedRef.current = true;
        setState((s) => ({ ...s, paused: true, pausedCount: 0 }));
    }, []);

    const resume = useCallback(() => {
        pausedRef.current = false;
        const held = heldWhilePaused.current;
        heldWhilePaused.current = [];
        setState((s) => ({
            ...s,
            paused: false,
            pausedCount: 0,
            window: appendHeld(s.window, held),
            appended: s.appended + held.length,
        }));
    }, []);

    const stopFollowing = useCallback(() => {
        socketRef.current?.stopFollowing();
        setState((s) => ({ ...s, following: false, stopReason: 'not-following' }));
    }, []);

    const startFollowing = useCallback(() => {
        socketRef.current?.follow();
        setState((s) => ({ ...s, following: true, stopReason: null }));
    }, []);

    const loadEarlier = useCallback((src = 0) => {
        socketRef.current?.earlier(src);
        setState((s) => ({ ...s, loadingEarlier: true, prepended: 0 }));
    }, []);

    return { state, pause, resume, reopen, stopFollowing, startFollowing, loadEarlier };
}
