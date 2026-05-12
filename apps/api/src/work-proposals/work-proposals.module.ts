import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserResearchModule } from '@ever-works/agent/user-research';
import { User } from '@ever-works/agent/entities';
import { AuthModule } from '../auth/auth.module';
import { WorkProposalsController } from './work-proposals.controller';
import { WorkProposalsApiService } from './work-proposals.service';
import { UserResearchListener } from './user-research.listener';
import { WorkCreatedLearningListener } from './work-created.listener';
import { ScheduledReRunService } from './scheduled-rerun.service';

@Module({
	imports: [UserResearchModule, AuthModule, TypeOrmModule.forFeature([User])],
	controllers: [WorkProposalsController],
	providers: [
		WorkProposalsApiService,
		UserResearchListener,
		WorkCreatedLearningListener,
		ScheduledReRunService
	],
	exports: [WorkProposalsApiService]
})
export class WorkProposalsModule {}
