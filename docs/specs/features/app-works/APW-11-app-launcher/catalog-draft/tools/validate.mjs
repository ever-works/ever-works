#!/usr/bin/env node
/**
 * The checks JSON Schema cannot express, run by `.github/workflows/validate.yml`.
 *
 *   1. every `id` is unique — pins are stored as `platform:<id>`, so a duplicate merges two
 *      platforms into one preference row (APW-11 plan §3.2, §4.2);
 *   2. every icon is a real file in `icons/` and at most 16,384 bytes (APP_LAUNCHER_ICON_MAX_BYTES);
 *   3. every address is `https` (the schema also says so; this is the defence-in-depth repeat that
 *      also covers a future edit to the schema);
 *   4. no SVG carries `<script`, an `on…=` handler, `javascript:` or `<foreignObject` (plan §5.2);
 *   5. at most 24 entries (APP_LAUNCHER_CATALOG_MAX_ENTRIES) — the 25th is refused here rather than
 *      silently dropped by the reader (APW-11 FR-11).
 *
 * Usage: node tools/validate.mjs [--expect-max-entries N]
 * Exit code 0 = clean, 1 = at least one problem (every problem is printed).
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_MAX_BYTES = 16_384;
const ENTRY_MAX = 24;
const SVG_DENY = [/<script/i, /on[a-z]+\s*=/i, /javascript:/i, /<foreignObject/i];

const maxEntriesArg = process.argv.indexOf('--expect-max-entries');
const maxEntries = maxEntriesArg === -1 ? ENTRY_MAX : Number(process.argv[maxEntriesArg + 1]);

const problems = [];
const catalog = JSON.parse(readFileSync(join(ROOT, 'platforms.json'), 'utf8'));
const platforms = Array.isArray(catalog.platforms) ? catalog.platforms : [];

if (platforms.length > maxEntries) {
	problems.push(`platforms.json holds ${platforms.length} entries; the cap is ${maxEntries}`);
}

const seen = new Map();
for (const entry of platforms) {
	if (seen.has(entry.id)) {
		problems.push(`duplicate id "${entry.id}" (also used by "${seen.get(entry.id)}")`);
	} else {
		seen.set(entry.id, entry.name);
	}

	for (const [environment, url] of Object.entries(entry.urls ?? {})) {
		if (!String(url).startsWith('https://')) {
			problems.push(`${entry.id}/${environment}: "${url}" is not https`);
		}
	}

	const iconPath = join(ROOT, entry.icon ?? '');
	let bytes;
	try {
		bytes = statSync(iconPath).size;
	} catch {
		problems.push(`${entry.id}: icon "${entry.icon}" does not exist`);
		continue;
	}
	if (bytes > ICON_MAX_BYTES) {
		problems.push(`${entry.id}: icon "${entry.icon}" is ${bytes} bytes; the cap is ${ICON_MAX_BYTES}`);
	}
	if (String(entry.icon).endsWith('.svg')) {
		const svg = readFileSync(iconPath, 'utf8');
		for (const pattern of SVG_DENY) {
			if (pattern.test(svg)) {
				problems.push(`${entry.id}: icon "${entry.icon}" matches the denied pattern ${pattern}`);
			}
		}
	}
}

if (problems.length > 0) {
	console.error(`platforms.json failed ${problems.length} check(s):`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exit(1);
}

console.log(`platforms.json is clean: ${platforms.length} entries, all icons ≤ ${ICON_MAX_BYTES} bytes.`);
