import { Injectable } from '@nestjs/common';
import { parse as yamlParse } from 'yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';
import type { ItemData } from '../ai-engine/ai-engine.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';

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

        const dataRepo = await this.githubService.clone(
            directory.owner,
            directory.getDataRepo(),
            token,
        );
        const markdownRepo = await this.githubService.clone(directory.owner, directory.slug, token);

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

            const markdown = this.createMarkdown(directory, data);
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
        data: { [c: string]: Array<ItemData> }
    ) {
        let md = `# ${directory.name}\n\n`;
        md += `${directory.description}\n\n`;

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
