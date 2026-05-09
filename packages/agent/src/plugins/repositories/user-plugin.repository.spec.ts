import { UserPluginRepository } from './user-plugin.repository';
import type { UserPluginEntity } from '../entities/user-plugin.entity';

/**
 * Pins the per-`(userId, pluginId)`-uniqueness semantics of the
 * `user_plugins` table. The composite key (`userId`, `pluginId`) is the
 * primary lookup mode for user-scoped settings + per-user enable/disable
 * state; the repository wraps every TypeORM call so callers don't have
 * to know the underlying query shape.
 *
 * The wrapper has two non-trivial behaviours that this suite pins:
 *   1. `update` and `updateByUserAndPlugin` re-fetch after the UPDATE
 *      because TypeORM's `Repository.update(...)` resolves with an
 *      `UpdateResult` (no entity) — every caller depends on getting the
 *      fresh entity back.
 *   2. The "did anything change?" predicate is `(result.affected ?? 0) > 0`
 *      so a TypeORM driver returning `affected: undefined` (some legacy
 *      drivers) is treated as "no rows touched" rather than "changed".
 *      This is defence-in-depth — a future driver swap that returns
 *      `affected: undefined` for all rows would make `setEnabled` /
 *      `delete*` silently become no-ops; pinned here so a regression
 *      breaks loudly.
 *
 * Mocks the TypeORM `Repository<UserPluginEntity>` directly (the
 * repository wrapper is a thin pass-through over `findOne`/`find`/
 * `update`/`save`/`create`/`delete`/`count`).
 */
