import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as realFs, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES } from '@ever-works/contracts';
import {
	collectOwnerQuestion,
	defaultQuestionFs,
	discardOwnerQuestion,
	ownerQuestionPath,
	type AgentTaskQuestionFs
} from './agent-task-question';

/**
 * The owner-question file at the node (self-build slice Q).
 *
 * What must hold, in order of how much it would hurt to lose:
 *
 *   1. A file the model wrote is reported AND removed — file first, then
 *      the directory when that leaves it empty — so the finalize's
 *      `git add -A` can never stage it.
 *   2. A file that parses to nothing is removed too; an absent file
 *      triggers no removal at all.
 *   3. No filesystem error ever escapes (the run's other verdicts are
 *      still true); an abort is the one exception and propagates.
 *   4. Writable mounts are scanned after the primary, read-only mounts
 *      never; the primary wins when both carry a file, both are removed.
 *   5. (review SR-1) Only a regular file is ever opened: a symbolic link
 *      is not followed, a directory or a FIFO is not read (a FIFO would
 *      block the node for the whole lease) — each is removed like a file.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

/**
 * File symlinks need a privilege on Windows (Developer Mode or an elevated
 * service); probe once and skip the link cases where they cannot be made.
 */
const canSymlinkFiles = (() => {
	const probeRoot = mkdtempSync(join(tmpdir(), 'ew-question-symlink-probe-'));
	try {
		writeFileSync(join(probeRoot, 'target'), 'x');
		symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'), 'file');
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probeRoot, { recursive: true, force: true });
	}
})();
const MOUNT = process.platform === 'win32' ? 'C:\\template-worktree' : '/template-worktree';
const READ_ONLY_MOUNT = process.platform === 'win32' ? 'C:\\docs-worktree' : '/docs-worktree';

const QUESTION_PATH = ownerQuestionPath(ABSOLUTE);
const QUESTION_DIR = join(ABSOLUTE, '.ever-works');

/** In-memory question filesystem: records every call, in order, as `<op>:<path>`. */
function memoryFs(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));
	const events: string[] = [];
	const doubles: AgentTaskQuestionFs & { files: Map<string, string>; events: string[] } = {
		files,
		events,
		readHead: async (path, maxBytes) => {
			events.push(`read:${path}`);
			const content = files.get(path);
			if (content === undefined) return null;
			return Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
		},
		remove: async (path) => {
			events.push(`remove:${path}`);
			files.delete(path);
		},
		removeDirIfEmpty: async (path) => {
			events.push(`rmdir:${path}`);
		}
	};
	return doubles;
}

function errnoError(code: string, message = code): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function abortError(): Error {
	const error = new Error('lease lost');
	error.name = 'AbortError';
	return error;
}

describe('ownerQuestionPath', () => {
	it('joins the contracts file name under the worktree with the OS separator', () => {
		expect(ownerQuestionPath(ABSOLUTE)).toBe(join(ABSOLUTE, '.ever-works', 'QUESTION.md'));
	});
});

