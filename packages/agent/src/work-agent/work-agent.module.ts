import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAgentGoal } from '../entities/work-agent-goal.entity';
import { WorkAgentPreference } from '../entities/work-agent-preference.entity';
import { WorkAgentRun } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog } from '../entities/work-agent-run-log.entity';
import { DatabaseModule } from '../database/database.module';
import { UserResearchModule } from '../user-research/user-research.module';
import { WorkAgentService } from './work-agent.service';
import { IdeaBuildExecutorService } from './idea-build-executor.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            WorkAgentPreference,
            WorkAgentGoal,
            WorkAgentRun,
            WorkAgentRunLog,
        ]),
        // PR-4 — IdeaBuildExecutorService needs WorkProposalService
        // (handleGoalCompletion) + WorkProposalRepository (markBuilding).
        // UserResearchModule does not import WorkAgentModule, so this
        // introduces no DI cycle.
        UserResearchModule,
    ],
    providers: [WorkAgentService, IdeaBuildExecutorService],
    exports: [WorkAgentService, IdeaBuildExecutorService],
})
export class WorkAgentModule {}
