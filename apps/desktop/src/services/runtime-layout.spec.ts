import { describe, expect, it } from 'vitest';
import type { BundleManifest, LayoutIo } from './runtime-layout';
import {
	BUNDLE_DIR_NAME,
	BUNDLE_MANIFEST_NAME,
	REPO_MARKER,
	parseBundleManifest,
	resolveRuntimeLayout,
	resolveServiceLaunch,
	toLayoutSummary
} from './runtime-layout';

/** Deliberately POSIX-ish join with `..` collapsing, so tests are platform-independent. */
function join(...segments: string[]): string {
	const parts: string[] = [];
	for (const segment of segments.join('/').split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return `/${parts.join('/')}`;
}

function ioWith(files: Record<string, string>): LayoutIo {
	return {
		exists: (path: string) => Object.prototype.hasOwnProperty.call(files, path),
		readFile: (path: string) => files[path],
		join
	};
}

const manifest: BundleManifest = {
	schema: 1,
	bundled: true,
	version: '0.1.0',
	generatedAt: '2026-07-26T00:00:00.000Z',
	api: { entry: 'api/dist/main.js', cwd: 'api' },
	web: { entry: 'web/apps/web/server.js', cwd: 'web/apps/web' }
};

const bundledFiles = {
	[join('/opt/app/resources', BUNDLE_DIR_NAME, BUNDLE_MANIFEST_NAME)]: JSON.stringify(manifest)
};

describe('parseBundleManifest', () => {
	it('parses a well-formed manifest', () => {
		expect(parseBundleManifest(JSON.stringify(manifest))).toEqual(manifest);
	});

	it('rejects missing, non-JSON, non-object and future-schema payloads', () => {
		expect(parseBundleManifest(undefined)).toBeUndefined();
		expect(parseBundleManifest('{not json')).toBeUndefined();
		expect(parseBundleManifest('"a string"')).toBeUndefined();
		expect(parseBundleManifest(JSON.stringify({ ...manifest, schema: 99 }))).toBeUndefined();
		expect(parseBundleManifest(JSON.stringify({ bundled: true }))).toBeUndefined();
	});

	it('drops malformed service entries rather than trusting them', () => {
		const parsed = parseBundleManifest(JSON.stringify({ ...manifest, api: { entry: '' }, web: 42 }));
		expect(parsed?.api).toBeUndefined();
		expect(parsed?.web).toBeUndefined();
	});
});

describe('resolveRuntimeLayout', () => {
	it('prefers the bundled runtime payload shipped inside the installer', () => {
		const layout = resolveRuntimeLayout(ioWith(bundledFiles), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar'
		});
		expect(layout.kind).toBe('bundled');
		expect(layout.bundleRoot).toBe('/opt/app/resources/app-bundle');
		expect(layout.bundleVersion).toBe('0.1.0');
		expect(layout.requiresHostToolchain).toBe(false);
	});

	it('falls back to EVER_WORKS_REPO_ROOT when the installer has no payload', () => {
		const layout = resolveRuntimeLayout(ioWith({ [join('/checkout', REPO_MARKER)]: 'packages:' }), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar',
			envRepoRoot: '/checkout'
		});
		expect(layout.kind).toBe('repo');
		expect(layout.repoRoot).toBe('/checkout');
		expect(layout.requiresHostToolchain).toBe(true);
	});

	it('falls back to the development checkout two levels above the app path', () => {
		const layout = resolveRuntimeLayout(ioWith({ [join('/repo', REPO_MARKER)]: 'packages:' }), {
			appPath: '/repo/apps/desktop'
		});
		expect(layout.kind).toBe('repo');
		expect(layout.repoRoot).toBe('/repo');
	});

	it('reports unavailable with an explanation when nothing is present', () => {
		const layout = resolveRuntimeLayout(ioWith({}), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar',
			envRepoRoot: '/nope'
		});
		expect(layout.kind).toBe('unavailable');
		expect(layout.reason).toContain('no runtime payload');
		expect(layout.reason).toContain('EVER_WORKS_REPO_ROOT=/nope');
		expect(layout.requiresHostToolchain).toBe(false);
	});

	it('explains a placeholder manifest emitted by an unbundled packaging run', () => {
		const files = {
			[join('/opt/app/resources', BUNDLE_DIR_NAME, BUNDLE_MANIFEST_NAME)]: JSON.stringify({
				schema: 1,
				bundled: false,
				version: '0.1.0',
				generatedAt: '',
				notes: 'platform build output was not staged'
			})
		};
		const layout = resolveRuntimeLayout(ioWith(files), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar'
		});
		expect(layout.kind).toBe('unavailable');
		expect(layout.reason).toContain('packaged without a runtime payload');
		expect(layout.reason).toContain('platform build output was not staged');
	});

	it('rejects a bundled manifest missing one of the two service entries', () => {
		const files = {
			[join('/opt/app/resources', BUNDLE_DIR_NAME, BUNDLE_MANIFEST_NAME)]: JSON.stringify({
				...manifest,
				web: undefined
			})
		};
		const layout = resolveRuntimeLayout(ioWith(files), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar'
		});
		expect(layout.kind).toBe('unavailable');
		expect(layout.reason).toContain('missing the api or web entry');
	});
});

