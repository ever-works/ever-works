import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { CHECKOUT_GIT_NETWORK_TIMEOUT_MS, type CheckoutGitResult, type CheckoutGitRunner } from './checkout-git';
import { CHECKOUT_CREDENTIAL_UNSET_ENV } from './checkout-credential';

/**
 * Checkouts on computers (FL-14, spec FR-16 … FR-26, plan §6) — the git work
 * behind create, pull, push and delete. Argv only, every command cancellable,
 * and every one that may leave a half-made folder cleans it up:
 *
 *  - **clone** into a path that must not exist yet; on failure the partial
 *    folder is removed (FR-20). A credentialed clone (a checkout Ever Works
 *    creates) runs with the scoped credential in the child's environment and
 *    every other credential source off — never the machine's helper (FR-17);
 *  - **worktree** add on an existing checkout, into a path OUTSIDE it (under
 *    the node's checkouts root, FR-18), on a new branch from the base ref, or
 *    on an existing local branch;
 *  - **pull** fast-forward only (a merge or a rebase is a session's job);
 *  - **push** the current branch to `origin`;
 *  - **remove** a worktree through git (`worktree remove`, then `prune`) so its
 *    registration goes with it and the BRANCH STAYS (FR-25); a clone's folder
 *    is deleted. A discovered checkout is never removed here — it is only
 *    forgotten.
 */

export interface CheckoutOperationOptions {
	git: CheckoutGitRunner;
	signal?: AbortSignal;
	/** The scoped credential's environment (platform-created checkouts only). */
	credentialEnv?: Record<string, string>;
}

/** Options for one network command: credentialed when a credential is given. */
function network(options: CheckoutOperationOptions, cwd: string) {
	return {
		cwd,
		timeoutMs: CHECKOUT_GIT_NETWORK_TIMEOUT_MS,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.credentialEnv ? { env: options.credentialEnv, unsetEnv: CHECKOUT_CREDENTIAL_UNSET_ENV } : {})
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** A path that already exists is refused (spec U13). */
export class CheckoutPathTakenError extends Error {
	constructor(readonly path: string) {
		super(`${path} already exists`);
		this.name = 'CheckoutPathTakenError';
	}
}

/** Clone `repoUrl` into `path` and check out `branch` (new from `baseRef` when the remote has no such branch). */
export async function cloneCheckout(
	input: { path: string; repoUrl: string; branch: string; baseRef: string | null },
	options: CheckoutOperationOptions
): Promise<CheckoutGitResult> {
	if (await exists(input.path)) throw new CheckoutPathTakenError(input.path);
	await fs.mkdir(dirname(input.path), { recursive: true });
	const args = ['clone', '--origin', 'origin', '--no-tags'];
	if (input.baseRef) args.push('--branch', input.baseRef);
	args.push('--', input.repoUrl, input.path);
	let result = await options.git(args, network(options, dirname(input.path)));
	if (result.code === 0) {
		result = await switchToBranch(input.path, input.branch, input.baseRef, options);
	}
	if (result.code !== 0) await removePartial(input.path);
	return result;
}

/** Add a worktree of `parentPath` at `path` on `branch` (new from `baseRef`, or the existing local branch). */
export async function addWorktree(
	input: { parentPath: string; path: string; branch: string; baseRef: string | null },
	options: CheckoutOperationOptions
): Promise<CheckoutGitResult> {
	if (await exists(input.path)) throw new CheckoutPathTakenError(input.path);
	await fs.mkdir(dirname(input.path), { recursive: true });
	const local = await options.git(['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`], {
		cwd: input.parentPath,
		...(options.signal ? { signal: options.signal } : {})
	});
	const args =
		local.code === 0
			? ['worktree', 'add', '--', input.path, input.branch]
			: ['worktree', 'add', '-b', input.branch, '--', input.path, input.baseRef ?? 'HEAD'];
	const result = await options.git(args, {
		cwd: input.parentPath,
		...(options.signal ? { signal: options.signal } : {})
	});
	if (result.code !== 0) {
		await removePartial(input.path);
		await options.git(['worktree', 'prune'], { cwd: input.parentPath });
	}
	return result;
}

/** Fetch, prune. */
export async function fetchCheckout(path: string, options: CheckoutOperationOptions): Promise<CheckoutGitResult> {
	return options.git(['fetch', '--prune', 'origin'], network(options, path));
}

/** Pull, fast-forward only. The caller refused a dirty tree first (spec FR-21, U7). */
export async function pullCheckout(path: string, options: CheckoutOperationOptions): Promise<CheckoutGitResult> {
	return options.git(['pull', '--ff-only', '--no-rebase', 'origin'], network(options, path));
}

/**
 * Push the current branch to `origin` (spec FR-22). A credentialed push skips
 * hooks (`--no-verify`, and `core.hooksPath` is empty in the credential
 * environment) — a hook would inherit the token; an owner's own push runs
 * exactly as their terminal would.
 */
export async function pushCheckout(
	path: string,
	branch: string,
	options: CheckoutOperationOptions
): Promise<CheckoutGitResult> {
	const args = ['push'];
	if (options.credentialEnv) args.push('--no-verify');
	args.push('--set-upstream', 'origin', `HEAD:refs/heads/${branch}`);
	return options.git(args, network(options, path));
}

/** Remove a worktree through git — its branch stays (spec FR-25). */
export async function removeWorktree(
	input: { path: string; mainPath: string },
	options: CheckoutOperationOptions
): Promise<CheckoutGitResult> {
	const result = await options.git(['worktree', 'remove', '--force', '--', input.path], {
		cwd: input.mainPath,
		...(options.signal ? { signal: options.signal } : {})
	});
	await options.git(['worktree', 'prune'], { cwd: input.mainPath });
	return result;
}

/** Remove a clone's folder. Only ever called for a path under the node's checkouts root. */
export async function removeCloneFolder(path: string): Promise<void> {
	await fs.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** The remote's branch names (`git ls-remote --heads origin`) — FL-06's `remoteHeads`, spec FR-26b. */
export async function remoteBranches(path: string, options: CheckoutOperationOptions): Promise<string[] | null> {
	const result = await options.git(['ls-remote', '--heads', 'origin'], network(options, path));
	if (result.code !== 0) return null;
	const out: string[] = [];
	for (const line of result.stdout.split(/\r?\n/)) {
		const match = /\trefs\/heads\/(.+)$/.exec(line.trim());
		if (match) out.push(match[1]);
	}
	return out;
}

async function switchToBranch(
	path: string,
	branch: string,
	baseRef: string | null,
	options: CheckoutOperationOptions
): Promise<CheckoutGitResult> {
	const current = await options.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path });
	if (current.code === 0 && current.stdout.trim() === branch) return current;
	const remote = await options.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
		cwd: path
	});
	if (remote.code === 0) return options.git(['switch', '--track', `origin/${branch}`], { cwd: path });
	return options.git(['switch', '-c', branch, ...(baseRef ? [`origin/${baseRef}`] : [])], { cwd: path });
}

async function removePartial(path: string): Promise<void> {
	try {
		await fs.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		// Best-effort; the reconcile reports what is left as it finds it.
	}
}
