import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PluginEntity } from '../plugins/entities/plugin.entity';
import { UserPluginEntity } from '../plugins/entities/user-plugin.entity';
import { WorkPluginEntity } from '../plugins/entities/work-plugin.entity';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { AccountExportService } from './account-export.service';
import { AccountImportService } from './account-import.service';
import { GitHubSyncService } from './github-sync.service';
import { UserSyncConfig } from './entities/user-sync-config.entity';
import { UserSyncConfigRepository } from './repositories/user-sync-config.repository';
import { AgentsSkillsTasksExportService } from './agents-skills-tasks-export.service';
import { AgentsSkillsTasksImportService } from './agents-skills-tasks-import.service';
import { AgentsModule } from '../agents/agents.module';
import { SkillsModule } from '../skills/skills.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { AccountExportWorkContentSource, BACKUP_WORK_CONTENT } from './backup/backup-work-content';
import { WorkspaceBackupRunner } from './backup/workspace-backup-runner';
import { WorkspaceBackupService } from './backup/workspace-backup.service';

@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        TypeOrmModule.forFeature([
            UserSyncConfig,
            PluginEntity,
            UserPluginEntity,
            WorkPluginEntity,
        ]),
        // Phase 19 — v2 account-transfer payload tail.
        AgentsModule,
        SkillsModule,
        TasksDomainModule,
    ],
    providers: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
        PluginRepository,
        UserPluginRepository,
        WorkPluginRepository,
        AgentsSkillsTasksExportService,
        AgentsSkillsTasksImportService,
        // AW-22 Workspace backup — the complete, dated archive that sits
        // ALONGSIDE the export/import/config-repo-sync path above, which is
        // untouched. Both surfaces stay: the JSON export is a small,
        // hand-editable file for moving a couple of Works between
        // environments; the archive is a complete artefact for keeping.
        WorkspaceBackupService,
        WorkspaceBackupRunner,
        // The hourly sweep's mutex, for `WorkspaceBackupService.runSweep`.
        // Provided here rather than taken from the caller because the caller
        // is the Trigger worker, which has no DataSource and so cannot build
        // a service that injects `@InjectRepository(CacheEntry)` at all. The
        // repository token is already in scope through `DatabaseModule`,
        // which does `TypeOrmModule.forFeature(ENTITIES)` — `CacheEntry`
        // among them — and re-exports `TypeOrmModule`; the same wiring
        // `NotificationsModule` and `ReleaseModule` use.
        DistributedTaskLockService,
        // The Work content port. Bound HERE, where `AccountExportService`
        // already lives, so the archive reads each Work's items through the
        // very walk the JSON export uses and no second reader exists.
        AccountExportWorkContentSource,
        { provide: BACKUP_WORK_CONTENT, useExisting: AccountExportWorkContentSource },
    ],
    exports: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
        AgentsSkillsTasksExportService,
        AgentsSkillsTasksImportService,
        WorkspaceBackupService,
        WorkspaceBackupRunner,
    ],
})
export class AccountTransferModule {}
