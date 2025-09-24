import { Injectable, Logger } from '@nestjs/common';
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
} from '../items-generator/dto';
import { format } from 'date-fns';
import { DirectoryRepository } from '../database';
import { GenerateStatusType } from '../entities/types';
import { LEGAL_NOTICE, LICENSE_TEXT } from './texts';
import { ItemsGeneratorStep } from '../items-generator/constants/steps';

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger(DataGeneratorService.name);

    constructor(
        private readonly githubService: GithubService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async initialize(
        directory: Directory,
        user: User,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
    ) {
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
        const generatedItems = await this.itemsGeneratorService
            .generateItems(directory, createItemsGeneratorDto, existingData, (step) => {
                this.onGenerationProgress(step, directory);
            })
            .catch((err) => {
                this.logger.error('Failed to generate items from ItemsGeneratorService.', err);
                return null;
            });

        // If no items were generated, we don't need to do anything else
        if (!generatedItems || generatedItems.items.length === 0) {
            // We could call data.cleanup() here but it's not necessary
            return;
        }

        const { categories: newCategories, items: newItems, tags: newTags } = generatedItems;
        const { existingCategories, existingTags } = existingData;

        this.logger.debug(
            `Generated ${newCategories.length} categories, ${newItems.length} items, ${newTags.length} tags.`,
        );

        const description = `machine-readable data for ${directory.slug}`;

        const token = user.getGitToken();
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
        const dest = await this.githubService
            .cloneOrPull({
                owner: directory.getRepoOwner(),
                repo,
                token,
                committer,
            })
            .catch((err) => {
                this.logger.error('Failed to clone repository', err);
                return null;
            });

        const data: DataRepository = await DataRepository.create(dest).catch((err) => {
            this.logger.error('Failed to create data repository', err);
            return null;
        });

        if (!data || !dest) {
            this.logger.error('Failed to create data repository');
            return false;
        }

        this.logger.log(`Cloned repository to ${dest}`);

        try {
            // Ensure directories exist
            await data.ensureDirectoriesExist();

            // Name of the new branch if we are in update mode
            let newBranchName: string | null = null;

            const createOrUpdate =
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE;

            const update_with_pull_request = createItemsGeneratorDto.update_with_pull_request;

            const defaultBranch = await this.githubService.getMainBranch(dest).catch((err) => {
                this.logger.error('Failed to get main branch', err);
                return null;
            });

            // In case of re-creation:
            // Switch to the main branch and remove existing items files.
            if (createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE) {
                this.logger.log('Recreating repository, clearing existing files');

                // just to make sure we're recreating from main
                await this.githubService.switchToMainBranch(dest).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });

                await data.resetFiles();
            } else if (existed && createOrUpdate && update_with_pull_request) {
                // In case of update, we want to create a new branch and switch to it
                newBranchName = await this.githubService.createAndSwitchToRandomBranch(dest);
                this.logger.log(`Created and switched to new branch: ${newBranchName}`);
            }

            const promises = [
                data.writeCategories(this.merge(existingCategories, newCategories)),
                data.writeTags(this.merge(existingTags, newTags)),
            ];

            /**
             * rewrite meta files only if we are creating new repository or we are recreating it
             */
            if (
                !existed ||
                createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE
            ) {
                promises.push(
                    data.writeReadme(this.getDefaultReadme(directory)),
                    data.writeLicense(LICENSE_TEXT),
                    data.mergeConfig({
                        ...this.withCompanyConfig(createItemsGeneratorDto.company),
                        metadata: {
                            initial_prompt: createItemsGeneratorDto.prompt,
                            generation_method: createItemsGeneratorDto.generation_method,
                            last_request_data: createItemsGeneratorDto,
                        },
                    }),
                    data.writeMarkdownTemplate(
                        this.getHeader(directory),
                        this.getFooter(directory),
                    ),
                );
            }

            const { title: prTitle, body: prBody } = this.getPRDetails(directory);

            // Write PR details in config so that others repositories may use it
            if (newBranchName) {
                promises.push(
                    data.writeMarkdownTemplate(
                        this.getHeader(directory),
                        this.getFooter(directory),
                    ),

                    data.mergeConfig({
                        ...this.withCompanyConfig(createItemsGeneratorDto.company),

                        metadata: {
                            generation_method: createItemsGeneratorDto.generation_method,
                            last_request_data: createItemsGeneratorDto,
                            pr_update: {
                                branch: newBranchName,
                                title: prTitle,
                                body: prBody,
                            },
                        },
                    }),
                );
            }

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

            // Process items (with markdown generation, writing to disk and committing)
            this.logger.log(`Processing ${newItems.length} items...`);
            this.onGenerationProgress(ItemsGeneratorStep.ITEMS_PROCESSING, directory);

            const itemsWithMarkdown =
                await this.itemsGeneratorService.generateMarkdownForItems(newItems);

            for (const item of itemsWithMarkdown) {
                item.slug = slugifyText(item.slug || item.name);
                await this.processItem(data, item, user).catch((err) => {
                    this.logger.error('Failed to process item', err);
                });
            }

            // Push changes
            await this.githubService.push(dest, token);
            this.logger.log(`All processed and pushed to ${directory.getRepoOwner()}/${repo}`);

            let prUpdate: PRUpdate | null = null;

            // create PR if we are in update mode and branch was created
            if (newBranchName && defaultBranch && createOrUpdate) {
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
                await this.directoryRepository.updateLastPullRequest(directory.id, {
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
                prUpdate,
                generation_method: createItemsGeneratorDto.generation_method,
            };
        } catch (err) {
            this.logger.error('Failed to initialize data repository', err);
            throw err;
        }
    }

    /**
     * Remove repository for a directory
     */
    async removeRepository(directory: Directory, user: User): Promise<void> {
        const token = user.getGitToken();
        const repo = directory.getDataRepo();

        try {
            // Delete the GitHub repository
            await this.githubService.deleteRepository(directory.getRepoOwner(), repo, token);

            const dataDir = this.githubService.getDir(
                directory.getRepoOwner(),
                directory.getDataRepo(),
            );

            DataRepository.create(dataDir).then((data) => data.cleanup());

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

    private async repositoryData(directory: Directory, user: User) {
        const token = user.getGitToken();
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
        await this.directoryRepository.updateGenerateStatus(directory.id, {
            status: GenerateStatusType.GENERATING,
            step,
        });
    }

    /**
     * Gets existing data from the repository if it exists, otherwise returns empty data
     */
    private async getExistingData(directory: Directory, user: User) {
        this.logger.debug(`Getting existing data for directory: ${directory.slug}`);

        const token = user.getGitToken();
        const committer = user.asCommitter();

        const repo = directory.getDataRepo();

        try {
            // Try to clone or pull the repository using persistent directory
            this.logger.log(`Checking for existing repository ${directory.getRepoOwner()}/${repo}`);
            const dest = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo,
                token,
                committer,
            });
            const data = await DataRepository.create(dest);
            this.logger.log(`Found existing repository at ${dest}`);

            try {
                // Try to get existing data
                const [categories, tags, existingItems, config] = await Promise.all([
                    data.getCategories().catch(() => []),
                    data.getTags().catch(() => []),
                    data.getItems().catch(() => []),
                    data.getConfig().catch(() => null),
                ]);

                this.logger.debug(
                    `Found existing data: ${categories.length} categories, ${tags.length} tags, ${existingItems.length} items`,
                );

                return {
                    existingItems,
                    existingCategories: categories,
                    existingTags: tags,
                    existingConfig: config,
                };
            } catch (error) {
                this.logger.debug(`No existing data found in repository: ${error.message}`);
                return {
                    existingItems: [],
                    existingCategories: [],
                    existingTags: [],
                    existingConfig: null,
                };
            }
        } catch (error) {
            // Repository doesn't exist or can't be accessed
            this.logger.debug(
                `Repository ${directory.getRepoOwner()}/${repo} doesn't exist or can't be accessed: ${error.message}`,
            );
            return {
                existingItems: [],
                existingCategories: [],
                existingTags: [],
                existingConfig: null,
            };
        }
    }

    private async processItem(data: DataRepository, item: ItemData, user: User) {
        this.logger.debug(`processItem: Starting for item ${item.name} (slug: ${item.slug})`);

        await data.createItemDir(item);
        const promises = [data.writeItem(item)];

        // Write item markdown to disk
        const md =
            item.markdown ||
            `#${item.name}\n\n${item.description}\n\n[${item.source_url}](${item.source_url})`;

        promises.push(data.writeItemMarkdown(item, `${md}`));

        await Promise.all(promises);
        await this.githubService.add(data.dir, '.');
        await this.githubService.commit(data.dir, `add ${item.name}`, user.asCommitter());

        this.logger.log(`processItem: Committed item ${item.name} (slug: ${item.slug})`);
    }

    private getPRDetails(directory: Directory) {
        const title = `Update data - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
        const body = `Update data for ${directory.slug}\n\nGenerated by [Ever Works](https://ever.works)`;
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
}
