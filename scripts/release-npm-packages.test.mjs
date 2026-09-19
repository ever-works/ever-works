// Unit tests for scripts/release-npm-packages.mjs — run with:
//   node --test scripts/release-npm-packages.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	buildPublishManifest,
	bumpVersion,
	compareSemver,
	computeFingerprint,
	entryPointTargets,
	incPatch,
	maxStable,
	normalizeManifestForFingerprint,
	parseChangesetBumps,
	parsePackument,
	readPackageJsonFromTarball,
	resolveDistribution,
	resolveTargetVersion,
	topoSort,
	workspaceRange
} from './release-npm-packages.mjs';

const released = (hash) => ({ everworksRelease: { contentHash: hash } });

describe('semver helpers', () => {
	it('orders releases and prereleases', () => {
		const sorted = ['1.0.0', '1.0.0-rc.1', '0.9.9', '1.0.10', '1.0.2', '1.0.0-alpha', '1.0.0-rc.10'].sort(
			compareSemver
		);
		assert.deepEqual(sorted, ['0.9.9', '1.0.0-alpha', '1.0.0-rc.1', '1.0.0-rc.10', '1.0.0', '1.0.2', '1.0.10']);
	});

	it('bumps the patch, and a prerelease to its release', () => {
		assert.equal(incPatch('1.0.0'), '1.0.1');
		assert.equal(incPatch('1.2.9'), '1.2.10');
		assert.equal(incPatch('1.3.0-rc.2'), '1.3.0');
	});

	it('maxStable ignores prereleases and junk', () => {
		assert.equal(maxStable(['1.0.0', '1.1.0-beta.1', '1.0.9', 'nope']), '1.0.9');
		assert.equal(maxStable(['2.0.0-rc.1']), null);
		assert.equal(maxStable([]), null);
	});
});

describe('resolveTargetVersion', () => {
	it('first release uses the package.json version', () => {
		const d = resolveTargetVersion({ repoVersion: '1.0.0', fingerprint: 'a', registries: [{ versions: {} }] });
		assert.deepEqual(d, { version: '1.0.0', reason: 'first release', changed: true });
	});

	it('reuses the highest version when its content is identical', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'same',
			registries: [{ versions: { '1.0.0': released('old'), '1.0.4': released('same') } }]
		});
		assert.equal(d.version, '1.0.4');
		assert.equal(d.changed, false);
	});

	it('back-fills: a version present on one registry only is reused, not re-cut', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'x',
			registries: [{ versions: { '1.0.5': released('x') } }, { versions: { '1.0.4': released('w') } }]
		});
		assert.equal(d.version, '1.0.5');
		assert.equal(d.changed, false);
	});

	it('cuts the next patch when content changed and package.json is not ahead', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'new',
			// The June publish carried no fingerprint at all.
			registries: [{ versions: { '1.0.0': {} } }, { versions: { '1.0.0': {} } }]
		});
		assert.equal(d.version, '1.0.1');
		assert.equal(d.changed, true);
	});

	it('honours a deliberate bump in package.json (by hand or Changesets)', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.2.0',
			fingerprint: 'new',
			registries: [{ versions: { '1.1.0': released('a'), '1.1.7': released('b') } }]
		});
		assert.equal(d.version, '1.2.0');
	});

	it('does not go backwards when package.json lags the registry', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.1.0',
			fingerprint: 'new',
			registries: [{ versions: { '1.1.0': released('a'), '1.1.3': released('b') } }]
		});
		assert.equal(d.version, '1.1.4');
	});

	it('a revert to older content is a NEW version, never a silent step back', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'a',
			registries: [{ versions: { '1.0.1': released('a'), '1.0.2': released('b') } }]
		});
		assert.equal(d.version, '1.0.3');
	});

	it('ignores prereleases when picking the base', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'n',
			registries: [{ versions: { '1.0.2': released('a'), '2.0.0-beta.1': released('b') } }]
		});
		assert.equal(d.version, '1.0.3');
	});

	it('never reuses a version number that was published and then unpublished', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'new',
			registries: [{ versions: { '1.0.3': released('a') }, burned: ['1.0.4', '1.0.5'] }]
		});
		assert.equal(d.version, '1.0.6');
		const ahead = resolveTargetVersion({
			repoVersion: '1.2.0',
			fingerprint: 'new',
			registries: [{ versions: { '1.1.0': released('a') }, burned: ['1.2.0'] }]
		});
		assert.equal(ahead.version, '1.2.1');
	});

	it('does not reuse a same-content version that is burned on another registry', () => {
		const d = resolveTargetVersion({
			repoVersion: '1.0.0',
			fingerprint: 'F',
			registries: [{ versions: {}, burned: ['1.0.5'] }, { versions: { '1.0.5': released('F') } }]
		});
		assert.equal(d.version, '1.0.6');
		assert.equal(d.changed, true);
	});

	it('rejects a non-semver package.json version', () => {
		assert.throws(() => resolveTargetVersion({ repoVersion: 'latest', fingerprint: 'x', registries: [] }));
	});
});

