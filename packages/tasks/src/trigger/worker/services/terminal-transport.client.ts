import { config } from '@ever-works/agent/config';
import {
    decodeTerminalFrame,
    encodeTerminalFrame,
    type TerminalFrame,
} from '@ever-works/contracts';
import type { TerminalTransport } from '@ever-works/plugin';

/**
 * Worker-side terminal transport (streaming-terminal M6).
 *
 * Bridges a hosted PTY/pipe process to the API relay:
 *
 *  - **Outbound**: frames buffer briefly and POST in small batches to
 *    `POST /api/internal/terminal/:runId/frames` (x-trigger-secret —
 *    the house internal-API header). Batches flush every
 *    {@link FLUSH_INTERVAL_MS} or at {@link FLUSH_BYTES}, far below the
 *    global 1MB body limit; a 413 response splits and retries once.
 *  - **Inbound**: the worker attaches to the SAME WebSocket gateway as
 *    browsers, with a `role: 'worker'` token brokered by run id via
 *    `POST /:runId/worker-token` (credentials never ride the task
 *    payload). `ws` is loaded via RUNTIME require — the deployed worker
 *    bundle has no global WebSocket (trap: ship `ws`, never assume).
 *  - `close()` flushes every buffered frame and is AWAITED by the
 *    plugin before its handle resolves — the exit frame always lands.
 */
const FLUSH_INTERVAL_MS = 150;
const FLUSH_BYTES = 64 * 1024;
const MAX_BATCH_FRAMES = 512;

interface WsLike {
    on(event: string, cb: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(): void;
    readyState: number;
    OPEN: number;
}

interface WsCtorLike {
    new (url: string): WsLike;
}

export class TerminalTransportClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor() {
        this.baseUrl = (config.trigger.getInternalBaseUrl() || '').replace(/\/$/, '');
        this.secret = config.trigger.getInternalSecret() || '';
        if (!this.baseUrl || !this.secret) {
            throw new Error(
                'Terminal transport requires TRIGGER_INTERNAL_API_URL and TRIGGER_INTERNAL_SECRET.',
            );
        }
    }

    /** Create the transport for one run: worker token + WS + batcher. */
    async createTransport(runId: string): Promise<TerminalTransport> {
        const tokenRes = await this.post(`/api/internal/terminal/${runId}/worker-token`, {});
        const { token, wsPath } = (await tokenRes.json()) as { token: string; wsPath: string };

        const wsUrl = this.baseUrl.replace(/^http/, 'ws') + wsPath;
        const socket = await this.openSocket(wsUrl, token);

        // ── outbound batcher ────────────────────────────────────────
        let buffer: TerminalFrame[] = [];
        let bufferedBytes = 0;
        let timer: NodeJS.Timeout | null = null;
        let flushing: Promise<void> = Promise.resolve();

        const flushNow = async (): Promise<void> => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (buffer.length === 0) return;
            const batch = buffer;
            buffer = [];
            bufferedBytes = 0;
            try {
                const res = await this.post(`/api/internal/terminal/${runId}/frames`, batch);
                if (res.status === 413 && batch.length > 1) {
                    // Split once; single oversize frames are the codec's
                    // problem (it caps them) so no infinite recursion.
                    const mid = Math.ceil(batch.length / 2);
                    await this.post(`/api/internal/terminal/${runId}/frames`, batch.slice(0, mid));
                    await this.post(`/api/internal/terminal/${runId}/frames`, batch.slice(mid));
                }
            } catch {
                // Fire-and-forget for data frames: a transient publish
                // failure loses a window of scrollback, never the session.
            }
        };

        const scheduleFlush = () => {
            if (timer) return;
            timer = setTimeout(() => {
                flushing = flushing.then(flushNow);
            }, FLUSH_INTERVAL_MS);
            timer.unref?.();
        };

        // ── inbound queue ───────────────────────────────────────────
        const inboundQueue: TerminalFrame[] = [];
        let notify: (() => void) | null = null;
        let closed = false;

