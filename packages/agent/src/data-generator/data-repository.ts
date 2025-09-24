import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as yaml from 'yaml';
import deepmerge from 'deepmerge';
import { format } from 'date-fns';
import { Category, ItemData, Tag } from '../agent/types';
import { CreateItemsGeneratorDto, GenerationMethod } from '../items-generator/dto';

export type PRUpdate = {
    branch: string;
    title: string;
    body: string;
    number?: number;
    url?: string;
};

export interface IDataConfig {
    company_name?: string;
    company_website?: string;
    content_table?: boolean;
    item_name?: string;
    items_name?: string;
    copyright_year?: number;
    paging_mode?: string;
    autoapproval?: boolean;
    metadata?: {
        initial_prompt?: string;
        generation_method?: GenerationMethod;
        pr_update?: PRUpdate | null;
        last_request_data?: CreateItemsGeneratorDto;
    } & (Record<string, any> & {});
}

const DEFAULT_DATA_CONFIG: IDataConfig = {
    company_name: 'Acme',
    content_table: true, // Previous value was false
    item_name: 'Item',
    items_name: 'Items',
    paging_mode: 'paging',
    copyright_year: new Date().getFullYear(),
};

export class DataRepository {
    private config?: IDataConfig;
    private categories?: Category[];

    private constructor(
        public readonly dir: string,
        private readonly configPath: string,
        private categoriesPath: string,
        private readonly tagsPath: string,
        private readonly markdownTemplatePath: string,
        public readonly dataDir: string,
    ) {}

    static async create(dir: string): Promise<DataRepository> {
        /*
         *   File structure:
         *      - config.yml
         *      - categories.yml
         *      - tags.yml
         *      - data/
         *          - item1/
         *              - item1.yml
         *              - item1.md?
         *              - item1.mdx?
         *          - item2/
         *              - item2.yml
         *          - ...
         *          - itemN/
         *              - itemN.yml
         */

        const categoriesPath = await this.getCollectionPath(dir, 'categories');
        const tagsPath = await this.getCollectionPath(dir, 'tags');

        const repo = new DataRepository(
            dir,
            path.join(dir, 'config.yml'),
            categoriesPath,
            tagsPath,
            path.join(dir, 'markdown'),
            path.join(dir, 'data'),
        );

        return repo;
    }

