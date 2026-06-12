import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { TitlerModule } from '../titler/titler.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { WorkProposalAttachmentRepository } from '../database/repositories/attachment.repositories';
import { UserResearchService } from './user-research.service';
import { WorkProposalService } from './work-proposal.service';
import { WorkProposalRepository } from './work-proposal.repository';
import {
    buildUserResearchLimitsConfig,
    USER_RESEARCH_LIMITS_CONFIG,
    UserResearchLimitsService,
} from './limits';

@Module({
    // Phase 3 PR I — TitlerModule provides TitlerService for
    // WorkProposalService.createUserManual (replaces its inline
    // deriveTitle placeholder from Phase 1 PR B).
    imports: [
        DatabaseModule,
        FacadesModule,
        TitlerModule,
        TypeOrmModule.forFeature([WorkProposal, WorkProposalAttachment, UserUpload]),
    ],
    providers: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
        WorkProposalAttachmentRepository,
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
        WorkProposalAttachmentRepository,
        UserResearchLimitsService,
    ],
})
export class UserResearchModule {}
