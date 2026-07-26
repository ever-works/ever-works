import { Test, TestingModule } from '@nestjs/testing';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
import { KbRetrievalLogRepository } from '../../database/repositories/kb-retrieval-log.repository';
import { WorkOwnershipService } from '../work-ownership.service';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentSource, KbDocumentStatus } from '../../entities/kb-types';

/**
 * Memory facets — the filters and the search must be SERVER-side.
 *
 * That is the whole point of these tests: the KB list is paginated
 * upstream, so a chip that filters the already-fetched array would
 * quietly search only the page in the browser and confidently report
 * "no matches" for a document that exists. Every assertion below checks
 * that the option reached the repository query, not that the returned
 * array looks right.
 */

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const DOC_ID = '00000000-0000-0000-0000-000000000010';

function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: DOC_ID,
        workId: WORK_ID,
        organizationId: null,
        path: 'decision/context-store.md',
        slug: 'context-store',
        title: 'Context lives in files',
        description: null,
        kbDocumentClass: KbDocumentClass.DECISION,
        tags: null,
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 0,
        tokenCount: 0,
        source: KbDocumentSource.USER,
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: USER_ID,
        updatedById: USER_ID,
        lastIndexedAt: null,
        lastCommitSha: null,
        metadata: { body: 'We keep context in files.' },
        consolidation: null,
        decision: null,
        reviewState: null,
        createdAt: new Date('2026-07-01T12:00:00Z'),
        updatedAt: new Date('2026-07-01T12:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

describe('KnowledgeBaseService — memory facets + retrieval log', () => {
    let service: KnowledgeBaseService;
    let docRepo: jest.Mocked<WorkKnowledgeDocumentRepository>;
    let retrievalLog: { record: jest.Mock; listForWorkSince: jest.Mock };
    let citations: { listForDocument: jest.Mock; countForDocument: jest.Mock };

    beforeEach(async () => {
        const docRepoMock: Partial<jest.Mocked<WorkKnowledgeDocumentRepository>> = {
            findById: jest.fn(),
            findByPath: jest.fn(),
            findByWorkOrPath: jest.fn().mockResolvedValue(buildDocument()),
            list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            pathExists: jest.fn().mockResolvedValue(false),
            create: jest.fn(),
            update: jest.fn(),
        };
        retrievalLog = {
            record: jest.fn().mockResolvedValue(undefined),
            listForWorkSince: jest.fn().mockResolvedValue([]),
        };
        citations = {
            listForDocument: jest.fn().mockResolvedValue([]),
            countForDocument: jest.fn().mockResolvedValue(3),
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
                    useValue: { list: jest.fn().mockResolvedValue([]), findBySlug: jest.fn() },
                },
                { provide: WorkKnowledgeCitationRepository, useValue: citations },
                { provide: KbRetrievalLogRepository, useValue: retrievalLog },
                {
                    provide: WorkOwnershipService,
                    useValue: {
                        ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' }),
                        ensureCanEdit: jest.fn().mockResolvedValue({ role: 'editor' }),
                    },
                },
                {
                    provide: KB_STORAGE_PLUGIN,
                    useValue: {
                        providerName: 'local-fs',
                        putObject: jest.fn(),
                        getObject: jest.fn(),
                        deleteObject: jest.fn(),
                        isAvailable: jest.fn().mockResolvedValue(true),
                    },
                },
                { provide: ActivityLogService, useValue: { log: jest.fn() } },
                {
                    provide: KB_EMBED_DOCUMENT_DISPATCHER,
                    useValue: { dispatchKbEmbedDocument: jest.fn().mockResolvedValue('run-id') },
                },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
    });

    // ─── Facet filters ─────────────────────────────────────────────────

    it('pushes a multi-class chip selection into the repository query', async () => {
        await service.listDocuments(WORK_ID, USER_ID, {
            classes: [KbDocumentClass.DECISION, KbDocumentClass.OUTPUT],
        });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                classes: [KbDocumentClass.DECISION, KbDocumentClass.OUTPUT],
            }),
        );
    });

    it('pushes a multi-source chip selection into the repository query', async () => {
        await service.listDocuments(WORK_ID, USER_ID, {
            sources: [KbDocumentSource.AGENT, KbDocumentSource.IMPORTED],
        });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({
                sources: [KbDocumentSource.AGENT, KbDocumentSource.IMPORTED],
            }),
        );
    });

    it('keeps the legacy single-class option working unchanged', async () => {
        await service.listDocuments(WORK_ID, USER_ID, { class: KbDocumentClass.LEGAL });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({ classes: [KbDocumentClass.LEGAL] }),
        );
    });

    it('narrows to the intersection when both class and classes are supplied', async () => {
        await service.listDocuments(WORK_ID, USER_ID, {
            class: KbDocumentClass.DECISION,
            classes: [KbDocumentClass.DECISION, KbDocumentClass.OUTPUT],
        });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({ classes: [KbDocumentClass.DECISION] }),
        );
    });

    it('sends no class filter at all (never an empty IN list) when none was requested', async () => {
        await service.listDocuments(WORK_ID, USER_ID, { classes: [] });

        expect(docRepo.list).toHaveBeenCalledWith(expect.objectContaining({ classes: undefined }));
    });

    // ─── Search ────────────────────────────────────────────────────────

    it('searches the document BODY server-side when searchBody is set', async () => {
        docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });

        await service.listDocuments(WORK_ID, USER_ID, { q: 'rollback', searchBody: true });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({ q: 'rollback', searchBody: true }),
        );
    });

    it('carries the facet filters through the search path too', async () => {
        docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });

        await service.listDocuments(WORK_ID, USER_ID, {
            q: 'rollback',
            classes: [KbDocumentClass.DECISION],
            sources: [KbDocumentSource.AGENT],
        });

        expect(docRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({
                q: 'rollback',
                classes: [KbDocumentClass.DECISION],
                sources: [KbDocumentSource.AGENT],
            }),
        );
    });

    // ─── Retrieval log (M10) ───────────────────────────────────────────

    it('records what a context resolution injected, and for which question', async () => {
        docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });

        await service.resolveContext(WORK_ID, { consumerKind: 'pipeline' });
        // The write is fire-and-forget — let the microtask queue drain.
        await Promise.resolve();
        await Promise.resolve();

        expect(retrievalLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                consumerKind: 'pipeline',
                resultCount: expect.any(Number),
            }),
        );
    });

    it('never fails a context resolution when the retrieval-log write throws', async () => {
        retrievalLog.record.mockRejectedValue(new Error('table missing'));
        docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });

        await expect(service.resolveContext(WORK_ID, { query: 'x' })).resolves.toBeDefined();
    });

    // ─── "Ask why" trail (M11) ─────────────────────────────────────────

    it('returns only the retrieval events that actually injected the document', async () => {
        retrievalLog.listForWorkSince.mockResolvedValue([
            {
                createdAt: new Date('2026-07-20T10:00:00Z'),
                queryText: 'where does context live',
                resultCount: 2,
                documentIds: [DOC_ID, 'other'],
                consumerKind: 'pipeline',
            },
            {
                createdAt: new Date('2026-07-19T10:00:00Z'),
                queryText: 'unrelated',
                resultCount: 1,
                documentIds: ['other'],
                consumerKind: null,
            },
        ]);

        const trail = await service.getRetrievalTrail(WORK_ID, USER_ID, DOC_ID);

        expect(trail.documentId).toBe(DOC_ID);
        expect(trail.totalRetrievals).toBe(1);
        expect(trail.entries).toEqual([
            {
                at: '2026-07-20T10:00:00.000Z',
                query: 'where does context live',
                resultCount: 2,
                consumerKind: 'pipeline',
            },
        ]);
        expect(trail.citations).toBe(3);
    });

    it('404s for a document the Work does not own instead of returning an empty trail', async () => {
        docRepo.findByWorkOrPath.mockResolvedValue(null);

        await expect(service.getRetrievalTrail(WORK_ID, USER_ID, DOC_ID)).rejects.toThrow(
            /not found/i,
        );
    });
});
