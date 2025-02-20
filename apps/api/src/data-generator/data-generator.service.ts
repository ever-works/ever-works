import { Injectable, Logger } from '@nestjs/common';
import slugify from 'slugify';
import * as fs from 'fs/promises';
import { AiEngineService, ItemData } from '../ai-engine/ai-engine.service';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository, DEFAULT_DATA_CONFIG } from './data-repository';

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger('DataGeneratorService');

    constructor(
        private readonly githubService: GithubService,
        private readonly aiEngine: AiEngineService
    ) {}

    async initialize(directory: Directory, user: User, prompt: string) {
        const categories = await this.aiEngine.getCategoryList();
        const items = await this.aiEngine.getItemsList({ prompt, categories });
        const token = user.getGitToken();
        const repo = directory.getDataRepo();
        const description = `machine-readable data for ${directory.slug}`;

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(directory.owner, repo, description, token);
        } else {
            await this.githubService.createEmptyRepo(repo, description, token);
        }
        
        const dest = await this.githubService.clone(directory.owner, repo, token);
        const data = new DataRepository(dest);
        
        try {
            await data.ensureDirectoriesExist();
            await Promise.all([
                data.writeConfig(DEFAULT_DATA_CONFIG),
                data.writeCategories(categories),
                data.writeMarkdownTemplate(this.getHeader(directory), this.getFooter()),
            ]);
            await this.githubService.add(data.dir, '.');
            await this.githubService.commit(data.dir, `init repository`, user.asCommitter());

            for (const item of items) {
                item.slug = slugify(item.name, { lower: true });
                await this.processItem(data, item, user);
            }

            await this.githubService.push(dest, token);
        } catch (err) {
            this.logger.error('Failed to initialize data repository', err);
            throw err;
        } finally {
            await data.cleanup();
        }
    }

    async update(directory: Directory, user: User, prompt: string) {
        const token = user.getGitToken();
        const repo = directory.getDataRepo();
        const dest = await this.githubService.clone(directory.owner, repo, token);
        const data = new DataRepository(dest);

        const categories = await data.getCategories();
        const items = await this.aiEngine.getItemsList({ prompt, categories });
        // mock adding some new item:
        items.push({ 
            name: 'Test Sample',
            category: 'testing',
            description: 'Best service ever',
            source_url: 'https://example.com', 
        });

        try {
            await data.ensureDirectoriesExist();
            const existingItems = new Set(await fs.readdir(data.dataDir));

            for (const item of items) {
                item.slug = slugify(item.name, { lower: true });
                if (existingItems.has(item.slug)) {
                    continue;
                }
                await this.processItem(data, item, user);
            }

            await this.githubService.push(dest, token);
        } catch (err) {
            this.logger.error('Failed to update data repository', err);
            throw err;
        } finally {
            await data.cleanup();
        }
    }

    private async processItem(data: DataRepository, item: ItemData, user: User) {
        const markdown = await this.aiEngine.getItemDetails(item);
        await data.createItemDir(item);

        await Promise.all([
            data.writeItem(item),
            data.writeItemMarkdown(item, markdown),
        ]);

        await this.githubService.add(data.dir, '.');
        await this.githubService.commit(data.dir, `add ${item.name}`, user.asCommitter());
    }

    private getHeader(directory: Directory) {
        return `# ${directory.name}\n` +
                `${directory.description}\n\n`;
    }

    private getFooter() {
        return "## License\n\n" +
            "Shield: [![CC BY-SA 4.0][cc-by-sa-shield]][cc-by-sa]\n\n" +
            "This work is licensed under a\n\n" +
            "[Creative Commons Attribution-ShareAlike 4.0 International License][cc-by-sa].\n\n" +
            "[![CC BY-SA 4.0][cc-by-sa-image]][cc-by-sa]\n\n" +
            "[cc-by-sa]: http://creativecommons.org/licenses/by-sa/4.0/\n\n" +
            "[cc-by-sa-image]: https://licensebuttons.net/l/by-sa/4.0/88x31.png\n\n" +
            "[cc-by-sa-shield]: https://img.shields.io/badge/License-CC%20BY--SA%204.0-lightgrey.svg\n\n";
    }
}
