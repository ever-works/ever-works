import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PluginEntity } from '../plugins/entities/plugin.entity';
import { UserPluginEntity } from '../plugins/entities/user-plugin.entity';
import { DirectoryPluginEntity } from '../plugins/entities/directory-plugin.entity';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { AccountExportService } from './account-export.service';
import { AccountImportService } from './account-import.service';
import { GitHubSyncService } from './github-sync.service';
import { UserSyncConfig } from './entities/user-sync-config.entity';
import { UserSyncConfigRepository } from './repositories/user-sync-config.repository';

@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        TypeOrmModule.forFeature([UserSyncConfig, PluginEntity, UserPluginEntity, DirectoryPluginEntity]),
    ],
    providers: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
        PluginRepository,
        UserPluginRepository,
        DirectoryPluginRepository,
    ],
    exports: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
    ],
})
export class AccountTransferModule {}
