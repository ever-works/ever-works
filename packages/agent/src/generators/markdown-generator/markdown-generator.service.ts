import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { GitFacadeService } from '../../facades/git.facade';
import type { Category, Identifiable, ItemData, Tag } from '@ever-works/contracts';
import { Directory } from '../../entities/directory.entity';
import { User } from '../../entities/user.entity';
import { DataRepository, PRUpdate } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';
import { GenerationMethod } from '../../items-generator/dto';
import { DirectoryOperationsService } from '@src/directory-operations';
import { getDirectoryOwner } from '../../utils/directory.utils';

type InitializeOptions = {
    generation_method?: GenerationMethod;
    pr_update?: PRUpdate;
    remove_details?: string[];
};

@Injectable()
export class MarkdownGeneratorService {
    private readonly logger = new Logger(MarkdownGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly directoryOperations: DirectoryOperationsService,
    ) {}

    async initialize(directory: Directory, user: User, options: InitializeOptions = {}) {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = user.asCommitter();
        const description = directory.description;

        // Create repository through facade
        await this.gitFacade.createRepository(
            {
                name: directory.slug,
                description,
                organization: directory.organization ? directory.getRepoOwner() : undefined,
                isPrivate: true,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Clone markdown repo
        const markdownPath = await this.gitFacade.cloneOrPull(
            {
                owner: directory.getRepoOwner(),
                repo: directory.slug,
                committer,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        // Clone data repo
        const dataPath = await this.gitFacade.cloneOrPull(
            {
                owner: directory.getRepoOwner(),
                repo: directory.getDataRepo(),
                committer,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const markdownRepo = new MarkdownRepository(markdownPath);
        const dataRepo = await DataRepository.create(dataPath);

        try {
            const slugs = await fs.readdir(dataRepo.dataDir);
            await markdownRepo.ensureDirectoriesExist();

            const provider = directory.gitProvider;
            const defaultBranch = await this.gitFacade
                .getMainBranch(provider, markdownRepo.dir)
                .catch((err) => {
                    this.logger.error('Failed to get main branch', err);
                    return null;
                });

            const generation_method = options?.generation_method;
            const pr_update = options?.pr_update;

            let canCreatePR =
                generation_method !== GenerationMethod.RECREATE && !!pr_update?.branch;

            // In case of re-creation:
            // Switch to the main branch and remove existing items files.
            if (generation_method === GenerationMethod.RECREATE) {
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, markdownRepo.dir, defaultBranch)
                        .catch((err) => {
                            this.logger.error('Failed to switch to main branch', err);
                            return null;
                        });
                }

                await markdownRepo.resetFiles();
            } else if (canCreatePR) {
                // Switch to PR branch (both repos)
                await Promise.all([
                    this.gitFacade.switchBranch(provider, markdownRepo.dir, pr_update.branch, true),
                    this.gitFacade.switchBranch(provider, dataRepo.dir, pr_update.branch, true),
                ]).catch((err) => {
                    canCreatePR = false;
                    this.logger.error('Failed to switch to PR branch', err);
                });
            }

            const markdowns = new Set<string>(); // will be needed to check if markdown exists before referencing them in README
            const categories = await this.loadCategories(dataRepo);
            const tags = await this.loadTags(dataRepo);

            const groups = {}; // we want to group items by category, like: { 'open-source': [items], 'commercial': [items] }
            for (const slug of slugs) {
                const markdown = await dataRepo.getMarkdown(slug);
                if (markdown) {
                    await markdownRepo.writeDetails(slug, markdown);
                    markdowns.add(slug);
                }

                let item = await dataRepo.getItem(slug);
                if (!item) {
                    continue;
                }

                if (Array.isArray(item.tags)) {
                    item = {
                        ...item,
                        tags: item.tags.map((tag) => this.populate<Tag>(tag, tags)),
                    };
                }

                // Normalize category to array of strings
                const itemCategories: string[] = Array.isArray(item.category)
                    ? item.category
                    : [item.category];

                // Ensure each category is in the categories map
                for (const cat of itemCategories) {
                    if (!categories.has(cat)) {
                        categories.set(cat, { id: cat, name: cat });
                    }
                }

                // Group item by each of its categories
                for (const cat of itemCategories) {
                    const group = groups[cat];
                    if (group) {
                        group.push(item);
                    } else {
                        groups[cat] = [item];
                    }
                }
            }

            // Remove detail files
            if (options?.remove_details && options.remove_details.length > 0) {
                for (const slug of options.remove_details) {
                    await markdownRepo.removeDetails(slug);
                    markdowns.delete(slug);
                }
            }

            const license = await dataRepo.getLicense();
            if (license) {
                await markdownRepo.writeLicense(license);
            }

            const readme: string = await this.generateReadme(
                dataRepo,
                markdowns,
                groups,
                categories,
            );
            await markdownRepo.writeReadme(readme);

            await this.gitFacade.addAll(provider, markdownPath);
            await this.gitFacade.commit(
                provider,
                markdownPath,
                'sync README.md',
                user.asCommitter(),
            );
            await this.gitFacade.push(
                { dir: markdownPath },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            if (canCreatePR && defaultBranch) {
                this.logger.log(
                    `Creating PR from ${pr_update.branch} to ${defaultBranch} for ${directory.slug}`,
                );

                const pr = await this.gitFacade
                    .createPullRequest(
                        {
                            owner: directory.getRepoOwner(),
                            repo: directory.slug,
                            base: defaultBranch,
                            head: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                        },
                        { userId: directoryOwner.id, providerId: directory.gitProvider },
                    )
                    .catch((err) => {
                        this.logger.error('Failed to create PR', err);
                        return null;
                    });

                if (pr) {
                    await this.directoryOperations.updateLastPullRequest(directory.id, {
                        main: {
                            branch: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                            number: pr.number,
                            url: pr.url,
                        },
                    });
                }
            } else {
                this.logger.log(`Pushed changes to main branch for ${directory.slug}`);
            }
        } catch (err) {
            this.logger.error('Error during markdown generation', err);
            throw err;
        }
    }

    async removeItemDetail(directory: Directory, user: User, slug: string, branch?: string) {
        const directoryOwner = getDirectoryOwner(directory);
        const committer = user.asCommitter();

        const markdownPath = await this.gitFacade.cloneOrPull(
            {
                owner: directory.getRepoOwner(),
                repo: directory.slug,
                committer,
            },
            { userId: directoryOwner.id, providerId: directory.gitProvider },
        );

        const markdownRepo = new MarkdownRepository(markdownPath);

        if (branch) {
            await this.gitFacade
                .switchBranch(directory.gitProvider, markdownRepo.dir, branch, true)
                .catch((err) => {
                    this.logger.error('Failed to switch to PR branch', err);
                });
        }

        await markdownRepo.removeDetails(slug);
    }

    /**
     * Remove repository for a directory
     */
    async removeRepository(directory: Directory, user: User): Promise<void> {
        const directoryOwner = getDirectoryOwner(directory);

        try {
            // Delete the repository
            await this.gitFacade.deleteRepository(directory.getRepoOwner(), directory.slug, {
                userId: directoryOwner.id,
                providerId: directory.gitProvider,
            });

            const dataDir = this.gitFacade.getLocalDir(
                directory.gitProvider,
                directory.getRepoOwner(),
                directory.getMainRepo(),
            );

            new MarkdownRepository(dataDir).cleanup();

            this.logger.log(
                `Successfully deleted markdown repository: ${directory.getRepoOwner()}/${directory.slug}`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to delete markdown repository ${directory.getRepoOwner()}/${directory.slug}:`,
                error,
            );
            throw error;
        }
    }

    async cleanup(directory: Directory) {
        const dataDir = this.gitFacade.getLocalDir(
            directory.gitProvider,
            directory.getRepoOwner(),
            directory.getMainRepo(),
        );

        return new MarkdownRepository(dataDir).cleanup();
    }

    private async generateReadme(
        data: DataRepository,
        markdowns: Set<string>,
        groups: Record<string, Array<ItemData>>,
        categories: Map<string, Category>,
    ) {
        const config = await data.getConfig();
        const { header, footer } = await data.readMarkdownTemplate();
        const builder = new ReadmeBuilder(header, footer);

        if (config.content_table) {
            builder.enableToC();
        }

        // Sort categories by priority, then alphabetically
        const sortedCategoryIds = this.sortCategoriesByPriority(groups, categories);

        for (const categoryId of sortedCategoryIds) {
            const categoryDetails = categories.get(categoryId);
            const items = groups[categoryId];
            builder.addSubHeader(categoryDetails.name, items.length);

            items.sort((a, b) => {
                const aFeatured = !!a.featured;
                const bFeatured = !!b.featured;

                if (aFeatured !== bFeatured) {
                    return aFeatured ? -1 : 1; // featured always first
                }

                // Within the same featured bucket, honor explicit order ascending
                const orderA = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
                const orderB = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
                if (orderA !== orderB) {
                    return orderA - orderB;
                }

                return a.name.localeCompare(b.name);
            });

            for (const item of items) {
                // TODO: consider making featured items bolder inside ReadmeBuilder.addItem
                builder.addItem(item, { hasDetails: item.slug && markdowns.has(item.slug) });
            }

            builder.addNewLine();
        }

        return builder.build();
    }

    /**
     * Sort category IDs by priority, then alphabetically
     * @param groups Groups of items by category ID
     * @param categories Map of category details
     */
    private sortCategoriesByPriority(
        groups: Record<string, ItemData[]>,
        categories: Map<string, Category>,
    ): string[] {
        const categoryIds = Object.keys(groups);

        return categoryIds.sort((aId, bId) => {
            const categoryA = categories.get(aId);
            const categoryB = categories.get(bId);
            const featuredCountA = groups[aId].filter((item) => item.featured).length;
            const featuredCountB = groups[bId].filter((item) => item.featured).length;

            // Ensure categories with featured items always come first
            const aHasFeatured = featuredCountA > 0;
            const bHasFeatured = featuredCountB > 0;
            if (aHasFeatured !== bHasFeatured) {
                return aHasFeatured ? -1 : 1;
            }

            // If both have priority, sort by priority number (lower = higher priority)
            if (categoryA?.priority !== undefined && categoryB?.priority !== undefined) {
                return categoryA.priority - categoryB.priority;
            }
            // If only A has priority, A comes first
            if (categoryA?.priority !== undefined && categoryB?.priority === undefined) {
                return -1;
            }
            // If only B has priority, B comes first
            if (categoryA?.priority === undefined && categoryB?.priority !== undefined) {
                return 1;
            }

            if (featuredCountA !== featuredCountB) {
                return featuredCountB - featuredCountA;
            }

            // If neither has priority, sort alphabetically by name
            const nameA = categoryA?.name || aId;
            const nameB = categoryB?.name || bId;
            return nameA.localeCompare(nameB);
        });
    }

    private async loadCategories(data: DataRepository): Promise<Map<string, Category>> {
        const list = await data.getCategories();
        const categories = new Map<string, Category>();

        for (const category of list) {
            categories.set(category.id, category);
        }

        return categories;
    }

    private async loadTags(data: DataRepository): Promise<Map<string, Category>> {
        const list = await data.getTags();
        const tags = new Map<string, Category>();

        for (const tag of list) {
            tags.set(tag.id, tag);
        }

        return tags;
    }

    /* Works with both tags and categories */
    private populate<T extends Identifiable>(value: string | T, collection: Map<string, T>): T {
        const id = typeof value === 'string' ? value : value.id;
        const populated = collection.get(id);

        if (populated) {
            return populated;
        }

        if (typeof value === 'string') {
            const result = { id, name: value } as T;
            collection.set(id, result);
            return result;
        }

        collection.set(value.id, value);
        return value;
    }
}
