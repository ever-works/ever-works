import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS §9) — the
 * `FLEET_USAGE_SCAN_ENABLED` gate on every usage route, applied AFTER
 * `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does, for the
 * reason `FleetEnabledGuard` gives: a deployment that has not switched the
 * scan on must not confirm the surface exists. Read per request, so the switch
 * needs no restart.
 */
@Injectable()
export class FleetUsageEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isUsageScanEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
