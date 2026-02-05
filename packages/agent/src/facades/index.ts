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
export {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
    type BaseFacadeOptions,
    type DefaultProviderInfo,
} from './base.facade';

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

// Git Facade
export {
    GitFacadeService,
    GitFacadeError,
    NoGitProviderError,
    GitProviderNotFoundError,
    NoGitCredentialsError,
    type GitFacadeOptions,
    type GitProviderInfo,
    type FacadeCloneOptions,
    type FacadePushOptions,
} from './git.facade';

// OAuth Facade
export {
    OAuthFacadeService,
    OAuthFacadeError,
    NoOAuthProviderError,
    OAuthProviderNotFoundError,
    OAuthNotSupportedError,
} from './oauth.facade';

// Deploy Facade
export {
    DeployFacadeService,
    DeployFacadeError,
    NoDeployProviderError,
    DeployProviderNotFoundError,
    NoDeployCredentialsError,
    type DeployFacadeFullOptions,
} from './deploy.facade';

// Re-export facade types from plugin for convenience
export type { FacadeExtractionOptions, FacadeExtractedContent } from '@ever-works/plugin';
export type {
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
} from '@ever-works/plugin';
