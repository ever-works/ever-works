import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { RecordAccessPolicy } from './record-access-policy.service';
import { RecordVisibilityService } from './record-visibility.service';

/**
 * Record visibility (EW-P1-3) — the access policy shared by the task, goal, mission,
 * idea and agent read paths. Import it where a service takes `RecordAccessPolicy`
 * (always `@Optional()`, so a context without it keeps today's owner-only reads).
 */
@Module({
    imports: [
        // `<aggregate>.visibility_changed` goes through the domain-event recorder.
        DomainEventsModule,
        TypeOrmModule.forFeature([
            OrganizationMember,
            Organization,
            Tenant,
            TeamMember,
            Team,
            WorkMember,
            Work,
            TaskAssignee,
            TaskApprover,
            TaskReviewer,
            TaskWatcher,
            Task,
            Goal,
            Mission,
            WorkProposal,
            Agent,
        ]),
    ],
    providers: [RecordAccessPolicy, RecordVisibilityService],
    exports: [RecordAccessPolicy, RecordVisibilityService],
})
export class RecordVisibilityModule {}
