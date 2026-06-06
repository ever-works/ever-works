import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeBaseReembedService } from './knowledge-base-reembed.service';
import { WorkKnowledgeChunkCoordinateRepository } from '../database/repositories/work-knowledge-chunk-coordinate.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { VectorStoreFacadeService } from '../facades/vector-store.facade';
import { AiFacadeService } from '../facades/ai.facade';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import type { KbReembedWorkPayload } from '../tasks/kb-reembed-work.types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const DOC_A = '00000000-0000-0000-0000-0000000000aa';
const DOC_B = '00000000-0000-0000-0000-0000000000bb';
const DOC_C = '00000000-0000-0000-0000-0000000000cc';

const OLD_MODEL = 'text-embedding-3-small';
const NEW_MODEL = 'text-embedding-3-large';
const OLD_DIMS = 1536;
const NEW_DIMS = 3072;

function makeCoord(documentId: string, embeddingModel: string) {
    return {
        workId: WORK_ID,
        documentId,
        vectorStoreId: 'pgvector',
        chunkCount: 1,
        embeddingModel,
        embeddingDims: OLD_DIMS,
        lastEmbeddedAt: new Date('2026-06-01T00:00:00Z'),
    };
}

function makeDoc(id: string, body: string) {
    return {
        id,
        workId: WORK_ID,
        createdById: 'user-1',
        metadata: { body } as Record<string, unknown>,
    };
}

