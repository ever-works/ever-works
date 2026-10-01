import { Logger } from '@nestjs/common';
import { WorksConfigProjectionService } from '../services/works-config-projection.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

/**
 * The `.works/works.yml` provider projection must leave supplementary plugins
 * out. The flag is read from the plugin's DB row, but that row holds the
 * package.json manifest alone until the plugin's first use in some process
 * (every boot re-registers each plugin lazily and upserts that lean manifest)
 * — and pdf-extractor / officecli-extractor declare `supplementary` only in
 * their class's getManifest(). The registry entry carries it once the plugin
 * has loaded.
 */
describe('WorksConfigProjectionService — supplementary plugins held cold', () => {
    const work = { id: 'work-1', name: 'Cold Projection' } as never;

    function build(workPlugins: unknown[]) {
        const registry = createRegistry();
        const scheduleRepository = {
            findByWorkId: jest.fn().mockResolvedValue({ providerOverrides: null }),
        };
        const workPluginRepository = {
            findEnabledByWork: jest.fn().mockResolvedValue(workPlugins),
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as never,
            workPluginRepository as never,
            registry,
        );
        return { registry, service };
    }

    it('leaves out a plugin whose supplementary flag only its getManifest() declares', async () => {
        const { registry, service } = build([
            {
                pluginId: 'cold-extractor',
                activeCapabilities: ['content-extractor'],
                pluginEntity: { manifest: {} },
            },
            {
                pluginId: 'cold-supplementary-extractor',
                activeCapabilities: ['content-extractor'],
                pluginEntity: { manifest: {} },
            },
        ]);
        registerColdPlugin(registry, {
            id: 'cold-extractor',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-supplementary-extractor',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { supplementary: true },
        });

        const request = await service.buildWriteRequest(work);

        expect(request.providers).toEqual({ contentExtractor: 'cold-extractor' });
    });

    it("still projects a plugin that cannot load (the projection mirrors the Work's configuration)", async () => {
        const { registry, service } = build([
            {
                pluginId: 'cold-broken-search',
                activeCapabilities: ['search'],
                pluginEntity: { manifest: {} },
            },
        ]);
        registerColdPlugin(registry, {
            id: 'cold-broken-search',
            capabilities: ['search'],
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        const request = await service.buildWriteRequest(work);

        expect(request.providers).toEqual({ search: 'cold-broken-search' });
    });

    it('does not load a plugin with no active capability to project', async () => {
        const { registry, service } = build([
            {
                pluginId: 'cold-inactive',
                activeCapabilities: [],
                pluginEntity: { manifest: {} },
            },
        ]);
        const inactive = registerColdPlugin(registry, {
            id: 'cold-inactive',
            capabilities: ['search'],
            settingsSchema: requiredSecretSchema(),
        });

        const request = await service.buildWriteRequest(work);

        expect(request.providers).toBeNull();
        expect(inactive.loads()).toBe(0);
    });
});
