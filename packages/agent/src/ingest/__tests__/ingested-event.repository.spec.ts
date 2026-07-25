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

    let typeormRepo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
    };
    let repository: IngestedEventRepository;

    beforeEach(() => {
        typeormRepo = {
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            save: jest.fn(async (data) => ({ id: 'row-1', ...data })),
            find: jest.fn(async () => []),
            update: jest.fn(async () => undefined),
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
});
