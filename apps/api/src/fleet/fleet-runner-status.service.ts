import { Injectable, Logger } from '@nestjs/common';
import { FleetJobService, FleetService } from '@ever-works/agent/fleet';
import {
    FLEET_NODE_NON_LEASABLE_STATUSES,
    FLEET_RUNNER_STATUS_REFRESH_SEC,
} from '@ever-works/contracts';
import type {
    FleetNodeLoadView,
    FleetNodeView,
    FleetRunnerAvailability,
    FleetRunnerNodeView,
    FleetRunnerStatusView,
} from '@ever-works/contracts';

/**
 * Runner status — ONE composer behind both the sidebar pill and the run
 * router's availability check.
 *
 * That sharing is the point. "3 of 4 runners online" in the pill and
 * "there is a free runner, send the work locally" in the router are the
 * same claim about the same machines; computing them in two places is
 * how a user ends up watching a green pill while every run quietly
 * falls back to the cloud. Both call {@link snapshot}.
 *
 * Composition happens at the API edge rather than inside `FleetService`
 * for the reason the node-list endpoint already documents: the registry
 * (who is enrolled, who beat recently) and the job runtime (who is
 * holding work) are deliberately independent, and the registry does not
 * depend on the queue. A load-lookup failure therefore degrades to
 * "nobody is known to be busy" instead of taking the whole read down —
 * `loadUnavailable` says so honestly rather than silently reporting
 * every machine as idle.
 *
 * Cluster-sourced (`kind: 'k8s'`) nodes are excluded throughout: the
 * platform never leases work onto them, so counting them would have the
 * pill claim capacity that cannot execute anything.
 */
@Injectable()
export class FleetRunnerStatusService {
    private readonly logger = new Logger(FleetRunnerStatusService.name);

    constructor(
        private readonly fleet: FleetService,
        private readonly jobs: FleetJobService,
    ) {}

    /** The full pill payload for one owner. */
    async snapshot(userId: string): Promise<FleetRunnerStatusView> {
        // `listEnrolledForUser`, not `listForUser`: the latter merges
        // live nodes from the user's own Kubernetes clusters, which
        // costs a cluster round-trip on a path polled every 30s and
        // would count machines that can never lease a fleet job.
        const nodes = await this.fleet.listEnrolledForUser(userId);

        let load: Record<string, FleetNodeLoadView> = {};
        let loadUnavailable = false;
        try {
            load = await this.jobs.loadByNodeForUser(userId);
        } catch (err) {
            loadUnavailable = true;
            this.logger.debug(
                `Runner status degraded to registry-only for user ${userId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        const rows = nodes.map((node) => toRunnerView(node, load[node.id] ?? null));
        const online = rows.filter((row) => row.status === 'online');

        return {
            total: rows.length,
            online: online.length,
            busy: online.filter((row) => row.busy).length,
            offline: rows.filter((row) => row.status === 'offline').length,
            drained: rows.filter((row) => row.status === 'paused' || row.status === 'disabled')
                .length,
            refreshIntervalSec: FLEET_RUNNER_STATUS_REFRESH_SEC,
            loadUnavailable,
            nodes: rows,
        };
    }

    /**
     * The narrower read the run router needs: can anything take work
     * right now?
     *
     * `free` counts nodes that are online, LEASABLE and idle. All three
     * conditions earn their place:
     *
     *   - online, because an offline node is not polling and would leave
     *     the job queued while the router believed it had placed it;
     *   - leasable, because a paused or disabled node keeps heartbeating
     *     — that is exactly what makes draining observable instead of a
     *     blackout — so its status alone still reads as "reachable"
     *     while `FleetJobService.lease` refuses it outright. Today
     *     `online` and the non-leasable set are disjoint and the check
     *     is redundant; it is written against
     *     {@link FLEET_NODE_NON_LEASABLE_STATUSES} rather than assuming
     *     that, so adding a future non-leasable status cannot silently
     *     make this over-count;
     *   - idle, because a busy runner is capacity that already has a
     *     tenant.
     *
     * Never throws: an availability read that fails reports zero free
     * runners, which sends a `local-fallback` run to the cloud and
     * leaves a `local-wait` run queued. Both are safe; claiming
     * capacity we could not verify is not.
     */
    async availability(userId: string): Promise<FleetRunnerAvailability> {
        try {
            const status = await this.snapshot(userId);
            const free = status.nodes.filter(
                (node) =>
                    node.status === 'online' &&
                    !FLEET_NODE_NON_LEASABLE_STATUSES.includes(node.status) &&
                    !node.busy,
            );
            return {
                total: status.total,
                online: status.online,
                free: free.length,
            };
        } catch (err) {
            this.logger.warn(
                `Runner availability lookup failed for user ${userId} — treating the fleet as unavailable: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return { total: 0, online: 0, free: 0 };
        }
    }
}

function toRunnerView(node: FleetNodeView, load: FleetNodeLoadView | null): FleetRunnerNodeView {
    const activeJobCount = load?.activeJobCount ?? 0;
    return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        status: node.status,
        lastHeartbeatAt: node.lastHeartbeatAt,
        // Renamed on the wire: `version` is ambiguous the moment a
        // second version (the agent CLI's) appears next to it.
        daemonVersion: node.version,
        cliVersion: node.cliVersion ?? null,
        diskFreeBytes: node.diskFreeBytes ?? null,
        busy: activeJobCount > 0,
        activeJobCount,
        currentJobKind: load?.currentJobKind ?? null,
    };
}
