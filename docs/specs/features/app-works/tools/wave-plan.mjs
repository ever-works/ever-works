/**
 * wave-plan.mjs — build the Wave 1 implementation order from the spec tasks.
 *
 * Why this exists: Wave 1 is ~40 tasks across seven epics, and the order is no
 * longer obvious from any single file — the gap pass rewrote `TRACKER.md`'s
 * merge order (Resolution R-38) and split several phases into an
 * interface-first "seam" so the whole thing is actually satisfiable. This script
 * reads the merge order out of `TRACKER.md`, reads each task heading and its
 * `**Create**`/`**Modify**` paths out of every epic's `tasks.md`, and prints one
 * linear plan with the files each step touches.
 *
 * It writes nothing and is safe to run at any time:
 *
 *     node docs/specs/features/app-works/tools/wave-plan.mjs [--wave 1]
 *
 * Deliberately dependency-free — no yaml, no workspace imports — because the
 * previous tooling in this tree tripped over missing modules more than once.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = join(HERE, '..');

const waveArg = process.argv.indexOf('--wave');
const wantWave = waveArg >= 0 ? Number(process.argv[waveArg + 1]) : null;

/** The merge order, as `TRACKER.md` states it (Resolution R-38). */
function readMergeOrder() {
	const text = readFileSync(join(TREE, 'TRACKER.md'), 'utf8');
	const section = text.match(/##\s*Merge order[\s\S]*?(?=\n##\s)/i);
	if (!section) return [];
	return section[0]
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^\d+\./.test(line))
		.map((line) => line.replace(/^\d+\.\s*/, '').replace(/\*\*/g, ''));
}

/**
 * Task headings and the paths they touch, per epic.
 *
 * A heading is `- [ ] **T12. Title.**` (with or without a phase suffix); the
 * paths are the backticked repo-relative paths in the task's own indented body.
 */
function readTasks(dir) {
	let raw;
	try {
		raw = readFileSync(join(TREE, dir, 'tasks.md'), 'utf8');
	} catch {
		return [];
	}
	const out = [];
	let current = null;
	for (const line of raw.split(/\r?\n/)) {
		const heading = line.match(/^- \[[ x]\]\s+\*\*(T\d+[a-z]?)\b\.?\s*(.*?)\*\*/);
		if (heading) {
			if (current) out.push(current);
			current = { id: heading[1], title: heading[2].trim(), paths: [] };
			continue;
		}
		if (!current) continue;
		if (/^- \[[ x]\]\s+\*\*T\d/.test(line)) {
			out.push(current);
			current = null;
			continue;
		}
		for (const match of line.matchAll(/`((?:packages|apps|docs|scripts)\/[\w./@-]+)`/g)) {
			if (!current.paths.includes(match[1])) current.paths.push(match[1]);
		}
	}
	if (current) out.push(current);
	return out;
}

const EPICS = readdirSync(TREE, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && /^APW-\d/.test(entry.name))
	.map((entry) => entry.name)
	.sort();

const mergeOrder = readMergeOrder();
console.log(`# Wave plan — derived from TRACKER.md's merge order and each epic's tasks.md\n`);
console.log(`Merge order (${mergeOrder.length} steps, Resolution R-38):`);
for (const step of mergeOrder) console.log(`  - ${step}`);

console.log(`\n## Tasks per epic\n`);
const totals = { total: 0, done: 0 };
for (const epic of EPICS) {
	const tasks = readTasks(epic);
	totals.total += tasks.length;
	if (!tasks.length) {
		console.log(`### ${epic}\n  (no tasks.md)\n`);
		continue;
	}
	console.log(`### ${epic} — ${tasks.length} tasks`);
	for (const task of tasks) {
		const where = task.paths.length
			? ` → ${task.paths.slice(0, 4).join(', ')}${task.paths.length > 4 ? ` (+${task.paths.length - 4})` : ''}`
			: '';
		console.log(`  ${task.id.padEnd(6)} ${task.title.slice(0, 78)}${where}`);
	}
	console.log('');
}
console.log(`\nTOTAL task headings across the programme: ${totals.total}`);
if (wantWave !== null) {
	console.log(
		`\n(--wave ${wantWave} was requested; the wave split lives in README §4 and ` +
			`docs/internal/app-works-implementation-plan.md §4, not machine-readably in this tree.)`
	);
}
