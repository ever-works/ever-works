import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Tenant } from '../entities/tenant.entity';
import { ToolGrant } from '../entities/tool-grant.entity';
import { Work } from '../entities/work.entity';
import { MERGE_POLICY_ENFORCER } from './merge-policy.enforcer';
import { MergePolicyScopeRepository } from './merge-policy.repository';
import { MergePolicyService } from './merge-policy.service';
import { PullRequestGateService } from './pull-request-gate.service';
import { CREDENTIAL_RESOLVER, EnvCredentialResolver } from './credential-resolver';
import { TOOL_GRANT_ENFORCER } from './tool-grant.enforcer';
import { ToolGrantRepository } from './tool-grant.repository';
import { ToolGrantService } from './tool-grant.service';

/**
 * Policy matrices (Wave 3 founder decision D4 + audit items G4/G14) —
 * agent-side module owning policy RESOLUTION and the single decision point
 * for BOTH matrices:
 *
 *  - merge policy  — "may this agent land this pull request?"
 *  - tool grants   — "may this tool be called in this scope?"
 *
 * They share the same tenant → organization → Work → Agent lattice and the
 * same `MergePolicyScopeRepository` parent walk, which is exactly why they
 * live in one module: two copies of a security-relevant scope walk is how
 * the two drift apart.
 *
 * Deliberately a leaf: it imports only the four scope entities plus the
 * `tool_grants` table, so `FacadesModule` (and anything else that has to
 * ask a policy question) can depend on it without creating a cycle. Both
 * enforcer tokens are bound via `useExisting`, so consumers depend on the
 * CONTRACT, never the concrete class.
 *
 * `CREDENTIAL_RESOLVER` defaults to the env-backed resolver
 * (`EVERWORKS_CRED_*`), which is the right answer for self-hosted installs.
 * A multi-tenant deployment overrides the token with a store-backed
 * implementation; nothing else changes.
 *
 * Every entity here MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query. All four have been
 * registered since their own features landed; this module adds no new
 * entity.
 *
 * It also owns `PullRequestGateService` — the quality-gate decision the
 * non-worker pull-request callers route through. It lives here (not in
 * `tasks-domain`) for the same leaf reason: the generator / item-submission
 * / import modules must be able to ask "may this PR open?" without pulling
 * the whole Tasks domain into their graph. It has NO injected dependency,
 * so adding it costs the module nothing.
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Agent, Work, Organization, Tenant, ToolGrant])],
    providers: [
        MergePolicyScopeRepository,
        MergePolicyService,
        { provide: MERGE_POLICY_ENFORCER, useExisting: MergePolicyService },
        PullRequestGateService,
        ToolGrantRepository,
        ToolGrantService,
        { provide: TOOL_GRANT_ENFORCER, useExisting: ToolGrantService },
        EnvCredentialResolver,
        { provide: CREDENTIAL_RESOLVER, useExisting: EnvCredentialResolver },
    ],
    exports: [
        MergePolicyScopeRepository,
        MergePolicyService,
        MERGE_POLICY_ENFORCER,
        PullRequestGateService,
        ToolGrantRepository,
        ToolGrantService,
        TOOL_GRANT_ENFORCER,
        CREDENTIAL_RESOLVER,
    ],
})
export class PolicyModule {}
