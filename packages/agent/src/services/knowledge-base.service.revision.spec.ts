import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { KnowledgeBaseService } from './knowledge-base.service';
import { hashNormalizedBody } from './kb-content-hash';
import { ActivityActionType } from '../entities/activity-log.types';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import {
    KbDecisionStatus,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbReviewState,
} from '../entities/kb-types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const DOC_ID = '00000000-0000-0000-0000-000000000010';
const FOLDER_ID = '00000000-0000-0000-0000-0000000000f1';

const BODY = 'When we refund,\nwhen we do not.';

function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: DOC_ID,
        workId: WORK_ID,
        organizationId: null,
        path: 'freeform/refunds.md',
        slug: 'refunds',
        title: 'Refund policy',
        description: 'When we refund',
        kbDocumentClass: KbDocumentClass.FREEFORM,
        tags: ['support', 'billing'],
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 5,
        tokenCount: 8,
        source: KbDocumentSource.USER,
        metadata: { body: BODY },
        revision: 3,
        revisionAt: new Date('2026-09-01T06:04:00Z'),
        normalizedContentHash: hashNormalizedBody(BODY),
        folderId: null,
        archivedAt: null,
        archivedById: null,
        reviewState: KbReviewState.ACCEPTED,
        decision: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T06:04:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

/**
 * Knowledge library — the revision counter and archive / restore on
 * `KnowledgeBaseService`.
 *
 * `revision` is what "changed since you last read it" will be built on, so
 * the property that matters most is what does NOT move it: reformatting,
 * bookkeeping writes, reordering tags, and — on the day this ships — every
 * existing document whose fingerprint has not been seeded yet.
 */
