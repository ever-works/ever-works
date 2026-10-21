import type {
    FleetCommandNodeMessage,
    FleetCommandRunStarted,
    FleetConsents,
} from '@ever-works/contracts';

/**
 * Commands on computers (FL-12) — how the command service reaches a machine.
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.openChannel` on the `command` family) and this package
 * must not import the API. The API binds it (`FleetCommandLinkAdapter`); a
 * context without it (the worker, a test) answers `unreachable` for every
 * machine, which is the honest answer when there is no link.
 *
 * One channel per run, opened with `{ commandId, nodeId, runId }`. `start`
 * resolves once the node said the process runs; everything the machine
 * reports afterwards reaches the `sink` — which is live BEFORE `start`
 * resolves (the channel listens from its first frame).
 */

/** Who the run is for (CONTRACTS §2.3 `requestedBy`). */
export type FleetCommandPortCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string; ownerUserId: string }
    | { kind: 'system'; job: string };

/** What a run's channel reports, in order. Never throws into the transport. */
export interface FleetCommandRunSink {
    /** Output bytes (stdout and stderr interleaved as emitted). */
    data(bytes: Uint8Array): void;
    /** `command.truncated` / `command.timeout` / `command.output`. */
    message(message: FleetCommandNodeMessage): void;
    /** `EXIT [code]`. */
    exit(code: number | null): void;
    /** The channel closed (`normal` after the exit; `resume_failed` when the link did not come back in time). */
    closed(reason: string, hint?: string): void;
    /** The node's link came back and the channel with it. */
    resumed?(): void;
}

export interface FleetCommandStartInput {
    nodeId: string;
    commandId: string;
    runId: string;
    command: string;
    /** Absent = the machine owner's home folder. */
    cwd?: string;
    timeoutSec: number;
    caller: FleetCommandPortCaller;
    sink: FleetCommandRunSink;
}

/** A started run's channel. */
export interface FleetCommandRunHandle {
    /** Close the channel from the platform's side (the node ends a still-running command). */
    close(): void;
}

export interface FleetCommandCancelInput {
    nodeId: string;
    commandId: string;
    runId: string;
    caller: FleetCommandPortCaller;
}

export interface FleetCommandNodePort {
    /** The platform holds the node's link right now (on any API replica). */
    isConnected(nodeId: string): boolean;
    /** What the live link presented, or null without a link. */
    liveConsents(nodeId: string): FleetConsents | null;
    /** Open the run's channel and start the command; rejects with the CONTRACTS §8 refusal. */
    start(
        input: FleetCommandStartInput,
    ): Promise<{ handle: FleetCommandRunHandle; started: FleetCommandRunStarted }>;
    /**
     * Stop one running command (P2 cancel): a short-lived channel of its own,
     * so it works from any API replica — the node finds the run by its id, and
     * the run's own channel then reports the end as usual.
     */
    cancel(input: FleetCommandCancelInput): Promise<void>;
}

export const FLEET_COMMAND_NODE_PORT = 'FLEET_COMMAND_NODE_PORT' as const;
