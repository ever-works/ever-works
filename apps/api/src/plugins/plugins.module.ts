import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
    PluginEntity,
    UserPluginEntity,
    DirectoryPluginEntity,
    PluginOperationsService,
    SettingsSchemaValidatorService,
} from '@ever-works/agent/plugins';
import { FacadesModule } from '@ever-works/agent/facades';
import { DirectoryModule } from '@ever-works/agent/services';
import { AuthModule } from '../auth';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

import { PluginsController } from './plugins.controller';
import { PluginValidationService } from './plugin-validation.service';
import { CodexLocalAuthService } from './codex-local-auth.service';
import { CodexLocalAuthController } from './codex-local-auth.controller';

/**
 * API module for plugin management endpoints.
 * Note: The core PluginsModule from @ever-works/agent/plugins must be
 * initialized with forRoot() at the app root level for this to work.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([PluginEntity, UserPluginEntity, DirectoryPluginEntity]),
        FacadesModule,
        DirectoryModule,
        AuthModule,
        ActivityLogModule,
    ],
    controllers: [PluginsController, CodexLocalAuthController],
    providers: [
        PluginOperationsService,
        SettingsSchemaValidatorService,
        PluginValidationService,
        CodexLocalAuthService,
    ],
    exports: [
        PluginOperationsService,
        SettingsSchemaValidatorService,
        PluginValidationService,
        CodexLocalAuthService,
    ],
})
export class PluginsModule {}
