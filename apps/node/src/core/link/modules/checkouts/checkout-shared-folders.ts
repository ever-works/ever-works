import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isFleetCheckoutSharedFolder } from '@ever-works/contracts';
import type { CheckoutGitRunner } from './checkout-git';

/**
 * Checkouts on computers (FL-14 P3, spec FR-32, ACC-FL14-28) — folders a new
 * worktree SHARES with its parent checkout (`node_modules`, `.env.local`, a
 * build cache): linked, never copied — a symbolic link on macOS and Linux, a
 * junction on Windows (no administrator right needed).
 *
 * Each folder must be a relative path inside the parent (no `..`, never
 * `.git`), must exist there, and must be IGNORED by git in the parent — a
 * tracked folder is part of the repository and belongs in the worktree's own
 * checkout. A folder that fails any of these is skipped and named; one bad
 * entry never fails the create.
 */

export interface SharedFolderOutcome {
	folder: string;
	linked: boolean;
	/** Why it was skipped. */
	reason?: 'invalid' | 'missing' | 'tracked' | 'exists' | 'failed';
}

export async function linkSharedFolders(
	input: { parentPath: string; worktreePath: string; folders: readonly string[]; platform: string },
	git: CheckoutGitRunner
): Promise<SharedFolderOutcome[]> {
	const outcomes: SharedFolderOutcome[] = [];
	const parent = resolve(input.parentPath);
	const worktree = resolve(input.worktreePath);
	for (const folder of input.folders) {
		if (!isFleetCheckoutSharedFolder(folder)) {
			outcomes.push({ folder, linked: false, reason: 'invalid' });
			continue;
		}
		const target = resolve(parent, folder);
		const destination = resolve(worktree, folder);
		// Belt and braces over the lexical check: both ends stay inside their checkouts.
		if (relative(parent, target).startsWith('..') || relative(worktree, destination).startsWith('..')) {
			outcomes.push({ folder, linked: false, reason: 'invalid' });
			continue;
		}
		try {
			await fs.lstat(target);
		} catch {
			outcomes.push({ folder, linked: false, reason: 'missing' });
			continue;
		}
		const ignored = await git(['check-ignore', '-q', '--', folder], { cwd: parent });
		if (ignored.code !== 0) {
			outcomes.push({ folder, linked: false, reason: 'tracked' });
			continue;
		}
		try {
			await fs.lstat(destination);
			outcomes.push({ folder, linked: false, reason: 'exists' });
			continue;
		} catch {
			// free — link it
		}
		try {
			await fs.mkdir(dirname(destination), { recursive: true });
			const stats = await fs.stat(target);
			const type = stats.isDirectory() ? (input.platform === 'win32' ? 'junction' : 'dir') : 'file';
			await fs.symlink(target, destination, type);
			outcomes.push({ folder, linked: true });
		} catch {
			outcomes.push({ folder, linked: false, reason: 'failed' });
		}
	}
	return outcomes;
}

/** Join helper kept for specs that build fixture paths the same way. */
export function sharedFolderPath(root: string, folder: string): string {
	return join(root, folder);
}
