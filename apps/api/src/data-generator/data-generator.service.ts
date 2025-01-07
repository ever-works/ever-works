import { Injectable } from '@nestjs/common';
import { stringify } from 'yaml';
import slugify from 'slugify';
import { AiEngineService } from '../ai-engine/ai-engine.service';
import { GithubService } from '../github/github.service';

@Injectable()
export class DataGeneratorService {
    constructor(
        private readonly githubService: GithubService,
        private readonly aiEngine: AiEngineService
    ) {}

    async generate(name: string) {
        const items = await this.aiEngine.getItemsList();
        const owner = {
            apiKey: process.env.GITHUB_APIKEY
        };

        const repo = `${name}-data`;
        const { owner: { login } } = await this.githubService.createEmptyRepository(repo, `machine-readable data for ${name}`, owner);

        for (const item of items) {
            const filename = slugify(item.name, {
                lower: true,
                trim: true,
            }) + '.yml';
            const content = stringify(item);
            await this.githubService.commitFile(repo, filename, content, `create ${filename}`, {
                ...owner,
                name: login,
            });
        }
    }
}
