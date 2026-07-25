import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';
import { MERGE_POLICY_ENFORCER } from './merge-policy.enforcer';
import { MergePolicyScopeRepository } from './merge-policy.repository';
import { MergePolicyService } from './merge-policy.service';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — agent-side module
 * owning policy RESOLUTION and the single merge decision point.
 *
 * Deliberately a leaf: it imports only the four scope entities, so
 * `FacadesModule` (and anything else that has to ask "may this agent
 * merge?") can depend on it without creating a cycle. It binds
 * `MERGE_POLICY_ENFORCER` to `MergePolicyService` via `useExisting`, so
 * `GitFacadeService` consumes the contract, never the concrete class.
 *
 * The four entities MUST also stay registered in the DataSource ENTITIES
 * array (`database/database.config.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query. All four have been
 * registered since their own features landed; this module adds no new
 * entity.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Agent, Work, Organization, Tenant])],
    providers: [
        MergePolicyScopeRepository,
        MergePolicyService,
        { provide: MERGE_POLICY_ENFORCER, useExisting: MergePolicyService },
    ],
    exports: [MergePolicyScopeRepository, MergePolicyService, MERGE_POLICY_ENFORCER],
})
export class PolicyModule {}
