import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The published `ever-works-node` manifest against what the bundle leaves
 * out.
 *
 * `build.js` inlines every workspace package into one `cli.js` and keeps
 * the native addons external. An external that is not also an (optional)
 * dependency of the published manifest is never installed, so the feature
 * behind it silently falls back on every machine that installs the CLI
 * from the registry — the build still succeeds and nothing fails loudly.
 */
const appRoot = join(__dirname, '../../..');
const repositoryRoot = join(appRoot, '../..');

interface BuildModule {
	bundleExternals(): Record<string, string>;
	buildPublishableManifest(
		manifest: Record<string, unknown>,
		version: string,
		externals: Record<string, string>
	): { optionalDependencies: Record<string, string> } & Record<string, unknown>;
}

const loadBuild = (): BuildModule => createRequire(__filename)(join(appRoot, 'build.js')) as BuildModule;

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

describe('publishable ever-works-node manifest', () => {
	it('ships every addon the bundle keeps external as an optional dependency', () => {
		const build = loadBuild();
		const externals = build.bundleExternals();
		const manifest = build.buildPublishableManifest(readJson(join(appRoot, 'package.json')), '0.0.0', externals);

		expect(Object.keys(externals).length).toBeGreaterThan(0);
		for (const [name, range] of Object.entries(externals)) {
			expect(manifest.optionalDependencies[name]).toBe(range);
		}
	});

	it('installs the PTY prebuild the bundled terminal host requires, at that plugin’s own range', () => {
		const ptyManifest = readJson(join(repositoryRoot, 'packages/plugins/pty-local/package.json')) as {
			optionalDependencies?: Record<string, string>;
		};
		const ptyRange = ptyManifest.optionalDependencies?.['@homebridge/node-pty-prebuilt-multiarch'];
		expect(typeof ptyRange).toBe('string');

		const build = loadBuild();
		const manifest = build.buildPublishableManifest(
			readJson(join(appRoot, 'package.json')),
			'0.0.0',
			build.bundleExternals()
		);

		expect(manifest.optionalDependencies).toMatchObject({
			'@napi-rs/keyring': expect.any(String),
			'@homebridge/node-pty-prebuilt-multiarch': ptyRange
		});
	});
});
