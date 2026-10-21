import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Checkouts on computers (FL-14, CONTRACTS §9) — the `FLEET_CHECKOUTS_ENABLED`
 * gate on every checkout route, applied AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does, for the
 * reason `FleetEnabledGuard` gives: a deployment that has not switched
 * checkouts on must not confirm the surface exists. Read per request, so the
 * switch needs no restart.
 */
@Injectable()
export class FleetCheckoutsEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isCheckoutsEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
