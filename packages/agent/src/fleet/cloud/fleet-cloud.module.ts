import { Injectable, Module } from '@nestjs/common';
import { config } from '../../config';
import { FacadesModule } from '../../facades/facades.module';
import { FleetModule } from '../fleet.module';
import { FleetSessionsModule } from '../sessions/fleet-sessions.module';
import { CloudIdleNeedsALookProducer } from './cloud-idle.producer';
import { FleetCloudProposalListener } from './fleet-cloud-proposal.listener';
import { FleetCloudService } from './fleet-cloud.service';

/**
 * Cloud computers (FL-17) — the sweeps' narrow facade.
 *
 * The `fleet-cloud-reconcile`, `fleet-cloud-bootstrap-watch` and (P2)
 * `fleet-cloud-usage` / `fleet-cloud-idle` Trigger tasks reach the API over the internal worker RPC, whose allow-list is derived from
 * a service's prototype. Exposing `FleetCloudService` itself would publish
 * create / power / destroy to the worker; this facade publishes exactly the
 * sweeps — reconcile, bootstrap watch and (P2) the cost refresh and the idle
 * policy (the FL-14 / FL-16 reconcile-facade shape).
 */
@Injectable()
export class FleetCloudSweepService {
    constructor(private readonly cloud: FleetCloudService) {}

    /** Hourly (FR-29). Does nothing while `FLEET_CLOUD_ENABLED` is off (read per call). */
    async reconcile(): Promise<{ machines: number; changed: number }> {
        if (!config.fleet.isCloudEnabled()) return { machines: 0, changed: 0 };
        return this.cloud.reconcile();
    }

    /** Every minute (plan §10). Does nothing while `FLEET_CLOUD_ENABLED` is off. */
    async watchBootstrap(): Promise<{ checked: number; changed: number }> {
        if (!config.fleet.isCloudEnabled()) return { checked: 0, changed: 0 };
        return this.cloud.watchBootstrap();
    }

    /** P2 — every 10 minutes (FR-21): the cost snapshots and the provider's month-to-date figure. */
    async refreshUsage(): Promise<{ machines: number; changed: number }> {
        if (!config.fleet.isCloudEnabled()) return { machines: 0, changed: 0 };
        return this.cloud.refreshUsage();
    }

    /** P2 — every 10 minutes, offset 5 (FR-27): the idle policy. Never destroys anything. */
    async evaluateIdle(): Promise<{ machines: number; acted: number }> {
        if (!config.fleet.isCloudEnabled()) return { machines: 0, acted: 0 };
        return this.cloud.evaluateIdle();
    }
}

/**
 * Cloud computers (FL-17) — the agent-side module: `FleetCloudService` (every
 * surface calls it), the sweep facade, the `cloud-idle` needs-a-look producer
 * (registers itself into FL-01's registry) and the listener that runs an
 * Agent's held act once a person approves it. No entity of its own: a cloud
 * computer is a `FleetNode` (README rule 18). The provider is reached through
 * `MachineProviderFacadeService` (FacadesModule) only.
 */
@Module({
    imports: [FleetModule, FleetSessionsModule, FacadesModule],
    providers: [FleetCloudService, FleetCloudSweepService, CloudIdleNeedsALookProducer, FleetCloudProposalListener],
    exports: [FleetCloudService, FleetCloudSweepService],
})
export class FleetCloudModule {}
