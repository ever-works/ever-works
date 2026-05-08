import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';
import { LessThan, Like } from 'typeorm';

describe('TypeORMKeyvAdapter', () => {
    let repository: {
        findOne: jest.Mock;
        upsert: jest.Mock;
        delete: jest.Mock;
        count: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
        };
    });

    const create = (overrides: Partial<{ ttl: number; namespace: string }> = {}) =>
        new TypeORMKeyvAdapter({ repository: repository as any, ...overrides });

    describe('constructor', () => {
        it('defaults the namespace to "app-cache" when not provided', () => {
            const adapter = create();
            expect(adapter._namespace).toBe('app-cache');
        });

        it('stores ttl on the opts bag and supports undefined', () => {
            const adapter = create({ ttl: 1000 });
            expect(adapter.opts.ttl).toBe(1000);

            const adapter2 = create();
            expect(adapter2.opts.ttl).toBeUndefined();
        });

        it('respects an explicit namespace', () => {
            const adapter = create({ namespace: 'works' });
            expect(adapter._namespace).toBe('works');
        });
    });

    describe('get', () => {
        it('returns undefined when no entry is found', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue(null);

            const result = await adapter.get('foo');

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { key: 'app-cache:foo' },
            });
            expect(result).toBeUndefined();
        });

        it('parses JSON-encoded values', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue({
                key: 'app-cache:foo',
                value: JSON.stringify({ a: 1, b: 'two' }),
                expiresAt: null,
            });

            const result = await adapter.get('foo');
            expect(result).toEqual({ a: 1, b: 'two' });
        });

        it('returns undefined and deletes the entry when expired', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue({
                key: 'app-cache:foo',
                value: '"x"',
                expiresAt: Date.now() - 1000,
            });
            repository.delete.mockResolvedValue({ affected: 1 });

            const result = await adapter.get('foo');

            expect(result).toBeUndefined();
            expect(repository.delete).toHaveBeenCalledWith({ key: 'app-cache:foo' });
        });

        it('treats null expiresAt as never-expiring', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue({
                key: 'app-cache:foo',
                value: '"forever"',
                expiresAt: null,
            });

            await expect(adapter.get('foo')).resolves.toBe('forever');
            expect(repository.delete).not.toHaveBeenCalled();
        });

        it('emits an error event and returns undefined on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            const boom = new Error('db down');
            repository.findOne.mockRejectedValue(boom);

            const result = await adapter.get('foo');

            expect(result).toBeUndefined();
            expect(onError).toHaveBeenCalledWith(boom);
        });

        it('respects a custom namespace when building the lookup key', async () => {
            const adapter = create({ namespace: 'tenants' });
            repository.findOne.mockResolvedValue(null);

            await adapter.get('a');

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { key: 'tenants:a' },
            });
        });
    });

    describe('set', () => {
        it('upserts the value with JSON-stringified payload', async () => {
            const adapter = create();
            repository.upsert.mockResolvedValue({});

            const ok = await adapter.set('foo', { a: 1 });

            expect(repository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'app-cache:foo',
                    value: JSON.stringify({ a: 1 }),
                    expiresAt: null,
                }),
                ['key'],
            );
            expect(ok).toBe(true);
        });

        it('computes expiresAt = now + ttl when ttl is provided', async () => {
            const adapter = create();
            const before = Date.now();
            repository.upsert.mockResolvedValue({});

            await adapter.set('foo', 1, 5000);

            const upsertCall = repository.upsert.mock.calls[0][0];
            expect(upsertCall.expiresAt).toBeGreaterThanOrEqual(before + 5000);
            expect(upsertCall.expiresAt).toBeLessThanOrEqual(Date.now() + 5000);
        });

        it('returns false and emits an error on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.upsert.mockRejectedValue(new Error('write failed'));

            const ok = await adapter.set('foo', 1);

            expect(ok).toBe(false);
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('delete', () => {
        it('returns true when at least one row was affected', async () => {
            const adapter = create();
            repository.delete.mockResolvedValue({ affected: 1 });

            const ok = await adapter.delete('foo');

            expect(ok).toBe(true);
            expect(repository.delete).toHaveBeenCalledWith({ key: 'app-cache:foo' });
        });

        it('returns false when affected is 0', async () => {
            const adapter = create();
            repository.delete.mockResolvedValue({ affected: 0 });

            await expect(adapter.delete('foo')).resolves.toBe(false);
        });

        it('emits an error and returns false on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.delete.mockRejectedValue(new Error('boom'));

            const ok = await adapter.delete('foo');

            expect(ok).toBe(false);
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('clear', () => {
        it('deletes all entries scoped to the namespace via Like', async () => {
            const adapter = create({ namespace: 'tenants' });
            repository.delete.mockResolvedValue({ affected: 5 });

            await adapter.clear();

            expect(repository.delete).toHaveBeenCalledWith({
                key: Like('tenants:%'),
            });
        });

        it('emits errors but does not throw', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.delete.mockRejectedValue(new Error('nope'));

            await expect(adapter.clear()).resolves.toBeUndefined();
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('has', () => {
        it('returns true when count > 0', async () => {
            const adapter = create();
            repository.count.mockResolvedValue(1);

            await expect(adapter.has('foo')).resolves.toBe(true);
            expect(repository.count).toHaveBeenCalledWith({
                where: { key: 'app-cache:foo' },
            });
        });

        it('returns false when count === 0', async () => {
            const adapter = create();
            repository.count.mockResolvedValue(0);

            await expect(adapter.has('foo')).resolves.toBe(false);
        });

        it('returns false and emits an error on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.count.mockRejectedValue(new Error('boom'));

            await expect(adapter.has('foo')).resolves.toBe(false);
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('cleanExpired', () => {
        it('deletes entries with expiresAt < now', async () => {
            const adapter = create();
            const before = Date.now();
            repository.delete.mockResolvedValue({ affected: 3 });

            const result = await adapter.cleanExpired();

            const deleteCall = repository.delete.mock.calls[0][0];
            // LessThan stores the value internally; we verify the where shape
            expect(deleteCall.expiresAt).toEqual(LessThan(deleteCall.expiresAt._value ?? before));
            expect(result).toBe(3);
        });

        it('returns affected || 0 when undefined', async () => {
            const adapter = create();
            repository.delete.mockResolvedValue({ affected: undefined });

            await expect(adapter.cleanExpired()).resolves.toBe(0);
        });

        it('returns 0 and emits an error on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.delete.mockRejectedValue(new Error('boom'));

            await expect(adapter.cleanExpired()).resolves.toBe(0);
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('deleteUnscopedEntriesLike', () => {
        it('deletes any entry whose key matches %term%', async () => {
            const adapter = create();
            repository.delete.mockResolvedValue({ affected: 0 });

            await adapter.deleteUnscopedEntriesLike('item-source-validation');

            expect(repository.delete).toHaveBeenCalledWith({
                key: Like('%item-source-validation%'),
            });
        });

        it('emits an error and resolves on repo failure', async () => {
            const adapter = create();
            const onError = jest.fn();
            adapter.on('error', onError);
            repository.delete.mockRejectedValue(new Error('nope'));

            await expect(adapter.deleteUnscopedEntriesLike('x')).resolves.toBeUndefined();
            expect(onError).toHaveBeenCalled();
        });
    });

    describe('deleteMany', () => {
        it('returns true when every delete returns true', async () => {
            const adapter = create();
            repository.delete.mockResolvedValue({ affected: 1 });

            await expect(adapter.deleteMany!(['a', 'b', 'c'])).resolves.toBe(true);
            expect(repository.delete).toHaveBeenCalledTimes(3);
        });

        it('returns false when any delete returns false', async () => {
            const adapter = create();
            repository.delete
                .mockResolvedValueOnce({ affected: 1 })
                .mockResolvedValueOnce({ affected: 0 });

            await expect(adapter.deleteMany!(['a', 'b'])).resolves.toBe(false);
        });
    });

    describe('disconnect', () => {
        it('resolves to undefined', async () => {
            const adapter = create();
            await expect(adapter.disconnect!()).resolves.toBeUndefined();
        });
    });

    describe('wrap', () => {
        it('returns the cached value without invoking fn when present', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue({
                key: 'app-cache:foo',
                value: '"cached"',
                expiresAt: null,
            });
            const fn = jest.fn();

            const result = await adapter.wrap('foo', fn, 1000);

            expect(result).toBe('cached');
            expect(fn).not.toHaveBeenCalled();
            expect(repository.upsert).not.toHaveBeenCalled();
        });

        it('invokes fn and stores the produced value when no cache hit', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue(null);
            repository.upsert.mockResolvedValue({});
            const fn = jest.fn().mockResolvedValue('computed');

            const result = await adapter.wrap('foo', fn, 1000);

            expect(result).toBe('computed');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(repository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'app-cache:foo',
                    value: JSON.stringify('computed'),
                }),
                ['key'],
            );
        });

        it('accepts a number ttl positional argument', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue(null);
            repository.upsert.mockResolvedValue({});
            const fn = jest.fn().mockResolvedValue(7);

            const before = Date.now();
            await adapter.wrap('foo', fn, 5000);

            const upsertCall = repository.upsert.mock.calls[0][0];
            expect(upsertCall.expiresAt).toBeGreaterThanOrEqual(before + 5000);
        });

        it('accepts an options object with ttl property', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue(null);
            repository.upsert.mockResolvedValue({});
            const fn = jest.fn().mockResolvedValue(7);

            const before = Date.now();
            await adapter.wrap('foo', fn, { ttl: 4000 });

            const upsertCall = repository.upsert.mock.calls[0][0];
            expect(upsertCall.expiresAt).toBeGreaterThanOrEqual(before + 4000);
        });

        it('falls back to constructor-level ttl when options object lacks ttl', async () => {
            const adapter = create({ ttl: 9000 });
            repository.findOne.mockResolvedValue(null);
            repository.upsert.mockResolvedValue({});
            const fn = jest.fn().mockResolvedValue(7);

            const before = Date.now();
            await adapter.wrap('foo', fn, {});

            const upsertCall = repository.upsert.mock.calls[0][0];
            expect(upsertCall.expiresAt).toBeGreaterThanOrEqual(before + 9000);
        });

        it('supports synchronous fn return values', async () => {
            const adapter = create();
            repository.findOne.mockResolvedValue(null);
            repository.upsert.mockResolvedValue({});
            const fn = jest.fn().mockReturnValue(42);

            const result = await adapter.wrap('foo', fn as any, 1000);

            expect(result).toBe(42);
        });
    });
});
