import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { TitlerModule } from '../titler/titler.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { User } from '../entities/user.entity';
import { Organization } from '../entities/organization.entity';
import { WorkProposalAttachmentRepository } from '../database/repositories/attachment.repositories';
import { VisionContextService } from '../services/vision-context.service';
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
        // PR-6 — User + Organization back VisionContextService's
        // active-Org vision lookup for Idea-generation prompts.
        TypeOrmModule.forFeature([
            WorkProposal,
            WorkProposalAttachment,
            UserUpload,
            User,
            Organization,
        ]),
    ],
    providers: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
        WorkProposalAttachmentRepository,
        VisionContextService,
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
        VisionContextService,
        UserResearchLimitsService,
    ],
})
export class UserResearchModule {}
