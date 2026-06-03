import { Module } from '@nestjs/common';
import { PluginOperationsService, SettingsSchemaValidatorService } from '@ever-works/agent/plugins';
import { FacadesModule } from '@ever-works/agent/facades';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../auth';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';

import { PluginsController } from './plugins.controller';
import { PluginValidationService } from './plugin-validation.service';
// EW-693 — dynamic plugin distribution API surface.
import { PluginAllowlistController } from './allowlist.controller';
import { PluginCatalogService } from './plugin-catalog.service';

/**
 * API module for plugin management endpoints.
 * Note: The core PluginsModule from @ever-works/agent/plugins must be
 * initialized at the app root level for this to work.
 *
 * EW-693 / Phase 6: the catalog + admin-allowlist controllers are
 * mounted here. `PluginInstallerService` + `PluginAllowlistRepository`
 * come from the agent-level PluginsModule (registered at the app root
 * via `AgentPluginsModule.forRootAsync` in api.module.ts) so the
 * controllers in this module just inject them via DI.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, WorkModule, AuthModule, ActivityLogModule],
    controllers: [PluginsController, PluginAllowlistController],
    providers: [
        PluginOperationsService,
        SettingsSchemaValidatorService,
        PluginValidationService,
        PluginCatalogService,
    ],
    exports: [
        PluginOperationsService,
        SettingsSchemaValidatorService,
        PluginValidationService,
        PluginCatalogService,
    ],
})
export class PluginsModule {}
