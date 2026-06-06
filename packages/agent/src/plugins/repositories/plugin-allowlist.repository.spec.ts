import { PluginAllowlistRepository } from './plugin-allowlist.repository';
import type { PluginAllowlistEntity } from '../entities/plugin-allowlist.entity';

/**
 * EW-693 — thin TypeORM wrapper over `plugin_allowlist`. Pins the
 * three behaviours that matter for the installer's allow-check:
 *
 * 1. `findByPackageName` returns `null` when absent — callers MUST
 *    treat absence as "not permitted" (NOT as "implicitly allow").
 * 2. `findEnabled` filters out disabled rows in the query, so the
 *    installer cannot accidentally see a `disabled = true` row.
 * 3. `setEnabled` is a pure toggle helper (no allowlist-shape mutation).
 */
describe('PluginAllowlistRepository', () => {
    function makeRepository(overrides: Record<string, jest.Mock> = {}) {
        return {
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            ...overrides,
        };
    }

    function makeService(overrides: Record<string, jest.Mock> = {}) {
        const typeormRepo = makeRepository(overrides);
        const repo = new PluginAllowlistRepository(typeormRepo as never);
        return { repo, typeormRepo };
    }

    describe('findAll', () => {
        it('returns every row (enabled + disabled), ordered by package name', async () => {
            const rows = [{ id: 'a-1' }, { id: 'a-2' }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            const result = await repo.findAll();

            expect(typeormRepo.find).toHaveBeenCalledWith({ order: { packageName: 'ASC' } });
            expect(result).toBe(rows);
        });
    });

    describe('findEnabled', () => {
        it('filters out disabled rows in the SQL (not in JS)', async () => {
            const rows = [{ id: 'a-1', enabled: true }];
            const { repo, typeormRepo } = makeService({
                find: jest.fn().mockResolvedValue(rows),
            });

            await repo.findEnabled();

            expect(typeormRepo.find).toHaveBeenCalledWith({
                where: { enabled: true },
                order: { packageName: 'ASC' },
            });
        });
    });

    describe('findByPackageName', () => {
        it('returns the row when present', async () => {
            const row = { id: 'a-1', packageName: '@some-vendor/cool-plugin' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(row),
            });

            const result = await repo.findByPackageName('@some-vendor/cool-plugin');

            expect(typeormRepo.findOne).toHaveBeenCalledWith({
                where: { packageName: '@some-vendor/cool-plugin' },
            });
            expect(result).toBe(row);
        });

        it('returns null when absent (callers MUST NOT fall back to allow)', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findByPackageName('not-on-list')).resolves.toBeNull();
        });
    });

    describe('create', () => {
        it('proxies through create() then save()', async () => {
            const data: Partial<PluginAllowlistEntity> = {
                packageName: '@some-vendor/cool-plugin',
                versionRange: '^2.0.0',
            };
            const created = { ...data };
            const saved = { ...created, id: 'a-new' };

            const { repo, typeormRepo } = makeService({
                create: jest.fn().mockReturnValue(created),
                save: jest.fn().mockResolvedValue(saved),
            });

            const result = await repo.create(data);

            expect(typeormRepo.create).toHaveBeenCalledWith(data);
            expect(typeormRepo.save).toHaveBeenCalledWith(created);
            expect(result).toBe(saved);
        });
    });

    describe('setEnabled', () => {
        it('toggles via update + refetch (no other column changes)', async () => {
            const { repo, typeormRepo } = makeService({
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                findOne: jest.fn().mockResolvedValue({ id: 'a-1', enabled: false }),
            });

            await repo.setEnabled('a-1', false);

            expect(typeormRepo.update).toHaveBeenCalledWith('a-1', { enabled: false });
        });
    });

    describe('deleteById', () => {
        it('returns true on affected > 0, false on 0 / undefined', async () => {
            const del1 = jest.fn().mockResolvedValueOnce({ affected: 1 });
            const { repo: r1 } = makeService({ delete: del1 });
            await expect(r1.deleteById('a-1')).resolves.toBe(true);

            const del2 = jest.fn().mockResolvedValueOnce({ affected: 0 });
            const { repo: r2 } = makeService({ delete: del2 });
            await expect(r2.deleteById('a-missing')).resolves.toBe(false);

            const del3 = jest.fn().mockResolvedValueOnce({ affected: undefined });
            const { repo: r3 } = makeService({ delete: del3 });
            await expect(r3.deleteById('a-legacy')).resolves.toBe(false);
        });
    });
});
