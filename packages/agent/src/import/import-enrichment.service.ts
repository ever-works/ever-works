import { Injectable, Logger } from '@nestjs/common';
import type { ItemData, Category, Tag } from '@ever-works/contracts';
import type {
    GenerationRequest,
    ExistingItems,
    DirectoryReference,
    PipelineResult,
    PipelineOutputs,
} from '@ever-works/plugin';

import { PipelineOrchestratorService } from '@src/pipeline/pipeline-orchestrator.service';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { Directory, ImportSourceType } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import type { ImportEnrichmentConfigDto } from '@src/dto/import-directory.dto';
import {
    DirectoryImportResult,
    DirectoryImportErrorCode,
    EnrichmentMetrics,
} from '@src/tasks/directory-import.types';
import { GitIssuePrParserService, GitFacadeOptionsForParsing } from './git-issue-pr-parser.service';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';

/** Resolved enrichment configuration with defaults applied */
interface ResolvedEnrichmentConfig {
    expansionFactor: number;
    maxImportProportion: number;
    parseIssues: boolean;
    parsePullRequests: boolean;
    enrichDescriptions: boolean;
    expandTaxonomy: boolean;
}

export interface ImportEnrichmentProgress {
    phase: 'parsing' | 'pr_issues' | 'enriching' | 'merging' | 'finalizing';
    message: string;
    seedCount?: number;
    newItemCount?: number;
}

export interface EnrichImportOptions {
    directory: Directory;
    user: User;
    seedItems: ItemData[];
    seedCategories: Category[];
    seedTags: Tag[];
    sourceUrl: string;
    config?: ImportEnrichmentConfigDto;
    aiProviderOverride?: string;
    pipelineProvider?: string;
    gitFacadeOptions?: GitFacadeOptionsForParsing;
    onProgress?: (progress: ImportEnrichmentProgress) => void;
}

/** Maximum items per pipeline run for chunking */
const MAX_SEED_ITEMS_PER_RUN = 500;

/** Maximum pages to process in pipeline for import enrichment */
const MAX_PIPELINE_PAGES = 1000;

/**
 * The agent-pipeline plugin ID — used to explicitly route enrichment to it.
 * Matches the `id` field in agent-pipeline's package.json `everworks.plugin`.
 */
const AGENT_PIPELINE_ID = 'agent-pipeline';

/** Baseline maxSteps for enrichment (agent-pipeline default is 100) */
const ENRICHMENT_BASE_MAX_STEPS = 100;

/** Hard cap on maxSteps (agent-pipeline setting max) */
const ENRICHMENT_MAX_STEPS_CAP = 2000;

@Injectable()
export class ImportEnrichmentService {
    private readonly logger = new Logger(ImportEnrichmentService.name);

    constructor(
        private readonly pipelineOrchestrator: PipelineOrchestratorService,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly gitIssuePrParser: GitIssuePrParserService,
        private readonly sourceRepoAnalyzer: SourceRepoAnalyzerService,
    ) {}

