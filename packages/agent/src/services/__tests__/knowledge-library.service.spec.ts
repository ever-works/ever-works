import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import {
    KnowledgeLibraryService,
    decodeCursor,
    decodeLibraryCursor,
    encodeCursor,
    encodeLibraryCursor,
    type KnowledgeLibraryActor,
} from '../knowledge-library.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { MemoryFolder, MemoryFolderScope } from '../../entities/memory-folder.entity';
import { KbDocumentClass, KbDocumentSource, KbDocumentStatus } from '../../entities/kb-types';
import { ActivityActionType } from '../../entities/activity-log.types';
import { WorkMemberRole } from '../../entities/types';

const ORG = 'org-1';
const USER = 'user-1';
const WORK_A = 'work-a';
const WORK_B = 'work-b';

const actor = (overrides: Partial<KnowledgeLibraryActor> = {}): KnowledgeLibraryActor => ({
    userId: USER,
    organizationId: ORG,
    canManageOrganization: true,
    ...overrides,
});

function doc(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: 'doc-1',
        workId: WORK_A,
        organizationId: null,
        path: 'freeform/voice.md',
        slug: 'voice',
        title: 'Voice guide',
        description: 'Tone and banned words',
        kbDocumentClass: KbDocumentClass.STYLE,
        tags: ['brand'],
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 10,
        tokenCount: 20,
        source: KbDocumentSource.USER,
        metadata: { body: '# Voice\n\nWarm, direct.' },
        revision: 2,
        revisionAt: new Date('2026-09-01T06:04:00Z'),
        folderId: null,
        archivedAt: null,
        archivedById: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-09-02T00:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

function sharedFolder(overrides: Partial<MemoryFolder> = {}): MemoryFolder {
    return {
        id: 'folder-playbooks',
        userId: USER,
        organizationId: ORG,
        scope: MemoryFolderScope.ORGANIZATION,
        name: 'Playbooks',
        parentId: null,
        path: '/Playbooks',
        ownerAgentId: null,
        syncRepo: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...overrides,
    } as MemoryFolder;
}

describe('KnowledgeLibraryService', () => {
    let documents: Record<string, jest.Mock>;
    let folders: Record<string, jest.Mock>;
    let knowledgeBase: Record<string, jest.Mock>;
    let ownership: Record<string, jest.Mock>;
    let works: { findIdNamesByOrganization: jest.Mock };
    let activityLog: { log: jest.Mock };
    let service: KnowledgeLibraryService;

    beforeEach(() => {
        documents = {
            listForLibrary: jest.fn(async () => ({ items: [], total: 0 })),
            countsForLibrary: jest.fn(async () => ({ byFolder: new Map(), archived: 0 })),
            findInLibraryScope: jest.fn(async () => []),
            setFolder: jest.fn(async (ids: string[]) => ids.length),
            clearFolders: jest.fn(async () => 0),
        };
        folders = {
            listOrganizationFolders: jest.fn(async () => []),
            findOrganizationFolder: jest.fn(async () => null),
            createOrganizationFolder: jest.fn(async () => sharedFolder()),
            renameOrganizationFolder: jest.fn(async () => sharedFolder()),
            moveOrganizationFolder: jest.fn(async () => sharedFolder()),
            deleteOrganizationFolder: jest.fn(async () => ({
                deletedFolders: 1,
                unfiledDocuments: 0,
            })),
        };
        knowledgeBase = {
            archiveDocument: jest.fn(async () => ({})),
            unarchiveDocument: jest.fn(async () => ({ restoredToUnfiled: false, changed: true })),
            archiveOrgDocument: jest.fn(async () => ({})),
            unarchiveOrgDocument: jest.fn(async () => ({
                restoredToUnfiled: false,
                changed: true,
            })),
        };
        ownership = {
            getUserRole: jest.fn(async () => WorkMemberRole.EDITOR),
            ensureCanEdit: jest.fn(async () => ({})),
            ensureCanView: jest.fn(async () => ({})),
        };
        works = {
            findIdNamesByOrganization: jest.fn(async () => [
                { id: WORK_A, name: 'Marketing' },
                { id: WORK_B, name: 'Support' },
            ]),
        };
        activityLog = { log: jest.fn(async () => undefined) };
        service = new KnowledgeLibraryService(
            documents as never,
            folders as never,
            knowledgeBase as never,
            ownership as never,
            works as never,
            activityLog as never,
        );
    });

    describe('list', () => {
        it('scopes to every Work of the Organization plus its own documents, excluding archived by default', async () => {
            await service.list(actor());
            expect(documents.listForLibrary).toHaveBeenCalledWith(
                expect.objectContaining({
                    workIds: [WORK_A, WORK_B],
                    organizationId: ORG,
                    archived: 'exclude',
                    sort: 'recent',
                    limit: 50,
                    offset: 0,
                }),
            );
        });

        it('clamps the page size to 200', async () => {
            await service.list(actor(), { limit: 5000 });
            expect(documents.listForLibrary).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 200 }),
            );
        });

        it('maps the Unfiled filter to a NULL folder', async () => {
            await service.list(actor(), { folderId: 'unfiled' });
            expect(documents.listForLibrary).toHaveBeenCalledWith(
                expect.objectContaining({ folderId: null }),
            );
        });

        it('404s a folder filter that is not one of the Organization’s shared folders', async () => {
            await expect(
                service.list(actor(), { folderId: 'someone-elses' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('narrows to one Work, and returns nothing for a Work outside the Organization', async () => {
            await service.list(actor(), { workId: WORK_B });
            const [options] = documents.listForLibrary.mock.calls[0];
            expect(options.workIds).toEqual([WORK_B]);
            // A Work filter is about Work documents: organization documents drop out.
            expect(options.organizationId).toBeUndefined();
            documents.listForLibrary.mockClear();
            const result = await service.list(actor(), { workId: 'foreign-work' });
            expect(result).toEqual({ documents: [], nextCursor: null, total: 0, unreadCount: 0 });
            expect(documents.listForLibrary).not.toHaveBeenCalled();
        });

        it('shapes rows with folder path, Work name, revision and per-Work edit rights', async () => {
            folders.listOrganizationFolders.mockResolvedValue([sharedFolder()]);
            documents.listForLibrary.mockResolvedValue({
                items: [
                    doc({ id: 'a', workId: WORK_A, folderId: 'folder-playbooks' }),
                    doc({ id: 'b', workId: WORK_B }),
                    doc({ id: 'org', workId: null, organizationId: ORG }),
                ],
                total: 3,
            });
            ownership.getUserRole.mockImplementation(async (workId: string) =>
                workId === WORK_A ? WorkMemberRole.EDITOR : WorkMemberRole.VIEWER,
            );

            const result = await service.list(actor({ canManageOrganization: false }));

            expect(result.documents.map((d) => [d.id, d.canEdit])).toEqual([
                ['a', true],
                ['b', false],
                ['org', false],
            ]);
            expect(result.documents[0]).toMatchObject({
                folderId: 'folder-playbooks',
                folderPath: '/Playbooks',
                workName: 'Marketing',
                revision: 2,
                revisionAt: '2026-09-01T06:04:00.000Z',
                readState: 'read',
                pinnedAt: null,
            });
            // One role lookup per distinct Work, not per row.
            expect(ownership.getUserRole).toHaveBeenCalledTimes(2);
        });

        it('reads a document filed in a folder that no longer exists as Unfiled', async () => {
            documents.listForLibrary.mockResolvedValue({
                items: [doc({ folderId: 'gone' })],
                total: 1,
            });
            const result = await service.list(actor());
            expect(result.documents[0]).toMatchObject({ folderId: null, folderPath: null });
        });

        it('pages with an opaque cursor and stops on the last page', async () => {
            const page = Array.from({ length: 50 }, (_v, i) => doc({ id: `d${i}` }));
            documents.listForLibrary.mockResolvedValue({
                items: page,
                total: 120,
                nextAfter: { sortKey: '2026-09-01 06:04:00.000', id: 'd49' },
            });
            const first = await service.list(actor());
            expect(first.nextCursor).not.toBeNull();
            // A keyset cursor: it names the last row served, not a row count.
            expect(decodeLibraryCursor(first.nextCursor as string, 'recent')).toEqual({
                offset: 0,
                after: { sortKey: '2026-09-01 06:04:00.000', id: 'd49' },
            });

            documents.listForLibrary.mockResolvedValue({
                items: page.slice(0, 20),
                total: 120,
                nextAfter: null,
            });
            const last = await service.list(actor(), { cursor: first.nextCursor as string });
            expect(documents.listForLibrary).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    offset: 0,
                    after: { sortKey: '2026-09-01 06:04:00.000', id: 'd49' },
                }),
            );
            expect(last.nextCursor).toBeNull();
        });

        it('still honours an offset cursor', async () => {
            documents.listForLibrary.mockResolvedValue({ items: [], total: 120, nextAfter: null });
            await service.list(actor(), { cursor: encodeCursor(100) });
            expect(documents.listForLibrary).toHaveBeenLastCalledWith(
                expect.objectContaining({ offset: 100 }),
            );
            const [options] = documents.listForLibrary.mock.calls[0];
            expect(options.after).toBeUndefined();
            expect(decodeCursor(encodeCursor(100))).toBe(100);
        });

        it('rejects a keyset cursor issued for another sort', async () => {
            const cursor = encodeLibraryCursor('title', { sortKey: 'apple', id: 'd1' });
            await expect(service.list(actor(), { cursor, sort: 'recent' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.list(actor(), { cursor, sort: 'title' })).resolves.toBeDefined();
        });

        it('rejects a malformed cursor', async () => {
            await expect(service.list(actor(), { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('tree', () => {
        it('nests folders with depth, direct and subtree counts, and reports no unread yet', async () => {
            folders.listOrganizationFolders.mockResolvedValue([
                sharedFolder({ id: 'p', name: 'Playbooks', path: '/Playbooks' }),
                sharedFolder({
                    id: 's',
                    name: 'Support',
                    path: '/Playbooks/Support',
                    parentId: 'p',
                }),
            ]);
            documents.countsForLibrary.mockResolvedValue({
                byFolder: new Map<string | null, number>([
                    ['p', 10],
                    ['s', 8],
                    [null, 37],
                    ['deleted-folder', 2],
                ]),
                archived: 9,
            });

            const tree = await service.tree(actor());

            expect(tree.folders).toHaveLength(1);
            expect(tree.folders[0]).toMatchObject({
                id: 'p',
                depth: 1,
                documentCount: 10,
                subtreeDocumentCount: 18,
                hasUnread: false,
            });
            expect(tree.folders[0].children[0]).toMatchObject({
                id: 's',
                depth: 2,
                documentCount: 8,
            });
            expect(tree.unfiled).toEqual({ documentCount: 39, hasUnread: false });
            expect(tree).toMatchObject({
                documentCount: 57,
                archivedCount: 9,
                folderCount: 2,
                hasUnread: false,
                canManageFolders: true,
            });
        });
    });

    describe('fileDocuments', () => {
        beforeEach(() => {
            folders.findOrganizationFolder.mockResolvedValue(sharedFolder());
        });

        it('files documents into a shared folder and logs one entry per moved document', async () => {
            documents.findInLibraryScope.mockResolvedValue([
                doc({ id: 'a' }),
                doc({ id: 'b', folderId: 'folder-playbooks' }),
            ]);
            const result = await service.fileDocuments(actor(), {
                documentIds: ['a', 'b'],
                folderId: 'folder-playbooks',
            });
            expect(documents.setFolder).toHaveBeenCalledWith(['a'], 'folder-playbooks');
            expect(result).toEqual({ filed: 1, folderId: 'folder-playbooks' });
            expect(activityLog.log).toHaveBeenCalledTimes(1);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.KB_DOCUMENT_FILED,
                    details: expect.objectContaining({
                        documentId: 'a',
                        fromFolderId: null,
                        toFolderId: 'folder-playbooks',
                    }),
                }),
            );
        });

        it('files 100 documents in one action', async () => {
            const ids = Array.from({ length: 100 }, (_v, i) => `d${i}`);
            documents.findInLibraryScope.mockResolvedValue(ids.map((id) => doc({ id })));
            await expect(
                service.fileDocuments(actor(), { documentIds: ids, folderId: 'folder-playbooks' }),
            ).resolves.toEqual({ filed: 100, folderId: 'folder-playbooks' });
        });

        it('refuses 101 documents with the batch message', async () => {
            const ids = Array.from({ length: 101 }, (_v, i) => `d${i}`);
            await expect(
                service.fileDocuments(actor(), { documentIds: ids, folderId: null }),
            ).rejects.toMatchObject({
                response: { message: 'You can file up to 100 documents at once. 101 selected.' },
            });
            expect(documents.setFolder).not.toHaveBeenCalled();
        });

        it('refuses a folder of another Organization with 422', async () => {
            folders.findOrganizationFolder.mockResolvedValue(null);
            await expect(
                service.fileDocuments(actor(), {
                    documentIds: ['a'],
                    folderId: 'other-org-folder',
                }),
            ).rejects.toBeInstanceOf(UnprocessableEntityException);
        });

        it('404s when any document is outside the library scope', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc({ id: 'a' })]);
            await expect(
                service.fileDocuments(actor(), { documentIds: ['a', 'foreign'], folderId: null }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(documents.setFolder).not.toHaveBeenCalled();
        });

        it('requires edit access to every affected Work', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc({ id: 'a' })]);
            ownership.ensureCanEdit.mockRejectedValue(new ForbiddenException());
            await expect(
                service.fileDocuments(actor(), { documentIds: ['a'], folderId: null }),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(documents.setFolder).not.toHaveBeenCalled();
        });

        it('requires Organization management to file an organization document', async () => {
            documents.findInLibraryScope.mockResolvedValue([
                doc({ id: 'o', workId: null, organizationId: ORG }),
            ]);
            await expect(
                service.fileDocuments(actor({ canManageOrganization: false }), {
                    documentIds: ['o'],
                    folderId: null,
                }),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('rejects an empty selection', async () => {
            await expect(
                service.fileDocuments(actor(), { documentIds: [], folderId: null }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('archive and unarchive', () => {
        it('archives a Work document through the Knowledge Base', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc()]);
            const result = await service.archive(actor(), 'doc-1');
            expect(knowledgeBase.archiveDocument).toHaveBeenCalledWith(WORK_A, 'doc-1', USER);
            expect(result.id).toBe('doc-1');
        });

        it('restores and reports when the document landed in Unfiled', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc()]);
            knowledgeBase.unarchiveDocument.mockResolvedValue({
                restoredToUnfiled: true,
                changed: true,
            });
            const result = await service.unarchive(actor(), 'doc-1');
            expect(knowledgeBase.unarchiveDocument).toHaveBeenCalledWith(WORK_A, 'doc-1', USER);
            expect(result.restoredToUnfiled).toBe(true);
        });

        it('routes an organization document to the organization path, only for managers', async () => {
            documents.findInLibraryScope.mockResolvedValue([
                doc({ workId: null, organizationId: ORG }),
            ]);
            await service.unarchive(actor(), 'doc-1');
            expect(knowledgeBase.unarchiveOrgDocument).toHaveBeenCalledWith(ORG, 'doc-1', USER);

            await expect(
                service.archive(actor({ canManageOrganization: false }), 'doc-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(knowledgeBase.archiveOrgDocument).not.toHaveBeenCalled();
        });

        it('404s a document outside the scope', async () => {
            await expect(service.unarchive(actor(), 'missing')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(service.archive(actor(), 'missing')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('shared folders', () => {
        it('refuses every folder write to someone who cannot manage the Organization', async () => {
            const viewer = actor({ canManageOrganization: false });
            await expect(service.createFolder(viewer, { name: 'X' })).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(service.renameFolder(viewer, 'f', 'X')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(service.moveFolder(viewer, 'f', null)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(service.deleteFolder(viewer, 'f')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(folders.createOrganizationFolder).not.toHaveBeenCalled();
            expect(folders.deleteOrganizationFolder).not.toHaveBeenCalled();
        });

        it('deleting a folder unfiles its documents through the document repository', async () => {
            folders.deleteOrganizationFolder.mockImplementation(
                async (
                    _org: string,
                    _user: string,
                    _id: string,
                    unfile: (ids: string[]) => Promise<number>,
                ) => ({
                    deletedFolders: 2,
                    unfiledDocuments: await unfile(['p', 's']),
                }),
            );
            documents.clearFolders.mockResolvedValue(12);
            const result = await service.deleteFolder(actor(), 'p');
            expect(documents.clearFolders).toHaveBeenCalledWith(['p', 's']);
            expect(result).toEqual({ deletedFolders: 2, unfiledDocuments: 12 });
        });

        it('unfiles through the transaction the folder delete runs in', async () => {
            const manager = { tx: true };
            folders.deleteOrganizationFolder.mockImplementation(
                async (
                    _org: string,
                    _user: string,
                    _id: string,
                    unfile: (ids: string[], manager?: unknown) => Promise<number>,
                ) => ({ deletedFolders: 1, unfiledDocuments: await unfile(['p'], manager) }),
            );
            await service.deleteFolder(actor(), 'p');
            expect(documents.clearFolders).toHaveBeenCalledWith(['p'], manager);
        });
    });

    describe('exportMarkdown', () => {
        it('returns <slug>.md with YAML front matter and logs the export', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc()]);
            const file = await service.exportMarkdown(actor(), 'doc-1');
            expect(file.filename).toBe('voice.md');
            expect(file.content.startsWith('---\ntitle: Voice guide\n')).toBe(true);
            expect(file.content).toContain('work: Marketing');
            expect(file.content).toContain('\n---\n\n# Voice\n\nWarm, direct.\n');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.KB_DOCUMENT_EXPORTED }),
            );
        });

        it('reports a document the person cannot view exactly like a missing one', async () => {
            documents.findInLibraryScope.mockResolvedValue([doc()]);
            ownership.ensureCanView.mockRejectedValue(
                new ForbiddenException('no access to Marketing'),
            );
            const denied = await service
                .exportMarkdown(actor(), 'doc-1')
                .catch((error: unknown) => error);
            documents.findInLibraryScope.mockResolvedValue([]);
            const missing = await service
                .exportMarkdown(actor(), 'doc-1')
                .catch((error: unknown) => error);
            expect(denied).toBeInstanceOf(NotFoundException);
            expect(missing).toBeInstanceOf(NotFoundException);
            expect((denied as NotFoundException).getResponse()).toEqual(
                (missing as NotFoundException).getResponse(),
            );
        });
    });
});
