import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Cloud computers (FL-17, CONTRACTS §9) — the `FLEET_CLOUD_ENABLED` gate on
 * every `/api/fleet/providers/**` and `/api/fleet/cloud/**` route, applied
 * AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does: a deployment
 * that has not switched cloud computers on must not confirm the surface exists.
 * Read per request, so the switch needs no restart. The R-36 "Remove from
 * Fleet" guard lives in `FleetService` and holds whatever this flag says.
 */
@Injectable()
export class FleetCloudEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isCloudEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
