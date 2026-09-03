/**
 * The built artifact, exercised as a consumer would actually load it.
 *
 * Every other suite imports `../src`, which Vitest resolves with bundler
 * rules. That is not how anybody consumes this package, and the difference
 * is not academic: `import { Ajv2020 } from 'ajv/dist/2020'` resolves fine
 * under bundler resolution and throws `ERR_MODULE_NOT_FOUND` the moment
 * Node's ESM resolver sees it, because ajv 8 publishes no `exports` map and
 * ESM does not retry with an added `.js`. CommonJS masked it too, since CJS
 * resolution *does* retry. So the whole test suite was green while the
 * published ESM bundle could not be imported at all.
 *
 * These tests close that gap by loading `dist/` the way a consumer does.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESM = join(PKG_ROOT, 'dist', 'index.js');
const CJS = join(PKG_ROOT, 'dist', 'index.cjs');

const NOT_BUILT =
	'dist/ is absent, so the published artifact was NOT exercised. Run `pnpm build` in this package first. CI builds before testing, so this skip should never appear there.';

/** Runs a snippet in a fresh Node process with the package root as cwd. */
function runNode(args: string[], source: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [...args, source], {
		cwd: PKG_ROOT,
		encoding: 'utf8',
		timeout: 60_000
	});
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('dist — the published artifact loads the way consumers load it', () => {
	it('imports the ESM bundle in real Node and loads a package', (ctx) => {
		if (!existsSync(ESM)) {
			ctx.skip(NOT_BUILT);
			return;
		}
		const { status, stdout, stderr } = runNode(
			['--input-type=module', '-e'],
			`import { loadPluginPackage } from './dist/index.js';
			const r = await loadPluginPackage('./fixtures/valid-full');
			if (!r.ok) throw new Error('expected the fixture to load');
			console.log('OK ' + r.skills.length + ' ' + r.mcpServers.length);`
		);
		expect(stderr, stderr).not.toContain('ERR_MODULE_NOT_FOUND');
		expect(status, stderr).toBe(0);
		expect(stdout.trim()).toBe('OK 2 3');
	});

	it('requires the CommonJS bundle in real Node', (ctx) => {
		if (!existsSync(CJS)) {
			ctx.skip(NOT_BUILT);
			return;
		}
		const { status, stdout, stderr } = runNode(
			['-e'],
			`const { loadPluginPackage } = require('./dist/index.cjs');
			loadPluginPackage('./fixtures/valid-minimal').then((r) => {
				if (!r.ok) throw new Error('expected the fixture to load');
				console.log('OK ' + r.manifest.name);
			});`
		);
		expect(status, stderr).toBe(0);
		expect(stdout.trim()).toBe('OK minimal-plugin');
	});

	it('never emits an extensionless ajv specifier in either bundle', (ctx) => {
		if (!existsSync(ESM) || !existsSync(CJS)) {
			ctx.skip(NOT_BUILT);
			return;
		}
		// Pins the exact defect directly, so it is caught even on a platform
		// where spawning a child process is awkward.
		for (const file of [ESM, CJS]) {
			const source = readFileSync(file, 'utf8');
			const specifiers = [...source.matchAll(/['"](ajv\/[^'"]*)['"]/gu)].map((m) => m[1]);
			expect(specifiers.length, `${file} should reference ajv`).toBeGreaterThan(0);
			for (const specifier of specifiers) {
				expect(specifier, `${file} must use an explicit extension`).toMatch(/\.js$/u);
			}
		}
	});

	it('vendors both schema versions into the bundle rather than fetching them', (ctx) => {
		if (!existsSync(ESM)) {
			ctx.skip(NOT_BUILT);
			return;
		}
		// Spec 5.2: "Clients MUST NOT retrieve a schema while loading a
		// plugin." The schemas must therefore be inlined, and `dist/` must
		// carry no loose schema files for something to read at runtime.
		const source = readFileSync(ESM, 'utf8');
		for (const version of ['1.0.0', '1.1.0']) {
			expect(source).toContain(`https://agent-plugins.org/schemas/${version}/plugin.schema.json`);
			expect(source).toContain(`https://agent-plugins.org/schemas/${version}/mcp.schema.json`);
		}
	});

	it('performs no network access while loading a package', (ctx) => {
		if (!existsSync(ESM)) {
			ctx.skip(NOT_BUILT);
			return;
		}
		const { status, stdout, stderr } = runNode(
			['--input-type=module', '-e'],
			`import { loadPluginPackage } from './dist/index.js';
			globalThis.fetch = () => { throw new Error('NETWORK: fetch'); };
			const net = await import('node:net');
			net.Socket.prototype.connect = function () { throw new Error('NETWORK: socket connect'); };
			for (const p of ['./fixtures/valid-full', './fixtures/valid-spec-1-1-0', './fixtures/mcp-skip-servers']) {
				await loadPluginPackage(p);
			}
			console.log('NO-NETWORK');`
		);
		expect(stderr, stderr).not.toContain('NETWORK');
		expect(status, stderr).toBe(0);
		expect(stdout.trim()).toBe('NO-NETWORK');
	});
});
