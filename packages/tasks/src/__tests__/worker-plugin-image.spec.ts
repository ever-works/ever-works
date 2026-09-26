import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

/**
 * EW-693 T27 — what the worker IMAGE carries for the runtime-installed half
 * (owner decision: "core-only + third-party"; bundled stays the default).
 *
 * 1. `scripts/prepare-plugins.js` copies every first-party plugin in bundled
 *    mode (unchanged) and only the CORE ones when `PLUGIN_DISTRIBUTION_MODE`
 *    is `dynamic` at build time, so a distributable plugin is installed at run
 *    time — the version the API pinned — instead of running whatever version
 *    the image carried.
 * 2. `trigger.config.ts` keeps `pacote` (the installer's registry client, a
 *    dependency of `@ever-works/agent` only) out of the bundle and installs it
 *    into the image, at the agent's range.
 */

const requireCjs = createRequire(__filename);
const TASKS_ROOT = path.resolve(__dirname, '../..');

interface PrepareModule {
    preparePlugins(options: {
        source: string;
        destination: string;
        env: Record<string, string | undefined>;
        log?: (line: string) => void;
    }): { mode: string; copied: string[]; skipped: string[] };
    isCorePlugin(manifest: Record<string, unknown> | undefined): boolean;
}

const prepare = requireCjs(path.join(TASKS_ROOT, 'scripts/prepare-plugins.js')) as PrepareModule;

describe('prepare-plugins — the plugins the worker image carries (T27)', () => {
    let source: string;
    let destination: string;

    /** A built first-party plugin package under `source`. */
    function plugin(dir: string, manifest: Record<string, unknown>) {
        const root = path.join(source, dir);
        fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'module.exports = {};\n');
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: `@ever-works/${dir}-plugin`,
                version: '1.0.0',
                type: 'module',
                main: './dist/index.cjs',
                everworks: { plugin: { id: dir, ...manifest } },
            }),
        );
    }

    beforeEach(() => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew693-prepare-plugins-'));
        source = path.join(root, 'plugins-src');
        destination = path.join(root, 'plugins-dest');
        fs.mkdirSync(source, { recursive: true });
        plugin('local-fs', { systemPlugin: true }); // core by derivation
        plugin('postgres-db', { distribution: 'core' }); // core, declared
        plugin('notion-extractor', {}); // distributable by derivation
        plugin('aws-s3', { distribution: 'registry' }); // distributable, declared
        // An explicit `distribution` wins over `systemPlugin`.
        plugin('odd-one', { systemPlugin: true, distribution: 'registry' });
    });

    afterEach(() => {
        fs.rmSync(path.dirname(source), { recursive: true, force: true });
    });

    const run = (env: Record<string, string | undefined>) =>
        prepare.preparePlugins({ source, destination, env, log: () => undefined });

    const copiedDirs = () => fs.readdirSync(destination).sort();

    it('bundled mode (the default): copies every plugin, exactly as before', () => {
        const result = run({});

        expect(result.mode).toBe('bundled');
        expect(copiedDirs()).toEqual([
            'aws-s3',
            'local-fs',
            'notion-extractor',
            'odd-one',
            'postgres-db',
        ]);
        // The runtime package.json drops "type": "module".
        const pkg = JSON.parse(
            fs.readFileSync(path.join(destination, 'local-fs', 'package.json'), 'utf-8'),
        );
        expect(pkg.type).toBeUndefined();
        expect(pkg.everworks.plugin.id).toBe('local-fs');
    });

    it('dynamic mode: copies the CORE plugins only', () => {
        const result = run({ PLUGIN_DISTRIBUTION_MODE: 'dynamic' });

        expect(result.mode).toBe('dynamic');
        expect(copiedDirs()).toEqual(['local-fs', 'postgres-db']);
        expect(result.skipped.sort()).toEqual(['aws-s3', 'notion-extractor', 'odd-one']);
    });

    it('reads the mode as the API does — case-insensitive, anything else is bundled', () => {
        expect(run({ PLUGIN_DISTRIBUTION_MODE: 'DYNAMIC' }).mode).toBe('dynamic');
        expect(run({ PLUGIN_DISTRIBUTION_MODE: 'dynamc' }).mode).toBe('bundled');
        expect(copiedDirs()).toHaveLength(5);
    });

    it('classifies core the way the SDK’s resolvePluginDistribution does', () => {
        expect(prepare.isCorePlugin({ distribution: 'core' })).toBe(true);
        expect(prepare.isCorePlugin({ systemPlugin: true })).toBe(true);
        expect(prepare.isCorePlugin({ systemPlugin: true, distribution: 'registry' })).toBe(false);
        expect(prepare.isCorePlugin({ distribution: 'registry' })).toBe(false);
        expect(prepare.isCorePlugin({})).toBe(false);
        expect(prepare.isCorePlugin(undefined)).toBe(false);
    });

    it('agrees with the REAL first-party manifests: core plugins stay, distributable ones go', () => {
        const realSource = path.resolve(TASKS_ROOT, '../plugins');
        const manifests = fs
            .readdirSync(realSource, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(realSource, d.name, 'package.json'))
            .filter((p) => fs.existsSync(p))
            .map((p) => JSON.parse(fs.readFileSync(p, 'utf-8')).everworks?.plugin)
            .filter(Boolean) as Array<Record<string, unknown>>;

        const core = manifests.filter((m) => prepare.isCorePlugin(m)).map((m) => m.id);
        // `local-fs` is the core default storage (FR-4); `notion-extractor` and
        // the storage backends are distributable (spec examples).
        expect(core).toContain('local-fs');
        expect(core).not.toContain('notion-extractor');
        expect(core).not.toContain('aws-s3');
        expect(core.length).toBeLessThan(manifests.length);
    });
});

