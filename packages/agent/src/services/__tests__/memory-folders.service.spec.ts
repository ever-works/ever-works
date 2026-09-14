import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { MemoryFoldersService } from '../memory-folders.service';
import { MemoryFolder, MemoryFolderScope } from '../../entities/memory-folder.entity';

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

describe('MemoryFoldersService — shared (organization) folders', () => {
    const ORG = 'org-1';
    const ADMIN = 'user-admin';

    function shared(partial: Partial<MemoryFolder>): MemoryFolder {
        return folder({
            userId: ADMIN,
            organizationId: ORG,
            scope: MemoryFolderScope.ORGANIZATION,
            ...partial,
        });
    }

    let folders: Record<string, jest.Mock>;
    let activityLog: { log: jest.Mock };
    let service: MemoryFoldersService;

    beforeEach(() => {
        folders = {
            create: jest.fn(async (input) => shared({ ...input, id: 'created' })),
            findById: jest.fn(async () => null),
            findByPath: jest.fn(async () => null),
            listByUser: jest.fn(async () => []),
            update: jest.fn(async () => undefined),
            updateSubtreePaths: jest.fn(async () => undefined),
            deleteByIds: jest.fn(async () => undefined),
            findOrganizationFolder: jest.fn(async () => null),
            listByOrganization: jest.fn(async () => []),
            countByOrganization: jest.fn(async () => 0),
            listOrganizationChildren: jest.fn(async () => []),
            listOrganizationSubtree: jest.fn(async () => []),
            updateOrganizationSubtreePaths: jest.fn(async () => undefined),
            deleteOrganizationFoldersByIds: jest.fn(async () => undefined),
        };
        activityLog = { log: jest.fn(async () => undefined) };
        service = new MemoryFoldersService(
            folders as never,
            { countByFolderIds: jest.fn(), clearFolders: jest.fn() } as never,
            { countByFolderIds: jest.fn(), clearFolders: jest.fn() } as never,
            activityLog as never,
        );
    });

    const byId = (...rows: MemoryFolder[]) =>
        folders.findOrganizationFolder.mockImplementation(
            async (_org: string, id: string) => rows.find((row) => row.id === id) ?? null,
        );

    describe('createOrganizationFolder', () => {
        it('creates an organization-scope folder stamped with the Organization', async () => {
            await service.createOrganizationFolder(ORG, ADMIN, { name: 'Playbooks' });
            expect(folders.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: ADMIN,
                    organizationId: ORG,
                    scope: MemoryFolderScope.ORGANIZATION,
                    path: '/Playbooks',
                    parentId: null,
                }),
            );
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'memory_folder_created',
                    details: expect.objectContaining({
                        scope: 'organization',
                        organizationId: ORG,
                    }),
                }),
            );
        });

        it('never touches the per-person lookups', async () => {
            await service.createOrganizationFolder(ORG, ADMIN, { name: 'Playbooks' });
            expect(folders.findById).not.toHaveBeenCalled();
            expect(folders.findByPath).not.toHaveBeenCalled();
        });

        it('allows a folder at depth 5', async () => {
            byId(shared({ id: 'd4', path: '/a/b/c/d' }));
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'e', parentId: 'd4' }),
            ).resolves.toBeDefined();
        });

        it('refuses a folder at depth 6 with the depth message', async () => {
            byId(shared({ id: 'd5', path: '/a/b/c/d/e' }));
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'f', parentId: 'd5' }),
            ).rejects.toMatchObject({
                response: { message: 'Folders can be nested up to 5 levels deep.' },
            });
            expect(folders.create).not.toHaveBeenCalled();
        });

        it('refuses the 501st folder in an Organization', async () => {
            folders.countByOrganization.mockResolvedValue(500);
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'One more' }),
            ).rejects.toBeInstanceOf(UnprocessableEntityException);
            expect(folders.create).not.toHaveBeenCalled();
        });

        it('allows the 500th folder', async () => {
            folders.countByOrganization.mockResolvedValue(499);
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'Last one' }),
            ).resolves.toBeDefined();
        });

        it('refuses a sibling name that differs only by case, quoting the existing name', async () => {
            folders.listOrganizationChildren.mockResolvedValue([
                shared({ id: 's', name: 'Support' }),
            ]);
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'support' }),
            ).rejects.toMatchObject({
                response: { message: 'A folder called "Support" already exists here.' },
            });
        });

        it.each([
            ['empty', '   '],
            ['longer than 120 characters', 'x'.repeat(121)],
        ])('refuses a name that is %s', async (_label, name) => {
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('404s a parent that belongs to another Organization', async () => {
            await expect(
                service.createOrganizationFolder(ORG, ADMIN, { name: 'X', parentId: 'foreign' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('renameOrganizationFolder', () => {
        it('rewrites the subtree paths and logs a rename', async () => {
            byId(shared({ id: 'p', name: 'Playbooks', path: '/Playbooks' }));
            await service.renameOrganizationFolder(ORG, ADMIN, 'p', 'Guides');
            expect(folders.updateOrganizationSubtreePaths).toHaveBeenCalledWith(
                ORG,
                '/Playbooks',
                '/Guides',
            );
            expect(folders.update).toHaveBeenCalledWith('p', { name: 'Guides' });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'memory_folder_renamed',
                    details: expect.objectContaining({ oldPath: '/Playbooks', newPath: '/Guides' }),
                }),
            );
        });

        it('allows a case-only rename of the same folder', async () => {
            byId(shared({ id: 'p', name: 'playbooks', path: '/playbooks' }));
            folders.listOrganizationChildren.mockResolvedValue([
                shared({ id: 'p', name: 'playbooks', path: '/playbooks' }),
            ]);
            await expect(
                service.renameOrganizationFolder(ORG, ADMIN, 'p', 'Playbooks'),
            ).resolves.toBeDefined();
        });

        it('refuses a rename onto a sibling name', async () => {
            byId(shared({ id: 'p', name: 'Playbooks', path: '/Playbooks' }));
            folders.listOrganizationChildren.mockResolvedValue([
                shared({ id: 'p', name: 'Playbooks' }),
                shared({ id: 'r', name: 'Reports', path: '/Reports' }),
            ]);
            await expect(
                service.renameOrganizationFolder(ORG, ADMIN, 'p', 'reports'),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(folders.updateOrganizationSubtreePaths).not.toHaveBeenCalled();
        });
    });

    describe('moveOrganizationFolder', () => {
        it('refuses a move into the folder subtree with the exact message', async () => {
            byId(
                shared({ id: 'p', name: 'Playbooks', path: '/Playbooks' }),
                shared({ id: 's', name: 'Support', path: '/Playbooks/Support', parentId: 'p' }),
            );
            await expect(
                service.moveOrganizationFolder(ORG, ADMIN, 'p', 's'),
            ).rejects.toMatchObject({
                response: { message: 'A folder cannot be moved inside itself.' },
            });
            expect(folders.updateOrganizationSubtreePaths).not.toHaveBeenCalled();
        });

        it('refuses a move into itself', async () => {
            byId(shared({ id: 'p', name: 'Playbooks', path: '/Playbooks' }));
            await expect(
                service.moveOrganizationFolder(ORG, ADMIN, 'p', 'p'),
            ).rejects.toBeInstanceOf(UnprocessableEntityException);
        });

        it('refuses a move that would push a descendant past depth 5', async () => {
            byId(
                shared({ id: 'p', name: 'p', path: '/p' }),
                shared({ id: 'deep', name: 'd', path: '/x/y/z/d' }),
            );
            // `/p` reaches two levels down (/p/q/r); under /x/y/z/d that is depth 7.
            folders.listOrganizationSubtree.mockResolvedValue([
                shared({ id: 'p', path: '/p' }),
                shared({ id: 'q', path: '/p/q' }),
                shared({ id: 'r', path: '/p/q/r' }),
            ]);
            await expect(
                service.moveOrganizationFolder(ORG, ADMIN, 'p', 'deep'),
            ).rejects.toMatchObject({
                response: { code: 'FolderDepthLimit' },
            });
        });

        it('moves a folder under a new parent, rewriting subtree paths', async () => {
            byId(
                shared({ id: 'p', name: 'Support', path: '/Support' }),
                shared({ id: 'pb', name: 'Playbooks', path: '/Playbooks' }),
            );
            folders.listOrganizationSubtree.mockResolvedValue([
                shared({ id: 'p', path: '/Support' }),
            ]);
            await service.moveOrganizationFolder(ORG, ADMIN, 'p', 'pb');
            expect(folders.updateOrganizationSubtreePaths).toHaveBeenCalledWith(
                ORG,
                '/Support',
                '/Playbooks/Support',
            );
            expect(folders.update).toHaveBeenCalledWith('p', { parentId: 'pb' });
        });
    });

    describe('deleteOrganizationFolder', () => {
        it('unfiles the whole subtree BEFORE deleting the folders, and deletes no document', async () => {
            byId(shared({ id: 'p', path: '/Playbooks' }));
            folders.listOrganizationSubtree.mockResolvedValue([
                shared({ id: 'p', path: '/Playbooks' }),
                shared({ id: 's', path: '/Playbooks/Support' }),
            ]);
            const order: string[] = [];
            const unfile = jest.fn(async (ids: string[]) => {
                order.push(`unfile:${ids.join(',')}`);
                return 12;
            });
            folders.deleteOrganizationFoldersByIds.mockImplementation(async () => {
                order.push('delete');
            });

            const result = await service.deleteOrganizationFolder(ORG, ADMIN, 'p', unfile);

            expect(order).toEqual(['unfile:p,s', 'delete']);
            expect(result).toEqual({ deletedFolders: 2, unfiledDocuments: 12 });
            expect(folders.deleteOrganizationFoldersByIds).toHaveBeenCalledWith(ORG, ['p', 's']);
        });

        it('404s a folder of another Organization and unfiles nothing', async () => {
            const unfile = jest.fn();
            await expect(
                service.deleteOrganizationFolder(ORG, ADMIN, 'foreign', unfile),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(unfile).not.toHaveBeenCalled();
        });
    });
});
