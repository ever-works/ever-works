import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IContentExtractorPlugin,
    FacadeContentExtractionResult,
    FacadeExtractedContent,
    FacadeExtractionAttempt,
    FacadeExtractionOptions,
    IContentExtractorFacade,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
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

    override getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IContentExtractorPlugin).providerName,
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
     *   4. System/default extractor (local-content-extractor)
     *   5. Last resort: any enabled extractor that accepts the URL
     */
    private async resolveExtractorCandidates(
        url: string,
        providerOverride?: string,
        userId?: string,
        workId?: string,
    ): Promise<ExtractorCandidate[]> {
        const loadedPlugins = this.registry
            .getByCapability(this.CAPABILITY)
            .filter((p) => p.state === 'loaded');
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
            if (!(await this.isPluginEnabled(registered.plugin.id, workId, userId))) continue;

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

            if (!(await this.isPluginEnabled(providerOverride, workId, userId))) {
                throw new ContentExtractorProviderNotFoundError(providerOverride);
            }

            const plugin = registered.plugin as IContentExtractorPlugin;
            await this.assertCanExtractForOverride(plugin, url, providerOverride);
            addCandidate(registered);
        }

        // 2. Work's configured default
        if (workId) {
            const active = await this.findActivePluginForWork(workId);
            if (active) {
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
            if (!(await this.isPluginEnabled(registered.plugin.id, workId, userId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        // 4. System/default extractor (e.g., local-content-extractor)
        const defaultExtractor = this.registry.getDefaultForCapability(this.CAPABILITY);
        if (defaultExtractor) {
            const plugin = defaultExtractor.plugin as IContentExtractorPlugin;
            let canExtract = true;
            if (typeof plugin.canExtract === 'function') {
                try {
                    canExtract = await plugin.canExtract(url);
                } catch (err) {
                    // canExtract itself threw — log and still attempt extraction
                    this.logger.warn(
                        `canExtract error on default extractor: ${(err as Error).message}`,
                    );
                }
            }

            if (canExtract) {
                addCandidate(defaultExtractor);
            }
        }

        // 5. Last resort
        for (const registered of loadedPlugins) {
            if (!(await this.isPluginEnabled(registered.plugin.id, workId, userId))) continue;

            const plugin = registered.plugin as IContentExtractorPlugin;
            if (await this.canExtractSafe(plugin, url, registered.plugin.id)) {
                addCandidate(registered);
            }
        }

        return candidates;
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
