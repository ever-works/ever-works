import { Injectable } from '@nestjs/common';
import { stringify as yamlStringify } from 'yaml';
import slugify from 'slugify';
import { AiEngineService } from '../ai-engine/ai-engine.service';
import { GithubService } from '../github/github.service';

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
            }) + '.yml';
            const updatedAt = new Date();
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            await this.githubService.createFile(repo, filename, content, `create ${filename}`, {
                ...owner,
                name: login,
            });
        }
    }

    async sync(name: string) {
        const items = await this.aiEngine.getItemsList();
        const repo = this.getDataRepositoryName(name);
        const apiKey = process.env.GITHUB_APIKEY;
        const user = await this.githubService.getUser(apiKey);
        const owner = { apiKey, name: user.login };

        const files = await this.githubService.getContent(repo, '', owner);
        if (!Array.isArray(files))
            throw new Error('Unexpected repository structure');

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            }) + '.yml';

            if (files.some(({ path }) => filename === path)) {
                continue;
            }
            const updatedAt = new Date();
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            await this.githubService.createFile(repo, filename, content, `create ${filename}`, owner);
        }
    }
}
