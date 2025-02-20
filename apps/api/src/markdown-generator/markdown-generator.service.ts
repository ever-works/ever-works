import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import { GithubService } from '../git/github.service';
import type { Category, ItemData } from '../ai-engine/ai-engine.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';

@Injectable()
export class MarkdownGeneratorService {
    constructor(private readonly githubService: GithubService) { }

    async initialize(directory: Directory, user: User) {
        const token = user.getGitToken();

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(
                directory.owner,
                directory.slug,
                directory.description,
                token
            );
        } else {
            await this.githubService.createEmptyRepo(directory.slug, directory.description, token);
        }
        await this.update(directory, user);
    }

    async update(directory: Directory, user: User) {
        const token = user.getGitToken();

        const markdownPath = await this.githubService.clone(directory.owner, directory.slug, token);
        const dataPath = await this.githubService.clone(
            directory.owner,
            directory.getDataRepo(),
            token,
        );

        const markdownRepo = new MarkdownRepository(markdownPath);
        const dataRepo = new DataRepository(dataPath);
        const markdowns = new Set<string>(); // will be needed to check if markdown exists before referencing them in README
        const categories = await this.loadCategories(dataRepo);

        try {
            const slugs = await fs.readdir(dataRepo.dataDir);
            await markdownRepo.ensureDirectoriesExist();

            const groups = {};  // we want to group items by category, like: { 'open-source': [items], 'commercial': [items] }
            for (const slug of slugs) {
                const markdown = await dataRepo.getMarkdown(slug);
                if (markdown) {
                    await markdownRepo.writeDetails(slug, markdown);
                    markdowns.add(slug);
                }

                const item = await dataRepo.getItem(slug);
                if (Array.isArray(item.category)) {
                    item.category = item.category.map(category => this.populateCategory(category, categories));
                } else {
                    item.category = [this.populateCategory(item.category, categories)];
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

            const readme: string = await this.generateReadme(dataRepo, markdowns, groups, categories);
            await markdownRepo.writeReadme(readme);
            await this.githubService.add(markdownPath, '.');
            await this.githubService.commit(markdownPath, 'sync README.md',  user.asCommitter());
            await this.githubService.push(markdownPath, token);
        } catch (err) {
            throw err;
        } finally {
            await Promise.all([
                dataRepo.cleanup(),
                markdownRepo.cleanup(),
            ]);
        }
    }

    private async generateReadme(
        data: DataRepository,
        markdowns: Set<string>,
        groups: Record<string, Array<ItemData>>,
        categories: Map<string, Category>
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

    private populateCategory(category: string | Category, categories: Map<string, Category>): Category {
        const id = typeof category === 'string' ? category : category.id;
        const populated = categories.get(id);

        if (populated) {
            return populated;
        }

        if (typeof category === 'string') {
            const result = { id, name: category };
            categories.set(id, result);
            return result;
        }

        categories.set(category.id, category);
        return category
    }
}
