import { Injectable } from '@nestjs/common';
import { stringify as yamlStringify } from 'yaml';
import slugify from 'slugify';
import { AiEngineService } from '../ai-engine/ai-engine.service';
import { GithubService } from '../github/github.service';
import { GitService } from '../github/git.service'; 
import { join } from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

@Injectable()
export class DataGeneratorService {
    constructor(
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
        private readonly aiEngine: AiEngineService
    ) {}

    getDataRepositoryName(name: string) {
        return `${name}-data`;
    }

    async initializeV2(name: string) {
        const items = await this.aiEngine.getItemsList();
        const owner = {
            name: process.env.GITHUB_LOGIN,
            apiKey: process.env.GITHUB_APIKEY
        };
        const repo = this.getDataRepositoryName(name);
        await this.githubService.createEmptyRepository(repo, `machine-readable data for ${name}`, owner);
        const url = `https://github.com/${owner.name}/${repo}`;
        const dir = join(tmpdir(), randomUUID());
        await this.gitService.clone(url, dir, owner.apiKey);
        const updatedAt = new Date();

        const ymlDir = join(dir, 'data');
        const mdDir = join(dir, 'details');

        await fs.mkdir(ymlDir, { recursive: true });
        await fs.mkdir(mdDir, { recursive: true });

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            });
            const ymlPath = join(ymlDir, `${filename}.yml`);
            const mdPath = join(mdDir, `${filename}.md`);
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            const markdown = await this.aiEngine.getItemDetails();

            const writes = [
                fs.writeFile(ymlPath, content, { encoding: 'utf-8' }),
                fs.writeFile(mdPath, markdown, { encoding: 'utf-8' }),
            ]
 
            await Promise.all(writes);
            await this.gitService.add(dir, '.');
            await this.gitService.commit(dir, `add ${item.name}`);
        }
        
        await this.gitService.push(dir, owner.apiKey);
        await fs.rm(dir, { recursive: true, force: true });
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
