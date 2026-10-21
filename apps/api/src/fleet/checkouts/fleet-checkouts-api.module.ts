import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_CHECKOUT_NODE_PORT,
    FleetCheckoutsModule,
    FleetModule,
} from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetCheckoutLinkAdapter, FleetCheckoutLinkListener } from './fleet-checkout-link.adapter';
import { FleetCheckoutReconcileCronService } from './fleet-checkout-reconcile-cron.service';
import { FleetCheckoutsController } from './fleet-checkouts.controller';
import { FleetCheckoutsEnabledGuard } from './fleet-checkouts-enabled.guard';

/**
 * Checkouts on computers (FL-14) — the API half:
 *
 *   - `FleetCheckoutsController` — `/api/fleet/checkouts[/:id[/refresh|/sync|
 *     /archive|/restore]]` and `/api/fleet/nodes/:id/checkouts` (dark unless
 *     `FLEET_CHECKOUTS_ENABLED`);
 *   - `FleetCheckoutLinkAdapter` — binds the agent package's
 *     `FLEET_CHECKOUT_NODE_PORT` to the node link (FL-02);
 *   - `FleetCheckoutLinkListener` — finished link operations and link opens,
 *     folded into the rows;
 *   - `FleetCheckoutReconcileCronService` — the ten-minute sweep when
 *     Trigger.dev is not the runtime.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side `FleetCheckoutsModule` consumes `FLEET_CHECKOUT_NODE_PORT`
 * `@Optional()` and must not import the API, so the binding is reached
 * through the global scope; and the trigger-internal controller reaches
 * `FleetCheckoutReconcileService` (re-exported here) without importing this
 * module. The adapter needs `FleetLinkService`, which the global
 * `FleetLinkApiModule` exports; nothing it injects needs the checkout service
 * back, so there is no provider cycle.
 */
@Global()
@Module({
    imports: [FleetCheckoutsModule, FleetModule, DatabaseModule],
    controllers: [FleetCheckoutsController],
    providers: [
        FleetCheckoutLinkAdapter,
        { provide: FLEET_CHECKOUT_NODE_PORT, useExisting: FleetCheckoutLinkAdapter },
        FleetCheckoutLinkListener,
        FleetCheckoutReconcileCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetCheckoutsEnabledGuard,
    ],
    exports: [FLEET_CHECKOUT_NODE_PORT, FleetCheckoutsModule],
})
export class FleetCheckoutsApiModule {}
