import { In } from 'typeorm';
import { PluginRepository } from './plugin.repository';
import type { PluginEntity } from '../entities/plugin.entity';

/**
 * Pins the per-`pluginId`-uniqueness semantics of the `plugins` table.
 * `pluginId` is the wire-stable string discriminant (e.g. `'github'`,
 * `'tavily'`, `'openai'`) — distinct from the surrogate `id` UUID. Most
 * callers use `findByPluginId` / `updateByPluginId` (because they receive
 * a plugin id from package.json metadata, not a DB primary key); the
 * `id`-keyed methods exist for downstream API endpoints that already
 * have a row-id in hand.
 *
 * The wrapper has three non-trivial behaviours that this suite pins:
 *   1. `findAll` builds the `where` clause defensively — only options
 *      with non-undefined values are added, and `Object.keys(where).length === 0`
 *      collapses back to `undefined` so TypeORM treats it as "no filter".
 *   2. `findByCapability` falls back to in-memory filter (capabilities is
 *      a `text[]`/`json[]` column whose driver-level handling differs;
 *      the repository pulls the full table and filters in JS to avoid
 *      driver-specific SQL).
 *   3. `updateState` auto-stamps `loadedAt = new Date()` ONLY when the
 *      target state is `'loaded'`. Other states (`'error'`, `'unloaded'`,
 *      etc.) MUST NOT touch `loadedAt` — that field is the "last
 *      successful load" timestamp shown in the UI.
 *
 * Mocks the TypeORM `Repository<PluginEntity>` directly. The repository
 * wrapper is a thin pass-through over `findOne`/`find`/`update`/`save`/
 * `create`/`delete`/`count`.
 */
