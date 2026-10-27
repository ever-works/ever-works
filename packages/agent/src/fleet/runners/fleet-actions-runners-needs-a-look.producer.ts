import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import {
    FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN,
    isFleetActionsRunnerStopped,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import { config } from '../../config';
import type { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import { FleetActionsRunnerRepository } from './fleet-actions-runner.repository';

/**
 * Actions runners on computers (FL-18, spec FR-19, U12, CONTRACTS §4.6, R-23)
 * — the `runner-stopped` producer. One `warn` item per runner a person did not
 * stop that has been `offline` for {@link FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN}
 * minutes while its computer is online, with **Start**. Computed from the rows
 * on every read (never stored), so it clears the moment the runner is idle or
 * working again. A stop the owner asked for (`stoppedByOwner`) raises nothing.
 */
export function runnerStoppedItems(
    nodes: readonly FleetNodeView[],
    runners: ReadonlyMap<string, readonly FleetActionsRunner[]>,
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of nodes) {
        const nodeOnline = node.status === 'online';
        for (const runner of runners.get(node.id) ?? []) {
            if (
                !isFleetActionsRunnerStopped({
                    state: runner.state,
                    stoppedByOwner: runner.stoppedByOwner,
                    nodeOnline,
                    lastSeenAt: runner.lastSeenAt ?? null,
                    installedAt: runner.installedAt ?? null,
                    now: context.now,
                })
            ) {
                continue;
            }
            const since = toIso(runner.lastSeenAt ?? runner.installedAt) ?? context.now.toISOString();
            const minutes = Math.max(
                FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN,
                Math.round((context.now.getTime() - Date.parse(since)) / 60_000),
            );
            items.push({
                id: `runner-stopped:${runner.id}`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'runner-stopped',
                title: `${runner.name} stopped`,
                detail: `${runner.target} runner offline for ${minutes} min`,
                action: { label: 'Start', route: `/fleet/computers/${node.id}?runner=${runner.id}` },
                since,
            });
        }
    }
    return items;
}

@Injectable()
export class FleetActionsRunnersNeedsALookProducer implements NeedsALookProducer, OnModuleInit {
    readonly id = 'fl-18.runner-stopped';
    private readonly logger = new Logger(FleetActionsRunnersNeedsALookProducer.name);

    constructor(
        private readonly runners: FleetActionsRunnerRepository,
        @Optional() private readonly registry?: NeedsALookService,
    ) {}

    onModuleInit(): void {
        this.registry?.register(this);
    }

    async produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): Promise<NeedsALookItem[]> {
        if (!config.fleet.isActionsRunnersEnabled() || nodes.length === 0) return [];
        const rows = await this.runners.listForNodes(nodes.map((node) => node.id));
        if (rows.length === 0) return [];
        const byNode = new Map<string, FleetActionsRunner[]>();
        for (const row of rows) {
            const list = byNode.get(row.nodeId) ?? [];
            list.push(row);
            byNode.set(row.nodeId, list);
        }
        const items = runnerStoppedItems(nodes, byNode, context);
        if (items.length > 0) this.logger.debug(`runner-stopped: ${items.length} item(s)`);
        return items;
    }
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
