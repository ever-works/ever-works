import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { TitlerModule } from '../titler/titler.module';
import { WorkProposal } from '../entities/work-proposal.entity';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { IdeaWork } from '../entities/idea-work.entity';
import { IdeaWorkRepository } from '../database/repositories/idea-work.repository';
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
        ActivityLogModule,
        DatabaseModule,
        // Schedules P2 — provides `ActivityLogService` so
        // `WorkProposalService` can emit `idea_generated` rows for
        // MISSION-sourced generation. `@Optional()`-injected downstream.
        ActivityLogModule,
        FacadesModule,
        TitlerModule,
        // PR-6 — User + Organization back VisionContextService's
        // active-Org vision lookup for Idea-generation prompts.
        TypeOrmModule.forFeature([
            WorkProposal,
            WorkProposalAttachment,
            UserUpload,
            IdeaWork,
            User,
            Organization,
        ]),
    ],
    providers: [
        UserResearchService,
        WorkProposalService,
        WorkProposalRepository,
        IdeaWorkRepository,
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
