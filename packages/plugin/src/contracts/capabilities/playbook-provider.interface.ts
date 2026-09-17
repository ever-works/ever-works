import type { PlaybookCatalogEntry, PlaybookCategory } from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

export interface PlaybookCatalogListOptions {
	limit: number;
	offset: number;
	category?: PlaybookCategory;
	search?: string;
	settings?: PluginSettings;
}

export interface PlaybookCatalogListResult {
	entries: PlaybookCatalogEntry[];
	total: number;
}

/**
 * Playbook-provider plugin capability (AW-21).
 *
 * Implementing plugins supply catalogue entries for the Playbooks section of
 * the capability catalogue. The platform's `PlaybookCatalogFacadeService`
 * resolves enabled providers for the caller's scope, fans out, validates
 * and sanitises every entry, and dedupes by slug (a strictly higher
 * `version` wins).
 *
 * Entries declare required connections as capability names, never provider
 * ids, so a provider cannot hard-wire one vendor into a playbook.
 *
 * Capability id: `'playbook-provider'`.
 */
export interface IPlaybookProviderPlugin extends IPlugin {
	readonly providerName: string;

	listPlaybooks(options: PlaybookCatalogListOptions): Promise<PlaybookCatalogListResult>;

	getPlaybook(slug: string, settings?: PluginSettings): Promise<PlaybookCatalogEntry | null>;
}

export function isPlaybookProviderPlugin(plugin: IPlugin): plugin is IPlaybookProviderPlugin {
	return plugin.capabilities.includes('playbook-provider');
}
