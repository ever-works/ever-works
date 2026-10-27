import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { config } from '../../config';
import { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';
import { FacadesModule } from '../../facades/facades.module';
import { FleetModule } from '../fleet.module';
import { FleetActionsRunnerRepository } from './fleet-actions-runner.repository';
import { FleetActionsRunnersNeedsALookProducer } from './fleet-actions-runners-needs-a-look.producer';
import { FleetActionsRunnersProposalListener } from './fleet-actions-runners-proposal.listener';
import { FleetActionsRunnersService } from './fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18) — the poll's one-member facade.
 *
 * The `fleet-runners-poll` cron reaches the API over the internal worker RPC,
 * whose allow-list is derived from a service's prototype. Exposing
 * `FleetActionsRunnersService` itself would publish install / control / the
 * token mint to the worker; this facade publishes exactly `reconcile()` (the
 * FL-14 / FL-16 shape).
 */
@Injectable()
export class FleetActionsRunnersPollService {
    constructor(private readonly runners: FleetActionsRunnersService) {}

    /** Does nothing while `FLEET_ACTIONS_RUNNERS_ENABLED` is off (the flag is read per call). */
    async reconcile(): Promise<{ owners: number; runners: number; changed: number }> {
        if (!config.fleet.isActionsRunnersEnabled()) return { owners: 0, runners: 0, changed: 0 };
        return this.runners.reconcile();
    }
}

/**
 * Actions runners on computers (FL-18) — the agent-side module owning
 * `fleet_actions_runners`: the repository, `FleetActionsRunnersService` (the
 * one writer), the poll facade, the `runner-stopped` producer (it registers
 * itself into FL-01's needs-a-look registry) and the listener that runs a held
 * Agent act once a person approves it. GitHub is reached only through the
 * `actions-runners` facade (`FacadesModule`); the node link
 * (`FLEET_MACHINE_NODE_PORT`) is the API's global binding, consumed
 * `@Optional()`.
 *
 * `FleetActionsRunner` is also registered in `database/_entities-inventory.ts`
 * — this repo has no `autoLoadEntities`.
 */
@Module({
    imports: [FleetModule, FacadesModule, TypeOrmModule.forFeature([FleetActionsRunner])],
    providers: [
        FleetActionsRunnerRepository,
        FleetActionsRunnersService,
        FleetActionsRunnersPollService,
        FleetActionsRunnersNeedsALookProducer,
        FleetActionsRunnersProposalListener,
    ],
    exports: [FleetActionsRunnerRepository, FleetActionsRunnersService, FleetActionsRunnersPollService],
})
export class FleetActionsRunnersModule {}
