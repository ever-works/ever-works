import { Injectable } from '@nestjs/common';
import { parse as yamlParse } from 'yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DataGeneratorService } from '../data-generator/data-generator.service';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';
import type { ItemData } from '../ai-engine/ai-engine.service';

@Injectable()
export class MarkdownGeneratorService {
    constructor(
        private readonly dataGeneratorService: DataGeneratorService,
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
    ) { }

    async initialize(data: { name: string, title: string, description: string }) {
        const token = process.env.GITHUB_APIKEY;
        await this.githubService.createEmptyRepository(data.name, data.description, token);
        await this.update(data);
    }

    async update({ name, title, description }: { name: string, title: string, description: string }) {
        const token = process.env.GITHUB_APIKEY;
        const owner = await this.githubService.getUser(token);

        const dataRepo = await this.githubService.clone(
            owner.login,
            this.dataGeneratorService.getDataRepositoryName(name),
            token,
        );
        const markdownRepo = await this.githubService.clone(owner.login, name, token);

        try {
            const data = {};
            const entriesPath = path.join(dataRepo, 'data');
            const entries = await fs.readdir(entriesPath);

            for (const entry of entries) {
                const file = await fs.readFile(path.join(entriesPath, entry), { encoding: 'utf-8' });
                const obj: ItemData = yamlParse(file);

                const group = data[obj.category];
                if (group) {
                    group.push(obj);
                } else {
                    data[obj.category] = [obj];
                }
            }

            const markdown = this.createMarkdown({ name, title, description }, data);
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
        { name, title, description }: { name: string, title: string, description: string },
        data: { [c: string]: Array<ItemData> }
    ) {
        let md = `# ${title}\n\n`;
        md += `${description}\n\n`;

        for (const category in data) {
            md += `## ${category}\n\n`;
            const items = data[category];

            for (const item of items) {
                md += `- [${item.name}](${item.source_url}) - ${item.description}\n`;
            }

            md += '\n';
        }

        return md;
    }
}
