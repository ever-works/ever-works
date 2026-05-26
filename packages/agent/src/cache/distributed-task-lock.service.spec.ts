import { DistributedTaskLockService } from './distributed-task-lock.service';

describe('DistributedTaskLockService', () => {
    let queryBuilder: {
        delete: jest.Mock;
        from: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        update: jest.Mock;
        set: jest.Mock;
        execute: jest.Mock;
    };
    let cacheEntryRepository: {
        createQueryBuilder: jest.Mock;
        insert: jest.Mock;
        findOne: jest.Mock;
    };
    let service: DistributedTaskLockService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-08T00:00:00Z'));

        queryBuilder = {
            delete: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({}),
        };
        cacheEntryRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
            insert: jest.fn().mockResolvedValue({}),
            findOne: jest.fn(),
        };

        service = new DistributedTaskLockService(cacheEntryRepository as any);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('isLocked', () => {
        it('returns true when a non-expired lock exists', async () => {
            cacheEntryRepository.findOne.mockResolvedValue({ key: 'task-lock:foo' });

            await expect(service.isLocked('foo')).resolves.toBe(true);
            expect(cacheEntryRepository.findOne).toHaveBeenCalledWith({
                where: { key: 'task-lock:foo', expiresAt: expect.any(Object) },
                select: ['key'],
            });
        });

        it('returns false when no non-expired lock exists', async () => {
            cacheEntryRepository.findOne.mockResolvedValue(null);

            await expect(service.isLocked('foo')).resolves.toBe(false);
        });
    });

    describe('runExclusive — happy path', () => {
        it('acquires the lock, runs fn, and releases on success', async () => {
            const fn = jest.fn().mockResolvedValue('computed');

            const promise = service.runExclusive('my-task', fn);
            await jest.runOnlyPendingTimersAsync();
            const result = await promise;

            expect(result).toEqual({ acquired: true, result: 'computed' });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(cacheEntryRepository.insert).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'task-lock:my-task',
                    value: expect.any(String),
                    expiresAt: expect.any(Number),
                }),
            );
            // Release: a delete query was issued for the lock key
            expect(queryBuilder.delete).toHaveBeenCalled();
        });

        it('runs the stale-lock cleanup (DELETE expiredAt < now OR createdAt < staleBefore) before INSERT', async () => {
            const fn = jest.fn().mockResolvedValue(1);

            await service.runExclusive('task-1', fn);

            // First createQueryBuilder call is the cleanup, before insert
            const firstQB = (cacheEntryRepository.createQueryBuilder as jest.Mock).mock
                .invocationCallOrder[0];
            const insertOrder = (cacheEntryRepository.insert as jest.Mock).mock
                .invocationCallOrder[0];
            expect(firstQB).toBeLessThan(insertOrder);

            expect(queryBuilder.where).toHaveBeenCalledWith('key = :key', {
                key: 'task-lock:task-1',
            });
            expect(queryBuilder.andWhere).toHaveBeenCalledWith(
                '(expiresAt < :now OR createdAt < :staleBefore)',
                expect.objectContaining({
                    now: expect.any(Number),
                    staleBefore: expect.any(Date),
                }),
            );
        });

        it('returns the value produced by fn even when fn returns undefined', async () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            const result = await service.runExclusive('task', fn);

            expect(result).toEqual({ acquired: true, result: undefined });
        });

        it('caps ttlMs to maxLifetimeMs', async () => {
            const fn = jest.fn().mockResolvedValue(null);

            await service.runExclusive('task', fn, {
                ttlMs: 60_000_000, // 1000 minutes
                maxLifetimeMs: 1000, // 1 second
            });

            const inserted = cacheEntryRepository.insert.mock.calls[0][0];
            // expiresAt should be now + 1000 (capped)
            expect(inserted.expiresAt - Date.now()).toBeLessThanOrEqual(1000);
        });

        it('caps maxLifetimeMs to MAX_STALE_LOCK_MS (24h)', async () => {
            const fn = jest.fn().mockResolvedValue(null);
            const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

            await service.runExclusive('task', fn, { maxLifetimeMs: TWO_DAYS });

            const inserted = cacheEntryRepository.insert.mock.calls[0][0];
            // 24h cap: expiresAt should be ≤ now + 24h
            expect(inserted.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        });
    });

    describe('runExclusive — already locked', () => {
        it('returns acquired:false and calls onLocked when insert conflicts AND existing lock found', async () => {
            // Simulate insert race: insert throws, then findOne returns the existing lock
            cacheEntryRepository.insert.mockRejectedValue(new Error('unique violation'));
            cacheEntryRepository.findOne.mockResolvedValue({ key: 'task-lock:foo' });

            const onLocked = jest.fn();
            const fn = jest.fn();

            const result = await service.runExclusive('foo', fn, { onLocked });

            expect(result).toEqual({ acquired: false });
            expect(fn).not.toHaveBeenCalled();
            expect(onLocked).toHaveBeenCalledTimes(1);
            expect(cacheEntryRepository.findOne).toHaveBeenCalledWith({
                where: { key: 'task-lock:foo' },
                select: ['key'],
            });
        });

        it('rethrows insert error when the lock vanished between INSERT and findOne (real DB error, not a race)', async () => {
            const boom = new Error('connection lost');
            cacheEntryRepository.insert.mockRejectedValue(boom);
            cacheEntryRepository.findOne.mockResolvedValue(null);
            const fn = jest.fn();

            await expect(service.runExclusive('foo', fn)).rejects.toThrow('connection lost');
            expect(fn).not.toHaveBeenCalled();
        });

        it('does not call onLocked when not provided (no crash)', async () => {
            cacheEntryRepository.insert.mockRejectedValue(new Error('unique'));
            cacheEntryRepository.findOne.mockResolvedValue({ key: 'task-lock:foo' });
            const fn = jest.fn();

            const result = await service.runExclusive('foo', fn);

            expect(result.acquired).toBe(false);
        });
    });

    describe('runExclusive — fn errors', () => {
        it('still releases the lock when fn rejects', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('compute failed'));

            await expect(service.runExclusive('task', fn)).rejects.toThrow('compute failed');

            // Two QB calls: one for stale-cleanup, one for release
            expect(cacheEntryRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
            // Release also issues a delete
            const deleteCalls = queryBuilder.delete.mock.calls.length;
            expect(deleteCalls).toBeGreaterThanOrEqual(2);
        });

        it('release filters by both key AND value (token) so we never release someone else’s lock', async () => {
            const fn = jest.fn().mockResolvedValue(1);

            await service.runExclusive('task', fn);

            // The last andWhere on the release path must filter by value = token
            const valueCalls = queryBuilder.andWhere.mock.calls.filter(
                ([sql]) => sql === 'value = :value',
            );
            expect(valueCalls.length).toBeGreaterThanOrEqual(1);
            expect(valueCalls[0][1]).toEqual({ value: expect.any(String) });
        });
    });

    describe('runExclusive — heartbeat refresh', () => {
        it('schedules a heartbeat with refreshIntervalMs default = max(30s, ttl/3)', async () => {
            const setIntervalSpy = jest.spyOn(global, 'setInterval');
            const fn = jest.fn().mockResolvedValue(null);

            // ttl = 90_000 ⇒ ttl/3 = 30_000 ⇒ refresh = 30_000
            await service.runExclusive('task', fn, { ttlMs: 90_000 });

            expect(setIntervalSpy).toHaveBeenCalled();
            const intervalDelay = setIntervalSpy.mock.calls[0][1];
            expect(intervalDelay).toBe(30_000);
        });

        it('honors explicit refreshIntervalMs', async () => {
            const setIntervalSpy = jest.spyOn(global, 'setInterval');
            const fn = jest.fn().mockResolvedValue(null);

            await service.runExclusive('task', fn, {
                ttlMs: 90_000,
                refreshIntervalMs: 10_000,
            });

            const intervalDelay = setIntervalSpy.mock.calls[0][1];
            expect(intervalDelay).toBe(10_000);
        });

        it('refresh updates expiresAt for the matching key+value', async () => {
            // Long-running fn so heartbeat fires
            const fn = jest.fn().mockImplementation(
                () =>
                    new Promise((resolve) => {
                        // resolve after a couple of intervals tick
                        setTimeout(() => resolve('done'), 70_000);
                    }),
            );

            const promise = service.runExclusive('task', fn, {
                ttlMs: 60_000, // refreshInterval = max(30_000, 20_000) = 30_000
            });

            // Advance by enough for the heartbeat to fire at least once
            await jest.advanceTimersByTimeAsync(31_000);

            // Update path uses createQueryBuilder().update(...).set(...).where(...).andWhere(...)
            expect(queryBuilder.update).toHaveBeenCalled();
            expect(queryBuilder.set).toHaveBeenCalledWith({
                expiresAt: expect.any(Number),
            });

            // Resolve fn so we can finish
            await jest.advanceTimersByTimeAsync(70_000);
            await promise;
        });
    });
});