    async enrichImport(options: EnrichImportOptions): Promise<DirectoryImportResult> {
        const {
            directory,
            user,
            seedItems,
            seedCategories,
            seedTags,
            sourceUrl,
            aiProviderOverride,
            pipelineProvider,
            gitFacadeOptions,
            onProgress,
        } = options;

        const config = this.resolveConfig(options.config);

        this.logger.log(
            `Starting import enrichment for "${directory.name}" with ${seedItems.length} seed items ` +
                `(expansion: ${config.expansionFactor}x, maxImportProportion: ${config.maxImportProportion})`,
        );

        try {
            // Phase 1: Parse PRs/issues if configured
            let prIssueItems: ItemData[] = [];
            let itemsFromPrIssues = 0;

            if ((config.parsePullRequests || config.parseIssues) && gitFacadeOptions) {
                onProgress?.({
                    phase: 'pr_issues',
                    message: 'Parsing PRs and issues for additional items...',
                });

                const parsed = this.sourceRepoAnalyzer.parseGitUrl(sourceUrl);
                if (parsed) {
                    const prResult = await this.gitIssuePrParser.parseIssuesAndPrs({
                        owner: parsed.owner,
                        repo: parsed.repo,
                        facadeOptions: gitFacadeOptions,
                        seedItems,
                        maxPrPages: 3,
                    });
                    prIssueItems = prResult.candidates;
                    itemsFromPrIssues = prIssueItems.length;
                    this.logger.log(
                        `Found ${itemsFromPrIssues} additional candidates from PRs/issues`,
                    );
                }
            }

            // Combine seed items with PR/issue candidates
            const allSeedItems = [...seedItems, ...prIssueItems];

            // Phase 2: Initialize directory with seed data
            onProgress?.({
                phase: 'parsing',
                message: 'Initializing directory with seed data...',
                seedCount: allSeedItems.length,
            });

            const parsedUrl = this.sourceRepoAnalyzer.parseGitUrl(sourceUrl);
            const initResult = await this.dataGenerator.initializeWithImportedData(
                directory,
                user,
                {
                    items: allSeedItems,
                    categories: seedCategories,
                    tags: seedTags,
                    config: {
                        metadata: {
                            imported_from: parsedUrl
                                ? `${parsedUrl.owner}/${parsedUrl.repo}`
                                : sourceUrl,
                            imported_at: new Date().toISOString(),
                            import_type: 'awesome_readme_enriched',
                            enrichment_config: {
                                expansionFactor: config.expansionFactor,
                                maxImportProportion: config.maxImportProportion,
                            },
                        },
                    },
                    importRequest: {
                        sourceUrl,
                        sourceType: 'awesome_readme' as ImportSourceType,
                        sourceOwner: parsedUrl?.owner || '',
                        sourceRepo: parsedUrl?.repo || '',
                    },
                },
            );

            if (initResult.success === false) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: initResult.error.message || 'Failed to initialize data repository',
                    errorCode: DirectoryImportErrorCode.CREATE_REPO_FAILED,
                };
            }

            // Phase 3: Run enrichment pipeline
            onProgress?.({
                phase: 'enriching',
                message: 'Running AI enrichment pipeline...',
                seedCount: allSeedItems.length,
            });

            const pipelineResult = await this.runEnrichmentPipeline(
                directory,
                user,
                allSeedItems,
                seedCategories,
                seedTags,
                sourceUrl,
                config,
                aiProviderOverride,
                pipelineProvider,
            );

            // Phase 4: Merge results and generate compliance report
            onProgress?.({
                phase: 'merging',
                message: 'Merging enriched results...',
                seedCount: allSeedItems.length,
                newItemCount: pipelineResult?.outputs?.items?.length ?? 0,
            });

            const pipelineOutputs = pipelineResult?.outputs;

            const enrichmentMetrics = this.buildEnrichmentMetrics(
                seedItems.length,
                seedCategories.length,
                seedTags.length,
                pipelineOutputs ?? null,
                config,
                itemsFromPrIssues,
            );

            // Phase 5: Initialize markdown and website
            onProgress?.({ phase: 'finalizing', message: 'Generating markdown and website...' });

            await this.markdownGenerator.initialize(directory, user);
            await this.websiteGenerator.initialize(directory, user);

            this.logger.log(
                `Import enrichment complete: ${enrichmentMetrics.finalItemCount} total items ` +
                    `(${enrichmentMetrics.seedItemCount} seed, expansion ratio: ${enrichmentMetrics.expansionRatio.toFixed(2)}x)`,
            );

