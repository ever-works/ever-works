import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	collectMisplacedOwnerQuestions,
	defaultQuestionFs,
	MISPLACED_QUESTION_SCAN_LIMITS,
	type AgentTaskQuestionFs
} from './agent-task-question';

/**
 * Self-build slice AU (a slice-Q follow-up) — a `.ever-works/QUESTION.md`
 * written from a SUBDIRECTORY.
 *
 * The node reads only the repository root's question file; the exclude rule
 * keeps a nested one out of Git, so before this the question simply
 * vanished. What must hold:
 *
 *   1. a nested file is FOUND and reported as a workspace-relative POSIX
 *      path (a mount's prefixed `.mounts/<dir>/`), never absolute;
 *   2. it is REMOVED (with its directory when that empties it) so a reused
 *      worktree does not report it again;
 *   3. the root's own file is never reported (it is the protocol's), nor
 *      anything under `node_modules`, `.git` or the `.mounts` links;
 *   4. the scan never walks through a link or junction out of the tree;
 *   5. a seam without `readDir` scans nothing.
 */

const roots: string[] = [];
function tempRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `ew-misplaced-${label}-`));
	roots.push(root);
	return root;
}

function writeQuestion(dir: string, text = 'Which DB?'): string {
	mkdirSync(join(dir, '.ever-works'), { recursive: true });
	const path = join(dir, '.ever-works', 'QUESTION.md');
	writeFileSync(path, text);
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('collectMisplacedOwnerQuestions', () => {
	it('⭐ reports a question written from a subdirectory, removes it, and never reports the root file', async () => {
		const primary = tempRoot('primary');
		const rootFile = writeQuestion(primary, 'root question');
		const nested = writeQuestion(join(primary, 'apps', 'api'));

		const found = await collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs);

		expect(found).toEqual(['apps/api/.ever-works/QUESTION.md']);
		expect(existsSync(nested)).toBe(false);
		expect(existsSync(join(primary, 'apps', 'api', '.ever-works'))).toBe(false);
		// The root file is `collectOwnerQuestion`'s, untouched here.
		expect(existsSync(rootFile)).toBe(true);
	});

	it('prefixes a writable mount’s findings and skips read-only mounts', async () => {
		const primary = tempRoot('primary');
		const writable = tempRoot('writable');
		const readOnly = tempRoot('readonly');
		writeQuestion(join(writable, 'packages', 'ui'));
		const untouched = writeQuestion(join(readOnly, 'src'));

		const found = await collectMisplacedOwnerQuestions(
			{
				primaryPath: primary,
				mounts: [
					{ mountDir: 'template', path: writable, writable: true },
					{ mountDir: 'docs', path: readOnly, writable: false }
				]
			},
			defaultQuestionFs
		);

		expect(found).toEqual(['.mounts/template/packages/ui/.ever-works/QUESTION.md']);
		expect(existsSync(untouched)).toBe(true);
	});

	it('skips node_modules, .git and the .mounts links', async () => {
		const primary = tempRoot('primary');
		writeQuestion(join(primary, 'node_modules', 'pkg'));
		writeQuestion(join(primary, '.git', 'hooks'));
		writeQuestion(join(primary, '.mounts', 'template'));

		expect(await collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs)).toEqual([]);
	});

	it('never walks through a directory link out of the worktree', async () => {
		const primary = tempRoot('primary');
		const outside = tempRoot('outside');
		const outsideFile = writeQuestion(join(outside, 'deep'));
		// A junction on Windows needs no privilege; a dir symlink elsewhere.
		symlinkSync(outside, join(primary, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

		expect(await collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs)).toEqual([]);
		expect(existsSync(outsideFile)).toBe(true);
	});

	it('caps what it reports, but removes every file it found', async () => {
		const primary = tempRoot('primary');
		const files = Array.from({ length: MISPLACED_QUESTION_SCAN_LIMITS.maxReported + 2 }, (_, index) =>
			writeQuestion(join(primary, `pkg${index}`))
		);

		const found = await collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs);

		expect(found).toHaveLength(MISPLACED_QUESTION_SCAN_LIMITS.maxReported);
		for (const file of files) expect(existsSync(file)).toBe(false);
	});

	it('does not descend past the depth bound', async () => {
		const primary = tempRoot('primary');
		const segments = Array.from({ length: MISPLACED_QUESTION_SCAN_LIMITS.maxDepth + 1 }, (_, i) => `d${i}`);
		const tooDeep = writeQuestion(join(primary, ...segments));
		writeQuestion(join(primary, 'shallow'));

		expect(await collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs)).toEqual([
			'shallow/.ever-works/QUESTION.md'
		]);
		expect(existsSync(tooDeep)).toBe(true);
	});

	it('scans nothing through a seam without readDir, and propagates an abort', async () => {
		const primary = tempRoot('primary');
		writeQuestion(join(primary, 'apps'));
		const { readDir: _readDir, ...withoutReadDir } = defaultQuestionFs;
		expect(
			await collectMisplacedOwnerQuestions({ primaryPath: primary }, withoutReadDir as AgentTaskQuestionFs)
		).toEqual([]);

		const controller = new AbortController();
		controller.abort(new Error('lease lost'));
		await expect(
			collectMisplacedOwnerQuestions({ primaryPath: primary }, defaultQuestionFs, controller.signal)
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('collectMisplacedOwnerQuestions — the entry budget bounds what is READ (review)', () => {
	it('never asks a directory for more entries than the budget has left', async () => {
		const { maxEntries } = MISPLACED_QUESTION_SCAN_LIMITS;
		const requested: number[] = [];
		let delivered = 0;
		// A generated directory far larger than the budget, everywhere.
		const huge: AgentTaskQuestionFs = {
			readHead: async () => null,
			remove: async () => undefined,
			removeDirIfEmpty: async () => undefined,
			readDir: async (_path, limit) => {
				requested.push(limit);
				const size = Math.min(limit, maxEntries * 3);
				delivered += size;
				return Array.from({ length: size }, (_, i) => ({ name: `d${i}`, kind: 'dir' as const }));
			}
		};

		expect(await collectMisplacedOwnerQuestions({ primaryPath: '/ws' }, huge)).toEqual([]);
		expect(requested[0]).toBe(maxEntries);
		expect(Math.max(...requested)).toBeLessThanOrEqual(maxEntries);
		expect(delivered).toBeLessThanOrEqual(maxEntries);
	});

	it('the default reader stops at the limit', async () => {
		const dir = tempRoot('many');
		for (let i = 0; i < 30; i += 1) writeFileSync(join(dir, `f${i}.txt`), '');
		expect(await defaultQuestionFs.readDir!(dir, 10)).toHaveLength(10);
		expect(await defaultQuestionFs.readDir!(dir, 0)).toEqual([]);
		expect(await defaultQuestionFs.readDir!(dir, 1000)).toHaveLength(30);
	});
});