describe('PluginRepository', () => {
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
        const repo = new PluginRepository(typeormRepo as never);
        return { repo, typeormRepo };
    }

    describe('create', () => {
        it('proxies through `repository.create(data)` then `repository.save(...)`', async () => {
            const data = { pluginId: 'github', name: 'GitHub' };
            const created = { ...data, id: 'p-1' };
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

    describe('findByPluginId', () => {
        it('queries `findOne` with `where: { pluginId }` (NO relation hints — plugins is a flat table)', async () => {
            const row = { id: 'p-1', pluginId: 'github' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            const result = await repo.findByPluginId('github');

            expect(result).toBe(row);
            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { pluginId: 'github' } });
            expect(typeormRepo.findOne.mock.calls[0][0]).not.toHaveProperty('relations');
        });

        it('returns null when no row exists', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findByPluginId('missing')).resolves.toBeNull();
        });
    });

    describe('findById', () => {
        it('queries `findOne` with `where: { id }` (NO relation hints)', async () => {
            const row = { id: 'p-1', pluginId: 'github' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            await repo.findById('p-1');

            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { id: 'p-1' } });
        });

        it('returns null when no row exists', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findAll', () => {
        it('omits `where` entirely when no options are provided (treats as "no filter")', async () => {
            // The defensive `where: <obj> | undefined` selection means
            // calling `findAll()` with no options produces a `find({order})`
            // call WITHOUT a `where` key. Pinned so a future "always pass
            // empty where" tweak (which TypeORM may interpret differently
            // depending on driver) is a deliberate diff.
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll();

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: undefined,
                order: { name: 'ASC' },
            });
        });

        it('omits `where` when all options are undefined', async () => {
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll({});

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: undefined,
                order: { name: 'ASC' },
            });
        });

        it('builds a `where` with each provided field individually', async () => {
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll({ category: 'ai-provider' as never });

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { category: 'ai-provider' },
                order: { name: 'ASC' },
            });
        });

        it('combines multiple fields when present (category + state + builtIn)', async () => {
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll({
                category: 'search' as never,
                state: 'loaded' as never,
                builtIn: true,
            });

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { category: 'search', state: 'loaded', builtIn: true },
                order: { name: 'ASC' },
            });
        });

        it('forwards `builtIn: false` (uses `!== undefined` check, NOT a truthy check)', async () => {
            // `if (options?.builtIn !== undefined) where.builtIn = options.builtIn;`
            // means a literal `builtIn: false` STILL adds the filter — pinned
            // so a future "if (options.builtIn)" truthy-check (which would
            // silently drop the filter for `false`) is a deliberate diff.
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll({ builtIn: false });

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { builtIn: false },
                order: { name: 'ASC' },
            });
        });

        it('always orders by `name: ASC` (alphabetical UI list)', async () => {
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue([]),
            });

            await repo.findAll({ builtIn: true });

            expect(typeormRepo.find.mock.calls[0][0].order).toEqual({ name: 'ASC' });
        });
    });

    describe('findByCategory', () => {
        it('queries `find` with `where: { category }` + `order: name ASC`', async () => {
            const rows = [{ pluginId: 'tavily' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            const result = await repo.findByCategory('search' as never);

            expect(result).toBe(rows);
            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { category: 'search' },
                order: { name: 'ASC' },
            });
        });
    });

    describe('findByCapability', () => {
        it('pulls the full table then filters in-memory by `capabilities.includes(...)`', async () => {
            // The in-memory filter is intentional — the `capabilities` column
            // is array-typed and driver-level handling for "array contains"
            // differs (Postgres has `&&`/`@>`, MySQL has JSON_CONTAINS, sqljs
            // has neither). Pulling the full table keeps the repository
            // driver-agnostic. Pinned so a future "switch to a SQL-side array
            // contains" optimisation is a deliberate, driver-targeted diff.
            const rows = [
                { pluginId: 'github', capabilities: ['git-provider', 'oauth'] },
                { pluginId: 'tavily', capabilities: ['search'] },
                { pluginId: 'openai', capabilities: ['ai-provider'] },
            ];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            const result = await repo.findByCapability('search');

            expect(typeormRepo.find).toHaveBeenCalledWith();
            expect(result).toEqual([{ pluginId: 'tavily', capabilities: ['search'] }]);
        });

        it('returns an empty array when no plugin advertises the capability', async () => {
            const { repo } = makeService({
                find: jest
                    .fn()
                    .mockResolvedValue([{ pluginId: 'github', capabilities: ['git-provider'] }]),
            });

            await expect(repo.findByCapability('search')).resolves.toEqual([]);
        });
    });

    describe('findByPluginIds', () => {
        it('short-circuits to `[]` on empty input WITHOUT touching the repository', async () => {
            // The empty-array short-circuit avoids issuing `WHERE pluginId IN ()`
            // which is invalid SQL on most drivers. Pinned so a future "let
            // the driver handle it" tweak is deliberate.
            const find = jest.fn();
            const { repo, typeormRepo } = makeService({ find });

            await expect(repo.findByPluginIds([])).resolves.toEqual([]);
            expect(typeormRepo.find).not.toHaveBeenCalled();
        });

        it('forwards non-empty IDs via TypeORM `In(...)`', async () => {
            const rows = [{ pluginId: 'a' }, { pluginId: 'b' }];
            const find = jest.fn().mockResolvedValue(rows);
            const { repo, typeormRepo } = makeService({ find });

            const result = await repo.findByPluginIds(['a', 'b']);

            expect(result).toBe(rows);
            const arg = typeormRepo.find.mock.calls[0][0];
            // The `In` helper produces a FindOperator — assert by comparing
            // to a freshly-constructed `In(...)` of the same input.
            expect(arg).toEqual({ where: { pluginId: In(['a', 'b']) } });
        });
    });

    describe('updateByPluginId', () => {
        it('UPDATEs by `pluginId` then re-fetches via findByPluginId', async () => {
            const updated = { id: 'p-1', pluginId: 'github', state: 'loaded' };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            const result = await repo.updateByPluginId('github', { state: 'loaded' as never });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { pluginId: 'github' },
                { state: 'loaded' },
            );
            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { pluginId: 'github' } });
            expect(result).toBe(updated);
        });

        it('returns null when the post-UPDATE refetch finds nothing', async () => {
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 0 }),
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.updateByPluginId('missing', {})).resolves.toBeNull();
        });
    });

    describe('update (by id)', () => {
        it('UPDATEs by id then re-fetches via findById', async () => {
            const updated = { id: 'p-1', pluginId: 'github' };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            const result = await repo.update('p-1', { name: 'GitHub' });

            expect(typeormRepo.update).toHaveBeenCalledWith('p-1', { name: 'GitHub' });
            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { id: 'p-1' } });
            expect(result).toBe(updated);
        });
    });

    describe('updateState', () => {
        it('writes the new state via updateByPluginId', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateState('github', 'error' as never);

            const updateArgs = typeormRepo.update.mock.calls[0];
            expect(updateArgs[0]).toEqual({ pluginId: 'github' });
            expect(updateArgs[1]).toMatchObject({ state: 'error' });
        });

        it('does NOT stamp `loadedAt` for non-loaded states (e.g. error)', async () => {
            // The `loadedAt` field is the "last SUCCESSFUL load" timestamp.
            // Pinned so a future "always update loadedAt" tweak (which would
            // make every error event LOOK like a successful load to the UI)
            // is a deliberate diff.
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateState('github', 'error' as never);

            expect(typeormRepo.update.mock.calls[0][1]).not.toHaveProperty('loadedAt');
        });

        it('STAMPS `loadedAt = new Date()` only when state === "loaded"', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            const before = Date.now();
            await repo.updateState('github', 'loaded' as never);
            const after = Date.now();

            const writeData = typeormRepo.update.mock.calls[0][1];
            expect(writeData.state).toBe('loaded');
            expect(writeData.loadedAt).toBeInstanceOf(Date);
            const stampedAt = (writeData.loadedAt as Date).getTime();
            expect(stampedAt).toBeGreaterThanOrEqual(before);
            expect(stampedAt).toBeLessThanOrEqual(after);
        });

        it('forwards `error` when provided (non-undefined check — empty string IS persisted)', async () => {
            // The predicate is `if (error !== undefined)` — pinned so a
            // future "if (error)" truthy-check (which would silently drop
            // empty-string updates intended to CLEAR a prior error) is
            // deliberate.
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateState('github', 'unloaded' as never, '');

            expect(typeormRepo.update.mock.calls[0][1]).toMatchObject({
                state: 'unloaded',
                lastError: '',
            });
        });

        it('omits `lastError` from the write when error arg is undefined', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateState('github', 'loading' as never);

            expect(typeormRepo.update.mock.calls[0][1]).not.toHaveProperty('lastError');
        });
    });

    describe('updateSettings', () => {
        it('writes only `settings` when secretSettings is omitted', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateSettings('github', { foo: 'bar' });

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({ settings: { foo: 'bar' } });
        });

        it('includes secretSettings when provided', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateSettings('github', { foo: 'bar' }, { token: 'secret' });

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({
                settings: { foo: 'bar' },
                secretSettings: { token: 'secret' },
            });
        });

        it('passes secretSettings = {} verbatim — does NOT collapse to undefined', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'p-1' }),
            });

            await repo.updateSettings('github', { foo: 'bar' }, {});

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({
                settings: { foo: 'bar' },
                secretSettings: {},
            });
        });
    });

    describe('deleteByPluginId', () => {
        it('DELETEs by `pluginId` and returns true on affected > 0', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ delete: del });

            await expect(repo.deleteByPluginId('github')).resolves.toBe(true);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ pluginId: 'github' });
        });

        it('returns false when affected is 0 / undefined', async () => {
            const del = jest.fn().mockResolvedValueOnce({ affected: 0 });
            const { repo: r1 } = makeService({ delete: del });
            await expect(r1.deleteByPluginId('missing')).resolves.toBe(false);

            const del2 = jest.fn().mockResolvedValueOnce({ affected: undefined });
            const { repo: r2 } = makeService({ delete: del2 });
            await expect(r2.deleteByPluginId('legacy')).resolves.toBe(false);
        });
    });

    describe('delete (by id)', () => {
        it('DELETEs by id and returns true on affected > 0', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ delete: del });

            await expect(repo.delete('p-1')).resolves.toBe(true);
            expect(typeormRepo.delete).toHaveBeenCalledWith('p-1');
        });

        it('returns false when affected is 0', async () => {
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

    describe('exists', () => {
        it('uses `count` (NOT findOne) for a presence check', async () => {
            const count = jest.fn().mockResolvedValue(1);
            const { repo, typeormRepo } = makeService({ count });

            await expect(repo.exists('github')).resolves.toBe(true);
            expect(typeormRepo.count).toHaveBeenCalledWith({ where: { pluginId: 'github' } });
        });

        it('returns false when count === 0', async () => {
            const { repo } = makeService({ count: jest.fn().mockResolvedValue(0) });
            await expect(repo.exists('missing')).resolves.toBe(false);
        });

        it('returns true when count > 1 (defensive predicate `> 0`, NOT `=== 1`)', async () => {
            const { repo } = makeService({ count: jest.fn().mockResolvedValue(2) });
            await expect(repo.exists('dup')).resolves.toBe(true);
        });
    });

    describe('upsert', () => {
        it('UPDATEs the existing row when one is found and refetches it', async () => {
            const existing: Partial<PluginEntity> = { id: 'p-1', pluginId: 'github' };
            const updated: Partial<PluginEntity> = { ...existing, name: 'GitHub' };
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing) // initial findByPluginId
                .mockResolvedValueOnce(updated); // re-fetch after update
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.upsert({ pluginId: 'github', name: 'GitHub' });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { pluginId: 'github' },
                { pluginId: 'github', name: 'GitHub' },
            );
            expect(result).toBe(updated);
            // create/save MUST NOT be called when the row already exists
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
        });

        it('CREATEs + SAVEs a fresh row when none is found', async () => {
            const data: Partial<PluginEntity> = { pluginId: 'tavily', name: 'Tavily' };
            const created = { ...data };
            const saved = { ...created, id: 'p-new' };
            const findOne = jest.fn().mockResolvedValue(null);
            const create = jest.fn().mockReturnValue(created);
            const save = jest.fn().mockResolvedValue(saved);
            const { repo, typeormRepo } = makeService({ findOne, create, save });

            const result = await repo.upsert({ pluginId: 'tavily', name: 'Tavily' });

            expect(typeormRepo.create).toHaveBeenCalledWith({
                pluginId: 'tavily',
                name: 'Tavily',
            });
            expect(typeormRepo.save).toHaveBeenCalledWith(created);
            expect(result).toBe(saved);
            expect(typeormRepo.update).not.toHaveBeenCalled();
        });
    });
});
