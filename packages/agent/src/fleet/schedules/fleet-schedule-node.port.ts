import type {
    FleetConsents,
    FleetScheduleRunNowParams,
    FleetScheduleRunsResult,
    FleetScheduleSyncParams,
    FleetScheduleSyncResult,
} from '@ever-works/contracts';
import type { FleetCommandPortCaller } from '../commands/fleet-command-node.port';

/**
 * Schedules on computers (FL-13) — how the schedule service reaches a
 * machine: the `schedule` link family (CONTRACTS §3.3, consent `manage`).
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.openChannel` on the `schedule` family) and this package
 * must not import the API. The API binds it (`FleetScheduleLinkAdapter`); a
 * context without it (the worker, a test) reaches no machine — every
 * schedule then reads "will sync when the computer is back", which is the
 * honest answer when there is no link.
 *
 * Each call opens a short-lived channel, sends ONE request and closes it, so
 * it works from whichever API replica holds the link. Every method rejects
 * with the CONTRACTS §8 refusal (`unreachable`, `consent_missing`,
 * `unsupported_on_node` from a node older than schedules, `busy`, …).
 */
export interface FleetScheduleNodePort {
    /** The platform holds the node's link right now (on any API replica). */
    isConnected(nodeId: string): boolean;
    /** What the live link presented, or null without a link. */
    liveConsents(nodeId: string): FleetConsents | null;
    /** Replace the machine's whole set (`schedule.sync`). */
    sync(
        nodeId: string,
        params: FleetScheduleSyncParams,
        caller: FleetCommandPortCaller,
    ): Promise<FleetScheduleSyncResult>;
    /** Runs that ended since `since`, and the ones running (`schedule.runs`). */
    runs(nodeId: string, since: string | null, caller: FleetCommandPortCaller): Promise<FleetScheduleRunsResult>;
    /** Run one schedule now (`schedule.runNow`); `busy` while one runs. */
    runNow(
        nodeId: string,
        params: FleetScheduleRunNowParams,
        caller: FleetCommandPortCaller,
    ): Promise<{ runId: string; startedAt: string }>;
}

export const FLEET_SCHEDULE_NODE_PORT = 'FLEET_SCHEDULE_NODE_PORT' as const;
