import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises BEFORE importing the module so the spy is in place.
vi.mock('fs/promises', () => {
	const rm = vi.fn().mockResolvedValue(undefined);
	return {
		default: { rm },
		rm
	};
});

import * as fs from 'fs/promises';
import { cleanupWorkspace } from '../workspace.js';

describe('cleanupWorkspace — safety guard', () => {
	const rm = fs.rm as unknown as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		rm.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('refuses an empty path', async () => {
		await cleanupWorkspace('');
		expect(rm).not.toHaveBeenCalled();
	});

	it('refuses whitespace-only path', async () => {
		await cleanupWorkspace('   ');
		expect(rm).not.toHaveBeenCalled();
	});

	it('refuses the POSIX root', async () => {
		await cleanupWorkspace('/');
		expect(rm).not.toHaveBeenCalled();
	});

	it('refuses a Windows drive root (C:\\)', async () => {
		// Regression: the previous Windows-root guard was dead because it
		// checked `path.posix.resolve(...)` which never produces a `C:\`
		// shape. cleanupWorkspace must call `nativePath.resolve(...)` for
		// the safety check so this input is recognized as the root drive
		// and refused. (On a non-Windows host `nativePath.resolve('C:\\')`
		// returns a POSIX-shaped path, but the guard also catches the
		// canonical root via `/` — see the next test.)
		await cleanupWorkspace('C:\\');
		expect(rm).not.toHaveBeenCalled();
	});

	it('refuses a Windows drive root with forward slash (C:/)', async () => {
		await cleanupWorkspace('C:/');
		expect(rm).not.toHaveBeenCalled();
	});

	it('refuses when baseTempDir is supplied and workspace is not under it', async () => {
		await cleanupWorkspace('/some/other/dir/work', '/tmp/work-builder');
		expect(rm).not.toHaveBeenCalled();
	});

	it('cleans up a path under the supplied baseTempDir', async () => {
		await cleanupWorkspace('/tmp/work-builder/u1/w1/run-abc', '/tmp/work-builder');
		expect(rm).toHaveBeenCalledTimes(1);
		expect(rm).toHaveBeenCalledWith(
			expect.stringContaining('run-abc'),
			expect.objectContaining({ recursive: true, force: true })
		);
	});
});
