import { Injectable, Logger, Inject } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository, PRUpdate } from './data-repository';
import { slugifyText } from '../items-generator/utils/text.utils';
import { ItemsGeneratorService } from '../items-generator/items-generator.service';
import {
    CreateItemsGeneratorDto,
    Identifiable,
    ItemData,
    GenerationMethod,
    CompanyDto,
    ItemsGeneratorMetrics,
    Category,
    Tag,
} from '../items-generator/dto';
import { format } from 'date-fns';
import { GenerateStatusType } from '../entities/types';
import { LEGAL_NOTICE, LICENSE_TEXT } from './texts';
import { DIRECTORY_OPERATIONS } from '@src/directory-operations';
import type { DirectoryOperations } from '@src/directory-operations';
import pMap from 'p-map';
import { config } from '../config';

const PARALLEL_WRITE_CONCURRENCY = 10;

/**
 * Default config values for stored request data.
 * These conservative values are applied when saving last_request_data
 * to ensure scheduled runs use efficient, cost-effective settings.
 */
const STORED_CONFIG_DEFAULTS = {
    max_search_queries: 10,
    max_results_per_query: 5,
    max_pages_to_process: 10,
    ai_first_generation_enabled: false,
    // Data generation defaults - ensure all entities are generated
    generate_categories: true,
    generate_tags: true,
    generate_brands: true,
    // Default to real mode for stored configs (sample mode is for quick tests)
    data_volume_mode: 'real',
};

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
};