describe('buildPublishManifest', () => {
	const ctx = {
		version: '1.0.3',
		releaseVersions: new Map([
			['@ever-works/plugin', '1.1.2'],
			['@ever-works/contracts', '1.0.1'],
			['@ever-works/aws-s3-plugin', '1.0.7']
		]),
		workspaceNames: new Set([
			'@ever-works/plugin',
			'@ever-works/contracts',
			'@ever-works/aws-s3-plugin',
			'@ever-works/agent',
			'@ever-works/eslint-config'
		]),
		repositoryUrl: 'https://github.com/ever-works/ever-works',
		directory: 'packages/plugins/minio'
	};
	const source = {
		name: '@ever-works/minio-plugin',
		version: '1.0.0',
		private: false,
		dependencies: {
			'@ever-works/aws-s3-plugin': 'workspace:*',
			'@ever-works/contracts': 'workspace:^',
			minio: '^8.0.0'
		},
		peerDependencies: { '@ever-works/plugin': 'workspace:*' },
		devDependencies: { '@ever-works/eslint-config': 'workspace:*', vitest: '^3.0.0' },
		publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org' }
	};

	it('turns workspace: specifiers into caret ranges of the released versions', () => {
		const m = buildPublishManifest(source, ctx);
		assert.equal(m.version, '1.0.3');
		assert.deepEqual(m.dependencies, {
			'@ever-works/aws-s3-plugin': '^1.0.7',
			'@ever-works/contracts': '^1.0.1',
			minio: '^8.0.0'
		});
		assert.deepEqual(m.peerDependencies, { '@ever-works/plugin': '^1.1.2' });
	});

	it('drops internal devDependencies that are not released', () => {
		const m = buildPublishManifest(source, ctx);
		assert.deepEqual(m.devDependencies, { vitest: '^3.0.0' });
	});

	it('leaves registry, access and tag to the publish command', () => {
		assert.equal(buildPublishManifest(source, ctx).publishConfig, undefined);
		const other = buildPublishManifest({ ...source, publishConfig: { access: 'public', provenance: true } }, ctx);
		assert.deepEqual(other.publishConfig, { provenance: true });
	});

	it('adds the repository block npm provenance checks', () => {
		const m = buildPublishManifest(source, ctx);
		assert.deepEqual(m.repository, {
			type: 'git',
			url: 'git+https://github.com/ever-works/ever-works.git',
			directory: 'packages/plugins/minio'
		});
	});

	it('refuses a runtime dependency on an internal package that is not released', () => {
		const bad = { ...source, dependencies: { '@ever-works/agent': 'workspace:*' } };
		assert.throws(() => buildPublishManifest(bad, ctx), /not part of the npm release/);
	});

	it('refuses link:/file: specifiers', () => {
		const bad = { ...source, dependencies: { foo: 'file:../foo' } };
		assert.throws(() => buildPublishManifest(bad, ctx), /cannot be published/);
	});

	it('does not mutate its input', () => {
		const copy = structuredClone(source);
		buildPublishManifest(source, ctx);
		assert.deepEqual(source, copy);
	});

	it('maps workspace protocol variants', () => {
		assert.equal(workspaceRange('workspace:*', '1.2.3'), '^1.2.3');
		assert.equal(workspaceRange('workspace:^', '1.2.3'), '^1.2.3');
		assert.equal(workspaceRange('workspace:~', '1.2.3'), '~1.2.3');
		assert.equal(workspaceRange('workspace:^1.0.0', '1.2.3'), '^1.0.0');
	});
});

