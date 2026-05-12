import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserResearchService } from './user-research.service';
import { WorkProposalService } from './work-proposal.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { UserResearchLimitsService } from './limits';

/**
 * EW-584 — packages the tool-calling user-research agent + work-proposal
 * generator. Both can be consumed from the Trigger.dev worker context
 * (heavy lifting) and from the API process (refresh endpoint, controller).
 *
 * Consumer must have PluginsModule.forRoot() registered upstream (it is
 * `@Global()`, so importing it once in the app/worker root is enough).
 */
@Module({
	imports: [DatabaseModule, FacadesModule, TypeOrmModule.forFeature([WorkProposal])],
	providers: [
		UserResearchService,
		WorkProposalService,
		WorkProposalRepository,
		UserResearchLimitsService
	],
	exports: [
		UserResearchService,
		WorkProposalService,
		WorkProposalRepository,
		UserResearchLimitsService
	]
})
export class UserResearchModule {}
