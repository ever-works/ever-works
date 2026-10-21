import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetJobService, FleetNodeHealthService, FleetService } from '@ever-works/agent/fleet';
import {
    hasFleetNodeHealthReading,
    isFleetNodeHealthStale,
    resolveComputerState,
    type FleetNodeHealthView,
    type FleetNodeView,
} from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** `GET /api/fleet/nodes/:id/health` — the shared `FleetNodeHealthView` shape. */
export type FleetNodeHealthResponse = FleetNodeHealthView;

/**
 * Computer health (FL-03) — the read side of a computer's health.
 *
 * `GET /api/fleet/nodes/:id/health` answers the snapshot the row holds (one
 * read, no history join), whether it is stale, and the computer's state
 * sentence with its fix — computed by `resolveComputerState`, the same pure
 * function the cards, the header and the Agent tool use, so no two surfaces
 * can disagree about what state a machine is in.
 *
 * Family: `view` (CONTRACTS §2.1, default org-members; spec §7 "Read health").
 * Visibility is FL-01's `getVisibleForUser`: the owner, and anyone the node is
 * shared with through an Organization, may read it; anyone else gets the 404
 * of an unknown id. A shared reader gets the shared view (no free-text
 * reasons) and no job count — the jobs are the owner's ledger. Reads are not
 * audited (§2.3).
 *
 * The state is judged against the offline window: this read does not run the
 * offline sweep, so a computer silent for longer than
 * `FLEET_NODE_OFFLINE_AFTER_MS` reads `offline` here even while its row still
 * says `online` (FR-30).
 *
 * Refresh now (`POST`), the history and wake arrive in FL-03's next phase on
 * FL-02's link.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetHealthController {
    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
        private readonly history: FleetNodeHealthService,
    ) {}

    @Get('nodes/:id/health')
    @ApiOperation({
        summary:
            "One computer's health: the latest snapshot (CPU, memory, disk, load, uptime, GPU, pending reboot, failed services) stamped with the platform's receipt time, whether it is stale, and its plain-language state with its one fix. Readable by anyone who can see the computer (the `view` family); a computer outside my view answers 404, exactly like an unknown id.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async health(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeHealthResponse> {
        // Visibility first: a 404 here means nothing else is read.
        const { view: node, role } = await this.service.getVisibleForUser(auth.userId, id);
        const withLoad = role === 'owner' ? await this.withLoad(auth.userId, node) : node;
        const now = Date.now();
        const offlineAfterMs = offlineThresholdMs();
        // A row holding only the platform's disk-low marker (an older daemon)
        // has no reading: it answers "no snapshot", never a page of dashes.
        const snapshot = hasFleetNodeHealthReading(node.health) ? (node.health ?? null) : null;
        return {
            nodeId: node.id,
            snapshot,
            stale: isFleetNodeHealthStale(snapshot, now, offlineAfterMs),
            state: resolveComputerState(withLoad, { now, offlineAfterMs }),
            historyEnabled: this.history.isHistoryEnabled(),
        };
    }

    /** The job count behind "Busy · 2 jobs" — best-effort, like the node list. */
    private async withLoad(userId: string, node: FleetNodeView): Promise<FleetNodeView> {
        try {
            const load = await this.jobs.loadByNodeForUser(userId);
            return { ...node, load: load[node.id] ?? null };
        } catch {
            return node;
        }
    }
}

/** The silence after which a node sweeps offline — the same threshold staleness is judged by. */
export function offlineThresholdMs(): number {
    return config.fleet.getNodeOfflineAfterMs();
}
