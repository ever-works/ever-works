import * as path from "path";
import * as fs from 'fs/promises';
import * as yaml from 'yaml';
import { Category, ItemData } from "../ai-engine/ai-engine.service";

export interface IDataConfig {
    content_table?: boolean;
    item_name?: string;
    items_name?: string;
}

export const DEFAULT_DATA_CONFIG: IDataConfig = {
    content_table: false,
    item_name: 'Item',
    items_name: 'Items',
};

export class DataRepository {
    private config?: IDataConfig;
    private categories?: Category[];
    private readonly configPath: string;
    private readonly categoriesPath: string;
    public readonly dataDir: string;

    constructor(public readonly dir: string) {
        /*
         *   File structure:
         *      - config.yml
         *      - categories.yml
         *      - data/
         *          - item1.yml
         *          - item1.md?
         *          - item1.mdx?
         *          - item2.yml
         *          - ...
         *          - itemN.yml
         */
        this.configPath = path.join(dir, 'config.yml');
        this.categoriesPath = path.join(dir, 'categories.yml');
        this.dataDir = path.join(dir, 'data');
    }

    async cleanup() {
        await fs.rm(this.dir, { recursive: true, force: true });
    }

    async ensureDirectoriesExist() {
        await fs.mkdir(this.dataDir, { recursive: true });
    }

    async getConfig(): Promise<IDataConfig> {
        if (this.config) {
            return this.config;
        }
        try {
            const config = await fs.readFile(this.configPath, 'utf-8');
            this.config = yaml.parse(config);

            return this.config
        } catch (err) {
            if (err && err.code && err.code === 'ENOENT') {
                this.config = {};   // set some defaults if needed
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

    getCategoryName(id: string): string {
        return this.categories?.find(c => c.id === id)?.name || id;
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

    async writeItem(item: ItemData) {
        const updatedAt = new Date();
        const str = yaml.stringify({ ...item, updated_at: updatedAt.toISOString() });
        const filename = path.join(this.dataDir, `${item.slug}.yml`);
        await fs.writeFile(filename, str, 'utf-8');
    }

    async writeMarkdown(item: ItemData, markdown: string) {
        const filename = path.join(this.dataDir, `${item.slug}.md`);
        await fs.writeFile(filename, markdown, 'utf-8');
    }
}
