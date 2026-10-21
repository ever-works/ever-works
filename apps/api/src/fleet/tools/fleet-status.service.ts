import { Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import {
    FleetKillSwitchService,
    FleetService,
    FleetSessionService,
    NeedsALookService,
    composeFleetStatus,
    type FleetStatusReaderPort,
} from '@ever-works/agent/fleet';
import type { FleetKillSwitchState, FleetStatusView, NeedsALookItem } from '@ever-works/contracts';

/** Most live sessions read to count them per computer (one read, never one per node). */
const LIVE_SESSIONS_READ_LIMIT = 200;

/**
 * FL-19 — `GET /api/fleet/status` and the `fleet_status` Agent tool (spec
 * FR-4, S1): "how is my fleet?" in one read.
 *
 * Four reads, run side by side, each degrading on its own so one broken
 * producer never turns the answer into a 500:
 *
 *  - every computer the caller may see (`FleetService.listVisibleForUser` —
 *    own and Organization-shared, each with the caller's role);
 *  - the Needs-a-look list over the persisted ones (a failed producer is
 *    skipped and the view says `needsALookPartial`);
 *  - the fleet kill switch (an unreadable state reads `unverified`, never
 *    "off");
 *  - live sessions per computer, only while `FLEET_SESSIONS_ENABLED` is on
 *    (null otherwise — "unknown", not "none").
 *
 * Read-only: no audit row, no confirmation, no Decision (CONTRACTS §2.3).
 */
@Injectable()
export class FleetStatusService implements FleetStatusReaderPort {
    private readonly logger = new Logger(FleetStatusService.name);

    constructor(
        private readonly fleet: FleetService,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly needsALook?: NeedsALookService,
        @Optional() private readonly sessions?: FleetSessionService,
    ) {}

    async status(userId: string): Promise<FleetStatusView> {
        const nodes = await this.fleet.listVisibleForUser(userId);
        const persisted = nodes.filter((node) => node.persisted);

        const [needs, killSwitch, liveSessions] = await Promise.all([
            this.readNeedsALook(persisted, userId),
            this.readKillSwitch(),
            this.readLiveSessions(userId),
        ]);

        return composeFleetStatus({
            nodes,
            needsALook: needs.items,
            needsALookPartial: needs.partial,
            killSwitch,
            liveSessionsByNode: liveSessions,
            now: new Date(),
        });
    }

    private async readNeedsALook(
        nodes: Parameters<NeedsALookService['forNodes']>[0],
        userId: string,
    ): Promise<{ items: NeedsALookItem[]; partial: boolean }> {
        if (!this.needsALook || nodes.length === 0) return { items: [], partial: false };
        try {
            const result = await this.needsALook.forNodes(nodes, { userId });
            return { items: [...result.items], partial: result.partial };
        } catch (error) {
            this.logger.warn(`fleet status: needs-a-look failed (${errorText(error)})`);
            return { items: [], partial: true };
        }
    }

    private async readKillSwitch(): Promise<FleetKillSwitchState> {
        try {
            return await this.killSwitch.publicState();
        } catch (error) {
            this.logger.warn(`fleet status: kill switch unreadable (${errorText(error)})`);
            return { stopped: false, reason: null, since: null, unverified: true };
        }
    }

    private async readLiveSessions(userId: string): Promise<Map<string, number> | null> {
        if (!this.sessions || !config.fleet.isSessionsEnabled()) return null;
        try {
            const live = await this.sessions.list({ userId }, { state: 'live', limit: LIVE_SESSIONS_READ_LIMIT });
            const counts = new Map<string, number>();
            for (const session of live) counts.set(session.nodeId, (counts.get(session.nodeId) ?? 0) + 1);
            return counts;
        } catch (error) {
            this.logger.warn(`fleet status: live sessions unreadable (${errorText(error)})`);
            return null;
        }
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
