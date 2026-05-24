import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { UserResearchModule } from '@ever-works/agent/user-research';
import { WorkAgentModule } from '@ever-works/agent/work-agent';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { User } from '@ever-works/agent/entities';
import { AuthModule } from '../auth/auth.module';
import { WorkProposalsController } from './work-proposals.controller';
import { WorkProposalsApiService } from './work-proposals.service';
import { UserResearchListener } from './user-research.listener';
import { WorkCreatedLearningListener } from './work-created.listener';
import { ScheduledReRunService } from './scheduled-rerun.service';

@Module({
    imports: [
        UserResearchModule,
        DatabaseModule,
        AuthModule,
        ConfigModule,
        TypeOrmModule.forFeature([User]),
        // Phase 1 PR B — POST /me/work-proposals/:id/build calls
        // WorkAgentService.createGoal() to spin up the build pipeline.
        WorkAgentModule,
    ],
    controllers: [WorkProposalsController],
    providers: [
        WorkProposalsApiService,
        UserResearchListener,
        WorkCreatedLearningListener,
        ScheduledReRunService,
        DistributedTaskLockService,
    ],
    exports: [WorkProposalsApiService],
})
export class WorkProposalsModule {}