describe('fingerprint', () => {
	const names = new Set(['@ever-works/plugin']);
	const files = [
		{ path: 'dist/index.js', sha256: 'aa' },
		{ path: 'README.md', sha256: 'bb' }
	];
	const manifest = {
		name: '@ever-works/x-plugin',
		version: '1.0.0',
		peerDependencies: { '@ever-works/plugin': '^1.1.0' },
		dependencies: { zod: '^3.0.0' }
	};
	const fp = (f, m) => computeFingerprint(f, normalizeManifestForFingerprint(m, names));

	it('is stable across file order, own version and sibling versions', () => {
		const base = fp(files, manifest);
		assert.equal(fp([...files].reverse(), manifest), base);
		assert.equal(fp(files, { ...manifest, version: '9.9.9' }), base);
		assert.equal(fp(files, { ...manifest, peerDependencies: { '@ever-works/plugin': '^1.4.0' } }), base);
		assert.equal(fp(files, { ...manifest, everworksRelease: { contentHash: 'x', commit: 'y' } }), base);
	});

	it('changes when shipped content or third-party deps change', () => {
		const base = fp(files, manifest);
		assert.notEqual(fp([{ ...files[0], sha256: 'ab' }, files[1]], manifest), base);
		assert.notEqual(fp([...files, { path: 'dist/extra.js', sha256: 'cc' }], manifest), base);
		assert.notEqual(fp(files, { ...manifest, dependencies: { zod: '^4.0.0' } }), base);
	});

	it('is key-order independent', () => {
		const reordered = {
			dependencies: manifest.dependencies,
			peerDependencies: manifest.peerDependencies,
			version: '1.0.0',
			name: manifest.name
		};
		assert.equal(fp(files, reordered), fp(files, manifest));
	});
});

describe('entryPointTargets', () => {
	it('collects main/types/bin and nested conditional exports, skipping patterns', () => {
		const t = entryPointTargets({
			main: './dist/index.cjs',
			types: 'dist/index.d.ts',
			bin: { x: './dist/cli.js' },
			exports: {
				'.': {
					import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
					require: './dist/index.cjs'
				},
				'./ai': ['./dist/ai.mjs'],
				'./icons/*': './dist/icons/*.svg',
				'./package.json': './package.json'
			}
		});
		assert.deepEqual(
			new Set(t),
			new Set([
				'dist/index.cjs',
				'dist/index.d.ts',
				'dist/cli.js',
				'dist/index.d.mts',
				'dist/index.mjs',
				'dist/ai.mjs',
				'package.json'
			])
		);
	});
});

describe('topoSort', () => {
	const pkg = (name, deps = {}, peers = {}) => ({
		name,
		json: { name, dependencies: deps, peerDependencies: peers }
	});

	it('puts dependencies first', () => {
		const order = topoSort([
			pkg(
				'@ever-works/minio-plugin',
				{ '@ever-works/aws-s3-plugin': 'workspace:*' },
				{ '@ever-works/plugin': 'workspace:*' }
			),
			pkg('@ever-works/aws-s3-plugin', {}, { '@ever-works/plugin': 'workspace:*' }),
			pkg('@ever-works/plugin', { '@ever-works/contracts': 'workspace:*' }),
			pkg('@ever-works/contracts')
		]).map((p) => p.name);
		assert.ok(order.indexOf('@ever-works/contracts') < order.indexOf('@ever-works/plugin'));
		assert.ok(order.indexOf('@ever-works/plugin') < order.indexOf('@ever-works/aws-s3-plugin'));
		assert.ok(order.indexOf('@ever-works/aws-s3-plugin') < order.indexOf('@ever-works/minio-plugin'));
	});

	it('rejects a cycle', () => {
		assert.throws(() => topoSort([pkg('a', { b: '1' }), pkg('b', { a: '1' })]), /cycle/);
	});
});

