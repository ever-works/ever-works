// The `@ever-works/agent/services` barrel pulls in the whole agent graph (work module ->
// subscriptions -> api notifications/auth -> ESM-only better-auth, website-generator
// config), which this jest environment cannot load. The controller only needs these
// classes as DI tokens and the spec hands it fakes: stub the barrel, as the other api
// specs do.
jest.mock('@ever-works/agent/services', () => ({
    KnowledgeBaseService: class KnowledgeBaseService {},
    KnowledgeLibraryService: class KnowledgeLibraryService {},
}));

import { ForbiddenException } from '@nestjs/common';
import {
    DuplicateExternalRefError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationKbController } from '../kb.controller';

/**
 * The Knowledge Base of `/api/integrations/v1` (EW-P3-2) over doubles of the
 * services: organization vs Work documents, the organization-admin rule
 * (`422 domain_rule`), archive-never-delete for organization documents,
 * If-Match, filing, and the library folder routes delegating to the Knowledge
 * library.
 */
describe('IntegrationKbController', () => {
    const ORG = '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12';
    const WORK = '5e907b12-3d6f-4081-8ca4-1e2f3a4b5c63';
    const FOLDER = '8b2d3f40-5c6e-4f70-9b8c-0d1e2f3a4b51';
    const principal = (actAsUserId: string | null = null) => ({
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['kb:read', 'kb:write'],
        ownerUserId: 'owner-1',
        actAsUserId,
    });
    const user = (actAsUserId: string | null = null) =>
        ({
            userId: actAsUserId ?? 'owner-1',
            authMethod: 'integration',
            integration: principal(actAsUserId),
        }) as never;
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });
    const req = (key = 'idem-1') => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/kb/documents',
        body: {},
        headers: key ? { 'idempotency-key': key } : {},
    });
    const docDto = (workId: string | null, version = 1, status = 'active') => ({
        id: 'doc-1',
        organizationId: ORG,
        workId,
        version,
        status,
    });

    const setup = (opts: { admin?: boolean; workId?: string | null; status?: string } = {}) => {
        const workId = opts.workId === undefined ? null : opts.workId;
        const kb = {
            listDocuments: jest
                .fn()
                .mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            getDocument: jest.fn(async () => ({
                dto: docDto(workId, 1, opts.status),
                etag: '"1"',
                workId,
            })),
            assertWorkOfOrganization: jest.fn().mockResolvedValue(undefined),
            listFolders: jest
                .fn()
                .mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            getFolder: jest.fn(async () => ({ dto: { id: FOLDER, version: 1 }, etag: '"1"' })),
            claimVersion: jest.fn().mockResolvedValue(true),
        };
        // As the Knowledge Base: `withinCreate` runs in the create's transaction.
        const createWith =
            (id: string) =>
            async (...args: unknown[]) => {
                const options = args[args.length - 1] as {
                    withinCreate?: (row: { id: string }, manager: unknown) => Promise<void>;
                };
                if (options?.withinCreate) await options.withinCreate({ id }, 'tx-manager');
                return { id };
            };
        const knowledgeBase = {
            createOrgDocument: jest.fn(createWith('doc-1')),
            createDocument: jest.fn(createWith('doc-1')),
            updateDocument: jest.fn().mockResolvedValue({}),
            updateOrgDocument: jest.fn().mockResolvedValue({}),
            deleteDocument: jest.fn().mockResolvedValue(undefined),
            acceptDocument: jest.fn().mockResolvedValue({}),
            acceptOrgDocument: jest.fn().mockResolvedValue({}),
            archiveOrgDocument: jest.fn().mockResolvedValue({}),
        };
        const library = {
            fileDocuments: jest.fn().mockResolvedValue({ filed: 1, folderId: FOLDER }),
            archive: jest.fn().mockResolvedValue({}),
            unarchive: jest.fn().mockResolvedValue({}),
            createFolder: jest.fn(createWith(FOLDER)),
            renameFolder: jest.fn().mockResolvedValue({}),
            moveFolder: jest.fn().mockResolvedValue({}),
            deleteFolder: jest.fn().mockResolvedValue({ deletedFolders: 1, unfiledDocuments: 2 }),
        };
        const membership = {
            ensureAdmin: jest.fn(async () => {
                if (opts.admin === false) throw new ForbiddenException('not an admin');
            }),
        };
        const links = {
            findByExternal: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            removeAllFor: jest.fn().mockResolvedValue(1),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationKbController(
            kb as never,
            knowledgeBase as never,
            library as never,
            membership as never,
            links as never,
            idempotency as never,
            scope as never,
        );
        return { controller, kb, knowledgeBase, library, links };
    };

    const createBody = (scope: { type: 'organization' | 'work'; id: string }) => ({
        scope,
        path: 'support/refunds.md',
        title: 'Refunds',
        class: 'freeform',
        body: 'Within 30 days.',
    });

    it('creates an organization document (any class), files it, links the externalRef and answers 201', async () => {
        const { controller, knowledgeBase, library, links } = setup();
        const response = res();
        const body = await controller.createDocument(
            user(),
            {
                ...createBody({ type: 'organization', id: ORG }),
                folderId: FOLDER,
                externalRef: { source: 'gauzy', externalId: 'gd-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(knowledgeBase.createOrgDocument).toHaveBeenCalledWith(
            ORG,
            'owner-1',
            expect.objectContaining({ class: 'freeform', source: 'imported' }),
            { withinCreate: expect.any(Function) },
        );
        expect(library.fileDocuments).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG, canManageOrganization: true }),
            { documentIds: ['doc-1'], folderId: FOLDER },
        );
        // Linked inside the create's transaction (its manager).
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG, installationId: 'conn-1' }),
            expect.objectContaining({ entityType: 'kb_document', entityId: 'doc-1' }),
            'tx-manager',
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toMatchObject({ id: 'doc-1' });
    });

    it('creates a Work document as the act-as person (source user) in a Work of the organization', async () => {
        const { controller, kb, knowledgeBase } = setup();
        await controller.createDocument(
            user('user-7'),
            createBody({ type: 'work', id: WORK }),
            undefined,
            req(),
            res(),
        );
        expect(kb.assertWorkOfOrganization).toHaveBeenCalledWith(ORG, WORK);
        expect(knowledgeBase.createDocument).toHaveBeenCalledWith(
            expect.objectContaining({ workId: WORK, userId: 'user-7', source: 'user' }),
            { withinCreate: undefined },
        );
    });

    it('refuses an organization document from a non-admin (422 domain_rule) and a foreign organization scope (400)', async () => {
        const { controller, knowledgeBase } = setup({ admin: false });
        await expect(
            controller.createDocument(
                user(),
                createBody({ type: 'organization', id: ORG }),
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ code: 'domain_rule' });
        await expect(
            controller.createDocument(
                user(),
                createBody({ type: 'organization', id: '1a5c3d7e-9f2b-4c4d-8e6f-7a8b9c0d1e23' }),
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        expect(knowledgeBase.createOrgDocument).not.toHaveBeenCalled();
    });

    it('a lost externalRef race rolls the create back (nothing archived or deleted) and answers the winner', async () => {
        const { controller, kb, knowledgeBase, links } = setup();
        links.create.mockRejectedValueOnce(
            new DuplicateExternalRefError('external', 'doc-w', 'gd-1'),
        );
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'doc-w' });
        const response = res();
        await controller.createDocument(
            user(),
            {
                ...createBody({ type: 'organization', id: ORG }),
                externalRef: { source: 'gauzy', externalId: 'gd-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(kb.getDocument).toHaveBeenCalledWith(ORG, 'doc-w');
        expect(knowledgeBase.archiveOrgDocument).not.toHaveBeenCalled();
        expect(knowledgeBase.deleteDocument).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
    });

    it('If-Match claims the version (compare-and-set); a writer that lost the claim gets 412, no If-Match claims nothing', async () => {
        const { controller, kb, knowledgeBase } = setup();
        await controller.updateDocument(user(), 'doc-1', { title: 'T' }, '"1"', res());
        expect(kb.claimVersion).toHaveBeenCalledWith('kb_document', 'doc-1', 1);
        expect(knowledgeBase.updateOrgDocument).toHaveBeenCalledTimes(1);
        kb.claimVersion.mockResolvedValueOnce(false);
        await expect(
            controller.updateDocument(user(), 'doc-1', { title: 'T' }, '"1"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        expect(knowledgeBase.updateOrgDocument).toHaveBeenCalledTimes(1);
        kb.claimVersion.mockClear();
        await controller.updateDocument(user(), 'doc-1', { title: 'T' }, undefined, res());
        expect(kb.claimVersion).not.toHaveBeenCalled();
    });

    it('a refused write claims nothing: a non-admin is refused before the If-Match claim', async () => {
        const { controller, kb } = setup({ admin: false });
        await expect(
            controller.updateDocument(user(), 'doc-1', { title: 'T' }, '"1"', res()),
        ).rejects.toMatchObject({ code: 'domain_rule' });
        await expect(
            controller.updateFolder(user(), FOLDER, { name: 'N' }, '"1"', res()),
        ).rejects.toMatchObject({ code: 'domain_rule' });
        expect(kb.claimVersion).not.toHaveBeenCalled();
    });

    it('checks the folder BEFORE creating: a folder outside the organization creates nothing (404)', async () => {
        const { controller, kb, knowledgeBase } = setup();
        kb.getFolder.mockRejectedValueOnce(new ResourceNotFoundError('kb_folder', FOLDER));
        await expect(
            controller.createDocument(
                user(),
                { ...createBody({ type: 'organization', id: ORG }), folderId: FOLDER },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(knowledgeBase.createOrgDocument).not.toHaveBeenCalled();
    });

    it('refuses an organization document path that leaves the library (400)', async () => {
        const { controller, knowledgeBase } = setup();
        for (const path of ['../secrets.md', '/etc/x.md', 'a\\b.md', 'C:/x.md', 'a/../../x.md']) {
            await expect(
                controller.createDocument(
                    user(),
                    { ...createBody({ type: 'organization', id: ORG }), path },
                    undefined,
                    req(),
                    res(),
                ),
            ).rejects.toMatchObject({ code: 'validation_failed' });
        }
        expect(knowledgeBase.createOrgDocument).not.toHaveBeenCalled();
    });

    it('refuses a status write on an archived document (422: restore it with /unarchive)', async () => {
        const { controller, knowledgeBase } = setup({ status: 'archived' });
        await expect(
            controller.updateDocument(user(), 'doc-1', { status: 'active' }, undefined, res()),
        ).rejects.toMatchObject({ code: 'domain_rule' });
        expect(knowledgeBase.updateOrgDocument).not.toHaveBeenCalled();
        // Other edits of an archived document still go through.
        await controller.updateDocument(user(), 'doc-1', { title: 'T' }, undefined, res());
        expect(knowledgeBase.updateOrgDocument).toHaveBeenCalled();
    });

    it('edits a Work document through updateDocument and an organization one through updateOrgDocument; a stale If-Match is 412', async () => {
        const work = setup({ workId: WORK });
        await work.controller.updateDocument(user(), 'doc-1', { body: 'New' }, undefined, res());
        expect(work.knowledgeBase.updateDocument).toHaveBeenCalledWith(WORK, 'doc-1', 'owner-1', {
            body: 'New',
        });
        const org = setup();
        await org.controller.updateDocument(user(), 'doc-1', { title: 'T' }, '"1"', res());
        expect(org.knowledgeBase.updateOrgDocument).toHaveBeenCalledWith(ORG, 'doc-1', 'owner-1', {
            title: 'T',
        });
        await expect(
            org.controller.updateDocument(user(), 'doc-1', { title: 'T' }, '"9"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        await expect(
            org.controller.updateDocument(user(), 'doc-1', {}, undefined, res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('deletes a Work document; an organization document is archived, never deleted (422)', async () => {
        const work = setup({ workId: WORK });
        await work.controller.deleteDocument(user(), 'doc-1', undefined);
        expect(work.knowledgeBase.deleteDocument).toHaveBeenCalledWith(WORK, 'doc-1', 'owner-1');
        expect(work.links.removeAllFor).toHaveBeenCalledWith(ORG, 'kb_document', 'doc-1');
        const org = setup();
        await expect(
            org.controller.deleteDocument(user(), 'doc-1', undefined),
        ).rejects.toMatchObject({ code: 'domain_rule' });
        expect(org.knowledgeBase.deleteDocument).not.toHaveBeenCalled();
    });

    it('accepts, archives, restores and files through the Knowledge Base and the library', async () => {
        const { controller, knowledgeBase, library } = setup();
        await controller.acceptDocument(user(), 'doc-1', res());
        expect(knowledgeBase.acceptOrgDocument).toHaveBeenCalledWith(ORG, 'doc-1', 'owner-1');
        await controller.archiveDocument(user(), 'doc-1', res());
        expect(library.archive).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG }),
            'doc-1',
        );
        await controller.unarchiveDocument(user(), 'doc-1', res());
        expect(library.unarchive).toHaveBeenCalled();
        await controller.moveDocument(user(), 'doc-1', { folderId: null }, res());
        expect(library.fileDocuments).toHaveBeenCalledWith(expect.anything(), {
            documentIds: ['doc-1'],
            folderId: null,
        });
    });

    it('lists with validated filters', async () => {
        const { controller, kb } = setup();
        await controller.listDocuments({
            scope: 'work',
            class: 'brand,legal',
            folderId: 'unfiled',
        });
        expect(kb.listDocuments).toHaveBeenCalledWith(
            ORG,
            expect.objectContaining({
                scopeType: 'work',
                classes: ['brand', 'legal'],
                folderId: 'unfiled',
            }),
        );
        for (const query of [
            { scope: 'team' },
            { class: 'wiki' },
            { status: 'deleted' },
            { workId: 'x' },
        ]) {
            await expect(controller.listDocuments(query)).rejects.toMatchObject({
                code: 'validation_failed',
            });
        }
    });

    it('manages library folders through the Knowledge library', async () => {
        const { controller, library, links } = setup();
        await controller.createFolder(user(), { name: 'Support' }, undefined, req(), res());
        expect(library.createFolder).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG }),
            { name: 'Support', parentId: null },
            {},
        );
        await controller.updateFolder(
            user(),
            FOLDER,
            { name: 'Help', parentId: null },
            undefined,
            res(),
        );
        expect(library.renameFolder).toHaveBeenCalledWith(expect.anything(), FOLDER, 'Help');
        expect(library.moveFolder).toHaveBeenCalledWith(expect.anything(), FOLDER, null);
        await expect(controller.deleteFolder(user(), FOLDER, undefined)).resolves.toEqual({
            deletedFolders: 1,
            unfiledDocuments: 2,
        });
        expect(links.removeAllFor).toHaveBeenCalledWith(ORG, 'kb_folder', FOLDER);
        await expect(
            controller.updateFolder(user(), FOLDER, {}, undefined, res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
    });
});
