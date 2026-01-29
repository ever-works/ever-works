/**
 * Facades module exports.
 *
 * These facades provide a unified interface for pipeline steps to access
 * AI, Search, Screenshot, and Content Extraction capabilities through
 * the plugin system.
 */

// Facades Module
export { FacadesModule } from './facades.module';

// AI Facade
export {
    AiFacadeService,
    AiFacadeError,
    NoAiProviderError,
    AiProviderNotFoundError,
    type AiFacadeOptions,
} from './ai.facade';

// Search Facade
export {
    SearchFacadeService,
    SearchFacadeError,
    NoSearchProviderError,
    SearchProviderNotFoundError,
    type ExtendedSearchFacadeOptions,
} from './search.facade';

// Re-export SearchFacadeOptions from plugin for convenience
export type { SearchFacadeOptions } from '@ever-works/plugin';

// Screenshot Facade
export {
    ScreenshotFacadeService,
    ScreenshotFacadeError,
    NoScreenshotProviderError,
    ScreenshotProviderNotFoundError,
    type ScreenshotFacadeOptions,
} from './screenshot.facade';

// Content Extractor Facade
export {
    ContentExtractorFacadeService,
    ContentExtractorFacadeError,
    type ContentExtractorFacadeOptions,
} from './content-extractor.facade';