describe('collectOwnerQuestion — primary worktree', () => {
	it('returns null and removes nothing when the file is absent', async () => {
		const fs = memoryFs();
		expect(await collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs)).toBeNull();
		expect(fs.events).toEqual([`read:${QUESTION_PATH}`]);
	});

	it('parses the file, then removes the file and THEN the directory', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: '# Which DB?\n\nPostgres or SQLite' });
		const question = await collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs);
		expect(question).toEqual({
			text: 'Which DB?',
			context: 'Postgres or SQLite',
			truncated: false,
			mountDir: null
		});
		expect(fs.files.has(QUESTION_PATH)).toBe(false);
		expect(fs.events).toEqual([`read:${QUESTION_PATH}`, `remove:${QUESTION_PATH}`, `rmdir:${QUESTION_DIR}`]);
	});

	it('marks the question truncated when the head filled the read cap', async () => {
		// The node never reads past the cap, so a file that fills it had
		// bytes nobody looked at — even when the parsed parts themselves fit.
		const content = `Short question?\n\n${'x'.repeat(FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES)}`;
		const fs = memoryFs({ [QUESTION_PATH]: content });
		const question = await collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs);
		expect(question?.text).toBe('Short question?');
		expect(question?.truncated).toBe(true);
	});

	it('removes a blank file without reporting a question', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: '\n\n   \n' });
		expect(await collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs)).toBeNull();
		expect(fs.files.has(QUESTION_PATH)).toBe(false);
		expect(fs.events).toContain(`remove:${QUESTION_PATH}`);
	});

	it('yields null, without throwing, when the file cannot be read', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: 'Q?' });
		fs.readHead = async () => {
			throw errnoError('EACCES', 'permission denied');
		};
		await expect(collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs)).resolves.toBeNull();
		// Unreadable is not absent: the removal is still attempted.
		expect(fs.events).toContain(`remove:${QUESTION_PATH}`);
	});

	it('still reports the question when the removal fails', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: 'Ship it?' });
		fs.remove = async (path) => {
			fs.events.push(`remove:${path}`);
			throw errnoError('EPERM', 'operation not permitted');
		};
		fs.removeDirIfEmpty = async () => {
			throw errnoError('ENOTEMPTY');
		};
		const question = await collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs);
		expect(question?.text).toBe('Ship it?');
		expect(fs.events).toContain(`remove:${QUESTION_PATH}`);
	});

	it('propagates an abort raised by the filesystem', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: 'Q?' });
		fs.readHead = async () => {
			throw abortError();
		};
		await expect(collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs)).rejects.toThrowError(/lease lost/);
	});

	it('propagates an abort raised by the removal', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: 'Q?' });
		fs.remove = async () => {
			throw abortError();
		};
		await expect(collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs)).rejects.toThrowError(/lease lost/);
	});

	it('stops at a pre-aborted signal before touching the tree', async () => {
		const controller = new AbortController();
		controller.abort(new Error('lease lost'));
		const fs = memoryFs({ [QUESTION_PATH]: 'Q?' });
		await expect(collectOwnerQuestion({ primaryPath: ABSOLUTE }, fs, controller.signal)).rejects.toThrowError(
			/lease lost/
		);
		expect(fs.events).toEqual([]);
	});
});

describe('collectOwnerQuestion — writable mounts', () => {
	const mounts = [
		{ mountDir: 'template', path: MOUNT, writable: true },
		{ mountDir: 'docs', path: READ_ONLY_MOUNT, writable: false }
	];

	it('reports a question found only in a writable mount, naming the mount, and never reads a read-only one', async () => {
		const fs = memoryFs({ [ownerQuestionPath(MOUNT)]: '# Change the template too?\nIt has the same bug.' });
		const question = await collectOwnerQuestion({ primaryPath: ABSOLUTE, mounts }, fs);
		expect(question).toEqual({
			text: 'Change the template too?',
			context: 'It has the same bug.',
			truncated: false,
			mountDir: 'template'
		});
		expect(fs.files.has(ownerQuestionPath(MOUNT))).toBe(false);
		expect(fs.events.filter((event) => event.startsWith('read:'))).toEqual([
			`read:${QUESTION_PATH}`,
			`read:${ownerQuestionPath(MOUNT)}`
		]);
		expect(fs.events.some((event) => event.includes(READ_ONLY_MOUNT))).toBe(false);
	});

	it('prefers the primary when both carry a file, and removes both', async () => {
		const fs = memoryFs({
			[QUESTION_PATH]: 'Primary question?',
			[ownerQuestionPath(MOUNT)]: 'Mount question?'
		});
		const question = await collectOwnerQuestion({ primaryPath: ABSOLUTE, mounts }, fs);
		expect(question?.text).toBe('Primary question?');
		expect(question?.mountDir).toBeNull();
		expect(fs.files.size).toBe(0);
		expect(fs.events).toContain(`remove:${QUESTION_PATH}`);
		expect(fs.events).toContain(`remove:${ownerQuestionPath(MOUNT)}`);
	});
});

describe('discardOwnerQuestion', () => {
	it('removes a pre-seeded file and its directory before the model runs', async () => {
		const fs = memoryFs({ [QUESTION_PATH]: 'stale question from a crashed attempt' });
		await discardOwnerQuestion(ABSOLUTE, fs);
		expect(fs.files.has(QUESTION_PATH)).toBe(false);
		expect(fs.events).toEqual([`remove:${QUESTION_PATH}`, `rmdir:${QUESTION_DIR}`]);
	});

	it('swallows a missing file and a non-empty directory', async () => {
		const fs = memoryFs();
		fs.remove = async () => {
			throw errnoError('ENOENT');
		};
		fs.removeDirIfEmpty = async () => {
			throw errnoError('ENOTEMPTY');
		};
		await expect(discardOwnerQuestion(ABSOLUTE, fs)).resolves.toBeUndefined();
	});

	it('propagates an abort', async () => {
		const controller = new AbortController();
		controller.abort(new Error('lease lost'));
		await expect(discardOwnerQuestion(ABSOLUTE, memoryFs(), controller.signal)).rejects.toThrowError(/lease lost/);
	});
});

