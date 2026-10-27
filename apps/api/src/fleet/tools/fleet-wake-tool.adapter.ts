import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FleetWakeToolPort } from '@ever-works/agent/fleet';
import { getOptionalProvider } from '@ever-works/agent/utils';
import type { FleetNodeWakeResult } from '@ever-works/contracts';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetHealthController } from '../fleet-health.controller';

/**
 * FL-19 P2 — `fleet_nodes_wake` for an Agent (FL-03's catalogue row), bound
 * under `FLEET_WAKE_TOOL_PORT`.
 *
 * Wake's whole decision lives in FL-03's route (`POST /api/fleet/nodes/:id/wake`):
 * visibility, the target's `machines` audience, the stop switch, "not offline",
 * no hardware address, no sibling on its network, 3 tries in 5 minutes, the
 * `node.wake` audit row. Rather than copy any of it, the Agent's call runs that
 * same handler as the Agent's OWNER (the only fact it reads off the caller is the
 * user id), resolved lazily so this module never imports the fleet API module.
 */
@Injectable()
export class FleetWakeToolAdapter implements FleetWakeToolPort {
    constructor(private readonly moduleRef: ModuleRef) {}

    async wake(userId: string, nodeId: string): Promise<FleetNodeWakeResult> {
        const controller = getOptionalProvider<FleetHealthController>(
            this.moduleRef,
            FleetHealthController,
        );
        if (!controller)
            throw fleetLinkError(
                'unreachable',
                'waking computers is not available on this deployment',
            );
        return controller.wake({ userId } as AuthenticatedUser, nodeId);
    }
}
