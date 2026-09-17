// Mock the agent barrels + injected collaborators so this unit spec does
// not pull the TypeORM / storage graph in. Every collaborator arrives
// through the constructor, so the barrels only have to exist. Mirrors
// `works/org-memory.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('../uploads/uploads.service', () => ({ UploadsService: class {} }));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class {},
}));
jest.mock('../scope', () => ({ ScopeContextService: class {} }));
jest.mock('../auth/decorators/user.decorator', () => ({ CurrentUser: () => () => undefined }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemoryFilesController } from './memory-files.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { UploadsService } from '../uploads/uploads.service';
import type { OrganizationMembershipService } from '../organizations/organization-membership.service';
import type { ScopeContextService } from '../scope';
import type {
    KnowledgeBaseService,
    MemoryFilesService,
    MemoryFoldersService,
    MemoryFolderSyncService,
} from '@ever-works/agent/services';
import type {
    UserUploadRepository,
    WorkKnowledgeUploadRepository,
} from '@ever-works/agent/database';

/**
 * `/api/memory/files` — the contracts the service specs cannot pin
 * because they live in the controller: scope-context-only org
 * resolution, upload ordering (folder check BEFORE bytes are stored),
 * the download response posture (active-MIME collapse + header
 * sanitation + per-spine delegation), and unlink-never-deletes.
 */
describe('MemoryFilesController', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;

    let folders: Record<string, jest.Mock>;
    let files: Record<string, jest.Mock>;
    let sync: Record<string, jest.Mock>;
    let kb: Record<string, jest.Mock>;
    let uploads: Record<string, jest.Mock>;
    let userUploads: Record<string, jest.Mock>;
    let kbUploads: Record<string, jest.Mock>;
    let scopeContext: { getOrganizationId: jest.Mock };
    let membership: { ensureMember: jest.Mock };
    let controller: MemoryFilesController;

    /** Minimal Express-response double — records what the route wrote. */
    function makeRes() {
        const headers: Record<string, string | number> = {};
        const res = {
            status: jest.fn(() => res),
            setHeader: jest.fn((name: string, value: string | number) => {
                headers[name] = value;
            }),
            json: jest.fn(),
            send: jest.fn(),
            headers,
        };
        return res;
    }

    beforeEach(() => {
        folders = {
            getTree: jest.fn().mockResolvedValue([]),
            requireOwned: jest.fn().mockResolvedValue({ id: 'f-1' }),
            createFolder: jest.fn().mockResolvedValue({ id: 'f-1' }),
            renameFolder: jest.fn().mockResolvedValue({ id: 'f-1' }),
            moveFolder: jest.fn().mockResolvedValue({ id: 'f-1' }),
            configureSync: jest.fn().mockResolvedValue({ id: 'f-1' }),
            deleteFolder: jest.fn().mockResolvedValue({ deletedFolders: 1, unlinkedFiles: 0 }),
        };
        files = {
            list: jest.fn().mockResolvedValue([]),
            moveFiles: jest.fn().mockResolvedValue({ moved: 1 }),
        };
        sync = { syncFolder: jest.fn().mockResolvedValue({ folderId: 'f-1', results: [] }) };
        kb = {
            getUploadBytes: jest.fn(),
            getOrgUploadBytes: jest.fn(),
        };
        uploads = {
            saveFile: jest.fn().mockResolvedValue({ hash: 'sha-1' }),
            readFile: jest.fn(),
        };
        userUploads = {
            findByIdOwned: jest.fn(),
            setFolderBySha256: jest.fn().mockResolvedValue(true),
        };
        kbUploads = { findForMemoryFiles: jest.fn() };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('o-1') };
        membership = { ensureMember: jest.fn().mockResolvedValue({ id: 'o-1' }) };

        controller = new MemoryFilesController(
            folders as unknown as MemoryFoldersService,
            files as unknown as MemoryFilesService,
            sync as unknown as MemoryFolderSyncService,
            kb as unknown as KnowledgeBaseService,
            uploads as unknown as UploadsService,
            userUploads as unknown as UserUploadRepository,
            kbUploads as unknown as WorkKnowledgeUploadRepository,
            scopeContext as unknown as ScopeContextService,
            membership as unknown as OrganizationMembershipService,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    describe('list', () => {
        it('scopes to the folder being browsed, with the org from the scope context', async () => {
            await controller.list(auth, { folderId: 'f-9' });

            expect(files.list).toHaveBeenCalledWith('u-1', {
                organizationId: 'o-1',
                folderId: 'f-9',
                source: undefined,
                q: undefined,
            });
        });

        it('defaults to the unfiled root when no folder is given', async () => {
            await controller.list(auth, {});

            expect(files.list.mock.calls[0][1]).toMatchObject({ folderId: null });
        });

        it('lets a search span every folder instead of the browsed one', async () => {
            await controller.list(auth, { folderId: 'f-9', q: 'invoice' });

            const opts = files.list.mock.calls[0][1];
            expect(opts.folderId).toBeUndefined();
            expect(opts.q).toBe('invoice');
        });

        it('passes no organization when the session has no active org', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);

            await controller.list(auth, {});

            expect(files.list.mock.calls[0][1].organizationId).toBeUndefined();
        });
    });

    describe('upload', () => {
        const file = { originalname: 'a.txt' } as Express.Multer.File;

        it('rejects a request with no multipart file', async () => {
            await expect(controller.upload(auth, undefined, {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(uploads.saveFile).not.toHaveBeenCalled();
        });

        it('validates folder ownership BEFORE any bytes are stored', async () => {
            folders.requireOwned.mockRejectedValue(new NotFoundException());

            await expect(
                controller.upload(auth, file, { folderId: 'f-other' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(uploads.saveFile).not.toHaveBeenCalled();
        });

        it('files the stored upload into the folder by its content hash', async () => {
            const result = await controller.upload(auth, file, { folderId: 'f-1' });

            expect(userUploads.setFolderBySha256).toHaveBeenCalledWith('u-1', 'sha-1', 'f-1');
            expect(result.folderId).toBe('f-1');
        });

        it('reports the file as unfiled when the folder link could not be written', async () => {
            // `UploadsService` records the ownership row best-effort, so a
            // swallowed failure there leaves nothing to file. Echoing the
            // requested folder here would tell the client the file is in a
            // folder it is not in (and not in the Files area at all).
            userUploads.setFolderBySha256.mockResolvedValue(false);

            const result = await controller.upload(auth, file, { folderId: 'f-1' });

            expect(result.folderId).toBeNull();
        });

        it('leaves an upload unfiled when no folder is given', async () => {
            const result = await controller.upload(auth, file, {});

            expect(folders.requireOwned).not.toHaveBeenCalled();
            expect(userUploads.setFolderBySha256).not.toHaveBeenCalled();
            expect(result.folderId).toBeNull();
        });
    });

    describe('updateFolder', () => {
        it('clears the sync target instead of writing one when both are sent', async () => {
            await controller.updateFolder(auth, 'f-1', {
                clearSyncRepo: true,
                syncRepo: { owner: 'acme', repo: 'docs' },
            });

            expect(folders.configureSync).toHaveBeenCalledWith('u-1', 'f-1', null);
        });

        it('moves to the root when moveToRoot is set', async () => {
            await controller.updateFolder(auth, 'f-1', { moveToRoot: true });

            expect(folders.moveFolder).toHaveBeenCalledWith('u-1', 'f-1', null);
        });
    });

    describe('unlinkFile', () => {
        it('only unfiles the row — bytes are never destroyed in v1', async () => {
            await controller.unlinkFile(auth, 'up-1', { source: 'upload' });

            expect(files.moveFiles).toHaveBeenCalledWith(
                'u-1',
                [{ source: 'upload', id: 'up-1' }],
                null,
                { organizationId: 'o-1' },
            );
        });
    });

    describe('download', () => {
        it('404s a plain upload that is not the caller’s', async () => {
            userUploads.findByIdOwned.mockResolvedValue(null);

            await expect(
                controller.download(auth, 'up-1', { source: 'upload' }, makeRes()),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('serves an owned upload and neutralizes active MIME types', async () => {
            userUploads.findByIdOwned.mockResolvedValue({
                id: 'up-1',
                storagePath: 'u-1/abc.html',
                originalFilename: 'page.html',
                workId: null,
            });
            uploads.readFile.mockResolvedValue({
                buffer: Buffer.from('<script>'),
                mimeType: 'text/html',
            });
            const res = makeRes();

            await controller.download(auth, 'up-1', { source: 'upload' }, res);

            expect(res.headers['Content-Type']).toBe('application/octet-stream');
            expect(res.send).toHaveBeenCalled();
        });

        it('strips quotes and newlines out of the Content-Disposition filename', async () => {
            userUploads.findByIdOwned.mockResolvedValue({
                id: 'up-1',
                storagePath: 'u-1/abc.txt',
                originalFilename: 'evil".txt',
                workId: null,
            });
            uploads.readFile.mockResolvedValue({
                buffer: Buffer.from('x'),
                mimeType: 'text/plain',
            });
            const res = makeRes();

            await controller.download(auth, 'up-1', { source: 'upload' }, res);

            expect(res.headers['Content-Disposition']).toBe('attachment; filename="evil_.txt"');
        });

        it('routes a per-Work KB original through the KB view gate', async () => {
            kbUploads.findForMemoryFiles.mockResolvedValue({ id: 'kb-1', workId: 'w-1' });
            kb.getUploadBytes.mockResolvedValue({
                buffer: Buffer.from('x'),
                mimeType: 'text/plain',
                filename: 'spec.txt',
            });

            await controller.download(auth, 'kb-1', { source: 'kb-upload' }, makeRes());

            expect(kb.getUploadBytes).toHaveBeenCalledWith('w-1', 'kb-1', 'u-1');
            expect(membership.ensureMember).not.toHaveBeenCalled();
        });

        it('asserts org membership before serving an org original', async () => {
            kbUploads.findForMemoryFiles.mockResolvedValue({ id: 'kb-2', workId: null });
            kb.getOrgUploadBytes.mockResolvedValue({
                buffer: Buffer.from('x'),
                mimeType: 'text/plain',
                filename: 'org.txt',
            });

            await controller.download(auth, 'kb-2', { source: 'kb-upload' }, makeRes());

            expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
            expect(kb.getOrgUploadBytes).toHaveBeenCalledWith('o-1', 'kb-2');
        });

        it('404s an org original when the session has no active org', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            kbUploads.findForMemoryFiles.mockResolvedValue({ id: 'kb-2', workId: null });

            await expect(
                controller.download(auth, 'kb-2', { source: 'kb-upload' }, makeRes()),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(kb.getOrgUploadBytes).not.toHaveBeenCalled();
        });
    });

    describe('syncFolder', () => {
        it('hands the sync walk a byte reader bound to the caller and org', async () => {
            userUploads.findByIdOwned.mockResolvedValue({
                id: 'up-1',
                storagePath: 'u-1/abc.txt',
                originalFilename: 'a.txt',
                workId: null,
            });
            uploads.readFile.mockResolvedValue({
                buffer: Buffer.from('bytes'),
                mimeType: 'text/plain',
            });

            await controller.syncFolder(auth, 'f-1');

            const opts = sync.syncFolder.mock.calls[0][2];
            expect(opts.organizationId).toBe('o-1');
            await expect(opts.readBytes({ source: 'upload', id: 'up-1' })).resolves.toEqual(
                Buffer.from('bytes'),
            );
        });
    });
});

/**
 * Shared (organization-scope) folders on the same folder routes.
 *
 * The property that matters most is the one that is easy to break silently:
 * a request with no `scope`, or a folder id that is not a shared folder of
 * the active Organization, takes exactly the per-person path it always took.
 */
describe('MemoryFilesController — shared folders', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;
    const SHARED_ID = '00000000-0000-0000-0000-0000000000f1';
    const PERSONAL_ID = '00000000-0000-0000-0000-0000000000f2';

    let folders: Record<string, jest.Mock>;
    let library: Record<string, jest.Mock>;
    let scopeContext: { getOrganizationId: jest.Mock };
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };

    const build = (withLibrary = true) =>
        new MemoryFilesController(
            folders as unknown as MemoryFoldersService,
            {} as unknown as MemoryFilesService,
            {} as unknown as MemoryFolderSyncService,
            {} as unknown as KnowledgeBaseService,
            {} as unknown as UploadsService,
            {} as unknown as UserUploadRepository,
            {} as unknown as WorkKnowledgeUploadRepository,
            scopeContext as unknown as ScopeContextService,
            membership as unknown as OrganizationMembershipService,
            (withLibrary ? library : undefined) as never,
        );

    beforeEach(() => {
        folders = {
            getTree: jest.fn().mockResolvedValue([{ id: PERSONAL_ID }]),
            createFolder: jest.fn().mockResolvedValue({ id: PERSONAL_ID }),
            renameFolder: jest.fn().mockResolvedValue({ id: PERSONAL_ID }),
            moveFolder: jest.fn().mockResolvedValue({ id: PERSONAL_ID }),
            configureSync: jest.fn().mockResolvedValue({ id: PERSONAL_ID }),
            requireOwned: jest.fn().mockResolvedValue({ id: PERSONAL_ID }),
            deleteFolder: jest.fn().mockResolvedValue({ deletedFolders: 1, unlinkedFiles: 0 }),
            listOrganizationFolders: jest.fn().mockResolvedValue([
                {
                    id: SHARED_ID,
                    name: 'Playbooks',
                    parentId: null,
                    path: '/Playbooks',
                    createdAt: new Date('2026-09-01T00:00:00Z'),
                    updatedAt: new Date('2026-09-01T00:00:00Z'),
                },
            ]),
            findOrganizationFolder: jest.fn(async (_org: string, id: string) =>
                id === SHARED_ID ? { id: SHARED_ID, name: 'Playbooks', path: '/Playbooks' } : null,
            ),
        };
        library = {
            createFolder: jest.fn().mockResolvedValue({ id: SHARED_ID }),
            renameFolder: jest.fn().mockResolvedValue({ id: SHARED_ID, name: 'Guides' }),
            moveFolder: jest.fn().mockResolvedValue({ id: SHARED_ID }),
            deleteFolder: jest.fn().mockResolvedValue({ deletedFolders: 1, unfiledDocuments: 12 }),
        };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('o-1') };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'o-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'o-1' }),
        };
    });

    describe('omitting scope is byte-identical to before', () => {
        it('tree', async () => {
            await expect(build().getTree(auth)).resolves.toEqual({
                folders: [{ id: PERSONAL_ID }],
            });
            expect(folders.listOrganizationFolders).not.toHaveBeenCalled();
        });

        it('create', async () => {
            await build().createFolder(auth, { name: 'Docs' });
            expect(folders.createFolder).toHaveBeenCalledWith('u-1', {
                name: 'Docs',
                parentId: null,
                ownerAgentId: null,
            });
            expect(library.createFolder).not.toHaveBeenCalled();
        });

        it('rename / delete of a personal folder id', async () => {
            const controller = build();
            await controller.updateFolder(auth, PERSONAL_ID, { name: 'Notes' });
            await controller.deleteFolder(auth, PERSONAL_ID, {});
            expect(folders.renameFolder).toHaveBeenCalledWith('u-1', PERSONAL_ID, 'Notes');
            expect(folders.deleteFolder).toHaveBeenCalledWith('u-1', PERSONAL_ID, {
                recursive: false,
            });
            expect(library.renameFolder).not.toHaveBeenCalled();
            expect(library.deleteFolder).not.toHaveBeenCalled();
        });

        it('a deployment without the library never looks for shared folders', async () => {
            await build(false).deleteFolder(auth, SHARED_ID, {});
            expect(folders.findOrganizationFolder).not.toHaveBeenCalled();
            expect(folders.deleteFolder).toHaveBeenCalled();
        });
    });

    describe('scope=organization', () => {
        it('lists the active Organization’s shared folders after asserting membership', async () => {
            const result = await build().getTree(auth, { scope: 'organization' });
            expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
            expect(folders.listOrganizationFolders).toHaveBeenCalledWith('o-1');
            expect(result.folders[0]).toMatchObject({
                id: SHARED_ID,
                path: '/Playbooks',
                fileCount: 0,
            });
            expect(folders.getTree).not.toHaveBeenCalled();
        });

        it('returns no shared folders when there is no active Organization', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            await expect(build().getTree(auth, { scope: 'organization' })).resolves.toEqual({
                folders: [],
            });
            expect(folders.listOrganizationFolders).not.toHaveBeenCalled();
        });

        it('creates a shared folder through the library with the resolved actor', async () => {
            await build().createFolder(auth, { name: 'Playbooks', scope: 'organization' });
            expect(library.createFolder).toHaveBeenCalledWith(
                { userId: 'u-1', organizationId: 'o-1', canManageOrganization: true },
                { name: 'Playbooks', parentId: null },
            );
            expect(folders.createFolder).not.toHaveBeenCalled();
        });

        it('refuses an agent-private shared folder', async () => {
            await expect(
                build().createFolder(auth, {
                    name: 'Playbooks',
                    scope: 'organization',
                    ownerAgentId: '00000000-0000-0000-0000-00000000a9e1',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('reports a refused admin seam to the library as canManageOrganization=false', async () => {
            membership.ensureAdmin.mockRejectedValue(new NotFoundException());
            await build().createFolder(auth, { name: 'X', scope: 'organization' });
            expect(library.createFolder.mock.calls[0][0]).toMatchObject({
                canManageOrganization: false,
            });
        });

        it('404s a shared-folder write from a non-member', async () => {
            membership.ensureMember.mockRejectedValue(new NotFoundException());
            await expect(
                build().createFolder(auth, { name: 'X', scope: 'organization' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(library.createFolder).not.toHaveBeenCalled();
        });

        it('renames and moves a shared folder through the library', async () => {
            await build().updateFolder(auth, SHARED_ID, { name: 'Guides', moveToRoot: true });
            expect(library.renameFolder).toHaveBeenCalledWith(
                expect.anything(),
                SHARED_ID,
                'Guides',
            );
            expect(library.moveFolder).toHaveBeenCalledWith(expect.anything(), SHARED_ID, null);
            expect(folders.renameFolder).not.toHaveBeenCalled();
        });

        it('refuses a git-sync target on a shared folder', async () => {
            await expect(
                build().updateFolder(auth, SHARED_ID, { clearSyncRepo: true }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('deletes a shared folder through the library, which only unfiles its documents', async () => {
            await expect(build().deleteFolder(auth, SHARED_ID, {})).resolves.toEqual({
                deletedFolders: 1,
                unfiledDocuments: 12,
            });
            expect(folders.deleteFolder).not.toHaveBeenCalled();
        });
    });
});
