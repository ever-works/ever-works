import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Desktop view & control (FL-07, CONTRACTS §9) — the `FLEET_DESKTOP_ENABLED`
 * gate on every `/api/fleet/nodes/:id/desktop/*` route this epic owns, applied
 * AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does: a deployment
 * that has not switched the Desktop source on must not confirm the surface
 * exists. Read per request, so the switch needs no restart.
 */
@Injectable()
export class FleetDesktopEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isDesktopEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
