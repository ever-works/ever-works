import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const { fsMock } = vi.hoisted(() => ({
    fsMock: {
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        readFileSync: vi.fn(),
    },
}));

vi.mock('fs', () => fsMock);

import { collectPluginDependencies } from '../build/collect-plugin-deps';

const PLUGINS_DIR = path.resolve(__dirname, '../../../../packages/plugins');

describe('collectPluginDependencies', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('returns [] and warns when the plugins directory is missing', () => {
        fsMock.existsSync.mockReturnValue(false);

        const result = collectPluginDependencies();

        expect(result).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
            '[collectPluginDeps] Plugin source not found:',
            PLUGINS_DIR,
        );
    });

    it('skips entries that are not directories', () => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([{ name: 'README.md', isDirectory: () => false }]);

        const result = collectPluginDependencies();
        expect(result).toEqual([]);
    });

    it('skips directories without package.json', () => {
        fsMock.existsSync.mockImplementation((p: any) => {
            return typeof p === 'string' && p === PLUGINS_DIR;
        });
        fsMock.readdirSync.mockReturnValue([{ name: 'pluginA', isDirectory: () => true }]);

        const result = collectPluginDependencies();
        expect(result).toEqual([]);
    });

    it('skips packages without an everworks.plugin manifest', () => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([{ name: 'pluginA', isDirectory: () => true }]);
        fsMock.readFileSync.mockReturnValue(
            JSON.stringify({ name: 'pluginA', dependencies: { axios: '^1.0.0' } }),
        );

        const result = collectPluginDependencies();
        expect(result).toEqual([]);
    });

    it('skips workspace: dependencies and @ever-works/* packages', () => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([{ name: 'pluginA', isDirectory: () => true }]);
        fsMock.readFileSync.mockReturnValue(
            JSON.stringify({
                name: 'pluginA',
                everworks: { plugin: { id: 'pluginA' } },
                dependencies: {
                    axios: '^1.0.0',
                    '@ever-works/plugin': 'workspace:*',
                    '@ever-works/contracts': '^1.0.0',
                    '@some-vendor/sdk': 'workspace:^1.0.0',
                },
            }),
        );

        const result = collectPluginDependencies();
        expect(result).toEqual(['axios@^1.0.0']);
    });

    it('aggregates dependencies and peerDependencies and dedupes across plugins', () => {
        const pkgA = {
            everworks: { plugin: { id: 'a' } },
            dependencies: { axios: '^1.0.0', lodash: '^4.0.0' },
        };
        const pkgB = {
            everworks: { plugin: { id: 'b' } },
            dependencies: { axios: '^1.0.0' },
            peerDependencies: { 'date-fns': '^3.0.0' },
        };

        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([
            { name: 'a', isDirectory: () => true },
            { name: 'b', isDirectory: () => true },
        ]);
        fsMock.readFileSync.mockImplementation((p: any) => {
            const str = String(p).replace(/\\/g, '/');
            if (str.endsWith('/a/package.json')) return JSON.stringify(pkgA);
            return JSON.stringify(pkgB);
        });

        const result = collectPluginDependencies();
        expect(result).toEqual(['axios@^1.0.0', 'date-fns@^3.0.0', 'lodash@^4.0.0']);
    });

    it('logs the dependency count via console.log', () => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([{ name: 'a', isDirectory: () => true }]);
        fsMock.readFileSync.mockReturnValue(
            JSON.stringify({
                everworks: { plugin: { id: 'a' } },
                dependencies: { axios: '^1.0.0' },
            }),
        );

        collectPluginDependencies();
        expect(logSpy).toHaveBeenCalledWith('[collectPluginDeps] Found 1 plugin dependencies');
    });

    it('returns sorted alphabetically', () => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readdirSync.mockReturnValue([{ name: 'a', isDirectory: () => true }]);
        fsMock.readFileSync.mockReturnValue(
            JSON.stringify({
                everworks: { plugin: { id: 'a' } },
                dependencies: { zlib: '^1.0.0', alpha: '^1.0.0', mu: '^1.0.0' },
            }),
        );

        const result = collectPluginDependencies();
        expect(result).toEqual(['alpha@^1.0.0', 'mu@^1.0.0', 'zlib@^1.0.0']);
    });
});
