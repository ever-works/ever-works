import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { MemoryFoldersService } from '../memory-folders.service';
import { MemoryFolder } from '../../entities/memory-folder.entity';

const USER = 'user-1';

function folder(partial: Partial<MemoryFolder>): MemoryFolder {
    return {
        id: 'folder-1',
        userId: USER,
        name: 'Docs',
        parentId: null,
        path: '/Docs',
        ownerAgentId: null,
        syncRepo: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        ...partial,
    } as MemoryFolder;
}

describe('MemoryFoldersService', () => {
    let folders: {
        create: jest.Mock;
        findById: jest.Mock;
        findByPath: jest.Mock;
        listByUser: jest.Mock;
        listSubtree: jest.Mock;
        update: jest.Mock;
        updateSubtreePaths: jest.Mock;
        deleteByIds: jest.Mock;
    };
    let userUploads: { countByFolderIds: jest.Mock; clearFolders: jest.Mock };
    let kbUploads: { countByFolderIds: jest.Mock; clearFolders: jest.Mock };
    let activityLog: { log: jest.Mock };
    let service: MemoryFoldersService;

    beforeEach(() => {
        folders = {
            create: jest.fn(async (input) => folder({ ...input, id: 'created' })),
            findById: jest.fn(async () => null),
            findByPath: jest.fn(async () => null),
            listByUser: jest.fn(async () => []),
            listSubtree: jest.fn(async () => []),
            update: jest.fn(async () => undefined),
            updateSubtreePaths: jest.fn(async () => undefined),
            deleteByIds: jest.fn(async () => undefined),
        };
        userUploads = {
            countByFolderIds: jest.fn(async () => new Map<string, number>()),
            clearFolders: jest.fn(async () => undefined),
        };
        kbUploads = {
            countByFolderIds: jest.fn(async () => new Map<string, number>()),
            clearFolders: jest.fn(async () => undefined),
        };
        activityLog = { log: jest.fn(async () => undefined) };
        service = new MemoryFoldersService(
            folders as never,
            userUploads as never,
            kbUploads as never,
            activityLog as never,
        );
    });

    describe('createFolder (path maintenance + uniqueness)', () => {
        it('creates a top-level folder at /<name>', async () => {
            await service.createFolder(USER, { name: 'Docs' });
            expect(folders.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: USER,
                    name: 'Docs',
                    path: '/Docs',
                    parentId: null,
                }),
            );
        });

        it('materializes the child path under its parent', async () => {
            folders.findById.mockResolvedValueOnce(folder({ id: 'parent', path: '/Docs' }));
            await service.createFolder(USER, { name: 'Q3', parentId: 'parent' });
            expect(folders.create).toHaveBeenCalledWith(
                expect.objectContaining({ path: '/Docs/Q3', parentId: 'parent' }),
            );
        });

        it('rejects a duplicate path per user with 409', async () => {
            folders.findByPath.mockResolvedValueOnce(folder({}));
            await expect(service.createFolder(USER, { name: 'Docs' })).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(folders.create).not.toHaveBeenCalled();
        });

        it('rejects names containing path separators', async () => {
            await expect(service.createFolder(USER, { name: 'a/b' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('404s when the parent belongs to another user (not found)', async () => {
            folders.findById.mockResolvedValueOnce(null);
            await expect(
                service.createFolder(USER, { name: 'X', parentId: 'foreign' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('renameFolder', () => {
        it('rewrites the whole subtree paths and updates the name', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', name: 'Docs', path: '/Docs' }));
            await service.renameFolder(USER, 'f1', 'Notes');
            expect(folders.updateSubtreePaths).toHaveBeenCalledWith(USER, '/Docs', '/Notes');
            expect(folders.update).toHaveBeenCalledWith('f1', { name: 'Notes' });
        });

        it('keeps nested parents intact when renaming a child', async () => {
            folders.findById.mockResolvedValue(
                folder({ id: 'f2', name: 'Q3', path: '/Docs/Q3', parentId: 'f1' }),
            );
            await service.renameFolder(USER, 'f2', 'Q4');
            expect(folders.updateSubtreePaths).toHaveBeenCalledWith(USER, '/Docs/Q3', '/Docs/Q4');
        });

        it('rejects when the new path already exists', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.findByPath.mockResolvedValueOnce(folder({ id: 'other', path: '/Notes' }));
            await expect(service.renameFolder(USER, 'f1', 'Notes')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(folders.updateSubtreePaths).not.toHaveBeenCalled();
        });
    });

    describe('moveFolder (subtree)', () => {
        it('moves a folder under a new parent, rewriting subtree paths', async () => {
            folders.findById.mockImplementation(async (_user: string, id: string) => {
                if (id === 'f1') return folder({ id: 'f1', name: 'Docs', path: '/Docs' });
                if (id === 'archive')
                    return folder({ id: 'archive', name: 'Archive', path: '/Archive' });
                return null;
            });
            await service.moveFolder(USER, 'f1', 'archive');
            expect(folders.updateSubtreePaths).toHaveBeenCalledWith(USER, '/Docs', '/Archive/Docs');
            expect(folders.update).toHaveBeenCalledWith('f1', { parentId: 'archive' });
        });

        it('refuses to move a folder into its own subtree (422)', async () => {
            folders.findById.mockImplementation(async (_user: string, id: string) => {
                if (id === 'f1') return folder({ id: 'f1', name: 'Docs', path: '/Docs' });
                if (id === 'child') return folder({ id: 'child', name: 'Sub', path: '/Docs/Sub' });
                return null;
            });
            await expect(service.moveFolder(USER, 'f1', 'child')).rejects.toBeInstanceOf(
                UnprocessableEntityException,
            );
            expect(folders.updateSubtreePaths).not.toHaveBeenCalled();
        });

        it('refuses to move a folder into itself (422)', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            await expect(service.moveFolder(USER, 'f1', 'f1')).rejects.toBeInstanceOf(
                UnprocessableEntityException,
            );
        });
    });

    describe('deleteFolder (guards)', () => {
        it('refuses (422) a non-recursive delete when the folder holds files', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.listSubtree.mockResolvedValue([folder({ id: 'f1', path: '/Docs' })]);
            userUploads.countByFolderIds.mockResolvedValue(new Map([['f1', 2]]));
            await expect(service.deleteFolder(USER, 'f1')).rejects.toBeInstanceOf(
                UnprocessableEntityException,
            );
            expect(folders.deleteByIds).not.toHaveBeenCalled();
            expect(userUploads.clearFolders).not.toHaveBeenCalled();
        });

        it('refuses (422) a non-recursive delete when the folder has children', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.listSubtree.mockResolvedValue([
                folder({ id: 'f1', path: '/Docs' }),
                folder({ id: 'f2', path: '/Docs/Sub' }),
            ]);
            await expect(service.deleteFolder(USER, 'f1')).rejects.toBeInstanceOf(
                UnprocessableEntityException,
            );
        });

        it('deletes an empty folder without recursive', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.listSubtree.mockResolvedValue([folder({ id: 'f1', path: '/Docs' })]);
            const result = await service.deleteFolder(USER, 'f1');
            expect(result).toEqual({ deletedFolders: 1, unlinkedFiles: 0 });
            expect(folders.deleteByIds).toHaveBeenCalledWith(USER, ['f1']);
        });

        it('recursive delete unlinks files across BOTH spines and drops the subtree', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.listSubtree.mockResolvedValue([
                folder({ id: 'f1', path: '/Docs' }),
                folder({ id: 'f2', path: '/Docs/Sub' }),
            ]);
            userUploads.countByFolderIds.mockResolvedValue(new Map([['f1', 1]]));
            kbUploads.countByFolderIds.mockResolvedValue(new Map([['f2', 2]]));
            const result = await service.deleteFolder(USER, 'f1', { recursive: true });
            expect(result).toEqual({ deletedFolders: 2, unlinkedFiles: 3 });
            expect(userUploads.clearFolders).toHaveBeenCalledWith(USER, ['f1', 'f2']);
            expect(kbUploads.clearFolders).toHaveBeenCalledWith(['f1', 'f2']);
            expect(folders.deleteByIds).toHaveBeenCalledWith(USER, ['f1', 'f2']);
        });
    });

    describe('cross-user access', () => {
        it('requireOwned maps a foreign/missing folder id to 404', async () => {
            folders.findById.mockResolvedValue(null);
            await expect(service.requireOwned(USER, 'foreign')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('activity', () => {
        it('records a create row with the folder path and owner agent', async () => {
            await service.createFolder(USER, { name: 'Docs', ownerAgentId: 'agent-1' });

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: USER,
                    actionType: 'memory_folder_created',
                    details: expect.objectContaining({
                        path: '/Docs',
                        ownerAgentId: 'agent-1',
                    }),
                }),
            );
        });

        it('records a delete row carrying what was dropped and unfiled', async () => {
            folders.findById.mockResolvedValue(folder({ id: 'f1', path: '/Docs' }));
            folders.listSubtree.mockResolvedValue([folder({ id: 'f1', path: '/Docs' })]);
            userUploads.countByFolderIds.mockResolvedValue(new Map([['f1', 2]]));

            await service.deleteFolder(USER, 'f1', { recursive: true });

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'memory_folder_deleted',
                    details: expect.objectContaining({ deletedFolders: 1, unlinkedFiles: 2 }),
                }),
            );
        });

        it('never fails the operation when the activity write throws', async () => {
            activityLog.log.mockRejectedValue(new Error('activity down'));

            await expect(service.createFolder(USER, { name: 'Docs' })).resolves.toMatchObject({
                path: '/Docs',
            });
        });
    });
});
