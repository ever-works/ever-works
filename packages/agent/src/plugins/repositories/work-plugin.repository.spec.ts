import { WorkPluginRepository } from './work-plugin.repository';
import type { WorkPluginEntity } from '../entities/work-plugin.entity';

/**
 * Pins the per-`(workId, pluginId)` semantics of the `work_plugins`
 * table — the per-work analogue of `user_plugins`. The composite key
 * (`workId`, `pluginId`) is the primary lookup mode, but this repository
 * additionally owns the **active-capability assignment** state — the
 * mechanism that lets a single work pick exactly one plugin per
 * capability among many that advertise it (e.g. one search provider out
 * of `tavily` / `brave` / `linkup` ...).
 *
 * Three non-trivial behaviours pinned by this suite:
 *   1. `findByWork` orders by `priority: ASC, createdAt: DESC` (a stable
 *      mixed sort: explicit operator priority wins, ties break in
 *      most-recently-added-first order).
 *   2. `findActiveByCapability` filters `enabled: true` rows in JS via
 *      `hasActiveCapability(workPlugin, capability)` — driver-agnostic
 *      because `activeCapabilities` is array-typed (same reason as
 *      `PluginRepository.findByCapability`).
 *   3. `setAsActiveForCapability` is a TWO-step operation
 *      (`clearActiveCapability` → `setActiveCapability`) — pinned so
 *      the single-active-plugin-per-capability invariant survives a
 *      concurrent caller. The clear runs first; if `setActiveCapability`
 *      fails, the work is left with NO active plugin for that capability
 *      (which is preferable to two simultaneously-active providers).
 *
 * Mocks the TypeORM `Repository<WorkPluginEntity>` directly.
 */
