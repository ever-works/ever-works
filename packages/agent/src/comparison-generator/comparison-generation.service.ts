import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { z } from 'zod';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { PromptFacadeService } from '../facades/prompt.facade';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '../database/repositories/directory-generation-history.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { CacheEntry } from '../entities/cache.entity';
import type { Directory } from '../entities/directory.entity';
import type { ComparisonData } from '@ever-works/contracts';
import type { FacadeOptions } from '@ever-works/plugin';
import { DataRepository, type IDataConfig } from '../generators/data-generator/data-repository';
import { CACHE_MANAGER, type Cache } from '../cache';
import { DirectoryScheduleCadence, GenerateStatusType } from '../entities/types';
import {
    DEFAULT_COMPARISON_SETTINGS,
    selectNextPair,
    findManualPair,
    buildPairKey,
    countRemainingPairs,
    researchPair,
    generateComparison,
    type ComparisonPair,
    type ResearchDependencies,
    type ComparisonAiDependencies,
    type ComparisonPromptOptions,
    type ComparisonProgressStage,
    type ComparisonProgressInfo,
    type ComparisonProgressCallback,
} from './comparison';
import {
    DirectoryHistoryActivityType,
    type DirectoryHistoryChangeEntry,
} from '@ever-works/contracts/api';
import { buildDirectoryChangelog } from '../utils/directory-changelog.utils';
import { normalizeGeneratorError } from '../services/utils/error.utils';

const comparisonStructureSchema = z.object({
    title: z.string(),
    summary: z.string(),
    verdict: z.string(),
    verdict_winner: z.enum(['item_a', 'item_b', 'tie']),
    dimensions: z.array(
        z.object({
            name: z.string(),
            item_a_summary: z.string(),
            item_b_summary: z.string(),
            item_a_score: z.number().min(1).max(10),
            item_b_score: z.number().min(1).max(10),
            winner: z.enum(['item_a', 'item_b', 'tie']),
        }),
    ),
});

export interface ComparisonResult {
    status: 'success' | 'skipped' | 'error';
    slug?: string;
    message: string;
}

