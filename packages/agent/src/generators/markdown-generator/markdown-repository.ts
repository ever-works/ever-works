import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export class MarkdownRepository {
    private readonly detailsPath: string;

    /**
     * Tracks how many filesystem writes / removes this instance has
     * performed since construction. Surfaced by {@link getWriteCount}
     * so the EW-628 data-repo sync entry can populate the
     * `filesChanged` activity-feed stat without a separate
     * `git diff` call. Reset implicitly because the instance lives
     * for a single sync run.
     */
    private writeCount = 0;

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
     * and ensure all needed works exist
     */
    async resetFiles() {
        const files = await fs.readdir(this.dir);
        const allowlist = ['.git', '.gitignore', '.github', '.vscode', '.env', '.nvmrc'];

        for (const file of files) {
            if (allowlist.includes(file) || file.startsWith('.git')) {
                continue;
            }

            await fs.rm(path.join(this.dir, file), { recursive: true, force: true });
            this.writeCount += 1;
        }

        await this.ensureWorksExist();
    }

    async ensureWorksExist() {
        await fs.mkdir(this.detailsPath, { recursive: true });
    }

    async writeReadme(content: string) {
        const filename = path.join(this.dir, 'README.md');
        await fs.writeFile(filename, content, 'utf-8');
        this.writeCount += 1;
    }

    async writeDetails(slug: string, content: string) {
        const filename = path.join(this.detailsPath, `${slug}.md`);
        await fs.writeFile(filename, content, 'utf-8');
        this.writeCount += 1;
    }

    async removeDetails(slug: string) {
        const filename = path.join(this.detailsPath, `${slug}.md`);
        await fs.rm(filename, { force: true });
        this.writeCount += 1;
    }

    async writeLicense(content: string) {
        const filepath = path.join(this.dir, 'LICENSE.md');
        await fs.writeFile(filepath, content, 'utf-8');
        this.writeCount += 1;
    }

    /**
     * Number of writes (writeReadme / writeDetails / writeLicense /
     * removeDetails / resetFiles entries) this instance has performed.
     * Used by EW-628 `syncFromDataRepo` to populate
     * `DataSyncSuccessStats.filesChanged` so the activity feed renders
     * an accurate count without an extra `git diff` round-trip.
     */
    getWriteCount(): number {
        return this.writeCount;
    }
}
