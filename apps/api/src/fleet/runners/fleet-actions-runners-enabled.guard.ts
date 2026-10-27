import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Actions runners on computers (FL-18, CONTRACTS §9) — the
 * `FLEET_ACTIONS_RUNNERS_ENABLED` gate on every `/api/fleet/nodes/:id/runners/**`
 * and `/api/fleet/runners/**` route and the node-facing
 * `/api/internal/fleet/runners/**`, applied AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does: a
 * deployment that has not switched runners on must not confirm the surface
 * exists. Read per request, so the switch needs no restart.
 */
@Injectable()
export class FleetActionsRunnersEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isActionsRunnersEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
