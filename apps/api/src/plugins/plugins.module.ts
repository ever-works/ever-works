import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
    PluginEntity,
    UserPluginEntity,
    WorkPluginEntity,
    PluginOperationsService,
    SettingsSchemaValidatorService,
} from '@ever-works/agent/plugins';
import { FacadesModule } from '@ever-works/agent/facades';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../auth';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

import { PluginsController } from './plugins.controller';
import { PluginValidationService } from './plugin-validation.service';

/**
 * API module for plugin management endpoints.
 * Note: The core PluginsModule from @ever-works/agent/plugins must be
 * initialized with forRoot() at the app root level for this to work.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([PluginEntity, UserPluginEntity, WorkPluginEntity]),
        FacadesModule,
        WorkModule,
        AuthModule,
        ActivityLogModule,
    ],
    controllers: [PluginsController],
    providers: [PluginOperationsService, SettingsSchemaValidatorService, PluginValidationService],
    exports: [PluginOperationsService, SettingsSchemaValidatorService, PluginValidationService],
})
export class PluginsModule {}
