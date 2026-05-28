import { Module } from '@nestjs/common';
import { PluginSettingsService } from '@ever-works/agent/plugins';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '../../auth';
import { ComposioController } from './composio.controller';
import { ComposioService } from './composio.service';

/**
 * Composio settings API module (PR-B of EW-684).
 *
 * Exposes /api/plugins/composio/{toolkits,connected-accounts,connect} for
 * the web settings UI. Depends on the core PluginsModule (via
 * `PluginOperationsService`) to resolve the caller's stored Composio API
 * key from their user_plugin settings.
 */
@Module({
    imports: [DatabaseModule, AuthModule],
    controllers: [ComposioController],
    providers: [PluginSettingsService, ComposioService],
    exports: [ComposioService],
})
export class ComposioApiModule {}
