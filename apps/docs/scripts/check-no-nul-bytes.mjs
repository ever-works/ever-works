#!/usr/bin/env node
/**
 * Checks the built site: no HTML page may contain a NUL character (U+0000).
 *
 *   node scripts/check-no-nul-bytes.mjs [buildDir=build]
 *
 * React 18's server renderer (react-dom 18.3.1, `renderToPipeableStream`, which Docusaurus uses for
 * every static page) buffers its output in 2048-byte views. When a short string did not fit, it
 * flushed the whole view, not the bytes it had written: the 1-3 bytes a multi-byte character (an
 * emoji, its U+FE0F, an em dash, a zero-width space) could not use were sent as zeros. A build of
 * this site carried hundreds of them, in sidebar labels, category cards and headings, and
 * docs.ever.works served them. React 19 writes only the bytes it encoded.
 *
 * Exits 1 naming each page and the text around each NUL, and also when the build holds no HTML at
 * all: a check that finds nothing to check would otherwise pass by absence.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const buildDir = process.argv[2] || 'build';

/**
 * Every `.html` file under `dir`, at any depth.
 * @param {string} dir
 * @returns {string[]}
 */
function htmlFiles(dir) {
	let found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...htmlFiles(path));
		} else if (entry.name.endsWith('.html')) {
			found.push(path);
		}
	}
	return found;
}

if (!existsSync(buildDir)) {
	console.error(`No build directory at ${buildDir}: run the build first.`);
	process.exit(1);
}

const files = htmlFiles(buildDir);
if (files.length === 0) {
	console.error(`No HTML page under ${buildDir}: nothing was checked.`);
	process.exit(1);
}

let count = 0;
let failures = [];
for (const file of files) {
	const html = readFileSync(file, 'utf8');
	for (let at = html.indexOf('\u0000'); at >= 0; at = html.indexOf('\u0000', at + 1)) {
		count += 1;
		failures.push(`${file}: ${JSON.stringify(html.slice(Math.max(0, at - 40), at + 20))}`);
	}
}

if (failures.length > 0) {
	console.error(`${count} NUL character(s) in the built HTML:`);
	for (const failure of failures.slice(0, 50)) console.error(`  ${failure}`);
	if (failures.length > 50) console.error(`  ... and ${failures.length - 50} more`);
	process.exit(1);
}
console.log(`OK: no NUL character in ${files.length} HTML page(s).`);
