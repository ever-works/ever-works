import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IContentExtractorPlugin,
    FacadeContentExtractionResult,
    FacadeExtractedContent,
    FacadeExtractionAttempt,
    FacadeExtractionOptions,
    IContentExtractorFacade,
    FacadeOptions,
    JsonSchema,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
    loadRegisteredPlugins,
} from '../plugins/services/plugin-registry.service';
import { readPluginString } from '../plugins/services/lazy-plugin-proxy';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { UsageOutcome } from '@src/entities/_types';
import {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
} from './base.facade';

export class ContentExtractorFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'ContentExtractorFacadeError';
    }
}

export class NoContentExtractorProviderError extends NoProviderError {
    constructor() {
        super('content extractor');
        this.name = 'NoContentExtractorProviderError';
    }
}

export class ContentExtractorProviderNotFoundError extends ProviderNotFoundError {
    constructor(providerId: string) {
        super(providerId, 'Content extractor');
        this.name = 'ContentExtractorProviderNotFoundError';
    }
}

interface ExtractorCandidate {
    readonly plugin: IContentExtractorPlugin;
    readonly id: string;
    readonly name: string;
}

@Injectable()
export class ContentExtractorFacadeService
    extends BaseFacadeService
    implements IContentExtractorFacade
{
    protected readonly logger = new Logger(ContentExtractorFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.CONTENT_EXTRACTOR;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
        @Optional() private readonly budgetGuard?: BudgetGuardService,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    async extractContent(
        url: string,
        options: FacadeExtractionOptions | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<FacadeExtractedContent | null> {
        const result = await this.extractContentWithDiagnostics(url, options, facadeOptions);
        return result.content;
    }

    async extractContentWithDiagnostics(
        url: string,
        options: FacadeExtractionOptions | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<FacadeContentExtractionResult> {
        const attempts: FacadeExtractionAttempt[] = [];
        const providerOverride = facadeOptions.providerOverride ?? options?.providerOverride;
        let candidates: ExtractorCandidate[];

        try {
            candidates = await this.resolveExtractorCandidates(
                url,
                providerOverride,
                facadeOptions.userId,
                facadeOptions.workId,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Content extractor resolution failed for ${url}: ${message}`);
            return {
                content: null,
                attempts,
                error: message,
            };
        }

        if (candidates.length === 0) {
            this.logger.debug(`No content extractor available for URL: ${url}`);
            return {
                content: null,
                attempts,
                error: `No content extractor available for URL: ${url}`,
            };
        }

        for (const candidate of candidates) {
            // AW-17 — set once the provider is actually invoked, so a refusal
            // BEFORE the call (the budget guard) is never recorded as a
            // failed extraction.
            let providerCalled = false;
            try {
                if (this.budgetGuard && facadeOptions.workId && facadeOptions.userId) {
                    await this.budgetGuard.checkBudget(
                        facadeOptions.workId,
                        facadeOptions.userId,
                        PluginUsageCapability.EXTRACTOR,
                        candidate.id,
                    );
                }

                const settings = await this.getResolvedSettings(candidate.id, facadeOptions);
                providerCalled = true;
                const result = await candidate.plugin.extract({
                    url,
                    settings,
                    includeImages: options?.includeImages,
                    includeLinks: options?.includeLinks,
                });
                const rawContent = result.content || result.markdown || '';

                if (!result.success) {
                    const error = result.error || 'unknown error';
                    attempts.push({
                        providerId: candidate.id,
                        providerName: candidate.name,
                        success: false,
                        error,
                    });
                    this.logger.warn(
                        `Content extraction returned failure for ${url} (plugin: ${candidate.id}): ${error}`,
                    );
                    await this.recordFailedExtraction(candidate.id, url, facadeOptions);
                    continue;
                }

                if (!rawContent.trim()) {
                    attempts.push({
                        providerId: candidate.id,
                        providerName: candidate.name,
                        success: false,
                        error: 'empty content',
                        contentLength: 0,
                    });
                    this.logger.warn(
                        `Content extraction returned empty content for ${url} (plugin: ${candidate.id})`,
                    );
                    await this.recordFailedExtraction(candidate.id, url, facadeOptions);
                    continue;
                }

                attempts.push({
                    providerId: candidate.id,
                    providerName: candidate.name,
                    success: true,
                    contentLength: rawContent.length,
                });

                const pricing = (await candidate.plugin.getPricing?.()) ?? null;
                await this.pluginUsageService?.record({
                    workId: facadeOptions.workId,
                    userId: facadeOptions.userId,
                    // Phase 15.6 — Agent/Task attribution propagation.
                    agentId: facadeOptions.agentId,
                    taskId: facadeOptions.taskId,
                    // Wave 9 M2 — per-run cost attribution.
                    runId: facadeOptions.runId,
                    // AW-17 — the Mission of the run's Task.
                    missionId: facadeOptions.missionId,
                    pluginId: candidate.id,
                    capability: PluginUsageCapability.EXTRACTOR,
                    units: 1,
                    costCents: pricing?.costPerCallCents ?? 0,
                    currency: pricing?.currency,
                    metadata: {
                        operation: 'extract',
                        url,
                        contentLength: rawContent.length,
                    },
                });

                return {
                    content: {
                        url: result.url,
                        rawContent,
                        images: result.images?.map((img) => img.src),
                        metadata: result.metadata as Record<string, unknown> | undefined,
                        extraction: {
                            providerId: candidate.id,
                            providerName: candidate.name,
                            attempts,
                        },
                    },
                    attempts,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                attempts.push({
                    providerId: candidate.id,
                    providerName: candidate.name,
                    success: false,
                    error: message,
                });
                this.logger.warn(
                    `Content processing failed for ${url} (plugin: ${candidate.id}): ${message}`,
                );
                if (providerCalled) {
                    await this.recordFailedExtraction(candidate.id, url, facadeOptions);
                }
            }
        }

        this.logger.warn(
            `Content processing failed for ${url}; tried ${attempts
                .map((attempt) => `${attempt.providerId}: ${attempt.error || 'failed'}`)
                .join(', ')}`,
        );
        return {
            content: null,
            attempts,
            error: `Processing failed for URL: ${url}`,
        };
    }

    /**
     * AW-17 — an extraction attempt that reached the provider and produced
     * nothing usable is still a call on the receipt: outcome `failed`,
     * zero-rated. The provider's error text is never copied onto the row.
     * Best-effort like every usage write.
     */
    private async recordFailedExtraction(
        pluginId: string,
        url: string,
        facadeOptions: FacadeOptions,
    ): Promise<void> {
        try {
            await this.pluginUsageService?.record({
                workId: facadeOptions.workId,
                userId: facadeOptions.userId,
                agentId: facadeOptions.agentId,
                taskId: facadeOptions.taskId,
                runId: facadeOptions.runId,
                missionId: facadeOptions.missionId,
                pluginId,
                capability: PluginUsageCapability.EXTRACTOR,
                units: 1,
                costCents: 0,
                outcome: UsageOutcome.FAILED,
                metadata: { operation: 'extract', url, failed: true },
            });
        } catch {
            // Usage writes never break the extraction fallback chain.
        }
    }

    override getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            // Sync, so a plugin may still be a cold lazy proxy: its manifest
            // name then (see BaseFacadeService.getProviderName).
            name: readPluginString(p.plugin, 'providerName') ?? p.plugin.name,
            enabled: p.state === 'loaded',
        }));
    }

    /**
     * Resolution order:
     *   0. Supplementary (pdf-extractor, notion-extractor) — intercept by URL pattern first,
     *      regardless of any explicit override. Only active when enabled for the scope.
     *   1. Explicit providerOverride (user's selected provider)
     *   2. Work's configured default provider
     *   3. General non-system extractors (Jina, Firecrawl, Tavily, …)
     *   4. Scoped default extractor (system plugins included via scoped enablement)
     *   5. Last resort: any enabled + configured extractor that accepts the URL
     */
    private async resolveExtractorCandidates(
        url: string,
        providerOverride?: string,
        userId?: string,
        workId?: string,
    ): Promise<ExtractorCandidate[]> {
        const loadedPlugins = await this.loadEnabledExtractors(userId, workId);
        const candidates: ExtractorCandidate[] = [];
        const seen = new Set<string>();

        const addCandidate = (registered: RegisteredPlugin): void => {
            if (seen.has(registered.plugin.id)) return;
            seen.add(registered.plugin.id);
            candidates.push({
                plugin: registered.plugin as IContentExtractorPlugin,
                id: registered.plugin.id,
                name: this.getProviderName(registered.plugin),
            });
        };

        // 0. Supplementary plugins: URL-pattern specialists (pdf, notion, …).
        //    Checked before the user's chosen provider so they can intercept their URL types.
        for (const registered of loadedPlugins) {
            if (!registered.manifest.supplementary) continue;
            if (!(await this.isPluginUsableForScope(registered, userId, workId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        // 1. Explicit provider override
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                !registered ||
                !registered.manifest.capabilities.includes(this.CAPABILITY) ||
                registered.state !== 'loaded'
            ) {
                throw new ContentExtractorProviderNotFoundError(providerOverride);
            }

            if (!(await this.isPluginUsableForScope(registered, userId, workId))) {
                throw new ContentExtractorProviderNotFoundError(providerOverride);
            }

            const plugin = registered.plugin as IContentExtractorPlugin;
            await this.assertCanExtractForOverride(plugin, url, providerOverride);
            addCandidate(registered);
        }

        // 2. Work's configured default
        if (workId) {
            const active = await this.findActivePluginForWork(workId);
            if (active && (await this.isPluginUsableForScope(active, userId, workId))) {
                const plugin = active.plugin as IContentExtractorPlugin;
                if (await this.canExtractSafe(plugin, url, active.plugin.id)) {
                    addCandidate(active);
                }
            }
        }

        // 3. General extractors (non-system, non-supplementary, non-default)
        const general = loadedPlugins.filter(
            (p) =>
                !p.manifest.systemPlugin &&
                !p.manifest.supplementary &&
                !p.manifest.defaultForCapabilities?.includes(this.CAPABILITY),
        );
        for (const registered of general) {
            if (!(await this.isPluginUsableForScope(registered, userId, workId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        // 4. Scoped default extractor (system plugins are included by enablement rules).
        for (const registered of loadedPlugins) {
            if (!registered.manifest.defaultForCapabilities?.includes(this.CAPABILITY)) continue;
            if (!(await this.isPluginUsableForScope(registered, userId, workId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        // 5. Last resort
        for (const registered of loadedPlugins) {
            if (!(await this.isPluginUsableForScope(registered, userId, workId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        return candidates;
    }

    /**
     * The `loaded` extractors, after loading every one enabled for the scope.
     *
     * The tiers above order extractors by manifest fields — `supplementary`,
     * `defaultForCapabilities` — that some plugins set only in their class's
     * getManifest() (pdf-extractor and officecli-extractor are supplementary
     * that way), and a cold lazy proxy's registry entry does not carry them
     * until it loads. An extractor that cannot load is now in `error` and is
     * left out, as it would have been had it failed at boot. Disabled ones
     * stay cold: every tier skips them anyway.
     */
    private async loadEnabledExtractors(
        userId?: string,
        workId?: string,
    ): Promise<RegisteredPlugin[]> {
        const loaded = this.registry
            .getByCapability(this.CAPABILITY)
            .filter((p) => p.state === 'loaded');
        const enabled: RegisteredPlugin[] = [];
        for (const registered of loaded) {
            if (await this.isPluginEnabled(registered.plugin.id, workId, userId)) {
                enabled.push(registered);
            }
        }
        await loadRegisteredPlugins(enabled);
        return loaded.filter((p) => p.state === 'loaded');
    }

    private hasAllRequiredSettings(
        schema: JsonSchema | undefined,
        resolvedSettings: Record<string, unknown>,
    ): boolean {
        if (!schema?.required || !schema.properties) return true;

        for (const field of schema.required) {
            const propSchema = schema.properties[field];
            if (!propSchema) continue;
            if (propSchema['x-envVar']) continue;
            if (propSchema['x-adminOnly']) continue;

            const value = resolvedSettings[field];
            if (value === undefined || value === null || value === '') return false;
        }

        return true;
    }

    private async isPluginUsableForScope(
        registered: RegisteredPlugin,
        userId?: string,
        workId?: string,
    ): Promise<boolean> {
        if (!(await this.isPluginEnabled(registered.plugin.id, workId, userId))) return false;
        // The required list below is the plugin class's; a cold lazy proxy
        // answers `{}`, which would make every extractor look configured. One
        // that cannot be loaded — or whose onLoad fails, once a first load
        // another request started has settled — is not usable.
        if ((await loadRegisteredPlugins([registered])).length === 0) return false;

        const settings = await this.getResolvedSettings(registered.plugin.id, {
            userId,
            workId,
        });
        return this.hasAllRequiredSettings(registered.plugin.settingsSchema, settings);
    }

    /**
     * Calls canExtract and returns false on any failure.
     * Used for all tiers where a failed check means "try the next plugin".
     */
    private async canExtractSafe(
        plugin: IContentExtractorPlugin,
        url: string,
        pluginId: string,
    ): Promise<boolean> {
        if (typeof plugin.canExtract !== 'function') return true;
        try {
            return await plugin.canExtract(url);
        } catch (err) {
            this.logger.warn(`canExtract failed for ${pluginId}: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Validates the override plugin can extract the URL.
     * - canExtract() → false: throws ContentExtractorProviderNotFoundError
     * - canExtract() → throws: logs warning, allows the plugin (may still succeed)
     */
    private async assertCanExtractForOverride(
        plugin: IContentExtractorPlugin,
        url: string,
        pluginId: string,
    ): Promise<void> {
        if (typeof plugin.canExtract !== 'function') return;
        try {
            if (!(await plugin.canExtract(url))) {
                this.logger.warn(`Override plugin ${pluginId} cannot extract: ${url}`);
                throw new ContentExtractorProviderNotFoundError(pluginId);
            }
        } catch (err) {
            if (err instanceof ContentExtractorProviderNotFoundError) throw err;
            this.logger.warn(
                `canExtract error for override ${pluginId}: ${(err as Error).message}`,
            );
        }
    }
}
