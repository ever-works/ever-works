import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { config } from '../../config';
import { FleetCheckout } from '../../entities/fleet-checkout.entity';
import { Work } from '../../entities/work.entity';
import { FleetModule } from '../fleet.module';
import { FleetSessionsModule } from '../sessions/fleet-sessions.module';
import { FleetCheckoutRepository } from './fleet-checkout.repository';
import { FleetCheckoutService } from './fleet-checkout.service';

/**
 * Checkouts on computers (FL-14) — the reconcile sweep's one-member facade.
 *
 * The `fleet-checkout-reconcile` cron reaches the API over the internal
 * worker RPC, whose allow-list is derived from a service's prototype.
 * Exposing `FleetCheckoutService` itself would publish archive / sync to the
 * worker; this facade publishes exactly `reconcile()` and (P3) `purgeBin()`.
 */
@Injectable()
export class FleetCheckoutReconcileService {
    constructor(private readonly checkouts: FleetCheckoutService) {}

    /** Does nothing while `FLEET_CHECKOUTS_ENABLED` is off (the flag is read per call). */
    async reconcile(): Promise<{ swept: number; asked: number }> {
        if (!config.fleet.isCheckoutsEnabled()) return { swept: 0, asked: 0 };
        return this.checkouts.reconcile();
    }

    /** P3 (spec FR-33): the daily bin purge — rows only, never folders. Off with the flag. */
    async purgeBin(): Promise<{ purged: number }> {
        if (!config.fleet.isCheckoutsEnabled()) return { purged: 0 };
        return this.checkouts.purgeBin();
    }
}

/**
 * Checkouts on computers (FL-14) — the agent-side module owning
 * `fleet_checkouts`: the repository, `FleetCheckoutService` (the one writer)
 * and the reconcile facade. The node transport is the
 * `FLEET_CHECKOUT_NODE_PORT` the API binds (`@Optional()`: without it every
 * machine reads unreachable and rows stay as last known).
 *
 * `FleetCheckout` is also registered in `database/_entities-inventory.ts` —
 * this repo has no `autoLoadEntities`.
 */
@Module({
    imports: [FleetModule, FleetSessionsModule, TypeOrmModule.forFeature([FleetCheckout, Work])],
    providers: [FleetCheckoutRepository, FleetCheckoutService, FleetCheckoutReconcileService],
    exports: [FleetCheckoutRepository, FleetCheckoutService, FleetCheckoutReconcileService],
})
export class FleetCheckoutsModule {}
