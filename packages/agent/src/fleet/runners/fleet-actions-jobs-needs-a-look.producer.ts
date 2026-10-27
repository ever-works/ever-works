import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import {
    fleetActionsJobItemId,
    fleetActionsRunnerCovers,
    type FleetActionsJobView,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import { config } from '../../config';
import type { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import { FleetActionsRunnerRepository } from './fleet-actions-runner.repository';
import { FleetActionsRunnersService } from './fleet-actions-runners.service';

/** The diagnosis sentence of an item (spec §5.5, FR-22). */
export function fleetActionsJobDiagnosisSentence(job: Pick<FleetActionsJobView, 'diagnosis' | 'diagnosisDetail' | 'repository'>): string {
    switch (job.diagnosis) {
        case 'missing-label':
            return `needs label ${job.diagnosisDetail ?? 'a label no runner has'}`;
        case 'offline-matching-runner':
            return `the only matching runner${job.diagnosisDetail ? `, ${job.diagnosisDetail},` : ''} is offline`;
        case 'wrong-scope':
            return `no runner is registered to ${job.diagnosisDetail ?? job.repository}`;
        case 'all-busy':
            return `waiting for ${job.diagnosisDetail ?? 'a runner'}`;
        default:
            return 'no runner has taken it';
    }
}

/**
 * Actions runners on computers (FL-18 P2, spec FR-24, U13, CONTRACTS §4.6) —
 * the `job-unassignable` producer: one `warn` item per queued job of the
 * caller's watched targets that has had no eligible runner for five minutes,
 * with the diagnosis and **Cancel workflow run…**. Read from the jobs the
 * service last fetched for the caller (the panel's 30 s read or the 5-minute
 * poll) — a needs-a-look read never waits on GitHub — so it clears when the
 * job starts or is cancelled. The item sits on the computer of the first of
 * the caller's runners registered for the job's repository (or organisation),
 * else on the first computer the caller has runners on; with none visible,
 * nothing is raised.
 */
export function jobUnassignableItems(
    nodes: readonly FleetNodeView[],
    jobs: readonly FleetActionsJobView[],
    runners: readonly FleetActionsRunner[],
): NeedsALookItem[] {
    const visible = new Set(nodes.map((node) => node.id));
    const own = runners.filter((runner) => visible.has(runner.nodeId) && !runner.removedAt);
    if (own.length === 0) return [];
    const items: NeedsALookItem[] = [];
    for (const job of jobs) {
        if (!job.unassignable) continue;
        const host = own.find((runner) => fleetActionsRunnerCovers(runner, job.repository)) ?? own[0];
        const run = job.runNumber ? ` #${job.runNumber}` : '';
        items.push({
            id: fleetActionsJobItemId(job.repository, job.jobId),
            nodeId: host.nodeId,
            severity: 'warn',
            kind: 'job-unassignable',
            title: `${job.repository} workflow${run} — no runner can take "${job.name}"`.slice(0, 200),
            detail: fleetActionsJobDiagnosisSentence(job).slice(0, 500),
            action: { label: 'Cancel workflow run…', route: `/fleet?actionsJob=${encodeURIComponent(`${job.repository}#${job.runId}`)}` },
            since: job.queuedAt ?? new Date().toISOString(),
        });
    }
    return items;
}

@Injectable()
export class FleetActionsJobsNeedsALookProducer implements NeedsALookProducer, OnModuleInit {
    readonly id = 'fl-18.job-unassignable';
    private readonly logger = new Logger(FleetActionsJobsNeedsALookProducer.name);

    constructor(
        private readonly runners: FleetActionsRunnerRepository,
        private readonly service: FleetActionsRunnersService,
        @Optional() private readonly registry?: NeedsALookService,
    ) {}

    onModuleInit(): void {
        this.registry?.register(this);
    }

    async produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): Promise<NeedsALookItem[]> {
        if (!config.fleet.isActionsRunnersEnabled() || nodes.length === 0) return [];
        const jobs = this.service.cachedJobs(context.userId);
        if (!jobs || jobs.length === 0) return [];
        const runners = await this.runners.listForOwner(context.userId);
        const items = jobUnassignableItems(nodes, jobs, runners);
        if (items.length > 0) this.logger.debug(`job-unassignable: ${items.length} item(s)`);
        return items;
    }
}
