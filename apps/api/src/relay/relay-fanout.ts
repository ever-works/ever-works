import type { ComputerFanoutBus } from '../computer/computer-relay.registry';
import type { TerminalFanoutBus, TerminalRelayRegistry } from '../terminal/terminal-relay.registry';
import type { RelayBus } from './relay-bus';

/**
 * The terminal and computer relays' cross-replica seams (`TERMINAL_FANOUT_BUS`,
 * `COMPUTER_FANOUT_BUS`) over the relay bus (CONTRACTS R-7, FR-29). Both
 * registries were written for exactly this: a frame published on one replica
 * fans out on the others, never back to the origin; local truth never
 * depends on it.
 *
 * Each message is the pair `[relayKey, wire]` as JSON under the relay's own
 * topic. With the single-replica bus nothing is ever sent — byte for byte
 * the in-process behaviour these registries had before.
 */

function encodePair(key: string, wire: string): string {
    return JSON.stringify([key, wire]);
}

function decodePair(body: string): [string, string] | null {
    try {
        const value: unknown = JSON.parse(body);
        if (
            Array.isArray(value) &&
            value.length === 2 &&
            typeof value[0] === 'string' &&
            typeof value[1] === 'string' &&
            value[0].length > 0 &&
            value[0].length <= 256
        ) {
            return [value[0], value[1]];
        }
    } catch {
        // not ours
    }
    return null;
}

export const RELAY_TERMINAL_TOPIC = 'relay.terminal';
export const RELAY_COMPUTER_TOPIC = 'relay.computer';

/** An ended run another replica published, with no viewer here, is released after this long. */
export const RELAY_TERMINAL_REMOTE_RETENTION_MS = 10 * 60_000;

/**
 * A run another replica published that never ended here — its exit frame was
 * lost, or the publishing replica died first — with no viewer here and no
 * frame for this long, is released too. A later frame of a run that is still
 * alive simply creates it again (with only the history from then on, and only
 * on this replica).
 */
export const RELAY_TERMINAL_REMOTE_IDLE_MS = 60 * 60_000;

/** Most remote-created runs tracked at once (oldest forgotten first). */
const MAX_TRACKED_REMOTE_RUNS = 50_000;

/**
 * The terminal relay over the bus. Every replica keeps the scrollback of a
 * run published elsewhere, so a viewer attaching anywhere sees its history —
 * which means a replica also holds runs it never had a viewer for. The
 * terminal registry releases memory only on request, so this seam tracks the
 * runs it created from peers' frames and {@link sweep} releases each one once
 * it has ended and nobody here watched it for
 * {@link RELAY_TERMINAL_REMOTE_RETENTION_MS} (`RelayBusLifecycle` runs it).
 */
export class RelayTerminalFanoutBus implements TerminalFanoutBus {
    private readonly remoteRuns = new Map<
        string,
        { endedSeenAt: number | null; lastFrameAt: number }
    >();

    constructor(
        private readonly bus: RelayBus,
        private readonly now: () => number = () => Date.now(),
    ) {}

    publishRemote(runId: string, wire: string): void {
        // A run first seen from a peer whose worker now publishes HERE (it
        // reconnected to this replica) is alive: its idle clock restarts.
        const tracked = this.remoteRuns.get(runId);
        if (tracked) tracked.lastFrameAt = this.now();
        this.bus.publish(RELAY_TERMINAL_TOPIC, encodePair(runId, wire));
    }

    onRemote(handler: (runId: string, wire: string) => void): void {
        this.bus.subscribe(RELAY_TERMINAL_TOPIC, (body) => {
            const pair = decodePair(body);
            if (!pair) return;
            const tracked = this.remoteRuns.get(pair[0]);
            if (tracked) tracked.lastFrameAt = this.now();
            else {
                this.remoteRuns.set(pair[0], { endedSeenAt: null, lastFrameAt: this.now() });
                if (this.remoteRuns.size > MAX_TRACKED_REMOTE_RUNS) {
                    const oldest = this.remoteRuns.keys().next().value;
                    if (oldest !== undefined) this.remoteRuns.delete(oldest);
                }
            }
            handler(pair[0], pair[1]);
        });
    }

    /**
     * Release remote-created runs nobody here is watching: ended ones after
     * {@link RELAY_TERMINAL_REMOTE_RETENTION_MS}, and ones that never ended
     * here but went silent for {@link RELAY_TERMINAL_REMOTE_IDLE_MS}. Returns
     * how many were released.
     */
    sweep(
        registry: Pick<TerminalRelayRegistry, 'getStatus' | 'reclaim'>,
        now = this.now(),
    ): number {
        let released = 0;
        for (const [runId, tracked] of [...this.remoteRuns]) {
            const status = registry.getStatus(runId);
            if (!status.exists) {
                this.remoteRuns.delete(runId);
                continue;
            }
            if (status.clientCount > 0) {
                tracked.endedSeenAt = null;
                continue;
            }
            if (!status.ended) {
                tracked.endedSeenAt = null;
                if (now - tracked.lastFrameAt < RELAY_TERMINAL_REMOTE_IDLE_MS) continue;
                // Never ended here: only the idle release frees it. Tracking
                // is dropped only once the session really is gone.
                if (registry.reclaim(runId, { idleRelease: true })) {
                    released += 1;
                    this.remoteRuns.delete(runId);
                }
                continue;
            }
            if (tracked.endedSeenAt === null) {
                tracked.endedSeenAt = now;
                continue;
            }
            if (now - tracked.endedSeenAt < RELAY_TERMINAL_REMOTE_RETENTION_MS) continue;
            if (registry.reclaim(runId, { force: true })) {
                released += 1;
                this.remoteRuns.delete(runId);
            }
        }
        return released;
    }

    /** Runs tracked right now (tests). */
    get trackedRuns(): number {
        return this.remoteRuns.size;
    }
}

/**
 * The computer relay's seam answers whether a peer replica may have taken a
 * frame (its `deliverToNode` reports `requested` to the owner's REST call).
 * Pub/sub cannot say which replica holds a machine's leg, so the answer is
 * "the frame went out and at least one other replica is there" — true when
 * the leg could be elsewhere, false when it certainly is not.
 */
export class RelayComputerFanoutBus implements ComputerFanoutBus {
    constructor(private readonly bus: RelayBus) {}

    publishRemote(sessionId: string, wire: string): boolean {
        return this.bus.publish(RELAY_COMPUTER_TOPIC, encodePair(sessionId, wire));
    }

    onRemote(handler: (sessionId: string, wire: string) => void): void {
        this.bus.subscribe(RELAY_COMPUTER_TOPIC, (body) => {
            const pair = decodePair(body);
            if (pair) handler(pair[0], pair[1]);
        });
    }
}