export type InitializeResult =
    | {
          success: true;
          prUpdate: PRUpdate | null;
          stats: GenerationStats;
      }
    | {
          success: false;
          error: InitializeError;
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
        private readonly githubService: GithubService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
    ) {}

    private getDirectoryOwner(directory: Directory): User {
        const owner = directory.user;
        if (!owner || typeof owner.getGitToken !== 'function') {
            throw new Error(
                `Directory owner not loaded for directory ${directory.id}. Ensure the user relation is joined.`,
            );
        }
        return owner as User;
    }

    async initialize(
        directory: Directory,
        user: User,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<InitializeResult> {
        this.logger.debug(
            `Initializing data repository for directory: ${JSON.stringify(createItemsGeneratorDto)}`,
        );

        let existingData = {
            existingItems: [],
            existingCategories: [],
            existingTags: [],
            existingConfig: null,
        };

        // Get existing data if available
        // get existing data only if we are in update mode
        if (createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE) {
            existingData = await this.getExistingData(directory, user);
        }

        const existed = existingData.existingItems.length > 0;

        // Generate items, the items generator will always to generate new items
        const generatedItems = await this.itemsGeneratorService.generateItems(
            directory,
            createItemsGeneratorDto,
            existingData,
            (step) => {
                this.onGenerationProgress(step, directory);
            },
        );

        // If no items were generated, we don't need to do anything else
        if (!generatedItems || generatedItems.items.length === 0) {
            const stats: GenerationStats = {
                newItemsCount: 0,
                updatedItemsCount: 0,
                totalItemsCount: 0,
                metrics: generatedItems?.metrics,
            };

            return {
                success: true,
                prUpdate: null,
                stats,
            };
        }

        const {
            categories: newCategories,
            items: newItems,
            tags: newTags,
            // contentCache,
        } = generatedItems;
        const { existingCategories, existingTags } = existingData;

        this.logger.debug(
            `Generated ${newCategories.length} categories, ${newItems.length} items, ${newTags.length} tags.`,
        );

        const description = `machine-readable data for ${directory.slug}`;

        // Use directory owner's Git token (they set up the repos)
        // but use current user as committer for attribution
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();

        const repo = directory.getDataRepo();

        // Creating GitHub repository
        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(
                directory.getRepoOwner(),
                repo,
                description,
                token,
            );
        } else {
            await this.githubService.createEmptyRepo(repo, description, token);
        }

        this.logger.log(
            `Successfully created GitHub repository: ${directory.getRepoOwner()}/${repo}`,
        );

        // Cloning repository
        let dest: string;
        try {
            dest = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo,
                token,
                committer,
            });
        } catch (err) {
            this.logger.error('Failed to clone repository', err);
            return {
                success: false,
                error: {
                    code: 'CLONE_FAILED' as const,
                    message: `Failed to clone repository ${directory.getRepoOwner()}/${repo}`,
                    cause: err instanceof Error ? err : new Error(String(err)),
                },
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
            };
        }

        this.logger.log(`Cloned repository to ${dest}`);

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

            const defaultBranch = await this.githubService.getMainBranch(dest).catch((err) => {
                this.logger.error('Failed to get main branch', err);
                return null;
            });

            // Determine branching strategy
            if (shouldCreatePR && (isRecreate || (existed && isUpdate))) {
                // Ensure we are on main before creating a new branch
                await this.githubService.switchToMainBranch(dest).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });

                newBranchName = await this.githubService.createAndSwitchToRandomBranch(dest);
                this.logger.log(`Created and switched to new branch: ${newBranchName}`);
            } else if (isRecreate) {
                // If Recreate and NO PR, switch to main
                this.logger.log('Recreating repository on main branch');
                await this.githubService.switchToMainBranch(dest).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });
            }

            // Clear files if we are recreating
            if (isRecreate) {
                this.logger.log('Recreating repository, clearing existing files');
                await data.resetFiles();
            }

            const promises = [
                data.writeCategories(this.merge(existingCategories, newCategories)),
                data.writeTags(this.merge(existingTags, newTags)),
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

            // Build metadata - always update last_request_data and generation_method
            // Apply conservative config defaults before storing to ensure scheduled runs
            // use efficient, cost-effective settings regardless of manual run config
            const sanitizedDto = {
                ...createItemsGeneratorDto,
                config: {
                    ...createItemsGeneratorDto.config,
                    ...STORED_CONFIG_DEFAULTS,
                },
            };

            const metadata: Record<string, unknown> = {
                last_request_data: sanitizedDto,
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
                    ...this.withCompanyConfig(createItemsGeneratorDto.company),
                    version: await data.getNextVersion(),
                    metadata,
                }),
            );

            // write categories, tags, readme, license, config, markdown template
            await Promise.all(promises);

            // Commit changes
            await this.githubService.addAll(data.dir);

            await this.githubService.commit(
                data.dir,
                existed ? 'update items' : 'init repository',
                user.asCommitter(),
            );

            this.logger.debug('files written and committed.');

            // Items already have markdown from pipeline - write to disk
            this.logger.debug(`Writing ${newItems.length} items to disk...`);

            const existingSlugSet = new Set(
                (existingData.existingItems || []).map((item) =>
                    slugifyText(item.slug || item.name),
                ),
            );

            // Prepare items with slugs and count new vs updated
            const itemsWithSlugs = newItems.map((item) => {
                item.slug = slugifyText(item.slug || item.name);
                return item;
            });

            const newItemsCount = itemsWithSlugs.filter(
                (item) => !existingSlugSet.has(item.slug),
            ).length;

            const updatedItemsCount = itemsWithSlugs.length - newItemsCount;

            await pMap(
                itemsWithSlugs,
                (item) => {
                    return this.writeItemToDisk(data, item).catch((err) => {
                        this.logger.error(`Failed to write item ${item.slug}`, err);
                    });
                },
                { concurrency: PARALLEL_WRITE_CONCURRENCY },
            );

            // Batch commit all items at once
            if (newItems.length > 0) {
                await this.githubService.addAll(data.dir);
                const commitMessage =
                    newItemsCount > 0
                        ? `add ${newItemsCount} new item${newItemsCount > 1 ? 's' : ''}${updatedItemsCount > 0 ? `, update ${updatedItemsCount}` : ''}`
                        : `update ${updatedItemsCount} item${updatedItemsCount > 1 ? 's' : ''}`;

                await this.githubService.commit(data.dir, commitMessage, user.asCommitter());

                this.logger.debug(`Batch committed ${newItems.length} items`);
            }

            // Push changes
            await this.githubService.push(dest, token);
            this.logger.log(`All processed and pushed to ${directory.getRepoOwner()}/${repo}`);

            // Update directory items count
            await this.directoryOperations.updateDirectory(directory.id, {
                itemsCount: generatedItems.items.length + existingData.existingItems.length,
            });

            // Persist domain type if detected and not manually set
            if (generatedItems.domainAnalysis && !directory.domainTypeManuallySet) {
                await this.directoryOperations.updateDirectory(directory.id, {
                    domainType: generatedItems.domainAnalysis.domain_type,
                    domainTypeConfidence: generatedItems.domainAnalysis.confidence,
                });
            }

            const stats: GenerationStats = {
                newItemsCount,
                updatedItemsCount,
                totalItemsCount: newItems.length,
                metrics: generatedItems.metrics,
            };

            let prUpdate: PRUpdate | null = null;

            // create PR if we are in update mode and branch was created
            if (newBranchName && defaultBranch) {
                const pr = await this.githubService.createPR(
                    {
                        owner: directory.getRepoOwner(),
                        repo: repo,
                        head: newBranchName,
                        base: defaultBranch,
                        title: prTitle,
                        body: prBody,
                    },
                    token,
                );

                prUpdate = {
                    branch: newBranchName,
                    title: prTitle,
                    body: prBody,
                    number: pr.number,
                    url: pr.html_url,
                };

                // Save PR details to the directory
                await this.directoryOperations.updateLastPullRequest(directory.id, {
                    data: {
                        branch: newBranchName,
                        title: prTitle,
                        body: prBody,
                        number: pr.number,
                        url: pr.html_url,
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
            };
        }
    }

    async updateMarkdownTemplate(
        directory: Directory,
        user: User,
    ): Promise<UpdateMarkdownTemplateResult> {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();
        const owner = directory.getRepoOwner();
        const repo = directory.getDataRepo();

        const repositoryExists = await this.githubService
            .repositoryExists(owner, repo, token)
            .catch((error) => {
                this.logger.error(
                    `Failed to verify repository ${owner}/${repo} existence`,
                    error.message,
                );
                throw error;
            });

        if (!repositoryExists) {
            this.logger.warn(
                `Data repository ${owner}/${repo} not initialized. Skipping README template update.`,
            );
            return {
                updated: false,
                reason: 'not_initialized',
                message: 'Data repository is not initialized yet. Run a generation first.',
            };
        }

        const dest = await this.githubService.cloneOrPull({
            owner,
            repo,
            token,
            committer,
        });

        const dataRepo = await DataRepository.create(dest);

        await dataRepo.ensureDirectoriesExist();

        await dataRepo.writeMarkdownTemplate(this.getHeader(directory), this.getFooter(directory));

        const statusMatrix = await this.githubService.status(dataRepo.dir);
        const hasChanges = statusMatrix.some(
            ([, headStatus, workdirStatus]) => headStatus !== workdirStatus,
        );

        if (!hasChanges) {
            this.logger.log(`No README template changes detected for ${directory.slug}`);
            return {
                updated: false,
                reason: 'no_changes',
                message: 'README template already up to date.',
            };
        }

        await this.githubService.addAll(dataRepo.dir);
        await this.githubService.commit(dataRepo.dir, 'update README template', committer);

        await this.githubService.push(dest, token);

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
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const repo = directory.getDataRepo();

        try {
            // Delete the GitHub repository
            await this.githubService.deleteRepository(directory.getRepoOwner(), repo, token);

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
        const dataDir = this.githubService.getDir(
            directory.getRepoOwner(),
            directory.getDataRepo(),
        );

        return DataRepository.create(dataDir).then((data) => data.cleanup());
    }

    /**
     * Get last request data from config
     */
    async getLastRequestData(directory: Directory, user: User) {
        const config = await this.config(directory, user);
        return config.metadata?.last_request_data;
    }

    /**
     * Get existing items from the repository
     */

    async getItems(directory: Directory, user: User) {
        return (await this.getExistingData(directory, user)).existingItems;
    }

    async getCategoriesTags(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);

        const [categories, tags] = await Promise.all([data.getCategories(), data.getTags()]);

        return {
            categories,
            tags,
        };
    }

    /**
     * Save categories to the data repository and push changes
     */
    async saveCategories(directory: Directory, user: User, categories: Category[]) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();
        const repo = directory.getDataRepo();

        const dest = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo,
            token,
            committer,
        });

        const data = await DataRepository.create(dest);

        await data.writeCategories(categories);

        await this.githubService.addAll(data.dir);
        await this.githubService.commit(data.dir, 'update categories', committer);
        await this.githubService.push(dest, token);
    }

    /**
     * Save tags to the data repository and push changes
     */
    async saveTags(directory: Directory, user: User, tags: Tag[]) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();
        const repo = directory.getDataRepo();

        const dest = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo,
            token,
            committer,
        });

        const data = await DataRepository.create(dest);

        await data.writeTags(tags);

        await this.githubService.addAll(data.dir);
        await this.githubService.commit(data.dir, 'update tags', committer);
        await this.githubService.push(dest, token);
    }

    async count(directory: Directory, user: User) {
        const data = await this.repositoryData(directory, user);

        const [categories, tags, items] = await Promise.all([
            data.getCategories(),
            data.getTags(),
            data.getItems(),
        ]);

        return {
            items: items.length,
            categories: categories.length,
            tags: tags.length,
        };
    }

    async config(directory: Directory, user: User) {
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

    private async repositoryData(directory: Directory, user: User) {
        // Use directory owner's Git token (they set up the repos)
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();

        const repo = directory.getDataRepo();

        const dest = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo,
            token,
            committer,
        });

        const data = await DataRepository.create(dest);

        return data;
    }

    /**
     * Callback for generation progress
     */
    private async onGenerationProgress(step: string, directory: Directory) {
        await this.directoryOperations.updateGenerateStatus(directory.id, {
            status: GenerateStatusType.GENERATING,
            step,
        });
    }

    /**
     * Gets existing data from the repository if it exists, otherwise returns empty data
     */
    private async getExistingData(directory: Directory, user: User) {
        const directoryOwner = this.getDirectoryOwner(directory);
        const token = directoryOwner.getGitToken();
        const committer = user.asCommitter();
        const repo = directory.getDataRepo();

        try {
            const dest = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo,
                token,
                committer,
            });
            const data = await DataRepository.create(dest);

            const [categories, tags, existingItems, config] = await Promise.all([
                data.getCategories().catch(() => []),
                data.getTags().catch(() => []),
                data.getItems().catch(() => []),
                data.getConfig().catch(() => null),
            ]);

            return {
                existingItems,
                existingCategories: categories,
                existingTags: tags,
                existingConfig: config,
            };
        } catch {
            return {
                existingItems: [],
                existingCategories: [],
                existingTags: [],
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

    private withCompanyConfig(company?: CompanyDto) {
        return company
            ? {
                  company_name: company.name,
                  company_website: company.website,
              }
            : {};
    }

    private getDefaultReadme(directory: Directory) {
        const markdownURL = this.githubService.getURL(directory.getRepoOwner(), directory.slug);
        return (
            `# ${directory.getDataRepo()}\n\n` +
            `This repository holds data used to generate [${directory.slug}](${markdownURL})\n\n`
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
            config?: Record<string, any>;
            importRequest?: {
                sourceUrl: string;
                sourceType: string;
                sourceOwner: string;
                sourceRepo: string;
            };
        },
    ): Promise<InitializeResult> {
        const token = user.getGitToken();
        const committer = user.asCommitter();

        try {
            // Create the data repository
            const repoName = directory.getDataRepo();
            const repoOwner = directory.getRepoOwner();

            this.logger.log(`Creating data repo: ${repoOwner}/${repoName}`);

            if (directory.organization) {
                await this.githubService.createEmptyRepoAsOrg(
                    repoOwner,
                    repoName,
                    directory.description,
                    token,
                );
            } else {
                await this.githubService.createEmptyRepo(repoName, directory.description, token);
            }

            // Clone the repository
            const dest = await this.githubService.cloneOrPull({
                owner: repoOwner,
                repo: repoName,
                token,
                committer,
            });

            const data = await DataRepository.create(dest);
            await data.ensureDirectoriesExist();

            // Write categories and tags
            if (importedData.categories.length > 0) {
                await data.writeCategories(importedData.categories);
            }
            if (importedData.tags.length > 0) {
                await data.writeTags(importedData.tags);
            }

            const initialCategories = importedData.categories.map((c) => c.id);
            const initialPrompt = `Directory imported from ${importedData.importRequest?.sourceOwner || 'external'}/${importedData.importRequest?.sourceRepo || 'source'}. Contains ${importedData.items.length} items across ${importedData.categories.length} categories.`;

            // Preserve existing metadata from imported config (data_repo/link_existing already have config)
            // For awesome_readme imports, we don't need last_request_data (sync will be used)
            const existingMetadata = importedData.config?.metadata || {};
            const isAwesomeReadme = importedData.importRequest?.sourceType === 'awesome_readme';

            const configData = {
                ...importedData.config,
                version: await data.getNextVersion(),
                metadata: {
                    ...existingMetadata,
                    initial_prompt: initialPrompt,
                },
            };

            // Only create default last_request_data if:
            // 1. Not an awesome_readme import (they use sync, not AI)
            // 2. The imported config doesn't already have one
            if (!isAwesomeReadme && !existingMetadata.last_request_data) {
                const initialRequestData = new CreateItemsGeneratorDto();
                initialRequestData.name = directory.name;
                initialRequestData.prompt = initialPrompt;
                initialRequestData.initial_categories = initialCategories;
                if (importedData.importRequest?.sourceUrl) {
                    initialRequestData.source_urls = [importedData.importRequest.sourceUrl];
                }
                configData.metadata.last_request_data = initialRequestData;
            }

            await data.mergeConfig(configData);

            // Write README and LICENSE
            await data.writeReadme(this.getDefaultReadme(directory));
            await data.writeLicense(LICENSE_TEXT);

            // Write markdown templates
            await data.writeMarkdownTemplate(this.getHeader(directory), this.getFooter(directory));

            // Commit metadata files
            await this.githubService.addAll(data.dir);
            await this.githubService.commit(
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
            await this.githubService.addAll(data.dir);
            await this.githubService.commit(
                data.dir,
                `add ${itemsWithSlugs.length} imported items`,
                committer,
            );

            // Push to remote
            await this.githubService.push(dest, token);

            this.logger.log(
                `Successfully initialized data repo with ${itemsWithSlugs.length} imported items`,
            );

            return {
                success: true,
                prUpdate: null,
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
            config?: Record<string, any>;
        },
        options: {
            updateWithPullRequest: boolean;
            commitMessage?: string;
        } = { updateWithPullRequest: true },
    ): Promise<InitializeResult> {
        const token = user.getGitToken();
        const committer = user.asCommitter();
        const repoName = directory.getDataRepo();
        const repoOwner = directory.getRepoOwner();

        try {
            this.logger.log(`Syncing imported data for: ${repoOwner}/${repoName}`);

            // Clone/Pull the repository
            const dest = await this.githubService.cloneOrPull({
                owner: repoOwner,
                repo: repoName,
                token,
                committer,
            });

            const data = await DataRepository.create(dest);
            await data.ensureDirectoriesExist();
            await data.ensureDefaultConfig();

            // Get existing data to compare
            const existingItems = await data.getItems().catch(() => []);
            const existingSlugSet = new Set(
                existingItems.map((item) => slugifyText(item.slug || item.name)),
            );

            // Handle branching
            let newBranchName: string | null = null;
            const defaultBranch = await this.githubService.getMainBranch(dest).catch(() => 'main');

            if (options.updateWithPullRequest) {
                await this.githubService.switchToMainBranch(dest).catch(() => {});
                newBranchName = await this.githubService.createAndSwitchToRandomBranch(dest);
                this.logger.log(`Created sync branch: ${newBranchName}`);
            } else {
                await this.githubService.switchToMainBranch(dest).catch(() => {});
            }

            // Write categories and tags (merge)
            if (importedData.categories.length > 0) {
                const existingCategories = await data.getCategories().catch(() => []);
                await data.writeCategories(this.merge(existingCategories, importedData.categories));
            }
            if (importedData.tags.length > 0) {
                const existingTags = await data.getTags().catch(() => []);
                await data.writeTags(this.merge(existingTags, importedData.tags));
            }

            // Prepare items
            const itemsWithSlugs = importedData.items.map((item) => ({
                ...item,
                slug: item.slug || slugifyText(item.name),
            }));

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

            // Commit
            await this.githubService.addAll(data.dir);
            const commitMsg =
                options.commitMessage ||
                `sync: ${newItemsCount} new, ${updatedItemsCount} updated items`;

            await this.githubService.commit(data.dir, commitMsg, committer);

            // Push
            await this.githubService.push(dest, token);

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
                const pr = await this.githubService.createPR(
                    {
                        owner: repoOwner,
                        repo: repoName,
                        head: newBranchName,
                        base: defaultBranch,
                        title: `Sync with source - ${format(new Date(), 'MM/dd/yyyy')}`,
                        body: `Automated sync from source repository.\n\nNew items: ${newItemsCount}\nUpdated items: ${updatedItemsCount}`,
                    },
                    token,
                );

                prUpdate = {
                    branch: newBranchName,
                    title: pr.title,
                    body: pr.body || '',
                    number: pr.number,
                    url: pr.html_url,
                };

                await this.directoryOperations.updateLastPullRequest(directory.id, {
                    data: prUpdate,
                });
            }

            return {
                success: true,
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
