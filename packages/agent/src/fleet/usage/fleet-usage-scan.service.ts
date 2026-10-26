import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    FLEET_USAGE_SCAN_CAPABILITY,
    FLEET_USAGE_SCAN_INTERVAL_MS,
    fleetUsageOptInHint,
    type FleetJobStatus,
    type FleetJobView,
    type FleetUsageRescanResult,
} from '@ever-works/contracts';
import { config } from '../../config';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetAccessService, fleetOwnerOnlyBody, type FleetCaller } from '../fleet-access.service';
import { FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { fleetUsageError } from './fleet-usage.errors';

/** Jobs that still hold a node's next scan: one of these and the dispatcher waits. */
const ACTIVE: FleetJobStatus[] = ['queued', 'leased', 'running'];

/** Most nodes one dispatcher pass looks at (a pass is cheap: one read, one enqueue each). */
const MAX_NODES_PER_PASS = 2000;

/** What the Usage view says about a computer's last scan. */
export interface FleetUsageScanFacts {
    lastScanAt: Date | null;
    backlogPct: number | null;
}

/**
 * Usage & cost on the fleet (FL-20, plan §10, T-14, T-15) — WHEN a computer is
 * asked to scan, and its "last scan" facts.
 *
 *  - `dispatchDue()` — the 15-minute pass: every ONLINE node that advertises
 *    the `usage-scan` tag (the machine owner's `--usage-scan`, CONTRACTS §1.2)
 *    and has no scan queued or running gets one `usage-scan` job, pinned to
 *    it, with the newest ACKNOWLEDGED watermark as `since`. Never a node
 *    without the tag (the platform never switches the scan on remotely, FR-1);
 *    nothing while `FLEET_USAGE_SCAN_ENABLED` is off or the kill switch is on
 *    (U9 — nodes lease nothing then anyway, so a job would only wait).
 *  - `rescan()` — the owner's "scan now" (`POST /api/fleet/usage/rescan`):
 *    `consent_missing`, `unsupported_on_node`, `unreachable`, `kill_switch`
 *    with CONTRACTS §8 hints (FR-18); an already waiting scan is returned
 *    rather than doubled.
 *
 * Idempotency: `usage-scan:<nodeId>:<15-min bucket>`, so two API replicas (or
 * a replayed tick) enqueue one scan per node per window.
 */
@Injectable()
export class FleetUsageScanService {
    private readonly logger = new Logger(FleetUsageScanService.name);

    constructor(
        @InjectRepository(FleetNode)
        private readonly nodeRows: Repository<FleetNode>,
        @InjectRepository(FleetJob)
        private readonly jobRows: Repository<FleetJob>,
        private readonly jobs: FleetJobService,
        private readonly access: FleetAccessService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
    ) {}

    /** The 15-minute pass. Does nothing while the flag is off. */
    async dispatchDue(now: Date = new Date()): Promise<{ nodes: number; enqueued: number }> {
        if (!config.fleet.isUsageScanEnabled()) return { nodes: 0, enqueued: 0 };
        if (this.killSwitch && (await this.killSwitch.isStopped())) return { nodes: 0, enqueued: 0 };
        const candidates = await this.nodeRows
            .createQueryBuilder('n')
            .where('n.status = :status', { status: 'online' })
            .andWhere('n.capabilities LIKE :tag', { tag: `%"${FLEET_USAGE_SCAN_CAPABILITY}"%` })
            .orderBy('n.lastHeartbeatAt', 'DESC')
            .take(MAX_NODES_PER_PASS)
            .getMany();
        // The LIKE is a coarse pre-filter over the JSON text; the tag must be an exact member.
        const nodes = candidates.filter(
            (node) =>
                Array.isArray(node.capabilities) &&
                node.capabilities.includes(FLEET_USAGE_SCAN_CAPABILITY) &&
                node.consents?.usageScan === true,
        );
        if (nodes.length === 0) return { nodes: 0, enqueued: 0 };
        const busy = await this.activeScanNodes(nodes.map((node) => node.id));
        const window = Math.floor(now.getTime() / FLEET_USAGE_SCAN_INTERVAL_MS);
        let enqueued = 0;
        for (const node of nodes) {
            if (busy.has(node.id)) continue;
            try {
                await this.enqueueFor(node, `usage-scan:${node.id}:${window}`);
                enqueued += 1;
            } catch (error) {
                this.logger.warn(
                    `usage-scan for node ${node.id} could not be enqueued: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return { nodes: nodes.length, enqueued };
    }

    /** The owner's "scan now" (FR-18 codes and hints). */
    async rescan(nodeId: string, caller: FleetCaller, now: Date = new Date()): Promise<FleetUsageRescanResult> {
        const { node, role } = await this.access.resolveVisible(nodeId, caller);
        if (role !== 'owner') throw new ForbiddenException(fleetOwnerOnlyBody(node));
        if (!node.consents) {
            throw fleetUsageError('unsupported_on_node', `update the node on ${node.name}`, { nodeId: node.id });
        }
        if (node.consents.usageScan !== true) {
            throw fleetUsageError('consent_missing', fleetUsageOptInHint(node.name), {
                nodeId: node.id,
                consent: 'usageScan',
            });
        }
        if (!Array.isArray(node.capabilities) || !node.capabilities.includes(FLEET_USAGE_SCAN_CAPABILITY)) {
            throw fleetUsageError(
                'unsupported_on_node',
                `no Claude Code or Codex records were found on ${node.name}, or the node there is too old — update it`,
                { nodeId: node.id },
            );
        }
        if (this.killSwitch && (await this.killSwitch.isStopped())) {
            throw fleetUsageError('kill_switch', 'clear it under Settings → Fleet');
        }
        if (node.status !== 'online') {
            throw fleetUsageError('unreachable', unreachableHint(node), { nodeId: node.id });
        }
        const waiting = await this.jobRows.findOne({
            where: { kind: 'usage-scan', targetNodeId: node.id, status: In(ACTIVE) },
            order: { createdAt: 'DESC' },
        });
        if (waiting) return { jobId: waiting.id };
        const minute = Math.floor(now.getTime() / 60_000);
        const job = await this.enqueueFor(node, `usage-scan:${node.id}:now:${minute}`);
        return { jobId: job.id };
    }

    /** Newest completed scan per node (last-scan age, backlog). */
    async factsFor(nodeIds: readonly string[]): Promise<Map<string, FleetUsageScanFacts>> {
        const out = new Map<string, FleetUsageScanFacts>();
        if (nodeIds.length === 0) return out;
        const rows = await this.jobRows.find({
            where: { kind: 'usage-scan', status: 'done', nodeId: In([...nodeIds]) },
            order: { completedAt: 'DESC' },
            select: { id: true, nodeId: true, completedAt: true, result: true },
            take: Math.min(nodeIds.length * 4, 4000),
        });
        for (const row of rows) {
            if (!row.nodeId || out.has(row.nodeId)) continue;
            const backlog = row.result?.backlogPct;
            out.set(row.nodeId, {
                lastScanAt: row.completedAt ?? null,
                backlogPct: typeof backlog === 'number' && Number.isFinite(backlog) ? backlog : null,
            });
        }
        return out;
    }

    /**
     * The newest watermark the platform STORED for this node (a report the
     * reconciler ingested), or null — the node then resumes from its own
     * acknowledged state (job bodies purged by retention, or no scan yet).
     */
    async acknowledgedWatermark(nodeId: string): Promise<number | null> {
        const rows = await this.jobRows.find({
            where: { kind: 'usage-scan', status: 'done', nodeId },
            order: { completedAt: 'DESC' },
            select: { id: true, result: true },
            take: 10,
        });
        for (const row of rows) {
            const result = row.result;
            if (result && typeof result.ingestedAt === 'string' && typeof result.watermark === 'number') {
                return result.watermark;
            }
        }
        return null;
    }

    private async enqueueFor(node: FleetNode, idempotencyKey: string): Promise<FleetJobView> {
        const since = await this.acknowledgedWatermark(node.id);
        return this.jobs.enqueue({
            userId: node.userId,
            organizationId: node.organizationId ?? null,
            kind: 'usage-scan',
            payload: { nodeId: node.id, since },
            requiredCapabilities: [FLEET_USAGE_SCAN_CAPABILITY],
            // A failed scan is simply the next window's job; retrying it would
            // only delay the fresher one.
            maxAttempts: 1,
            idempotencyKey,
        });
    }

    private async activeScanNodes(nodeIds: readonly string[]): Promise<Set<string>> {
        const busy = new Set<string>();
        for (let i = 0; i < nodeIds.length; i += 200) {
            const rows = await this.jobRows.find({
                where: { kind: 'usage-scan', status: In(ACTIVE), targetNodeId: In(nodeIds.slice(i, i + 200)) },
                select: { id: true, targetNodeId: true },
            });
            for (const row of rows) if (row.targetNodeId) busy.add(row.targetNodeId);
        }
        return busy;
    }
}

function unreachableHint(node: Pick<FleetNode, 'name' | 'lastHeartbeatAt'>): string {
    const at = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : null;
    if (!at) return `${node.name} is offline; the numbers shown are from its last scan`;
    const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
    const age = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
    return `last seen ${age} ago; the numbers shown are from ${node.name}'s last scan`;
}
