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

    async initialize(name: string) {
        const items = await this.aiEngine.getItemsList();
        const token = process.env.GITHUB_APIKEY;  // we will get it from currently authenticated user object
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(name);
        await this.githubService.createEmptyRepository(repo, `machine-readable data for ${name}`, { apiKey: token });
        const url = `https://github.com/${owner.login}/${repo}`;
        const dir = join(tmpdir(), randomUUID());
        await this.gitService.clone(url, dir, token);
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
            ];
 
            await Promise.all(writes);
            await this.gitService.add(dir, '.');
            await this.gitService.commit(dir, `add ${item.name}`);
        }
        
        await this.gitService.push(dir, token);
        await fs.rm(dir, { recursive: true, force: true });
    }

    async update(name: string) {
        const items = await this.aiEngine.getItemsList();
        const token = process.env.GITHUB_APIKEY;  // we will get it from currently authenticated user object
        const owner = await this.githubService.getUser(token);
        const repo = this.getDataRepositoryName(name);
        const url = `https://github.com/${owner.login}/${repo}`;
        const dir = join(tmpdir(), randomUUID());
        await this.gitService.clone(url, dir, token);
        const updatedAt = new Date();

        const ymlDir = join(dir, 'data');
        const mdDir = join(dir, 'details');

        const files = await fs.readdir(ymlDir); // TODO: maybe replace with stream based fs.opendir and control number of returned files?

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            });

            if (files.includes(filename + '.yml')) {
                continue;
            }

            const ymlPath = join(ymlDir, `${filename}.yml`);
            const mdPath = join(mdDir, `${filename}.md`);
            const content = yamlStringify({ ...item, updated_at: updatedAt.toISOString() });
            const markdown = await this.aiEngine.getItemDetails();

            const writes = [
                fs.writeFile(ymlPath, content, { encoding: 'utf-8' }),
                fs.writeFile(mdPath, markdown, { encoding: 'utf-8' }),
            ];
 
            await Promise.all(writes);
            await this.gitService.add(dir, '.');
            await this.gitService.commit(dir, `add ${item.name}`);
        }
        
        await this.gitService.push(dir, token);
        await fs.rm(dir, { recursive: true, force: true });
    }
}
