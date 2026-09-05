import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { AgentsModule as AgentAgentsModule } from '@ever-works/agent/agents';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { FleetController } from './fleet.controller';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetAgentAffinityController } from './fleet-agent-affinity.controller';
import { FleetKillSwitchController } from './fleet-kill-switch.controller';
import { FleetPanicController } from './fleet-panic.controller';
import { FleetPanicService } from './fleet-panic.service';
import { FleetMcpCredentialListener } from './fleet-mcp-credential.listener';
import { FleetRunRouterService } from './fleet-run-router.service';
import { FleetRunnerStatusService } from './fleet-runner-status.service';
import {
    buildNodeJobRuntimeProviders,
    NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
    NODE_JOB_RUNTIME_PLUGIN,
    NODE_JOB_RUNTIME_STORE,
} from './node-job-runtime.providers';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from './guards/fleet-node-auth.guard';

/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — thin API module exposing
 * `/api/fleet` over the agent-side `FleetModule` (entities,
 * repositories, enrollment/heartbeat crypto, the job lease protocol and
 * the offline sweep all live there).
 *
 * Five controllers, three trust boundaries — kept apart deliberately:
 *   - `FleetController` — owner-scoped registry management
 *     (session/API-key auth) plus the public token-authenticated
 *     enroll/heartbeat pair.
 *   - `FleetAgentAffinityController` — owner + active-Organization scoped
 *     Agent-to-node scheduling intent (session/API-key auth).
 *   - `FleetPanicController` (EW-778) — owner-scoped drain-all and
 *     cancel-in-flight, plus the read of the global stop flag.
 *   - `FleetKillSwitchController` (EW-778) — PLATFORM-ADMIN set / clear
 *     of the global stop flag and the fleet audit trail
 *     (`IsPlatformAdminGuard`, provided here the way `BudgetsModule`
 *     does it: the guard only injects `UserRepository`, which the
 *     imported `DatabaseModule` supplies — deliberately NOT `AuthModule`,
 *     whose better-auth runtime would otherwise ride into every module
 *     that imports this one).
 *   - `FleetJobsController` — the node work channel (lease / job
 *     heartbeat / complete), node-secret authenticated, public,
 *     fail-closed to one undifferentiated 401.
 *
 * `FleetPanicService` holds the per-node drain that `FleetController`
 * and drain-all BOTH call (one implementation, two routes), and the
 * cancel-in-flight walk over `FleetJobService.cancel` +
 * `AgentRunRepository.cancel`. The clear route resumes parked runs
 * through `RunDispatchGateService.promoteParked`, which is why the
 * agent-side `AgentsModule` is imported here.
 *
 * `FleetRunnerStatusService` is the ONE composer behind both the
 * always-visible runner pill and the router's availability check, so
 * "3 of 4 runners online" and "there is a free runner, send the work
 * locally" can never disagree. The router narrows that check to the
 * runners that could take THE job (Agent affinity + required tags,
 * self-build slice S), asking `FleetJobService` — exported by
 * `AgentFleetModule` — the same affinity question the enqueue path
 * asks. The Task → (Work, Goal) lookup the
 * execution preference is resolved against lives in
 * `fleet-task-scope.resolver.ts` but is PROVIDED by the api-side
 * `TasksModule`, which is the module that has `TaskRepository` — the
 * same split `SubAgentDelegationDepthResolverService` already uses.
 *
 * It is ALSO the operator-side construction site for the `node` job
 * runtime (see `node-job-runtime.providers.ts`): the plugin's dispatcher
 * factory is bound to the real `fleet_jobs` store here, and
 * `FleetRunRouterService` turns "this tenant's runtime is the fleet"
 * into an actual `FleetJobService.enqueue`. The `TenantJobRuntimeConfig`
 * feature registration is what lets the router honour a per-tenant
 * overlay row rather than only the instance-global selector.
 *
 * Both guards are ordinary providers so Nest can inject them (the node
 * guard needs `FleetNodeRepository`, which `AgentFleetModule` exports):
 *   - `FleetEnabledGuard` — the `FLEET_ENABLED` gate on all three controllers,
 *     so the surface cannot end up half-on.
 *   - `FleetNodeAuthGuard` — node-credential authentication for the work
 *     channel, at the edge instead of only inside the services.
 */
@Module({
    imports: [
        AgentFleetModule,
        DatabaseModule,
        // NotificationsModule supplies the producer behind the
        // "local runner fallback → cloud" inbox entry. Imported here
        // rather than injected @Global() so the dependency is visible
        // where the fallback is actually decided.
        NotificationsModule,
        TypeOrmModule.forFeature([TenantJobRuntimeConfig]),
        // EW-778 — `RunDispatchGateService` (resume parked runs on clear)
        // is provided + exported by the agent-side AgentsModule.
        AgentAgentsModule,
        // EW-778 — `IsPlatformAdminGuard` (kill-switch routes) resolves
        // `UserRepository` from `DatabaseModule` above; session auth is the
        // global APP_GUARD. `AuthModule` is NOT imported on purpose: it
        // pulls the better-auth runtime (ESM) into `TasksModule` and every
        // other importer of this module, which is what
        // `tasks.module.di-contract.spec.ts` guards against.
    ],
    controllers: [
        FleetController,
        FleetJobsController,
        FleetAgentAffinityController,
        FleetPanicController,
        FleetKillSwitchController,
    ],
    providers: [
        ...buildNodeJobRuntimeProviders(),
        FleetRunnerStatusService,
        FleetRunRouterService,
        FleetPanicService,
        // Self-build slice Z (EW-796) — revokes a job's run-scoped MCP
        // credentials on EVERY terminal path, by subscribing to the one
        // completion event they all emit. Additive: no edit to
        // `FleetJobService` was needed to make revocation guaranteed.
        FleetMcpCredentialListener,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetNodeAuthGuard,
        IsPlatformAdminGuard,
    ],
    exports: [
        AgentFleetModule,
        // Re-exported so the api-side TasksModule (which imports this
        // module) can inject NotificationService into the fleet-aware
        // dispatcher factory without importing NotificationsModule twice.
        NotificationsModule,
        NODE_JOB_RUNTIME_STORE,
        NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
        NODE_JOB_RUNTIME_PLUGIN,
        FleetRunRouterService,
        FleetRunnerStatusService,
        FleetPanicService,
    ],
})
export class FleetApiModule {}
