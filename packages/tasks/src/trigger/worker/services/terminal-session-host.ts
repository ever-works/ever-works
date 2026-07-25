import type { ITerminalStreamPlugin, TerminalSessionHandle } from '@ever-works/plugin';
import { makeTerminalErrorFrame } from '@ever-works/contracts';
import type { TerminalTransportClient } from './terminal-transport.client.js';

/**
 * Worker-side terminal session host (streaming-terminal M6).
 *
 * Orchestrates one live session end-to-end with every seam injectable
 * (the whole byte path tests with a loopback transport and a plain
 * child process — no PTY, no SDK, no network):
 *
 *   1. lifecycle → `starting` (+ provider id, persistent flag)
 *   2. transport up (worker token + WS inbound + batched publish)
 *   3. preamble banner, then `plugin.spawn(...)` pumps the process
 *   4. heartbeat every {@link HEARTBEAT_INTERVAL_MS} while live
 *   5. on exit: lifecycle → `ended` with the mapped reason (the plugin
 *      already published the pinned exit frame BEFORE resolving)
 *
 * Failure honesty: a spawn failure publishes an error banner + a
 * crashed exit through the transport (never a silently-black pane) and
 * still transitions the lifecycle to `ended/crashed`.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface TerminalSessionSpec {
    runId: string;
    command: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    persistent?: boolean;
    /** Kill the child when the inbound socket dies (cost guard). */
    endOnInputClose?: boolean;
}

export interface TerminalSessionResult {
    code: number;
    reason: 'completed' | 'crashed' | 'closed';
    isPty: boolean;
}

export class TerminalSessionHost {
    constructor(
        private readonly plugin: ITerminalStreamPlugin,
        private readonly client: TerminalTransportClient,
        private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
    ) {}

    async run(spec: TerminalSessionSpec): Promise<TerminalSessionResult> {
        await this.client.heartbeat(spec.runId, {
            state: 'starting',
            providerId: this.plugin.providerName,
            persistent: spec.persistent === true,
        });

        const transport = await this.client.createTransport(spec.runId);

        let handle: TerminalSessionHandle;
        try {
            handle = await this.plugin.spawn(
                {
                    runId: spec.runId,
                    command: spec.command,
                    cwd: spec.cwd,
                    env: spec.env,
                    endOnInputClose: spec.endOnInputClose,
                    preamble: [
                        makeTerminalErrorFrame(
                            `starting ${spec.command[0] ?? 'session'} (${this.plugin.providerName})…`,
                        ),
                    ],
                },
                transport,
            );
        } catch (error) {
            // Loud failure: banner + crashed exit + ended lifecycle — a
            // viewer attaching later still learns exactly what happened.
            const message = error instanceof Error ? error.message : String(error);
            transport.publish(makeTerminalErrorFrame(`session failed to start: ${message}`));
            transport.publish({ kind: 'exit', code: -1, reason: 'crashed' });
            await transport.close();
            await this.client.heartbeat(spec.runId, { state: 'ended', endedReason: 'crashed' });
            throw error;
        }

        await this.client.heartbeat(spec.runId, { state: 'attached' });

        const beat = setInterval(() => {
            void this.client.heartbeat(spec.runId, { state: 'attached' });
        }, this.heartbeatIntervalMs);
        beat.unref?.();

        try {
            const outcome = await handle.exited;
            await this.client.heartbeat(spec.runId, {
                state: 'ended',
                endedReason: outcome.reason,
            });
            return { ...outcome, isPty: handle.isPty };
        } finally {
            clearInterval(beat);
        }
    }
}