            return {
                success: true,
                directoryId: directory.id,
                itemsImported: enrichmentMetrics.finalItemCount,
                categoriesImported: enrichmentMetrics.finalCategoryCount,
                tagsImported: enrichmentMetrics.finalTagCount,
                enrichmentMetrics,
                metrics: pipelineResult?.metrics
                    ? {
                          total_tokens_used: pipelineResult.metrics.itemsProcessed,
                      }
                    : undefined,
            };
        } catch (error) {
            this.logger.error('Import enrichment failed', error);
            return {
                success: false,
                directoryId: directory.id,
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.ENRICHMENT_FAILED,
            };
        }
    }

    private async runEnrichmentPipeline(
        directory: Directory,
        user: User,
        seedItems: ItemData[],
        seedCategories: Category[],
        seedTags: Tag[],
        sourceUrl: string,
        config: ResolvedEnrichmentConfig,
        aiProviderOverride?: string,
        pipelineProvider?: string,
    ): Promise<PipelineResult | null> {
        const targetNewItems = Math.ceil(seedItems.length * (config.expansionFactor - 1));
        const maxPct = Math.round(config.maxImportProportion * 100);

        const prompt = this.buildEnrichmentPrompt(
            seedItems.length,
            sourceUrl,
            targetNewItems,
            maxPct,
            seedCategories.length,
            seedTags.length,
            config,
        );

        const directoryRef: DirectoryReference = {
            id: directory.id,
            name: directory.name,
            slug: directory.slug,
            description: directory.description,
            user: { id: user.id },
        };

        const existing: ExistingItems = {
            items: seedItems,
            categories: seedCategories,
            tags: seedTags,
        };

        // Scale maxSteps for enrichment: more seed items need more tool-calling iterations.
        // Baseline is 100 (agent-pipeline default); scale up based on seed count × expansion factor.
        const enrichmentMaxSteps = Math.min(
            ENRICHMENT_MAX_STEPS_CAP,
            Math.max(
                ENRICHMENT_BASE_MAX_STEPS,
                Math.ceil(seedItems.length * config.expansionFactor * 4),
            ),
        );

        const request: GenerationRequest = {
            name: directory.name,
            prompt,
            generationMethod: 'create-update',
            config: {
                target_items: targetNewItems,
                max_pages_to_process: Math.min(
                    MAX_PIPELINE_PAGES,
                    Math.max(20, seedItems.length * 2),
                ),
                capture_screenshots: true,
            },
            pluginConfig: {
                [AGENT_PIPELINE_ID]: { maxSteps: enrichmentMaxSteps },
            },
            providers: {
                ai: aiProviderOverride,
                pipeline: pipelineProvider ?? AGENT_PIPELINE_ID,
            },
        };

        // For large seed sets, use chunking
        if (seedItems.length > MAX_SEED_ITEMS_PER_RUN) {
            return this.runChunkedPipeline(directoryRef, request, existing, seedCategories, config);
        }

        try {
            return await this.pipelineOrchestrator.execute(directoryRef, request, existing);
        } catch (error) {
            this.logger.error('Pipeline execution failed, enrichment will be partial', error);
            return null;
        }
    }

    private async runChunkedPipeline(
        directory: DirectoryReference,
        baseRequest: GenerationRequest,
        existing: ExistingItems,
        seedCategories: Category[],
        config: ResolvedEnrichmentConfig,
    ): Promise<PipelineResult | null> {
        const items = [...existing.items];
        const chunkSize = MAX_SEED_ITEMS_PER_RUN;
        const chunks = this.chunkItemsByCategory(items, seedCategories, chunkSize);

        this.logger.log(
            `Large import (${items.length} items): splitting into ${chunks.length} pipeline runs`,
        );

        let accumulatedItems: ItemData[] = [];
        let accumulatedCategories: Category[] = [];
        let accumulatedTags: Tag[] = [];
        let lastResult: PipelineResult | null = null;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const targetForChunk = Math.ceil(chunk.length * (config.expansionFactor - 1));

            const chunkExisting: ExistingItems = {
                items: [...chunk, ...accumulatedItems],
                categories: existing.categories,
                tags: existing.tags,
            };

            const chunkRequest: GenerationRequest = {
                ...baseRequest,
                prompt: `${baseRequest.prompt}\n\nThis is chunk ${i + 1} of ${chunks.length}. Focus on discovering items related to the ${chunk.length} seed items in this batch.`,
                config: {
                    ...baseRequest.config,
                    target_items: targetForChunk,
                },
            };

            try {
                const result = await this.pipelineOrchestrator.execute(
                    directory,
                    chunkRequest,
                    chunkExisting,
                );

                if (result?.outputs?.items) {
                    accumulatedItems.push(...(result.outputs.items as ItemData[]));
                }
                if (result?.outputs?.categories) {
                    accumulatedCategories.push(...(result.outputs.categories as Category[]));
                }
                if (result?.outputs?.tags) {
                    accumulatedTags.push(...(result.outputs.tags as Tag[]));
                }
                lastResult = result;
            } catch (error) {
                this.logger.warn(
                    `Chunk ${i + 1}/${chunks.length} failed: ${(error as Error).message}`,
                );
            }
        }

        if (!lastResult) return null;

        const mergedOutputs: PipelineOutputs = {
            items: accumulatedItems,
            categories: accumulatedCategories,
            tags: accumulatedTags,
            collections: lastResult.outputs?.collections ?? [],
            brands: lastResult.outputs?.brands ?? [],
        };

        return {
            ...lastResult,
            outputs: mergedOutputs,
        };
    }

    private chunkItemsByCategory(
        items: readonly ItemData[],
        categories: Category[],
        maxPerChunk: number,
    ): ItemData[][] {
        // Group items by category
        const byCategory = new Map<string, ItemData[]>();
        for (const item of items) {
            const cat = Array.isArray(item.category) ? item.category[0] || '' : item.category || '';
            if (!byCategory.has(cat)) {
                byCategory.set(cat, []);
            }
            byCategory.get(cat)!.push(item as ItemData);
        }

        // Pack categories into chunks up to maxPerChunk
        const chunks: ItemData[][] = [];
        let currentChunk: ItemData[] = [];

        for (const [, catItems] of byCategory) {
            if (currentChunk.length + catItems.length > maxPerChunk && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
            }
            currentChunk.push(...catItems);
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    private buildEnrichmentPrompt(
        seedCount: number,
        sourceUrl: string,
        targetNewItems: number,
        maxPct: number,
        seedCategoryCount: number,
        seedTagCount: number,
        config: ResolvedEnrichmentConfig,
    ): string {
        const sections: string[] = [];

        sections.push(
            `You are enriching a directory that was seeded from an external repository.`,
            `The workspace contains ${seedCount} seed items from "${sourceUrl}".`,
            ``,
            `IMPORTANT: The seed items are research input only — do NOT treat them as final content.`,
            ``,
        );

        sections.push(
            `GOAL 1 — EXPAND:`,
            `Discover at least ${targetNewItems} NEW items in the same domain via web search.`,
            `Imported items should represent at most ${maxPct}% of the final collection.`,
            `Search broadly using multiple queries. Look for alternatives, competitors, and related tools`,
            `that are NOT in the seed list.`,
            ``,
        );

        if (config.enrichDescriptions) {
            sections.push(
                `GOAL 2 — REWRITE:`,
                `Use modifyItems to rewrite ALL existing item descriptions. For each item:`,
                `- Do NOT keep original descriptions verbatim — rewrite and significantly expand them`,
                `- Add: what the tool/project does (2-3 sentences), key features, use cases`,
                `- Add comparisons to alternatives where relevant`,
                `- Add images/screenshots where available`,
                ``,
            );
        }

        if (config.expandTaxonomy) {
            sections.push(
                `GOAL 3 — TAXONOMY:`,
                `Propose new categories beyond the ${seedCategoryCount} existing ones.`,
                `Target: seed categories should be ~30% of the final taxonomy.`,
                `Reorganize items into the expanded taxonomy where it makes sense.`,
                ``,
                `GOAL 4 — TAGS:`,
                `Expand the tag set significantly beyond the ${seedTagCount} current tags.`,
                `Add descriptive, useful tags that help users filter and discover items.`,
                ``,
            );
        }

        return sections.join('\n');
    }

    private buildEnrichmentMetrics(
        seedItemCount: number,
        seedCategoryCount: number,
        seedTagCount: number,
        pipelineOutputs: PipelineOutputs | null,
        config: ResolvedEnrichmentConfig,
        itemsFromPrIssues: number,
    ): EnrichmentMetrics {
        const newItems = pipelineOutputs?.items?.length ?? 0;
        const finalItemCount = seedItemCount + newItems;
        const expansionRatio = seedItemCount > 0 ? finalItemCount / seedItemCount : 1;
        const importProportion = finalItemCount > 0 ? seedItemCount / finalItemCount : 1;

        const finalCategoryCount = pipelineOutputs?.categories?.length ?? seedCategoryCount;
        const finalTagCount = pipelineOutputs?.tags?.length ?? seedTagCount;
        const newCategoriesAdded = Math.max(0, finalCategoryCount - seedCategoryCount);
        const newTagsAdded = Math.max(0, finalTagCount - seedTagCount);

        return {
            seedItemCount,
            finalItemCount,
            expansionRatio,
            seedCategoryCount,
            finalCategoryCount,
            seedTagCount,
            finalTagCount,
            itemsFromPrIssues,
            complianceReport: {
                importProportion,
                withinTarget: importProportion <= config.maxImportProportion,
                enrichedDescriptions: config.enrichDescriptions ? seedItemCount : 0,
                newCategoriesAdded,
                newTagsAdded,
            },
        };
    }

    private resolveConfig(input?: ImportEnrichmentConfigDto): ResolvedEnrichmentConfig {
        return {
            expansionFactor: Math.max(1.5, Math.min(5, input?.expansionFactor ?? 2.5)),
            maxImportProportion: Math.max(0.1, Math.min(0.5, input?.maxImportProportion ?? 0.35)),
            parseIssues: input?.parseIssues ?? false,
            parsePullRequests: input?.parsePullRequests ?? false,
            enrichDescriptions: input?.enrichDescriptions ?? true,
            expandTaxonomy: input?.expandTaxonomy ?? true,
        };
    }
}
