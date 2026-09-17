import type {
	IPlaybookProviderPlugin,
	IPlugin,
	JsonSchema,
	PlaybookCatalogListOptions,
	PlaybookCatalogListResult,
	PluginCategory,
	PluginContext,
	PluginSettings
} from '@ever-works/plugin';
import {
	acceptPlaybookEntry,
	catalogSearchRank,
	playbookSearchFields,
	type PlaybookCatalogEntry
} from '@ever-works/contracts';

import { BUILTIN_PLAYBOOKS } from './builtin-catalog.js';

const MAX_PAGE_SIZE = 200;

/** Case-insensitive match against title, tags, outcome, summary and step titles. */
function matchesSearch(entry: PlaybookCatalogEntry, search: string): boolean {
	const fields = playbookSearchFields({ ...entry, stepTitles: entry.steps.map((step) => step.title) });
	return catalogSearchRank(fields, search) !== null;
}

/**
 * First-party `playbook-provider` (AW-21).
 *
 * Serves the built-in Playbook catalogue that ships with the build. Every
 * entry is sanitised (HTML stripped, lengths capped) and then validated before
 * it leaves the plugin, and an entry that fails validation is dropped with a
 * warning rather than thrown — a bad entry must never take the catalogue down.
 */
export class EverWorksPlaybooksPlugin implements IPlugin, IPlaybookProviderPlugin {
	readonly id = 'everworks-playbooks';
	readonly name = 'Ever Works Playbooks';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility' as PluginCategory;
	readonly capabilities: readonly string[] = ['playbook-provider'];
	readonly providerName = 'Ever Works Playbooks';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;
	private catalogue: readonly PlaybookCatalogEntry[] | null = null;

	constructor(private readonly source: readonly unknown[] = BUILTIN_PLAYBOOKS) {}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log(`Ever Works Playbooks provider loaded (${this.entries().length} built-in playbooks).`);
	}

	async onUnload(): Promise<void> {
		this.catalogue = null;
	}

	isAvailable(_settings?: PluginSettings): boolean {
		return true;
	}

	async listPlaybooks(options: PlaybookCatalogListOptions): Promise<PlaybookCatalogListResult> {
		const filtered = this.entries().filter(
			(entry) =>
				(!options.category || entry.category === options.category) &&
				(!options.search || matchesSearch(entry, options.search))
		);
		const offset = Math.max(0, Math.floor(options.offset || 0));
		const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.limit || MAX_PAGE_SIZE)));
		return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
	}

	async getPlaybook(slug: string, _settings?: PluginSettings): Promise<PlaybookCatalogEntry | null> {
		return this.entries().find((entry) => entry.slug === slug) ?? null;
	}

	/** Validated, sanitised, slug-unique entries — computed once and reused. */
	private entries(): readonly PlaybookCatalogEntry[] {
		if (this.catalogue) return this.catalogue;
		const seen = new Set<string>();
		const accepted: PlaybookCatalogEntry[] = [];
		for (const candidate of this.source) {
			const { entry, violation } = acceptPlaybookEntry(candidate);
			if (!entry) {
				this.context?.logger.warn(`Ever Works Playbooks: dropping an invalid entry — ${violation}`);
				continue;
			}
			if (seen.has(entry.slug)) {
				this.context?.logger.warn(`Ever Works Playbooks: dropping a duplicate slug "${entry.slug}"`);
				continue;
			}
			seen.add(entry.slug);
			accepted.push(entry);
		}
		this.catalogue = accepted;
		return accepted;
	}
}
