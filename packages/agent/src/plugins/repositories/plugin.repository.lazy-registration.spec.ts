import { DataSource } from 'typeorm';
import { PluginEntity } from '../entities/plugin.entity';
import { PluginRepository, type LazyRegistrationRow } from './plugin.repository';

/**
 * `PluginRepository.mergeLazyRegistration` — the row every lazy registration
 * writes (`PluginLoaderService.registerLazy`), against a REAL in-memory
 * better-sqlite3 `plugins` table.
 *
 * Every process boot registers each disk plugin lazily — with builtIns lazy
 * that is every API boot and every Trigger run — and the row another process
 * enriched on the plugin's first load (icon, homepage, readme, uiHints: what
 * only the class's `getManifest()` adds) must survive it when it was written
 * for the SAME version, and must not when it was written for another one.
 *
 * The read, the merge and the write are ONE repository method so the Trigger
 * worker's `LocalPluginStore` can answer the whole of it in memory: there
 * `PluginRepository` is a remote proxy whose reads go to the API, and a read
 * here cost one round trip per discovered plugin per run.
 */
describe('PluginRepository.mergeLazyRegistration (real sqlite)', () => {
    let dataSource: DataSource;
    let repository: PluginRepository;

    const PACKAGE_JSON = {
        id: 'lean-row',
        name: 'Lean Row',
        version: '2.0.0',
        category: 'utility',
        capabilities: ['test'],
        description: 'package.json description',
    };

    const row = (overrides: Partial<LazyRegistrationRow> = {}): LazyRegistrationRow => ({
        pluginId: 'lean-row',
        name: 'Lean Row',
        version: '2.0.0',
        description: 'package.json description',
        category: 'utility',
        capabilities: ['test'],
        builtIn: true,
        installPath: '/plugins/lean-row',
        state: 'loaded',
        ...overrides,
    });

    /** A row as another process left it after the plugin's first load. */
    async function seed(version: string, manifest: Record<string, unknown> | null) {
        await dataSource.getRepository(PluginEntity).save({
            pluginId: 'lean-row',
            name: 'Lean Row',
            version,
            description: 'enriched description',
            category: 'utility',
            capabilities: ['test'],
            manifest: manifest as Record<string, unknown>,
            builtIn: false,
            installPath: '/old/lean-row',
            state: 'unloaded',
            settings: { region: 'eu' },
            installState: 'installed',
        });
    }

    async function stored(): Promise<PluginEntity[]> {
        return dataSource.getRepository(PluginEntity).find({ where: { pluginId: 'lean-row' } });
    }

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [PluginEntity],
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new PluginRepository(dataSource.getRepository(PluginEntity));
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('writes the package.json manifest as it is when there is no row yet', async () => {
        const written = await repository.mergeLazyRegistration(row(), PACKAGE_JSON);

        const rows = await stored();
        expect(rows).toHaveLength(1);
        expect(rows[0].manifest).toEqual(PACKAGE_JSON);
        expect(rows[0]).toMatchObject({
            version: '2.0.0',
            state: 'loaded',
            builtIn: true,
            installPath: '/plugins/lean-row',
        });
        expect(written?.pluginId).toBe('lean-row');
    });

    it('keeps the manifest keys a row of the same version already has, package.json winning on conflict', async () => {
        await seed('2.0.0', {
            id: 'lean-row',
            name: 'Lean Row',
            version: '2.0.0',
            description: 'enriched description',
            icon: 'enriched-icon',
            homepage: 'https://enriched.example',
            readme: '## Enriched',
        });

        await repository.mergeLazyRegistration(row(), {
            ...PACKAGE_JSON,
            // An undefined package.json value does not erase the row's.
            homepage: undefined,
        });

        const rows = await stored();
        expect(rows).toHaveLength(1);
        expect(rows[0].manifest).toEqual({
            id: 'lean-row',
            name: 'Lean Row',
            version: '2.0.0',
            category: 'utility',
            capabilities: ['test'],
            // package.json wins where both carry the key.
            description: 'package.json description',
            icon: 'enriched-icon',
            homepage: 'https://enriched.example',
            readme: '## Enriched',
        });
        // The registration's own columns are written as for any other row …
        expect(rows[0]).toMatchObject({
            version: '2.0.0',
            description: 'package.json description',
            state: 'loaded',
            builtIn: true,
            installPath: '/plugins/lean-row',
        });
        // … and the columns it does not own are left alone.
        expect(rows[0].settings).toEqual({ region: 'eu' });
        expect(rows[0].installState).toBe('installed');
    });

    it('writes the package.json manifest as it is over a row another version enriched', async () => {
        await seed('1.0.0', {
            id: 'lean-row',
            name: 'Lean Row',
            version: '1.0.0',
            description: 'enriched description',
            icon: 'enriched-icon',
            // What version 1.0.0's getManifest() declared and 2.0.0 no longer
            // does: readers that trust the row (works-config projection, the
            // catalog, the installer) must not keep it.
            supplementary: true,
        });

        await repository.mergeLazyRegistration(row(), PACKAGE_JSON);

        const rows = await stored();
        expect(rows).toHaveLength(1);
        expect(rows[0].manifest).toEqual(PACKAGE_JSON);
        expect(rows[0]).toMatchObject({ version: '2.0.0', state: 'loaded' });
        expect(rows[0].settings).toEqual({ region: 'eu' });
    });

    it('writes the package.json manifest over a row that has no manifest', async () => {
        await seed('2.0.0', null);

        await repository.mergeLazyRegistration(row(), PACKAGE_JSON);

        const rows = await stored();
        expect(rows).toHaveLength(1);
        expect(rows[0].manifest).toEqual(PACKAGE_JSON);
        expect(rows[0]).toMatchObject({ state: 'loaded', installPath: '/plugins/lean-row' });
        expect(rows[0].settings).toEqual({ region: 'eu' });
    });

    it('does not rewrite one row with another plugin’s registration', async () => {
        await seed('2.0.0', { id: 'lean-row', icon: 'enriched-icon' });

        await repository.mergeLazyRegistration(row({ pluginId: 'other', name: 'Other' }), {
            ...PACKAGE_JSON,
            id: 'other',
        });

        expect((await stored())[0].manifest).toEqual({ id: 'lean-row', icon: 'enriched-icon' });
        const other = await repository.findByPluginId('other');
        expect(other?.manifest).toEqual({ ...PACKAGE_JSON, id: 'other' });
    });

    it('writes the row when its first read fails, reading it again to do so', async () => {
        // As `persistLazyRegistration` did: a failed read is not a failed
        // registration on its own — the write reads the row again.
        await seed('2.0.0', { id: 'lean-row', icon: 'enriched-icon' });
        jest.spyOn(repository, 'findByPluginId').mockRejectedValueOnce(new Error('read blip'));

        await repository.mergeLazyRegistration(row(), PACKAGE_JSON);

        const rows = await stored();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ version: '2.0.0', state: 'loaded' });
    });

    it('rejects when the row cannot be read at all', async () => {
        jest.spyOn(repository, 'findByPluginId').mockRejectedValue(new Error('db down'));

        await expect(repository.mergeLazyRegistration(row(), PACKAGE_JSON)).rejects.toThrow(
            'db down',
        );
    });
});
