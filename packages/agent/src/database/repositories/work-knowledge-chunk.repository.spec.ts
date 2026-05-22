import { ChunkUpsertInput, WorkKnowledgeChunkRepository } from './work-knowledge-chunk.repository';
import { WorkKnowledgeChunk } from '../../entities/work-knowledge-chunk.entity';

describe('WorkKnowledgeChunkRepository', () => {
    let repository: {
        find: jest.Mock;
        count: jest.Mock;
        manager: {
            transaction: jest.Mock;
        };
    };
    let txManager: {
        delete: jest.Mock;
        create: jest.Mock;
        insert: jest.Mock;
    };
    let chunkRepo: WorkKnowledgeChunkRepository;

    beforeEach(() => {
        txManager = {
            delete: jest.fn().mockResolvedValue({ affected: 0 }),
            // Mirror real EntityManager.create: returns its second arg
            // shape with the entity constructor applied (we just echo it).
            create: jest.fn((_entity: unknown, value: unknown) => value),
            insert: jest.fn().mockResolvedValue({ identifiers: [] }),
        };
        repository = {
            find: jest.fn(),
            count: jest.fn(),
            manager: {
                transaction: jest.fn(async (callback: (m: unknown) => unknown) =>
                    callback(txManager),
                ),
            },
        };
        chunkRepo = new WorkKnowledgeChunkRepository(repository as never);
    });

    describe('replaceForDocument', () => {
        it('runs delete-then-insert inside a single transaction', async () => {
            const chunks: ChunkUpsertInput[] = [
                {
                    id: 'chunk-1',
                    documentId: 'doc-1',
                    chunkIndex: 0,
                    content: 'first',
                    tokenCount: 2,
                },
                {
                    id: 'chunk-2',
                    documentId: 'doc-1',
                    chunkIndex: 1,
                    content: 'second',
                    tokenCount: 3,
                },
            ];

            await chunkRepo.replaceForDocument('work-1', 'doc-1', chunks);

            expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
            expect(txManager.delete).toHaveBeenCalledTimes(1);
            expect(txManager.delete).toHaveBeenCalledWith(WorkKnowledgeChunk, {
                workId: 'work-1',
                documentId: 'doc-1',
            });
            expect(txManager.insert).toHaveBeenCalledTimes(1);
            expect(txManager.insert).toHaveBeenCalledWith(WorkKnowledgeChunk, [
                expect.objectContaining({
                    id: 'chunk-1',
                    workId: 'work-1',
                    documentId: 'doc-1',
                    chunkIndex: 0,
                    content: 'first',
                    tokenCount: 2,
                    embedding: null,
                    metadata: null,
                }),
                expect.objectContaining({
                    id: 'chunk-2',
                    workId: 'work-1',
                    documentId: 'doc-1',
                    chunkIndex: 1,
                    content: 'second',
                    tokenCount: 3,
                }),
            ]);
        });

        it('skips the insert when chunks is empty but still issues the delete', async () => {
            await chunkRepo.replaceForDocument('work-1', 'doc-1', []);

            expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
            expect(txManager.delete).toHaveBeenCalledWith(WorkKnowledgeChunk, {
                workId: 'work-1',
                documentId: 'doc-1',
            });
            expect(txManager.insert).not.toHaveBeenCalled();
        });

        it('forwards embedding and metadata when provided', async () => {
            const chunks: ChunkUpsertInput[] = [
                {
                    id: 'chunk-1',
                    documentId: 'doc-1',
                    chunkIndex: 0,
                    content: 'one',
                    tokenCount: 1,
                    embedding: [0.1, 0.2, 0.3],
                    metadata: { headingPath: ['Brand voice'], charRange: { start: 0, end: 3 } },
                },
            ];

            await chunkRepo.replaceForDocument('work-1', 'doc-1', chunks);

            const [, inserted] = txManager.insert.mock.calls[0];
            expect(inserted[0]).toEqual(
                expect.objectContaining({
                    embedding: [0.1, 0.2, 0.3],
                    metadata: { headingPath: ['Brand voice'], charRange: { start: 0, end: 3 } },
                }),
            );
        });

        it("overrides the caller's workId on every row to keep the partition invariant", async () => {
            // Even if a caller bug somehow stamps a wrong workId on the
            // input (shouldn't be possible since the input shape doesn't
            // carry one, but the entity does), the repo must scrub it
            // and use the function arg.
            const chunks: ChunkUpsertInput[] = [
                {
                    id: 'chunk-1',
                    documentId: 'doc-1',
                    chunkIndex: 0,
                    content: 'one',
                    tokenCount: 1,
                },
            ];

            await chunkRepo.replaceForDocument('work-1', 'doc-1', chunks);

            const [, inserted] = txManager.insert.mock.calls[0];
            expect(inserted[0].workId).toBe('work-1');
        });

        it('lets transaction errors propagate', async () => {
            const boom = new Error('insert failed');
            txManager.insert.mockRejectedValueOnce(boom);

            await expect(
                chunkRepo.replaceForDocument('work-1', 'doc-1', [
                    {
                        id: 'chunk-1',
                        documentId: 'doc-1',
                        chunkIndex: 0,
                        content: 'one',
                        tokenCount: 1,
                    },
                ]),
            ).rejects.toBe(boom);
        });
    });

    describe('findByWorkAndDocument', () => {
        it('queries by workId+documentId, ordered by chunkIndex ASC', async () => {
            const row = { id: 'chunk-1' } as WorkKnowledgeChunk;
            repository.find.mockResolvedValue([row]);

            const out = await chunkRepo.findByWorkAndDocument('work-1', 'doc-1');

            expect(repository.find).toHaveBeenCalledWith({
                where: { workId: 'work-1', documentId: 'doc-1' },
                order: { chunkIndex: 'ASC' },
            });
            expect(out).toEqual([row]);
        });
    });

    describe('countByWork', () => {
        it('counts all chunks for a work', async () => {
            repository.count.mockResolvedValue(7);

            const out = await chunkRepo.countByWork('work-1');

            expect(repository.count).toHaveBeenCalledWith({ where: { workId: 'work-1' } });
            expect(out).toBe(7);
        });
    });
});