describe('UserPluginRepository', () => {
    function makeRepository(overrides: Record<string, jest.Mock> = {}) {
        return {
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
            ...overrides,
        };
    }

    function makeService(overrides: Record<string, jest.Mock> = {}) {
        const typeormRepo = makeRepository(overrides);
        const repo = new UserPluginRepository(typeormRepo as never);
        return { repo, typeormRepo };
    }

    describe('create', () => {
        it('proxies through `repository.create(data)` then `repository.save(...)`', async () => {
            const data = { userId: 'u-1', pluginId: 'p-1' };
            const created = { ...data, id: 'up-1' };
            const saved = { ...created, createdAt: new Date('2026-01-01') };

            const create = jest.fn().mockReturnValue(created);
            const save = jest.fn().mockResolvedValue(saved);
            const { repo, typeormRepo } = makeService({ create, save });

            const result = await repo.create(data);

            expect(typeormRepo.create).toHaveBeenCalledWith(data);
            expect(typeormRepo.save).toHaveBeenCalledWith(created);
            expect(result).toBe(saved);
        });
    });

    describe('findByUserAndPlugin', () => {
        it('queries `findOne` with composite-key where + `pluginEntity` relation', async () => {
            const row = { id: 'up-1', userId: 'u-1', pluginId: 'p-1' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            const result = await repo.findByUserAndPlugin('u-1', 'p-1');

            expect(result).toBe(row);
            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { userId: 'u-1', pluginId: 'p-1' },
                relations: ['pluginEntity'],
            });
        });

        it('returns null when no row exists', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findByUserAndPlugin('missing', 'missing')).resolves.toBeNull();
        });
    });

    describe('findById', () => {
        it('queries `findOne` with `where: { id }` + `pluginEntity` relation', async () => {
            const row = { id: 'up-1' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            await repo.findById('up-1');

            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'up-1' },
                relations: ['pluginEntity'],
            });
        });

        it('returns null when no row exists', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByUser', () => {
        it('queries `find` with userId + pluginEntity relation + DESC createdAt order', async () => {
            // The DESC ordering is what powers the "most-recently-added
            // plugin first" UI; pinned so a future "switch to ASC" tweak
            // is a deliberate diff.
            const rows = [{ id: 'up-1' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            const result = await repo.findByUser('u-1');

            expect(result).toBe(rows);
            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { userId: 'u-1' },
                relations: ['pluginEntity'],
                order: { createdAt: 'DESC' },
            });
        });
    });

    describe('findEnabledByUser', () => {
        it('queries `find` with userId + `enabled: true` + pluginEntity relation (NO order)', async () => {
            // No order is intentional — callers either iterate through all
            // matched rows (the registry/loader) or apply their own
            // ordering. Pinned here so the absence of an `order` key
            // doesn't drift back in by accident.
            const rows = [{ id: 'up-1', enabled: true }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            const result = await repo.findEnabledByUser('u-1');

            expect(result).toBe(rows);
            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { userId: 'u-1', enabled: true },
                relations: ['pluginEntity'],
            });
            expect(typeormRepo.find.mock.calls[0][0]).not.toHaveProperty('order');
        });
    });

    describe('findByPlugin', () => {
        it('queries `find` with pluginId + `user` relation (NOT pluginEntity)', async () => {
            // The `user` relation here is the inverse — given a pluginId,
            // load all users who have a record. Pinned so a future swap
            // to `pluginEntity` (which would be redundant) is deliberate.
            const rows = [{ id: 'up-1', userId: 'u-1' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            await repo.findByPlugin('p-1');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { pluginId: 'p-1' },
                relations: ['user'],
            });
        });
    });

    describe('update (by id)', () => {
        it('UPDATEs by id then re-fetches via findById (TypeORM update returns no entity)', async () => {
            const updated = { id: 'up-1', settings: { x: 1 } };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            const result = await repo.update('up-1', { settings: { x: 1 } });

            expect(typeormRepo.update).toHaveBeenCalledWith('up-1', { settings: { x: 1 } });
            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'up-1' },
                relations: ['pluginEntity'],
            });
            expect(result).toBe(updated);
        });

        it('returns null when the post-UPDATE refetch finds nothing (e.g. row deleted concurrently)', async () => {
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.update('up-1', {})).resolves.toBeNull();
        });
    });

    describe('updateByUserAndPlugin', () => {
        it('UPDATEs by composite key then re-fetches via findByUserAndPlugin', async () => {
            const updated = { id: 'up-1', userId: 'u-1', pluginId: 'p-1' };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            const result = await repo.updateByUserAndPlugin('u-1', 'p-1', { enabled: true });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { enabled: true },
            );
            // The refetch passes the composite key + pluginEntity relation.
            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { userId: 'u-1', pluginId: 'p-1' },
                relations: ['pluginEntity'],
            });
            expect(result).toBe(updated);
        });

        it('returns null when the post-UPDATE refetch finds nothing', async () => {
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 0 }),
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.updateByUserAndPlugin('u-1', 'p-1', {})).resolves.toBeNull();
        });
    });

    describe('updateSettings', () => {
        it('passes only `settings` when secretSettings is omitted', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'up-1' }),
            });

            await repo.updateSettings('u-1', 'p-1', { foo: 'bar' });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { settings: { foo: 'bar' } },
            );
        });

        it('includes secretSettings when provided', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'up-1' }),
            });

            await repo.updateSettings('u-1', 'p-1', { foo: 'bar' }, { apiKey: 'secret-token' });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { settings: { foo: 'bar' }, secretSettings: { apiKey: 'secret-token' } },
            );
        });

        it('passes secretSettings = {} (empty object) verbatim — does NOT collapse to undefined', async () => {
            // The check is `secretSettings !== undefined`, NOT
            // `secretSettings`. So an empty `{}` STILL gets persisted (which
            // is how a caller clears the secrets back to "none"). Pinned
            // so a future "drop falsy" tweak is a deliberate diff.
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'up-1' }),
            });

            await repo.updateSettings('u-1', 'p-1', { foo: 'bar' }, {});

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { settings: { foo: 'bar' }, secretSettings: {} },
            );
        });

        it('returns the refetched entity', async () => {
            const refetched = { id: 'up-1', settings: { foo: 'bar' } };
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(refetched),
            });

            await expect(repo.updateSettings('u-1', 'p-1', { foo: 'bar' })).resolves.toBe(
                refetched,
            );
        });
    });

    describe('setEnabled', () => {
        it('UPDATEs `enabled` by composite key and returns true when affected > 0', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ update });

            await expect(repo.setEnabled('u-1', 'p-1', true)).resolves.toBe(true);
            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { enabled: true },
            );
        });

        it('returns false when affected is 0 (no row matched)', async () => {
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 0 }),
            });

            await expect(repo.setEnabled('u-1', 'p-1', true)).resolves.toBe(false);
        });

        it('returns false when affected is undefined (defence-in-depth for legacy drivers)', async () => {
            // `(result.affected ?? 0) > 0` evaluates `undefined ?? 0 > 0`
            // → `0 > 0` → false. Pinned so a future "rely on truthiness"
            // tweak (which would treat undefined as "true") is a deliberate
            // diff.
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: undefined }),
            });

            await expect(repo.setEnabled('u-1', 'p-1', false)).resolves.toBe(false);
        });

        it('forwards the `enabled` flag verbatim (false vs true)', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo } = makeService({ update });

            await repo.setEnabled('u-1', 'p-1', false);

            expect(update.mock.calls[0][1]).toEqual({ enabled: false });
        });
    });

    describe('delete', () => {
        it('returns true when affected > 0', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            await expect(repo.delete('up-1')).resolves.toBe(true);
        });

        it('returns false when affected is 0 (row missing)', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 0 }),
            });

            await expect(repo.delete('missing')).resolves.toBe(false);
        });

        it('returns false when affected is undefined', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: undefined }),
            });

            await expect(repo.delete('legacy')).resolves.toBe(false);
        });
    });

    describe('deleteByUserAndPlugin', () => {
        it('DELETEs by composite key and returns true on success', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ delete: del });

            await expect(repo.deleteByUserAndPlugin('u-1', 'p-1')).resolves.toBe(true);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ userId: 'u-1', pluginId: 'p-1' });
        });

        it('returns false when no row matches', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 0 }),
            });

            await expect(repo.deleteByUserAndPlugin('u-1', 'p-1')).resolves.toBe(false);
        });
    });

    describe('deleteByPlugin', () => {
        it('DELETEs all rows for a pluginId and returns the affected COUNT (NOT a boolean)', async () => {
            // The other delete methods return boolean — `deleteByPlugin`
            // returns the integer count because callers (plugin-uninstall
            // flow) want to log how many user rows were swept. Pinned so
            // a future "make all delete methods consistent" refactor is a
            // deliberate diff.
            const del = jest.fn().mockResolvedValue({ affected: 7 });
            const { repo, typeormRepo } = makeService({ delete: del });

            const result = await repo.deleteByPlugin('p-1');

            expect(result).toBe(7);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ pluginId: 'p-1' });
        });

        it('returns 0 when affected is undefined', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: undefined }),
            });

            await expect(repo.deleteByPlugin('p-1')).resolves.toBe(0);
        });

        it('returns 0 when no rows matched', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 0 }),
            });

            await expect(repo.deleteByPlugin('p-1')).resolves.toBe(0);
        });
    });

    describe('exists', () => {
        it('uses `count` (NOT findOne) for a presence check + composite-key where', async () => {
            // `count` is cheaper than `findOne` because no entity needs
            // to be hydrated. Pinned so a future "switch to findOne" tweak
            // is a deliberate downgrade.
            const count = jest.fn().mockResolvedValue(1);
            const { repo, typeormRepo } = makeService({ count });

            await expect(repo.exists('u-1', 'p-1')).resolves.toBe(true);
            expect(typeormRepo.count).toHaveBeenCalledWith({
                where: { userId: 'u-1', pluginId: 'p-1' },
            });
        });

        it('returns true when count > 1 (defensive — composite key should preclude duplicates, but the predicate must be > 0 not === 1)', async () => {
            const { repo } = makeService({
                count: jest.fn().mockResolvedValue(2),
            });

            await expect(repo.exists('u-1', 'p-1')).resolves.toBe(true);
        });

        it('returns false when count === 0', async () => {
            const { repo } = makeService({
                count: jest.fn().mockResolvedValue(0),
            });

            await expect(repo.exists('u-1', 'p-1')).resolves.toBe(false);
        });
    });

    describe('upsert', () => {
        it('UPDATEs the existing row when one is found and refetches it', async () => {
            const existing = { id: 'up-1', userId: 'u-1', pluginId: 'p-1' };
            const updated = { ...existing, enabled: true };
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing) // initial findByUserAndPlugin
                .mockResolvedValueOnce(updated); // re-fetch after update
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.upsert({
                userId: 'u-1',
                pluginId: 'p-1',
                enabled: true,
            });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { userId: 'u-1', pluginId: 'p-1' },
                { userId: 'u-1', pluginId: 'p-1', enabled: true },
            );
            expect(result).toBe(updated);
            // create/save MUST NOT be called when the row already exists
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
        });

        it('CREATEs + SAVEs a fresh row when none is found', async () => {
            const created: Partial<UserPluginEntity> = {
                userId: 'u-1',
                pluginId: 'p-1',
                enabled: true,
            };
            const saved = { ...created, id: 'up-new' };
            const findOne = jest.fn().mockResolvedValue(null);
            const create = jest.fn().mockReturnValue(created);
            const save = jest.fn().mockResolvedValue(saved);
            const { repo, typeormRepo } = makeService({ findOne, create, save });

            const result = await repo.upsert({
                userId: 'u-1',
                pluginId: 'p-1',
                enabled: true,
            });

            expect(typeormRepo.create).toHaveBeenCalledWith({
                userId: 'u-1',
                pluginId: 'p-1',
                enabled: true,
            });
            expect(typeormRepo.save).toHaveBeenCalledWith(created);
            expect(result).toBe(saved);
            expect(typeormRepo.update).not.toHaveBeenCalled();
        });
    });
});