describe('KnowledgeBaseReembedService', () => {
    let service: KnowledgeBaseReembedService;
    let coordinates: jest.Mocked<
        Pick<WorkKnowledgeChunkCoordinateRepository, 'listByWork' | 'upsert' | 'deleteByDocument'>
    >;
    let documents: jest.Mocked<Pick<WorkKnowledgeDocumentRepository, 'findById'>>;
    let vectorStoreFacade: {
        select: jest.Mock;
        upsertChunks: jest.Mock;
    };
    let aiFacade: { embed: jest.Mock };
    let activityLog: { log: jest.Mock };

    const payload: KbReembedWorkPayload = {
        workId: WORK_ID,
        previousModel: OLD_MODEL,
        newModel: NEW_MODEL,
        newDims: NEW_DIMS,
    };

    /**
     * Plugin used in tests — `embedsOnWrite: false` so
     * `EmbeddingModeResolver` resolves to `'platform'`, which forces the
     * service through the `AiFacadeService.embed` lane (the most
     * commonly exercised production path).
     */
    const resolvedPlugin = {
        id: 'pgvector',
        vectorCapabilities: {
            embedsOnWrite: false,
        },
    };

    beforeEach(async () => {
        coordinates = {
            listByWork: jest.fn(),
            upsert: jest.fn().mockResolvedValue(undefined),
            deleteByDocument: jest.fn().mockResolvedValue(undefined),
        };
        documents = {
            findById: jest.fn(),
        };
        vectorStoreFacade = {
            select: jest.fn().mockResolvedValue(resolvedPlugin),
            upsertChunks: jest.fn().mockResolvedValue({ written: 1, skipped: 0 }),
        };
        aiFacade = {
            embed: jest.fn(),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseReembedService,
                {
                    provide: WorkKnowledgeChunkCoordinateRepository,
                    useValue: coordinates,
                },
                { provide: WorkKnowledgeDocumentRepository, useValue: documents },
                { provide: VectorStoreFacadeService, useValue: vectorStoreFacade },
                { provide: AiFacadeService, useValue: aiFacade },
                { provide: ActivityLogService, useValue: activityLog },
            ],
        }).compile();

        service = module.get(KnowledgeBaseReembedService);
    });

    it('happy path: re-embeds both stale docs, updates coordinates, emits START + COMPLETED activity', async () => {
        coordinates.listByWork.mockResolvedValue([
            makeCoord(DOC_A, OLD_MODEL),
            makeCoord(DOC_B, OLD_MODEL),
        ] as any);
        documents.findById.mockImplementation(async (_workId: string, docId: string) => {
            if (docId === DOC_A) return makeDoc(DOC_A, '## Section A\nbody alpha') as any;
            if (docId === DOC_B) return makeDoc(DOC_B, '## Section B\nbody bravo') as any;
            return null;
        });
        // One chunk per doc → embed returns 1 vector per call.
        aiFacade.embed.mockResolvedValue({
            embeddings: [[0.1, 0.2, 0.3]],
            model: NEW_MODEL,
        });

        const result = await service.reembedWork(payload);

        expect(vectorStoreFacade.select).toHaveBeenCalledWith({
            workId: WORK_ID,
            userId: 'kb-reembed-system',
        });
        // Both docs were embedded (one batched embed call per doc).
        expect(aiFacade.embed).toHaveBeenCalledTimes(2);
        // Both docs were upserted into the vector store + coordinates.
        expect(vectorStoreFacade.upsertChunks).toHaveBeenCalledTimes(2);
        expect(coordinates.upsert).toHaveBeenCalledTimes(2);
        expect(coordinates.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                documentId: DOC_A,
                vectorStoreId: 'pgvector',
                embeddingModel: NEW_MODEL,
                embeddingDims: NEW_DIMS,
            }),
        );
        expect(result).toMatchObject({
            workId: WORK_ID,
            documentsReembedded: 2,
            documentsSkipped: 0,
            fromModel: OLD_MODEL,
            toModel: NEW_MODEL,
        });
        expect(result.chunksReembedded).toBeGreaterThan(0);

        // Activity-log lifecycle — STARTED + COMPLETED.
        const actions = activityLog.log.mock.calls.map((c) => c[0].actionType);
        expect(actions).toContain(ActivityActionType.KB_REEMBED_STARTED);
        expect(actions).toContain(ActivityActionType.KB_REEMBED_COMPLETED);
        const startCall = activityLog.log.mock.calls.find(
            (c) => c[0].actionType === ActivityActionType.KB_REEMBED_STARTED,
        );
        expect(startCall?.[0]).toMatchObject({
            status: ActivityStatus.IN_PROGRESS,
            details: expect.objectContaining({
                count: 2,
                fromModel: OLD_MODEL,
                toModel: NEW_MODEL,
            }),
        });
        const completeCall = activityLog.log.mock.calls.find(
            (c) => c[0].actionType === ActivityActionType.KB_REEMBED_COMPLETED,
        );
        expect(completeCall?.[0]).toMatchObject({
            status: ActivityStatus.COMPLETED,
            details: expect.objectContaining({
                documentsReembedded: 2,
                fromModel: OLD_MODEL,
                toModel: NEW_MODEL,
            }),
        });
    });

    it('idempotency: a coordinate row already on newModel is skipped (no fetch, no embed, no upsert)', async () => {
        coordinates.listByWork.mockResolvedValue([
            makeCoord(DOC_A, OLD_MODEL),
            // DOC_C is already on the target model — must be skipped.
            makeCoord(DOC_C, NEW_MODEL),
        ] as any);
        documents.findById.mockImplementation(async (_workId: string, docId: string) => {
            if (docId === DOC_A) return makeDoc(DOC_A, '## hi\nbody') as any;
            return null;
        });
        aiFacade.embed.mockResolvedValue({
            embeddings: [[0.1, 0.2, 0.3]],
            model: NEW_MODEL,
        });

        const result = await service.reembedWork(payload);

        // Only the stale doc was looked up + embedded + upserted.
        expect(documents.findById).toHaveBeenCalledTimes(1);
        expect(documents.findById).toHaveBeenCalledWith(WORK_ID, DOC_A);
        expect(aiFacade.embed).toHaveBeenCalledTimes(1);
        expect(vectorStoreFacade.upsertChunks).toHaveBeenCalledTimes(1);
        expect(coordinates.upsert).toHaveBeenCalledTimes(1);
        expect(coordinates.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: DOC_A }),
        );
        expect(result.documentsReembedded).toBe(1);
        expect(result.documentsSkipped).toBe(1);
    });

    it('failure: surfaces KB_REEMBED_FAILED activity event and rethrows the underlying error', async () => {
        coordinates.listByWork.mockResolvedValue([makeCoord(DOC_A, OLD_MODEL)] as any);
        documents.findById.mockResolvedValue(makeDoc(DOC_A, '## hi\nbody') as any);
        const boom = new Error('embedder 503');
        aiFacade.embed.mockRejectedValue(boom);

        await expect(service.reembedWork(payload)).rejects.toBe(boom);

        const actions = activityLog.log.mock.calls.map((c) => c[0].actionType);
        expect(actions).toContain(ActivityActionType.KB_REEMBED_STARTED);
        expect(actions).toContain(ActivityActionType.KB_REEMBED_FAILED);
        const failCall = activityLog.log.mock.calls.find(
            (c) => c[0].actionType === ActivityActionType.KB_REEMBED_FAILED,
        );
        expect(failCall?.[0]).toMatchObject({
            status: ActivityStatus.FAILED,
            details: expect.objectContaining({
                error: 'embedder 503',
                fromModel: OLD_MODEL,
                toModel: NEW_MODEL,
            }),
        });
        // Coordinates were NOT updated (the failed doc still on the old model).
        expect(coordinates.upsert).not.toHaveBeenCalled();
    });
});
