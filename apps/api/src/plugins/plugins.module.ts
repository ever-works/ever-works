import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginEntity, UserPluginEntity, DirectoryPluginEntity } from '@packages/agent/plugins';
import { FacadesModule } from '@packages/agent/facades';
import { DirectoryModule } from '@packages/agent/services';
import { AuthModule } from '../auth';

import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { SettingsSchemaValidatorService } from './services';

/**
 * API module for plugin management endpoints.
 * Note: The core PluginsModule from @packages/agent/plugins must be
 * initialized with forRoot() at the app root level for this to work.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([PluginEntity, UserPluginEntity, DirectoryPluginEntity]),
        FacadesModule,
        DirectoryModule,
        AuthModule,
    ],
    controllers: [PluginsController],
    providers: [PluginsService, SettingsSchemaValidatorService],
    exports: [PluginsService, SettingsSchemaValidatorService],
})
export class PluginsModule {}
