import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import {
    FleetCommandException,
    FleetScheduleService,
    type FleetCommandPortCaller,
    type FleetScheduleNodePort,
} from '@ever-works/agent/fleet';
import {
    makeFleetLinkError,
    parseFleetScheduleRunsResult,
    parseFleetScheduleSyncResult,
    type FleetConsents,
    type FleetScheduleRunNowParams,
    type FleetScheduleRunsResult,
    type FleetScheduleSyncParams,
    type FleetScheduleSyncResult,
} from '@ever-works/contracts';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import type { FleetLinkCaller } from '../../fleet-link/fleet-link.types';

/** How long the machine has to apply a whole set. */
export const FLEET_SCHEDULE_SYNC_TIMEOUT_MS = 15_000;
/** How long `schedule.runs` may take (up to 500 runs with heads and tails). */
export const FLEET_SCHEDULE_RUNS_TIMEOUT_MS = 30_000;
/** Run now starts within two seconds on an online computer (FR-19); this bounds a slow one. */
export const FLEET_SCHEDULE_RUN_NOW_TIMEOUT_MS = 10_000;
/** A link that just opened is given this long before its set is sent (its own `link.ready` first). */
const LINK_OPEN_DELAY_MS = 2_000;

/**
 * Schedules on computers (FL-13) — `FLEET_SCHEDULE_NODE_PORT` over the node
 * link (FL-02). The agent package's `FleetScheduleService` decides; this only
 * carries one request to the machine and its answer back.
 *
 * Each request opens a short-lived `schedule` channel through
 * `FleetLinkService.openChannel` — so the link's own gate runs first, in its
 * order: the link flag, existence, the kill switch, `manage` against the
 * consents the live link presented, the `schedules` family audience (the
 * caller's role; the platform's own sync and reconcile run as `system`),
 * then "is it connected" on any API replica — sends ONE verb, reads the
 * reply and closes the channel. A `sync` or a `runNow` changes the machine
 * (`stateChanging`, audited by the link as `node.link.channel-open`); a
 * `runs` read does not.
 */
@Injectable()
export class FleetScheduleLinkAdapter implements FleetScheduleNodePort {
    private readonly logger = new Logger(FleetScheduleLinkAdapter.name);

    constructor(private readonly link: FleetLinkService) {}

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    liveConsents(nodeId: string): FleetConsents | null {
        return this.link.liveConsents(nodeId);
    }

    async sync(
        nodeId: string,
        params: FleetScheduleSyncParams,
        caller: FleetCommandPortCaller,
    ): Promise<FleetScheduleSyncResult> {
        const result = await this.call(nodeId, 'schedule.sync', params as unknown as Record<string, unknown>, caller, {
            stateChanging: true,
            timeoutMs: FLEET_SCHEDULE_SYNC_TIMEOUT_MS,
        });
        const parsed = parseFleetScheduleSyncResult(result);
        if (!parsed) throw unreadable('schedule.sync');
        return parsed;
    }

    async runs(nodeId: string, since: string | null, caller: FleetCommandPortCaller): Promise<FleetScheduleRunsResult> {
        const result = await this.call(nodeId, 'schedule.runs', { since }, caller, {
            stateChanging: false,
            timeoutMs: FLEET_SCHEDULE_RUNS_TIMEOUT_MS,
        });
        const parsed = parseFleetScheduleRunsResult(result);
        if (!parsed) throw unreadable('schedule.runs');
        return parsed;
    }

    async runNow(
        nodeId: string,
        params: FleetScheduleRunNowParams,
        caller: FleetCommandPortCaller,
    ): Promise<{ runId: string; startedAt: string }> {
        const result = await this.call(nodeId, 'schedule.runNow', { ...params }, caller, {
            stateChanging: true,
            timeoutMs: FLEET_SCHEDULE_RUN_NOW_TIMEOUT_MS,
            target: params.id,
        });
        const record =
            typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
        return {
            runId: typeof record.runId === 'string' ? record.runId : params.runId,
            startedAt:
                typeof record.startedAt === 'string' && record.startedAt.length <= 40
                    ? record.startedAt
                    : new Date().toISOString(),
        };
    }

    private async call(
        nodeId: string,
        verb: string,
        params: Record<string, unknown>,
        caller: FleetCommandPortCaller,
        options: { stateChanging: boolean; timeoutMs: number; target?: string },
    ): Promise<unknown> {
        let channel: FleetLinkChannel | null = null;
        try {
            channel = await this.link.openChannel({
                nodeId,
                family: 'schedule',
                params: {},
                caller: toLinkCaller(caller),
                requirement: {
                    consent: 'manage',
                    actionFamily: 'schedules',
                    stateChanging: options.stateChanging,
                    target: options.target ?? null,
                },
            });
            const reply = await channel.request(verb, params, { timeoutMs: options.timeoutMs });
            if ('error' in reply) throw new FleetCommandException(reply.error);
            if (!('result' in reply)) throw unreadable(verb);
            return reply.result;
        } finally {
            if (channel && !channel.isClosed) {
                try {
                    channel.close('normal');
                } catch (error) {
                    this.logger.debug(
                        `closing a schedule channel on node ${nodeId} failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
    }
}

/**
 * Schedules on computers (FL-13, FR-11, FR-15) — a link that (re)connected
 * gets its whole set and is asked for the runs it made while it was away, a
 * moment after `link.ready`. Dropped while `FLEET_COMMANDS_ENABLED` is off.
 */
@Injectable()
export class FleetScheduleLinkListener implements OnModuleInit, OnModuleDestroy {
    private readonly stops: Array<() => void> = [];
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    constructor(
        private readonly schedules: FleetScheduleService,
        private readonly registry: FleetLinkRegistry,
    ) {}

    onModuleInit(): void {
        this.stops.push(
            this.registry.onLinkEvent((event) => {
                if (event.type !== 'connected' || !config.fleet.isCommandsEnabled()) return;
                const timer = setTimeout(() => {
                    this.timers.delete(timer);
                    void this.schedules.onLinkOpen(event.nodeId);
                }, LINK_OPEN_DELAY_MS);
                timer.unref?.();
                this.timers.add(timer);
            }),
        );
    }

    onModuleDestroy(): void {
        for (const stop of this.stops.splice(0)) stop();
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}

function toLinkCaller(caller: FleetCommandPortCaller): FleetLinkCaller {
    switch (caller.kind) {
        case 'agent':
            return { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId };
        case 'system':
            return { kind: 'system', job: caller.job };
        case 'user':
        default:
            return { kind: 'user', userId: (caller as { userId: string }).userId };
    }
}

function unreadable(verb: string): FleetCommandException {
    return new FleetCommandException(
        makeFleetLinkError('operation_failed', `the computer answered ${verb} in a way this platform does not understand`),
    );
}
