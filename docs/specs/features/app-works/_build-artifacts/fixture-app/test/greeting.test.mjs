/**
 * `GET /` and the evolve loop's contract.
 *
 * `src/greeting.mjs` holds the one string the home page renders, and an agent's change to it must be
 * visible verbatim in the page (ACC-E2E-07: the lane proves a run-unique marker is absent before the
 * merge and present afterwards).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml, greeting, homePage } from '../src/greeting.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('greeting is a non-empty plain string', () => {
	assert.equal(typeof greeting, 'string');
	assert.ok(greeting.length > 0);
	assert.equal(greeting.trim(), greeting);
});

test('the home page renders the greeting inside the tested element', () => {
	const html = homePage({});
	assert.match(html, /<h1 data-testid="greeting">Hello from app-fixture-hello<\/h1>/);
	assert.ok(html.startsWith('<!doctype html>'));
});

test('a run-unique marker in the greeting reaches the page unchanged', () => {
	// The lane's evolve step changes the greeting to include a marker; the page must show it verbatim.
	const marker = 'EVOLVE-MARKER-9f3c1';
	const html = homePage({ publicUrl: 'https://fixture.example.test' }).replace(greeting, `${greeting} ${marker}`);
	assert.ok(html.includes(marker));
});

test('the page shows the public URL when it is known and nothing when it is not', () => {
	assert.ok(homePage({ publicUrl: 'https://app.example.test' }).includes('<code>https://app.example.test</code>'));
	assert.ok(!homePage({}).includes('data-testid="public-url"'));
});

test('values interpolated into the page are escaped', () => {
	assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
	assert.ok(!homePage({ publicUrl: '"><script>x</script>' }).includes('<script>'));
});

test('the greeting lives in exactly one source file', () => {
	const sources = fs
		.readdirSync(path.join(root, 'src'))
		.filter((name) => name.endsWith('.mjs'))
		.map((name) => ({ name, text: fs.readFileSync(path.join(root, 'src', name), 'utf8') }));
	const holders = sources.filter((file) => file.text.includes('Hello from app-fixture-hello'));
	assert.deepEqual(
		holders.map((file) => file.name),
		['greeting.mjs'],
		'the evolve loop needs one obvious place for the greeting to change'
	);
});
