import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
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
 * Memory upgrades M8 — the review queue's data path.
 *
 * The queue is "list the documents the platform captured but excluded
 * from injection". Two things must hold or the feature is a lie:
 *  - the `reviewState` filter reaches the repository (service layer), and
 *  - the repository turns it into a predicate that treats a NULL column
 *    as `accepted` (so pre-M7 rows never show up as review work).
 */

const WORK_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = '00000000-0000-0000-0000-0000000000a2';

function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: '00000000-0000-0000-0000-0000000000b1',
        workId: WORK_ID,
        organizationId: null,
        path: 'output/agent-note.md',
        slug: 'agent-note',
        title: 'Agent note',
        description: null,
        kbDocumentClass: KbDocumentClass.OUTPUT,
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
        metadata: { body: 'note body' },
        consolidation: null,
        decision: null,
        reviewState: KbReviewState.PROPOSED,
        createdAt: new Date('2026-07-02T09:00:00Z'),
        updatedAt: new Date('2026-07-02T09:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

describe('KnowledgeBaseService.listDocuments — reviewState filter (M8)', () => {
    let service: KnowledgeBaseService;
    let docRepo: jest.Mocked<WorkKnowledgeDocumentRepository>;

    beforeEach(async () => {
        const docRepoMock: Partial<jest.Mocked<WorkKnowledgeDocumentRepository>> = {
            list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            findById: jest.fn(),
        };

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
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
    });

    it('forwards reviewState=proposed to the repository', async () => {
        await service.listDocuments(WORK_ID, USER_ID, {
            reviewState: KbReviewState.PROPOSED,
            limit: 50,
        });
        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                reviewState: KbReviewState.PROPOSED,
                limit: 50,
            }),
        );
    });

    it('omits the filter entirely when reviewState is not supplied (additive)', async () => {
        await service.listDocuments(WORK_ID, USER_ID, {});
        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({ reviewState: undefined }),
        );
    });

    it('returns the proposed documents mapped through the DTO with reviewState carried', async () => {
        docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });
        const result = await service.listDocuments(WORK_ID, USER_ID, {
            reviewState: KbReviewState.PROPOSED,
        });
        expect(result.total).toBe(1);
        expect(result.items[0].reviewState).toBe('proposed');
        expect(result.items[0].source).toBe('agent');
    });
});

describe('WorkKnowledgeDocumentRepository.list — reviewState predicate (M8)', () => {
    let repo: WorkKnowledgeDocumentRepository;
    let qb: {
        andWhere: jest.Mock;
        orderBy: jest.Mock;
        take: jest.Mock;
        skip: jest.Mock;
        getCount: jest.Mock;
        getMany: jest.Mock;
    };

    beforeEach(async () => {
        qb = {
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            getCount: jest.fn().mockResolvedValue(0),
            getMany: jest.fn().mockResolvedValue([]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkKnowledgeDocumentRepository,
                {
                    provide: getRepositoryToken(WorkKnowledgeDocument),
                    useValue: { createQueryBuilder: jest.fn().mockReturnValue(qb) },
                },
            ],
        }).compile();

        repo = module.get(WorkKnowledgeDocumentRepository);
    });

    function predicates(): string[] {
        return qb.andWhere.mock.calls.map((call) => String(call[0]));
    }

    it('matches the column exactly for proposed', async () => {
        await repo.list({ workId: WORK_ID, reviewState: KbReviewState.PROPOSED });
        expect(predicates()).toContain('doc.reviewState = :reviewState');
        expect(qb.andWhere).toHaveBeenCalledWith('doc.reviewState = :reviewState', {
            reviewState: 'proposed',
        });
    });

    it('treats a NULL column as accepted', async () => {
        await repo.list({ workId: WORK_ID, reviewState: KbReviewState.ACCEPTED });
        expect(predicates()).toContain(
            '(doc.reviewState = :reviewState OR doc.reviewState IS NULL)',
        );
    });

    it('adds no review predicate when the filter is omitted', async () => {
        await repo.list({ workId: WORK_ID });
        expect(predicates().some((p) => p.includes('reviewState'))).toBe(false);
    });

    it('still enforces the mandatory tenant scope guard', async () => {
        await expect(repo.list({ reviewState: KbReviewState.PROPOSED })).rejects.toThrow(
            /requires workId or organizationId/,
        );
    });
});
