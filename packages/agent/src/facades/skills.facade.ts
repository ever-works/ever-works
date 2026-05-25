import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
	FacadeOptions,
	ISkillsProviderPlugin,
	SkillCatalogEntry,
	SkillCatalogListOptions,
	SkillCatalogListResult,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class SkillsFacadeError extends FacadeError {
	constructor(message: string, operation: string, provider?: string, cause?: Error) {
		super(message, operation, provider, cause);
		this.name = 'SkillsFacadeError';
	}
}

/**
 * Skills feature — Phase 8.6 (ADR-012).
 *
 * Resolves enabled `skills-provider` plugins for the user/work scope,
 * fans out catalog reads to each, dedupes by slug (first plugin to
 * surface a slug wins — install-order priority), and returns the
 * union to callers.
 *
 * The platform's `/skills/catalog` API + the `Install` button on
 * `/skills` page go through this facade. Skill resolution at
 * AI-call time goes through `SkillBindingRepository.resolveActive()`
 * directly — bindings reference platform-stored Skill rows, not
 * raw catalog entries.
 */
@Injectable()
export class SkillsFacadeService extends BaseFacadeService {
	protected readonly logger = new Logger(SkillsFacadeService.name);
	protected readonly CAPABILITY = PLUGIN_CAPABILITIES.SKILLS_PROVIDER;

	constructor(
		registry: PluginRegistryService,
		settingsService: PluginSettingsService,
		@Optional() workPluginRepository?: WorkPluginRepository,
	) {
		super(registry, settingsService, workPluginRepository);
	}

	/**
	 * Aggregate `listEntries` across all enabled providers. Dedupes
	 * by slug. Caps `limit` per provider so a chatty provider can't
	 * blow the page size.
	 */
	async listEntries(
		options: SkillCatalogListOptions,
		facadeOptions: FacadeOptions,
	): Promise<SkillCatalogListResult> {
		const plugins = await this.getEnabledPlugins(facadeOptions.workId, facadeOptions.userId);
		if (plugins.length === 0) {
			return { entries: [], total: 0 };
		}

		const seenSlugs = new Set<string>();
		const merged: SkillCatalogEntry[] = [];
		let totalAcrossProviders = 0;

		for (const wrapped of plugins) {
			const plugin = wrapped.plugin as ISkillsProviderPlugin;
			try {
				const settings = this.settingsService
					? await this.settingsService.resolveSettings(plugin.id, facadeOptions).catch(() => undefined)
					: undefined;
				const result = await plugin.listEntries({
					limit: options.limit,
					offset: options.offset,
					tags: options.tags,
					search: options.search,
					settings,
				});
				totalAcrossProviders += result.total;
				for (const entry of result.entries) {
					if (seenSlugs.has(entry.slug)) continue;
					seenSlugs.add(entry.slug);
					merged.push(entry);
				}
			} catch (err) {
				this.logger.warn(
					`Skills provider ${plugin.id} failed to listEntries: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		return { entries: merged, total: totalAcrossProviders };
	}

	async getEntry(
		slug: string,
		facadeOptions: FacadeOptions,
	): Promise<{ entry: SkillCatalogEntry; providerId: string } | null> {
		const plugins = await this.getEnabledPlugins(facadeOptions.workId, facadeOptions.userId);
		for (const wrapped of plugins) {
			const plugin = wrapped.plugin as ISkillsProviderPlugin;
			try {
				const settings = this.settingsService
					? await this.settingsService.resolveSettings(plugin.id, facadeOptions).catch(() => undefined)
					: undefined;
				const entry = await plugin.getEntry(slug, settings);
				if (entry) return { entry, providerId: plugin.id };
			} catch (err) {
				this.logger.warn(
					`Skills provider ${plugin.id} failed to getEntry(${slug}): ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		return null;
	}
}