describe('KnowledgeBaseService — knowledge library revisions and archive', () => {
    let docRepo: {
        findById: jest.Mock;
        findOrgById: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        pathExists: jest.Mock;
        list: jest.Mock;
        setLock: jest.Mock;
    };
    let ownership: { ensureCanEdit: jest.Mock; ensureCanView: jest.Mock };
    let activityLog: { log: jest.Mock };
    let mirrorDispatcher: { dispatchKbMirrorDocument: jest.Mock };
    let mirrorService: { restoreDocumentFromGit: jest.Mock };
    let fanout: { dispatchKbOrgOverlayFanout: jest.Mock };
    let workRepository: { findIdsByOrganization: jest.Mock; findById: jest.Mock };
    let service: KnowledgeBaseService;

    beforeEach(() => {
        docRepo = {
            findById: jest.fn(),
            findOrgById: jest.fn(),
            create: jest.fn(async (data) => buildDocument(data)),
            update: jest.fn(async (_id, patch) => buildDocument(patch)),
            pathExists: jest.fn(async () => false),
            list: jest.fn(async () => ({ items: [], total: 0 })),
            setLock: jest.fn(async () => buildDocument({ locked: true })),
        };
        ownership = {
            ensureCanEdit: jest.fn(async () => ({ role: 'owner' })),
            ensureCanView: jest.fn(async () => ({ role: 'owner' })),
        };
        activityLog = { log: jest.fn(async () => undefined) };
        mirrorDispatcher = { dispatchKbMirrorDocument: jest.fn(async () => 'run') };
        mirrorService = {
            restoreDocumentFromGit: jest.fn(async () => ({ restored: true, body: '' })),
        };
        fanout = { dispatchKbOrgOverlayFanout: jest.fn(async () => undefined) };
        workRepository = {
            findIdsByOrganization: jest.fn(async () => [WORK_ID]),
            findById: jest.fn(async () => null),
        };
        const tagRepo = {
            upsertBySlug: jest.fn(),
            findBySlug: jest.fn(async () => null),
            create: jest.fn(),
        };
        service = new KnowledgeBaseService(
            docRepo as never,
            {} as never,
            tagRepo as never,
            {} as never,
            ownership as never,
            mirrorDispatcher as never,
            mirrorService as never,
            undefined,
            activityLog as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            fanout as never,
            workRepository as never,
        );
    });

    describe('createDocument', () => {
        it('starts at revision 1 with the body fingerprint seeded', async () => {
            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'freeform/refunds.md',
                title: 'Refund policy',
                class: KbDocumentClass.FREEFORM,
                body: BODY,
            });
            const data = docRepo.create.mock.calls[0][0];
            expect(data.revision).toBe(1);
            expect(data.revisionAt).toBeInstanceOf(Date);
            expect(data.normalizedContentHash).toBe(hashNormalizedBody(BODY));
        });
    });

    describe('updateDocument', () => {
        async function update(input: Record<string, unknown>, existing = buildDocument()) {
            docRepo.findById.mockResolvedValue(existing);
            await service.updateDocument(WORK_ID, DOC_ID, USER_ID, input);
            return docRepo.update.mock.calls[0][1] as Partial<WorkKnowledgeDocument>;
        }

        it('bumps the revision when the body changes', async () => {
            const patch = await update({ body: `${BODY} Always within 30 days.` });
            expect(patch.revision).toBe(4);
            expect(patch.revisionAt).toBeInstanceOf(Date);
            expect(patch.normalizedContentHash).toBe(
                hashNormalizedBody(`${BODY} Always within 30 days.`),
            );
        });

        it('does NOT bump on a whitespace-only reformat', async () => {
            const patch = await update({ body: '  When we refund,   when we do not.\r\n\r\n' });
            expect(patch.revision).toBeUndefined();
            expect(patch.revisionAt).toBeUndefined();
        });

        it.each([
            ['title', { title: 'Refunds' }],
            ['description', { description: 'When we refund, and when we do not' }],
            ['class', { class: KbDocumentClass.RESEARCH }],
            ['added tag', { tags: ['support', 'billing', 'vip'] }],
            ['removed tag', { tags: ['support'] }],
        ])('bumps the revision when the %s changes', async (_label, input) => {
            const patch = await update(input);
            expect(patch.revision).toBe(4);
        });

        it('does NOT bump when the tags are only reordered', async () => {
            const patch = await update({ tags: ['billing', 'support'] });
            expect(patch.revision).toBeUndefined();
        });

        it('does NOT bump on a language or status change', async () => {
            const patch = await update({ language: 'fr', status: KbDocumentStatus.DRAFT });
            expect(patch.revision).toBeUndefined();
        });

        it('seeds a NULL fingerprint without bumping, even when the body changes', async () => {
            const patch = await update(
                { body: 'An entirely new body', title: 'New title' },
                buildDocument({ normalizedContentHash: null, revision: 1 }),
            );
            expect(patch.revision).toBeUndefined();
            expect(patch.normalizedContentHash).toBe(hashNormalizedBody('An entirely new body'));
        });

        it('seeds a NULL fingerprint from the existing body when the body is not part of the edit', async () => {
            const patch = await update(
                { language: 'de' },
                buildDocument({ normalizedContentHash: null, revision: 1 }),
            );
            expect(patch.normalizedContentHash).toBe(hashNormalizedBody(BODY));
            expect(patch.revision).toBeUndefined();
        });
    });

    describe('bookkeeping writes', () => {
        it('locking a document leaves the revision alone', async () => {
            docRepo.findById.mockResolvedValue(buildDocument());
            await service.lockDocument(WORK_ID, DOC_ID, USER_ID, 'full' as never);
            expect(docRepo.update).not.toHaveBeenCalled();
            expect(docRepo.setLock).toHaveBeenCalledWith(DOC_ID, true, 'full');
        });
    });

    describe('restoreDocumentFromHistory', () => {
        it('bumps the revision when the restored body differs', async () => {
            docRepo.findById
                .mockResolvedValueOnce(buildDocument())
                .mockResolvedValueOnce(buildDocument({ metadata: { body: 'The old policy' } }));
            await service.restoreDocumentFromHistory(WORK_ID, DOC_ID, USER_ID, 'abc123');
            expect(docRepo.update).toHaveBeenCalledWith(
                DOC_ID,
                expect.objectContaining({ revision: 4 }),
            );
        });

        it('does not bump when the restored body is the same text reflowed', async () => {
            docRepo.findById
                .mockResolvedValueOnce(buildDocument())
                .mockResolvedValueOnce(buildDocument({ metadata: { body: `\n${BODY}\n\n` } }));
            await service.restoreDocumentFromHistory(WORK_ID, DOC_ID, USER_ID, 'abc123');
            expect(docRepo.update).not.toHaveBeenCalled();
        });
    });

    describe('archiveDocument', () => {
        it('stamps who archived it, when, and the folder it sat in, and logs it once', async () => {
            docRepo.findById.mockResolvedValue(buildDocument({ folderId: FOLDER_ID }));
            await service.archiveDocument(WORK_ID, DOC_ID, USER_ID);
            const patch = docRepo.update.mock.calls[0][1];
            expect(patch.status).toBe(KbDocumentStatus.ARCHIVED);
            expect(patch.archivedAt).toBeInstanceOf(Date);
            expect(patch.archivedById).toBe(USER_ID);
            expect(patch.metadata).toEqual({ body: BODY, archivedFromFolderId: FOLDER_ID });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.KB_DOCUMENT_ARCHIVED }),
            );
        });

        it('archiving an archived document keeps the original bookkeeping and logs nothing', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({ status: KbDocumentStatus.ARCHIVED, archivedById: 'someone-else' }),
            );
            await service.archiveDocument(WORK_ID, DOC_ID, USER_ID);
            const patch = docRepo.update.mock.calls[0][1];
            expect(patch.archivedById).toBeUndefined();
            expect(patch.archivedAt).toBeUndefined();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('does not move the revision', async () => {
            docRepo.findById.mockResolvedValue(buildDocument());
            await service.archiveDocument(WORK_ID, DOC_ID, USER_ID);
            expect(docRepo.update.mock.calls[0][1].revision).toBeUndefined();
        });
    });

    describe('unarchiveDocument', () => {
        it('returns the document to its folder and clears the archive bookkeeping', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({
                    status: KbDocumentStatus.ARCHIVED,
                    archivedAt: new Date(),
                    archivedById: USER_ID,
                    folderId: FOLDER_ID,
                    metadata: { body: BODY, archivedFromFolderId: FOLDER_ID },
                }),
            );
            const result = await service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID);
            const patch = docRepo.update.mock.calls[0][1];
            expect(patch).toMatchObject({
                status: KbDocumentStatus.ACTIVE,
                archivedAt: null,
                archivedById: null,
                metadata: { body: BODY },
            });
            expect(patch.folderId).toBeUndefined();
            expect(result.restoredToUnfiled).toBe(false);
            expect(result.changed).toBe(true);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.KB_DOCUMENT_UNARCHIVED }),
            );
        });

        it('reports restoredToUnfiled when the folder it was archived from is gone', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({
                    status: KbDocumentStatus.ARCHIVED,
                    folderId: null,
                    metadata: { body: BODY, archivedFromFolderId: FOLDER_ID },
                }),
            );
            const result = await service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID);
            expect(result.restoredToUnfiled).toBe(true);
        });

        it('a document that was never filed is not "restored to Unfiled because its folder is gone"', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({
                    status: KbDocumentStatus.ARCHIVED,
                    metadata: { body: BODY, archivedFromFolderId: null },
                }),
            );
            const result = await service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID);
            expect(result.restoredToUnfiled).toBe(false);
        });

        it('is a no-op on a document that is not archived', async () => {
            docRepo.findById.mockResolvedValue(buildDocument());
            const result = await service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID);
            expect(result.changed).toBe(false);
            expect(docRepo.update).not.toHaveBeenCalled();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('leaves the decision state alone', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({
                    kbDocumentClass: KbDocumentClass.DECISION,
                    status: KbDocumentStatus.ARCHIVED,
                    decision: { status: KbDecisionStatus.ARCHIVED },
                }),
            );
            await service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID);
            expect(docRepo.update.mock.calls[0][1].decision).toBeUndefined();
        });

        it('requires edit access', async () => {
            ownership.ensureCanEdit.mockRejectedValue(new ForbiddenException());
            await expect(
                service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(docRepo.update).not.toHaveBeenCalled();
        });

        it('404s for a document that is not in the Work', async () => {
            docRepo.findById.mockResolvedValue(null);
            await expect(
                service.unarchiveDocument(WORK_ID, DOC_ID, USER_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('organization documents', () => {
        const orgDoc = (overrides: Partial<WorkKnowledgeDocument> = {}) =>
            buildDocument({
                workId: null,
                organizationId: ORG_ID,
                kbDocumentClass: KbDocumentClass.LEGAL,
                ...overrides,
            });

        it('archiving stamps the bookkeeping and retracts the overlay', async () => {
            docRepo.findOrgById.mockResolvedValue(orgDoc());
            const result = await service.archiveOrgDocument(ORG_ID, DOC_ID, USER_ID);
            expect(result).not.toBeNull();
            // The reject transition is written exactly as the review queue
            // writes it; the shelf bookkeeping follows as its own write.
            expect(docRepo.update.mock.calls[0][1]).toEqual({
                status: KbDocumentStatus.ARCHIVED,
                updatedById: USER_ID,
            });
            expect(docRepo.update.mock.calls[1][1]).toMatchObject({ archivedById: USER_ID });
            expect(docRepo.update.mock.calls[1][1].archivedAt).toBeInstanceOf(Date);
            expect(fanout.dispatchKbOrgOverlayFanout).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'delete' }),
            );
            expect(activityLog.log).toHaveBeenCalledTimes(1);
        });

        it('restoring re-fans the overlay out for an inheritable class', async () => {
            docRepo.findOrgById.mockResolvedValue(orgDoc({ status: KbDocumentStatus.ARCHIVED }));
            docRepo.update.mockImplementation(async (_id, patch) => orgDoc(patch));
            const result = await service.unarchiveOrgDocument(ORG_ID, DOC_ID, USER_ID);
            expect(result?.changed).toBe(true);
            expect(fanout.dispatchKbOrgOverlayFanout).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'upsert' }),
            );
        });

        it('returns null for a document of another Organization', async () => {
            docRepo.findOrgById.mockResolvedValue(null);
            expect(await service.unarchiveOrgDocument(ORG_ID, DOC_ID, USER_ID)).toBeNull();
            expect(await service.archiveOrgDocument(ORG_ID, DOC_ID, USER_ID)).toBeNull();
            expect(docRepo.update).not.toHaveBeenCalled();
        });
    });

    describe('context injection', () => {
        beforeEach(() => {
            docRepo.findById.mockImplementation(async (_workId: string, id: string) =>
                id === 'archived'
                    ? buildDocument({ id: 'archived', status: KbDocumentStatus.ARCHIVED })
                    : buildDocument({ id: 'live' }),
            );
            jest.spyOn(service, 'semanticSearch').mockResolvedValue([
                { documentId: 'archived' },
                { documentId: 'live' },
            ] as never);
        });

        it('still returns an archived document from query retrieval by default', async () => {
            const bundle = await service.resolveContext(WORK_ID, { query: 'refunds' });
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['archived', 'live']);
        });

        it('keeps an archived decision (archived through the review action) as a demoted historical hit', async () => {
            docRepo.findById.mockImplementation(async (_workId: string, id: string) =>
                id === 'archived'
                    ? buildDocument({
                          id: 'archived',
                          kbDocumentClass: KbDocumentClass.DECISION,
                          status: KbDocumentStatus.ARCHIVED,
                          decision: { status: KbDecisionStatus.ARCHIVED },
                      })
                    : buildDocument({ id: 'live' }),
            );
            const bundle = await service.resolveContext(WORK_ID, { query: 'refunds' });
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['live', 'archived']);
        });

        it('never injects an archived document, even on a direct semantic hit, when the caller opts in', async () => {
            const bundle = await service.resolveContext(WORK_ID, {
                query: 'refunds',
                excludeArchived: true,
            });
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['live']);
        });
    });
});
