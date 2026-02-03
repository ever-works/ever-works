import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { DatabaseModule } from '../database/database.module';

import { AiFacadeService } from './ai.facade';
import { SearchFacadeService } from './search.facade';
import { ScreenshotFacadeService } from './screenshot.facade';
import { ContentExtractorFacadeService } from './content-extractor.facade';
import { DataSourceFacadeService } from './data-source.facade';
import { GitFacadeService } from './git.facade';
import { OAuthFacadeService } from './oauth.facade';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    OAuthFacadeService,
];

/**
 * Facades module providing unified access to AI, Search, Screenshot etc. services.
 *
 * These facades wrap the plugin registry and settings service to provide
 * a consistent interface for pipeline steps. Providers are resolved dynamically
 * from the plugin registry based on capability.
 *
 * Resolution priority:
 * 1. Provider override (explicit request)
 * 2. Directory default provider
 * 3. User default provider
 * 4. First enabled provider
 *
 * Settings are resolved using the 4-level hierarchy:
 * 1. Directory settings
 * 2. User settings
 * 3. Admin settings
 * 4. Plugin defaults
 */
@Module({
    imports: [PluginsModule, DatabaseModule],
    providers: FACADES,
    exports: FACADES,
})
export class FacadesModule {}
