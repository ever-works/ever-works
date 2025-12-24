import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as yaml from 'yaml';
import deepmerge from 'deepmerge';
import { format } from 'date-fns';
import {
    Category,
    CreateItemsGeneratorDto,
    GenerationMethod,
    ItemData,
    Tag,
} from '../items-generator/dto';

export type PRUpdate = {
    branch: string;
    title: string;
    body: string;
    number?: number;
    url?: string;
};

export interface SettingsHeaderConfig {
    submit_enabled?: boolean;
    pricing_enabled?: boolean;
    layout_enabled?: boolean;
    language_enabled?: boolean;
    theme_enabled?: boolean;
    layout_default?: string;
    pagination_default?: string;
    theme_default?: string;
}

export interface SettingsHomepageConfig {
    hero_enabled?: boolean;
    search_enabled?: boolean;
    default_view?: string;
    default_sort?: string;
}

export interface SettingsFooterConfig {
    subscribe_enabled?: boolean;
    version_enabled?: boolean;
    theme_selector_enabled?: boolean;
}

export interface SettingsConfig {
    categories_enabled?: boolean;
    companies_enabled?: boolean;
    tags_enabled?: boolean;
    surveys_enabled?: boolean;
    header?: SettingsHeaderConfig;
    homepage?: SettingsHomepageConfig;
    footer?: SettingsFooterConfig;
}

export interface PaginationConfig {
    type?: string;
    itemsPerPage?: number;
}

export interface IDataConfig {
    company_name?: string;
    company_website?: string;
    content_table?: boolean;
    item_name?: string;
    items_name?: string;
    copyright_year?: number;
    paging_mode?: string;
    autoapproval?: boolean;
    settings?: SettingsConfig;
    pagination?: PaginationConfig;
    metadata?: {
        initial_prompt?: string;
        pr_update?: PRUpdate | null;
        last_request_data?: CreateItemsGeneratorDto;
    } & (Record<string, any> & {});
}

const DEFAULT_SETTINGS: SettingsConfig = {
    categories_enabled: true,
    companies_enabled: true,
    tags_enabled: true,
    surveys_enabled: true,
    header: {
        submit_enabled: true,
        pricing_enabled: true,
        layout_enabled: true,
        language_enabled: true,
        theme_enabled: true,
        layout_default: 'home1',
        pagination_default: 'standard',
        theme_default: 'light',
    },
    homepage: {
        hero_enabled: true,
        search_enabled: true,
        default_view: 'classic',
        default_sort: 'popularity',
    },
    footer: {
        subscribe_enabled: true,
        version_enabled: true,
        theme_selector_enabled: true,
    },
};

const DEFAULT_PAGINATION: PaginationConfig = {
    type: 'standard',
    itemsPerPage: 12,
};

const DEFAULT_DATA_CONFIG: IDataConfig = {
    company_name: 'Acme',
    content_table: true, // Previous value was false
    item_name: 'Item',
    items_name: 'Items',
    paging_mode: 'paging',
    copyright_year: new Date().getFullYear(),
    settings: DEFAULT_SETTINGS,
    pagination: DEFAULT_PAGINATION,
};

const createDefaultConfig = (overrides: Partial<IDataConfig> = {}): IDataConfig =>
    deepmerge(
        {
            ...DEFAULT_DATA_CONFIG,
            // ensure dynamic defaults (like year) are refreshed per call
            copyright_year: new Date().getFullYear(),
        },
        overrides,
    );

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
     * Remove all files except allowlisted ones
     * and ensure all needed directories exist
     */
    async resetFiles() {
        const files = await fs.readdir(this.dir);
        const allowlist = ['.git', '.gitignore', '.github', '.vscode', '.env', '.nvmrc'];

        for (const file of files) {
            if (allowlist.includes(file)) {
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
                const defaultConfig = createDefaultConfig();
                await this.writeConfig(defaultConfig);
                return defaultConfig;
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

                const itemDir = await fs.readdir(this.getItemPath(slug));
                if (itemDir.length === 0) {
                    return null;
                }

                return this.getItem(slug);
            });

        return Promise.all(promises).then((items) => items.filter(Boolean));
    }

    async getItem(slug: string): Promise<ItemData | null> {
        const ymlPath = path.join(this.getItemPath(slug), `${slug}.yml`);

        try {
            const content = await fs.readFile(ymlPath, 'utf-8');
            const item = yaml.parse(content);

            return { ...item, slug };
        } catch (err) {
            if (err?.code === 'ENOENT') {
                const yamlPath = path.join(this.getItemPath(slug), `${slug}.yaml`);
                try {
                    const content = await fs.readFile(yamlPath, 'utf-8');
                    const item = yaml.parse(content);
                    return { ...item, slug };
                } catch (yamlErr) {
                    if (yamlErr?.code === 'ENOENT') {
                        return null;
                    }

                    throw yamlErr;
                }
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

    /**
     * Ensure a config.yml exists; if missing, create it with defaults merged with optional overrides.
     */
    async ensureDefaultConfig(overrides: Partial<IDataConfig> = {}): Promise<IDataConfig> {
        const exists = await this.fileExists(this.configPath);

        if (!exists) {
            const defaultConfig = createDefaultConfig(overrides);
            await this.writeConfig(defaultConfig);
            return defaultConfig;
        }

        return this.getConfig();
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

    async updateItemMetadata(
        slug: string,
        updates: Partial<Pick<ItemData, 'featured' | 'order'>>,
    ): Promise<ItemData | null> {
        const existing = await this.getItem(slug).catch(() => null);
        if (!existing) {
            return null;
        }

        const next: ItemData = {
            ...existing,
            ...updates,
        };

        await this.writeItem({ ...next, slug });
        return next;
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

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                return false;
            }
            throw err;
        }
    }
}
