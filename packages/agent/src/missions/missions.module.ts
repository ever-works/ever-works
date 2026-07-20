import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mission } from '../entities/mission.entity';
import { MissionAttachment } from '../entities/mission-attachment.entity';
import { MissionWork } from '../entities/mission-work.entity';
import { Work } from '../entities/work.entity';
import { MissionWorkRepository } from '../database/repositories/mission-work.repository';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { MissionAttachmentRepository } from '../database/repositories/attachment.repositories';
import { TitlerModule } from '../titler/titler.module';
import { UserResearchModule } from '../user-research/user-research.module';
import { WorkAgentModule } from '../work-agent/work-agent.module';
import { MissionCloneService } from './mission-clone.service';
import { MissionTemplateManifestService } from './mission-template-manifest.service';
import { MissionsService } from './missions.service';
import { MissionTickService } from './mission-tick.service';

/**
 * Phase 3 PR G — MissionsModule skeleton (Missions/Ideas/Works
 * build). Extended in PR J with the Mission tick worker, which
 * spans three other modules:
 *   - UserResearchModule for `WorkProposalService` (proposal
 *     generator) + `WorkProposalRepository` (outstanding-Ideas
 *     count).
 *   - WorkAgentModule for `WorkAgentService.getPreferences`
 *     (user-level `missionDefaultOutstandingCap` cap fallback).
 *   - TitlerModule (PR I) for the create() title fallback.
 *
 * The tick service is exported so the Trigger.dev task at
 * `packages/tasks/src/tasks/trigger/mission-tick.task.ts` can
 * resolve it from the application context.
 */
@Module({
    imports: [
        // Phase 3 PR HH — MissionCloneService injects
        // Repository<WorkProposal> for the Idea-copy half of Full
        // Fork, so the entity is registered here as well as via
        // UserResearchModule.
        TypeOrmModule.forFeature([
            Mission,
            MissionAttachment,
            MissionWork,
            Work,
            WorkProposal,
            UserUpload,
        ]),
        TitlerModule,
        UserResearchModule,
        WorkAgentModule,
    ],
    providers: [
        MissionsService,
        MissionWorkRepository,
        MissionTickService,
        MissionCloneService,
        MissionTemplateManifestService,
        MissionAttachmentRepository,
    ],
    exports: [
        MissionsService,
        MissionWorkRepository,
        MissionTickService,
        MissionCloneService,
        MissionTemplateManifestService,
        MissionAttachmentRepository,
    ],
})
export class MissionsModule {}
