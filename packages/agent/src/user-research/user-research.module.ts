import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserResearchService } from './user-research.service';
import { WorkProposalService } from './work-proposal.service';
import { WorkProposalRepository } from './work-proposal.repository';
import {
    buildUserResearchLimitsConfig,
    USER_RESEARCH_LIMITS_CONFIG,
    UserResearchLimitsService,
} from './limits';

@Module({
    imports: [DatabaseModule, FacadesModule, TypeOrmModule.forFeature([WorkProposal])],
    providers: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
        {
            provide: USER_RESEARCH_LIMITS_CONFIG,
            useFactory: buildUserResearchLimitsConfig,
        },
        UserResearchLimitsService,
    ],
    exports: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
        UserResearchLimitsService,
    ],
})
export class UserResearchModule {}
