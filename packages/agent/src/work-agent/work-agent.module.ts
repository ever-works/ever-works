import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkBuildRequest } from '../entities/work-build-request.entity';
import { WorkAgentPreference } from '../entities/work-agent-preference.entity';
import { WorkAgentRun } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog } from '../entities/work-agent-run-log.entity';
import { DatabaseModule } from '../database/database.module';
import { UserResearchModule } from '../user-research/user-research.module';
import { WorkModule } from '../services/work.module';
import { WorkAgentService } from './work-agent.service';
import { IdeaBuildExecutorService } from './idea-build-executor.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            WorkAgentPreference,
            WorkBuildRequest,
            WorkAgentRun,
            WorkAgentRunLog,
        ]),
        // PR-4 — IdeaBuildExecutorService needs WorkProposalService
        // (handleGoalCompletion) + WorkProposalRepository (markBuilding).
        // UserResearchModule does not import WorkAgentModule, so this
        // introduces no DI cycle.
        UserResearchModule,
        // Wave 0.3 — the REAL generation path needs WorkLifecycleService
        // (create Work from Idea) + WorkGenerationService (run/re-run
        // generation). WorkModule imports neither WorkAgentModule nor
        // MissionsModule (verified), so no DI cycle. UserRepository /
        // WorkRepository ride the DatabaseModule import above.
        WorkModule,
    ],
    providers: [WorkAgentService, IdeaBuildExecutorService],
    exports: [WorkAgentService, IdeaBuildExecutorService],
})
export class WorkAgentModule {}
