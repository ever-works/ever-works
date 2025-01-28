import { Injectable, Logger } from '@nestjs/common';
import { stringify as yamlStringify } from 'yaml';
import slugify from 'slugify';
import { join } from 'path';
import * as fs from 'fs/promises';
import { AiEngineService, ItemData } from '../ai-engine/ai-engine.service';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';

export interface Directory {
    name: string;
    slug: string;
    description: string;
}

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger('DataGeneratorService');

    constructor(
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
        private readonly aiEngine: AiEngineService
    ) { }

    getDataRepositoryName(name: string): string {
        return `${name}-data`;
    }

    async initialize(directory: Directory, prompt: string) {
        const items = await this.aiEngine.getItemsList({ prompt });
        const token = process.env.GITHUB_APIKEY; // TODO: take access token from authenticated user object
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(directory.slug);
        await this.githubService.createEmptyRepository(repo, `machine-readable data for ${directory.slug}`, token);
        const dest = await this.githubService.clone(owner.login, repo, token);

        try {
            const dirs = await this.ensureDirectoriesExist(dest);
            const updatedAt = new Date();

            for (const item of items) {
                const filename = slugify(item.name, { lower: true, trim: true });
                await this.processItem(item, filename, dirs, updatedAt, dest);
            }

            await this.githubService.push(dest, token);
        } catch (err) {
            this.logger.error('Failed to initialize data repository', err);
            throw err;
        } finally {
            await fs.rm(dest, { recursive: true, force: true });
        }
    }

    async update(directory: Directory, prompt: string) {
        const items = await this.aiEngine.getItemsList({ prompt });
        items.push({ 
            name: 'Test Sample',
            category: 'None',
            description: 'Best service ever',
            source_url: 'https://example.com', 
        });
        const token = process.env.GITHUB_APIKEY; // TODO: take access token from authenticated user object
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(directory.slug);
        const dest = await this.githubService.clone(owner.login, repo, token);

        try {
            const dirs = await this.ensureDirectoriesExist(dest);
            const updatedAt = new Date();

            const existingFiles = new Set(await fs.readdir(dirs.ymlDir));

            for (const item of items) {
                const filename = slugify(item.name, { lower: true, trim: true });
                if (existingFiles.has(`${filename}.yml`)) {
                    continue;
                }
                await this.processItem(item, filename, dirs, updatedAt, dest);
            }

            await this.githubService.push(dest, token);
        } catch (err) {
            this.logger.error('Failed to update data repository', err);
            throw err;
        } finally {
            await fs.rm(dest, { recursive: true, force: true });
        }
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

    private async processItem(item: ItemData, filename: string, dirs: { ymlDir: string; mdDir: string }, updatedAt: Date, dir: string) {
        const ymlPath = join(dirs.ymlDir, `${filename}.yml`);
        const mdPath = join(dirs.mdDir, `${filename}.md`);

        const yaml = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
        const markdown = await this.aiEngine.getItemDetails(item);

        await Promise.all([
            fs.writeFile(ymlPath, yaml, { encoding: 'utf-8' }),
            fs.writeFile(mdPath, markdown, { encoding: 'utf-8' }),
        ]);

        await this.gitService.add(dir, '.');
        await this.gitService.commit(dir, `add ${item.name}`);
    }
}
