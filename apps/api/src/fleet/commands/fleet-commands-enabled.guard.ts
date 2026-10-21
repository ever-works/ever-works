import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Commands on computers (FL-12, CONTRACTS §9) — the `FLEET_COMMANDS_ENABLED`
 * gate on every command route, applied AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does: a
 * deployment that has not switched Commands on must not confirm the surface
 * exists. Read per request, so the switch needs no restart.
 */
@Injectable()
export class FleetCommandsEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isCommandsEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
