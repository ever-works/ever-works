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
            select: jest.fn(() => qb),
            where: jest.fn(() => qb),
            andWhere: jest.fn(() => qb),
            groupBy: jest.fn(() => qb),
            orderBy: jest.fn(() => qb),
            take: jest.fn(() => qb),
            limit: jest.fn(() => qb),
            getMany: jest.fn(async () => []),
            // Default: ONE owner has unprocessed work, which is the
            // short-circuit path (identical to the plain oldest-first
            // query). The fairness tests below override it.
            getRawMany: jest.fn(async () => [{ userId: 'user-1' }]),
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

    /**
     * The drain that consumes this is a five-minute cron with a fifty-row
     * batch, so a global `ORDER BY occurredAt ASC LIMIT n` means one
     * chatty source decides how long EVERY other customer waits: two
     * thousand rows from one flapping Sentry issue is forty ticks — over
     * three hours — during which a newly filed GitHub issue anywhere on
     * the deployment does not become a Task. That is the input that
     * silently swallows genuinely new work.
     */
    describe('findUnprocessed shares the batch between owners', () => {
        const rowFor = (userId: string, minute: number) =>
            ({
                id: `${userId}-${minute}`,
                userId,
                occurredAt: new Date(Date.UTC(2026, 8, 1, 12, minute)),
            }) as never;

        it('gives every waiting owner a share instead of a global FIFO head', async () => {
            qb.getRawMany.mockResolvedValue([{ userId: 'flooder' }, { userId: 'quiet-tenant' }]);
            typeormRepo.find.mockImplementation(async (options: any) => {
                const userId = options.where.userId as string;
                // The flooder has far more waiting rows AND older ones, so
                // a global FIFO would hand back nothing but theirs.
                return userId === 'flooder'
                    ? [rowFor('flooder', 0), rowFor('flooder', 1)]
                    : [rowFor('quiet-tenant', 30)];
            });

            const batch = await repository.findUnprocessed(4);

            expect(qb.getRawMany).toHaveBeenCalled();
            expect(batch.map((row) => row.userId)).toContain('quiet-tenant');
            // Per-owner reads are owner-scoped AND still oldest-first.
            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { processedAt: IsNull(), userId: 'flooder' },
                order: { occurredAt: 'ASC', createdAt: 'ASC' },
                take: 2,
            });
        });

        it('hands the merged batch back oldest-first and inside the limit', async () => {
            qb.getRawMany.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);
            typeormRepo.find.mockImplementation(async (options: any) =>
                options.where.userId === 'a'
                    ? [rowFor('a', 10), rowFor('a', 40)]
                    : [rowFor('b', 5), rowFor('b', 20)],
            );

            const batch = await repository.findUnprocessed(3);

            expect(batch).toHaveLength(3);
            expect(batch.map((row) => row.id)).toEqual(['b-5', 'a-10', 'b-20']);
        });

        it('falls back to the plain query when the owner scan is unavailable', async () => {
            qb.getRawMany.mockRejectedValue(new Error('no such function'));

            await repository.findUnprocessed(25);

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { processedAt: IsNull() },
                order: { occurredAt: 'ASC', createdAt: 'ASC' },
                take: 25,
            });
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
