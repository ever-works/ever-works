import { Injectable } from '@nestjs/common';
import { DataGeneratorService } from '../data-generator/data-generator.service';
import { parse as yamlParse } from 'yaml';
import { GithubService } from '../github/github.service';
import type { ItemData } from '../ai-engine/ai-engine.service';

@Injectable()
export class MarkdownGeneratorService {
    constructor(
        private readonly dataGeneratorService: DataGeneratorService,
        private readonly githubService: GithubService,
    ) {}

    async initialize({name, title, description}: { name: string, title: string, description: string }) {
        const apiKey = process.env.GITHUB_APIKEY;
        const user = await this.githubService.getUser(apiKey);
        const owner = { apiKey, name: user.login };
        await this.githubService.createEmptyRepository(name, description, owner);
        const dataRepoName = this.dataGeneratorService.getDataRepositoryName(name);
        const entries = await this.githubService.getContent(dataRepoName, 'entries', owner);
        if (!Array.isArray(entries)) {
            throw new Error('Invalid repository structure');
        }

        const data = {};
        for (const entry of entries) {
            const file = await this.githubService.getContent(dataRepoName, entry.path, owner);
            if (Array.isArray(file))
                throw new Error('Unexpected directory');

            if (file.type !== 'file')
                throw new Error('Expected file');

            const content = Buffer.from(file.content, 'base64').toString('utf-8');
            const obj: ItemData = yamlParse(content);
            const group = data[obj.category];

            if (group) {
                group.push(obj);
            } else {
                data[obj.category] = [obj];
            }
        }

        const markdown = this.createMarkdown({ name, title, description }, data);
        await this.githubService.createFile(name, 'README.md', markdown, 'create README.md', owner);
    }

    private createMarkdown(
        {name, title, description}: { name: string, title: string, description: string }, 
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
