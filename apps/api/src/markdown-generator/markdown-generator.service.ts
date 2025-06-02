import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { GithubService } from '../git/github.service';
import type { Category, Identifiable, ItemData, Tag } from '../agent/types';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';
import { GenerationMethod } from '../items-generator/dto';

@Injectable()
export class MarkdownGeneratorService {
    private readonly logger = new Logger(MarkdownGeneratorService.name);

    constructor(private readonly githubService: GithubService) {}

    async initialize(directory: Directory, user: User) {
        const token = user.getGitToken();

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(
                directory.owner,
                directory.slug,
                directory.description,
                token,
            );
        } else {
            await this.githubService.createEmptyRepo(directory.slug, directory.description, token);
        }

        const markdownPath = await this.githubService.cloneOrPull(
            directory.owner,
            directory.slug,
            token,
        );

        const dataPath = await this.githubService.cloneOrPull(
            directory.owner,
            directory.getDataRepo(),
            token,
        );

        const markdownRepo = new MarkdownRepository(markdownPath);
        const dataRepo = await DataRepository.create(dataPath);

        const markdowns = new Set<string>(); // will be needed to check if markdown exists before referencing them in README
        const categories = await this.loadCategories(dataRepo);
        const tags = await this.loadTags(dataRepo);
        const config = await dataRepo.getConfig();

        try {
            const slugs = await fs.readdir(dataRepo.dataDir);
            await markdownRepo.ensureDirectoriesExist();

            const defaultBranch = await this.githubService
                .getMainBranch(markdownRepo.dir)
                .catch((err) => {
                    this.logger.error('Failed to get main branch', err);
                    return null;
                });

            let canCreatePR =
                config.generation_method !== GenerationMethod.RECREATE && !!config.pr_update?.branch;

            // In case of re-creation:
            // Switch to the main branch and remove existing items files.
            if (config?.generation_method === GenerationMethod.RECREATE) {
                await this.githubService.switchToMainBranch(markdownRepo.dir).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });

                await markdownRepo.resetFiles();
            } else if (config.pr_update?.branch) {
                // Switch to PR branch
                await this.githubService
                    .switchToBranch(markdownRepo.dir, config.pr_update.branch, true)
                    .catch((err) => {
                        canCreatePR = false;
                        this.logger.error('Failed to switch to PR branch', err);
                    });
            }

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
            await this.githubService.add(markdownPath, '.');
            await this.githubService.commit(markdownPath, 'sync README.md', user.asCommitter());
            await this.githubService.push(markdownPath, token);

            if (canCreatePR && defaultBranch) {
                this.logger.log(
                    `Creating PR from ${config.pr_update.branch} to ${defaultBranch} for ${directory.slug}`,
                );

                await this.githubService
                    .createPR(
                        {
                            owner: directory.owner,
                            repo: directory.slug,
                            base: defaultBranch,
                            head: config.pr_update.branch,
                            title: config.pr_update.title,
                            body: config.pr_update.body,
                        },
                        token,
                    )
                    .catch((err) => {
                        this.logger.error('Failed to create PR', err);
                    });
            } else {
                this.logger.log(`Pushed changes to main branch for ${directory.slug}`);
            }
        } catch (err) {
            this.logger.error('Error during markdown generation', err);
            throw err;
        } finally {
            await Promise.all([dataRepo.cleanup(), markdownRepo.cleanup()]);
        }
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

        for (const category in groups) {
            const categoryDetails = categories.get(category);
            builder.addSubHeader(categoryDetails.name);

            const items = groups[category];
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
