import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import {
    fleetScheduleFailureStreak,
    FLEET_SCHEDULE_FAILURE_ALERT,
    FLEET_SCHEDULE_FAILURE_PAUSE,
    type FleetCommandRunStatus,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { FleetCommand } from '../../entities/fleet-command.entity';
import type { FleetCommandRun } from '../../entities/fleet-command-run.entity';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import { FleetScheduleRepository } from './fleet-schedule.repository';
import { isCountedFleetScheduleRun } from './fleet-schedule.view';

/**
 * Schedules on computers (FL-13, spec S7, FR-24, CONTRACTS §4.6, R-23) — the
 * `schedule-failed` producer. One `warn` item per schedule, raised when its
 * last {@link FLEET_SCHEDULE_FAILURE_ALERT} counted runs failed (or timed
 * out), or when its last run was skipped because the computer was asleep
 * past the grace window; it clears on the next successful run because it is
 * computed from the runs on every read (never stored). A schedule the streak
 * paused (five in a row) keeps its item until it is resumed and passes.
 *
 * Only the viewer's OWN schedules: a schedule's name and command are its
 * author's, so another person looking at the same computer sees nothing of
 * them here.
 */
export function scheduleFailedItems(
    nodes: readonly FleetNodeView[],
    schedules: ReadonlyMap<string, readonly FleetCommand[]>,
    runs: ReadonlyMap<string, readonly FleetCommandRun[]>,
    context: Pick<NeedsALookContext, 'userId' | 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of nodes) {
        for (const schedule of schedules.get(node.id) ?? []) {
            if (schedule.userId !== context.userId || schedule.deletedAt) continue;
            const counted = (runs.get(schedule.id) ?? []).filter(isCountedFleetScheduleRun);
            const latest = counted.find((run) => run.status !== 'running' && run.status !== 'skipped-overlap');
            if (!latest) continue;
            const streak = fleetScheduleFailureStreak(counted as Array<{ status: FleetCommandRunStatus }>);
            const asleep = latest.status === 'skipped-offline';
            if (streak < FLEET_SCHEDULE_FAILURE_ALERT && !asleep) continue;
            const name = schedule.name ?? 'A schedule';
            const since = toIso(latest.endedAt ?? latest.startedAt) ?? context.now.toISOString();
            const paused = schedule.pausedReason === 'failures';
            items.push({
                id: `schedule-failed:${schedule.id}`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'schedule-failed',
                title: asleep
                    ? `${name} did not run on ${node.name}: it was asleep past the grace window`
                    : streak === 2
                      ? `${name} failed twice on ${node.name}`
                      : `${name} failed ${streak} times in a row on ${node.name}`,
                detail: paused
                    ? `Paused after ${FLEET_SCHEDULE_FAILURE_PAUSE} failures in a row — fix it, then resume it.`
                    : asleep
                      ? 'Install the node as a service so a closed lid still runs it.'
                      : `It pauses itself after ${FLEET_SCHEDULE_FAILURE_PAUSE} failures in a row.`,
                action: { label: 'Open', route: `/fleet/computers/${node.id}?tab=schedules` },
                since,
            });
        }
    }
    return items;
}

@Injectable()
export class FleetScheduleNeedsALookProducer implements NeedsALookProducer, OnModuleInit {
    readonly id = 'fl-13.schedule-failed';
    private readonly logger = new Logger(FleetScheduleNeedsALookProducer.name);

    constructor(
        private readonly schedules: FleetScheduleRepository,
        @Optional() private readonly registry?: NeedsALookService,
    ) {}

    onModuleInit(): void {
        this.registry?.register(this);
    }

    async produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): Promise<NeedsALookItem[]> {
        const byNode = new Map<string, FleetCommand[]>();
        const ids: string[] = [];
        for (const node of nodes) {
            const rows = (await this.schedules.listForNode(node.id)).filter((row) => row.userId === context.userId);
            if (rows.length === 0) continue;
            byNode.set(node.id, rows);
            ids.push(...rows.map((row) => row.id));
        }
        if (ids.length === 0) return [];
        const runs = await this.schedules.findRecentRunsFor(ids, FLEET_SCHEDULE_FAILURE_PAUSE + 2);
        const items = scheduleFailedItems(nodes, byNode, runs, context);
        if (items.length > 0) this.logger.debug(`schedule-failed: ${items.length} item(s)`);
        return items;
    }
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
