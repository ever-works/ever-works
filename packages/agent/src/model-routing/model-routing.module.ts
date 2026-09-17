import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { ModelAccountHealthService } from './model-account-health.service';
import { ModelAccountService } from './model-account.service';
import { ModelPolicyResolver } from './model-policy.resolver';
import { ModelPolicyService } from './model-policy.service';
import { ModelProviderCatalogService } from './model-provider-catalog.service';
import { MODEL_ROUTE_PLANNER } from './model-route-planner.port';
import { ModelRoutePlannerService } from './model-route-planner.service';

/**
 * Model accounts (AW-16) — binds `MODEL_ROUTE_PLANNER` and owns the account,
 * policy and health services.
 *
 * Import direction: `FacadesModule` → here → `DatabaseModule` /
 * `ActivityLogModule`. Nothing here imports the facade layer, so the graph
 * stays acyclic — the same shape `EmailSendPolicyModule` uses to be
 * importable from `FacadesModule`. The plugin registry and settings service
 * are the global providers `PluginsModule.forRoot()` registers.
 *
 * The token is bound with `useExisting` so the facade depends on the
 * CONTRACT, never on the concrete class.
 */
@Module({
    imports: [DatabaseModule, ActivityLogModule],
    providers: [
        ModelProviderCatalogService,
        ModelAccountHealthService,
        ModelAccountService,
        ModelPolicyResolver,
        ModelPolicyService,
        ModelRoutePlannerService,
        { provide: MODEL_ROUTE_PLANNER, useExisting: ModelRoutePlannerService },
    ],
    exports: [
        ModelProviderCatalogService,
        ModelAccountHealthService,
        ModelAccountService,
        ModelPolicyResolver,
        ModelPolicyService,
        ModelRoutePlannerService,
        MODEL_ROUTE_PLANNER,
    ],
})
export class ModelRoutingModule {}
