import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { MergePolicyOverride } from '@ever-works/contracts';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';

/**
 * One scope row, reduced to what policy resolution needs: its stored
 * override plus the parent ids that continue the chain upward.
 */
export interface MergePolicyScopeRow {
    id: string;
    mergePolicy?: MergePolicyOverride | null;
    workId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
}

/**
 * Feature-owned, READ-ONLY repository for the merge-policy matrix
 * (provided by `PolicyModule`, not `DatabaseModule` — same split as
 * `FleetNodeRepository` / `MeetingRepository`).
 *
 * Deliberately projects only the columns resolution needs. Writes go
 * through the owning services (`AgentService.update`,
 * `WorkLifecycleService.updateWork`, `OrganizationService.update`), which
 * already own validation and ownership checks for their entity — this
 * feature adds one field to each, not a second write path.
 */
@Injectable()
export class MergePolicyScopeRepository {
    constructor(
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(Tenant)
        private readonly tenants: Repository<Tenant>,
    ) {}

    async findAgent(id: string): Promise<MergePolicyScopeRow | null> {
        const row = await this.agents.findOne({
            where: { id },
            select: ['id', 'mergePolicy', 'workId', 'organizationId', 'tenantId'],
        });
        return row ?? null;
    }

    async findWork(id: string): Promise<MergePolicyScopeRow | null> {
        const row = await this.works.findOne({
            where: { id },
            select: ['id', 'mergePolicy', 'organizationId', 'tenantId'],
        });
        return row ?? null;
    }

    async findOrganization(id: string): Promise<MergePolicyScopeRow | null> {
        const row = await this.organizations.findOne({
            where: { id },
            select: ['id', 'mergePolicy', 'tenantId'],
        });
        return row ?? null;
    }

    async findTenant(id: string): Promise<MergePolicyScopeRow | null> {
        const row = await this.tenants.findOne({
            where: { id },
            select: ['id', 'mergePolicy'],
        });
        return row ?? null;
    }
}
