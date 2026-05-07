import { describe, it, expect, beforeEach } from 'vitest';
import { LocalPluginStore } from '../trigger/worker/services/local-plugin-store';

describe('LocalPluginStore', () => {
    let store: LocalPluginStore;

    beforeEach(() => {
        store = new LocalPluginStore();
    });

    describe('create', () => {
        it('writes a new entity keyed by pluginId', async () => {
            const entity = await store.create({ pluginId: 'foo', name: 'Foo' } as any);

            expect(entity.id).toBe('foo');
            expect(entity.pluginId).toBe('foo');
            expect(entity.name).toBe('Foo');
            expect(await store.exists('foo')).toBe(true);
        });

        it('overwrites an existing entry on subsequent create', async () => {
            await store.create({ pluginId: 'foo', name: 'First' } as any);
            await store.create({ pluginId: 'foo', name: 'Second' } as any);

            const all = await store.findAll();
            expect(all).toHaveLength(1);
            expect(all[0].name).toBe('Second');
        });
    });

    describe('upsert', () => {
        it('inserts when not present', async () => {
            const entity = await store.upsert({ pluginId: 'a', name: 'A' } as any);

            expect(entity.pluginId).toBe('a');
            expect((entity as any).id).toBe('a');
        });

        it('merges into the existing entity instead of replacing', async () => {
            const first = await store.upsert({ pluginId: 'a', name: 'A', enabled: true } as any);
            const second = await store.upsert({ pluginId: 'a', name: 'A2' } as any);

            expect(second).toBe(first);
            expect((second as any).name).toBe('A2');
            expect((second as any).enabled).toBe(true);
        });
    });

    describe('update', () => {
        it('returns null when the id is unknown', async () => {
            const result = await store.update('missing', { name: 'X' } as any);
            expect(result).toBeNull();
        });

        it('mutates the existing entity in place', async () => {
            await store.create({ pluginId: 'p', name: 'A' } as any);
            const updated = await store.update('p', { name: 'B' } as any);

            expect(updated).not.toBeNull();
            expect((updated as any).name).toBe('B');
            const fromStore = (await store.findAll())[0];
            expect((fromStore as any).name).toBe('B');
        });
    });

    describe('delete / deleteByPluginId', () => {
        it('returns false when nothing was deleted', async () => {
            expect(await store.delete('missing')).toBe(false);
            expect(await store.deleteByPluginId('missing')).toBe(false);
        });

        it('removes the entity and reports true', async () => {
            await store.create({ pluginId: 'p' } as any);
            expect(await store.delete('p')).toBe(true);
            expect(await store.exists('p')).toBe(false);
        });

        it('deleteByPluginId is an alias for delete by id', async () => {
            await store.create({ pluginId: 'p' } as any);
            expect(await store.deleteByPluginId('p')).toBe(true);
        });
    });

    describe('updateState', () => {
        it('returns null when the plugin is unknown', async () => {
            const out = await store.updateState('missing', 'enabled' as any);
            expect(out).toBeNull();
        });

        it('updates state without touching lastError when not provided', async () => {
            await store.create({ pluginId: 'p', state: 'disabled', lastError: 'old' } as any);
            const out = await store.updateState('p', 'enabled' as any);

            expect((out as any).state).toBe('enabled');
            expect((out as any).lastError).toBe('old');
        });

        it('updates lastError when provided', async () => {
            await store.create({ pluginId: 'p', state: 'enabled' } as any);
            const out = await store.updateState('p', 'failed' as any, 'boom');

            expect((out as any).state).toBe('failed');
            expect((out as any).lastError).toBe('boom');
        });
    });

    describe('updateByPluginId', () => {
        it('returns null when the plugin is unknown', async () => {
            const out = await store.updateByPluginId('missing', { foo: 1 });
            expect(out).toBeNull();
        });

        it('merges arbitrary fields into the entity', async () => {
            await store.create({ pluginId: 'p', name: 'A' } as any);
            const out = await store.updateByPluginId('p', { name: 'B', extra: 1 });

            expect((out as any).name).toBe('B');
            expect((out as any).extra).toBe(1);
        });
    });

    describe('findAll / findEnabled', () => {
        it('findAll returns all stored entities', async () => {
            await store.create({ pluginId: 'a' } as any);
            await store.create({ pluginId: 'b' } as any);

            const all = await store.findAll();
            expect(all.map((e) => e.pluginId).sort()).toEqual(['a', 'b']);
        });

        it('findEnabled filters by enabled flag', async () => {
            await store.create({ pluginId: 'a', enabled: true } as any);
            await store.create({ pluginId: 'b', enabled: false } as any);
            await store.create({ pluginId: 'c', enabled: true } as any);

            const enabled = await store.findEnabled();
            expect(enabled.map((e) => e.pluginId).sort()).toEqual(['a', 'c']);
        });
    });
});
