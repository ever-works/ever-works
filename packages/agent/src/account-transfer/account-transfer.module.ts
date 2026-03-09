import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { AccountExportService } from './account-export.service';
import { AccountImportService } from './account-import.service';
import { GitHubSyncService } from './github-sync.service';
import { UserSyncConfig } from './entities/user-sync-config.entity';
import { UserSyncConfigRepository } from './repositories/user-sync-config.repository';

@Module({
    imports: [DatabaseModule, FacadesModule, TypeOrmModule.forFeature([UserSyncConfig])],
    providers: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
    ],
    exports: [
        AccountExportService,
        AccountImportService,
        GitHubSyncService,
        UserSyncConfigRepository,
    ],
})
export class AccountTransferModule {}
