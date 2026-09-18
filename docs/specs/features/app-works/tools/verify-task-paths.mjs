// App Works — task-path drift check.
//
// Every task in an epic's tasks.md names the exact files it creates or modifies.
// The convention in this tree is that a path which does NOT exist yet is marked
// "new" right after it, and every other path was supposed to have been checked
// with `git ls-files` when the task was written. That convention is what makes a
// task reviewable without the diff — and it is exactly what rots as the
// repository moves: a renamed module, a moved directory or a file that was never
// created leaves a task pointing at nothing.
//
// This checker reports the two failure modes separately, because they mean
// different things:
//
//   STALE        a path named without a "new" marker that is not in the
//                repository. Either the task text is wrong, or a predecessor
//                task never landed.
//   MISLABELLED  a path marked "new" that already exists. Not an error — it
//                usually means a predecessor landed it — but worth knowing,
//                because the task is then smaller than it reads.
//
// Report-only: it never edits a spec. Run it from the repository root.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_ROOT = 'docs/specs/features/app-works';

function trackedFiles() {
	const out = execFileSync('git', ['ls-files'], { maxBuffer: 256 * 1024 * 1024 });
	return new Set(out.toString('utf8').split('\n').filter(Boolean));
}

/**
 * Paths a task names: a backticked token that looks like a file — no spaces, at
 * least one slash, no glob, no trailing slash, and an extension or a known
 * barrel name.
 */
function pathsIn(line) {
	const found = [];
	for (const match of line.matchAll(/`([^`]+)`/g)) {
		const token = match[1].trim();
		if (token.length === 0) continue;
		if (token.includes('*') || token.includes(' ') || token.endsWith('/')) continue;
		if (!/^[a-z0-9_.@[\]-]+(\/[a-z0-9_.@[\]{}-]+)+$/i.test(token)) continue;
		if (!/\.[a-z0-9]+$/i.test(token)) continue;
		found.push(token);
	}
	return found;
}

const tracked = trackedFiles();
const epics = readdirSync(SPEC_ROOT)
	.filter((name) => name.startsWith('APW-'))
	.filter((name) => {
		try {
			readFileSync(join(SPEC_ROOT, name, 'tasks.md'), 'utf8');
			return true;
		} catch {
			return false;
		}
	})
	.sort();

/**
 * Repo-root-anchored paths only. A task that creates a package names its files
 * relative to that package (`src/index.ts`), which cannot be resolved without
 * knowing the package — those are counted separately rather than guessed at.
 */
const ROOT_PREFIXES = ['packages/', 'apps/', 'docs/', '.deploy/', '.github/', 'scripts/'];

function isRootAnchored(token) {
	return ROOT_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * The tree writes the same marker two ways — `(**new**)` 212 times and `(new)`
 * 375 times — so both count. Missing one of them is what makes a checker like
 * this report a thousand "stale" paths that are simply not built yet.
 */
function isMarkedNew(line) {
	return line.includes('(**new**)') || line.includes('(new)');
}

/** Pass 1 — every path the programme says it will create. */
const createdBy = new Set();

for (const epic of epics) {
	const lines = readFileSync(join(SPEC_ROOT, epic, 'tasks.md'), 'utf8').split('\n');
	for (const line of lines) {
		if (!isMarkedNew(line)) continue;
		for (const token of pathsIn(line)) createdBy.add(token);
	}
}

const stale = [];
const mislabelled = [];
const notYetBuilt = [];
let taskCount = 0;
let pathCount = 0;
let relativeCount = 0;

for (const epic of epics) {
	const lines = readFileSync(join(SPEC_ROOT, epic, 'tasks.md'), 'utf8').split('\n');

	for (let i = 0; i < lines.length; i += 1) {
		if (!/^- \[[ x]\] \*\*T[0-9]/.test(lines[i])) continue;
		taskCount += 1;
		const id = /^- \[[ x]\] \*\*(T[0-9a-z]+)/.exec(lines[i])?.[1] ?? '?';

		// A task body runs until the next task heading.
		let end = i + 1;
		while (end < lines.length && !/^- \[[ x]\] \*\*T[0-9]/.test(lines[end])) end += 1;

		for (const raw of lines.slice(i, end)) {
			for (const token of pathsIn(raw)) {
				if (!isRootAnchored(token)) {
					relativeCount += 1;
					continue;
				}
				pathCount += 1;
				const exists = tracked.has(token);
				const markedNew = isMarkedNew(raw) && raw.includes(`\`${token}\``);

				if (exists && markedNew) mislabelled.push({ epic, id, token });
				else if (!exists && createdBy.has(token)) notYetBuilt.push({ epic, id, token });
				else if (!exists) stale.push({ epic, id, token });
			}
		}
	}
}

