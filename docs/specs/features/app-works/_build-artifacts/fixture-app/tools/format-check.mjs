/**
 * `npm run format:check` — the repository's formatting gate, with no dependency.
 *
 * The Blueprint's App spec declares this check as `npm ci && npm run format:check` (required: false).
 * A fixture whose whole point is that it builds with nothing installed cannot run Prettier, so the
 * house style is expressed as four rules a script can check in milliseconds (see gaps.md §2):
 *
 *   1. LF line endings — no carriage returns anywhere
 *   2. no trailing whitespace on a line
 *   3. the file ends with exactly one newline
 *   4. indentation is tabs in code and spaces in YAML (YAML forbids tabs outright)
 *
 * `--write` fixes rules 1 to 3 in place; rule 4 is left for a person, because silently re-indenting
 * YAML is how a workflow file breaks.
 *
 * Exit code 0 when the tree is clean, 1 when a file breaks a rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.data', 'evidence', 'dist']);
const TAB_INDENTED = new Set(['.mjs', '.js', '.cjs', '.json', '.sql', '.md', '.svg', '.html']);
const SPACE_INDENTED = new Set(['.yml', '.yaml']);
const TEXT_FILES = new Set([...TAB_INDENTED, ...SPACE_INDENTED, '.txt', '.dockerignore', '.gitignore', '']);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			files.push(...walk(path.join(dir, entry.name)));
		} else if (entry.isFile()) {
			files.push(path.join(dir, entry.name));
		}
	}
	return files;
}

/** @param {string} file @returns {string[]} the rule violations of one file */
export function checkFile(file) {
	const name = path.basename(file);
	if (!TEXT_FILES.has(path.extname(file)) && !TEXT_FILES.has(name)) return [];
	const raw = fs.readFileSync(file, 'utf8');
	const problems = [];
	const relative = path.relative(root, file).split(path.sep).join('/');

	if (raw.includes('\r')) problems.push('CRLF line endings (the repository is LF-only)');
	if (raw.length && !raw.endsWith('\n')) problems.push('no newline at end of file');
	if (raw.endsWith('\n\n')) problems.push('more than one trailing newline');

	const lines = raw.split('\n');
	lines.forEach((line, index) => {
		if (/[ \t]+$/.test(line)) problems.push(`line ${index + 1}: trailing whitespace`);
	});

	const extension = path.extname(file);
	if (SPACE_INDENTED.has(extension)) {
		if (raw.includes('\t')) problems.push('YAML must not contain tab characters');
	} else if (TAB_INDENTED.has(extension) || name === 'Dockerfile') {
		lines.forEach((line, index) => {
			if (/^ +\S/.test(line)) problems.push(`line ${index + 1}: indented with spaces (the house style is tabs)`);
		});
	}

	return problems.map((problem) => `${relative}: ${problem}`);
}

/** Rewrite a file so rules 1 to 3 hold. */
export function fixFile(file) {
	const raw = fs.readFileSync(file, 'utf8');
	const fixed = `${raw.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n*$/, '')}\n`;
	if (fixed !== raw) {
		fs.writeFileSync(file, fixed);
		return true;
	}
	return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const write = process.argv.includes('--write');
	const files = walk(root).filter((file) => TEXT_FILES.has(path.extname(file)) || TEXT_FILES.has(path.basename(file)));
	let changed = 0;
	const problems = [];
	for (const file of files) {
		if (write) {
			if (fixFile(file)) {
				changed += 1;
				process.stdout.write(`format: rewrote ${path.relative(root, file)}\n`);
			}
			continue;
		}
		problems.push(...checkFile(file));
	}
	if (write) {
		process.stdout.write(`format: ${changed} file(s) rewritten\n`);
		process.exit(0);
	}
	if (problems.length) {
		for (const problem of problems) process.stderr.write(`format: ${problem}\n`);
		process.stderr.write(`format: ${problems.length} problem(s); run "npm run format:write" for the fixable ones\n`);
		process.exit(1);
	}
	process.stdout.write(`format: ${files.length} file(s) checked, no problems\n`);
}
