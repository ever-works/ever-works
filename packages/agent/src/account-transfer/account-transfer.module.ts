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
    ],
    exports: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
        AgentsSkillsTasksExportService,
        AgentsSkillsTasksImportService,
    ],
})
export class AccountTransferModule {}
