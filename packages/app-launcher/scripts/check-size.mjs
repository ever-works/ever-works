#!/usr/bin/env node
/**
 * T10 / plan §6.1 — the App Launcher size and self-containment gate.
 *
 * FR-46: "The component, including its styles, is at most 30 KB compressed and
 * adds no global styles to the host page." ACC-11-35 measures it.
 *
 * Two assertions, both hard failures (this script is the second half of
 * `pnpm test`, so a violation fails the test run):
 *
 *   1. gzip of `dist/index.js` is at most 30,720 bytes (30 KB — 30 * 1024, the
 *      number T10 names).
 *   2. the built file carries no bare module import. `noExternal: ['lit']` in
 *      `tsup.config.ts` is what makes this true: the file a
 *      `<script type="module">` tag loads must resolve with no import map, so a
 *      surviving `from 'lit'` (the failure APW11-G15 names) is a build error,
 *      not a warning.
 *
 * It deliberately re-reads the file rather than trusting the build log: the
 * number published in ACC-11-35 has to be the number of the artifact consumers
 * load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(PACKAGE_ROOT, 'dist', 'index.js');

/** FR-46 / ACC-11-35: 30 KB compressed, counted in bytes (30 * 1024). */
export const SIZE_BUDGET_BYTES = 30 * 1024;

const failures = [];
const notes = [];

if (!existsSync(BUNDLE)) {
	failures.push(
		`dist/index.js does not exist — run \`pnpm --filter @ever-works/app-launcher build\` before the size check. ` +
			`T10's Done-when is \`build test\`, in that order.`
	);
} else {
	const source = readFileSync(BUNDLE);
	const gzippedBytes = gzipSync(source).length;
	const rel = relative(PACKAGE_ROOT, BUNDLE).replace(/\\/g, '/');

	notes.push(`${rel}: ${source.length} bytes raw, ${gzippedBytes} bytes gzipped (budget ${SIZE_BUDGET_BYTES})`);
	if (gzippedBytes > SIZE_BUDGET_BYTES) {
		failures.push(
			`${rel} is ${gzippedBytes} bytes gzipped, over the ${SIZE_BUDGET_BYTES}-byte budget ` +
				`(FR-46, ACC-11-35) by ${gzippedBytes - SIZE_BUDGET_BYTES} bytes.`
		);
	}

	// Every ES module specifier the bundle still asks someone else to resolve.
	// A bare one (not starting with `.`, `/` or a URL scheme) means Lit — or any
	// other dependency — was left external, so the artifact is not the one
	// ACC-11-35 measures and T27's fixtures cannot load it.
	const bare = new Set();
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
	];
	for (const pattern of patterns) {
		for (const match of source.toString('utf8').matchAll(pattern)) {
			const specifier = match[1];
			if (/^(?:\.{0,2}\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(specifier)) continue;
			bare.add(specifier);
		}
	}

	if (bare.size > 0) {
		failures.push(
			`${rel} still imports ${[...bare].map((s) => `'${s}'`).join(', ')} — the bundle must be one self-contained ` +
				`ESM file (plan §6.1, APW11-G15). Check \`noExternal\` in tsup.config.ts.`
		);
	}
}

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
	console.error('\nApp Launcher size check FAILED:');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`  size check OK: gzip <= ${SIZE_BUDGET_BYTES} bytes and no bare import`);
}
