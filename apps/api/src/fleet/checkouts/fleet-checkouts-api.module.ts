import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_CHECKOUT_CREDENTIAL_SCOPE,
    FLEET_CHECKOUT_NODE_PORT,
    FleetCheckoutsModule,
    FleetModule,
} from '@ever-works/agent/fleet';
import { FleetApiModule } from '../fleet.module';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from '../guards/fleet-node-auth.guard';
import {
    FleetCheckoutCredentialScopeAdapter,
    FleetCheckoutCredentialService,
} from './fleet-checkout-credential.service';
import { FleetCheckoutsNodeController } from './fleet-checkouts-node.controller';
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
    // `FleetApiModule` for `FleetPushCredentialService` — the installation-scope
    // resolver the scoped checkout credential reuses (FL-14 P2).
    imports: [FleetCheckoutsModule, FleetModule, FleetApiModule, DatabaseModule],
    controllers: [FleetCheckoutsController, FleetCheckoutsNodeController],
    providers: [
        FleetCheckoutLinkAdapter,
        { provide: FLEET_CHECKOUT_NODE_PORT, useExisting: FleetCheckoutLinkAdapter },
        FleetCheckoutLinkListener,
        FleetCheckoutReconcileCronService,
        // FL-14 P2: the scoped git credential — "does an installation cover it"
        // for create, and the node-authenticated mint.
        FleetCheckoutCredentialScopeAdapter,
        { provide: FLEET_CHECKOUT_CREDENTIAL_SCOPE, useExisting: FleetCheckoutCredentialScopeAdapter },
        FleetCheckoutCredentialService,
        FleetNodeAuthGuard,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetCheckoutsEnabledGuard,
    ],
    exports: [FLEET_CHECKOUT_NODE_PORT, FLEET_CHECKOUT_CREDENTIAL_SCOPE, FleetCheckoutsModule],
})
export class FleetCheckoutsApiModule {}
