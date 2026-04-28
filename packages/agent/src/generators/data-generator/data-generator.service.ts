import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { DataRepository, PRUpdate } from './data-repository';
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
import { DirectoryOperationsService } from '@src/directory-operations';
import { getDirectoryOwner } from '../../utils/directory.utils';
import pMap from 'p-map';
import { config } from '../../config';
import { PipelineOrchestratorService } from '../../pipeline';
import { buildDirectoryChangelog } from '../../utils/directory-changelog.utils';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { assertCreatedRepositoryTarget } from '../../utils/git-repository.utils';
import { extractPipelineUsageMetrics } from '../../utils/metrics.util';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems as PluginExistingItems,
    PipelineResult,
    PipelineProgress,
} from '@ever-works/plugin';
import type { DirectoryHistoryChangeEntry } from '@ever-works/contracts/api';
import type { GenerationLogCollector } from './generation-log-collector';
import { GENERATION_CANCELLED } from '@src/constants/messages';
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
    changelog?: ReturnType<typeof buildDirectoryChangelog>;
};

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
        private readonly directoryOperations: DirectoryOperationsService,
        private readonly worksConfigWriter: WorksConfigWriterService,
    ) {}

    private getDirectoryOwner(directory: Directory): User {
        return getDirectoryOwner(directory);
    }

    async initialize(
        directory: Directory,
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
            `Initializing data repository for directory: ${JSON.stringify(createItemsGeneratorDto)}`,
        );

        const throwIfCancelled = () => {
            if (options?.signal?.aborted) {
                const reason = options.signal.reason;
                if (reason instanceof Error) {
                    throw reason;
                }

                const error = new Error(GENERATION_CANCELLED);
                error.name = 'AbortError';
                throw error;
            }
        };

        let existingData = {
            existingItems: [],
            existingCategories: [],
            existingTags: [],
            existingCollections: [],
            existingConfig: null,
        };
        let existingItemsBeforeGeneration: ItemData[] = [];

        // Get existing data if available
        // get existing data only if we are in update mode
        if (createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE) {
            existingData = await this.getExistingData(directory, user);
            existingItemsBeforeGeneration = existingData.existingItems;
        } else if (createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE) {
            existingItemsBeforeGeneration = (await this.getExistingData(directory, user))
                .existingItems;
        }

        throwIfCancelled();

        const existed = existingData.existingItems.length > 0;

        const logCollector = options?.logCollector;

        // Execute pipeline to generate items
        const pipelineResult = await this.executePipeline(
            directory,
            user,
            createItemsGeneratorDto,
            existingData,
            (progress) => {
                this.onGenerationProgress(progress, directory, logCollector);
            },
            options?.tryResume,
            logCollector ? (entry) => logCollector.log(entry) : undefined,
            options?.signal,
        );

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
        if (!pipelineResult || pipelineResult.outputs.items.length === 0) {
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

        this.logger.debug(
            `Generated ${newCategories.length} categories, ${newItems.length} items, ${newTags.length} tags, ${newCollections.length} collections.`,
        );

        const description = `machine-readable data for ${directory.slug}`;

        // Use directory owner's credentials (they set up the repos)
        // but use current user as committer for attribution
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const owner = directory.getRepoOwner();
        const repo = directory.getDataRepo();

        throwIfCancelled();

        // Creating repository
        const createdRepository = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: repo,
                    description,
                    organization: directory.organization ? owner : undefined,
                    isPrivate: true,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
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
                    userId: directoryOwner.id,
                    providerId: directory.gitProvider,
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
            data = await DataRepository.create(dest);
        } catch (err) {
            this.logger.error('Failed to create data repository', err);
            return {
                success: false,
                error: {
                    code: 'DATA_REPO_FAILED' as const,
                    message: 'Failed to create data repository from cloned directory',
                    cause: err instanceof Error ? err : new Error(String(err)),
                },
                warnings,
            };
        }

        this.logger.log(`Cloned repository to ${dest}`);
        throwIfCancelled();

        try {
            // Ensure directories exist
            await data.ensureDirectoriesExist();
            await data.ensureDefaultConfig();

            // Name of the new branch if we are in update mode
            let newBranchName: string | null = null;

            const isRecreate =
                createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE;

            const isUpdate =
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE;
            const shouldCreatePR = createItemsGeneratorDto.update_with_pull_request;

            const provider = directory.gitProvider;
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

            const { title: prTitle, body: prBody } = this.getPRDetails(directory);

            const isNewOrRecreate =
                !existed || createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE;

            /**
             * Rewrite meta files only if we are creating new repository or we are recreating it
             */
            if (isNewOrRecreate) {
                promises.push(
                    data.writeReadme(this.getDefaultReadme(directory)),
                    data.writeLicense(LICENSE_TEXT),
                );
            }

            // Write markdown template if new/recreate OR if creating a PR branch
            if (isNewOrRecreate || newBranchName) {
                promises.push(
                    data.writeMarkdownTemplate(
                        this.getHeader(directory),
                        this.getFooter(directory),
                    ),
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
                directory,
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
                directory.resolveCommitter(user),
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
            const changelogEntries: DirectoryHistoryChangeEntry[] = itemsWithSlugs.map((item) => ({
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
                        (item): DirectoryHistoryChangeEntry => ({
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
                    directory.resolveCommitter(user),
                );

                this.logger.debug(`Batch committed ${newItems.length} items`);
            }

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );
            this.logger.log(`All processed and pushed to ${directory.getRepoOwner()}/${repo}`);

            // Update directory items count
            await this.directoryOperations.updateDirectory(directory.id, {
                itemsCount: pipelineResult.outputs.items.length + existingData.existingItems.length,
            });

            // Persist domain type if detected and not manually set
            if (pipelineResult.outputs.domainAnalysis && !directory.domainTypeManuallySet) {
                await this.directoryOperations.updateDirectory(directory.id, {
                    domainType: pipelineResult.outputs.domainAnalysis.domain_type,
                    domainTypeConfidence: pipelineResult.outputs.domainAnalysis.confidence,
                });
            }

            const stats: GenerationStats = {
                newItemsCount,
                updatedItemsCount,
                totalItemsCount: newItems.length,
                metrics: this.convertPipelineMetrics(pipelineResult),
                changelog: buildDirectoryChangelog(changelogEntries),
            };

            let prUpdate: PRUpdate | null = null;

            // create PR if we are in update mode and branch was created
            if (newBranchName && defaultBranch) {
                const pr = await this.gitFacade.createPullRequest(
                    {
                        owner: directory.getRepoOwner(),
                        repo: repo,
                        head: newBranchName,
                        base: defaultBranch,
                        title: prTitle,
                        body: prBody,
                    },
                    { userId: directoryOwner.id, providerId: directory.gitProvider },
                );

                prUpdate = {
                    branch: newBranchName,
                    title: prTitle,
                    body: prBody,
                    number: pr.number,
                    url: pr.url,
                };

                // Save PR details to the directory
                await this.directoryOperations.updateLastPullRequest(directory.id, {
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

    async updateMarkdownTemplate(
        directory: Directory,
        user: User,
    ): Promise<UpdateMarkdownTemplateResult> {
        // Use directory owner's credentials (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const owner = directory.getRepoOwner();
        const repo = directory.getDataRepo();

        const repoExists = await this.gitFacade
            .repositoryExists(owner, repo, {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
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
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const dataRepo = await DataRepository.create(dest);

        await dataRepo.ensureDirectoriesExist();

        await dataRepo.writeMarkdownTemplate(this.getHeader(directory), this.getFooter(directory));

        const changes = await this.gitFacade.getStatus(directory.gitProvider, dataRepo.dir);
        const hasChanges = changes.length > 0;

        if (!hasChanges) {
            this.logger.log(`No README template changes detected for ${directory.slug}`);
            return {
                updated: false,
                reason: 'no_changes',
                message: 'README template already up to date.',
            };
        }

        await this.gitFacade.addAll(directory.gitProvider, dataRepo.dir);
        await this.gitFacade.commit(
            directory.gitProvider,
            dataRepo.dir,
            'update README template',
            committer,
        );

        await this.gitFacade.push(
            { dir: dest },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        return {
            updated: true,
            message: 'README template updated successfully.',
        };
    }

    /**
     * Remove repository for a directory
     * @param _user - Unused, kept for API consistency with other generator services
     */
    async removeRepository(directory: Directory, _user: User): Promise<void> {
        // Use directory owner's credentials (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const repo = directory.getDataRepo();

        try {
            // Delete the repository
            await this.gitFacade.deleteRepository(directory.getRepoOwner(), repo, {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
            });

            this.logger.log(
                `Successfully deleted data repository: ${directory.getRepoOwner()}/${repo}`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to delete data repository ${directory.getRepoOwner()}/${repo}:`,
                error,
            );
            throw error;
        }
    }

    public cleanup(directory: Directory) {
        const dataDir = this.gitFacade.getLocalDir(
            directory.gitProvider,
            directory.getRepoOwner(),
            directory.getDataRepo(),
        );

        return DataRepository.create(dataDir).then((data) => data.cleanup());
    }

    /**
     * Get existing items from the repository
     */

    async getItems(directory: Directory, user: User) {
        return (await this.getExistingData(directory, user)).existingItems;
    }

    async getCategoriesTags(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);

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
    async saveCategories(directory: Directory, user: User, categories: Category[]) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const repo = directory.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo, committer },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const data = await DataRepository.create(dest);

        await data.writeCategories(categories);

        await this.gitFacade.addAll(directory.gitProvider, data.dir);
        await this.gitFacade.commit(
            directory.gitProvider,
            data.dir,
            'update categories',
            committer,
        );
        await this.gitFacade.push(
            { dir: dest },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );
    }

    /**
     * Save tags to the data repository and push changes
     */
    async saveTags(directory: Directory, user: User, tags: Tag[]) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const repo = directory.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo, committer },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const data = await DataRepository.create(dest);

        await data.writeTags(tags);

        await this.gitFacade.addAll(directory.gitProvider, data.dir);
        await this.gitFacade.commit(directory.gitProvider, data.dir, 'update tags', committer);
        await this.gitFacade.push(
            { dir: dest },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );
    }

    /**
     * Save collections to the data repository and push changes
     */
    async saveCollections(directory: Directory, user: User, collections: Collection[]) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const repo = directory.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            { owner: directory.getRepoOwner(), repo, committer },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const data = await DataRepository.create(dest);

        await data.writeCollections(collections);

        await this.gitFacade.addAll(directory.gitProvider, data.dir);
        await this.gitFacade.commit(
            directory.gitProvider,
            data.dir,
            'update collections',
            committer,
        );
        await this.gitFacade.push(
            { dir: dest },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );
    }

    async count(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);

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
                `Failed to count ${label} for directory ${directory.id}; defaulting to 0.`,
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
                `Failed to count ${label} for directory ${directory.id}; defaulting to 0.`,
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

    async getConfig(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);
        return data.getConfig();
    }

    /**
     * Returns a lightweight snapshot of the data repository for sync purposes.
     * Uses the shared repositoryData() helper to respect cloning/pulling patterns.
     */
    async getDataSyncSnapshot(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);

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
     * Update website settings in config.yml and push to git repository
     */
    async updateWebsiteSettings(
        directory: Directory,
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
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);

        const data = await this.repositoryData(directory, user);
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

        await this.gitFacade.addAll(directory.gitProvider, data.dir);
        await this.gitFacade.commit(
            directory.gitProvider,
            data.dir,
            'update website settings',
            committer,
        );
        await this.gitFacade.push(
            { dir: data.dir },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        this.logger.log(`Successfully updated website settings for directory ${directory.slug}`);
    }

    private async repositoryData(directory: Directory, user: User) {
        // Use directory owner's credentials (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);

        const repo = directory.getDataRepo();

        const dest = await this.gitFacade.cloneOrPull(
            {
                owner: directory.getRepoOwner(),
                repo,
                committer,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const data = await DataRepository.create(dest);

        return data;
    }

    /**
     * Execute the pipeline to generate items.
     * This method converts DTOs to plugin types and calls the pipeline orchestrator.
     *
     * @param directory - The directory entity
     * @param user - The user executing the generation (for multi-tenant context)
     * @param dto - The generation request DTO
     * @param existingData - Existing items for deduplication
     * @param onProgress - Progress callback
     * @returns Pipeline execution result
     */
    private async executePipeline(
        directory: Directory,
        user: User,
        dto: CreateItemsGeneratorDto,
        existingData: {
            existingItems: ItemData[];
            existingCategories: Category[];
            existingTags: Tag[];
            existingCollections: Collection[];
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
                existingConfig: null,
            };
        }

        // Convert Directory entity to DirectoryReference (plugin type)
        // This includes user context for multi-tenant resolution
        const directoryRef: DirectoryReference = {
            id: directory.id,
            name: directory.name ?? directory.slug,
            slug: directory.slug,
            description: directory.description,
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
            existingConfig: existing.existingConfig,
        };

        this.logger.log(`Executing pipeline for directory "${directory.slug}" (user: ${user.id})`);

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
                  directoryRef,
                  request,
                  pluginExisting,
                  pipelineOptions,
                  onProgress,
              )
            : this.pipelineOrchestrator.execute(
                  directoryRef,
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
        directory: Directory,
        logCollector?: GenerationLogCollector,
    ) {
        // Note: step_started/completed events are now emitted by pipeline executors
        // via onLogEntry → logCollector.log(), so we only update the generate status here.
        await this.directoryOperations.updateGenerateStatus(directory.id, {
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
    private async getExistingData(directory: Directory, user: User) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const committer = directory.resolveCommitter(user);
        const repo = directory.getDataRepo();

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner: directory.getRepoOwner(), repo, committer },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );
            const data = await DataRepository.create(dest);

            const [categories, tags, collections, existingItems, config] = await Promise.all([
                data.getCategories().catch(() => []),
                data.getTags().catch(() => []),
                data.getCollections().catch(() => []),
                data.getItems().catch(() => []),
                data.getConfig().catch(() => null),
            ]);

            return {
                existingItems,
                existingCategories: categories,
                existingTags: tags,
                existingCollections: collections,
                existingConfig: config,
            };
        } catch {
            return {
                existingItems: [],
                existingCategories: [],
                existingTags: [],
                existingCollections: [],
                existingConfig: null,
            };
        }
    }

    private async writeItemToDisk(data: DataRepository, item: ItemData) {
        await data.createItemDir(item);
        const md = item.markdown || DEFAULT_ITEM_MARKDOWN(item);
        await Promise.all([data.writeItem(item), data.writeItemMarkdown(item, md)]);
    }

    private getPRDetails(directory: Directory) {
        const title = `Update data - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
        const appName = config.branding.getAppName();
        const platformWebsite = config.branding.getPlatformWebsite();
        const body = `Update data for ${directory.slug}\n\nGenerated by [${appName}](${platformWebsite})`;
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

    private getDefaultReadme(directory: Directory) {
        // Construct URL based on directory's repo provider
        const owner = directory.getRepoOwner('directory');
        const repo = directory.getMainRepo();
        const markdownURL = this.gitFacade.getWebUrl(directory.gitProvider, owner, repo);
        return (
            `# ${directory.getDataRepo()}\n\n` +
            `This repository holds data used to generate [${repo}](${markdownURL})\n\n`
        );
    }

    private getHeader(directory: Directory) {
        const readmeConfig = directory.readmeConfig;
        if (readmeConfig?.header && readmeConfig.overwriteDefaultHeader) {
            return readmeConfig.header;
        }

        let additionalHeader = readmeConfig?.header || '';
        if (additionalHeader) {
            additionalHeader = additionalHeader + '\n\n';
        }

        return `# ${directory.name}\n\n` + `${directory.description}\n\n` + additionalHeader;
    }

    private getFooter(directory: Directory) {
        const readmeConfig = directory.readmeConfig;
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
        directory: Directory,
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
        const committer = directory.resolveCommitter(user);

        try {
            // Create the data repository
            const repoName = directory.getDataRepo();
            const repoOwner = directory.getRepoOwner();

            this.logger.log(`Creating data repo: ${repoOwner}/${repoName}`);

            const createdRepository = assertCreatedRepositoryTarget(
                await this.gitFacade.createRepository(
                    {
                        name: repoName,
                        description: directory.description,
                        organization: directory.organization ? repoOwner : undefined,
                        isPrivate: true,
                    },
                    { userId: user.id, providerId: directory.gitProvider },
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
                    providerId: directory.gitProvider,
                },
                this.logger,
            );

            const data = await DataRepository.create(dest);
            await data.ensureDirectoriesExist();

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
            const initialPrompt = `Directory imported from ${importedData.importRequest?.sourceOwner || 'external'}/${importedData.importRequest?.sourceRepo || 'source'}. Contains ${importedData.items.length} items across ${importedData.categories.length} categories.`;

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
                    name: directory.name,
                    prompt: configData.metadata.initial_prompt,
                    // pluginConfig is intentionally empty - plugins provide defaults
                    pluginConfig: {},
                };
                configData.metadata.last_request_data = initialRequestData;
            }

            await data.mergeConfig(configData);
            await this.worksConfigWriter.writeToDataRepository({
                directory,
                dataRepository: data,
                request: configData.metadata.last_request_data,
                importedWorksConfig: importedData.worksConfig,
                initialPrompt: configData.metadata.initial_prompt,
            });

            // Write README and LICENSE
            await data.writeReadme(this.getDefaultReadme(directory));
            await data.writeLicense(LICENSE_TEXT);

            // Write markdown templates
            await data.writeMarkdownTemplate(this.getHeader(directory), this.getFooter(directory));

            // Commit metadata files
            await this.gitFacade.addAll(directory.gitProvider, data.dir);
            await this.gitFacade.commit(
                directory.gitProvider,
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
            await this.gitFacade.addAll(directory.gitProvider, data.dir);
            await this.gitFacade.commit(
                directory.gitProvider,
                data.dir,
                `add ${itemsWithSlugs.length} imported items`,
                committer,
            );

            // Push to remote
            await this.gitFacade.push(
                { dir: dest },
                { userId: user.id, providerId: directory.gitProvider },
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
        directory: Directory,
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
        const committer = directory.resolveCommitter(user);
        const repoName = directory.getDataRepo();
        const repoOwner = directory.getRepoOwner();

        try {
            this.logger.log(`Syncing imported data for: ${repoOwner}/${repoName}`);

            // Clone/Pull the repository
            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: repoName, committer },
                { userId: user.id, providerId: directory.gitProvider },
            );

            const data = await DataRepository.create(dest);
            await data.ensureDirectoriesExist();
            await data.ensureDefaultConfig();

            // Get existing data to compare
            const existingItems = await data.getItems().catch(() => []);
            const existingSlugSet = new Set(
                existingItems.map((item) => slugifyText(item.slug || item.name)),
            );

            // Handle branching
            const provider = directory.gitProvider;
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

            // Calculate stats
            const newItemsCount = itemsWithSlugs.filter(
                (item) => !existingSlugSet.has(item.slug),
            ).length;
            const updatedItemsCount = itemsWithSlugs.length - newItemsCount;

            if (newItemsCount === 0 && updatedItemsCount === 0) {
                this.logger.log('No new or updated items found during sync.');
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

            // Write items
            await pMap(itemsWithSlugs, (item) => this.writeItemToDisk(data, item), {
                concurrency: PARALLEL_WRITE_CONCURRENCY,
            });
            await this.worksConfigWriter.writeToDataRepository({
                directory,
                dataRepository: data,
                request: importedData.config?.metadata?.last_request_data,
                importedWorksConfig: importedData.worksConfig,
                initialPrompt: importedData.config?.metadata?.initial_prompt,
            });

            // Commit
            await this.gitFacade.addAll(provider, data.dir);
            const commitMsg =
                options.commitMessage ||
                `sync: ${newItemsCount} new, ${updatedItemsCount} updated items`;

            await this.gitFacade.commit(provider, data.dir, commitMsg, committer);

            // Push
            await this.gitFacade.push(
                { dir: dest },
                { userId: user.id, providerId: directory.gitProvider },
            );

            // Update DB stats
            await this.directoryOperations.updateDirectory(directory.id, {
                itemsCount: itemsWithSlugs.length, // Approximation, assuming we keep all existing + new
            });

            const stats: GenerationStats = {
                newItemsCount,
                updatedItemsCount,
                totalItemsCount: itemsWithSlugs.length, // Note: this might be inaccurate if we didn't fetch ALL existing items to merge, but usually import fetches full state
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
                    { userId: user.id, providerId: directory.gitProvider },
                );

                prUpdate = {
                    branch: newBranchName,
                    title: pr.title,
                    body: pr.body || '',
                    number: pr.number,
                    url: pr.url,
                };

                await this.directoryOperations.updateLastPullRequest(directory.id, {
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
