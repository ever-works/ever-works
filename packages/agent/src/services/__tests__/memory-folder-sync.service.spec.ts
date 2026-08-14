import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnprocessableEntityException } from '@nestjs/common';
import { MemoryFolderSyncService, SYNC_MAX_FILE_BYTES } from '../memory-folder-sync.service';
import type { MemoryFileRow } from '../memory-files.service';

const USER = 'user-1';

function folder(partial: Record<string, unknown> = {}) {
    return {
        id: 'f1',
        userId: USER,
        name: 'Docs',
        parentId: null,
        path: '/Docs',
        ownerAgentId: null,
        syncRepo: { owner: 'acme', repo: 'notes', dirPrefix: 'memory' },
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partial,
    };
}

function fileRow(partial: Partial<MemoryFileRow> = {}): MemoryFileRow {
    return {
        id: 'up-1',
        source: 'upload',
        filename: 'a.md',
        mime: 'text/markdown',
        size: 10,
        folderId: 'f1',
        ownerAgentId: null,
        provenance: { chat: true },
        updatedAt: new Date().toISOString(),
        ...partial,
    };
}

describe('MemoryFolderSyncService', () => {
    let tmpDir: string;
    let gitFacade: {
        cloneOrPull: jest.Mock;
        addAll: jest.Mock;
        getStatus: jest.Mock;
        commit: jest.Mock;
        push: jest.Mock;
        getCommitter: jest.Mock;
    };
    let folderRepo: { listSubtree: jest.Mock };
    let foldersService: { requireOwned: jest.Mock };
    let filesService: { list: jest.Mock };
    let service: MemoryFolderSyncService;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-sync-'));
        gitFacade = {
            cloneOrPull: jest.fn(async () => tmpDir),
            addAll: jest.fn(async () => undefined),
            getStatus: jest.fn(async () => [{ path: 'memory/a.md', status: 'added' }]),
            commit: jest.fn(async () => 'sha-123'),
            push: jest.fn(async () => undefined),
            getCommitter: jest.fn(async () => ({ name: 'Tester', email: 't@example.com' })),
        };
        folderRepo = { listSubtree: jest.fn(async () => [folder()]) };
        foldersService = { requireOwned: jest.fn(async () => folder()) };
        filesService = { list: jest.fn(async () => []) };
        service = new MemoryFolderSyncService(
            gitFacade as never,
            folderRepo as never,
            foldersService as never,
            filesService as never,
        );
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('refuses (422) when the folder has no syncRepo configured', async () => {
        foldersService.requireOwned.mockResolvedValue(folder({ syncRepo: null }));
        await expect(
            service.syncFolder(USER, 'f1', { readBytes: async () => Buffer.from('x') }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(gitFacade.cloneOrPull).not.toHaveBeenCalled();
    });

    it('commits the subtree files at their folder-relative paths under dirPrefix', async () => {
        folderRepo.listSubtree.mockResolvedValue([
            folder(),
            folder({ id: 'f2', name: 'Sub', path: '/Docs/Sub', parentId: 'f1' }),
        ]);
        filesService.list.mockImplementation(async (_user: string, opts: { folderId: string }) => {
            if (opts.folderId === 'f1') return [fileRow({ id: 'up-1', filename: 'a.md' })];
            if (opts.folderId === 'f2') return [fileRow({ id: 'up-2', filename: 'b.md' })];
            return [];
        });
        const readBytes = jest.fn(async (row: MemoryFileRow) =>
            Buffer.from(`content of ${row.filename}`),
        );

        const report = await service.syncFolder(USER, 'f1', { readBytes });

        // Files land where the report says they do.
        const a = await fs.readFile(path.join(tmpDir, 'memory', 'a.md'), 'utf-8');
        const b = await fs.readFile(path.join(tmpDir, 'memory', 'Sub', 'b.md'), 'utf-8');
        expect(a).toBe('content of a.md');
        expect(b).toBe('content of b.md');

        expect(report.commitSha).toBe('sha-123');
        expect(report.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'up-1',
                    status: 'committed',
                    repoPath: 'memory/a.md',
                }),
                expect.objectContaining({
                    id: 'up-2',
                    status: 'committed',
                    repoPath: 'memory/Sub/b.md',
                }),
            ]),
        );
        expect(gitFacade.cloneOrPull).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'acme', repo: 'notes' }),
            { providerId: 'github', userId: USER },
        );
        expect(gitFacade.commit).toHaveBeenCalledWith(
            'github',
            tmpDir,
            expect.stringContaining('/Docs'),
            { name: 'Tester', email: 't@example.com' },
        );
        expect(gitFacade.push).toHaveBeenCalledWith({ dir: tmpDir }, expect.any(Object));
    });

    it('skips files over the size cap and reports them, without reading bytes', async () => {
        filesService.list.mockResolvedValue([
            fileRow({ id: 'big', filename: 'big.zip', size: SYNC_MAX_FILE_BYTES + 1 }),
            fileRow({ id: 'small', filename: 'small.md', size: 4 }),
        ]);
        const readBytes = jest.fn(async () => Buffer.from('ok'));

        const report = await service.syncFolder(USER, 'f1', { readBytes });

        expect(report.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'big', status: 'skipped-too-large' }),
                expect.objectContaining({ id: 'small', status: 'committed' }),
            ]),
        );
        expect(readBytes).toHaveBeenCalledTimes(1);
        expect(readBytes).toHaveBeenCalledWith(expect.objectContaining({ id: 'small' }));
    });

    it('marks a file failed when its bytes cannot be read, but still commits the rest', async () => {
        filesService.list.mockResolvedValue([
            fileRow({ id: 'bad', filename: 'bad.md' }),
            fileRow({ id: 'good', filename: 'good.md' }),
        ]);
        const readBytes = jest.fn(async (row: MemoryFileRow) => {
            if (row.id === 'bad') throw new Error('storage exploded');
            return Buffer.from('fine');
        });

        const report = await service.syncFolder(USER, 'f1', { readBytes });

        expect(report.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'bad',
                    status: 'failed',
                    reason: 'storage exploded',
                }),
                expect.objectContaining({ id: 'good', status: 'committed' }),
            ]),
        );
        expect(report.commitSha).toBe('sha-123');
    });

    it('does not touch git at all for an empty folder', async () => {
        filesService.list.mockResolvedValue([]);
        const report = await service.syncFolder(USER, 'f1', {
            readBytes: async () => Buffer.from(''),
        });
        expect(report.commitSha).toBeNull();
        expect(report.results).toEqual([]);
        expect(gitFacade.cloneOrPull).not.toHaveBeenCalled();
    });

    it('resolves owner/repo from a github repoUrl when not given explicitly', async () => {
        foldersService.requireOwned.mockResolvedValue(
            folder({ syncRepo: { repoUrl: 'https://github.com/acme/wiki.git' } }),
        );
        filesService.list.mockResolvedValue([fileRow()]);
        await service.syncFolder(USER, 'f1', { readBytes: async () => Buffer.from('x') });
        expect(gitFacade.cloneOrPull).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'acme', repo: 'wiki' }),
            expect.any(Object),
        );
    });
});
