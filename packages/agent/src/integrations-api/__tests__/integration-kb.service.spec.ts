import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    contractValidator,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { MemoryFolder, MemoryFolderScope } from '../../entities/memory-folder.entity';
import { Organization } from '../../entities/organization.entity';
import { Work } from '../../entities/work.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { ResourceNotFoundError } from '../integration-api.errors';
import { IntegrationKbService } from '../integration-kb.service';

/**
 * Integration API v1 Knowledge Base reads (EW-P3-2) on SQLite: the
 * organization's own documents plus its Works' (never a personal Work's or
 * another organization's), the scope / Work / folder / class / status filters,
 * archived only on request, the organization library folders (never a
 * person's own), and every DTO valid against the published schemas.
 */
describe('IntegrationKbService', () => {
    let dataSource: DataSource;
    let kb: IntegrationKbService;
    const expectValid = contractValidator();
    const OWNER = randomUUID();
    const WORK_A = randomUUID();
    const WORK_B = randomUUID();
    const PERSONAL = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        kb = new IntegrationKbService(dataSource);
    });

    beforeEach(async () => {
        for (const table of [
            'work_knowledge_documents',
            'memory_folders',
            'works',
            'organizations',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert([
            { id: ORG_A, tenantId: TENANT, slug: 'acme', displayName: 'Acme' },
            { id: ORG_B, tenantId: TENANT, slug: 'beta', displayName: 'Beta' },
        ] as unknown as Organization[]);
        const work = (id: string, organizationId: string | null, slug: string) => ({
            id,
            name: slug,
            slug,
            description: slug,
            userId: OWNER,
            tenantId: TENANT,
            organizationId,
        });
        await dataSource
            .getRepository(Work)
            .insert([
                work(WORK_A, ORG_A, 'docs-a'),
                work(WORK_B, ORG_B, 'docs-b'),
                work(PERSONAL, null, 'mine'),
            ] as unknown as Work[]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const doc = (
        scope: { workId?: string; organizationId?: string },
        extra: Partial<WorkKnowledgeDocument> = {},
    ): Promise<WorkKnowledgeDocument> =>
        dataSource.getRepository(WorkKnowledgeDocument).save({
            workId: scope.workId ?? null,
            organizationId: scope.organizationId ?? null,
            path: `notes/${randomUUID().slice(0, 8)}.md`,
            slug: 'notes',
            title: 'Notes',
            kbDocumentClass: 'freeform',
            status: 'active',
            source: 'user',
            revision: 1,
            revisionAt: new Date(),
            reviewState: 'accepted',
            metadata: { body: '# Notes' },
            ...extra,
        } as unknown as WorkKnowledgeDocument);

    it("lists the organization's own documents and its Works', never a personal Work's or another organization's", async () => {
        const own = await doc({ organizationId: ORG_A });
        const ofWork = await doc({ workId: WORK_A }, { kbDocumentClass: 'brand' as never });
        await doc({ workId: WORK_B });
        await doc({ workId: PERSONAL });
        await doc({ organizationId: ORG_B });
        const page = await kb.listDocuments(ORG_A, {});
        expect(page.data.map((dto) => dto.id).sort()).toEqual([own.id, ofWork.id].sort());
        for (const dto of page.data) {
            expectValid('resources/kb-document.schema.json', dto);
            expect(dto.organizationId).toBe(ORG_A);
            expect(dto.body).toBe('# Notes');
        }
        const work = page.data.find((dto) => dto.id === ofWork.id)!;
        expect(work).toMatchObject({ scope: { type: 'work', id: WORK_A }, workId: WORK_A });
        const org = page.data.find((dto) => dto.id === own.id)!;
        expect(org).toMatchObject({ scope: { type: 'organization', id: ORG_A }, workId: null });
    });

    it('filters by scope, Work, folder, class and status; archived only when asked', async () => {
        const folder = await dataSource.getRepository(MemoryFolder).save({
            userId: OWNER,
            organizationId: ORG_A,
            scope: MemoryFolderScope.ORGANIZATION,
            name: 'Support',
            path: '/Support',
        } as unknown as MemoryFolder);
        const own = await doc({ organizationId: ORG_A }, { folderId: folder.id });
        const ofWork = await doc({ workId: WORK_A }, { kbDocumentClass: 'brand' as never });
        const archived = await doc({ organizationId: ORG_A }, { status: 'archived' as never });
        const ids = async (query: Parameters<IntegrationKbService['listDocuments']>[1]) =>
            (await kb.listDocuments(ORG_A, query)).data.map((dto) => dto.id).sort();

        expect(await ids({ scopeType: 'organization' })).toEqual([own.id]);
        expect(await ids({ scopeType: 'work' })).toEqual([ofWork.id]);
        expect(await ids({ workId: WORK_A })).toEqual([ofWork.id]);
        expect(await ids({ workId: WORK_B })).toEqual([]);
        expect(await ids({ folderId: folder.id })).toEqual([own.id]);
        expect(await ids({ folderId: 'unfiled' })).toEqual([ofWork.id]);
        expect(await ids({ classes: ['brand'] })).toEqual([ofWork.id]);
        expect(await ids({ statuses: ['archived'] })).toEqual([archived.id]);
        expect(await ids({ includeArchived: true })).toEqual(
            [own.id, ofWork.id, archived.id].sort(),
        );
    });

    it('pages with a cursor', async () => {
        const created: WorkKnowledgeDocument[] = [];
        for (let i = 0; i < 3; i++) created.push(await doc({ organizationId: ORG_A }));
        const first = await kb.listDocuments(ORG_A, { limit: 2 });
        expect(first.hasMore).toBe(true);
        const second = await kb.listDocuments(ORG_A, { limit: 2, cursor: first.nextCursor });
        expect([...first.data, ...second.data].map((dto) => dto.id).sort()).toEqual(
            created.map((row) => row.id).sort(),
        );
    });

    it('gets one document with its ETag and Work, and 404s outside the organization', async () => {
        const ofWork = await doc({ workId: WORK_A });
        const got = await kb.getDocument(ORG_A, ofWork.id);
        expect(got).toMatchObject({ etag: '"1"', workId: WORK_A });
        for (const other of [
            await doc({ workId: WORK_B }),
            await doc({ workId: PERSONAL }),
            await doc({ organizationId: ORG_B }),
        ]) {
            await expect(kb.getDocument(ORG_A, other.id)).rejects.toBeInstanceOf(
                ResourceNotFoundError,
            );
        }
        await expect(kb.assertWorkOfOrganization(ORG_A, WORK_A)).resolves.toBeUndefined();
        await expect(kb.assertWorkOfOrganization(ORG_A, WORK_B)).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
    });

    it("serves the organization's library folders, never a person's own", async () => {
        const shared = await dataSource.getRepository(MemoryFolder).save({
            userId: OWNER,
            organizationId: ORG_A,
            scope: MemoryFolderScope.ORGANIZATION,
            name: 'Support',
            path: '/Support',
        } as unknown as MemoryFolder);
        const personal = await dataSource.getRepository(MemoryFolder).save({
            userId: OWNER,
            organizationId: ORG_A,
            scope: MemoryFolderScope.USER,
            name: 'Mine',
            path: '/Mine',
        } as unknown as MemoryFolder);
        const page = await kb.listFolders(ORG_A, {});
        expect(page.data.map((dto) => dto.id)).toEqual([shared.id]);
        expectValid('resources/kb-folder.schema.json', page.data[0]);
        await expect(kb.getFolder(ORG_A, shared.id)).resolves.toMatchObject({ etag: '"1"' });
        await expect(kb.getFolder(ORG_A, personal.id)).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        await expect(kb.getFolder(ORG_B, shared.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
});
