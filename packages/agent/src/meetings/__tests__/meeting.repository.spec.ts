import { computeMeetingDedupeKey, MeetingRepository } from '../meeting.repository';

describe('computeMeetingDedupeKey', () => {
    it('is deterministic for the same (userId, source, externalId)', () => {
        const a = computeMeetingDedupeKey('user-1', 'zoom', 'uuid-1');
        const b = computeMeetingDedupeKey('user-1', 'zoom', 'uuid-1');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('scopes the identity per owner and length-prefixes segments against boundary collisions', () => {
        // Same (source, externalId), different owner → different key.
        expect(computeMeetingDedupeKey('user-1', 'zoom', 'uuid-1')).not.toBe(
            computeMeetingDedupeKey('user-2', 'zoom', 'uuid-1'),
        );
        // ('ab','c') vs ('a','bc') must not collide (length-prefixed).
        expect(computeMeetingDedupeKey('u', 'ab', 'c')).not.toBe(
            computeMeetingDedupeKey('u', 'a', 'bc'),
        );
    });
});

describe('MeetingRepository', () => {
    const baseData = {
        userId: 'user-1',
        title: 'Weekly sync',
        startedAt: new Date('2026-07-24T10:00:00.000Z'),
        source: 'zoom' as const,
        externalId: 'uuid-1',
    };

    let queryBuilder: {
        where: jest.Mock;
        andWhere: jest.Mock;
        orderBy: jest.Mock;
        take: jest.Mock;
        skip: jest.Mock;
        getMany: jest.Mock;
    };
    let typeormRepo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let repository: MeetingRepository;

    beforeEach(() => {
        queryBuilder = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            getMany: jest.fn(async () => []),
        };
        typeormRepo = {
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            save: jest.fn(async (data) => ({ id: 'meeting-1', ...data })),
            update: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
            createQueryBuilder: jest.fn(() => queryBuilder),
        };
        repository = new MeetingRepository(typeormRepo as never);
    });

    it('createIfNew inserts a provider-synced meeting stamped with the computed dedupeKey', async () => {
        typeormRepo.findOne.mockResolvedValue(null);

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(true);
        const expectedKey = computeMeetingDedupeKey('user-1', 'zoom', 'uuid-1');
        expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { dedupeKey: expectedKey } });
        expect(typeormRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({
                dedupeKey: expectedKey,
                title: 'Weekly sync',
                participants: [],
            }),
        );
    });

    it('createIfNew dedupes: the same (source, externalId) is inserted once per owner', async () => {
        const existing = { id: 'meeting-1', ...baseData };
        typeormRepo.findOne.mockResolvedValue(existing);

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(false);
        expect(result.meeting).toBe(existing);
        expect(typeormRepo.save).not.toHaveBeenCalled();
    });

    it('createIfNew without an externalId always inserts (manual meetings never dedupe)', async () => {
        const result = await repository.createIfNew({
            ...baseData,
            source: 'manual',
            externalId: null,
        });

        expect(result.created).toBe(true);
        expect(typeormRepo.findOne).not.toHaveBeenCalled();
        expect(typeormRepo.save).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: null }));
    });

    it('createIfNew treats the unique-index race as the idempotent outcome', async () => {
        const winner = { id: 'meeting-winner', ...baseData };
        // Check-then-insert race: existence check misses, INSERT trips the
        // unique index, the re-read finds the row that won.
        typeormRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        typeormRepo.save.mockRejectedValueOnce({ driverError: { code: '23505' } });

        const result = await repository.createIfNew(baseData);

        expect(result.created).toBe(false);
        expect(result.meeting).toBe(winner);
    });

    it('findByUser is owner-scoped, newest-first, and applies the work/source filters', async () => {
        await repository.findByUser('user-1', { workId: 'work-9', source: 'zoom', limit: 5 });

        expect(queryBuilder.where).toHaveBeenCalledWith('meeting.userId = :userId', {
            userId: 'user-1',
        });
        expect(queryBuilder.andWhere).toHaveBeenCalledWith('meeting.workId = :workId', {
            workId: 'work-9',
        });
        expect(queryBuilder.andWhere).toHaveBeenCalledWith('meeting.source = :source', {
            source: 'zoom',
        });
        expect(queryBuilder.orderBy).toHaveBeenCalledWith('meeting.startedAt', 'DESC');
        expect(queryBuilder.take).toHaveBeenCalledWith(5);
    });

    it('findByUser clamps the page size to the 1–100 bound', async () => {
        await repository.findByUser('user-1', { limit: 5000 });
        expect(queryBuilder.take).toHaveBeenCalledWith(100);

        await repository.findByUser('user-1', { limit: -3 });
        expect(queryBuilder.take).toHaveBeenCalledWith(1);
    });
});
