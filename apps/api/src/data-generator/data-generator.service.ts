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
    ) { }

    getDataRepositoryName(name: string): string {
        return `${name}-data`;
    }

    private async prepareRepository(owner: string, repo: string, token: string) {
        const url = `https://github.com/${owner}/${repo}`;
        const dir = join(tmpdir(), randomUUID());
        await this.gitService.clone(url, dir, token);

        return dir;
    }

    private async ensureDirectoriesExist(dir: string) {
        const ymlDir = join(dir, 'data');
        const mdDir = join(dir, 'details');

        await Promise.all([
            fs.mkdir(ymlDir, { recursive: true }),
            fs.mkdir(mdDir, { recursive: true }),
        ]);

        return { ymlDir, mdDir };
    }

    private async processItem(item: any, dirs: { ymlDir: string; mdDir: string }, updatedAt: Date, dir: string) {
        const filename = slugify(item.name, { lower: true, trim: true });
        const ymlPath = join(dirs.ymlDir, `${filename}.yml`);
        const mdPath = join(dirs.mdDir, `${filename}.md`);

        const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
        const markdown = await this.aiEngine.getItemDetails();

        await Promise.all([
            fs.writeFile(ymlPath, content, { encoding: 'utf-8' }),
            fs.writeFile(mdPath, markdown, { encoding: 'utf-8' }),
        ]);

        await this.gitService.add(dir, '.');
        await this.gitService.commit(dir, `add ${item.name}`);
    }

    private async cleanupDirectory(dir: string) {
        await fs.rm(dir, { recursive: true, force: true });
    }

    async initialize(name: string) {
        const items = await this.aiEngine.getItemsList();
        const token = process.env.GITHUB_APIKEY;
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(name);
        await this.githubService.createEmptyRepository(repo, `machine-readable data for ${name}`, { apiKey: token });
        const dest = await this.prepareRepository(owner.login, repo, token);
        const dirs = await this.ensureDirectoriesExist(dest);
        const updatedAt = new Date();

        for (const item of items) {
            await this.processItem(item, dirs, updatedAt, dest);
        }

        await this.gitService.push(dest, token);
        await this.cleanupDirectory(dest);
    }

    async update(name: string) {
        const items = await this.aiEngine.getItemsList();
        const token = process.env.GITHUB_APIKEY;
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(name);
        const dest = await this.prepareRepository(owner.login, repo, token);
        const dirs = await this.ensureDirectoriesExist(dest);
        const updatedAt = new Date();

        const existingFiles = new Set(await fs.readdir(dirs.ymlDir));

        for (const item of items) {
            const filename = slugify(item.name, { lower: true, trim: true });
            if (existingFiles.has(`${filename}.yml`)) {
                continue;
            }
            await this.processItem(item, dirs, updatedAt, dest);
        }

        await this.gitService.push(dest, token);
        await this.cleanupDirectory(dest);
    }
}
