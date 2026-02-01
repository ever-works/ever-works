/**
 * Facades module exports.
 *
 * These facades provide a unified interface for pipeline steps to access
 * AI, Search, Screenshot, and Content Extraction capabilities through
 * the plugin system.
 */

// Facades Module
export { FacadesModule } from './facades.module';

// Base Facade
export { BaseFacadeService, type BaseFacadeOptions, type DefaultProviderInfo } from './base.facade';

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
    NoContentExtractorProviderError,
    ContentExtractorProviderNotFoundError,
    type ExtendedFacadeExtractionOptions,
} from './content-extractor.facade';

// Data Source Facade
export { DataSourceFacadeService, DataSourceFacadeError } from './data-source.facade';

// Settings Utils
export { getSettingTyped, getSettingWithDefault, type ExpectedSettingType } from './settings-utils';

// Re-export facade types from plugin for convenience
export type { FacadeExtractionOptions, FacadeExtractedContent } from '@ever-works/plugin';
export type {
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
} from '@ever-works/plugin';