describe('defaultQuestionFs — the real filesystem', () => {
	it('reads at most maxBytes, reports an absent file as null, and removes file then empty directory', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-question-fs-'));
		try {
			const dir = join(root, '.ever-works');
			const file = join(dir, 'QUESTION.md');
			await realFs.mkdir(dir, { recursive: true });
			await realFs.writeFile(file, `Q?\n${'y'.repeat(100)}`, 'utf8');

			expect(await defaultQuestionFs.readHead(file, 10)).toBe('Q?\nyyyyyyy');
			expect(await defaultQuestionFs.readHead(file, 1024)).toBe(`Q?\n${'y'.repeat(100)}`);
			expect(await defaultQuestionFs.readHead(join(dir, 'missing.md'), 10)).toBeNull();
			expect(await defaultQuestionFs.readHead(join(root, 'no-such-dir', 'QUESTION.md'), 10)).toBeNull();

			// A non-empty directory is left alone...
			await defaultQuestionFs.removeDirIfEmpty(dir);
			expect((await realFs.stat(dir)).isDirectory()).toBe(true);
			// ...the file goes, then the now-empty directory, and both are idempotent.
			await defaultQuestionFs.remove(file);
			await defaultQuestionFs.remove(file);
			await defaultQuestionFs.removeDirIfEmpty(dir);
			await defaultQuestionFs.removeDirIfEmpty(dir);
			await expect(realFs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await realFs.rm(root, { recursive: true, force: true });
		}
	});

	it('collects a real file end to end and leaves the worktree clean', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-question-e2e-'));
		try {
			await realFs.mkdir(join(root, '.ever-works'), { recursive: true });
			await realFs.writeFile(ownerQuestionPath(root), '# Real file?\r\n\r\nYes.\r\n', 'utf8');
			const question = await collectOwnerQuestion({ primaryPath: root });
			expect(question).toEqual({ text: 'Real file?', context: 'Yes.', truncated: false, mountDir: null });
			expect(await realFs.readdir(root)).toEqual([]);
		} finally {
			await realFs.rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(canSymlinkFiles)(
		'never follows a symbolic link: the target is not read, the link is removed, the target survives (review SR-1)',
		async () => {
			const root = mkdtempSync(join(tmpdir(), 'ew-question-symlink-'));
			try {
				const target = join(root, 'secret.env');
				await realFs.writeFile(target, 'DATABASE_URL=postgres://user:hunter2@db/app\n', 'utf8');
				const worktree = join(root, 'worktree');
				await realFs.mkdir(join(worktree, '.ever-works'), { recursive: true });
				await realFs.symlink(target, ownerQuestionPath(worktree), 'file');

				await expect(defaultQuestionFs.readHead(ownerQuestionPath(worktree), 1024)).rejects.toMatchObject({
					code: 'EFTYPE'
				});
				expect(await collectOwnerQuestion({ primaryPath: worktree })).toBeNull();
				// The link and its directory are gone; what it pointed at is untouched.
				expect(await realFs.readdir(worktree)).toEqual([]);
				expect(await realFs.readFile(target, 'utf8')).toBe('DATABASE_URL=postgres://user:hunter2@db/app\n');
			} finally {
				await realFs.rm(root, { recursive: true, force: true });
			}
		}
	);

	it('treats a directory at the question path as unreadable, never as a question (review SR-1)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-question-dir-'));
		try {
			await realFs.mkdir(ownerQuestionPath(root), { recursive: true });
			await expect(defaultQuestionFs.readHead(ownerQuestionPath(root), 1024)).rejects.toMatchObject({
				code: 'EFTYPE'
			});
			await expect(collectOwnerQuestion({ primaryPath: root })).resolves.toBeNull();
		} finally {
			await realFs.rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== 'win32')(
		'treats a FIFO as unreadable instead of blocking on it, and removes it (review SR-1)',
		async () => {
			const root = mkdtempSync(join(tmpdir(), 'ew-question-fifo-'));
			try {
				await realFs.mkdir(join(root, '.ever-works'), { recursive: true });
				execFileSync('mkfifo', [ownerQuestionPath(root)]);
				await expect(defaultQuestionFs.readHead(ownerQuestionPath(root), 1024)).rejects.toMatchObject({
					code: 'EFTYPE'
				});
				expect(await collectOwnerQuestion({ primaryPath: root })).toBeNull();
				expect(await realFs.readdir(root)).toEqual([]);
			} finally {
				await realFs.rm(root, { recursive: true, force: true });
			}
		}
	);
});
