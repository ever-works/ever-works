import { Test, TestingModule } from '@nestjs/testing';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from '../../tasks/kb-org-overlay-fanout-dispatcher';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { WorkOwnershipService } from '../work-ownership.service';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbReviewState,
} from '../../entities/kb-types';

/**
 * Org Memory review actions — `rejectOrgDocument` and the queue filter
 * that makes it visible.
 *
 * Rejecting is the one verb on the review surface that removes something
 * from a human's attention, so the properties that matter are the ones
 * that would be silently wrong:
 *
 *  - it ARCHIVES rather than deletes (consolidation never deletes, and
 *    neither may this);
 *  - it leaves `reviewState` at `proposed`, because every other review
 *    gate in the codebase is a `!== 'proposed'` DENY list — moving the
 *    state to something new would make rejected text injectable;
 *  - it does NOT churn every Work's git repo for a document that was
 *    never fanned out in the first place;
 *  - but it DOES retract one that had already been accepted;
 *  - and it is scoped: a document id from another Organization is not
 *    writable and is reported as "not found" with no existence leak.
 */

const ORG_ID = '00000000-0000-0000-0000-0000000000c1';
const OTHER_ORG_ID = '00000000-0000-0000-0000-0000000000c9';
const USER_ID = '00000000-0000-0000-0000-0000000000c2';
const DOC_ID = '00000000-0000-0000-0000-0000000000c3';

function buildOrgDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: DOC_ID,
        // Org-scoped rows are exactly those with a null workId.
        workId: null,
        organizationId: ORG_ID,
        path: 'legal/terms.md',
        slug: 'terms',
        title: 'Terms',
        description: null,
        kbDocumentClass: KbDocumentClass.LEGAL,
        tags: null,
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 0,
        tokenCount: 0,
        source: KbDocumentSource.AGENT,
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: USER_ID,
        updatedById: USER_ID,
        lastIndexedAt: null,
        lastCommitSha: null,
        metadata: { body: 'body' },
        consolidation: null,
        decision: null,
        reviewState: KbReviewState.PROPOSED,
        createdAt: new Date('2026-07-30T09:00:00Z'),
        updatedAt: new Date('2026-07-30T09:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

describe('KnowledgeBaseService — org Memory review actions', () => {
    let service: KnowledgeBaseService;
    let docRepo: jest.Mocked<WorkKnowledgeDocumentRepository>;
    let fanout: { dispatchKbOrgOverlayFanout: jest.Mock };

    beforeEach(async () => {
        const docRepoMock: Partial<jest.Mocked<WorkKnowledgeDocumentRepository>> = {
            list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            findOrgById: jest.fn(),
            update: jest.fn(),
        };
        fanout = { dispatchKbOrgOverlayFanout: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                { provide: WorkKnowledgeDocumentRepository, useValue: docRepoMock },
                {
                    provide: WorkKnowledgeUploadRepository,
                    useValue: { findById: jest.fn(), create: jest.fn(), update: jest.fn() },
                },
                {
                    provide: WorkKnowledgeTagRepository,
                    useValue: { list: jest.fn().mockResolvedValue([]) },
                },
                {
                    provide: WorkKnowledgeCitationRepository,
                    useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                },
                {
                    provide: WorkOwnershipService,
                    useValue: {
                        ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' }),
                        ensureCanEdit: jest.fn().mockResolvedValue({ role: 'editor' }),
                    },
                },
                {
                    provide: KB_STORAGE_PLUGIN,
                    useValue: { isAvailable: jest.fn().mockResolvedValue(true) },
                },
                { provide: ActivityLogService, useValue: { log: jest.fn() } },
                {
                    provide: KB_EMBED_DOCUMENT_DISPATCHER,
                    useValue: { dispatchKbEmbedDocument: jest.fn() },
                },
                { provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER, useValue: fanout },
                {
                    provide: WorkRepository,
                    useValue: { findIdsByOrganization: jest.fn().mockResolvedValue(['work-1']) },
                },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
    });

    afterEach(() => jest.restoreAllMocks());

    describe('listOrgReviewQueue', () => {
        it('excludes archived documents so a rejected one leaves the queue', async () => {
            await service.listOrgReviewQueue(ORG_ID, { limit: 50, offset: 0 });

            // Without this filter, reject (which archives) would be a
            // visual no-op: the row would come straight back on reload.
            expect(docRepo.list).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationId: ORG_ID,
                    reviewState: KbReviewState.PROPOSED,
                    statuses: [KbDocumentStatus.DRAFT, KbDocumentStatus.ACTIVE],
                }),
            );
            const [call] = docRepo.list.mock.calls;
            expect(call[0].statuses).not.toContain(KbDocumentStatus.ARCHIVED);
        });
    });

    describe('rejectOrgDocument', () => {
        it('archives the document and never deletes it', async () => {
            const doc = buildOrgDocument();
            docRepo.findOrgById.mockResolvedValue(doc);
            docRepo.update.mockResolvedValue(
                buildOrgDocument({ status: KbDocumentStatus.ARCHIVED }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            expect(docRepo.update).toHaveBeenCalledWith(DOC_ID, {
                status: KbDocumentStatus.ARCHIVED,
                updatedById: USER_ID,
            });
            // There is no delete on the repository mock at all; asserting
            // the patch shape is what pins "archive, not remove".
            expect(docRepo.update).toHaveBeenCalledTimes(1);
        });

        it('leaves reviewState at proposed so every existing deny-list gate still withholds it', async () => {
            docRepo.findOrgById.mockResolvedValue(buildOrgDocument());
            docRepo.update.mockResolvedValue(
                buildOrgDocument({ status: KbDocumentStatus.ARCHIVED }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            const patch = docRepo.update.mock.calls[0][1];
            expect(patch).not.toHaveProperty('reviewState');
        });

        it('scopes the lookup to the Organization before writing', async () => {
            docRepo.findOrgById.mockResolvedValue(buildOrgDocument());
            docRepo.update.mockResolvedValue(
                buildOrgDocument({ status: KbDocumentStatus.ARCHIVED }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            // `update` keys on the id alone, so the org-scoped re-fetch is
            // the only thing standing between a foreign id and a write.
            expect(docRepo.findOrgById).toHaveBeenCalledWith(ORG_ID, DOC_ID);
        });

        it("returns null — and writes nothing — for another Organization's document", async () => {
            docRepo.findOrgById.mockResolvedValue(null);

            const result = await service.rejectOrgDocument(OTHER_ORG_ID, DOC_ID, USER_ID);

            expect(result).toBeNull();
            expect(docRepo.update).not.toHaveBeenCalled();
        });

        it('retracts a PROPOSED inheritable document — the create path already fanned it out', async () => {
            // The trap this pins: it is tempting to assume a proposed doc
            // was never overlaid and so needs no retraction. False —
            // `createOrgDocument` enqueues the fanout gated on class ALONE,
            // so a proposed inheritable doc is already materialized in
            // every Work's data repo. Skipping the delete would strand the
            // file in N repositories with nothing pointing at it.
            docRepo.findOrgById.mockResolvedValue(
                buildOrgDocument({
                    reviewState: KbReviewState.PROPOSED,
                    kbDocumentClass: KbDocumentClass.LEGAL,
                }),
            );
            docRepo.update.mockResolvedValue(
                buildOrgDocument({ status: KbDocumentStatus.ARCHIVED }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            expect(fanout.dispatchKbOrgOverlayFanout).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'delete' }),
            );
        });

        it('DOES retract a previously accepted inheritable document', async () => {
            // This one really is in every Work; leaving it there would let
            // an archived document keep teaching agents forever.
            docRepo.findOrgById.mockResolvedValue(
                buildOrgDocument({
                    reviewState: KbReviewState.ACCEPTED,
                    kbDocumentClass: KbDocumentClass.LEGAL,
                }),
            );
            docRepo.update.mockResolvedValue(
                buildOrgDocument({
                    reviewState: KbReviewState.ACCEPTED,
                    status: KbDocumentStatus.ARCHIVED,
                }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            expect(fanout.dispatchKbOrgOverlayFanout).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'delete' }),
            );
        });

        it('does not retract a previously accepted NON-inheritable document', async () => {
            // Non-inheritable classes are never written into a Work in the
            // first place — the create/accept paths gate on exactly this.
            docRepo.findOrgById.mockResolvedValue(
                buildOrgDocument({
                    reviewState: KbReviewState.ACCEPTED,
                    kbDocumentClass: KbDocumentClass.OUTPUT,
                }),
            );
            docRepo.update.mockResolvedValue(
                buildOrgDocument({
                    reviewState: KbReviewState.ACCEPTED,
                    kbDocumentClass: KbDocumentClass.OUTPUT,
                    status: KbDocumentStatus.ARCHIVED,
                }),
            );

            await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            expect(fanout.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
        });

        it('is idempotent: rejecting an already-archived document writes nothing', async () => {
            docRepo.findOrgById.mockResolvedValue(
                buildOrgDocument({ status: KbDocumentStatus.ARCHIVED }),
            );

            const result = await service.rejectOrgDocument(ORG_ID, DOC_ID, USER_ID);

            expect(result).not.toBeNull();
            expect(docRepo.update).not.toHaveBeenCalled();
            expect(fanout.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
        });
    });
});
