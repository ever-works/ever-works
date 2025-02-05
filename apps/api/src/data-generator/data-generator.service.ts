import { Injectable, Logger } from '@nestjs/common';
import { stringify as yamlStringify } from 'yaml';
import slugify from 'slugify';
import { join } from 'path';
import * as fs from 'fs/promises';
import { AiEngineService, ItemData } from '../ai-engine/ai-engine.service';
import { GithubService } from '../git/github.service';
import { GitService } from '../git/git.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger('DataGeneratorService');

    constructor(
        private readonly githubService: GithubService,
        private readonly gitService: GitService,
        private readonly aiEngine: AiEngineService
    ) {}

    async initialize(directory: Directory, user: User, prompt: string) {
        const items = await this.aiEngine.getItemsList({ prompt });
        const token = user.getGitToken();
        const repo = directory.getDataRepo();
        const description = `machine-readable data for ${directory.slug}`;

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(directory.owner, repo, description, token);
        } else {
            await this.githubService.createEmptyRepo(repo, description, token);
        }
        
        const dest = await this.githubService.clone(directory.owner, repo, token);
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

    async update(directory: Directory, user: User, prompt: string) {
        const items = await this.aiEngine.getItemsList({ prompt });
        items.push({ 
            name: 'Test Sample',
            category: 'None',
            description: 'Best service ever',
            source_url: 'https://example.com', 
        });
        const token = user.getGitToken();
        const repo = directory.getDataRepo();
        const dest = await this.githubService.clone(directory.owner, repo, token);

        try {
            const dirs = await this.ensureDirectoriesExist(dest);
            const updatedAt = new Date();

            const existingFiles = new Set(await fs.readdir(dirs.dataDir));

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

    /* it's still in seperated function in case we will need more dirs */
    private async ensureDirectoriesExist(dir: string) {
        const dataDir = join(dir, 'data');
        await fs.mkdir(dataDir, { recursive: true });

        return { dataDir };
    }

    private async processItem(item: ItemData, filename: string, dirs: { dataDir: string }, updatedAt: Date, dir: string) {
        const ymlPath = join(dirs.dataDir, `${filename}.yml`);
        const mdPath = join(dirs.dataDir, `${filename}.md`);

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
