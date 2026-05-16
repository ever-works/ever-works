import { MarkdownRepository } from './markdown-repository';
import * as path from 'node:path';

jest.mock('node:fs/promises', () => ({
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
}));

const fsMock = jest.requireMock('node:fs/promises') as {
    rm: jest.Mock;
    readdir: jest.Mock;
    mkdir: jest.Mock;
    writeFile: jest.Mock;
};

describe('MarkdownRepository', () => {
    const dir = path.join('/tmp', 'work');
    const detailsDir = path.join(dir, 'details');

    beforeEach(() => {
        jest.clearAllMocks();
        fsMock.rm.mockResolvedValue(undefined);
        fsMock.readdir.mockResolvedValue([]);
        fsMock.mkdir.mockResolvedValue(undefined);
        fsMock.writeFile.mockResolvedValue(undefined);
    });

    describe('cleanup', () => {
        it('rms the entire dir recursive+force', async () => {
            await new MarkdownRepository(dir).cleanup();
            expect(fsMock.rm).toHaveBeenCalledTimes(1);
            expect(fsMock.rm).toHaveBeenCalledWith(dir, { recursive: true, force: true });
        });
    });

    describe('resetFiles', () => {
        it('removes every non-allowlisted entry then ensures details/ exists', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                'README.md',
                'old-cache',
                'details',
                'random.txt',
            ] as any);

            await new MarkdownRepository(dir).resetFiles();

            const removed = fsMock.rm.mock.calls.map((c) => c[0]);
            expect(removed).toEqual([
                path.join(dir, 'README.md'),
                path.join(dir, 'old-cache'),
                path.join(dir, 'details'),
                path.join(dir, 'random.txt'),
            ]);
            for (const call of fsMock.rm.mock.calls) {
                expect(call[1]).toEqual({ recursive: true, force: true });
            }
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('preserves the standard allowlist + every dotfile starting with ".git"', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                '.git',
                '.gitignore',
                '.github',
                '.vscode',
                '.env',
                '.nvmrc',
                '.gitattributes', // covered by `.git*` startsWith branch
                '.gitkeep', // covered by `.git*` startsWith branch
                'something.md',
            ] as any);

            await new MarkdownRepository(dir).resetFiles();

            // Only `something.md` should be removed.
            expect(fsMock.rm).toHaveBeenCalledTimes(1);
            expect(fsMock.rm).toHaveBeenCalledWith(path.join(dir, 'something.md'), {
                recursive: true,
                force: true,
            });
            // Still calls mkdir at the end via ensureWorksExist().
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('still ensures details/ exists when readdir returns an empty list', async () => {
            fsMock.readdir.mockResolvedValueOnce([] as any);

            await new MarkdownRepository(dir).resetFiles();

            expect(fsMock.rm).not.toHaveBeenCalled();
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('propagates readdir failure (no mkdir, no rm)', async () => {
            fsMock.readdir.mockRejectedValueOnce(new Error('ENOENT'));

            await expect(new MarkdownRepository(dir).resetFiles()).rejects.toThrow('ENOENT');
            expect(fsMock.rm).not.toHaveBeenCalled();
            expect(fsMock.mkdir).not.toHaveBeenCalled();
        });

        it('removes entries sequentially in directory-listing order (await per iteration)', async () => {
            fsMock.readdir.mockResolvedValueOnce(['a', 'b', 'c'] as any);
            const order: string[] = [];
            fsMock.rm.mockImplementation(async (target: string) => {
                order.push(target);
            });

            await new MarkdownRepository(dir).resetFiles();

            expect(order).toEqual([path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'c')]);
        });
    });

    describe('ensureWorksExist', () => {
        it('mkdirs the details/ subdir recursively', async () => {
            await new MarkdownRepository(dir).ensureWorksExist();
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });
    });

    describe('writeReadme', () => {
        it('writes README.md at the root with utf-8', async () => {
            await new MarkdownRepository(dir).writeReadme('# Hello');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(dir, 'README.md'),
                '# Hello',
                'utf-8',
            );
        });
    });

    describe('writeDetails / removeDetails', () => {
        it('writes details/<slug>.md with utf-8', async () => {
            await new MarkdownRepository(dir).writeDetails('cool-thing', '# Cool');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(detailsDir, 'cool-thing.md'),
                '# Cool',
                'utf-8',
            );
        });

        it('rms the per-slug detail file with force only (NOT recursive)', async () => {
            await new MarkdownRepository(dir).removeDetails('gone');
            expect(fsMock.rm).toHaveBeenCalledWith(path.join(detailsDir, 'gone.md'), {
                force: true,
            });
            // Note: explicitly NOT recursive — files only.
        });
    });

    describe('writeLicense', () => {
        it('writes LICENSE.md at the root with utf-8', async () => {
            await new MarkdownRepository(dir).writeLicense('MIT');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(dir, 'LICENSE.md'),
                'MIT',
                'utf-8',
            );
        });
    });

    describe('contracts', () => {
        it('exposes the input dir as a public readonly property', () => {
            const repo = new MarkdownRepository(dir);
            expect(repo.dir).toBe(dir);
        });

        it('builds the details/ path from the constructor dir argument', async () => {
            const customDir = path.join('/srv', 'data');
            await new MarkdownRepository(customDir).writeDetails('s', 'x');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(customDir, 'details', 's.md'),
                'x',
                'utf-8',
            );
        });
    });

    // EW-628 G5 — `syncFromDataRepo` reads `getWriteCount()` to populate the
    // `filesChanged` activity-row stat. The counter must accumulate across
    // every writing method and be observable without a real fs round-trip.
    describe('getWriteCount (EW-628 G5)', () => {
        it('starts at zero', () => {
            expect(new MarkdownRepository(dir).getWriteCount()).toBe(0);
        });

        it('increments once per writeReadme / writeDetails / writeLicense / removeDetails', async () => {
            const repo = new MarkdownRepository(dir);
            await repo.writeReadme('a');
            await repo.writeDetails('s1', 'b');
            await repo.writeDetails('s2', 'c');
            await repo.writeLicense('mit');
            await repo.removeDetails('s1');
            expect(repo.getWriteCount()).toBe(5);
        });

        it('increments once per non-allowlisted entry inside resetFiles()', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                '.git', // allowlisted
                'README.md', // counts
                'old', // counts
            ] as unknown as string[]);
            const repo = new MarkdownRepository(dir);
            await repo.resetFiles();
            expect(repo.getWriteCount()).toBe(2);
        });

        it('persists the running total across mixed calls in a single sync run', async () => {
            fsMock.readdir.mockResolvedValueOnce(['old.md'] as unknown as string[]);
            const repo = new MarkdownRepository(dir);
            await repo.resetFiles(); // +1
            await repo.writeReadme('readme'); // +1
            await repo.writeDetails('s', 'details'); // +1
            expect(repo.getWriteCount()).toBe(3);
        });
    });
});
