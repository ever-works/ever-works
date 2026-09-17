// Mock the agent barrels + injected collaborators so this unit spec does not
// pull in the TypeORM / service graph. Every collaborator arrives through the
// constructor, so the barrels only have to exist. Mirrors
// `works/org-memory.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({ KnowledgeLibraryService: class {} }));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class {},
}));
jest.mock('../scope', () => ({ ScopeContextService: class {} }));
jest.mock('../auth/decorators/user.decorator', () => ({ CurrentUser: () => () => undefined }));

import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { KnowledgeLibraryService } from '@ever-works/agent/services';
import type { OrganizationMembershipService } from '../organizations/organization-membership.service';
import type { ScopeContextService } from '../scope';
import { KnowledgeLibraryController } from './knowledge-library.controller';
import {
    ExportKnowledgeDocumentQueryDto,
    FileKnowledgeDocumentsDto,
    KnowledgeLibraryQueryDto,
} from './dto/knowledge-library.dto';

const DOC_ID = '6f1c2a4e-3b7d-4c9a-8e21-0000000000d1';
const FOLDER_ID = '6f1c2a4e-3b7d-4c9a-8e21-0000000000f1';

async function errorsOf<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
    const instance = plainToInstance(cls, plain);
    const errors = await validate(instance);
    return errors.map((error) => error.property);
}

/**
 * `/api/knowledge` — the contracts that live in the controller: the
 * Organization comes from the scope context (never a param), membership is
 * asserted before every read or write, an org-less session gets an empty
 * shelf instead of a scan, and the per-route validation and throttles.
 */
