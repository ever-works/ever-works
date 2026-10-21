import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
 * worker; this facade publishes exactly `reconcile()`.
 */
@Injectable()
export class FleetCheckoutReconcileService {
    constructor(private readonly checkouts: FleetCheckoutService) {}

    reconcile(): Promise<{ swept: number; asked: number }> {
        return this.checkouts.reconcile();
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
    imports: [
        FleetModule,
        FleetSessionsModule,
        TypeOrmModule.forFeature([FleetCheckout, Work]),
    ],
    providers: [FleetCheckoutRepository, FleetCheckoutService, FleetCheckoutReconcileService],
    exports: [FleetCheckoutRepository, FleetCheckoutService, FleetCheckoutReconcileService],
})
export class FleetCheckoutsModule {}
