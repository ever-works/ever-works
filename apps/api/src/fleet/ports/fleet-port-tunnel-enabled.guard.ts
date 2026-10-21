import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS §9, FR-31) — the
 * `FLEET_PORT_TUNNEL_ENABLED` gate on the preview routes, applied after
 * `FleetEnabledGuard` and `FleetMachineFactsEnabledGuard`. It needs a preview
 * hostname too (`FLEET_PREVIEW_HOST`): without one there is nowhere to serve a
 * tunnel. Off answers the 404 of an unmounted route; read per request.
 */
@Injectable()
export class FleetPortTunnelEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isPortTunnelEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
