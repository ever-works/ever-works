import * as path from 'node:path';
import * as fs from 'node:fs/promises';

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

    /**
     * Remove all files except allowlisted ones
     * and ensure all needed directories exist
     */
    async resetFiles() {
        const files = await fs.readdir(this.dir);
        const allowlist = ['.git', '.gitignore', '.github', '.vscode', '.env', '.nvmrc'];

        for (const file of files) {
            if (allowlist.includes(file) || file.startsWith('.git')) {
                continue;
            }

            await fs.rm(path.join(this.dir, file), { recursive: true, force: true });
        }

        await this.ensureDirectoriesExist();
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

    async removeDetails(slug: string) {
        const filename = path.join(this.detailsPath, `${slug}.md`);
        await fs.rm(filename, { force: true });
    }

    async writeLicense(content: string) {
        const filepath = path.join(this.dir, 'LICENSE.md');
        await fs.writeFile(filepath, content, 'utf-8');
    }
}
