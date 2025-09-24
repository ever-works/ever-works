import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { GithubService } from '../git/github.service';
import type { Identifiable, ItemData, Tag } from '../agent/types';
import { Category } from '../items-generator/dto/category.dto';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository, PRUpdate } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';
import { GenerationMethod } from '../items-generator/dto';
import { DirectoryRepository } from '../database';

type InitializeOptions = {
    repository_description?: string;
    generation_method?: GenerationMethod;
    pr_update?: PRUpdate;
    remove_details?: string[];
};

@Injectable()
export class MarkdownGeneratorService {
    private readonly logger = new Logger(MarkdownGeneratorService.name);

    constructor(
        private readonly githubService: GithubService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async initialize(directory: Directory, user: User, options: InitializeOptions = {}) {
        const token = user.getGitToken();
        const committer = user.asCommitter();

        const description = options?.repository_description || directory.description;

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(
                directory.getRepoOwner(),
                directory.slug,
                description,
                token,
            );
        } else {
            await this.githubService.createEmptyRepo(directory.slug, description, token);
        }

        // Calling CloneOrPull switches to main branch by default
        const markdownPath = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo: directory.slug,
            token,
            committer,
        });

        // Calling CloneOrPull switches to main branch by default
        const dataPath = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo: directory.getDataRepo(),
            token,
            committer,
        });

        const markdownRepo = new MarkdownRepository(markdownPath);
        const dataRepo = await DataRepository.create(dataPath);

        try {
            const slugs = await fs.readdir(dataRepo.dataDir);
            await markdownRepo.ensureDirectoriesExist();

            const defaultBranch = await this.githubService
                .getMainBranch(markdownRepo.dir)
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
                await this.githubService.switchToMainBranch(markdownRepo.dir).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });

                await markdownRepo.resetFiles();
            } else if (canCreatePR) {
                // Switch to PR branch (both repos)
                await Promise.all([
                    this.githubService.switchToBranch(markdownRepo.dir, pr_update.branch, true),
                    this.githubService.switchToBranch(dataRepo.dir, pr_update.branch, true),
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

                const item = await dataRepo.getItem(slug);
                if (Array.isArray(item.tags)) {
                    item.tags = item.tags.map((tag) => this.populate<Tag>(tag, tags));
                }

                if (Array.isArray(item.category)) {
                    item.category = item.category.map((category) =>
                        this.populate<Category>(category, categories),
                    );
                } else {
                    item.category = [this.populate(item.category, categories)];
                }

                for (const category of item.category) {
                    const group = groups[category.id];
                    if (group) {
                        group.push(item);
                    } else {
                        groups[category.id] = [item];
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

            await this.githubService.addAll(markdownPath);
            await this.githubService.commit(markdownPath, 'sync README.md', user.asCommitter());
            await this.githubService.push(markdownPath, token);

            if (canCreatePR && defaultBranch) {
                this.logger.log(
                    `Creating PR from ${pr_update.branch} to ${defaultBranch} for ${directory.slug}`,
                );

                const pr = await this.githubService
                    .createPR(
                        {
                            owner: directory.getRepoOwner(),
                            repo: directory.slug,
                            base: defaultBranch,
                            head: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                        },
                        token,
                    )
                    .catch((err) => {
                        this.logger.error('Failed to create PR', err);
                        return null;
                    });

                if (pr) {
                    await this.directoryRepository.updateLastPullRequest(directory.id, {
                        main: {
                            branch: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                            number: pr.number,
                            url: pr.html_url,
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
        const token = user.getGitToken();
        const committer = user.asCommitter();

        const markdownPath = await this.githubService.cloneOrPull({
            owner: directory.getRepoOwner(),
            repo: directory.slug,
            token,
            committer,
        });

        const markdownRepo = new MarkdownRepository(markdownPath);

        if (branch) {
            await this.githubService.switchToBranch(markdownRepo.dir, branch, true).catch((err) => {
                this.logger.error('Failed to switch to PR branch', err);
            });
        }

        await markdownRepo.removeDetails(slug);
    }

    /**
     * Remove repository for a directory
     */
    async removeRepository(directory: Directory, user: User): Promise<void> {
        const token = user.getGitToken();

        try {
            // Delete the GitHub repository
            await this.githubService.deleteRepository(
                directory.getRepoOwner(),
                directory.slug,
                token,
            );

            const dataDir = this.githubService.getDir(
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
        const dataDir = this.githubService.getDir(
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
            builder.addSubHeader(categoryDetails.name);

            const items = groups[categoryId];
            items.sort((a, b) => {
                if (a.featured && !b.featured) return -1;
                if (!a.featured && b.featured) return 1;
                return 0;
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

            // order by items featured count
            const featuredCountA = groups[aId].filter((item) => item.featured).length;
            const featuredCountB = groups[bId].filter((item) => item.featured).length;
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
