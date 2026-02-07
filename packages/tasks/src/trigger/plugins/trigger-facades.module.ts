import { Module } from '@nestjs/common';
import {
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    OAuthFacadeService,
    DeployFacadeService,
} from '@ever-works/agent/facades';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    OAuthFacadeService,
    DeployFacadeService,
];

/**
 * Facades module for Trigger.dev context.
 *
 * Provides the same facade services as FacadesModule but without importing
 * DatabaseModule (which requires a TypeORM connection unavailable in Trigger.dev).
 *
 * All facade dependencies (PluginRegistryService, PluginSettingsService,
 * DirectoryPluginRepository) are provided by the global TriggerPluginsModule.
 */
@Module({
    providers: FACADES,
    exports: FACADES,
})
export class TriggerFacadesModule {}
