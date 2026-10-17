import { Module } from '@nestjs/common';
import { RecordVisibilityModule } from '../record-visibility/record-visibility.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import { Work } from '../entities/work.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { OrgChartService } from './org-chart.service';
import { TeamResourcesService } from './team-resources.service';
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
    imports: [
        // Domain events (EW-P1-1 B2) — the publisher the team services record through.
        DomainEventsModule,
        // Record visibility (EW-P1-3) — automatic Team ↔ Organization scope.
        RecordVisibilityModule,
        TypeOrmModule.forFeature([
            Team,
            TeamMember,
            TeamResource,
            Agent,
            Organization,
            Tenant,
            User,
            Work,
            Mission,
            WorkProposal,
            Task,
            Goal,
        ]),
    ],
    providers: [TeamsService, OrgChartService, TeamResourcesService],
    exports: [TeamsService, OrgChartService, TeamResourcesService],
})
export class AgentTeamsModule {}
