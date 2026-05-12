import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserResearchService } from './user-research.service';
import { WorkProposalService } from './work-proposal.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { UserResearchLimitsService } from './limits';

@Module({
    imports: [DatabaseModule, FacadesModule, TypeOrmModule.forFeature([WorkProposal])],
    providers: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
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