describe('KnowledgeLibraryController', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;

    let library: Record<string, jest.Mock>;
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let scopeContext: { getOrganizationId: jest.Mock };
    let controller: KnowledgeLibraryController;

    beforeEach(() => {
        library = {
            list: jest
                .fn()
                .mockResolvedValue({ documents: [], nextCursor: null, total: 0, unreadCount: 0 }),
            tree: jest.fn().mockResolvedValue({ folders: [] }),
            getDocument: jest.fn().mockResolvedValue({ id: DOC_ID, folderPath: '/Playbooks' }),
            fileDocuments: jest.fn().mockResolvedValue({ filed: 1, folderId: FOLDER_ID }),
            archive: jest.fn().mockResolvedValue({ id: DOC_ID }),
            unarchive: jest
                .fn()
                .mockResolvedValue({ document: { id: DOC_ID }, restoredToUnfiled: false }),
            exportMarkdown: jest.fn().mockResolvedValue({
                filename: 'voice.md',
                content: '---\ntitle: Voice\n---\n\nBody\n',
            }),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'o-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'o-1' }),
        };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('o-1') };
        controller = new KnowledgeLibraryController(
            library as unknown as KnowledgeLibraryService,
            membership as unknown as OrganizationMembershipService,
            scopeContext as unknown as ScopeContextService,
        );
    });

    describe('routing', () => {
        it('lives under api/knowledge and never opts out of the global session guard', () => {
            expect(Reflect.getMetadata(PATH_METADATA, KnowledgeLibraryController)).toBe(
                'api/knowledge',
            );
            // Authentication is the app-wide session guard; a controller-level
            // guard would need the auth provider wired into this module.
            expect(
                Reflect.getMetadata(GUARDS_METADATA, KnowledgeLibraryController),
            ).toBeUndefined();
            expect(Reflect.getMetadata('isPublic', KnowledgeLibraryController)).toBeUndefined();
            for (const method of [
                'list',
                'tree',
                'get',
                'file',
                'archive',
                'unarchive',
                'export',
            ] as const) {
                expect(
                    Reflect.getMetadata('isPublic', KnowledgeLibraryController.prototype[method]),
                ).toBeUndefined();
            }
        });

        it.each([
            ['list', 'library', RequestMethod.GET],
            ['tree', 'tree', RequestMethod.GET],
            ['get', 'documents/:docId', RequestMethod.GET],
            ['file', 'documents/file', RequestMethod.PATCH],
            ['archive', 'documents/:docId/archive', RequestMethod.POST],
            ['unarchive', 'documents/:docId/unarchive', RequestMethod.POST],
            ['export', 'documents/:docId/export', RequestMethod.GET],
        ] as const)('%s → %s', (method, path, verb) => {
            const handler = KnowledgeLibraryController.prototype[method];
            expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
            expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
        });

        it.each([
            ['file', 60],
            ['archive', 60],
            ['unarchive', 60],
            ['export', 10],
        ] as const)('%s is throttled to %i requests per minute', (method, limit) => {
            const handler = KnowledgeLibraryController.prototype[method];
            expect(Reflect.getMetadata('THROTTLER:LIMITlong', handler)).toBe(limit);
            expect(Reflect.getMetadata('THROTTLER:TTLlong', handler)).toBe(60_000);
        });
    });

    describe('scope and membership', () => {
        it('lists with the Organization from the scope context after asserting membership', async () => {
            await controller.list(auth, { folderId: 'unfiled', class: ['style'], sort: 'title' });
            expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
            expect(library.list).toHaveBeenCalledWith(
                { userId: 'u-1', organizationId: 'o-1', canManageOrganization: true },
                expect.objectContaining({ folderId: 'unfiled', classes: ['style'], sort: 'title' }),
            );
        });

        it('returns an empty shelf and tree, without any read, when there is no active Organization', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            await expect(controller.list(auth, {})).resolves.toEqual({
                documents: [],
                nextCursor: null,
                total: 0,
                unreadCount: 0,
            });
            await expect(controller.tree(auth)).resolves.toMatchObject({
                folders: [],
                canManageFolders: false,
            });
            expect(library.list).not.toHaveBeenCalled();
            expect(library.tree).not.toHaveBeenCalled();
            expect(membership.ensureMember).not.toHaveBeenCalled();
        });

        it('refuses a non-member with 404 before touching the library', async () => {
            membership.ensureMember.mockRejectedValue(
                new NotFoundException('Organization o-1 not found'),
            );
            await expect(controller.tree(auth)).rejects.toBeInstanceOf(NotFoundException);
            await expect(
                controller.file(auth, { documentIds: [DOC_ID], folderId: null }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(library.tree).not.toHaveBeenCalled();
            expect(library.fileDocuments).not.toHaveBeenCalled();
        });

        it('passes canManageOrganization=false when the admin seam refuses', async () => {
            membership.ensureAdmin.mockRejectedValue(new NotFoundException());
            await controller.archive(auth, DOC_ID);
            expect(library.archive).toHaveBeenCalledWith(
                expect.objectContaining({ canManageOrganization: false }),
                DOC_ID,
            );
        });

        it('reads one document as a shelf row for the Organization in scope', async () => {
            await expect(controller.get(auth, DOC_ID)).resolves.toMatchObject({
                id: DOC_ID,
                folderPath: '/Playbooks',
            });
            expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
            expect(library.getDocument).toHaveBeenCalledWith(
                { userId: 'u-1', organizationId: 'o-1', canManageOrganization: true },
                DOC_ID,
            );
        });

        it('404s a single-document read when there is no active Organization', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            await expect(controller.get(auth, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
            expect(library.getDocument).not.toHaveBeenCalled();
        });

        it('404s a write when there is no active Organization', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            await expect(controller.unarchive(auth, DOC_ID)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(library.unarchive).not.toHaveBeenCalled();
        });
    });

    describe('export', () => {
        it('serves the Markdown as an attachment named after the slug', async () => {
            const headers: Record<string, string | number> = {};
            const res = {
                setHeader: jest.fn((name: string, value: string | number) => {
                    headers[name] = value;
                }),
                send: jest.fn(),
            };
            await controller.export(auth, DOC_ID, {}, res);
            expect(headers['Content-Type']).toBe('text/markdown; charset=utf-8');
            expect(headers['Content-Disposition']).toBe('attachment; filename="voice.md"');
            expect(res.send).toHaveBeenCalledWith(
                Buffer.from('---\ntitle: Voice\n---\n\nBody\n', 'utf8'),
            );
        });
    });

    describe('validation', () => {
        it('accepts a folder id or "unfiled" as the folder filter, and nothing else', async () => {
            expect(await errorsOf(KnowledgeLibraryQueryDto, { folderId: FOLDER_ID })).toEqual([]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { folderId: 'unfiled' })).toEqual([]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { folderId: 'root' })).toEqual([
                'folderId',
            ]);
        });

        it('bounds the page size at 200', async () => {
            expect(await errorsOf(KnowledgeLibraryQueryDto, { limit: '200' })).toEqual([]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { limit: '201' })).toEqual(['limit']);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { limit: '0' })).toEqual(['limit']);
        });

        it('rejects unknown sorts, archived filters and classes', async () => {
            expect(await errorsOf(KnowledgeLibraryQueryDto, { sort: 'random' })).toEqual(['sort']);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { archived: 'all' })).toEqual([
                'archived',
            ]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { class: 'style,nope' })).toEqual([
                'class',
            ]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { class: 'style,brand' })).toEqual([]);
        });

        it('bounds the free-text query at 128 characters', async () => {
            expect(await errorsOf(KnowledgeLibraryQueryDto, { q: 'x'.repeat(128) })).toEqual([]);
            expect(await errorsOf(KnowledgeLibraryQueryDto, { q: 'x'.repeat(129) })).toEqual(['q']);
        });

        it('files 1 to 100 documents into a folder id or null', async () => {
            const ids = (n: number) =>
                Array.from(
                    { length: n },
                    (_v, i) => `6f1c2a4e-3b7d-4c9a-8e21-${String(i).padStart(12, '0')}`,
                );
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, {
                    documentIds: ids(100),
                    folderId: FOLDER_ID,
                }),
            ).toEqual([]);
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, { documentIds: ids(1), folderId: null }),
            ).toEqual([]);
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, {
                    documentIds: ids(101),
                    folderId: null,
                }),
            ).toEqual(['documentIds']);
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, { documentIds: [], folderId: null }),
            ).toEqual(['documentIds']);
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, {
                    documentIds: ['nope'],
                    folderId: null,
                }),
            ).toEqual(['documentIds']);
            expect(
                await errorsOf(FileKnowledgeDocumentsDto, {
                    documentIds: ids(1),
                    folderId: 'nope',
                }),
            ).toEqual(['folderId']);
        });

        it('exports Markdown only', async () => {
            expect(await errorsOf(ExportKnowledgeDocumentQueryDto, { format: 'md' })).toEqual([]);
            expect(await errorsOf(ExportKnowledgeDocumentQueryDto, {})).toEqual([]);
            expect(await errorsOf(ExportKnowledgeDocumentQueryDto, { format: 'pdf' })).toEqual([
                'format',
            ]);
        });
    });
});
