/**
 * `scripts/check-no-nul-bytes.mjs` is the image build's gate against the React 18 SSR bug that put
 * U+0000 into docs.ever.works' HTML (see the script's header). These checks prove the gate can go
 * red, not only that it is green on a clean build: a NUL anywhere in a page fails it, and so does a
 * build with nothing to check.
 *
 * Run: `pnpm --filter ever-works-docs test` (node's built-in runner, no dependencies).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/check-no-nul-bytes.mjs');
const root = mkdtempSync(path.join(tmpdir(), 'ew-docs-nul-'));

/** A build directory holding `pages` ({ relative path: html }). */
function build(name, pages) {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, html] of Object.entries(pages)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), html, 'utf8');
	}
	return dir;
}

/** Runs the check on `dir` in a child node process; returns its exit status and output. */
function check(dir) {
	return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
}

describe('check-no-nul-bytes', () => {
	after(() => rmSync(root, { recursive: true, force: true }));

	it('passes a build whose pages hold multi-byte text and no NUL', () => {
		const dir = build('clean', {
			'index.html': '<h1>🗃️ Docs — home</h1>',
			'fr/guide/index.html': '<p>Guide​📄</p>'
		});
		const result = check(dir);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /no NUL character in 2 HTML page/);
	});

	it('fails on a NUL in a nested page and names the page', () => {
		const dir = build('dirty', {
			'index.html': '<h1>Home</h1>',
			'guide/setup/index.html': '<a title="Setup">Setup\u0000\u0000 📄</a>'
		});
		const result = check(dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /2 NUL character\(s\)/);
		assert.match(result.stderr, /setup[\\/]index\.html/);
	});

	it('fails when the build holds no HTML page (nothing was checked)', () => {
		const dir = build('empty', { 'sitemap.xml': '<urlset/>' });
		const result = check(dir);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /nothing was checked/);
	});

	it('fails when the build directory does not exist', () => {
		const result = check(path.join(root, 'missing'));
		assert.equal(result.status, 1);
		assert.match(result.stderr, /No build directory/);
	});
});
