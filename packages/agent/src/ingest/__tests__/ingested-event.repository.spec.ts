import { IsNull } from 'typeorm';
import { computeDedupeKey, IngestedEventRepository } from '../ingested-event.repository';

describe('computeDedupeKey', () => {
    it('is deterministic for the same (userId, source, sourceEventId)', () => {
        const a = computeDedupeKey('user-1', 'slack-connector', 'evt-1');
        const b = computeDedupeKey('user-1', 'slack-connector', 'evt-1');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('scopes the identity per owner and length-prefixes segments against boundary collisions', () => {
        // Same (source, sourceEventId), different owner → different key.
        expect(computeDedupeKey('user-1', 'src', 'evt')).not.toBe(
            computeDedupeKey('user-2', 'src', 'evt'),
        );
        // ('ab','c') vs ('a','bc') must not collide (length-prefixed).
        expect(computeDedupeKey('u', 'ab', 'c')).not.toBe(computeDedupeKey('u', 'a', 'bc'));
    });
});

describe('IngestedEventRepository', () => {
    const baseData = {
        userId: 'user-1',
        source: 'slack-connector',
        sourceEventId: 'evt-1',
        kind: 'slack.message',
        occurredAt: new Date('2026-07-01T10:00:00.000Z'),
        payload: { text: 'hello' },
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let qb: any;
    let typeormRepo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let repository: IngestedEventRepository;

    beforeEach(() => {
        qb = {
            where: jest.fn(() => qb),
            andWhere: jest.fn(() => qb),
            orderBy: jest.fn(() => qb),
            take: jest.fn(() => qb),
            getMany: jest.fn(async () => []),
        };
        typeormRepo = {
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            save: jest.fn(async (data) => ({ id: 'row-1', ...data })),
            find: jest.fn(async () => []),
            update: jest.fn(async () => undefined),
            createQueryBuilder: jest.fn(() => qb),
        };
        repository = new IngestedEventRepository(typeormRepo as never);
    });

    it('createIfNew inserts a new row stamped with the computed dedupeKey', async () => {
        typeormRepo.findOne.mockResolvedValue(null);

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(true);
        const expectedKey = computeDedupeKey('user-1', 'slack-connector', 'evt-1');
        expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { dedupeKey: expectedKey } });
        expect(typeormRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({ dedupeKey: expectedKey, kind: 'slack.message' }),
        );
    });

    it('createIfNew dedupes: the same (source, sourceEventId) is inserted once', async () => {
        const existing = { id: 'row-1', ...baseData };
        typeormRepo.findOne.mockResolvedValue(existing);

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(false);
        expect(result.event).toBe(existing);
        expect(typeormRepo.save).not.toHaveBeenCalled();
    });

    it('createIfNew treats the unique-index race as the idempotent outcome', async () => {
        const winner = { id: 'row-winner', ...baseData };
        // Check-then-insert race: existence check misses, INSERT trips the
        // unique index, the re-read finds the row that won.
        typeormRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        typeormRepo.save.mockRejectedValue({ code: 'SQLITE_CONSTRAINT' });

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(false);
        expect(result.event).toBe(winner);
    });

    it('createIfNew rethrows non-unique-violation errors', async () => {
        typeormRepo.findOne.mockResolvedValue(null);
        typeormRepo.save.mockRejectedValue(new Error('connection reset'));

        await expect(repository.createIfNew(baseData)).rejects.toThrow('connection reset');
    });

    it('findUnprocessed reads oldest-first with the batch limit and processedAt IS NULL', async () => {
        await repository.findUnprocessed(25);

        expect(typeormRepo.find).toHaveBeenCalledWith({
            where: { processedAt: IsNull() },
            order: { occurredAt: 'ASC', createdAt: 'ASC' },
            take: 25,
        });
    });

    it('markProcessed stamps the row', async () => {
        const at = new Date('2026-07-02T00:00:00.000Z');
        await repository.markProcessed('row-1', at);

        expect(typeormRepo.update).toHaveBeenCalledWith('row-1', { processedAt: at });
    });

    // ── `workId` routing — the per-Work activity feed query ──────────

    it('findRecentByUser scopes to the owner and applies no extra filter by default', async () => {
        await repository.findRecentByUser('user-1');

        expect(qb.where).toHaveBeenCalledWith('event.userId = :userId', { userId: 'user-1' });
        expect(qb.andWhere).not.toHaveBeenCalled();
        expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('findRecentByUser keeps accepting a bare limit (the pre-filter call shape)', async () => {
        await repository.findRecentByUser('user-1', 5);
        expect(qb.take).toHaveBeenCalledWith(5);
    });

    it('findRecentByUser pushes the workId and source filters into SQL', async () => {
        await repository.findRecentByUser('user-1', {
            workId: 'work-1',
            source: 'slack-connector',
            limit: 10,
        });

        expect(qb.andWhere).toHaveBeenCalledWith('event.workId = :workId', { workId: 'work-1' });
        expect(qb.andWhere).toHaveBeenCalledWith('event.source = :source', {
            source: 'slack-connector',
        });
        expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('findRecentByWork applies the owner scope FIRST — another tenant Work returns an empty page, never their rows', async () => {
        await repository.findRecentByWork('user-1', 'not-my-work');

        expect(qb.where).toHaveBeenCalledWith('event.userId = :userId', { userId: 'user-1' });
        expect(qb.andWhere).toHaveBeenCalledWith('event.workId = :workId', {
            workId: 'not-my-work',
        });
    });

    it('findRecentByUser clamps the page size to 1..200', async () => {
        await repository.findRecentByUser('user-1', { limit: 5000 });
        expect(qb.take).toHaveBeenLastCalledWith(200);

        await repository.findRecentByUser('user-1', { limit: -1 });
        expect(qb.take).toHaveBeenLastCalledWith(1);
    });
});
