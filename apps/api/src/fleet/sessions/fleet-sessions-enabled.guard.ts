import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Sessions on computers (FL-04, CONTRACTS §9) — the `FLEET_SESSIONS_ENABLED`
 * gate on every session route, applied AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does, for the
 * reason `FleetEnabledGuard` gives: a deployment that has not switched
 * sessions on must not confirm the surface exists. Read per request, so the
 * switch needs no restart.
 */
@Injectable()
export class FleetSessionsEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isSessionsEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
