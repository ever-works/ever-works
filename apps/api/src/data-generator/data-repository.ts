import * as path from "path";
import * as fs from 'fs/promises';
import * as yaml from 'yaml';
import { Category, ItemData } from "../ai-engine/ai-engine.service";
import { format } from "date-fns";

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
    private readonly markdownTemplatePath: string;
    public readonly dataDir: string;

    constructor(public readonly dir: string) {
        /*
         *   File structure:
         *      - config.yml
         *      - categories.yml
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
        this.configPath = path.join(dir, 'config.yml');
        this.categoriesPath = path.join(dir, 'categories.yml');
        this.markdownTemplatePath = path.join(dir, 'markdown');
        this.dataDir = path.join(dir, 'data');
    }

    private getItemPath(slug: string) {
        return path.join(this.dataDir, slug);
    }

    async cleanup() {
        await fs.rm(this.dir, { recursive: true, force: true });
    }

    async ensureDirectoriesExist() {
        await Promise.all([
            fs.mkdir(this.markdownTemplatePath, { recursive: true }),
            fs.mkdir(this.dataDir, { recursive: true })
        ]);
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
        const updated_at = format(new Date(), "yyyy-MM-dd HH:mm");
        const str = yaml.stringify({ ...rest, updated_at });
        const filepath = path.join(this.getItemPath(item.slug), `${item.slug}.yml`);
        await fs.writeFile(filepath, str, 'utf-8');
    }

    async writeItemMarkdown(item: ItemData, markdown: string) {
        const filepath = path.join(this.getItemPath(item.slug), `${item.slug}.md`);
        await fs.writeFile(filepath, markdown, 'utf-8');
    }
}
