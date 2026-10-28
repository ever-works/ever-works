import { describe, expect, it, vi } from 'vitest';
import { killableDisk } from './__fixtures__/killable-disk';
import {
	isRetryableRenameError,
	isTempFileFor,
	publishFileExclusively,
	RENAME_RETRY_DELAYS_MS,
	replaceFileAtomically,
	STALE_TEMP_FILE_AGE_MS,
	sweepStaleTempFiles,
	tempFilePathFor,
	type ExclusiveAtomicFileOps
} from './atomic-state-file';

const DIR = 'C:/state';
const TARGET = `${DIR}/node-config.json.lifecycle.json`;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');

/** The killable disk's fs, typed as the atomic primitives it implements. */
function ops(h: ReturnType<typeof killableDisk>): ExclusiveAtomicFileOps {
	return h.fs as unknown as ExclusiveAtomicFileOps;
}

describe('replaceFileAtomically', () => {
	it('stages an empty temp beside the target, tightens it, fills it, then renames it over the target', async () => {
		const h = killableDisk({ [TARGET]: 'old' });
		const tighten = vi.fn(async (path: string) => {
			// Tightened while it still holds nothing.
			expect(h.files.get(path)).toBe('');
		});

		await replaceFileAtomically(ops(h), TARGET, 'new', {
			platform: 'linux',
			tighten,
			tempTag: () => '7.0123456789ab'
		});

		const temp = `${TARGET}.7.0123456789ab.tmp`;
		expect(tighten).toHaveBeenCalledWith(temp);
		expect(h.ops.map((op) => [op.op, op.path])).toEqual([
			['create', temp],
			['write', temp],
			['rename', temp],
			['syncDir', DIR]
		]);
		expect(h.files.get(TARGET)).toBe('new');
		expect(h.temps()).toEqual([]);
	});

	it('names temp files after the target, in its own directory, with a pid and 12 hex digits', async () => {
		const h = killableDisk();
		h.killAt((op) => (op.op === 'rename' ? 'kill' : null));
		void replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'win32' });
		await vi.waitFor(() => expect(h.killed).toBe(true), { timeout: 500 });

		const [temp] = h.temps();
		expect(temp.startsWith(`${TARGET}.${process.pid}.`)).toBe(true);
		expect(isTempFileFor(temp.slice(DIR.length + 1), 'node-config.json')).toBe(true);
		expect(tempFilePathFor('/a/b.json', '1.abc')).toBe('/a/b.json.1.abc.tmp');
	});

	it('does not flush the directory on Windows', async () => {
		const h = killableDisk();
		await replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'win32' });
		expect(h.ops.some((op) => op.op === 'syncDir')).toBe(false);
	});

	it('a tightening failure aborts before any content is written: temp removed, target untouched', async () => {
		const h = killableDisk({ [TARGET]: 'old' });

		await expect(
			replaceFileAtomically(ops(h), TARGET, 'secret', {
				platform: 'win32',
				tighten: async () => {
					throw new Error('ACL refused');
				}
			})
		).rejects.toThrow('ACL refused');

		expect(h.ops.some((op) => op.content === 'secret')).toBe(false);
		expect(h.files.get(TARGET)).toBe('old');
		expect(h.temps()).toEqual([]);
	});

	it('picks a fresh temp name when one is already taken', async () => {
		const tags = ['1.aaaaaaaaaaaa', '1.bbbbbbbbbbbb'];
		const h = killableDisk({ [`${TARGET}.1.aaaaaaaaaaaa.tmp`]: 'someone else' });

		await replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'linux', tempTag: () => tags.shift()! });

		expect(h.files.get(TARGET)).toBe('new');
		expect(h.files.get(`${TARGET}.1.aaaaaaaaaaaa.tmp`)).toBe('someone else');
	});

	it('retries a busy rename with the bounded back-off, then succeeds', async () => {
		const h = killableDisk({ [TARGET]: 'old' });
		h.failRenames('EBUSY', 'EPERM', 'EACCES');
		const sleep = vi.fn(async () => undefined);

		await replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'win32', sleep });

		expect(h.ops.filter((op) => op.op === 'rename')).toHaveLength(4);
		expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 3));
		expect(h.files.get(TARGET)).toBe('new');
	});

	it('gives up after the last retry: the old file stays, the temp goes, the error surfaces', async () => {
		const h = killableDisk({ [TARGET]: 'old' });
		h.failRenames(...RENAME_RETRY_DELAYS_MS.map(() => 'EBUSY'), 'EBUSY');
		const sleep = vi.fn(async () => undefined);

		await expect(replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'win32', sleep })).rejects.toMatchObject({
			code: 'EBUSY'
		});

		expect(h.ops.filter((op) => op.op === 'rename')).toHaveLength(RENAME_RETRY_DELAYS_MS.length + 1);
		expect(RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(3_000);
		expect(h.files.get(TARGET)).toBe('old');
		expect(h.temps()).toEqual([]);
	});

	it('does not retry a permission refusal on POSIX, nor an error that is not "busy"', async () => {
		expect(isRetryableRenameError({ code: 'EPERM' }, 'linux')).toBe(false);
		expect(isRetryableRenameError({ code: 'EACCES' }, 'darwin')).toBe(false);
		expect(isRetryableRenameError({ code: 'EBUSY' }, 'linux')).toBe(true);
		expect(isRetryableRenameError({ code: 'EPERM' }, 'win32')).toBe(true);
		expect(isRetryableRenameError({ code: 'ENOSPC' }, 'win32')).toBe(false);

		const h = killableDisk({ [TARGET]: 'old' });
		h.failRenames('EXDEV');
		const sleep = vi.fn(async () => undefined);
		await expect(replaceFileAtomically(ops(h), TARGET, 'new', { platform: 'win32', sleep })).rejects.toMatchObject({
			code: 'EXDEV'
		});
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe('publishFileExclusively', () => {
	it('links a complete temp into place and removes the temp name', async () => {
		const h = killableDisk();

		await publishFileExclusively(ops(h), TARGET, 'marker', { platform: 'linux' });

		expect(h.ops.map((op) => op.op)).toEqual(['create', 'write', 'link', 'remove', 'syncDir']);
		expect(h.files.get(TARGET)).toBe('marker');
		expect(h.temps()).toEqual([]);
	});

	it('refuses an existing target with EEXIST and leaves it alone', async () => {
		const h = killableDisk({ [TARGET]: 'first' });

		await expect(publishFileExclusively(ops(h), TARGET, 'second', { platform: 'linux' })).rejects.toMatchObject({
			code: 'EEXIST'
		});
		expect(h.files.get(TARGET)).toBe('first');
		expect(h.temps()).toEqual([]);
	});
});

describe('sweepStaleTempFiles', () => {
	it('removes only stale temp files named after the file, never anything else', async () => {
		const ours = `${DIR}/node-config.json.11.0123456789ab.tmp`;
		const oursSibling = `${DIR}/node-config.json.bak.12.0123456789ab.tmp`;
		const fresh = `${DIR}/node-config.json.13.0123456789ab.tmp`;
		const lookalike = `${DIR}/node-config.json.tmp`;
		const otherFile = `${DIR}/helper-policy.json.14.0123456789ab.tmp`;
		const h = killableDisk({
			[`${DIR}/node-config.json`]: '{}',
			[ours]: 'x',
			[oursSibling]: 'x',
			[fresh]: 'x',
			[lookalike]: 'x',
			[otherFile]: 'x'
		});
		for (const path of [ours, oursSibling, lookalike, otherFile])
			h.mtimes.set(path, NOW - STALE_TEMP_FILE_AGE_MS - 1);
		h.mtimes.set(fresh, NOW - 1_000);

		const removed = await sweepStaleTempFiles(h.fs, `${DIR}/node-config.json`, { now: NOW });

		expect(removed.sort()).toEqual([oursSibling, ours].sort());
		expect([...h.files.keys()].sort()).toEqual([`${DIR}/node-config.json`, fresh, lookalike, otherFile].sort());
	});

	it('with no age limit removes every one of them (unenroll)', async () => {
		const fresh = `${DIR}/node-config.json.13.0123456789ab.tmp`;
		const h = killableDisk({ [fresh]: 'secret' });
		h.mtimes.set(fresh, NOW);

		await sweepStaleTempFiles(h.fs, `${DIR}/node-config.json`, { now: NOW, olderThanMs: 0 });

		expect(h.files.has(fresh)).toBe(false);
	});

	it('is a no-op on a filesystem that cannot list a directory', async () => {
		const h = killableDisk({}, { legacy: true });
		await expect(sweepStaleTempFiles(h.fs, `${DIR}/node-config.json`)).resolves.toEqual([]);
	});
});
