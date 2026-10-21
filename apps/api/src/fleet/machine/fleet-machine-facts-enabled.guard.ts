import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Machine facts (FL-08, FL-09, FL-10 P1, FL-11 — CONTRACTS §9) — the
 * `FLEET_MACHINE_FACTS_ENABLED` gate on every logs, services, Docker,
 * Compose, processes, ports and files route, applied AFTER
 * `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does, for the
 * reason `FleetEnabledGuard` gives: a deployment that has not switched
 * machine facts on must not confirm the surface exists (ACC-FL09-15). Read
 * per request, so the switch needs no restart.
 */
@Injectable()
export class FleetMachineFactsEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!config.fleet.isMachineFactsEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
