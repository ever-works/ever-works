import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { DataRepository } from './data-repository';
import type { IDataConfig, PRUpdate } from './data-repository';
import { slugifyText } from '../../utils/text.utils';
import type { Identifiable, ItemData, Category, Collection, Tag } from '@ever-works/contracts';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    ItemsGeneratorMetrics,
} from '../../items-generator/dto';
import { format } from 'date-fns';
import { GenerateStatusType } from '../../entities/types';
import { LEGAL_NOTICE, LICENSE_TEXT } from './texts';
import { WorkOperationsService } from '@src/work-operations';
import { getWorkOwner } from '../../utils/work.utils';
import pMap from 'p-map';
import { config } from '../../config';
import { PipelineOrchestratorService } from '../../pipeline';
import { buildWorkChangelog } from '../../utils/work-changelog.utils';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { assertCreatedRepositoryTarget } from '../../utils/git-repository.utils';
import { extractPipelineUsageMetrics } from '../../utils/metrics.util';
import type {
    WorkReference,
    GenerationRequest,
    ExistingItems as PluginExistingItems,
    PipelineResult,
    PipelineProgress,
    ReferenceEntry,
} from '@ever-works/plugin';
import { mergeReferences } from '@ever-works/plugin';
import type { WorkHistoryChangeEntry } from '@ever-works/contracts/api';
import type { GenerationLogCollector } from './generation-log-collector';
import { throwIfGenerationCancelled } from '@src/utils';
import { WorksConfigWriterService } from '@src/works-config/services/works-config-writer.service';
import type { ResolvedWorksConfig } from '@src/works-config/services/works-config.service';

const PARALLEL_WRITE_CONCURRENCY = 10;

const DEFAULT_ITEM_MARKDOWN = (item: ItemData) =>
    `# ${item.name}\n\n${item.description}\n\n[${item.source_url}](${item.source_url})`;

export type InitializeErrorCode =
    | 'CLONE_FAILED'
    | 'REPO_CREATE_FAILED'
    | 'DATA_REPO_FAILED'
    | 'GENERATION_FAILED'
    | 'PUSH_FAILED';

export type InitializeError = {
    code: InitializeErrorCode;
    message: string;
    cause?: Error;
};

export type GenerationStats = {
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    metrics?: ItemsGeneratorMetrics;
    changelog?: ReturnType<typeof buildWorkChangelog>;
};

const getWorkDefaultDataConfig = (work: Work): Partial<IDataConfig> => ({
    company_name: work.name || work.slug,
});

export type InitializeResult =
    | {
          success: true;
          prUpdate: PRUpdate | null;
          stats: GenerationStats;
          hasExistingItems: boolean;
          warnings?: string[];
      }
    | {
          success: false;
          error: InitializeError;
          hasExistingItems?: boolean;
          warnings?: string[];
      };

