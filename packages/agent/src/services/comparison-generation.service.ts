import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import type { Directory } from '../entities/directory.entity';
import type { ComparisonData } from '@ever-works/contracts';
import type { FacadeOptions } from '@ever-works/plugin';
import { DataRepository, type IDataConfig } from '../generators/data-generator/data-repository';
import {
    selectNextPair,
    findManualPair,
    buildPairKey,
    type ComparisonPair,
    researchPair,
    type ResearchDependencies,
    generateComparison,
    type ComparisonAiDependencies,
} from '@ever-works/comparison-generator-plugin';

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

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly searchFacade: SearchFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        private readonly gitFacade: GitFacadeService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    private async findDirectoryOrFail(directoryId: string): Promise<Directory> {
        const directory = await this.directoryRepository.findById(directoryId);
        if (!directory) {
            throw new NotFoundException(`Directory not found: ${directoryId}`);
        }
        return directory;
    }

    /**
     * Generate the next automatic comparison for a directory.
     * Picks the best un-compared pair and generates a full comparison page.
     */
    async generateNextComparison(directoryId: string, userId: string): Promise<ComparisonResult> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions: GitFacadeOptions = {
            userId,
            providerId: directory.gitProvider,
        };

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

        const maxComparisons = 50;
        const minItems = 3;

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

        const gitOptions: GitFacadeOptions = {
            userId,
            providerId: directory.gitProvider,
        };

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
    }

    /**
     * List all comparisons for a directory.
     */
    async listComparisons(directoryId: string, userId: string): Promise<ComparisonData[]> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions: GitFacadeOptions = {
            userId,
            providerId: directory.gitProvider,
        };

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
            gitOptions,
        );
        const dataRepo = await DataRepository.create(dest);
        return dataRepo.getComparisons();
    }

    /**
     * Get a single comparison by slug.
     */
    async getComparison(
        directoryId: string,
        userId: string,
        slug: string,
    ): Promise<{ comparison: ComparisonData | null; markdown?: string }> {
        const directory = await this.findDirectoryOrFail(directoryId);

        const gitOptions: GitFacadeOptions = {
            userId,
            providerId: directory.gitProvider,
        };

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo: directory.getDataRepo() },
            gitOptions,
        );
        const dataRepo = await DataRepository.create(dest);
        const comparison = await dataRepo.getComparison(slug);
        const markdown = comparison ? await dataRepo.getComparisonMarkdown(slug) : undefined;

        return { comparison, markdown };
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

        const gitOptions: GitFacadeOptions = {
            userId,
            providerId: directory.gitProvider,
        };

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
        const facadeOptions: FacadeOptions = {
            userId: gitOptions.userId!,
            directoryId: directory.id,
        };

        // 1. Research the pair
        const researchDeps: ResearchDependencies = {
            search: async (query: string, limit: number) => {
                const results = await this.searchFacade.search(
                    query,
                    { maxResults: limit },
                    facadeOptions,
                );
                return results.map((r) => ({ url: r.url, snippet: r.title || '' }));
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
        const research = await researchPair(pair, researchDeps);

        // 2. Generate comparison via AI
        const aiDeps: ComparisonAiDependencies = {
            askJson: async <T>(prompt: string, _schema: Record<string, unknown>) => {
                const response = await this.aiFacade.askJson(
                    prompt,
                    comparisonStructureSchema,
                    undefined,
                    facadeOptions,
                );
                return response.result as T;
            },
            askText: async (prompt: string) => {
                const response = await this.aiFacade.createChatCompletion(
                    { messages: [{ role: 'user', content: prompt }] },
                    facadeOptions,
                );
                const content = response.choices[0]?.message?.content;
                return typeof content === 'string' ? content : '';
            },
        };

        this.logger.log(`Generating comparison: ${pair.itemA.name} vs ${pair.itemB.name}`);
        const result = await generateComparison(pair, research, aiDeps, {
            name: directory.name,
            description: directory.description,
        });

        // 3. Write to data repo
        await dataRepo.writeComparison(result.comparison);
        await dataRepo.writeComparisonMarkdown(result.comparison.slug, result.markdown);

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

        return {
            status: 'success',
            slug: result.comparison.slug,
            message: `Generated comparison: ${pair.itemA.name} vs ${pair.itemB.name}`,
        };
    }
}
