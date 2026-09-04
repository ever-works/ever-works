import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    FacadeOptions,
    ISkillsProviderPlugin,
    SkillCatalogEntry,
    SkillCatalogListOptions,
    SkillCatalogListResult,
    SkillCatalogUpdate,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';
import {
    AGENT_PLUGIN_SKILL_SOURCE,
    type AgentPluginSkillSource,
} from '../agent-plugins/skill-source.token';

export class SkillsFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'SkillsFacadeError';
    }
}

const PROVIDER_CATALOG_PAGE_SIZE = 200;
const MAX_PROVIDER_CATALOG_ENTRIES = 5000;

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
        // APPENDED, never inserted. This facade is constructed positionally in
        // tests (`new SkillsFacadeService(registry, settings)`), so putting a
        // new parameter anywhere but last silently rebinds what every existing
        // 2- and 3-argument construction passes.
        @Optional()
        @Inject(AGENT_PLUGIN_SKILL_SOURCE)
        private readonly packageSource?: AgentPluginSkillSource,
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
        // The guard must consider the package source too. Only
        // `everworks-skills` auto-enables, so "no skills-provider plugin
        // enabled" is a real deployment state — and returning early there
        // would make package skills silently invisible rather than merely
        // absent.
        if (plugins.length === 0 && !this.packageSource) {
            return { entries: [], total: 0 };
        }

        const requestedLimit = Math.max(1, options.limit);
        const requestedOffset = Math.max(0, options.offset);
        const seenSlugs = new Set<string>();
        const merged: SkillCatalogEntry[] = [];

        for (const wrapped of plugins) {
            const plugin = wrapped.plugin as ISkillsProviderPlugin;
            try {
                const settings = this.settingsService
                    ? await this.settingsService
                          .getResolvedSettings(plugin.id, facadeOptions)
                          .catch(() => undefined)
                    : undefined;
                let providerOffset = 0;
                while (providerOffset < MAX_PROVIDER_CATALOG_ENTRIES) {
                    const result = await plugin.listEntries({
                        limit: PROVIDER_CATALOG_PAGE_SIZE,
                        offset: providerOffset,
                        tags: options.tags,
                        search: options.search,
                        settings,
                    });
                    for (const entry of result.entries) {
                        if (seenSlugs.has(entry.slug)) continue;
                        seenSlugs.add(entry.slug);
                        merged.push(entry);
                    }
                    providerOffset += result.entries.length;
                    if (result.entries.length === 0 || providerOffset >= result.total) break;
                }
                if (providerOffset >= MAX_PROVIDER_CATALOG_ENTRIES) {
                    this.logger.warn(
                        `Skills provider ${plugin.id} catalog exceeded ${MAX_PROVIDER_CATALOG_ENTRIES} entries; truncating aggregate.`,
                    );
                }
            } catch (err) {
                this.logger.warn(
                    `Skills provider ${plugin.id} failed to listEntries: ${err instanceof Error ? err.message : err}`,
                );
            }
        }
        // Merged LAST, on purpose. The dedupe above is first-wins and
        // `everworks-skills` sorts first as the default provider, so appending
        // here is what guarantees a package can never displace a provider
        // plugin's entry.
        if (this.packageSource) {
            try {
                const packageEntries = await this.packageSource.listEntries({
                    facadeOptions,
                    tags: options.tags,
                    search: options.search,
                });
                for (const entry of packageEntries) {
                    if (seenSlugs.has(entry.slug)) {
                        // The provider dedupe drops silently, which is fine
                        // between plugins but not here: a package skill
                        // colliding with a built-in slug would vanish with no
                        // diagnostic at all.
                        this.logger.debug(
                            `Agent Plugins skill "${entry.slug}" from package ${entry.packageName ?? 'unknown'} is shadowed by an earlier provider entry.`,
                        );
                        continue;
                    }
                    seenSlugs.add(entry.slug);
                    merged.push(entry);
                }
            } catch (err) {
                // Same failure posture as a provider: one bad source must not
                // turn a working catalog into a 500.
                this.logger.warn(
                    `Agent Plugins package source failed to listEntries: ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        return {
            entries: merged.slice(requestedOffset, requestedOffset + requestedLimit),
            total: merged.length,
        };
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
                    ? await this.settingsService
                          .getResolvedSettings(plugin.id, facadeOptions)
                          .catch(() => undefined)
                    : undefined;
                const entry = await plugin.getEntry(slug, settings);
                if (entry) return { entry, providerId: plugin.id };
            } catch (err) {
                this.logger.warn(
                    `Skills provider ${plugin.id} failed to getEntry(${slug}): ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        // Consulted after every provider, matching the precedence
        // `listEntries` applies. Wiring only that method and not this one
        // would produce a catalog card whose Install button 404s, because the
        // install route resolves the slug through here.
        if (this.packageSource) {
            try {
                const found = await this.packageSource.getEntry(slug, { facadeOptions });
                if (found) return found;
            } catch (err) {
                this.logger.warn(
                    `Agent Plugins package source failed to getEntry(${slug}): ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        return null;
    }

    /**
     * Which installed skills have a newer version available.
     *
     * ## This finally calls `ISkillsProviderPlugin.checkForUpdates`
     *
     * That method has been on the contract, and implemented by
     * `everworks-skills` and `composio`, with **zero non-test callers** — a
     * capability every provider was asked to implement and none was ever
     * asked to perform. Wiring the package source's updates without also
     * wiring this one would have left the same dead seam in place while
     * appearing to add update support, so both are done here.
     *
     * `checkForUpdates` is optional on the interface, so a provider that does
     * not implement it is skipped rather than treated as an error.
     *
     * @param installedVersions slug → installed version, from the caller's
     *        own record of what the user has installed.
     */
    async checkForUpdates(
        installedVersions: Record<string, string>,
        facadeOptions: FacadeOptions,
    ): Promise<{ updated: SkillCatalogUpdate[] }> {
        const plugins = await this.getEnabledPlugins(facadeOptions.workId, facadeOptions.userId);
        const seen = new Set<string>();
        const updated: SkillCatalogUpdate[] = [];

        for (const wrapped of plugins) {
            const plugin = wrapped.plugin as ISkillsProviderPlugin;
            if (typeof plugin.checkForUpdates !== 'function') continue;
            try {
                const settings = this.settingsService
                    ? await this.settingsService
                          .getResolvedSettings(plugin.id, facadeOptions)
                          .catch(() => undefined)
                    : undefined;
                const result = await plugin.checkForUpdates(installedVersions, settings);
                for (const update of result.updated) {
                    if (seen.has(update.slug)) continue;
                    seen.add(update.slug);
                    updated.push(update);
                }
            } catch (err) {
                // One provider's outage must not hide every other provider's
                // updates.
                this.logger.warn(
                    `Skills provider ${plugin.id} failed to checkForUpdates: ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        // Package updates are appended LAST, matching the precedence
        // `listEntries` establishes: a package can never displace a provider
        // plugin's entry, so it must not displace its update either.
        if (this.packageSource?.checkForUpdates) {
            try {
                const packageUpdates = await this.packageSource.checkForUpdates(installedVersions, {
                    facadeOptions,
                });
                for (const update of packageUpdates) {
                    if (seen.has(update.slug)) continue;
                    seen.add(update.slug);
                    updated.push(update);
                }
            } catch (err) {
                this.logger.warn(
                    `Agent Plugins package source failed to checkForUpdates: ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        return { updated };
    }
}
