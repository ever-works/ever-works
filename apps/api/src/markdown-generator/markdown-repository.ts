import * as path from "path";
import * as fs from 'fs/promises';

export class MarkdownRepository {
    private readonly detailsPath: string;

    constructor(public readonly dir: string) {
        /*
         *   File structure:
         *      - README.md
         *      - details/
         *          - item1.md
         *          - item2.md
         *          - ...
         *          - itemN.md
         */
        this.detailsPath = path.join(dir, 'details');
    }

    async cleanup() {
        await fs.rm(this.dir, { recursive: true, force: true });
    }

    async ensureDirectoriesExist() {
        await fs.mkdir(this.detailsPath, { recursive: true });
    }

    async writeReadme(content: string) {
        const filename = path.join(this.dir, 'README.md');
        await fs.writeFile(filename, content, 'utf-8');
    }

    async writeDetails(slug: string, content: string) {
        const filename = path.join(this.detailsPath, `${slug}.md`);
        await fs.writeFile(filename, content, 'utf-8');
    }

    async writeLicense(content: string) {
        const filepath = path.join(this.dir, 'LICENSE.md');
        await fs.writeFile(filepath, content, 'utf-8');
    }
}
