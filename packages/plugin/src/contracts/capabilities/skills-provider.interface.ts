import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Frontmatter object on a Skill markdown file. Mirrors the Skill
 * entity's `frontmatter` JSON column. Plugins MAY add extra keys;
 * the platform validates the listed subset strictly.
 */
export interface SkillFrontmatter {
	name: string;
	description: string;
	allowedTools?: string[];
	tags?: string[];
	[key: string]: unknown;
}

/**
 * One catalog entry returned by an `ISkillsProviderPlugin`.
 *
 * `body` is the Markdown text WITHOUT the frontmatter — frontmatter
 * is already parsed into the `frontmatter` field. The platform
 * stores both halves separately so it can re-emit a canonical
 * Markdown file on demand.
 */
export interface SkillCatalogEntry {
	slug: string;
	title: string;
	description: string;
	frontmatter: SkillFrontmatter;
	body: string;
	version: string;
	tags: string[];
	sourceUrl?: string;
}

export interface SkillCatalogListOptions {
	limit: number;
	offset: number;
	tags?: string[];
	search?: string;
	settings?: PluginSettings;
}

export interface SkillCatalogListResult {
	entries: SkillCatalogEntry[];
	total: number;
}

export interface SkillCatalogUpdate {
	slug: string;
	oldVersion: string;
	newVersion: string;
}

/**
 * Skills-provider plugin capability — ADR-012.
 *
 * Implementing plugins source a catalog of Skill entries from
 * somewhere (a Git repo, an HTTP API, a local folder). The
 * platform's `SkillsFacadeService` resolves enabled providers,
 * calls their methods, dedupes by slug, and surfaces the union to
 * the Skills UI + `POST /skills/install`.
 *
 * Capability id: `'skills-provider'`.
 */
export interface ISkillsProviderPlugin extends IPlugin {
	readonly providerName: string;

	listEntries(options: SkillCatalogListOptions): Promise<SkillCatalogListResult>;

	getEntry(slug: string, settings?: PluginSettings): Promise<SkillCatalogEntry | null>;

	checkForUpdates?(
		installedVersions: Record<string, string>,
		settings?: PluginSettings,
	): Promise<{ updated: SkillCatalogUpdate[] }>;

	isAvailable?(settings?: PluginSettings): boolean;
}

export function isSkillsProviderPlugin(plugin: IPlugin): plugin is ISkillsProviderPlugin {
	return plugin.capabilities.includes('skills-provider');
}