        socket.on('message', (data: unknown) => {
            const raw =
                typeof data === 'string'
                    ? data
                    : data instanceof Buffer
                      ? new Uint8Array(data)
                      : null;
            if (raw === null) return;
            const frame = decodeTerminalFrame(raw);
            if (frame && (frame.kind === 'stdin' || frame.kind === 'resize')) {
                inboundQueue.push(frame);
                notify?.();
            }
        });
        socket.on('close', () => {
            closed = true;
            notify?.();
        });
        socket.on('error', () => {
            closed = true;
            notify?.();
        });

        return {
            publish: (frame) => {
                const wire = encodeTerminalFrame(frame);
                if (wire === null) return;
                buffer.push(frame);
                bufferedBytes += wire.length;
                if (
                    frame.kind === 'exit' ||
                    bufferedBytes >= FLUSH_BYTES ||
                    buffer.length >= MAX_BATCH_FRAMES
                ) {
                    flushing = flushing.then(flushNow);
                } else {
                    scheduleFlush();
                }
            },
            inbound: () => ({
                [Symbol.asyncIterator]() {
                    return {
                        next(): Promise<IteratorResult<TerminalFrame>> {
                            if (inboundQueue.length > 0) {
                                return Promise.resolve({
                                    value: inboundQueue.shift() as TerminalFrame,
                                    done: false,
                                });
                            }
                            if (closed) {
                                return Promise.resolve({
                                    value: undefined as never,
                                    done: true,
                                });
                            }
                            return new Promise((resolve) => {
                                notify = () => {
                                    notify = null;
                                    if (inboundQueue.length > 0) {
                                        resolve({
                                            value: inboundQueue.shift() as TerminalFrame,
                                            done: false,
                                        });
                                    } else {
                                        resolve({ value: undefined as never, done: true });
                                    }
                                };
                            });
                        },
                    };
                },
            }),
            close: async () => {
                await flushing.then(flushNow);
                closed = true;
                notify?.();
                try {
                    socket.close();
                } catch {
                    // already gone
                }
            },
        };
    }

    /**
     * Best-effort pinned-exit publish for the sweeper: a session whose
     * worker died can't publish its own exit frame, so the sweeper does
     * it post-mortem. The relay pins it for every current/future attach.
     */
    async publishExit(
        runId: string,
        code: number,
        reason: 'completed' | 'crashed' | 'closed' | 'parked',
    ): Promise<void> {
        await this.post(`/api/internal/terminal/${runId}/frames`, [{ kind: 'exit', code, reason }]);
    }

    /** Heartbeat + lifecycle updates (server stamps the timestamp). */
    async heartbeat(
        runId: string,
        body: {
            state?: 'starting' | 'attached' | 'ended';
            endedReason?: 'completed' | 'crashed' | 'closed' | 'parked';
            providerId?: string;
            cliSessionId?: string;
            lastFrameSeq?: number;
            persistent?: boolean;
        },
    ): Promise<void> {
        try {
            await this.post(`/api/internal/terminal/${runId}/heartbeat`, body);
        } catch {
            // Heartbeat loss is survivable; the sweeper's cutoff has slack.
        }
    }

    private async post(path: string, body: unknown): Promise<Response> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-trigger-secret': this.secret,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok && res.status !== 413) {
            throw new Error(`terminal internal API ${path} → ${res.status}`);
        }
        return res;
    }

    private openSocket(wsUrl: string, token: string): Promise<WsLike> {
        // Runtime require: the bundled Trigger.dev runtime has no global
        // WebSocket; `ws` must be shipped and loaded lazily so worker
        // bundling never traces browser-only paths.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { WebSocket: WsCtor } = require('ws') as { WebSocket: WsCtorLike };
        return new Promise((resolve, reject) => {
            const socket = new WsCtor(wsUrl);
            socket.on('open', () => {
                socket.send(JSON.stringify({ kind: 'auth', token }));
                resolve(socket);
            });
            socket.on('error', (err: unknown) => {
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }
}
