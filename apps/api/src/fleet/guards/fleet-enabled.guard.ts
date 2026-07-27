import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * The single gate for the WHOLE Fleet surface (`FLEET_ENABLED`).
 *
 * Applied at class level to both fleet controllers, so registry
 * management, the admin endpoints and the node work channel go dark
 * together. A half-disabled Fleet — a settings page with no API, or a
 * lease channel with no registry — would be worse than either state.
 *
 * **404, not 403.** A disabled deployment should not confirm that the
 * surface exists at all: `/api/fleet/**` must look exactly like a route
 * that was never mounted. 403 would answer "yes, Fleet is here, you just
 * can't have it", which is a free reconnaissance answer on a public,
 * node-authenticated channel.
 *
 * The flag defaults to ON (`config.fleet.isEnabled()` returns true
 * unless `FLEET_ENABLED=false`) because Fleet already ships — a
 * default-off flag would silently remove a working feature from every
 * existing deployment on upgrade.
 */
@Injectable()
export class FleetEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