    private static async shouldeUseDir(dir: string, type: 'categories' | 'tags') {
        try {
            const dirpath = path.join(dir, type);
            const stat = await fs.stat(dirpath);
            return stat.isDirectory();
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
                return false;
            }
            throw err;
        }
    }

    private static async getCollectionPath(dir: string, type: 'categories' | 'tags') {
        const useDir = await this.shouldeUseDir(dir, type);
        const collectionPath = useDir
            ? path.join(dir, type, `${type}.yml`)
            : path.join(dir, `${type}.yml`);

        return collectionPath;
    }

    private getItemPath(slug: string) {
        return path.join(this.dataDir, slug);
    }

    async cleanup() {
        await fs.rm(this.dir, { recursive: true, force: true });
    }

    /**
     * Remove all files except .git
     * and ensure all needed directories exist
     */
    async resetFiles() {
        const files = await fs.readdir(this.dir);
        for (const file of files) {
            if (file === '.git') {
                continue;
            }

            await fs.rm(path.join(this.dir, file), { recursive: true, force: true });
        }

        await this.ensureDirectoriesExist();
    }

    async ensureDirectoriesExist() {
        await Promise.all([
            fs.mkdir(this.markdownTemplatePath, { recursive: true }),
            fs.mkdir(this.dataDir, { recursive: true }),
        ]);
    }

    async getConfig(): Promise<IDataConfig> {
        if (this.config) {
            return this.config;
        }
        try {
            const config = await fs.readFile(this.configPath, 'utf-8');
            this.config = yaml.parse(config);

            return this.config;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                this.config = { ...DEFAULT_DATA_CONFIG }; // set some defaults if needed
                return this.config;
            }
            throw err;
        }
    }

    async getCategories(): Promise<Category[]> {
        if (this.categories) {
            return this.categories;
        }
        const categories = await fs.readFile(this.categoriesPath, 'utf-8');
        this.categories = yaml.parse(categories);

        return this.categories;
    }

    async getTags(): Promise<Tag[]> {
        try {
            const tags = await fs.readFile(this.tagsPath, 'utf-8');
            return yaml.parse(tags);
        } catch (err) {
            if (err?.code === 'ENOENT') {
                return [];
            }
            throw err;
        }
    }

    async getItems() {
        const items = await fs.readdir(this.dataDir, { withFileTypes: true });
        const promises = items
            .filter((item) => item.isDirectory())
            .map(async (item) => {
                const slug = item.name;
                return this.getItem(slug);
            });

        return Promise.all(promises);
    }

    async getItem(slug: string): Promise<ItemData> {
        const ymlPath = path.join(this.getItemPath(slug), `${slug}.yml`);

        try {
            const content = await fs.readFile(ymlPath, 'utf-8');
            const item = yaml.parse(content);

            return { ...item, slug };
        } catch (err) {
            if (err?.code === 'ENOENT') {
                const yamlPath = path.join(this.getItemPath(slug), `${slug}.yaml`);
                const content = await fs.readFile(yamlPath, 'utf-8');
                const item = yaml.parse(content);

                return { ...item, slug };
            }
            throw err;
        }
    }

    async getMarkdown(slug: string): Promise<string | undefined> {
        const mdPath = path.join(this.getItemPath(slug), `${slug}.md`);
        try {
            const md = await fs.readFile(mdPath, 'utf-8');
            return md;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                return;
            }
            throw err;
        }
    }

    async getLicense(): Promise<string | null> {
        const licensePath = path.join(this.dir, 'LICENSE.md');
        try {
            const license = await fs.readFile(licensePath, 'utf-8');
            return license;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                return null;
            }
            throw err;
        }
    }

    async mergeConfig(config: IDataConfig) {
        const currentConfig = await this.getConfig();
        await this.writeConfig(deepmerge(currentConfig, config));
    }

    async writeConfig(config: IDataConfig) {
        this.config = config;
        const str = yaml.stringify(config);
        await fs.writeFile(this.configPath, str, 'utf-8');
    }

    async writeCategories(categories: Category[]) {
        this.categories = categories;
        const str = yaml.stringify(categories);
        await fs.writeFile(this.categoriesPath, str, 'utf-8');
    }

    async writeTags(tags: Tag[]) {
        const str = yaml.stringify(tags);
        await fs.writeFile(this.tagsPath, str, 'utf-8');
    }

    async createItemDir(item: ItemData) {
        const itemDir = path.join(this.dataDir, item.slug);
        await fs.mkdir(itemDir, { recursive: true });
    }

    async writeMarkdownTemplate(header: string, footer: string) {
        await Promise.all([
            fs.writeFile(path.join(this.markdownTemplatePath, 'header.md'), header, 'utf-8'),
            fs.writeFile(path.join(this.markdownTemplatePath, 'footer.md'), footer, 'utf-8'),
        ]);
    }

    async readMarkdownTemplate() {
        const [header, footer] = await Promise.all([
            fs.readFile(path.join(this.markdownTemplatePath, 'header.md'), 'utf-8'),
            fs.readFile(path.join(this.markdownTemplatePath, 'footer.md'), 'utf-8'),
        ]);
        return { header, footer };
    }

    async writeItem(item: ItemData) {
        const { slug, ...rest } = item; // we don't want to write slug to the file
        const updated_at = format(new Date(), 'yyyy-MM-dd HH:mm');
        const str = yaml.stringify({ ...rest, updated_at });
        const filepath = path.join(this.getItemPath(item.slug), `${item.slug}.yml`);
        await fs.writeFile(filepath, str, 'utf-8');
    }

    async writeItemMarkdown(item: ItemData, markdown: string) {
        const filepath = path.join(this.getItemPath(item.slug), `${item.slug}.md`);
        await fs.writeFile(filepath, markdown, 'utf-8');
    }

    async writeReadme(content: string) {
        const filepath = path.join(this.dir, 'README.md');
        await fs.writeFile(filepath, content, 'utf-8');
    }

    async writeLicense(content: string) {
        const filepath = path.join(this.dir, 'LICENSE.md');
        await fs.writeFile(filepath, content, 'utf-8');
    }

    async removeItem(slug: string): Promise<boolean> {
        const itemPath = this.getItemPath(slug);

        try {
            // Check if item directory exists
            await fs.access(itemPath);

            // Remove the entire item directory
            await fs.rm(itemPath, { recursive: true, force: true });

            return true;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                // Item doesn't exist
                return false;
            }
            throw err;
        }
    }

    async itemExists(slug: string): Promise<boolean> {
        const itemPath = this.getItemPath(slug);

        try {
            await fs.access(itemPath);
            return true;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                return false;
            }
            throw err;
        }
    }
}
