import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { stripFleetRemoteCredential, type FleetGitLine } from '@ever-works/contracts';
import type { CheckoutGitRunner } from './checkout-git';

/**
 * Checkouts on computers (FL-14, CONTRACTS §4.7, spec FR-8, FR-10) — the git
 * line of one checkout, computed on the machine WITHOUT contacting the
 * remote: ahead/behind are against the remote-tracking ref the last fetch
 * left, so a refresh is three local git reads and never a network call.
 *
 *   git status --porcelain=v2 --branch   branch, upstream, ahead/behind, changed and untracked files
 *   git diff HEAD --numstat              lines added / removed (staged + unstaged)
 *   git config --get remote.origin.url   the remote (token-free before it leaves)
 *
 * Whether it is a worktree is read off the checkout's `.git`: a linked
 * worktree's is a FILE pointing at the main repository's gitdir.
 */

/** Everything one read of a checkout yields. */
export interface CheckoutFacts {
	gitLine: FleetGitLine;
	branch: string | null;
	headSha: string | null;
	baseRef: string | null;
	isWorktree: boolean;
	remoteUrl: string | null;
	remoteHadCredential: boolean;
	/** The main checkout's path, for a linked worktree (from its `.git` file), when readable. */
	mainCheckoutPath: string | null;
}

/** What `git status --porcelain=v2 --branch` says, parsed. */
export interface PorcelainStatus {
	headSha: string | null;
	branch: string | null;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	/** Tracked entries with changes (ordinary, renamed/copied, unmerged). */
	changed: number;
	untracked: number;
}

/** Parse porcelain v2 with `--branch`. Pure; tolerant of lines it does not know. */
export function parsePorcelainV2(output: string): PorcelainStatus {
	const status: PorcelainStatus = {
		headSha: null,
		branch: null,
		upstream: null,
		ahead: null,
		behind: null,
		changed: 0,
		untracked: 0
	};
	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith('# branch.oid ')) {
			const oid = line.slice('# branch.oid '.length).trim();
			status.headSha = /^[0-9a-f]{7,64}$/i.test(oid) ? oid : null;
		} else if (line.startsWith('# branch.head ')) {
			const head = line.slice('# branch.head '.length).trim();
			status.branch = head && head !== '(detached)' ? head : null;
		} else if (line.startsWith('# branch.upstream ')) {
			status.upstream = line.slice('# branch.upstream '.length).trim() || null;
		} else if (line.startsWith('# branch.ab ')) {
			const match = /^\+(\d+) -(\d+)$/.exec(line.slice('# branch.ab '.length).trim());
			if (match) {
				status.ahead = Number(match[1]);
				status.behind = Number(match[2]);
			}
		} else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
			status.changed += 1;
		} else if (line.startsWith('? ')) {
			status.untracked += 1;
		}
	}
	return status;
}

/** Sum `git diff --numstat`: binary files (`-\t-`) count as changed with no lines. */
export function parseNumstat(output: string): { added: number; removed: number; files: number } {
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of output.split(/\r?\n/)) {
		const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (!match) continue;
		files += 1;
		if (match[1] !== '-') added += Number(match[1]);
		if (match[2] !== '-') removed += Number(match[2]);
	}
	return { added, removed, files };
}

/** True when `path/.git` exists (a directory for a clone, a file for a linked worktree). */
export async function isGitCheckout(path: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(join(path, '.git'));
		return stats.isDirectory() || stats.isFile();
	} catch {
		return false;
	}
}

/**
 * For a linked worktree, the main checkout's path: its `.git` file reads
 * `gitdir: <main>/.git/worktrees/<name>`. Null for a clone, a bare pool, or
 * anything unreadable.
 */
export async function readWorktreeMain(path: string): Promise<{ isWorktree: boolean; mainPath: string | null }> {
	let stats;
	try {
		stats = await fs.lstat(join(path, '.git'));
	} catch {
		return { isWorktree: false, mainPath: null };
	}
	if (!stats.isFile()) return { isWorktree: false, mainPath: null };
	try {
		const text = (await fs.readFile(join(path, '.git'), 'utf8')).slice(0, 4096);
		const match = /^gitdir:\s*(.+)$/m.exec(text);
		const gitdir = match?.[1]?.trim() ?? '';
		const marker = gitdir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/');
		if (marker <= 0) return { isWorktree: true, mainPath: null };
		return { isWorktree: true, mainPath: gitdir.slice(0, marker) };
	} catch {
		return { isWorktree: true, mainPath: null };
	}
}

/**
 * Read one checkout's facts. Never contacts the remote. A git that cannot
 * read the checkout at all answers null (the caller reports it present but
 * without a line).
 */
export async function readCheckoutFacts(
	path: string,
	git: CheckoutGitRunner,
	options: { signal?: AbortSignal; now?: () => number } = {}
): Promise<CheckoutFacts | null> {
	const now = options.now ?? (() => Date.now());
	const status = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
		cwd: path,
		...(options.signal ? { signal: options.signal } : {})
	});
	if (status.code !== 0) return null;
	const parsed = parsePorcelainV2(status.stdout);
	let numstat = { added: 0, removed: 0, files: 0 };
	if (parsed.headSha) {
		const diff = await git(['diff', 'HEAD', '--numstat', '--no-renames'], {
			cwd: path,
			...(options.signal ? { signal: options.signal } : {})
		});
		if (diff.code === 0) numstat = parseNumstat(diff.stdout);
	}
	const remote = await git(['config', '--get', 'remote.origin.url'], {
		cwd: path,
		...(options.signal ? { signal: options.signal } : {})
	});
	const stripped = remote.code === 0 ? stripFleetRemoteCredential(remote.stdout.trim()) : null;
	let baseRef: string | null = null;
	if (parsed.branch) {
		const base = await git(['config', '--get', `branch.${parsed.branch}.base`], {
			cwd: path,
			...(options.signal ? { signal: options.signal } : {})
		});
		baseRef = base.code === 0 ? base.stdout.trim() || null : null;
	}
	baseRef = baseRef ?? parsed.upstream;
	const worktree = await readWorktreeMain(path);
	const gitLine: FleetGitLine = {
		branch: parsed.branch,
		isWorktree: worktree.isWorktree,
		baseRef,
		ahead: parsed.upstream ? parsed.ahead : null,
		behind: parsed.upstream ? parsed.behind : null,
		added: numstat.added,
		removed: numstat.removed,
		filesChanged: Math.max(parsed.changed, numstat.files),
		uncommitted: parsed.changed + parsed.untracked,
		pr: null,
		at: new Date(now()).toISOString()
	};
	return {
		gitLine,
		branch: parsed.branch,
		headSha: parsed.headSha,
		baseRef,
		isWorktree: worktree.isWorktree,
		remoteUrl: stripped?.url ?? null,
		remoteHadCredential: stripped?.hadCredential === true,
		mainCheckoutPath: worktree.mainPath
	};
}