type UpdateMarkdownTemplateResult = {
    updated: boolean;
    reason?: 'not_initialized' | 'no_changes';
    message?: string;
};

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger(DataGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly pipelineOrchestrator: PipelineOrchestratorService,
        private readonly workOperations: WorkOperationsService,
        private readonly worksConfigWriter: WorksConfigWriterService,
    ) {}

    private getWorkOwner(work: Work): User {
        return getWorkOwner(work);
    }

    async initialize(
        work: Work,
        user: User,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        options?: {
            tryResume?: boolean;
            logCollector?: GenerationLogCollector;
            signal?: AbortSignal;
            worksConfig?: ResolvedWorksConfig | null;
        },
    ): Promise<InitializeResult> {
        this.logger.debug(
            `Initializing data repository for work: ${JSON.stringify(createItemsGeneratorDto)}`,
        );

        const throwIfCancelled = () => throwIfGenerationCancelled(options?.signal);

        let existingData = {
            existingItems: [],
            existingCategories: [],
            existingTags: [],
            existingCollections: [],
            existingReferences: [],
            existingConfig: null,
        };
        let existingItemsBeforeGeneration: ItemData[] = [];

        // Get existing data if available
        // get existing data only if we are in update mode
        if (createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE) {
            existingData = await this.getExistingData(work, user);
            existingItemsBeforeGeneration = existingData.existingItems;
        } else if (createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE) {
            existingItemsBeforeGeneration = (await this.getExistingData(work, user)).existingItems;
        }

        throwIfCancelled();

        const existed = existingData.existingItems.length > 0;

        const logCollector = options?.logCollector;

        // Execute pipeline to generate items
        const pipelineResult = await this.executePipeline(
            work,
            user,
            createItemsGeneratorDto,
            existingData,
            (progress) => {
                this.onGenerationProgress(progress, work, logCollector);
            },
            options?.tryResume,
            logCollector ? (entry) => logCollector.log(entry) : undefined,
            options?.signal,
        );

        if (!pipelineResult) {
            return {
                success: false,
                error: {
                    code: 'GENERATION_FAILED' as const,
                    message: 'Pipeline execution returned no result',
                    cause: new Error('Pipeline execution returned no result'),
                },
                warnings: [],
            };
        }

        const warnings = pipelineResult.warnings?.slice();

        // If pipeline failed or no items were generated, handle appropriately
        if (!pipelineResult.success) {
            return {
                success: false,
                error: {
                    code: 'GENERATION_FAILED' as const,
                    message: pipelineResult.error?.toString() || 'Pipeline execution failed',
                    cause:
                        pipelineResult.error instanceof Error
                            ? pipelineResult.error
                            : new Error(String(pipelineResult.error)),
                },
                warnings,
            };
        }

        throwIfCancelled();

        // If no items were generated, we don't need to do anything else
        if (pipelineResult.outputs.items.length === 0) {
            const generatedReferences = this.extractPipelineReferences(pipelineResult);
            if (generatedReferences.length > 0) {
                await this.persistReferencesToExistingDataRepository(
                    work,
                    user,
                    generatedReferences,
                    existingData.existingReferences,
                );
            }

            const stats: GenerationStats = {
                newItemsCount: 0,
                updatedItemsCount: 0,
                totalItemsCount: 0,
                metrics: this.convertPipelineMetrics(pipelineResult),
            };

            return { success: true, prUpdate: null, stats, warnings, hasExistingItems: existed };
        }

        const {
            categories: newCategories,
            items: newItems,
            tags: newTags,
            collections: newCollections,
        } = pipelineResult.outputs;
        const { existingCategories, existingTags, existingCollections } = existingData;
        const existingReferences = existingData.existingReferences;

        this.logger.debug(
            `Generated ${newCategories.length} categories, ${newItems.length} items, ${newTags.length} tags, ${newCollections.length} collections.`,
        );

        const description = `machine-readable data for ${work.slug}`;

        // Use work owner's credentials (they set up the repos)
        // but use current user as committer for attribution
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const owner = work.getRepoOwner();
        const repo = work.getDataRepo();

        throwIfCancelled();

        // Creating repository
        const createdRepository = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: repo,
                    description,
                    organization: work.organization ? owner : undefined,
                    isPrivate: true,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            ),
            owner,
            repo,
            'Data repository',
        );

        this.logger.log(`Successfully created repository: ${createdRepository.fullName}`);
        throwIfCancelled();

        // Cloning repository
        let dest: string;
        try {
            dest = await cloneFreshRepository(
                this.gitFacade,
                {
                    owner: createdRepository.owner,
                    repo: createdRepository.name,
                    committer,
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
                this.logger,
            );
        } catch (err) {
            this.logger.error('Failed to clone repository', err);
            return {
                success: false,
                error: {
                    code: 'CLONE_FAILED' as const,
                    message: `Failed to clone repository ${createdRepository.fullName}`,
                    cause: err instanceof Error ? err : new Error(String(err)),
                },
                warnings,
            };
        }

        let data: DataRepository;
        try {
            data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));
        } catch (err) {
            this.logger.error('Failed to create data repository', err);
            return {
                success: false,
                error: {
                    code: 'DATA_REPO_FAILED' as const,
                    message: 'Failed to create data repository from cloned work',
                    cause: err instanceof Error ? err : new Error(String(err)),
                },
                warnings,
            };
        }

        this.logger.log(`Cloned repository to ${dest}`);
        throwIfCancelled();

        try {
            // Ensure works exist
            await data.ensureWorksExist();
            await data.ensureDefaultConfig();

            // Name of the new branch if we are in update mode
            let newBranchName: string | null = null;

            const isRecreate =
                createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE;

            const isUpdate =
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE;
            const shouldCreatePR = createItemsGeneratorDto.update_with_pull_request;

            const provider = work.gitProvider;
            const defaultBranch = await this.gitFacade
                .getMainBranch(provider, dest)
                .catch((err) => {
                    this.logger.error('Failed to get main branch', err);
                    return null;
                });

            // Determine branching strategy
            if (shouldCreatePR && (isRecreate || (existed && isUpdate))) {
                // Ensure we are on main before creating a new branch
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, dest, defaultBranch)
                        .catch((err) => {
                            this.logger.error('Failed to switch to main branch', err);
                        });
                }

                newBranchName = `update-${Date.now()}`;
                await this.gitFacade.switchBranch(provider, dest, newBranchName, true);
                this.logger.log(`Created and switched to new branch: ${newBranchName}`);
            } else if (isRecreate) {
                // If Recreate and NO PR, switch to main
                this.logger.log('Recreating repository on main branch');
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, dest, defaultBranch)
                        .catch((err) => {
                            this.logger.error('Failed to switch to main branch', err);
                        });
                }
            }

            // Clear files if we are recreating
            if (isRecreate) {
                this.logger.log('Recreating repository, clearing existing files');
                await data.resetFiles();
            }

            const promises = [
                data.writeCategories(this.merge(existingCategories, [...newCategories])),
                data.writeTags(this.merge(existingTags, [...newTags])),
                data.writeCollections(this.merge(existingCollections, [...newCollections])),
            ];

            const generatedReferences = this.extractPipelineReferences(pipelineResult);
            if (generatedReferences.length > 0) {
                promises.push(
                    data.writeReferences(mergeReferences(existingReferences, generatedReferences)),
                );
            }

            const { title: prTitle, body: prBody } = this.getPRDetails(work);

            const isNewOrRecreate =
                !existed || createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE;

            /**
             * Rewrite meta files only if we are creating new repository or we are recreating it
             */
            if (isNewOrRecreate) {
                promises.push(
                    data.writeReadme(this.getDefaultReadme(work)),
                    data.writeLicense(LICENSE_TEXT),
                );
            }

            // Write markdown template if new/recreate OR if creating a PR branch
            if (isNewOrRecreate || newBranchName) {
                promises.push(
                    data.writeMarkdownTemplate(this.getHeader(work), this.getFooter(work)),
                );
            }

            // Build metadata - store the request data for scheduled runs
            // Plugin config is stored as-is; plugins handle their own defaults
            const metadata: Record<string, unknown> = {
                last_request_data: createItemsGeneratorDto,
            };

            // Only set initial_prompt if it doesn't exist yet (first creation)
            if (!existingData.existingConfig?.metadata?.initial_prompt) {
                metadata.initial_prompt = createItemsGeneratorDto.prompt;
            }

            if (newBranchName) {
                metadata.pr_update = {
                    branch: newBranchName,
                    title: prTitle,
                    body: prBody,
                };
            }

            promises.push(
                data.mergeConfig({
                    version: await data.getNextVersion(),
                    metadata,
                }),
            );

            // write categories, tags, readme, license, config, markdown template
            await Promise.all(promises);
            await this.worksConfigWriter.writeToDataRepository({
                work,
                dataRepository: data,
                request: createItemsGeneratorDto,
                importedWorksConfig: options?.worksConfig,
                initialPrompt:
                    existingData.existingConfig?.metadata?.initial_prompt ??
                    createItemsGeneratorDto.prompt,
            });
            throwIfCancelled();

            // Commit changes
            await this.gitFacade.addAll(provider, data.dir);

            await this.gitFacade.commit(
                provider,
                data.dir,
                existed ? 'update items' : 'init repository',
                work.resolveCommitter(user),
            );

            this.logger.debug('files written and committed.');

            // Items already have markdown from pipeline - write to disk
            this.logger.debug(`Writing ${newItems.length} items to disk...`);

            const existingSlugSet = new Set(
                (existingData.existingItems || []).map((item) =>
                    slugifyText(item.slug || item.name),
                ),
            );
            const existingItemsBySlug = new Map(
                (existingData.existingItems || []).map((item) => [
                    slugifyText(item.slug || item.name),
                    item,
                ]),
            );

            // Prepare items with slugs and count new vs updated
            // Create mutable copies since pipeline returns readonly items
            const itemsWithSlugs: ItemData[] = newItems.map((item) => {
                // Create mutable copies of arrays from readonly source
                const category: string | string[] = Array.isArray(item.category)
                    ? [...(item.category as readonly string[])]
                    : (item.category as string);

                const tags: string[] | Tag[] = (item.tags as readonly (string | Tag)[]).every(
                    (t): t is string => typeof t === 'string',
                )
                    ? [...(item.tags as readonly string[])]
                    : [...(item.tags as readonly Tag[])];

                const mutableItem: ItemData = {
                    name: item.name,
                    description: item.description,
                    source_url: item.source_url,
                    slug: slugifyText(item.slug || item.name),
                    category,
                    tags,
                    collection: item.collection,
                    featured: item.featured,
                    order: item.order,
                    markdown: item.markdown,
                    badges: item.badges,
                    brand: item.brand,
                    brand_logo_url: item.brand_logo_url,
                    images: item.images ? [...item.images] : undefined,
                    health: existingItemsBySlug.get(slugifyText(item.slug || item.name))?.health,
                    source_validation: existingItemsBySlug.get(slugifyText(item.slug || item.name))
                        ?.source_validation,
                };
                return mutableItem;
            });

            const newItemsCount = itemsWithSlugs.filter(
                (item) => !existingSlugSet.has(item.slug!),
            ).length;

            const updatedItemsCount = itemsWithSlugs.length - newItemsCount;
            const changelogEntries: WorkHistoryChangeEntry[] = itemsWithSlugs.map((item) => ({
                entityType: 'item',
                action: existingSlugSet.has(item.slug!) ? 'updated' : 'added',
                name: item.name,
                slug: item.slug,
            }));

            if (isRecreate && existingItemsBeforeGeneration.length > 0) {
                const generatedSlugSet = new Set(itemsWithSlugs.map((item) => item.slug!));
                const removedEntries = existingItemsBeforeGeneration
                    .filter((item) => {
                        const slug = slugifyText(item.slug || item.name);
                        return !generatedSlugSet.has(slug);
                    })
                    .map(
                        (item): WorkHistoryChangeEntry => ({
                            entityType: 'item',
                            action: 'removed',
                            name: item.name,
                            slug: slugifyText(item.slug || item.name),
                        }),
                    );

                changelogEntries.push(...removedEntries);
            }

            await pMap(
                itemsWithSlugs,
                (item) => {
                    return this.writeItemToDisk(data, item).catch((err) => {
                        this.logger.error(`Failed to write item ${item.slug}`, err);
                    });
                },
                { concurrency: PARALLEL_WRITE_CONCURRENCY },
            );
            throwIfCancelled();

            // Batch commit all items at once
            if (newItems.length > 0) {
                await this.gitFacade.addAll(provider, data.dir);
                const commitMessage =
                    newItemsCount > 0
                        ? `add ${newItemsCount} new item${newItemsCount > 1 ? 's' : ''}${updatedItemsCount > 0 ? `, update ${updatedItemsCount}` : ''}`
                        : `update ${updatedItemsCount} item${updatedItemsCount > 1 ? 's' : ''}`;

                await this.gitFacade.commit(
                    provider,
                    data.dir,
                    commitMessage,
                    work.resolveCommitter(user),
                );

                this.logger.debug(`Batch committed ${newItems.length} items`);
            }

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );
            this.logger.log(`All processed and pushed to ${work.getRepoOwner()}/${repo}`);

            // Update work items count
            await this.workOperations.updateWork(work.id, {
                itemsCount: pipelineResult.outputs.items.length + existingData.existingItems.length,
            });

            // Persist domain type if detected and not manually set
            if (pipelineResult.outputs.domainAnalysis && !work.domainTypeManuallySet) {
                await this.workOperations.updateWork(work.id, {
                    domainType: pipelineResult.outputs.domainAnalysis.domain_type,
                    domainTypeConfidence: pipelineResult.outputs.domainAnalysis.confidence,
                });
            }

            const stats: GenerationStats = {
                newItemsCount,
                updatedItemsCount,
                totalItemsCount: newItems.length,
                metrics: this.convertPipelineMetrics(pipelineResult),
                changelog: buildWorkChangelog(changelogEntries),
            };

            let prUpdate: PRUpdate | null = null;

            // create PR if we are in update mode and branch was created
            if (newBranchName && defaultBranch) {
                const pr = await this.gitFacade.createPullRequest(
                    {
                        owner: work.getRepoOwner(),
                        repo: repo,
                        head: newBranchName,
                        base: defaultBranch,
                        title: prTitle,
                        body: prBody,
                    },
                    {
                        userId: workOwner.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    },
                );

                prUpdate = {
                    branch: newBranchName,
                    title: prTitle,
                    body: prBody,
                    number: pr.number,
                    url: pr.url,
                };

                // Save PR details to the work
                await this.workOperations.updateLastPullRequest(work.id, {
                    data: {
                        branch: newBranchName,
                        title: prTitle,
                        body: prBody,
                        number: pr.number,
                        url: pr.url,
                    },
                });

                this.logger.log(
                    `Successfully created and pushed data repository - created PR ${newBranchName} to ${defaultBranch}`,
                );
            } else {
                this.logger.log(
                    `Successfully created and pushed data repository - initialized with ${newItems.length} items.`,
                );
            }

            return {
                success: true,
                prUpdate,
                stats,
                hasExistingItems: existed,
                warnings,
            };
        } catch (err) {
            this.logger.error('Failed to initialize data repository', err);
            return {
                success: false,
                error: {
                    code: 'GENERATION_FAILED' as const,
                    message: 'Failed to complete data repository initialization',
                    cause: err instanceof Error ? err : new Error(String(err)),
                },
                warnings,
            };
        }
    }

    async updateMarkdownTemplate(work: Work, user: User): Promise<UpdateMarkdownTemplateResult> {
        // Use work owner's credentials (they set up the repos)
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const owner = work.getRepoOwner();
        const repo = work.getDataRepo();

        const repoExists = await this.gitFacade
            .repositoryExists(owner, repo, {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            })
            .catch((error) => {
                this.logger.error(
                    `Failed to verify repository ${owner}/${repo} existence`,
                    error.message,
                );
                throw error;
            });

        if (!repoExists) {
            this.logger.warn(
                `Data repository ${owner}/${repo} not initialized. Skipping README template update.`,
            );
            return {
                updated: false,
                reason: 'not_initialized',
                message: 'Data repository is not initialized yet. Run a generation first.',
            };
        }

        const dest = await this.gitFacade.cloneOrPull(
            { owner, repo, committer },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const dataRepo = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

        await dataRepo.ensureWorksExist();

        await dataRepo.writeMarkdownTemplate(this.getHeader(work), this.getFooter(work));

        const changes = await this.gitFacade.getStatus(work.gitProvider, dataRepo.dir);
        const hasChanges = changes.length > 0;

        if (!hasChanges) {
            this.logger.log(`No README template changes detected for ${work.slug}`);
            return {
                updated: false,
                reason: 'no_changes',
                message: 'README template already up to date.',
            };
        }

        await this.gitFacade.addAll(work.gitProvider, dataRepo.dir);
        await this.gitFacade.commit(
            work.gitProvider,
            dataRepo.dir,
            'update README template',
            committer,
        );

        await this.gitFacade.push(
            { dir: dest },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        return {
            updated: true,
            message: 'README template updated successfully.',
        };
    }

    /**
     * Remove repository for a work
     * @param _user - Unused, kept for API consistency with other generator services
     */
    async removeRepository(work: Work, _user: User): Promise<void> {
        // Use work owner's credentials (they set up the repos)
        const workOwner = this.getWorkOwner(work);
        const repo = work.getDataRepo();

        try {
            // Delete the repository
            await this.gitFacade.deleteRepository(work.getRepoOwner(), repo, {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            });

            this.logger.log(`Successfully deleted data repository: ${work.getRepoOwner()}/${repo}`);
        } catch (error) {
            this.logger.error(
                `Failed to delete data repository ${work.getRepoOwner()}/${repo}:`,
                error,
            );
            throw error;
        }
    }

    public cleanup(work: Work) {
        const dataDir = this.gitFacade.getLocalDir(
            work.gitProvider,
            work.getRepoOwner(),
            work.getDataRepo(),
        );

        return DataRepository.create(dataDir, getWorkDefaultDataConfig(work)).then((data) =>
            data.cleanup(),
        );
    }

    /**
     * Get existing items from the repository
     */

    async getItems(work: Work, user: User) {
        return (await this.getExistingData(work, user)).existingItems;
    }

    async getCategoriesTags(work: Work, user: User) {
        const data = await this.repositoryData(work, user);

        const [categories, tags, collections] = await Promise.all([
            data.getCategories(),
            data.getTags(),
            data.getCollections(),
        ]);

        return {
            categories,
            tags,
            collections,
        };
    }

    /**
     * Save categories to the data repository and push changes
     */
    async saveCategories(work: Work, user: User, categories: Category[]) {
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const repo = work.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: work.getRepoOwner(), repo, committer },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

        await data.writeCategories(categories);

        await this.gitFacade.addAll(work.gitProvider, data.dir);
        await this.gitFacade.commit(work.gitProvider, data.dir, 'update categories', committer);
        await this.gitFacade.push(
            { dir: dest },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
    }

    /**
     * Save tags to the data repository and push changes
     */
    async saveTags(work: Work, user: User, tags: Tag[]) {
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const repo = work.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: work.getRepoOwner(), repo, committer },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

        await data.writeTags(tags);

        await this.gitFacade.addAll(work.gitProvider, data.dir);
        await this.gitFacade.commit(work.gitProvider, data.dir, 'update tags', committer);
        await this.gitFacade.push(
            { dir: dest },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
    }

    /**
     * Save collections to the data repository and push changes
     */
    async saveCollections(work: Work, user: User, collections: Collection[]) {
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const repo = work.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: work.getRepoOwner(), repo, committer },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

        await data.writeCollections(collections);

        await this.gitFacade.addAll(work.gitProvider, data.dir);
        await this.gitFacade.commit(work.gitProvider, data.dir, 'update collections', committer);
        await this.gitFacade.push(
            { dir: dest },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
    }

    async count(work: Work, user: User) {
        const data = await this.repositoryData(work, user);

        const [categories, tags, items, comparisons] = await Promise.allSettled([
            data.getCategories(),
            data.getTags(),
            data.countItems(),
            data.countComparisons(),
        ]);

        const getArrayCount = <T>(
            result: PromiseSettledResult<T[]>,
            label: 'categories' | 'tags',
        ): number => {
            if (result.status === 'fulfilled') {
                return result.value.length;
            }

            this.logger.warn(
                `Failed to count ${label} for work ${work.id}; defaulting to 0.`,
                result.reason instanceof Error ? result.reason.stack : undefined,
            );
            return 0;
        };

        const getNumberCount = (
            result: PromiseSettledResult<number>,
            label: 'items' | 'comparisons',
        ): number => {
            if (result.status === 'fulfilled') {
                return result.value;
            }

            this.logger.warn(
                `Failed to count ${label} for work ${work.id}; defaulting to 0.`,
                result.reason instanceof Error ? result.reason.stack : undefined,
            );
            return 0;
        };

        return {
            items: getNumberCount(items, 'items'),
            categories: getArrayCount(categories, 'categories'),
            tags: getArrayCount(tags, 'tags'),
            comparisons: getNumberCount(comparisons, 'comparisons'),
        };
    }

    async getConfig(work: Work, user: User) {
        const data = await this.repositoryData(work, user);
        return data.getConfig();
    }

    /**
     * Returns a lightweight snapshot of the data repository for sync purposes.
     * Uses the shared repositoryData() helper to respect cloning/pulling patterns.
     */
    async getDataSyncSnapshot(work: Work, user: User) {
        const data = await this.repositoryData(work, user);

        const [items, config, markdownTemplate] = await Promise.all([
            data.getItems().catch(() => []),
            data.getConfig().catch(() => null),
            data.readMarkdownTemplate().catch(() => null),
        ]);

        return {
            itemsCount: items.length,
            prUpdate: config?.metadata?.pr_update,
            readmeTemplate: markdownTemplate,
        };
    }

    /**
     * Update website settings in works.yaml and push to git repository.
     */
    async updateWebsiteSettings(
        work: Work,
        user: User,
        settings: {
            categories_enabled?: boolean;
            collections_enabled?: boolean;
            companies_enabled?: boolean;
            tags_enabled?: boolean;
            surveys_enabled?: boolean;
            header?: {
                submit_enabled?: boolean;
                pricing_enabled?: boolean;
                layout_enabled?: boolean;
                language_enabled?: boolean;
                theme_enabled?: boolean;
                layout_default?: string;
                pagination_default?: string;
                theme_default?: string;
            };
            homepage?: {
                hero_enabled?: boolean;
                search_enabled?: boolean;
                default_view?: string;
                default_sort?: string;
            };
            footer?: {
                subscribe_enabled?: boolean;
                version_enabled?: boolean;
                theme_selector_enabled?: boolean;
            };
        },
        customMenu?: {
            header?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
            footer?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
        },
        companyName?: string,
        companyWebsite?: string,
    ): Promise<void> {
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);

        const data = await this.repositoryData(work, user);
        const currentConfig = await data.getConfig();

        // Deep merge settings
        const newSettings = {
            ...currentConfig.settings,
            ...settings,
            header: settings.header
                ? { ...currentConfig.settings?.header, ...settings.header }
                : currentConfig.settings?.header,
            homepage: settings.homepage
                ? { ...currentConfig.settings?.homepage, ...settings.homepage }
                : currentConfig.settings?.homepage,
            footer: settings.footer
                ? { ...currentConfig.settings?.footer, ...settings.footer }
                : currentConfig.settings?.footer,
        };

        // Build new config
        const newConfig = {
            ...currentConfig,
            company_name: companyName !== undefined ? companyName : currentConfig.company_name,
            company_website:
                companyWebsite !== undefined ? companyWebsite : currentConfig.company_website,
            settings: newSettings,
            custom_menu: customMenu !== undefined ? customMenu : currentConfig.custom_menu,
        };

        await data.writeConfig(newConfig);

        await this.gitFacade.addAll(work.gitProvider, data.dir);
        await this.gitFacade.commit(
            work.gitProvider,
            data.dir,
            'update website settings',
            committer,
        );
        await this.gitFacade.push(
            { dir: data.dir },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        this.logger.log(`Successfully updated website settings for work ${work.slug}`);
    }

    private async repositoryData(work: Work, user: User) {
        // Use work owner's credentials (they set up the repos)
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);

        const repo = work.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            {
                owner: work.getRepoOwner(),
                repo,
                committer,
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

        return data;
    }

    /**
     * Execute the pipeline to generate items.
     * This method converts DTOs to plugin types and calls the pipeline orchestrator.
     *
     * @param work - The work entity
     * @param user - The user executing the generation (for multi-tenant context)
     * @param dto - The generation request DTO
     * @param existingData - Existing items for deduplication
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    private async executePipeline(
        work: Work,
        user: User,
        dto: CreateItemsGeneratorDto,
        existingData: {
            existingItems: ItemData[];
            existingCategories: Category[];
            existingTags: Tag[];
            existingCollections: Collection[];
            existingReferences: ReferenceEntry[];
            existingConfig: any;
        },
        onProgress?: (progress: PipelineProgress) => void,
        tryResume?: boolean,
        onLogEntry?: (log: import('@ever-works/contracts/api').GenerationStepLog) => void,
        signal?: AbortSignal,
    ): Promise<PipelineResult> {
        // Handle existing data reset for RECREATE mode
        let existing = { ...existingData };
        if (dto.generation_method === GenerationMethod.RECREATE) {
            existing = {
                existingItems: [],
                existingCategories: [],
                existingTags: [],
                existingCollections: [],
                existingReferences: [],
                existingConfig: null,
            };
        }

        // Convert Work entity to WorkReference (plugin type)
        // This includes user context for multi-tenant resolution
        const workRef: WorkReference = {
            id: work.id,
            name: work.name ?? work.slug,
            slug: work.slug,
            description: work.description,
            user: { id: user.id }, // User context for multi-tenant plugin resolution
        };

        const request: GenerationRequest = {
            name: dto.name,
            prompt: dto.prompt,
            aiModel: dto.model,
            generationMethod: dto.generation_method,
            config: dto.pluginConfig || {},
            pluginConfig: dto._processedPluginConfig || undefined,
            providers: dto.providers
                ? {
                      ai: dto.providers.ai,
                      search: dto.providers.search,
                      screenshot: dto.providers.screenshot,
                      contentExtractor: dto.providers.contentExtractor,
                      pipeline: dto.providers.pipeline,
                  }
                : undefined,
        };

        // Convert existing data to ExistingItems (plugin type)
        const pluginExisting: PluginExistingItems = {
            items: existing.existingItems ?? [],
            categories: existing.existingCategories ?? [],
            tags: existing.existingTags ?? [],
            collections: existing.existingCollections ?? [],
            brands: [],
            references: existing.existingReferences ?? [],
            existingConfig: existing.existingConfig,
        };

        this.logger.log(`Executing pipeline for work "${work.slug}" (user: ${user.id})`);

        const pipelineOptions =
            onLogEntry || signal
                ? {
                      ...(onLogEntry ? { onLogEntry } : {}),
                      ...(signal ? { signal } : {}),
                  }
                : undefined;

        // Execute the pipeline - the orchestrator handles plugin resolution
        return tryResume
            ? this.pipelineOrchestrator.resumeOrExecute(
                  workRef,
                  request,
                  pluginExisting,
                  pipelineOptions,
                  onProgress,
              )
            : this.pipelineOrchestrator.execute(
                  workRef,
                  request,
                  pluginExisting,
                  pipelineOptions,
                  onProgress,
              );
    }

    /**
     * Convert pipeline result metrics to legacy metrics format
     */
    private convertPipelineMetrics(result: PipelineResult): ItemsGeneratorMetrics | undefined {
        if (!result.metrics) {
            return undefined;
        }

        const usageMetrics = extractPipelineUsageMetrics(result.metrics);

        return {
            urls_scanned: 0,
            pages_processed: 0,
            items_extracted_current_run: result.outputs.items.length,
            new_items_added_to_store: result.outputs.items.length,
            total_items_in_store: result.outputs.items.length,
            ...usageMetrics,
        };
    }

    /**
     * Callback for generation progress
     */
    private async onGenerationProgress(
        progress: PipelineProgress,
        work: Work,
        logCollector?: GenerationLogCollector,
    ) {
        // Note: step_started/completed events are now emitted by pipeline executors
        // via onLogEntry → logCollector.log(), so we only update the generate status here.
        await this.workOperations.updateGenerateStatus(work.id, {
            status: GenerateStatusType.GENERATING,
            step: progress.message ?? progress.currentStepName,
            stepName: progress.currentStepName,
            stepIndex: progress.currentStepIndex,
            totalSteps: progress.totalSteps,
            progress: progress.percent,
            itemsProcessed: progress.itemsProcessed,
            recentLogs: logCollector?.getRecentLogs(),
        });
    }

    /**
     * Gets existing data from the repository if it exists, otherwise returns empty data
     */
    private async getExistingData(work: Work, user: User) {
        const workOwner = this.getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const repo = work.getDataRepo();

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner: work.getRepoOwner(), repo, committer },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );
            const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));

            const [categories, tags, collections, references, existingItems, config] =
                await Promise.all([
                    data.getCategories().catch(() => []),
                    data.getTags().catch(() => []),
                    data.getCollections().catch(() => []),
                    data.getReferences().catch(() => []),
                    data.getItems().catch(() => []),
                    data.getConfig().catch(() => null),
                ]);

            return {
                existingItems,
                existingCategories: categories,
                existingTags: tags,
                existingCollections: collections,
                existingReferences: references,
                existingConfig: config,
            };
        } catch {
            return {
                existingItems: [],
                existingCategories: [],
                existingTags: [],
                existingCollections: [],
                existingReferences: [],
                existingConfig: null,
            };
        }
    }

    private extractPipelineReferences(result: PipelineResult): ReferenceEntry[] {
        const references = result.outputs.extra?.references;
        return Array.isArray(references) ? (references as ReferenceEntry[]) : [];
    }

    private async persistReferencesToExistingDataRepository(
        work: Work,
        user: User,
        references: ReferenceEntry[],
        existingReferences: ReferenceEntry[],
    ): Promise<void> {
        const workOwner = this.getWorkOwner(work);
        const owner = work.getRepoOwner();
        const repo = work.getDataRepo();

        const repoExists = await this.gitFacade
            .repositoryExists(owner, repo, {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            })
            .catch(() => false);

        if (!repoExists) {
            return;
        }

        const dest = await this.gitFacade.cloneOrPull(
            {
                owner,
                repo,
                committer: work.resolveCommitter(user),
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));
        await data.writeReferences(mergeReferences(existingReferences, references));

        const changes = await this.gitFacade.getStatus(work.gitProvider, data.dir);
        if (changes.length === 0) {
            return;
        }

        await this.gitFacade.addAll(work.gitProvider, data.dir);
        await this.gitFacade.commit(
            work.gitProvider,
            data.dir,
            'update processed references',
            work.resolveCommitter(user),
        );
        await this.gitFacade.push(
            { dir: data.dir },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
    }

    private async writeItemToDisk(data: DataRepository, item: ItemData) {
        await data.createItemDir(item);
        const md = item.markdown || DEFAULT_ITEM_MARKDOWN(item);
        await Promise.all([data.writeItem(item), data.writeItemMarkdown(item, md)]);
    }

    private getPRDetails(work: Work) {
        const title = `Update data - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
        const appName = config.branding.getAppName();
        const platformWebsite = config.branding.getPlatformWebsite();
        const body = `Update data for ${work.slug}\n\nGenerated by [${appName}](${platformWebsite})`;
        return { title, body };
    }

    private merge(a: Identifiable[], b: Identifiable[]) {
        const map = new Map<string, Identifiable>();
        for (const item of a) {
            map.set(item.id, item);
        }
        for (const item of b) {
            map.set(item.id, item);
        }
        return Array.from(map.values());
    }

    private getDefaultReadme(work: Work) {
        // Construct URL based on work's repo provider
        const owner = work.getRepoOwner('work');
        const repo = work.getMainRepo();
        const markdownURL = this.gitFacade.getWebUrl(work.gitProvider, owner, repo);
        return (
            `# ${work.getDataRepo()}\n\n` +
            `This repository holds data used to generate [${repo}](${markdownURL})\n\n`
        );
    }

    private getHeader(work: Work) {
        const readmeConfig = work.readmeConfig;
        if (readmeConfig?.header && readmeConfig.overwriteDefaultHeader) {
            return readmeConfig.header;
        }

        let additionalHeader = readmeConfig?.header || '';
        if (additionalHeader) {
            additionalHeader = additionalHeader + '\n\n';
        }

        return `# ${work.name}\n\n` + `${work.description}\n\n` + additionalHeader;
    }

    private getFooter(work: Work) {
        const readmeConfig = work.readmeConfig;
        if (readmeConfig?.footer && readmeConfig.overwriteDefaultFooter) {
            return readmeConfig.footer;
        }

        let additionalFooter = readmeConfig?.footer || '';
        if (additionalFooter) {
            additionalFooter = additionalFooter + '\n\n';
        }

        return additionalFooter + LEGAL_NOTICE;
    }

    async initializeWithImportedData(
        work: Work,
        user: User,
        importedData: {
            items: ItemData[];
            categories: Identifiable[];
            tags: Identifiable[];
            collections?: Identifiable[];
            config?: Record<string, any>;
            worksConfig?: ResolvedWorksConfig | null;
            importRequest?: {
                sourceUrl: string;
                sourceType: string;
                sourceOwner: string;
                sourceRepo: string;
            };
        },
    ): Promise<InitializeResult> {
        const committer = work.resolveCommitter(user);

        try {
            // Create the data repository
            const repoName = work.getDataRepo();
            const repoOwner = work.getRepoOwner();

            this.logger.log(`Creating data repo: ${repoOwner}/${repoName}`);

            const createdRepository = assertCreatedRepositoryTarget(
                await this.gitFacade.createRepository(
                    {
                        name: repoName,
                        description: work.description,
                        organization: work.organization ? repoOwner : undefined,
                        isPrivate: true,
                    },
                    {
                        userId: user.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    },
                ),
                repoOwner,
                repoName,
                'Data repository',
            );

            // Clone the repository
            const dest = await cloneFreshRepository(
                this.gitFacade,
                {
                    owner: createdRepository.owner,
                    repo: createdRepository.name,
                    committer,
                    userId: user.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
                this.logger,
            );

            const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));
            await data.ensureWorksExist();

            // Write categories, tags, and collections
            if (importedData.categories.length > 0) {
                await data.writeCategories(importedData.categories);
            }
            if (importedData.tags.length > 0) {
                await data.writeTags(importedData.tags);
            }
            if (importedData.collections && importedData.collections.length > 0) {
                await data.writeCollections(importedData.collections);
            }

            const initialCategories = importedData.categories.map((c) => c.id);
            const initialPrompt = `Work imported from ${importedData.importRequest?.sourceOwner || 'external'}/${importedData.importRequest?.sourceRepo || 'source'}. Contains ${importedData.items.length} items across ${importedData.categories.length} categories.`;

            // Preserve existing metadata from imported config (data_repo/link_existing already have config)
            const existingMetadata = importedData.config?.metadata || {};

            const configData = {
                ...importedData.config,
                version: await data.getNextVersion(),
                metadata: {
                    ...existingMetadata,
                    initial_prompt: existingMetadata.initial_prompt ?? initialPrompt,
                },
            };

            // Only create default last_request_data if the imported config doesn't already have one
            if (!existingMetadata.last_request_data) {
                // Store minimal request data - plugin-specific defaults come from plugins
                const initialRequestData: Partial<CreateItemsGeneratorDto> = {
                    name: work.name,
                    prompt: configData.metadata.initial_prompt,
                    // pluginConfig is intentionally empty - plugins provide defaults
                    pluginConfig: {},
                };
                configData.metadata.last_request_data = initialRequestData;
            }

            await data.mergeConfig(configData);
            await this.worksConfigWriter.writeToDataRepository({
                work,
                dataRepository: data,
                request: configData.metadata.last_request_data,
                importedWorksConfig: importedData.worksConfig,
                initialPrompt: configData.metadata.initial_prompt,
            });

            // Write README and LICENSE
            await data.writeReadme(this.getDefaultReadme(work));
            await data.writeLicense(LICENSE_TEXT);

            // Write markdown templates
            await data.writeMarkdownTemplate(this.getHeader(work), this.getFooter(work));

            // Commit metadata files
            await this.gitFacade.addAll(work.gitProvider, data.dir);
            await this.gitFacade.commit(
                work.gitProvider,
                data.dir,
                'init repository with imported data',
                committer,
            );

            // Write items
            const itemsWithSlugs = importedData.items.map((item) => ({
                ...item,
                slug: item.slug || slugifyText(item.name),
            }));

            await pMap(itemsWithSlugs, (item) => this.writeItemToDisk(data, item), {
                concurrency: PARALLEL_WRITE_CONCURRENCY,
            });

            // Commit items
            await this.gitFacade.addAll(work.gitProvider, data.dir);
            await this.gitFacade.commit(
                work.gitProvider,
                data.dir,
                `add ${itemsWithSlugs.length} imported items`,
                committer,
            );

            // Push to remote
            await this.gitFacade.push(
                { dir: dest },
                { userId: user.id, providerId: work.gitProvider, workId: work.id },
            );

            this.logger.log(
                `Successfully initialized data repo with ${itemsWithSlugs.length} imported items`,
            );

            return {
                success: true,
                prUpdate: null,
                hasExistingItems: false,
                stats: {
                    newItemsCount: itemsWithSlugs.length,
                    updatedItemsCount: 0,
                    totalItemsCount: itemsWithSlugs.length,
                },
            };
        } catch (error) {
            this.logger.error('Failed to initialize with imported data', error);
            return {
                success: false,
                error: {
                    code: 'DATA_REPO_FAILED',
                    message: error.message || 'Failed to initialize data repository',
                    cause: error,
                },
            };
        }
    }

    async updateWithImportedData(
        work: Work,
        user: User,
        importedData: {
            items: ItemData[];
            categories: Identifiable[];
            tags: Identifiable[];
            collections?: Identifiable[];
            config?: Record<string, any>;
            worksConfig?: ResolvedWorksConfig | null;
        },
        options: {
            updateWithPullRequest: boolean;
            commitMessage?: string;
        } = { updateWithPullRequest: true },
    ): Promise<InitializeResult> {
        const committer = work.resolveCommitter(user);
        const repoName = work.getDataRepo();
        const repoOwner = work.getRepoOwner();

        try {
            this.logger.log(`Syncing imported data for: ${repoOwner}/${repoName}`);

            // Clone/Pull the repository
            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: repoName, committer },
                { userId: user.id, providerId: work.gitProvider, workId: work.id },
            );

            const data = await DataRepository.create(dest, getWorkDefaultDataConfig(work));
            await data.ensureWorksExist();
            await data.ensureDefaultConfig();

            // Get existing data to compare
            const existingItems = await data.getItems().catch(() => []);
            const existingSlugSet = new Set(
                existingItems.map((item) => slugifyText(item.slug || item.name)),
            );

            // Handle branching
            const provider = work.gitProvider;
            let newBranchName: string | null = null;
            const defaultBranch = await this.gitFacade
                .getMainBranch(provider, dest)
                .catch(() => 'main');

            if (options.updateWithPullRequest) {
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, dest, defaultBranch)
                        .catch(() => {});
                }
                newBranchName = `sync-${Date.now()}`;
                await this.gitFacade.switchBranch(provider, dest, newBranchName, true);
                this.logger.log(`Created sync branch: ${newBranchName}`);
            } else if (defaultBranch) {
                await this.gitFacade.switchBranch(provider, dest, defaultBranch).catch(() => {});
            }

            // Write categories, tags, and collections (merge)
            if (importedData.categories.length > 0) {
                const existingCategories = await data.getCategories().catch(() => []);
                await data.writeCategories(this.merge(existingCategories, importedData.categories));
            }
            if (importedData.tags.length > 0) {
                const existingTags = await data.getTags().catch(() => []);
                await data.writeTags(this.merge(existingTags, importedData.tags));
            }
            if (importedData.collections && importedData.collections.length > 0) {
                const existingCollections = await data.getCollections().catch(() => []);
                await data.writeCollections(
                    this.merge(existingCollections, importedData.collections),
                );
            }

            if (importedData.config) {
                const currentConfig = (await data.getConfig().catch(() => ({}))) as Record<
                    string,
                    any
                >;
                await data.mergeConfig({
                    ...currentConfig,
                    ...importedData.config,
                    version: await data.getNextVersion(),
                    metadata: {
                        ...(currentConfig.metadata || {}),
                        ...(importedData.config.metadata || {}),
                    },
                });
            }

            // Prepare items
            const existingItemsBySlug = new Map<string, ItemData>(
                existingItems.map((item) => [slugifyText(item.slug || item.name), item] as const),
            );
            const itemsWithSlugs = importedData.items.map((item) => {
                const slug = item.slug || slugifyText(item.name);
                const existingItem = existingItemsBySlug.get(slug);

                return {
                    ...item,
                    slug,
                    health: existingItem?.health,
                    source_validation: existingItem?.source_validation,
                };
            });

            // Calculate candidate stats. The final no-op decision is based on git status after
            // writing, because existing imported items may serialize to identical files.
            const newItemsCount = itemsWithSlugs.filter(
                (item) => !existingSlugSet.has(item.slug),
            ).length;
            const updatedItemsCount = itemsWithSlugs.length - newItemsCount;

            // Write items
            await pMap(itemsWithSlugs, (item) => this.writeItemToDisk(data, item), {
                concurrency: PARALLEL_WRITE_CONCURRENCY,
            });
            await this.worksConfigWriter.writeToDataRepository({
                work,
                dataRepository: data,
                request: importedData.config?.metadata?.last_request_data,
                importedWorksConfig: importedData.worksConfig,
                initialPrompt: importedData.config?.metadata?.initial_prompt,
            });

            const changes = await this.gitFacade.getStatus(provider, data.dir);

            if (changes.length === 0) {
                this.logger.log('No repository changes found during source sync.');
                return {
                    success: true,
                    prUpdate: null,
                    hasExistingItems: existingItems.length > 0,
                    stats: {
                        newItemsCount: 0,
                        updatedItemsCount: 0,
                        totalItemsCount: existingItems.length,
                    },
                };
            }

            // Commit
            await this.gitFacade.addAll(provider, data.dir);
            const commitMsg =
                options.commitMessage ||
                `sync: ${newItemsCount} new, ${updatedItemsCount} updated items`;

            await this.gitFacade.commit(provider, data.dir, commitMsg, committer);

            // Push
            await this.gitFacade.push(
                { dir: dest },
                { userId: user.id, providerId: work.gitProvider, workId: work.id },
            );

            // Update DB stats
            await this.workOperations.updateWork(work.id, {
                itemsCount: existingItems.length + newItemsCount,
            });

            const stats: GenerationStats = {
                newItemsCount,
                updatedItemsCount,
                totalItemsCount: existingItems.length + newItemsCount,
            };

            let prUpdate: PRUpdate | null = null;

            if (newBranchName && defaultBranch) {
                const pr = await this.gitFacade.createPullRequest(
                    {
                        owner: repoOwner,
                        repo: repoName,
                        head: newBranchName,
                        base: defaultBranch,
                        title: `Sync with source - ${format(new Date(), 'MM/dd/yyyy')}`,
                        body: `Automated sync from source repository.\n\nNew items: ${newItemsCount}\nUpdated items: ${updatedItemsCount}`,
                    },
                    {
                        userId: user.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    },
                );

                prUpdate = {
                    branch: newBranchName,
                    title: pr.title,
                    body: pr.body || '',
                    number: pr.number,
                    url: pr.url,
                };

                await this.workOperations.updateLastPullRequest(work.id, {
                    data: prUpdate,
                });
            }

            return {
                success: true,
                hasExistingItems: existingItems.length > 0,
                prUpdate,
                stats,
            };
        } catch (error) {
            this.logger.error('Failed to sync with imported data', error);
            return {
                success: false,
                error: {
                    code: 'GENERATION_FAILED',
                    message: error.message || 'Failed to sync data repository',
                    cause: error,
                },
            };
        }
    }
}
