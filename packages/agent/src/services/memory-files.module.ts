import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { TaskAttachment } from '../entities/task-attachment.entity';
import { MissionAttachment } from '../entities/mission-attachment.entity';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import {
    AgentAttachmentRepository,
    MissionAttachmentRepository,
    WorkProposalAttachmentRepository,
} from '../database/repositories/attachment.repositories';
import { TaskAttachmentRepository } from '../database/repositories/task-side.repositories';
import { MemoryFoldersService } from './memory-folders.service';
import { MemoryFilesService } from './memory-files.service';
import { MemoryFolderSyncService } from './memory-folder-sync.service';

/**
 * Memory Files — folder tree + unified file list + manual git sync for
 * the /memory Files area.
 *
 * `MemoryFolderRepository` + `UserUploadRepository` come from
 * `DatabaseModule` (the EW-638 repository inventory). The KB upload and
 * attachment-edge repositories are FEATURE-owned (KnowledgeBaseModule /
 * TasksModule / MissionsModule wire their own instances), so they are
 * provided here too — they are stateless `@InjectRepository` wrappers
 * whose TypeORM tokens resolve through `DatabaseModule`'s
 * `forFeature(ENTITIES)`, exactly the pattern MissionsModule uses.
 *
 * `FacadesModule` supplies `GitFacadeService` for the sync path.
 *
 * `ActivityLogModule` is imported so the `@Optional()`-injected
 * `ActivityLogService` actually resolves here — without it folder
 * create/delete/sync would silently record nothing (same lesson as
 * KnowledgeBaseModule's post-cascade fix).
 */
@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        ActivityLogModule,
        // House pattern (mirrors MissionsModule): a module that provides
        // feature-owned repositories registers their entities itself so
        // the @InjectRepository tokens resolve within THIS module.
        TypeOrmModule.forFeature([
            WorkKnowledgeUpload,
            TaskAttachment,
            MissionAttachment,
            WorkProposalAttachment,
            AgentAttachment,
        ]),
    ],
    providers: [
        WorkKnowledgeUploadRepository,
        TaskAttachmentRepository,
        MissionAttachmentRepository,
        WorkProposalAttachmentRepository,
        AgentAttachmentRepository,
        MemoryFoldersService,
        MemoryFilesService,
        MemoryFolderSyncService,
    ],
    exports: [MemoryFoldersService, MemoryFilesService, MemoryFolderSyncService],
})
export class MemoryFilesModule {}
