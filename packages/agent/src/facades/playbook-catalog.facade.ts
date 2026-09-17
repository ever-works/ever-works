import { Injectable, Logger, Optional } from '@nestjs/common';
import type { FacadeOptions, IPlaybookProviderPlugin } from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import {
    acceptPlaybookEntry,
    comparePlaybookVersions,
    type PlaybookCatalogEntry,
} from '@ever-works/contracts';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class PlaybookCatalogFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'PlaybookCatalogFacadeError';
    }
}

/** Entries requested per provider page. */
export const PLAYBOOK_PROVIDER_PAGE_SIZE = 200;
/** Hard ceiling on the merged catalogue, however many providers are enabled. */
export const MAX_PLAYBOOK_CATALOG_ENTRIES = 2000;

/**
 * Capability & playbook catalogue (AW-21).
 *
 * Resolves the `playbook-provider` plugins enabled for the caller's scope,
 * fans catalogue reads out to each, validates and sanitises every entry,
 * and dedupes by slug. Unlike the skills catalogue (first provider wins), a
 * later provider replaces an earlier entry only when its `version` is
 * STRICTLY greater — so a hosted catalogue can revise a built-in playbook
 * without a deploy, but can never downgrade one.
 *
 * A provider that throws is logged and skipped: one bad source must not
 * turn a working catalogue into a 500.
 */
@Injectable()
export class PlaybookCatalogFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(PlaybookCatalogFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.PLAYBOOK_PROVIDER;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /** The whole merged catalogue for the scope, in provider order, capped. */
    async listEntries(facadeOptions: FacadeOptions): Promise<PlaybookCatalogEntry[]> {
        const plugins = await this.getEnabledPlugins(facadeOptions.workId, facadeOptions.userId);
        const bySlug = new Map<string, PlaybookCatalogEntry>();
        let dropped = 0;

        for (const wrapped of plugins) {
            const plugin = wrapped.plugin as IPlaybookProviderPlugin;
            try {
                const settings = await this.settingsFor(plugin.id, facadeOptions);
                let offset = 0;
                while (offset < MAX_PLAYBOOK_CATALOG_ENTRIES) {
                    const page = await plugin.listPlaybooks({
                        limit: PLAYBOOK_PROVIDER_PAGE_SIZE,
                        offset,
                        settings,
                    });
                    for (const candidate of page.entries) {
                        if (!this.accept(bySlug, candidate, plugin.id)) dropped++;
                    }
                    offset += page.entries.length;
                    if (page.entries.length === 0 || offset >= page.total) break;
                }
            } catch (err) {
                this.logger.warn(
                    `Playbook provider ${plugin.id} failed to listPlaybooks: ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        if (dropped > 0) {
            this.logger.warn(
                `Playbook catalogue exceeded ${MAX_PLAYBOOK_CATALOG_ENTRIES} entries; dropped ${dropped}.`,
            );
        }
        return [...bySlug.values()];
    }

    /** One entry by slug, applying the same version-wins rule across providers. */
    async getEntry(
        slug: string,
        facadeOptions: FacadeOptions,
    ): Promise<{ entry: PlaybookCatalogEntry; providerId: string } | null> {
        const plugins = await this.getEnabledPlugins(facadeOptions.workId, facadeOptions.userId);
        let best: { entry: PlaybookCatalogEntry; providerId: string } | null = null;

        for (const wrapped of plugins) {
            const plugin = wrapped.plugin as IPlaybookProviderPlugin;
            try {
                const settings = await this.settingsFor(plugin.id, facadeOptions);
                const candidate = await plugin.getPlaybook(slug, settings);
                if (!candidate) continue;
                const { entry, violation } = acceptPlaybookEntry(candidate);
                if (!entry || entry.slug !== slug) {
                    this.logger.warn(
                        `Playbook provider ${plugin.id} returned an invalid entry for "${slug}": ${violation ?? 'slug mismatch'}`,
                    );
                    continue;
                }
                if (!best || comparePlaybookVersions(entry.version, best.entry.version) > 0) {
                    best = { entry, providerId: plugin.id };
                }
            } catch (err) {
                this.logger.warn(
                    `Playbook provider ${plugin.id} failed to getPlaybook(${slug}): ${err instanceof Error ? err.message : err}`,
                );
            }
        }
        return best;
    }

    private accept(
        bySlug: Map<string, PlaybookCatalogEntry>,
        candidate: unknown,
        providerId: string,
    ): boolean {
        const { entry, violation } = acceptPlaybookEntry(candidate);
        if (!entry) {
            this.logger.warn(
                `Playbook provider ${providerId} returned an invalid entry: ${violation}`,
            );
            return true;
        }
        const existing = bySlug.get(entry.slug);
        if (existing && comparePlaybookVersions(entry.version, existing.version) <= 0) {
            return true;
        }
        if (!existing && bySlug.size >= MAX_PLAYBOOK_CATALOG_ENTRIES) {
            // A new slug past the ceiling is dropped (reported once by the
            // caller); a higher version of an entry already inside it still
            // replaces that entry.
            return false;
        }
        bySlug.set(entry.slug, entry);
        return true;
    }

    private async settingsFor(
        pluginId: string,
        facadeOptions: FacadeOptions,
    ): Promise<Record<string, unknown> | undefined> {
        if (!this.settingsService) return undefined;
        return this.settingsService
            .getResolvedSettings(pluginId, facadeOptions)
            .catch(() => undefined);
    }
}
