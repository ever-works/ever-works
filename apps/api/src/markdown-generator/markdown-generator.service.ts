import { Injectable } from '@nestjs/common';
import { parse as yamlParse } from 'yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';
import type { ItemData } from '../ai-engine/ai-engine.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import slugify from 'slugify';

interface IDataConfig {
    content_table?: boolean;
}

@Injectable()
export class MarkdownGeneratorService {
    constructor(
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
    ) { }

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

    async readConfig(dataDir: string): Promise<IDataConfig> {
        const configPath = path.join(dataDir, 'config.yml');
        try {
            const config = await fs.readFile(configPath, { encoding: 'utf-8' });
            return yamlParse(config);
        } catch (err) {
            if (err && err.code && err.code === 'ENOENT') {
                return {};
            }
            throw err;
        }
    }

    async update(directory: Directory, user: User) {
        const token = user.getGitToken();

        const dataRepo = await this.githubService.clone(
            directory.owner,
            directory.getDataRepo(),
            token,
        );
        const config = await this.readConfig(dataRepo);

        const markdownRepo = await this.githubService.clone(directory.owner, directory.slug, token);
        const markdowns = new Set<string>();
        const markdownsPath = path.join(markdownRepo, 'details');

        const entriesPath = path.join(dataRepo, 'data');
        const entries = await fs.readdir(entriesPath);

        try {
            const data = {};
            for (const entry of entries) {
                const entryPath = path.join(entriesPath, entry);
                const extname = path.extname(entry);

                if (extname === '.md') {
                    await fs.mkdir(markdownsPath, { recursive: true });
                    const copy = await fs.readFile(entryPath, { encoding: 'utf-8' });
                    await fs.writeFile(path.join(markdownsPath, entry), copy, { encoding: 'utf-8' });
                    markdowns.add(entry);
                    continue;
                }

                if (extname !== '.yml')
                    continue;

                const file = await fs.readFile(entryPath, { encoding: 'utf-8' });
                const obj: ItemData = yamlParse(file);
                obj.slug = path.basename(entry, path.extname(entry));

                const group = data[obj.category];
                if (group) {
                    group.push(obj);
                } else {
                    data[obj.category] = [obj];
                }
            }

            const markdown = this.createMarkdown(directory, markdowns, data, config);
            await fs.writeFile(path.join(markdownRepo, 'README.md'), markdown, { encoding: 'utf-8' });
            await this.gitService.add(markdownRepo, '.');
            await this.gitService.commit(markdownRepo, 'sync README.md');
            await this.githubService.push(markdownRepo, token);
        } catch (err) {
            throw err;
        } finally {
            await Promise.all([
                fs.rm(dataRepo, { recursive: true, force: true }),
                fs.rm(markdownRepo, { recursive: true, force: true }),
            ]);
        }
    }

    // TODO: replace with some library
    private createMarkdown(
        directory: Directory,
        markdowns: Set<string>,
        data: { [c: string]: Array<ItemData> },
        config: IDataConfig,
    ) {
        let md = `# ${directory.name}\n\n`;
        md += `${directory.description}\n\n`;

        if (config.content_table) {
            md += '## Table of contents\n\n';
            for (const category in data) {
                md += `- [${category}](#${slugify(category)})\n`;
            }
            md += '\n';
        }

        for (const category in data) {
            md += `## ${category}\n\n`;
            const items = data[category];

            for (const item of items) {
                md += `- [${item.name}](${item.source_url}) - ${item.description}`;

                if (item.slug && markdowns.has(`${item.slug}.md`))
                    md += ` ([Read more](/details/${item.slug}.md))`;

                md += '\n';
            }

            md += '\n';
        }

        return md;
    }
}
