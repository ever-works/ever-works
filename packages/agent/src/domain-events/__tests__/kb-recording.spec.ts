import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { MemoryFolderRepository } from '../../database/repositories/memory-folder.repository';
import { ActivityActionType } from '../../entities/activity-log.types';
import { DomainEvent } from '../../entities/domain-event.entity';
import { KbDocumentClass } from '../../entities/kb-types';
import { MemoryFolder } from '../../entities/memory-folder.entity';
import { Organization } from '../../entities/organization.entity';
import { Work } from '../../entities/work.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KnowledgeBaseService } from '../../services/knowledge-base.service';
import { MemoryFoldersService } from '../../services/memory-folders.service';
import type { WorkOwnershipService } from '../../services/work-ownership.service';
import { IntegrationKbService } from '../../integrations-api/integration-kb.service';
import { runWithClaimedAggregateVersion } from '../domain-event-context';
import { KB_EVENT_BODY_MAX_BYTES } from '../domain-event-kb-snapshots';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Knowledge Base recording points (EW-P3-2): the real `KnowledgeBaseService`
 * and `MemoryFoldersService` over their real repositories on SQLite. Every
 * write records after itself (best-effort, `recordAfterWrite`); each event's
 * `data` is valid against the schema its catalog row names
 * (`resources/kb-document.schema.json`, `resources/kb-folder.schema.json`).
 */
