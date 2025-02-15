import { Injectable } from '@nestjs/common';
import { parse as yamlParse } from 'yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';
import type { ItemData } from '../ai-engine/ai-engine.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';

@Injectable()
export class MarkdownGeneratorService {
    constructor(
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
    ) {}

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

        try {
            const items = await fs.readdir(dataRepo.dataDir);
           await markdownRepo.ensureDirectoriesExist();

            const groups = {};
            for (const item of items) {
                const itemPath = path.join(dataRepo.dataDir, item);
                const extname = path.extname(item);

                if (extname === '.md') {
                    await markdownRepo.copyMarkdownFromData(dataRepo.dataDir, item);
                    markdowns.add(item);
                    continue;
                }

                if (extname !== '.yml')
                    continue;

                const file = await fs.readFile(itemPath, { encoding: 'utf-8' });
                const obj: ItemData = yamlParse(file);
                obj.slug = path.basename(item, extname);

                const group = groups[obj.category];
                if (group) {
                    group.push(obj);
                } else {
                    groups[obj.category] = [obj];
                }
            }

            const readme: string = await this.generateReadme(dataRepo, directory, markdowns, groups);
            await markdownRepo.writeReadme(readme);
            await this.gitService.add(markdownPath, '.');
            await this.gitService.commit(markdownPath, 'sync README.md');
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
        directory: Directory,
        markdowns: Set<string>,
        groups: Record<string, Array<ItemData>>
    ) {
        const config = await data.getConfig();
        const builder = new ReadmeBuilder(markdowns);

        builder.addHeader(directory.name);
        builder.addParagraph(directory.description);

        if (config.content_table) {
            const table = Object.keys(groups).map((slug) => {
                const name = data.getCategoryName(slug);
                return { name, slug };
            });

            builder.addSubHeader('Table of contents');
            builder.addTableOfContents(table);
        }

        for (const category in groups) {
            const categoryName = data.getCategoryName(category);
            builder.addSubHeader(categoryName);

            const items = groups[category];
            for (const item of items) {
                builder.addItem(item);
            }

            builder.addNewLine();
        }

        return builder.build();
    }
}