@Injectable()
export class ComparisonGenerationService {
    private readonly logger = new Logger(ComparisonGenerationService.name);
    private readonly activeGenerationLocks = new Set<string>();

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly searchFacade: SearchFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        private readonly gitFacade: GitFacadeService,
        private readonly promptFacade: PromptFacadeService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
        @Optional()
        @InjectRepository(CacheEntry)
        private readonly cacheEntryRepository?: Repository<CacheEntry>,
    ) {}

    private static readonly PROGRESS_CACHE_TTL = 120_000; // 2 minutes
    private static readonly GENERATION_LOCK_TTL = 2 * 60 * 60 * 1000; // 2 hours

    private progressCacheKey(directoryId: string): string {
        return `comparison-progress-${directoryId}`;
    }

    private generationLockKey(directoryId: string): string {
        return `comparison-generation-lock:${directoryId}`;
    }

    private async setProgress(
        directoryId: string,
        stage: ComparisonProgressStage,
        itemAName: string,
        itemBName: string,
        startedAt: string,
    ): Promise<void> {
        if (!this.cacheManager) return;
        const info: ComparisonProgressInfo = { stage, itemAName, itemBName, startedAt };
        await this.cacheManager.set(
            this.progressCacheKey(directoryId),
            info,
            ComparisonGenerationService.PROGRESS_CACHE_TTL,
        );
    }

    private async clearProgress(directoryId: string): Promise<void> {
        if (!this.cacheManager) return;
        await this.cacheManager.del(this.progressCacheKey(directoryId));
    }

    async getGenerationStatus(
        directoryId: string,
    ): Promise<{ generating: boolean } & Partial<ComparisonProgressInfo>> {
        if (!this.cacheManager) return { generating: false };
        const info = await this.cacheManager.get<ComparisonProgressInfo>(
            this.progressCacheKey(directoryId),
        );
        if (!info) return { generating: false };
        return { generating: true, ...info };
    }

    private async recordComparisonHistory(params: {
        directoryId: string;
        userId: string;
        activityType: DirectoryHistoryActivityType;
        entries: DirectoryHistoryChangeEntry[];
        summary: string;
    }): Promise<void> {
        const now = new Date();

        await this.generationHistoryRepository.createEntry({
            directoryId: params.directoryId,
            userId: params.userId,
            status: GenerateStatusType.GENERATED,
            startedAt: now,
            finishedAt: now,
            durationInSeconds: 0,
            triggeredBy: 'user',
            activityType: params.activityType,
            changelog: buildDirectoryChangelog(params.entries, params.summary),
        });
    }

    private async findDirectoryOrFail(directoryId: string): Promise<Directory> {
        const directory = await this.directoryRepository.findById(directoryId);
        if (!directory) {
            throw new NotFoundException(`Directory not found: ${directoryId}`);
        }
        return directory;
    }

    private async getComparisonPluginSettings(directoryId: string) {
        const dirPlugin = await this.directoryPluginRepository.findByDirectoryAndPlugin(
            directoryId,
            'comparison-generator',
        );
        const settings = dirPlugin?.settings ?? {};
        return {
            cadence_override:
                (settings.cadence_override as string) ??
                DEFAULT_COMPARISON_SETTINGS.cadence_override,
            max_comparisons_mode:
                (settings.max_comparisons_mode as string) ??
                DEFAULT_COMPARISON_SETTINGS.max_comparisons_mode,
            max_comparisons:
                Number(settings.max_comparisons) || DEFAULT_COMPARISON_SETTINGS.max_comparisons,
            min_items_for_comparison:
                Number(settings.min_items_for_comparison) ||
                DEFAULT_COMPARISON_SETTINGS.min_items_for_comparison,
            ai_provider: (settings.ai_provider as string) || undefined,
            ai_model: (settings.ai_model as string) || undefined,
            custom_prompt: (settings.custom_prompt as string) || undefined,
            extended_analysis: !!settings.extended_analysis,
        };
    }

    private resolveComparisonCadence(
        directory: Directory,
        cadenceOverride: string,
    ): DirectoryScheduleCadence | null {
        switch (cadenceOverride) {
            case 'daily':
                return DirectoryScheduleCadence.DAILY;
            case 'weekly':
                return DirectoryScheduleCadence.WEEKLY;
            case 'monthly':
                return DirectoryScheduleCadence.MONTHLY;
            case 'use_directory':
                return directory.scheduledCadence ?? null;
            default:
                return null;
        }
    }

    private calculateNextComparisonRun(
        cadence: DirectoryScheduleCadence,
        fromDate = new Date(),
    ): Date {
        const next = new Date(fromDate);

        switch (cadence) {
            case DirectoryScheduleCadence.HOURLY:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 1);
                break;
            case DirectoryScheduleCadence.EVERY_3_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 3);
                break;
            case DirectoryScheduleCadence.EVERY_8_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 8);
                break;
            case DirectoryScheduleCadence.EVERY_12_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 12);
                break;
            case DirectoryScheduleCadence.DAILY:
                next.setDate(next.getDate() + 1);
                break;
            case DirectoryScheduleCadence.WEEKLY:
                next.setDate(next.getDate() + 7);
                break;
            case DirectoryScheduleCadence.MONTHLY:
                next.setMonth(next.getMonth() + 1);
                break;
        }

        return next;
    }

    private isComparisonDue(
        directory: Directory,
        cadenceOverride: string,
        lastGeneratedAt?: string,
    ): boolean {
        const cadence = this.resolveComparisonCadence(directory, cadenceOverride);
        if (!cadence || !lastGeneratedAt) {
            return true;
        }

        const lastGeneratedDate = new Date(lastGeneratedAt);
        if (Number.isNaN(lastGeneratedDate.getTime())) {
            return true;
        }

        return this.calculateNextComparisonRun(cadence, lastGeneratedDate) <= new Date();
    }

    private async tryAcquireGenerationLock(directoryId: string): Promise<string | null> {
        if (this.activeGenerationLocks.has(directoryId)) {
            return null;
        }

        const lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        if (this.cacheEntryRepository) {
            const lockKey = this.generationLockKey(directoryId);
            const now = Date.now();

            await this.cacheEntryRepository.delete({
                key: lockKey,
                expiresAt: LessThan(now),
            });

            try {
                await this.cacheEntryRepository.insert({
                    key: lockKey,
                    value: lockToken,
                    expiresAt: now + ComparisonGenerationService.GENERATION_LOCK_TTL,
                });
            } catch (error) {
                const existingLock = await this.cacheEntryRepository.findOne({
                    where: { key: lockKey },
                    select: ['key'],
                });

                if (existingLock) {
                    return null;
                }

                throw error;
            }
        }

        this.activeGenerationLocks.add(directoryId);
        return lockToken;
    }

    private async releaseGenerationLock(
        directoryId: string,
        lockToken: string | null,
    ): Promise<void> {
        this.activeGenerationLocks.delete(directoryId);

        if (!lockToken || !this.cacheEntryRepository) {
            return;
        }

        await this.cacheEntryRepository
            .createQueryBuilder()
            .delete()
            .from(CacheEntry)
            .where('key = :key', { key: this.generationLockKey(directoryId) })
            .andWhere('value = :value', { value: lockToken })
            .execute();
    }

    private getDirectoryGitOptions(directory: Directory): GitFacadeOptions {
        return {
            userId: directory.userId,
            providerId: directory.gitProvider,
            directoryId: directory.id,
        };
    }

    private extractMarkdownLinkSeeds(
        markdown: string | undefined,
    ): Array<{ url: string; snippet: string }> {
        if (!markdown) {
            return [];
        }

        const matches = markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g);
        return Array.from(matches, (match) => ({
            url: match[2].trim(),
            snippet: match[1].trim(),
        })).filter((seed) => seed.url.length > 0 && seed.snippet.length > 0);
    }

    private buildResearchSeedResults(
        pair: ComparisonPair,
    ): Array<{ url: string; snippet: string }> {
        const candidates: Array<{ url?: string; snippet: string }> = [
            {
                url:
                    pair.itemA.source_validation?.suggested_source_url?.trim() ||
                    pair.itemA.source_url?.trim(),
                snippet: `${pair.itemA.name} official source`,
            },
            {
                url:
                    pair.itemB.source_validation?.suggested_source_url?.trim() ||
                    pair.itemB.source_url?.trim(),
                snippet: `${pair.itemB.name} official source`,
            },
            {
                url: pair.itemA.source_url?.trim(),
                snippet: `${pair.itemA.name} original source`,
            },
            {
                url: pair.itemB.source_url?.trim(),
                snippet: `${pair.itemB.name} original source`,
            },
            ...this.extractMarkdownLinkSeeds(pair.itemA.markdown),
            ...this.extractMarkdownLinkSeeds(pair.itemB.markdown),
        ];

        const deduped = new Map<string, { url: string; snippet: string }>();
        for (const candidate of candidates) {
            const url = candidate.url?.trim();
            if (!url || deduped.has(url)) {
                continue;
            }

            deduped.set(url, {
                url,
                snippet: candidate.snippet,
            });
        }

        return Array.from(deduped.values());
    }

    /**
     * Generate the next automatic comparison for a directory.
     * Picks the best un-compared pair and generates a full comparison page.
     */
    async generateNextComparison(
        directoryId: string,
        userId: string,
        options: { respectCadence?: boolean } = {},
    ): Promise<ComparisonResult> {
        const directory = await this.findDirectoryOrFail(directoryId);
        const lockToken = await this.tryAcquireGenerationLock(directoryId);

        if (!lockToken) {
            return {
                status: 'skipped',
                message: 'Comparison generation is already in progress for this directory',
            };
        }

        try {
            const gitOptions = this.getDirectoryGitOptions(directory);

            const dest = await this.gitFacade.cloneOrPull(
                { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
                gitOptions,
            );
            const dataRepo = await DataRepository.create(dest);
            const config = await dataRepo.getConfig();
            const items = await dataRepo.getItems();

            const comparisonState = config.metadata?.comparison_state ?? {
                generated_pairs: [],
                total_generated: 0,
            };

            const pluginSettings = await this.getComparisonPluginSettings(directoryId);
            if (
                options.respectCadence &&
                !this.isComparisonDue(
                    directory,
                    pluginSettings.cadence_override,
                    comparisonState.last_generated_at,
                )
            ) {
                return { status: 'skipped', message: 'Comparison generation is not due yet' };
            }

            const maxComparisons =
                pluginSettings.max_comparisons_mode === 'unlimited'
                    ? Number.MAX_SAFE_INTEGER
                    : pluginSettings.max_comparisons;
            const minItems = pluginSettings.min_items_for_comparison;

            const pair = selectNextPair({
                items,
                generatedPairs: comparisonState.generated_pairs,
                minItemsForComparison: minItems,
                maxComparisons,
            });

            if (!pair) {
                return { status: 'skipped', message: 'No more pairs available for comparison' };
            }

            return this.generateComparisonForPair(
                pair,
                directory,
                dataRepo,
                config,
                comparisonState,
                gitOptions,
            );
        } finally {
            await this.releaseGenerationLock(directoryId, lockToken);
        }
    }

    /**
     * Count how many un-generated comparison pairs remain.
     */
    async getRemainingCount(directoryId: string, userId: string): Promise<number> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions = this.getDirectoryGitOptions(directory);

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
            gitOptions,
        );
        const dataRepo = await DataRepository.create(dest);
        const config = await dataRepo.getConfig();
        const items = await dataRepo.getItems();

        const comparisonState = config.metadata?.comparison_state ?? {
            generated_pairs: [],
            total_generated: 0,
        };

        const pluginSettings = await this.getComparisonPluginSettings(directoryId);
        const maxComparisons =
            pluginSettings.max_comparisons_mode === 'unlimited'
                ? Number.MAX_SAFE_INTEGER
                : pluginSettings.max_comparisons;

        return countRemainingPairs({
            items,
            generatedPairs: comparisonState.generated_pairs,
            minItemsForComparison: pluginSettings.min_items_for_comparison,
            maxComparisons,
        });
    }

    /**
     * Generate a comparison for two specific items (manual trigger).
     */
    async generateManualComparison(
        directoryId: string,
        userId: string,
        itemASlug: string,
        itemBSlug: string,
    ): Promise<ComparisonResult> {
        const directory = await this.findDirectoryOrFail(directoryId);
        const lockToken = await this.tryAcquireGenerationLock(directoryId);

        if (!lockToken) {
            return {
                status: 'skipped',
                message: 'Comparison generation is already in progress for this directory',
            };
        }

        try {
            const gitOptions = this.getDirectoryGitOptions(directory);

            const dest = await this.gitFacade.cloneOrPull(
                { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
                gitOptions,
            );
            const dataRepo = await DataRepository.create(dest);
            const config = await dataRepo.getConfig();
            const items = await dataRepo.getItems();

            const comparisonState = config.metadata?.comparison_state ?? {
                generated_pairs: [],
                total_generated: 0,
            };

            const pair = findManualPair(items, itemASlug, itemBSlug);
            if (!pair) {
                return {
                    status: 'error',
                    message: `Could not find items: ${itemASlug} and/or ${itemBSlug}`,
                };
            }

            const pairKey = buildPairKey(itemASlug, itemBSlug);
            if (comparisonState.generated_pairs.includes(pairKey)) {
                const exists = await dataRepo.comparisonExists(pairKey);
                if (exists) {
                    return {
                        status: 'skipped',
                        slug: pairKey,
                        message: 'Comparison already exists for this pair',
                    };
                }
            }

            return this.generateComparisonForPair(
                pair,
                directory,
                dataRepo,
                config,
                comparisonState,
                gitOptions,
            );
        } finally {
            await this.releaseGenerationLock(directoryId, lockToken);
        }
    }

    /**
     * List all comparisons for a directory.
     */
    async listComparisons(directoryId: string, userId: string): Promise<ComparisonData[]> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions = this.getDirectoryGitOptions(directory);

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
                gitOptions,
            );
            const dataRepo = await DataRepository.create(dest);
            return dataRepo.getComparisons();
        } catch (error) {
            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return [];
            }

            throw error;
        }
    }

    /**
     * Get a single comparison by slug.
     */
    async getComparison(
        directoryId: string,
        userId: string,
        slug: string,
    ): Promise<{
        comparison: ComparisonData | null;
        markdown?: string;
        extendedAnalysisMarkdown?: string;
    }> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions = this.getDirectoryGitOptions(directory);

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
                gitOptions,
            );
            const dataRepo = await DataRepository.create(dest);
            const comparison = await dataRepo.getComparison(slug);
            const markdown = comparison ? await dataRepo.getComparisonMarkdown(slug) : undefined;
            const extendedAnalysisMarkdown = comparison
                ? await dataRepo.getComparisonExtendedMarkdown(slug)
                : undefined;

            return { comparison, markdown, extendedAnalysisMarkdown };
        } catch (error) {
            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return { comparison: null };
            }

            throw error;
        }
    }

    /**
     * Delete a comparison by slug.
     */
    async deleteComparison(
        directoryId: string,
        userId: string,
        slug: string,
    ): Promise<ComparisonResult> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions = this.getDirectoryGitOptions(directory);

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
            gitOptions,
        );
        const dataRepo = await DataRepository.create(dest);

        const removed = await dataRepo.removeComparison(slug);
        if (!removed) {
            return { status: 'error', message: `Comparison not found: ${slug}` };
        }

        // Update comparison state
        const config = await dataRepo.getConfig();
        const comparisonState = config.metadata?.comparison_state ?? {
            generated_pairs: [],
            total_generated: 0,
        };

        comparisonState.generated_pairs = comparisonState.generated_pairs.filter((p) => p !== slug);
        comparisonState.total_generated = Math.max(0, comparisonState.total_generated - 1);

        await dataRepo.mergeConfig({
            metadata: { ...config.metadata, comparison_state: comparisonState },
        });

        // Commit and push
        await this.gitFacade.add(directory.gitProvider, dest, '.');
        await this.gitFacade.commit(
            directory.gitProvider,
            dest,
            `chore: remove comparison - ${slug}`,
        );
        await this.gitFacade.push({ dir: dest }, gitOptions);

        await this.recordComparisonHistory({
            directoryId,
            userId,
            activityType: DirectoryHistoryActivityType.COMPARISON_REMOVED,
            entries: [
                {
                    entityType: 'comparison',
                    action: 'removed',
                    name: slug,
                    slug,
                },
            ],
            summary: `Comparison removed: ${slug}`,
        });

        return { status: 'success', slug, message: 'Comparison deleted' };
    }

    private async generateComparisonForPair(
        pair: ComparisonPair,
        directory: Directory,
        dataRepo: DataRepository,
        config: IDataConfig,
        comparisonState: {
            generated_pairs: string[];
            last_generated_at?: string;
            total_generated: number;
        },
        gitOptions: GitFacadeOptions,
    ): Promise<ComparisonResult> {
        const startedAt = new Date().toISOString();
        const onProgress: ComparisonProgressCallback = (stage) => {
            this.setProgress(
                directory.id,
                stage,
                pair.itemA.name,
                pair.itemB.name,
                startedAt,
            ).catch(() => {});
        };

        try {
            const pluginSettings = await this.getComparisonPluginSettings(directory.id);
            const facadeOptions: FacadeOptions = {
                userId: gitOptions.userId!,
                directoryId: directory.id,
                providerOverride: pluginSettings.ai_provider,
            };

            // 1. Research the pair
            onProgress('researching');
            const researchDeps: ResearchDependencies = {
                search: async (query: string, limit: number) => {
                    const results = await this.searchFacade.search(
                        query,
                        { maxResults: limit },
                        facadeOptions,
                    );
                    return results.map((r) => ({
                        url: r.url,
                        snippet: [r.title, r.publishedDate].filter(Boolean).join(' - '),
                    }));
                },
                extractContent: async (url: string) => {
                    const result = await this.contentExtractorFacade.extractContent(
                        url,
                        undefined,
                        facadeOptions,
                    );
                    return result?.rawContent ?? null;
                },
            };

            this.logger.log(`Researching comparison: ${pair.itemA.name} vs ${pair.itemB.name}`);
            const research = await researchPair(pair, researchDeps, {
                seedResults: this.buildResearchSeedResults(pair),
            });

            // 2. Generate comparison via AI
            const aiDeps: ComparisonAiDependencies = {
                askJson: async <T>(prompt: string) => {
                    const response = await this.aiFacade.askJson(
                        prompt,
                        comparisonStructureSchema,
                        pluginSettings.ai_model
                            ? { routing: { modelOverride: pluginSettings.ai_model } }
                            : undefined,
                        facadeOptions,
                    );
                    return response.result as T;
                },
                askText: async (prompt: string) => {
                    const response = await this.aiFacade.createChatCompletion(
                        {
                            messages: [{ role: 'user', content: prompt }],
                            model: pluginSettings.ai_model,
                        },
                        facadeOptions,
                    );
                    const content = response.choices[0]?.message?.content;
                    return typeof content === 'string' ? content : '';
                },
            };

            this.logger.log(`Generating comparison: ${pair.itemA.name} vs ${pair.itemB.name}`);
            const promptOptions: ComparisonPromptOptions = {
                promptFacade: this.promptFacade,
                facadeOptions,
            };
            const result = await generateComparison(
                pair,
                research,
                aiDeps,
                {
                    name: directory.name,
                    description: directory.description,
                    customPrompt: pluginSettings.custom_prompt,
                    extendedAnalysis: pluginSettings.extended_analysis,
                },
                promptOptions,
                onProgress,
            );

            // 3. Write to data repo
            onProgress('saving');
            await dataRepo.writeComparison(result.comparison);
            await dataRepo.writeComparisonMarkdown(result.comparison.slug, result.markdown);
            if (result.extendedAnalysisMarkdown) {
                await dataRepo.writeComparisonExtendedMarkdown(
                    result.comparison.slug,
                    result.extendedAnalysisMarkdown,
                );
            }

            // 4. Update comparison state
            comparisonState.generated_pairs.push(result.comparison.slug);
            comparisonState.last_generated_at = new Date().toISOString();
            comparisonState.total_generated += 1;

            await dataRepo.mergeConfig({
                settings: { comparisons_enabled: true },
                metadata: { ...config.metadata, comparison_state: comparisonState },
            });

            // 5. Commit and push
            await this.gitFacade.add(directory.gitProvider, dataRepo.dir, '.');
            await this.gitFacade.commit(
                directory.gitProvider,
                dataRepo.dir,
                `chore: add comparison - ${pair.itemA.name} vs ${pair.itemB.name}`,
            );
            await this.gitFacade.push({ dir: dataRepo.dir }, gitOptions);

            this.logger.log(`Comparison generated: ${result.comparison.slug}`);

            await this.recordComparisonHistory({
                directoryId: directory.id,
                userId: gitOptions.userId!,
                activityType: DirectoryHistoryActivityType.COMPARISON_ADDED,
                entries: [
                    {
                        entityType: 'comparison',
                        action: 'added',
                        name: result.comparison.title,
                        slug: result.comparison.slug,
                    },
                ],
                summary: `Comparison generated: ${pair.itemA.name} vs ${pair.itemB.name}`,
            });

            return {
                status: 'success',
                slug: result.comparison.slug,
                message: `Generated comparison: ${pair.itemA.name} vs ${pair.itemB.name}`,
            };
        } finally {
            await this.clearProgress(directory.id);
        }
    }
}