describe('WorkPluginRepository', () => {
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
        const repo = new WorkPluginRepository(typeormRepo as never);
        return { repo, typeormRepo };
    }

    describe('create', () => {
        it('proxies through `repository.create(data)` then `repository.save(...)`', async () => {
            const data = { workId: 'w-1', pluginId: 'p-1' };
            const created = { ...data, id: 'wp-1' };
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

    describe('findByWorkAndPlugin / findById', () => {
        it('queries `findOne` by composite key + pluginEntity relation', async () => {
            const row = { id: 'wp-1' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            await repo.findByWorkAndPlugin('w-1', 'p-1');

            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { workId: 'w-1', pluginId: 'p-1' },
                relations: ['pluginEntity'],
            });
        });

        it('queries `findOne` by id + pluginEntity relation', async () => {
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue({ id: 'wp-1' }),
            });

            await repo.findById('wp-1');

            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'wp-1' },
                relations: ['pluginEntity'],
            });
        });

        it('passes through null when no row exists', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findByWorkAndPlugin('w', 'p')).resolves.toBeNull();
            await expect(repo.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByWork (mixed sort)', () => {
        it('orders by `priority: ASC, createdAt: DESC` (ties break newest-first)', async () => {
            // The mixed sort is what gives the UI a stable list: explicit
            // operator priority wins, and ties break in most-recently-added
            // order. Pinned so a future "switch to createdAt only" tweak
            // is a deliberate diff.
            const rows = [{ id: 'wp-1' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            await repo.findByWork('w-1');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { workId: 'w-1' },
                relations: ['pluginEntity'],
                order: { priority: 'ASC', createdAt: 'DESC' },
            });
        });
    });

    describe('findEnabledByWork', () => {
        it('orders by `priority: ASC` only (no createdAt tie-breaker)', async () => {
            // The enabled-only listing is consumed by the runtime registry
            // which DOESN'T need the createdAt tie-breaker (caller-side
            // logic handles ties by capability resolution). Pinned so the
            // distinct ordering between findByWork and findEnabledByWork
            // doesn't drift.
            const rows = [{ id: 'wp-1' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            await repo.findEnabledByWork('w-1');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { workId: 'w-1', enabled: true },
                relations: ['pluginEntity'],
                order: { priority: 'ASC' },
            });
        });
    });

    describe('findActiveByCapability', () => {
        it('queries `find` for enabled rows with the pluginEntity relation, then filters by `hasActiveCapability` in JS', async () => {
            // Driver-agnostic in-memory filter (same reason as
            // PluginRepository.findByCapability). The query restricts to
            // enabled rows but the active-capability check is in JS.
            const rows = [
                { workId: 'w-1', pluginId: 'a', activeCapabilities: ['search'] },
                { workId: 'w-1', pluginId: 'b', activeCapabilities: ['ai-provider'] },
            ];
            const find = jest.fn().mockResolvedValue(rows);
            const { repo, typeormRepo } = makeService({ find });

            const result = await repo.findActiveByCapability('w-1', 'search');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { workId: 'w-1', enabled: true },
                relations: ['pluginEntity'],
            });
            expect(result).toEqual({
                workId: 'w-1',
                pluginId: 'a',
                activeCapabilities: ['search'],
            });
        });

        it('returns null when no enabled row advertises the capability', async () => {
            const { repo } = makeService({
                find: jest.fn().mockResolvedValue([
                    { pluginId: 'a', activeCapabilities: ['ai-provider'] },
                    { pluginId: 'b', activeCapabilities: [] },
                ]),
            });

            await expect(repo.findActiveByCapability('w-1', 'search')).resolves.toBeNull();
        });

        it('filters to the FIRST match (Array.find semantics) — pinned so a future "all-matches" change is deliberate', async () => {
            // Two plugins claiming the same active capability is an
            // invariant violation that `setAsActiveForCapability` is
            // designed to prevent. If it does happen anyway, this method
            // returns the first one — pinned so a future all-matches
            // refactor doesn't silently break callers.
            const { repo } = makeService({
                find: jest.fn().mockResolvedValue([
                    { pluginId: 'first', activeCapabilities: ['search'] },
                    { pluginId: 'second', activeCapabilities: ['search'] },
                ]),
            });

            const result = await repo.findActiveByCapability('w-1', 'search');
            expect(result?.pluginId).toBe('first');
        });
    });

    describe('findByPlugin / findEnabledByPlugin', () => {
        it('findByPlugin uses `where: { pluginId }` + `work` relation (inverse)', async () => {
            const find = jest.fn().mockResolvedValue([]);
            const { repo, typeormRepo } = makeService({ find });

            await repo.findByPlugin('p-1');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { pluginId: 'p-1' },
                relations: ['work'],
            });
        });

        it('findEnabledByPlugin filters by enabled and DOES NOT load the work relation', async () => {
            // The enabled-only variant is used by the lifecycle manager to
            // notify works of plugin state changes — it does NOT need the
            // work relation hydrated. Pinned so a future "always include
            // work" tweak is deliberate.
            const find = jest.fn().mockResolvedValue([]);
            const { repo, typeormRepo } = makeService({ find });

            await repo.findEnabledByPlugin('p-1');

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { pluginId: 'p-1', enabled: true },
            });
            expect(typeormRepo.find.mock.calls[0][0]).not.toHaveProperty('relations');
        });
    });

    describe('update / updateByWorkAndPlugin / updateSettings', () => {
        it('UPDATEs by id then refetches via findById', async () => {
            const updated = { id: 'wp-1' };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            const result = await repo.update('wp-1', { enabled: false });

            expect(typeormRepo.update).toHaveBeenCalledWith('wp-1', { enabled: false });
            expect(result).toBe(updated);
        });

        it('UPDATEs by composite key then refetches via findByWorkAndPlugin', async () => {
            const updated = { id: 'wp-1' };
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue(updated),
            });

            await repo.updateByWorkAndPlugin('w-1', 'p-1', { priority: 5 });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { workId: 'w-1', pluginId: 'p-1' },
                { priority: 5 },
            );
        });

        it('updateSettings — empty-object secretSettings forwarded verbatim, NOT collapsed to undefined', async () => {
            // Same `secretSettings !== undefined` semantics as the
            // user-plugin repository — empty object IS persisted (clears
            // secrets). Pinned across both repositories.
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'wp-1' }),
            });

            await repo.updateSettings('w-1', 'p-1', { foo: 'bar' }, {});

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({
                settings: { foo: 'bar' },
                secretSettings: {},
            });
        });

        it('updateSettings — secretSettings omitted when undefined', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'wp-1' }),
            });

            await repo.updateSettings('w-1', 'p-1', { foo: 'bar' });

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({ settings: { foo: 'bar' } });
        });
    });

    describe('setActiveCapability', () => {
        it('returns null when the row does not exist (no UPDATE issued)', async () => {
            const update = jest.fn();
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
                update,
            });

            await expect(repo.setActiveCapability('w-1', 'p-1', 'search')).resolves.toBeNull();
            expect(typeormRepo.update).not.toHaveBeenCalled();
        });

        it('clears activeCapabilities when capability arg is null', async () => {
            const existing = {
                workId: 'w-1',
                pluginId: 'p-1',
                activeCapabilities: ['search'],
            } as Partial<WorkPluginEntity>;
            const refetched = { ...existing, activeCapabilities: [] };
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce(refetched);
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.setActiveCapability('w-1', 'p-1', null);

            // The clear-path forwards an EMPTY ARRAY (not undefined) so
            // the field is reset rather than left with the old value.
            expect(typeormRepo.update.mock.calls[0][1]).toEqual({ activeCapabilities: [] });
            expect(result).toBe(refetched);
        });

        it('appends the capability to the existing list (deduped via Set)', async () => {
            const existing = {
                workId: 'w-1',
                pluginId: 'p-1',
                activeCapabilities: ['ai-provider'],
            } as Partial<WorkPluginEntity>;
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce({
                    ...existing,
                    activeCapabilities: ['ai-provider', 'search'],
                });
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            await repo.setActiveCapability('w-1', 'p-1', 'search');

            expect(typeormRepo.update.mock.calls[0][1]).toEqual({
                activeCapabilities: ['ai-provider', 'search'],
            });
        });

        it('dedupes when the capability is already present (Set semantics)', async () => {
            const existing = {
                workId: 'w-1',
                pluginId: 'p-1',
                activeCapabilities: ['search'],
            } as Partial<WorkPluginEntity>;
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce(existing);
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            await repo.setActiveCapability('w-1', 'p-1', 'search');

            // No duplicate added — `addActiveCapability` is Set-deduped.
            expect(typeormRepo.update.mock.calls[0][1]).toEqual({
                activeCapabilities: ['search'],
            });
        });
    });

    describe('clearActiveCapability', () => {
        it('finds all rows for the work and removes the capability ONLY from rows that had it', async () => {
            const all = [
                { workId: 'w-1', pluginId: 'a', activeCapabilities: ['search'] },
                { workId: 'w-1', pluginId: 'b', activeCapabilities: ['search', 'ai-provider'] },
                { workId: 'w-1', pluginId: 'c', activeCapabilities: ['ai-provider'] },
            ];
            const find = jest.fn().mockResolvedValue(all);
            const save = jest.fn().mockImplementation((row) => Promise.resolve(row));
            const { repo, typeormRepo } = makeService({ find, save });

            const result = await repo.clearActiveCapability('w-1', 'search');

            // Two rows touched: 'a' (loses search → []) and 'b' (loses
            // search → ['ai-provider']). 'c' is NOT touched.
            expect(result).toBe(2);
            expect(typeormRepo.save).toHaveBeenCalledTimes(2);

            const saved = typeormRepo.save.mock.calls.map((c) => c[0]);
            const a = saved.find((s) => s.pluginId === 'a');
            const b = saved.find((s) => s.pluginId === 'b');
            expect(a.activeCapabilities).toEqual([]);
            expect(b.activeCapabilities).toEqual(['ai-provider']);
        });

        it('returns 0 and saves nothing when no row has the capability', async () => {
            const find = jest
                .fn()
                .mockResolvedValue([
                    { workId: 'w-1', pluginId: 'a', activeCapabilities: ['ai-provider'] },
                ]);
            const save = jest.fn();
            const { repo, typeormRepo } = makeService({ find, save });

            await expect(repo.clearActiveCapability('w-1', 'search')).resolves.toBe(0);
            expect(typeormRepo.save).not.toHaveBeenCalled();
        });

        it('queries `find` WITHOUT a relation hint (fast path — clear-only does not need the join)', async () => {
            const find = jest.fn().mockResolvedValue([]);
            const { repo, typeormRepo } = makeService({ find });

            await repo.clearActiveCapability('w-1', 'search');

            expect(typeormRepo.find).toHaveBeenCalledWith({ where: { workId: 'w-1' } });
            expect(typeormRepo.find.mock.calls[0][0]).not.toHaveProperty('relations');
        });
    });

    describe('setAsActiveForCapability (clear → set)', () => {
        it('runs clearActiveCapability BEFORE setActiveCapability (single-active-per-capability invariant)', async () => {
            // The two-step is what enforces the "exactly one active plugin
            // per capability per work" invariant. Pinned so a future
            // "concurrent set" tweak can't accidentally leave two active.
            const callOrder: string[] = [];

            const all = [{ workId: 'w-1', pluginId: 'old', activeCapabilities: ['search'] }];
            const find = jest.fn().mockImplementation(() => {
                callOrder.push('find');
                return Promise.resolve(all);
            });
            const save = jest.fn().mockImplementation((row) => {
                callOrder.push('save');
                return Promise.resolve(row);
            });
            const findOne = jest.fn().mockImplementation(() => {
                callOrder.push('findOne');
                return Promise.resolve({
                    workId: 'w-1',
                    pluginId: 'new',
                    activeCapabilities: [],
                });
            });
            const update = jest.fn().mockImplementation(() => {
                callOrder.push('update');
                return Promise.resolve({ affected: 1 });
            });

            const { repo } = makeService({ find, save, findOne, update });

            await repo.setAsActiveForCapability('w-1', 'new', 'search');

            // Order: find (clear) → save (clear) → findOne (set lookup)
            // → update (set write) → findOne (set refetch)
            expect(callOrder.indexOf('find')).toBeLessThan(callOrder.indexOf('update'));
            expect(callOrder.indexOf('save')).toBeLessThan(callOrder.indexOf('update'));
        });
    });

    describe('setEnabled / setPriority', () => {
        it('setEnabled UPDATEs by composite key and returns true on affected > 0', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ update });

            await expect(repo.setEnabled('w-1', 'p-1', false)).resolves.toBe(true);
            expect(typeormRepo.update).toHaveBeenCalledWith(
                { workId: 'w-1', pluginId: 'p-1' },
                { enabled: false },
            );
        });

        it('setEnabled returns false on affected === 0 / undefined', async () => {
            const { repo: r1 } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 0 }),
            });
            await expect(r1.setEnabled('w-1', 'p-1', true)).resolves.toBe(false);

            const { repo: r2 } = makeService({
                update: jest.fn().mockResolvedValue({ affected: undefined }),
            });
            await expect(r2.setEnabled('w-1', 'p-1', true)).resolves.toBe(false);
        });

        it('setPriority UPDATEs `{priority}` by composite key', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ update });

            await expect(repo.setPriority('w-1', 'p-1', 7)).resolves.toBe(true);
            expect(typeormRepo.update).toHaveBeenCalledWith(
                { workId: 'w-1', pluginId: 'p-1' },
                { priority: 7 },
            );
        });

        it('setPriority returns false on affected === undefined', async () => {
            const { repo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: undefined }),
            });
            await expect(repo.setPriority('w-1', 'p-1', 1)).resolves.toBe(false);
        });
    });

    describe('delete*', () => {
        it('delete (by id) returns true on affected > 0', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 1 }),
            });
            await expect(repo.delete('wp-1')).resolves.toBe(true);
        });

        it('delete returns false on affected === undefined', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: undefined }),
            });
            await expect(repo.delete('legacy')).resolves.toBe(false);
        });

        it('deleteByWorkAndPlugin DELETEs by composite key', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo, typeormRepo } = makeService({ delete: del });

            await expect(repo.deleteByWorkAndPlugin('w-1', 'p-1')).resolves.toBe(true);
            expect(typeormRepo.delete).toHaveBeenCalledWith({
                workId: 'w-1',
                pluginId: 'p-1',
            });
        });

        it('deleteByWork returns the integer count of swept rows (NOT boolean)', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 5 });
            const { repo, typeormRepo } = makeService({ delete: del });

            const result = await repo.deleteByWork('w-1');

            expect(result).toBe(5);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ workId: 'w-1' });
        });

        it('deleteByWork returns 0 when affected is undefined', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: undefined }),
            });
            await expect(repo.deleteByWork('w-1')).resolves.toBe(0);
        });

        it('deleteByPlugin returns the integer count of swept rows', async () => {
            const del = jest.fn().mockResolvedValue({ affected: 12 });
            const { repo, typeormRepo } = makeService({ delete: del });

            const result = await repo.deleteByPlugin('p-1');

            expect(result).toBe(12);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ pluginId: 'p-1' });
        });
    });

    describe('exists', () => {
        it('uses count() with composite-key where; predicate is `> 0`', async () => {
            const count = jest.fn().mockResolvedValue(1);
            const { repo, typeormRepo } = makeService({ count });

            await expect(repo.exists('w-1', 'p-1')).resolves.toBe(true);
            expect(typeormRepo.count).toHaveBeenCalledWith({
                where: { workId: 'w-1', pluginId: 'p-1' },
            });
        });

        it('returns false on count === 0', async () => {
            const { repo } = makeService({ count: jest.fn().mockResolvedValue(0) });
            await expect(repo.exists('w', 'p')).resolves.toBe(false);
        });

        it('returns true on count > 1 (defensive `> 0`, NOT `=== 1`)', async () => {
            const { repo } = makeService({ count: jest.fn().mockResolvedValue(2) });
            await expect(repo.exists('w', 'p')).resolves.toBe(true);
        });
    });

    describe('upsert', () => {
        it('UPDATEs the existing row and refetches', async () => {
            const existing = { id: 'wp-1', workId: 'w-1', pluginId: 'p-1' };
            const updated = { ...existing, enabled: true };
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce(updated);
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.upsert({
                workId: 'w-1',
                pluginId: 'p-1',
                enabled: true,
            });

            expect(typeormRepo.update).toHaveBeenCalledWith(
                { workId: 'w-1', pluginId: 'p-1' },
                { workId: 'w-1', pluginId: 'p-1', enabled: true },
            );
            expect(result).toBe(updated);
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
        });

        it('CREATEs + SAVEs a fresh row when none is found', async () => {
            const data: Partial<WorkPluginEntity> = {
                workId: 'w-1',
                pluginId: 'p-1',
            };
            const created = { ...data };
            const saved = { ...created, id: 'wp-new' };
            const findOne = jest.fn().mockResolvedValue(null);
            const create = jest.fn().mockReturnValue(created);
            const save = jest.fn().mockResolvedValue(saved);
            const { repo, typeormRepo } = makeService({ findOne, create, save });

            const result = await repo.upsert({ workId: 'w-1', pluginId: 'p-1' });

            expect(typeormRepo.create).toHaveBeenCalledWith({ workId: 'w-1', pluginId: 'p-1' });
            expect(typeormRepo.save).toHaveBeenCalledWith(created);
            expect(result).toBe(saved);
            expect(typeormRepo.update).not.toHaveBeenCalled();
        });
    });
});
