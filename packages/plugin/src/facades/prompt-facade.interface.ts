import type { IBaseFacade } from './base-facade.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';

/**
 * Prompt facade for resolving prompts from external prompt providers.
 *
 * This facade never throws — it always returns a usable prompt string.
 * When no prompt provider is configured, or the requested key is not found,
 * the provided default prompt is returned unchanged.
 */
export interface IPromptFacade extends IBaseFacade {
	/**
	 * Resolve a prompt by key, falling back to the default if unavailable.
	 *
	 * @param key - Unique prompt key (e.g., 'standard-pipeline.domain-detection')
	 * @param defaultPrompt - Hardcoded fallback prompt template
	 * @param facadeOptions - User/directory context for settings resolution
	 * @returns The resolved prompt template string (provider or default)
	 */
	getPrompt(key: string, defaultPrompt: string, facadeOptions?: FacadeOptions): Promise<string>;
}
