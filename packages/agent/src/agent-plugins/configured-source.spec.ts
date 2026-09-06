import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
    configuredPackageDirs,
    loadedPackages,
    rejectedPackages,
    scanConfiguredPackages,
} from './configured-source';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

async function packageDir(name: string, manifestName?: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-plugins-cfg-'));
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ $schema: PLUGIN_SCHEMA, name: manifestName ?? name }),
        'utf8',
    );
    return root;
}

describe('agent-plugins configured source', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.FEATURE_AGENT_PLUGINS;
        delete process.env.AGENT_PLUGINS_DIR;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('when the flag is off', () => {
        it('scans nothing at all, and says so', async () => {
            const root = await packageDir('alpha');
            process.env.AGENT_PLUGINS_DIR = root;

            const result = await scanConfiguredPackages();

            // `enabled: false` is distinguishable from "on but empty" on
            // purpose: an operator who turns the flag on and still sees
            // nothing needs to know which of the two they are looking at.
            expect(result.enabled).toBe(false);
            expect(result.roots).toEqual([]);
            expect(result.scans).toEqual([]);
            expect(loadedPackages(result)).toEqual([]);
        });

        it('does not even read the configured directory', async () => {
            // The catalog runs this on every request, so "off" must cost
            // nothing — not one filesystem call.
            process.env.AGENT_PLUGINS_DIR = '/definitely/not/a/real/path';
            await expect(scanConfiguredPackages()).resolves.toEqual({
                enabled: false,
                roots: [],
                scans: [],
                shadowed: [],
            });
        });
    });

    describe('when the flag is on', () => {
        beforeEach(() => {
            process.env.FEATURE_AGENT_PLUGINS = 'true';
        });

        it('finds packages in the configured directory', async () => {
            const root = await packageDir('alpha');
            process.env.AGENT_PLUGINS_DIR = root;

            const result = await scanConfiguredPackages();

            expect(result.enabled).toBe(true);
            expect(result.roots).toEqual([root]);
            expect(loadedPackages(result).map((p) => p.name)).toEqual(['alpha']);
        });

        it('reports a missing directory as empty rather than failing', async () => {
            // Nothing creates the default directory — no Dockerfile mkdir, no
            // volume mount — so every existing deployment hits this path the
            // first time the flag is turned on. It must not be an error.
            process.env.AGENT_PLUGINS_DIR = '/no/such/directory/anywhere';

            const result = await scanConfiguredPackages();

            expect(result.enabled).toBe(true);
            expect(loadedPackages(result)).toEqual([]);
            expect(result.scans[0]?.unavailable).toBe(true);
        });

        it('separates packages that loaded from packages that were rejected', async () => {
            const root = await mkdtemp(join(tmpdir(), 'agent-plugins-cfg-'));
            await mkdir(join(root, 'good'), { recursive: true });
            await writeFile(
                join(root, 'good', 'plugin.json'),
                JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'good' }),
                'utf8',
            );
            await mkdir(join(root, 'bad'), { recursive: true });
            await writeFile(
                join(root, 'bad', 'plugin.json'),
                JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }),
                'utf8',
            );
            process.env.AGENT_PLUGINS_DIR = root;

            const result = await scanConfiguredPackages();

            expect(loadedPackages(result).map((p) => p.name)).toEqual(['good']);
            // A rejected package was put there deliberately, so its absence
            // from the catalog needs an explanation rather than silence.
            expect(rejectedPackages(result).map((p) => p.dirName)).toEqual(['bad']);
        });

        it('scans several configured directories, first definition winning', async () => {
            const primary = await packageDir('one', 'shared');
            const secondary = await packageDir('two', 'shared');
            process.env.AGENT_PLUGINS_DIR = [primary, secondary].join(delimiter);

            const result = await scanConfiguredPackages();

            expect(result.roots).toEqual([primary, secondary]);
            expect(loadedPackages(result).map((p) => p.name)).toEqual(['shared']);
            expect(result.shadowed.map((p) => p.dirName)).toEqual(['two']);
        });

        it('uses the default directory when none is configured', () => {
            expect(configuredPackageDirs()).toEqual(['/app/agent-plugins']);
        });

        it('treats an empty configured value as unset', () => {
            process.env.AGENT_PLUGINS_DIR = '';
            expect(configuredPackageDirs()).toEqual(['/app/agent-plugins']);
        });
    });
});
