#!/usr/bin/env node
/**
 * verify-spec-tree.mjs — a zero-dependency self-check for the App Works spec tree.
 *
 * Why this exists: the program is ~200 documents where every claim cites a `file:line` or a
 * relative link. Both rot silently when the platform moves. This script re-checks the two
 * mechanical properties that CAN be checked from the filesystem alone:
 *
 *   1. every relative markdown link resolves to a real file (or an existing heading anchor)
 *   2. every acceptance id defined by an epic spec appears in ACCEPTANCE.md, and vice versa
 *
 * It is additive tooling: it writes nothing and removes nothing. Run it from the repository root:
 *
 *     node docs/specs/features/app-works/tools/verify-spec-tree.mjs
 *
 * Exit code 0 = clean, 1 = findings. Findings are printed grouped, capped at 40 per group.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..'); // repo root
const TREE = join(ROOT, 'docs', 'specs', 'features', 'app-works');

const CAP = 40;
const findings = { links: [], ids: [] };

/**
 * Always write the COMPLETE finding list next to the script, so a CI log that truncates the
 * printed head still leaves the full picture. The file is machine-readable on purpose: one
 * finding per line, prefixed `link ` or `id `.
 */
const reportPath = join(HERE, 'verify-spec-tree.report.txt');

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			walk(full, out);
		} else if (entry.name.endsWith('.md')) {
			out.push(full);
		}
	}
	return out;
}

const files = walk(TREE);

/** Every heading in every file, so `foo.md#some-heading` can be verified. */
const anchors = new Map();
/**
 * GitHub's heading slug, as closely as it can be reproduced offline: lowercase, drop punctuation
 * (`—`, `.`, `(`, `)`, `` ` `` … all vanish rather than becoming separators), turn remaining
 * whitespace into `-`. Verified against the one long anchor this tree uses most:
 * `## 0. Program audit resolutions (binding — 2026-09-17, against `develop` @ `ee45946e5`)`
 * → `#0-program-audit-resolutions-binding--2026-09-17-against-develop--ee45946e5` (note the
 * double dash where the em dash was removed between two spaces).
 */
function slugify(heading) {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/^-+|-+$/g, '');
}
for (const file of files) {
	const text = readFileSync(file, 'utf8');
	const set = new Set();
	for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) set.add(slugify(match[1]));
	anchors.set(file, set);
}

/**
 * Strip fenced code blocks before looking for links: a JSON Schema `pattern` or an OpenAPI path
 * contains `[...](...)` shapes that are not links at all, and flagging them is noise.
 */
function stripFences(text) {
	return text.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, (block) =>
		block.replace(/[^\n]/g, ' '),
	);
}

// 1. relative links
//    - optional `<...>` wrapper (required by GFM when the path contains spaces or parentheses —
//      Next.js route groups like `(dashboard)` are the common case here, so the angle-bracket
//      form must win over the balanced-paren form or the path is truncated at the first `)`)
//    - otherwise a single level of balanced parentheses inside the target
const ANGLED = /\[[^\]]*\]\(<([^>]+)>(?:\s+"[^"]*")?\)/g;
const PLAIN = /\[[^\]]*\]\(([^)\s]*(?:\([^)\s]*\)[^)\s]*)*)(?:\s+"[^"]*")?\)/g;
/** Every relative link target in one line, angled form first so `(dashboard)` survives. */
function linkTargets(line) {
	// Mask inline code spans first: a regex literal such as `(?:[A-Za-z0-9-]{0,38})$` is not a
	// markdown link, but it looks exactly like one to a bracket-then-paren matcher.
	const masked = line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
	const seen = new Set();
	const out = [];
	for (const match of masked.matchAll(ANGLED)) {
		seen.add(match[0]);
		out.push(match[1]);
	}
	// Mask anything already collected in an angled link so PLAIN cannot re-read its inner parens.
	let rest = masked;
	for (const whole of seen) rest = rest.split(whole).join(' '.repeat(whole.length));
	for (const match of rest.matchAll(PLAIN)) out.push(match[1]);
	return out;
}

for (const file of files) {
	const text = stripFences(readFileSync(file, 'utf8'));
	const lines = text.split(/\r?\n/);
	lines.forEach((line, index) => {
		for (const raw of linkTargets(line)) {
			if (/^(https?:|mailto:|#)/.test(raw)) continue;
			const [pathPart, anchor] = raw.split('#');
			if (!pathPart) continue;
			const target = resolve(dirname(file), decodeURIComponent(pathPart));
			if (!existsSync(target)) {
				findings.links.push(
					`${relative(ROOT, file).split(sep).join('/')}:${index + 1} -> ${raw}`,
				);
				continue;
			}
			if (!anchor) continue;
			try {
				if (statSync(target).isDirectory()) continue;
			} catch {
				continue;
			}
			const targetAnchors = anchors.get(target);
			if (targetAnchors && !targetAnchors.has(anchor.toLowerCase())) {
				findings.links.push(
					`${relative(ROOT, file).split(sep).join('/')}:${index + 1} -> ${raw} (anchor not found)`,
				);
			}
		}
	});
}

// 2. acceptance ids: epics define them, ACCEPTANCE.md indexes them
const acceptanceFile = join(TREE, 'ACCEPTANCE.md');
const acceptanceText = readFileSync(acceptanceFile, 'utf8');
const indexed = new Set([...acceptanceText.matchAll(/\bACC-(?:E2E-)?[0-9]{2}-[0-9]{2}\b/g)].map((m) => m[0]));

const defined = new Map(); // id -> file
for (const file of files) {
	const base = file.split(sep).pop();
	if (base !== 'spec.md') continue;
	const text = readFileSync(file, 'utf8');
	for (const match of text.matchAll(/^- \[[ x]\] \*\*(ACC-(?:E2E-)?[0-9]{2}-[0-9]{2})\*\*/gm)) {
		defined.set(match[1], relative(ROOT, file).split(sep).join('/'));
	}
}

for (const [id, file] of defined) {
	if (!indexed.has(id)) findings.ids.push(`${id} defined in ${file} but absent from ACCEPTANCE.md`);
}
for (const id of indexed) {
	if (!defined.has(id)) findings.ids.push(`${id} indexed in ACCEPTANCE.md but never defined by an epic spec`);
}

// report
const linkCount = files.reduce(
	(sum, file) =>
		sum +
		stripFences(readFileSync(file, 'utf8'))
			.split(/\r?\n/)
			.reduce(
				(n, line) => n + linkTargets(line).filter((raw) => !/^(https?:|mailto:|#)/.test(raw)).length,
				0,
			),
	0,
);

console.log(`App Works spec tree — ${files.length} markdown files, ${linkCount} relative links`);
console.log(`acceptance ids — ${defined.size} defined, ${indexed.size} indexed`);
for (const [group, list] of Object.entries(findings)) {
	console.log(`\n${group}: ${list.length}`);
	for (const line of list.slice(0, CAP)) console.log(`  ${line}`);
	if (list.length > CAP) console.log(`  … ${list.length - CAP} more`);
}
const total = findings.links.length + findings.ids.length;
writeFileSync(
	reportPath,
	[
		`# App Works spec tree — full finding list (${total})`,
		`# generated by tools/verify-spec-tree.mjs`,
		...findings.links.map((line) => `link ${line}`),
		...findings.ids.map((line) => `id ${line}`),
		'',
	].join('\n'),
);
console.log(`\n${total === 0 ? 'CLEAN' : `${total} finding(s)`} — full list: tools/verify-spec-tree.report.txt`);
process.exit(total === 0 ? 0 : 1);
