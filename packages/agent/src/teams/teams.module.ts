import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import { OrgChartService } from './org-chart.service';
import { TeamsService } from './teams.service';

/**
 * Teams & Prebuilt Companies — agent-side domain module
 * (`docs/specs/features/teams-and-companies/spec.md` §3).
 *
 * Consumed by the api-side `apps/api/src/teams/teams.module.ts` (controller
 * only, missions-pattern split). Exports the services so the Phase 4
 * company-template importer can reuse them.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Team, TeamMember, Agent, Organization, Tenant, User])],
    providers: [TeamsService, OrgChartService],
    exports: [TeamsService, OrgChartService],
})
export class AgentTeamsModule {}
