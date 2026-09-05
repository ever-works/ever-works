import { ExternalIssueLinkRepository } from '../external-issue-link.repository';

/**
 * The WRITE half of the external-issue ↔ Task mapping.
 *
 * Everything around this layer was already covered — the triage filer
 * (with `links` mocked wholesale), the service (with `links.upsert`
 * mocked), the migration (which proves the column exists, is NOT NULL and
 * defaults to 0) — and the one link that actually persists a value had no
 * test at all. So `regressionCount`, the slice's headline audit counter,
 * was asserted at every hop EXCEPT the hop that writes it: dropping the
 * `!== undefined` guard (which would reset a user's whole re-open history
 * to 0 on an ordinary refresh) or flipping the `?? 0` on insert would
 * have left the entire suite green.
 *
 * Same harness as the sibling repository specs: a mocked TypeORM
 * repository, asserting on the ENTITY handed to `save`.
 */
describe('ExternalIssueLinkRepository', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let typeormRepo: {
        findOne: jest.Mock;
        find: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        remove: jest.Mock;
    };
    let repository: ExternalIssueLinkRepository;

    const identity = { userId: 'user-1', source: 'sentry', externalIssueId: '4501' };

    const existingRow = (overrides: Record<string, unknown> = {}) => ({
        id: 'link-1',
        ...identity,
        taskId: 'task-1',
        externalKey: 'EVER-WORKS-1X',
        title: 'TypeError',
        url: 'https://sentry.io/organizations/ever-co/issues/4501/',
        lastIngestedEventId: 'row-1',
        lastSeenAt: new Date('2026-09-01T12:00:00.000Z'),
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        regressionCount: 3,
        ...overrides,
    });

    beforeEach(() => {
        typeormRepo = {
            findOne: jest.fn(async () => null),
            find: jest.fn(async () => []),
            create: jest.fn((data) => ({ ...data })),
            save: jest.fn(async (entity) => entity),
            remove: jest.fn(async () => undefined),
        };
        repository = new ExternalIssueLinkRepository(typeormRepo as never);
    });

    describe('regressionCount survives a write and reads back', () => {
        it('inserts a first link at 0 without the caller mentioning the column', async () => {
            await repository.upsert({ ...identity, taskId: 'task-1' });

            const written = typeormRepo.save.mock.calls[0][0];
            expect(written.regressionCount).toBe(0);
        });

        it('inserts the caller-supplied count when a first link IS a re-open', async () => {
            await repository.upsert({ ...identity, taskId: 'task-2', regressionCount: 2 });

            expect(typeormRepo.save.mock.calls[0][0].regressionCount).toBe(2);
        });

        it('persists an incremented count onto an existing row', async () => {
            typeormRepo.findOne.mockResolvedValue(existingRow());

            await repository.upsert({ ...identity, taskId: 'task-9', regressionCount: 4 });

            const written = typeormRepo.save.mock.calls[0][0];
            expect(written.taskId).toBe('task-9');
            expect(written.regressionCount).toBe(4);
        });

        it('leaves the count ALONE on an ordinary refresh that omits it', async () => {
            typeormRepo.findOne.mockResolvedValue(existingRow());

            await repository.upsert({
                ...identity,
                taskId: 'task-1',
                lastIngestedEventId: 'row-2',
            });

            // The guard that stops a plain refresh resetting a user's
            // whole re-open history to zero.
            expect(typeormRepo.save.mock.calls[0][0].regressionCount).toBe(3);
        });
    });

    describe('onlyIfAbsent — the insert-only first link', () => {
        it('leaves an existing row untouched and hands back the holder', async () => {
            const holder = existingRow({ taskId: 'winner-task' });
            typeormRepo.findOne.mockResolvedValue(holder);

            const result = await repository.upsert({
                ...identity,
                taskId: 'loser-task',
                onlyIfAbsent: true,
            });

            // Nothing written; the caller can see it lost the race
            // because the row names somebody else's Task.
            expect(typeormRepo.save).not.toHaveBeenCalled();
            expect(result.taskId).toBe('winner-task');
        });

        it('still inserts when nothing holds the key, and never persists the flag', async () => {
            await repository.upsert({ ...identity, taskId: 'task-1', onlyIfAbsent: true });

            const created = typeormRepo.create.mock.calls[0][0];
            expect(created).not.toHaveProperty('onlyIfAbsent');
            expect(typeormRepo.save).toHaveBeenCalledTimes(1);
        });

        it('re-points the row when the caller did NOT ask for insert-only', async () => {
            typeormRepo.findOne.mockResolvedValue(existingRow({ taskId: 'old-task' }));

            await repository.upsert({ ...identity, taskId: 'new-task' });

            expect(typeormRepo.save.mock.calls[0][0].taskId).toBe('new-task');
        });
    });

    it('adopts the winner when a concurrent first insert violates the UNIQUE index', async () => {
        const winner = existingRow({ taskId: 'winner-task' });
        typeormRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        typeormRepo.save.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

        const result = await repository.upsert({ ...identity, taskId: 'loser-task' });

        expect(result.taskId).toBe('winner-task');
    });
});