/**
 * `trigger.config.ts`, with the build extensions stubbed to hand back their
 * options: what `pacote` gets.
 */
describe('trigger.config — the installer’s registry client in the worker image (T27)', () => {
    it('keeps pacote out of the bundle and installs it at the agent’s range', async () => {
        vi.resetModules();
        vi.doMock('@trigger.dev/sdk', () => ({ defineConfig: (config: unknown) => config }));
        vi.doMock('@trigger.dev/build/extensions/typescript', () => ({
            emitDecoratorMetadata: () => ({ name: 'emitDecoratorMetadata' }),
        }));
        vi.doMock('@trigger.dev/build/extensions/core', () => ({
            additionalPackages: (options: { packages: string[] }) => ({
                name: 'additionalPackages',
                options,
            }),
            additionalFiles: (options: unknown) => ({ name: 'additionalFiles', options }),
        }));
        vi.doMock('../build/collect-plugin-deps', () => ({
            collectPluginDependencies: () => ['@tavily/core@^0.5.0'],
        }));

        const config = (await import('../../trigger.config')).default as unknown as {
            build: {
                external: string[];
                extensions: Array<{ name: string; options?: { packages?: string[] } }>;
            };
        };

        expect(config.build.external).toContain('pacote');
        const packages = config.build.extensions.find((e) => e.name === 'additionalPackages')!
            .options!.packages!;
        const agentRange = (
            JSON.parse(
                fs.readFileSync(path.resolve(TASKS_ROOT, '../agent/package.json'), 'utf-8'),
            ) as { dependencies: Record<string, string> }
        ).dependencies.pacote;
        expect(packages).toContain(`pacote@${agentRange}`);
        // The plugins' own dependencies are still collected.
        expect(packages).toContain('@tavily/core@^0.5.0');

        vi.doUnmock('@trigger.dev/sdk');
        vi.doUnmock('@trigger.dev/build/extensions/typescript');
        vi.doUnmock('@trigger.dev/build/extensions/core');
        vi.doUnmock('../build/collect-plugin-deps');
    });
});
