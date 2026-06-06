/**
 * EW-642 slice 2 — unit tests for the vector-store-facade migration of
 * `KnowledgeBaseService`.
 *
 * Coverage:
 *   - `semanticSearch` routes through `VectorStoreFacadeService.queryChunks`
 *     and maps `QueryHit[]` back to the legacy `{ id, workId, documentId,
 *     chunkIndex, content, distance }` shape kb-rrf.ts consumes.
 *   - `upsertChunks` upserts the platform-side `WorkKnowledgeChunkCoordinate`
 *     row with the resolved plugin's `id`, the chunk count, embedding
 *     model + dims.
 *   - `deleteChunksByDocument` clears the coordinate row.
 *   - `VectorStoreNotConfiguredError` degrades to lexical-only (returns
 *     `[]` rather than throwing 500) and only logs a warning once per
 *     service instance.
 *
 * Mirrors the isolation level of `knowledge-base-transcribe.service.spec.ts`
 * — every dependency is mocked, no DB or Trigger.dev wiring.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeBaseService } from './knowledge-base.service';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { WorkKnowledgeChunkCoordinateRepository } from '../database/repositories/work-knowledge-chunk-coordinate.repository';
import { WorkOwnershipService } from './work-ownership.service';
import { AiFacadeService } from '../facades/ai.facade';
import {
    VectorStoreFacadeService,
    VectorStoreNotConfiguredError,
} from '../facades/vector-store.facade';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const DOC_ID = '00000000-0000-0000-0000-000000000010';

describe('KnowledgeBaseService — vector-store facade migration', () => {
    let service: KnowledgeBaseService;
    let vectorStoreFacade: {
        select: jest.Mock;
        queryChunks: jest.Mock;
        upsertChunks: jest.Mock;
        deleteByDocument: jest.Mock;
        deleteByWork: jest.Mock;
    };
    let resolvedPlugin: { id: string; upsertChunks: jest.Mock };
    let chunkCoordinateRepo: {
        upsert: jest.Mock;
        deleteByDocument: jest.Mock;
        deleteByWork: jest.Mock;
    };
    let aiFacade: { embed: jest.Mock };
    let ownership: { ensureCanView: jest.Mock; ensureCanEdit: jest.Mock };

    beforeEach(async () => {
        resolvedPlugin = {
            id: 'pgvector',
            upsertChunks: jest.fn().mockResolvedValue({ written: 0, skipped: 0 }),
        };
        vectorStoreFacade = {
            select: jest.fn().mockResolvedValue(resolvedPlugin),
            queryChunks: jest.fn(),
            upsertChunks: jest.fn(),
            deleteByDocument: jest.fn().mockResolvedValue(undefined),
            deleteByWork: jest.fn().mockResolvedValue(undefined),
        };

        chunkCoordinateRepo = {
            upsert: jest.fn().mockResolvedValue(undefined),
            deleteByDocument: jest.fn().mockResolvedValue(undefined),
            deleteByWork: jest.fn().mockResolvedValue(undefined),
        };

        aiFacade = {
            embed: jest.fn().mockResolvedValue({
                embeddings: [[0.1, 0.2, 0.3]],
                model: 'text-embedding-3-small',
            }),
        };

        ownership = {
            ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' }),
            ensureCanEdit: jest.fn().mockResolvedValue({ role: 'editor' }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                {
                    provide: WorkKnowledgeDocumentRepository,
                    useValue: { findById: jest.fn() },
                },
                { provide: WorkKnowledgeUploadRepository, useValue: {} },
                { provide: WorkKnowledgeTagRepository, useValue: { upsertBySlug: jest.fn() } },
                { provide: WorkKnowledgeCitationRepository, useValue: {} },
                { provide: WorkOwnershipService, useValue: ownership },
                { provide: AiFacadeService, useValue: aiFacade },
                { provide: VectorStoreFacadeService, useValue: vectorStoreFacade },
                {
                    provide: WorkKnowledgeChunkCoordinateRepository,
                    useValue: chunkCoordinateRepo,
                },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
    });

    describe('semanticSearch', () => {
        it('routes through VectorStoreFacadeService.queryChunks and maps QueryHit[] back to the legacy distance shape', async () => {
            vectorStoreFacade.queryChunks.mockResolvedValue({
                hits: [
                    {
                        chunk: {
                            id: 'c1',
                            workId: WORK_ID,
                            documentId: 'd1',
                            chunkIndex: 0,
                            content: 'chunk one',
                            tokenCount: 10,
                        },
                        rawScore: 0.05,
                        normalizedScore: 0.95,
                        rank: 1,
                    },
                    {
                        chunk: {
                            id: 'c2',
                            workId: WORK_ID,
                            documentId: 'd2',
                            chunkIndex: 1,
                            content: 'chunk two',
                            tokenCount: 12,
                        },
                        rawScore: 0.2,
                        normalizedScore: 0.8,
                        rank: 2,
                    },
                ],
            });

            const result = await service.semanticSearch(WORK_ID, 'hello world', 5);

            expect(aiFacade.embed).toHaveBeenCalledWith(
                { input: 'hello world' },
                expect.objectContaining({ workId: WORK_ID, userId: 'kb-search-system' }),
            );
            expect(vectorStoreFacade.queryChunks).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    queryEmbedding: [0.1, 0.2, 0.3],
                    topK: 5,
                }),
                expect.objectContaining({ workId: WORK_ID, userId: 'kb-search-system' }),
            );

            // Best-first order preserved (the row-30c RRF blend treats
            // the array position as the ordinal rank).
            expect(result).toEqual([
                {
                    id: 'c1',
                    workId: WORK_ID,
                    documentId: 'd1',
                    chunkIndex: 0,
                    content: 'chunk one',
                    // 1 - 0.95 = 0.05 — monotone with rank, no
                    // pgvector-cosine specifics leaking through.
                    distance: expect.closeTo(0.05),
                },
                {
                    id: 'c2',
                    workId: WORK_ID,
                    documentId: 'd2',
                    chunkIndex: 1,
                    content: 'chunk two',
                    distance: expect.closeTo(0.2),
                },
            ]);
        });

        it('degrades to lexical-only when VectorStoreNotConfiguredError is thrown', async () => {
            vectorStoreFacade.queryChunks.mockRejectedValue(
                new VectorStoreNotConfiguredError('No vector-store plugin registered', undefined),
            );

            const result = await service.semanticSearch(WORK_ID, 'hi', 5);

            expect(result).toEqual([]);
            // Caller (listDocuments) sees `[]` and uses the lexical-only
            // branch of its RRF blend — no exception bubbles up to the
            // HTTP layer.
            expect(vectorStoreFacade.queryChunks).toHaveBeenCalledTimes(1);
        });

        it('only logs the degradation warning once per service instance', async () => {
            vectorStoreFacade.queryChunks.mockRejectedValue(
                new VectorStoreNotConfiguredError('No vector-store plugin registered'),
            );
            const warnSpy = jest
                .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
                .mockImplementation(() => undefined);

            await service.semanticSearch(WORK_ID, 'hi', 5);
            await service.semanticSearch(WORK_ID, 'hello', 5);
            await service.semanticSearch(WORK_ID, 'again', 5);

            // 3 calls, but only the first logs.
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toMatch(/no vector-store plugin configured/i);
        });

        it('returns [] (no embedder call) for empty/whitespace queries', async () => {
            const result = await service.semanticSearch(WORK_ID, '   ', 5);

            expect(result).toEqual([]);
            expect(aiFacade.embed).not.toHaveBeenCalled();
            expect(vectorStoreFacade.queryChunks).not.toHaveBeenCalled();
        });
    });

    describe('upsertChunks', () => {
        it('writes chunks via the resolved plugin and stamps the coordinate row', async () => {
            resolvedPlugin.upsertChunks.mockResolvedValue({ written: 2, skipped: 0 });

            const result = await service.upsertChunks({
                workId: WORK_ID,
                documentId: DOC_ID,
                userId: USER_ID,
                chunks: [
                    {
                        id: 'chunk-1',
                        chunkIndex: 0,
                        content: 'first',
                        tokenCount: 4,
                        embedding: [0.1, 0.2],
                    },
                    {
                        id: 'chunk-2',
                        chunkIndex: 1,
                        content: 'second',
                        tokenCount: 5,
                        embedding: [0.3, 0.4],
                    },
                ],
                embeddingModel: 'text-embedding-3-small',
                embeddingDims: 2,
            });

            expect(vectorStoreFacade.select).toHaveBeenCalledWith(
                expect.objectContaining({ workId: WORK_ID, userId: USER_ID }),
            );
            // The resolved plugin's `upsertChunks` got the (workId,
            // documentId, chunks) shape, with each chunk carrying its
            // workId + documentId pinned from the input.
            expect(resolvedPlugin.upsertChunks).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    documentId: DOC_ID,
                    chunks: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'chunk-1',
                            workId: WORK_ID,
                            documentId: DOC_ID,
                            chunkIndex: 0,
                            embedding: [0.1, 0.2],
                        }),
                    ]),
                }),
            );

            // Coordinate row stamped with plugin id + chunk count +
            // embedding metadata.
            expect(chunkCoordinateRepo.upsert).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: DOC_ID,
                vectorStoreId: 'pgvector',
                chunkCount: 2,
                embeddingModel: 'text-embedding-3-small',
                embeddingDims: 2,
            });

            expect(result).toEqual({ written: 2, skipped: 0 });
        });

        it('logs a warning when the coordinate stamp fails but does NOT roll back the vector write', async () => {
            resolvedPlugin.upsertChunks.mockResolvedValue({ written: 1, skipped: 0 });
            chunkCoordinateRepo.upsert.mockRejectedValue(new Error('coord write timeout'));

            const warnSpy = jest
                .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
                .mockImplementation(() => undefined);

            await expect(
                service.upsertChunks({
                    workId: WORK_ID,
                    documentId: DOC_ID,
                    userId: USER_ID,
                    chunks: [
                        {
                            id: 'c1',
                            chunkIndex: 0,
                            content: 'x',
                            tokenCount: 1,
                            embedding: [0.1],
                        },
                    ],
                    embeddingModel: 'text-embedding-3-small',
                    embeddingDims: 1,
                }),
            ).resolves.toEqual({ written: 1, skipped: 0 });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('coordinate stamp failed'),
            );
        });

        it('selects the plugin via the facade and uses its id as vectorStoreId', async () => {
            // Override the plugin id so we can prove vectorStoreId
            // actually flows from `plugin.id`, not from a hardcoded string.
            const fakePlugin = {
                id: 'qdrant',
                providerType: 'qdrant',
                providerName: 'Qdrant',
                upsertChunks: jest.fn().mockResolvedValue({ written: 1, skipped: 0 }),
            };
            vectorStoreFacade.select.mockResolvedValueOnce(fakePlugin);

            await service.upsertChunks({
                workId: WORK_ID,
                documentId: DOC_ID,
                userId: USER_ID,
                chunks: [
                    {
                        id: 'c1',
                        chunkIndex: 0,
                        content: 'x',
                        tokenCount: 1,
                        embedding: [0.1],
                    },
                ],
                embeddingModel: 'text-embedding-3-large',
                embeddingDims: 3072,
            });

            expect(chunkCoordinateRepo.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    vectorStoreId: 'qdrant',
                    embeddingModel: 'text-embedding-3-large',
                    embeddingDims: 3072,
                }),
            );
        });
    });

    describe('deleteChunksByDocument', () => {
        it('clears the vector store + the coordinate row', async () => {
            await service.deleteChunksByDocument({
                workId: WORK_ID,
                documentId: DOC_ID,
                userId: USER_ID,
            });

            expect(vectorStoreFacade.deleteByDocument).toHaveBeenCalledWith(
                { workId: WORK_ID, documentId: DOC_ID },
                expect.objectContaining({ workId: WORK_ID, userId: USER_ID }),
            );
            expect(chunkCoordinateRepo.deleteByDocument).toHaveBeenCalledWith(WORK_ID, DOC_ID);
        });

        it('still clears the coordinate row when the vector store reports not-configured', async () => {
            vectorStoreFacade.deleteByDocument.mockRejectedValueOnce(
                new VectorStoreNotConfiguredError('no plugin'),
            );

            await service.deleteChunksByDocument({
                workId: WORK_ID,
                documentId: DOC_ID,
                userId: USER_ID,
            });

            // VectorStoreNotConfigured → swallowed, log-once, coordinate
            // delete still runs so the platform-side row doesn't leak.
            expect(chunkCoordinateRepo.deleteByDocument).toHaveBeenCalledWith(WORK_ID, DOC_ID);
        });
    });

    describe('deleteChunksByWork', () => {
        it('clears the vector store + every coordinate row for the Work', async () => {
            await service.deleteChunksByWork({ workId: WORK_ID, userId: USER_ID });

            expect(vectorStoreFacade.deleteByWork).toHaveBeenCalledWith(
                { workId: WORK_ID },
                expect.objectContaining({ workId: WORK_ID, userId: USER_ID }),
            );
            expect(chunkCoordinateRepo.deleteByWork).toHaveBeenCalledWith(WORK_ID);
        });
    });
});
