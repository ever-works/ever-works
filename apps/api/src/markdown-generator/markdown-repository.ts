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

    async copyMarkdownFromData(sourceDir: string, filename: string) {
        const sourcePath = path.join(sourceDir, filename);
        const targetPath = path.join(this.detailsPath, filename);
        const content = await fs.readFile(sourcePath, 'utf-8');
        await fs.writeFile(targetPath, content, 'utf-8');
    }
}