describe('toLayoutSummary', () => {
	it('drops the internal manifest but keeps the IPC-visible fields', () => {
		const layout = resolveRuntimeLayout(ioWith(bundledFiles), {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar'
		});
		const summary = toLayoutSummary(layout);
		expect(summary).toEqual({
			kind: 'bundled',
			bundleRoot: '/opt/app/resources/app-bundle',
			bundleVersion: '0.1.0',
			requiresHostToolchain: false
		});
		expect('manifest' in summary).toBe(false);
	});
});

describe('resolveServiceLaunch', () => {
	const io = ioWith(bundledFiles);

	it('runs bundled services on the app own Node.js runtime — no host toolchain', () => {
		const layout = resolveRuntimeLayout(io, {
			resourcesPath: '/opt/app/resources',
			appPath: '/opt/app/resources/app.asar'
		});
		expect(resolveServiceLaunch('api', layout, io, { nodeExecPath: '/opt/app/everworks' })).toEqual({
			command: '/opt/app/everworks',
			args: ['/opt/app/resources/app-bundle/api/dist/main.js'],
			cwd: '/opt/app/resources/app-bundle/api',
			env: { ELECTRON_RUN_AS_NODE: '1' }
		});
		expect(resolveServiceLaunch('web', layout, io, { nodeExecPath: '/opt/app/everworks' })).toEqual({
			command: '/opt/app/everworks',
			args: ['/opt/app/resources/app-bundle/web/apps/web/server.js'],
			cwd: '/opt/app/resources/app-bundle/web/apps/web',
			env: { ELECTRON_RUN_AS_NODE: '1' }
		});
	});

	it('keeps the repo-checkout launch behavior for developer runs', () => {
		const repoIo = ioWith({ [join('/repo', REPO_MARKER)]: 'packages:' });
		const layout = resolveRuntimeLayout(repoIo, { appPath: '/repo/apps/desktop' });
		expect(resolveServiceLaunch('api', layout, repoIo, { nodeExecPath: '/bin/electron' })).toEqual({
			command: 'pnpm',
			args: ['dev:api'],
			cwd: '/repo'
		});
	});

	it('returns undefined when no runtime is available at all', () => {
		const emptyIo = ioWith({});
		const layout = resolveRuntimeLayout(emptyIo, { appPath: '/nowhere/apps/desktop' });
		expect(layout.kind).toBe('unavailable');
		expect(resolveServiceLaunch('api', layout, emptyIo, { nodeExecPath: '/bin/electron' })).toBeUndefined();
	});
});
