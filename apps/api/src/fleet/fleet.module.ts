import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { FleetController } from './fleet.controller';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetRunRouterService } from './fleet-run-router.service';
import {
    buildNodeJobRuntimeProviders,
    NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
    NODE_JOB_RUNTIME_PLUGIN,
    NODE_JOB_RUNTIME_STORE,
} from './node-job-runtime.providers';

/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — thin API module exposing
 * `/api/fleet` over the agent-side `FleetModule` (entities,
 * repositories, enrollment/heartbeat crypto, the job lease protocol and
 * the offline sweep all live there).
 *
 * Two controllers, two trust boundaries — kept apart deliberately:
 *   - `FleetController` — owner-scoped registry management
 *     (session/API-key auth) plus the public token-authenticated
 *     enroll/heartbeat pair.
 *   - `FleetJobsController` — the node work channel (lease / job
 *     heartbeat / complete), node-secret authenticated, public,
 *     fail-closed to one undifferentiated 401.
 *
 * It is ALSO the operator-side construction site for the `node` job
 * runtime (see `node-job-runtime.providers.ts`): the plugin's dispatcher
 * factory is bound to the real `fleet_jobs` store here, and
 * `FleetRunRouterService` turns "this tenant's runtime is the fleet"
 * into an actual `FleetJobService.enqueue`. The `TenantJobRuntimeConfig`
 * feature registration is what lets the router honour a per-tenant
 * overlay row rather than only the instance-global selector.
 */
@Module({
    imports: [AgentFleetModule, DatabaseModule, TypeOrmModule.forFeature([TenantJobRuntimeConfig])],
    controllers: [FleetController, FleetJobsController],
    providers: [...buildNodeJobRuntimeProviders(), FleetRunRouterService],
    exports: [
        AgentFleetModule,
        NODE_JOB_RUNTIME_STORE,
        NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
        NODE_JOB_RUNTIME_PLUGIN,
        FleetRunRouterService,
    ],
})
export class FleetApiModule {}
