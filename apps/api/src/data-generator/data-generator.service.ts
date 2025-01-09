import { Injectable } from '@nestjs/common';
import { stringify as yamlStringify } from 'yaml';
import slugify from 'slugify';
import { AiEngineService } from '../ai-engine/ai-engine.service';
import { GithubService } from '../github/github.service';
import { join } from 'path';

@Injectable()
export class DataGeneratorService {
    constructor(
        private readonly githubService: GithubService,
        private readonly aiEngine: AiEngineService
    ) {}

    getDataRepositoryName(name: string) {
        return `${name}-data`;
    }

    async initialize(name: string) {
        const items = await this.aiEngine.getItemsList();
        const owner = {
            apiKey: process.env.GITHUB_APIKEY
        };

        const repo = this.getDataRepositoryName(name);
        const { owner: { login } } = await this.githubService.createEmptyRepository(repo, `machine-readable data for ${name}`, owner);

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            });
            const entrypath = join('entries', `${filename}.yml`);
            const updatedAt = new Date();
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            const detailpath = join('details', `${filename}.md`);
            const markdown = await this.aiEngine.getItemDetails();

            const requests = [
                this.githubService.createFile(repo, entrypath, content, `create ${filename}.yml`, {
                    ...owner,
                    name: login,
                }),
                this.githubService.createFile(repo, detailpath, markdown, `create ${filename}.md`, {
                    ...owner,
                    name: login,
                }),
            ];

            await Promise.all(requests);
        }
    }

    async update(name: string) {
        const items = await this.aiEngine.getItemsList();
        const repo = this.getDataRepositoryName(name);
        const apiKey = process.env.GITHUB_APIKEY;
        const user = await this.githubService.getUser(apiKey);
        const owner = { apiKey, name: user.login };

        const files = await this.githubService.getContent(repo, 'entries', owner);
        if (!Array.isArray(files))
            throw new Error('Unexpected repository structure');

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            });
            const entrypath = join('entries', `${filename}.yml`);
            if (files.some(({ path }) => entrypath === path)) {
                continue;
            }
            const updatedAt = new Date();
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            const detailpath = join('details', `${filename}.md`);
            const markdown = await this.aiEngine.getItemDetails();

            const requests = [
                this.githubService.createFile(repo, entrypath, content, `create ${filename}.yml`, owner),
                this.githubService.createFile(repo, detailpath, markdown, `create ${filename}.md`, owner),
            ];

            await Promise.all(requests);
        }
    }
}