describe('Knowledge Base recording points', () => {
    let dataSource: DataSource;
    let kb: KnowledgeBaseService;
    let folders: MemoryFoldersService;
    const activity: Array<{ actionType: string; details?: Record<string, unknown> }> = [];
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const WORK = randomUUID();
    const PERSONAL_WORK = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    const docVersion = async (id: string) =>
        Number(
            (await dataSource.getRepository(WorkKnowledgeDocument).findOneByOrFail({ id })).version,
        );

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const publisher = new DomainEventPublisher(new DomainEventRecorder(), dataSource);
        // Authorization is the ownership service's job and not under test here.
        const ownership = {
            ensureCanEdit: async () => ({ role: 'owner' }),
            ensureCanView: async () => ({ role: 'owner' }),
        } as unknown as WorkOwnershipService;
        const activityLog = {
            log: async (entry: { actionType: string; details?: Record<string, unknown> }) => {
                activity.push(entry);
            },
        };
        const args: unknown[] = new Array(21).fill(undefined);
        args[0] = new WorkKnowledgeDocumentRepository(
            dataSource.getRepository(WorkKnowledgeDocument),
        );
        args[4] = ownership;
        args[8] = activityLog;
        kb = new (KnowledgeBaseService as unknown as new (...a: unknown[]) => KnowledgeBaseService)(
            ...args,
            publisher,
        );
        folders = new MemoryFoldersService(
            new MemoryFolderRepository(dataSource.getRepository(MemoryFolder)),
            {} as never,
            {} as never,
            activityLog as never,
            publisher,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'work_knowledge_documents',
            'memory_folders',
            'works',
            'organizations',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        activity.length = 0;
        await dataSource.getRepository(Organization).insert({
            id: ORG_A,
            tenantId: TENANT,
            slug: 'acme',
            displayName: 'Acme',
        } as unknown as Organization);
        await dataSource.getRepository(Work).insert([
            {
                id: WORK,
                name: 'Docs',
                slug: 'docs',
                description: 'Docs',
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
            },
            {
                id: PERSONAL_WORK,
                name: 'Mine',
                slug: 'mine',
                description: 'Mine',
                userId: OWNER,
                tenantId: TENANT,
                organizationId: null,
            },
        ] as unknown as Work[]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const createWorkDoc = (body = '# Voice\n\nFriendly and short.', workId = WORK) =>
        kb.createDocument({
            workId,
            userId: OWNER,
            path: 'brand/voice.md',
            title: 'Voice',
            class: KbDocumentClass.BRAND,
            body,
        });

    it('a Work document records kb.document.created at version 1 with its Work organization', async () => {
        const doc = await createWorkDoc();
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'kb.document.created',
            aggregateType: 'kb_document',
            aggregateId: doc.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
        });
        expect(event.data).toMatchObject({
            id: doc.id,
            organizationId: ORG_A,
            scope: { type: 'work', id: WORK },
            workId: WORK,
            class: 'brand',
            body: '# Voice\n\nFriendly and short.',
            revision: 1,
        });
        expectValid(event);
    });

    it('withinCreate runs in the create transaction: a throw rolls the document back and records nothing', async () => {
        let seen: unknown;
        await expect(
            kb.createDocument(
                {
                    workId: WORK,
                    userId: OWNER,
                    path: 'brand/voice.md',
                    title: 'Voice',
                    class: KbDocumentClass.BRAND,
                    body: 'x',
                },
                {
                    withinCreate: async (document, manager) => {
                        seen = await manager
                            .getRepository(WorkKnowledgeDocument)
                            .findOneBy({ id: document.id });
                        throw new Error('the link lost its race');
                    },
                },
            ),
        ).rejects.toThrow('the link lost its race');
        // The row existed inside the transaction, and is gone after it.
        expect(seen).toBeTruthy();
        expect(await dataSource.getRepository(WorkKnowledgeDocument).count()).toBe(0);
        expect(await events()).toEqual([]);
    });

    it('If-Match as a compare-and-set: one claim per version, and the claimed write records that version once', async () => {
        const doc = await createWorkDoc();
        const integration = new IntegrationKbService(dataSource);
        expect(await integration.claimVersion('kb_document', doc.id, 1)).toBe(true);
        // A second writer holding the same version loses.
        expect(await integration.claimVersion('kb_document', doc.id, 1)).toBe(false);
        expect(await docVersion(doc.id)).toBe(2);
        await runWithClaimedAggregateVersion(
            { aggregateType: 'kb_document', id: doc.id, version: 2 },
            () => kb.updateDocument(WORK, doc.id, OWNER, { title: 'Brand voice' }),
        );
        // Not bumped a second time by the event.
        expect(await docVersion(doc.id)).toBe(2);
        const updated = (await events()).filter((event) => event.type === 'kb.document.updated');
        expect(updated.map((event) => event.aggregateVersion)).toEqual([2]);
        // Outside a claim, the next edit bumps as usual.
        await kb.updateDocument(WORK, doc.id, OWNER, { title: 'Voice' });
        expect(await docVersion(doc.id)).toBe(3);
    });

    it('a document of a personal Work records nothing (never served to an integration)', async () => {
        await createWorkDoc('x', PERSONAL_WORK);
        expect(await events()).toEqual([]);
    });

    it('an edit records kb.document.updated with the changed fields, and the kb_document_updated activity row', async () => {
        const doc = await createWorkDoc();
        await kb.updateDocument(WORK, doc.id, OWNER, { title: 'Brand voice', body: 'New body' });
        // A no-op edit records nothing.
        await kb.updateDocument(WORK, doc.id, OWNER, { title: 'Brand voice' });
        const recorded = (await events()).slice(1);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            type: 'kb.document.updated',
            aggregateVersion: 2,
            changedFields: ['title', 'body'],
            previous: { title: 'Voice' },
        });
        expect(recorded[0].data).toMatchObject({
            title: 'Brand voice',
            body: 'New body',
            revision: 2,
        });
        expectValid(recorded[0]);
        expect(activity.map((row) => row.actionType)).toEqual([
            ActivityActionType.KB_DOCUMENT_UPDATED,
        ]);
        expect(activity[0].details).toMatchObject({
            changedFields: ['title', 'body'],
            revision: 2,
        });
    });

    it('accept, archive and restore record review_changed, archived and unarchived', async () => {
        const doc = await kb.createDocument({
            workId: WORK,
            userId: OWNER,
            path: 'research/notes.md',
            title: 'Notes',
            class: KbDocumentClass.RESEARCH,
            body: 'Agent notes',
            source: 'agent' as never,
        });
        await kb.acceptDocument(WORK, doc.id, OWNER);
        await kb.acceptDocument(WORK, doc.id, OWNER); // already accepted: nothing
        await kb.archiveDocument(WORK, doc.id, OWNER);
        await kb.unarchiveDocument(WORK, doc.id, OWNER);
        const recorded = (await events()).slice(1);
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['kb.document.review_changed', 2],
            ['kb.document.archived', 3],
            ['kb.document.unarchived', 4],
        ]);
        expect(recorded[0]).toMatchObject({ previous: { reviewState: 'proposed' } });
        expect(recorded[1].data).toMatchObject({ status: 'archived' });
        expect(recorded[2].data).toMatchObject({ status: 'active', archivedAt: null });
        for (const event of recorded) expectValid(event);
        expect(await docVersion(doc.id)).toBe(4);
    });

    it('a delete records kb.document.deleted with the last snapshot and the kb_document_deleted activity row', async () => {
        const doc = await createWorkDoc();
        await kb.deleteDocument(WORK, doc.id, OWNER);
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['kb.document.created', 1],
            ['kb.document.deleted', 2],
        ]);
        expect(recorded[1].data).toMatchObject({ id: doc.id, title: 'Voice', deleted: true });
        expectValid(recorded[1]);
        expect(activity.map((row) => row.actionType)).toContain(
            ActivityActionType.KB_DOCUMENT_DELETED,
        );
        expect(await dataSource.getRepository(WorkKnowledgeDocument).count()).toBe(0);
    });

    it('every class may live at organization scope; the organization document records created and its edits', async () => {
        const doc = await kb.createOrgDocument(ORG_A, OWNER, {
            path: 'support/refunds.md',
            title: 'Refunds',
            class: KbDocumentClass.FREEFORM,
            body: 'Within 30 days.',
        });
        await kb.updateOrgDocument(ORG_A, doc.id, OWNER, { body: 'Within 60 days.' });
        await expect(
            kb.updateOrgDocument('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', doc.id, OWNER, {
                body: 'x',
            }),
        ).resolves.toBeNull();
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['kb.document.created', 1],
            ['kb.document.updated', 2],
        ]);
        expect(recorded[0].data).toMatchObject({
            scope: { type: 'organization', id: ORG_A },
            workId: null,
            class: 'freeform',
        });
        expect(recorded[1].data).toMatchObject({ body: 'Within 60 days.', revision: 2 });
        for (const event of recorded) expectValid(event);
    });

    it('an event leaves out a body above the event limit (bodyOmitted); the row keeps it', async () => {
        const big = 'x'.repeat(KB_EVENT_BODY_MAX_BYTES + 1);
        const doc = await createWorkDoc(big);
        const [event] = await events();
        expect(event.data).toMatchObject({ body: null, bodyOmitted: true });
        expectValid(event);
        const row = await dataSource.getRepository(WorkKnowledgeDocument).findOneByOrFail({
            id: doc.id,
        });
        expect((row.metadata as { body: string }).body).toHaveLength(big.length);
    });

    it('organization library folders record created, updated for a renamed subtree, and deleted for each folder', async () => {
        const parent = await folders.createOrganizationFolder(ORG_A, OWNER, { name: 'Playbooks' });
        const child = await folders.createOrganizationFolder(ORG_A, OWNER, {
            name: 'Support',
            parentId: parent.id,
        });
        await folders.renameOrganizationFolder(ORG_A, OWNER, parent.id, 'Runbooks');
        const afterRename = (await events()).slice(2);
        expect(afterRename.map((event) => [event.type, event.aggregateId])).toEqual([
            ['kb.folder.updated', parent.id],
            ['kb.folder.updated', child.id],
        ]);
        expect(afterRename[0]).toMatchObject({
            changedFields: ['name', 'path'],
            previous: { name: 'Playbooks', path: '/Playbooks' },
        });
        expect(afterRename[1]).toMatchObject({
            changedFields: ['path'],
            previous: { path: '/Playbooks/Support' },
        });
        expect(afterRename[1].data).toMatchObject({ path: '/Runbooks/Support' });

        await folders.deleteOrganizationFolder(ORG_A, OWNER, parent.id, async () => 0);
        const deleted = (await events()).filter((event) => event.type === 'kb.folder.deleted');
        expect(deleted.map((event) => event.aggregateId).sort()).toEqual(
            [parent.id, child.id].sort(),
        );
        for (const event of await events()) expectValid(event);
    });
});
