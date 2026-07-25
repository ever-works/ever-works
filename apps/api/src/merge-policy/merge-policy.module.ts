import { Module } from '@nestjs/common';
import { PolicyModule } from '@ever-works/agent/policy';
import { AgentsModule } from '@ever-works/agent/agents';
import { WorkModule } from '@ever-works/agent/services';
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
 * There is no controller for WRITES here on purpose: a policy is a field
 * on an existing entity, so it is set through that entity's existing
 * PATCH endpoint (Work / Agent / organization) with that entity's
 * existing permission checks — extension, not a parallel surface.
 */
@Module({
    imports: [PolicyModule, WorkModule, AgentsModule],
    controllers: [MergePolicyController],
    exports: [PolicyModule],
})
export class MergePolicyApiModule {}
