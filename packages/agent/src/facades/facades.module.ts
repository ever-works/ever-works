import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';

import { AiFacadeService } from './ai.facade';
import { SearchFacadeService } from './search.facade';
import { ScreenshotFacadeService } from './screenshot.facade';
import { ContentExtractorFacadeService } from './content-extractor.facade';

/**
 * All facade providers
 */
const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
];

/**
 * Facades module providing unified access to AI, Search, and Screenshot services.
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
    imports: [PluginsModule],
    providers: FACADES,
    exports: FACADES,
})
export class FacadesModule {}
