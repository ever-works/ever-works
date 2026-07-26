import { Module } from '@nestjs/common';
import { PolicyModule } from '@ever-works/agent/policy';
import { AgentsModule } from '@ever-works/agent/agents';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../auth/auth.module';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { OperatorTenantMergePolicyController } from '../operator/tenant-merge-policy/operator-tenant-merge-policy.controller';
import { MergePolicyController } from './merge-policy.controller';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — thin API module
 * exposing the read-only `GET /api/merge-policy/resolve` preview over the
 * agent-side `PolicyModule` (resolution, deep merge and the single
 * decision point all live there).
 *
 * `WorkModule` supplies `WorkOwnershipService` and `AgentsModule` supplies
 * `AgentRepository` — the two owner-scope checks the controller runs
 * BEFORE resolving anything, so this endpoint can never become a
 * cross-tenant policy oracle.
 *
 * Customer-owned WRITES have no controller here on purpose: a policy is a
 * field on an existing entity, so it is set through that entity's existing
 * PATCH endpoint (Work / Agent / organization) with that entity's existing
 * permission checks — extension, not a parallel surface.
 *
 * The one exception is the TENANT scope, which owns no user-facing entity
 * and therefore no PATCH endpoint to extend. `OperatorTenantMergePolicyController`
 * closes that gap behind `IsPlatformAdminGuard`; see the controller's own
 * header for why a tenant ceiling must not be settable from underneath.
 * `AuthModule` is imported for the same reason
 * `TenantJobRuntimeModule` imports it: the guard extends `AuthSessionGuard`,
 * which injects `Symbol(AUTH_PROVIDER)` and would otherwise crash module
 * init. `DatabaseModule` supplies `TenantRepository` (the write) and
 * `UserRepository` (the guard's `isPlatformAdmin` lookup).
 */
@Module({
    imports: [PolicyModule, WorkModule, AgentsModule, DatabaseModule, AuthModule],
    controllers: [MergePolicyController, OperatorTenantMergePolicyController],
    providers: [IsPlatformAdminGuard],
    exports: [PolicyModule],
})
export class MergePolicyApiModule {}
