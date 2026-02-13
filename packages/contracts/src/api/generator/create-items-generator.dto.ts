import type { ProvidersDto } from './providers.dto.js';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from './generation-method.enum.js';

/**
 * Minimal core DTO for creating/triggering item generation.
 * All pipeline-specific configuration is passed via pluginConfig.
 */
export interface CreateItemsGeneratorDto {
	/** Directory name */
	name: string;
	/** Generation prompt */
	prompt: string;
	/** Method for generation (create-update or recreate) */
	generation_method?: GenerationMethod;
	/** Whether to update with pull request */
	update_with_pull_request?: boolean;
	/** Website repository creation method */
	website_repository_creation_method?: WebsiteRepositoryCreationMethod;
	/** Provider selection */
	providers?: ProvidersDto;
	/** Plugin-specific configuration - structure defined by selected pipeline plugin */
	pluginConfig?: Record<string, unknown>;
}

/**
 * DTO for updating items generator configuration
 */
export interface UpdateItemsGeneratorDto {
	/** Method for generation (create-update or recreate) */
	generation_method?: GenerationMethod;
	/** Whether to update with pull request */
	update_with_pull_request?: boolean;
	/** Provider overrides (pipeline, ai, search, etc.) */
	providers?: ProvidersDto;
}