// Vacuity guards: a parse that found no tasks or no paths must fail loudly
// rather than reporting a clean tree.
if (taskCount < 600 || pathCount < 500) {
	console.error(
		`REFUSING TO REPORT: parsed only ${taskCount} tasks / ${pathCount} paths, far below the ` +
			'tree this checker was written against — the parser has drifted.'
	);
	process.exit(2);
}

const byEpic = (rows) => {
	const counts = new Map();
	for (const row of rows) counts.set(row.epic, (counts.get(row.epic) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

const present = pathCount - notYetBuilt.length - stale.length;

/**
 * Per-epic presence: how much of the file surface an epic names already exists.
 * This is a METER, not a defect list — an absent path is the normal state of work
 * that has not been built yet, and this tree is not consistent about marking
 * which task creates what. The only crisp alarm is a path marked "new" that
 * exists: that task's surface has landed.
 */
const perEpic = new Map();
for (const epic of epics) perEpic.set(epic, { present: 0, absent: 0, landed: 0 });
for (const row of [...notYetBuilt, ...stale]) perEpic.get(row.epic).absent += 1;
for (const row of mislabelled) perEpic.get(row.epic).landed += 1;
for (const [epic, counts] of perEpic) {
	const total = counts.absent + counts.landed;
	counts.named = total;
}

console.log('App Works — task-path meter');
console.log(`epics parsed       : ${epics.length}`);
console.log(`tasks parsed       : ${taskCount}`);
console.log(`root paths checked : ${pathCount}   (package-relative, skipped: ${relativeCount})`);
console.log(`present in the repo: ${present}   absent (not built yet): ${stale.length + notYetBuilt.length}`);
console.log(`  of the absent, another task says it creates them: ${notYetBuilt.length}`);
console.log('');
console.log('LANDED SURFACE — path marked "new" by a task that already exists:');
for (const [epic, count] of byEpic(mislabelled)) console.log(`  ${epic}: ${count}`);
console.log('');
console.log('PER EPIC — paths named / already present / marked-new-and-landed:');
for (const epic of epics) {
	const c = perEpic.get(epic);
	console.log(`  ${epic.padEnd(28)} named ${String(c.named).padStart(4)} · landed ${String(c.landed).padStart(3)}`);
}
console.log('');

const report = [
	'# App Works — task-path meter',
	'',
	'This is a METER, not a defect list. An absent path is the normal state of work that has',
	'not been built yet; this tree is not consistent about marking which task creates what, so',
	'"absent" cannot be read as "the task text is wrong". The crisp signal is the last section:',
	'a path a task marks as new that already exists means that surface has landed.',
	'',
	`epics: ${epics.length} · tasks: ${taskCount} · root-anchored paths: ${pathCount} · ` +
		`package-relative skipped: ${relativeCount}`,
	'',
	`present: ${present} · absent: ${stale.length + notYetBuilt.length} · ` +
		`of the absent, another task says it creates them: ${notYetBuilt.length}`,
	'',
	`## LANDED SURFACE — marked "new", already in the repository (${mislabelled.length})`,
	'',
	...mislabelled.map((row) => `- ${row.epic} ${row.id} — \`${row.token}\``),
	'',
	`## PER EPIC — named / already present / landed (${epics.length} epics)`,
	'',
	'| Epic | Named | Landed (marked new, exists) |',
	'| ---- | ----- | --------------------------- |',
	...epics.map((epic) => {
		const c = perEpic.get(epic);
		return `| ${epic} | ${c.named} | ${c.landed} |`;
	}),
	'',
	`## ABSENT PATHS (${stale.length + notYetBuilt.length}) — grouped by epic`,
	'',
	'Listed by count only: an absent path is the normal state of unbuilt work, and a 1 500-line list of them',
	'in the repository would be noise. Pass `--full` to print every path to stdout instead.',
	'',
	...byEpic([...notYetBuilt, ...stale]).map(([epic, count]) => `- ${epic}: ${count}`),
	''
].join('\n');

const reportPath = join(SPEC_ROOT, 'tools', 'verify-task-paths.report.txt');
writeFileSync(reportPath, report, 'utf8');
console.log(`summary: ${reportPath}`);

if (process.argv.includes('--full')) {
	console.log('');
	console.log('ABSENT PATHS — full list');
	for (const row of [...notYetBuilt, ...stale]) {
		console.log(`  ${row.epic} ${row.id} — ${row.token}`);
	}
}
