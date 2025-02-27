import { Injectable, Logger } from '@nestjs/common';
import slugify from 'slugify';
import * as fs from 'fs/promises';
import { AiEngineService, ItemData } from '../ai-engine/ai-engine.service';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository, DEFAULT_DATA_CONFIG, IDataConfig } from './data-repository';

@Injectable()
export class DataGeneratorService {
    private readonly logger = new Logger('DataGeneratorService');

    constructor(
        private readonly githubService: GithubService,
        private readonly aiEngine: AiEngineService
    ) { }

    async initialize(directory: Directory, user: User, prompt: string) {
        const categories = await this.aiEngine.getCategoryList();
        const tags = await this.aiEngine.getTagsList();
        const items = await this.aiEngine.getItemsList({ prompt, categories, tags });
        const token = user.getGitToken();
        const repo = directory.getDataRepo();
        const description = `machine-readable data for ${directory.slug}`;

        if (directory.organization) {
            await this.githubService.createEmptyRepoAsOrg(directory.owner, repo, description, token);
        } else {
            await this.githubService.createEmptyRepo(repo, description, token);
        }

        const dest = await this.githubService.clone(directory.owner, repo, token);
        const data = await DataRepository.create(dest);

        try {
            await data.ensureDirectoriesExist();
            await Promise.all([
                data.writeReadme(this.getDefaultReadme(directory)),
                data.writeConfig(this.getDefaultConfig()),
                data.writeCategories(categories),
                data.writeTags(tags),
                data.writeMarkdownTemplate(this.getHeader(directory), this.getFooter()),
            ]);
            await this.githubService.add(data.dir, '.');
            await this.githubService.commit(data.dir, `init repository`, user.asCommitter());

            for (const item of items) {
                item.slug = slugify(item.name, { lower: true, trim: true });
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
        const data = await DataRepository.create(dest);

        const categories = await data.getCategories();
        const tags = await data.getTags();
        const items = await this.aiEngine.getItemsList({ prompt, categories, tags });
        // mock adding some new item:
        items.push({
            name: 'Test Sample',
            category: 'testing',
            description: 'Best service ever',
            source_url: 'https://example.com',
            tags: [ { name: 'Test', id: 'test' } ],
        });

        try {
            await data.ensureDirectoriesExist();
            const existingItems = new Set(await fs.readdir(data.dataDir));

            for (const item of items) {
                item.slug = slugify(item.name, { lower: true, trim: true });
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

    private getDefaultConfig(): IDataConfig {
        const now = new Date();
        return { ...DEFAULT_DATA_CONFIG, copyright_year: now.getFullYear() };
    }

    private getDefaultReadme(directory: Directory) {
        const markdownURL = this.githubService.getURL(directory.owner, directory.slug);
        return `# ${directory.getDataRepo()}\n\n` +
            `This repository holds data used to generate [${directory.slug}](${markdownURL})\n\n`;
    }

    private getHeader(directory: Directory) {
        return `# ${directory.name}\n\n` +
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
