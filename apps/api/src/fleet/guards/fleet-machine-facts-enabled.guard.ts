import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * Machine facts (CONTRACTS §9) — the `FLEET_MACHINE_FACTS_ENABLED` gate on
 * every logs (FL-08), services / Docker / processes (FL-09), ports (FL-10)
 * and files (FL-11) route, applied AFTER `FleetEnabledGuard`.
 *
 * Off (the default) answers the same 404 an unmounted route does, for the
 * reason `FleetEnabledGuard` gives: a deployment that has not switched
 * machine facts on must not confirm the surface exists. Read per request,
 * so the switch needs no restart. Written by FL-10 (the first machine-facts
 * epic to land); the sibling epics reuse it.
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
