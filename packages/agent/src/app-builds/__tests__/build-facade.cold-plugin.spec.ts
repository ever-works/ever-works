import type { IPlugin, PluginManifest } from '@ever-works/plugin';

import { createLazyPluginProxy } from '../../plugins/services/lazy-plugin-proxy';
import { BuildFacadeService, type BuildTokenSource } from '../build-facade.service';

/**
 * APW-05 T16 — `BuildFacadeService.resolve` reads a build plugin's RUNTIME members, so it loads
 * the plugin first.
 *
 * ## The defect this pins
 *
 * Disk built-ins are registered as lazy proxies and stay cold until something uses them
 * (`plugin-bootstrap.service.ts`, unless `PLUGIN_EAGER_BUILTINS=true`), and
 * `github-actions-build` is one. A cold proxy answers a member its manifest does not carry
 * with an async forwarding WRAPPER — a function (`lazy-plugin-proxy.ts`'s "Reading a member
 * the manifest does not carry"). `buildKind` is such a member, so on a cold plugin:
 *
 *   - the shape filter `!!plugin.buildKind` was true for ANY plugin declaring `build`, whether
 *     or not the real instance has a `buildKind`;
 *   - `binding.buildKind` was that wrapper function, not `'github-actions'` — the value
 *     `evaluateBuildVerdict` compares against `'apps-builder'` to decide whether a signature is
 *     required, so a cold `apps-builder` plugin would have skipped the signature gate;
 *   - a plugin whose import or `onLoad` fails still produced a binding, which failed later,
 *     inside `startBuild`, instead of being left out as a boot-time load failure would be.
 *
 * Found by review 2026-09-26, once `BuildFacadeService` became reachable in the API.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const tokens: BuildTokenSource = { getBuildToken: async () => 'ghs-not-a-real-token' };

function manifest(id: string): PluginManifest {
    // What a package.json `everworks.plugin` block carries: no `buildKind`.
    return {
        id,
        name: id,
        version: '1.0.0',
        description: 'build plugin',
        category: 'build',
        capabilities: ['build'],
    } as unknown as PluginManifest;
}

function realBuildPlugin(id: string, overrides: Record<string, unknown> = {}): IPlugin {
    return {
        id,
        name: id,
        version: '1.0.0',
        category: 'build',
        capabilities: ['build'],
        buildKind: 'github-actions',
        startBuild: jest.fn(async () => ({
            providerRunId: '9001',
            dispatchedAt: '2026-09-26T10:00:00.000Z',
        })),
        cancelBuild: jest.fn(async () => undefined),
        onLoad: jest.fn(async () => undefined),
        onUnload: jest.fn(async () => undefined),
        ...overrides,
    } as unknown as IPlugin;
}

function facadeOver(entries: Array<{ plugin: unknown; state?: string }>) {
    const registered = entries.map((entry) => ({
        state: entry.state ?? 'loaded',
        manifest: { capabilities: ['build'] },
        plugin: entry.plugin,
    }));
    const registry = { getAll: () => registered } as never;
    const work = {
        id: WORK_ID,
        getWebsiteRepo: () => 'their-app',
        getRepoOwner: () => 'acme',
    };
    const repository = { findById: async () => work } as never;
    return { facade: new BuildFacadeService(registry, repository, tokens), registered };
}

describe('BuildFacadeService — a cold lazy build plugin is loaded before it is read', () => {
    it("answers the real buildKind string, not the cold proxy's forwarding wrapper", async () => {
        const loader = jest.fn(async () => realBuildPlugin('github-actions-build'));
        const cold = createLazyPluginProxy(manifest('github-actions-build'), loader);

        const binding = await facadeOver([{ plugin: cold }]).facade.resolve(WORK_ID, USER_ID);

        expect(binding?.pluginId).toBe('github-actions-build');
        expect(binding?.buildKind).toBe('github-actions');
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('leaves out a plugin whose real instance is not a build plugin', async () => {
        const notABuildPlugin = createLazyPluginProxy(manifest('liar'), async () =>
            realBuildPlugin('liar', { buildKind: undefined, startBuild: undefined }),
        );

        expect(
            await facadeOver([{ plugin: notABuildPlugin }]).facade.resolve(WORK_ID, USER_ID),
        ).toBeNull();
    });

    it('leaves out a plugin that cannot load, as a boot-time load failure would be', async () => {
        const broken = createLazyPluginProxy(manifest('broken'), async () => null);

        expect(await facadeOver([{ plugin: broken }]).facade.resolve(WORK_ID, USER_ID)).toBeNull();
    });

    it('counts only the plugins that load when it refuses to pick between two', async () => {
        const good = createLazyPluginProxy(manifest('github-actions-build'), async () =>
            realBuildPlugin('github-actions-build'),
        );
        const broken = createLazyPluginProxy(manifest('broken'), async () => null);

        const binding = await facadeOver([{ plugin: good }, { plugin: broken }]).facade.resolve(
            WORK_ID,
            USER_ID,
        );

        expect(binding?.pluginId).toBe('github-actions-build');
    });
});