describe('changesets', () => {
	it('bumps a version by type', () => {
		assert.equal(bumpVersion('1.1.0', 'minor'), '1.2.0');
		assert.equal(bumpVersion('1.1.3', 'major'), '2.0.0');
		assert.equal(bumpVersion('1.1.3', 'patch'), '1.1.4');
		assert.equal(bumpVersion('1.1.3', 'none'), '1.1.3');
	});

	it('reads only the packages a changeset names, keeping the highest bump', () => {
		const bumps = parseChangesetBumps([
			// The changeset committed in this repo on 2026-09-14.
			"---\n'@ever-works/plugin': minor\n---\n\nAI provider plugins may now declare `reasoningSupport(modelId)`.\n",
			'---\r\n"@ever-works/openai-plugin": patch\r\n"@ever-works/plugin": patch\r\n---\r\n\r\nFix.\r\n',
			'---\n"@ever-works/grok-plugin": major\n---\n'
		]);
		assert.deepEqual(Object.fromEntries(bumps), {
			'@ever-works/plugin': 'minor',
			'@ever-works/openai-plugin': 'patch',
			'@ever-works/grok-plugin': 'major'
		});
	});

	it('ignores files without frontmatter and prose lines', () => {
		assert.equal(parseChangesetBumps(['# Changesets\n\nfoo: minor\n', '---\n---\n']).size, 0);
	});
});

describe('parsePackument', () => {
	it('lists unpublished versions as burned', () => {
		const p = parsePackument({
			versions: { '1.0.0': {}, '1.0.2': {} },
			time: { created: 'x', modified: 'y', '1.0.0': 'a', '1.0.1': 'b', '1.0.2': 'c' }
		});
		assert.deepEqual(Object.keys(p.versions), ['1.0.0', '1.0.2']);
		assert.deepEqual(p.burned, ['1.0.1']);
	});

	it('handles a fully unpublished package', () => {
		const p = parsePackument({ time: { unpublished: { versions: ['1.0.0', '1.0.1'] } } });
		assert.deepEqual(p.versions, {});
		assert.deepEqual(p.burned.sort(), ['1.0.0', '1.0.1']);
	});
});

describe('readPackageJsonFromTarball', () => {
	it('reads package.json back out of a real `npm pack` tarball', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ew-tarball-test-'));
		try {
			const manifest = {
				name: '@ever-works/tarball-fixture',
				version: '1.0.7',
				everworksRelease: { contentHash: 'sha256:abc' }
			};
			writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
			mkdirSync(join(dir, 'dist'));
			// A long nested path, so a pax/ustar prefix header precedes it.
			writeFileSync(join(dir, 'dist', `${'x'.repeat(120)}.js`), 'export {};\n');
			const out = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
				cwd: dir,
				encoding: 'utf8',
				shell: process.platform === 'win32'
			});
			const file = JSON.parse(out.slice(out.indexOf('[')))[0].filename;
			const read = readPackageJsonFromTarball(readFileSync(join(dir, file)));
			assert.equal(read.version, '1.0.7');
			assert.deepEqual(read.everworksRelease, { contentHash: 'sha256:abc' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns null when there is no package.json', () => {
		// An empty tar (two zero blocks), gzipped.
		assert.equal(readPackageJsonFromTarball(gzipSync(Buffer.alloc(1024))), null);
	});
});

describe('resolveDistribution', () => {
	it('mirrors the SDK default-derivation rule', () => {
		assert.equal(resolveDistribution({ distribution: 'core' }), 'core');
		assert.equal(resolveDistribution({ distribution: 'registry', systemPlugin: true }), 'registry');
		assert.equal(resolveDistribution({ systemPlugin: true }), 'core');
		assert.equal(resolveDistribution({}), 'registry');
		assert.equal(resolveDistribution(undefined), 'registry');
	});
});
