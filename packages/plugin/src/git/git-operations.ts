import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import git from 'isomorphic-git';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import * as nodeHttp from 'isomorphic-git/http/node';
import type {
	IGitOperations,
	GitAuth,
	GitCommitter,
	GitCloneOptions,
	GitCloneBranchOptions,
	GitPushOptions,
	GitFileChange,
	GitFileStatus
} from '../contracts/capabilities/git-provider.interface.js';

/**
 * Node >= 19 ships `http(s).globalAgent` with `timeout: 5000` - a SOCKET-IDLE deadline, not a
 * total-request budget. `isomorphic-git/http/node` never passes an `agent`, so every git-over-HTTP
 * request inherits it and `simple-get` rejects with the literal string `Request timed out` after ~5s.
 *
 * That string matches none of the entries in the push retry list below, so the whole operation fails
 * on the first attempt. Worse, the abort is CLIENT-side: on 2026-08-23 a generation pushed 8 files that
 * GitHub accepted (commits 4100128f + d006ac78) and then failed 9s later recording 0 items, leaving the
 * data repo and the platform database silently divergent.
 *
 * isomorphic-git is pure JavaScript (inflate / SHA-1 / packfile indexing run on the main thread), so a
 * busy event loop or a receive-pack that thinks for >5s trips the timer. Supplying our own agent with a
 * realistic ceiling removes the trap. Keep this FINITE - 0 would let a genuinely dead socket hang.
 */
const GIT_HTTP_TIMEOUT_MS = Number(process.env.GIT_HTTP_TIMEOUT_MS ?? 300_000);

const gitHttpAgent = new HttpAgent({ keepAlive: true, timeout: GIT_HTTP_TIMEOUT_MS });
const gitHttpsAgent = new HttpsAgent({ keepAlive: true, timeout: GIT_HTTP_TIMEOUT_MS });

/**
 * Drop-in replacement for the raw `isomorphic-git/http/node` client that injects the agents above.
 * Exported so tests can exercise it directly against a deliberately slow server.
 */
export const http = {
	request: (request: Parameters<typeof nodeHttp.request>[0]) =>
		nodeHttp.request({
			...request,
			agent:
				(request as { agent?: unknown }).agent ??
				(String(request.url).startsWith('https:') ? gitHttpsAgent : gitHttpAgent)
		} as Parameters<typeof nodeHttp.request>[0])
};

const DEFAULT_BRANCHES = ['main', 'master'] as const;

function slugifyText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

/**
 * Prefix of every directory this class generates, separating new working copies from the ones the
 * lossy `slugifyText(`${owner}-${repo}`)` key produced. Bumping the version is how a future key
 * change stays additive: old directories are still readable, never rewritten.
 */
export const CHECKOUT_DIR_PREFIX = 'v2';

/** Readable slug kept from each part of the identity, so directories stay human-identifiable. */
export const CHECKOUT_DIR_SLUG_MAX_LENGTH = 40;

/**
 * Ceiling for one generated path component. Filesystems allow 255 (bytes on POSIX, UTF-16 units on
 * Windows) and every component this module generates is far below it; the constant exists so a
 * future change to the readable suffix cannot silently exceed it.
 */
export const CHECKOUT_DIR_NAME_MAX_LENGTH = 255;

/**
 * Checkout keys are caller-supplied and land in a path, so the shape is fixed rather than
 * sanitised: lowercase letters, digits, `:`, `_` and `-`, starting with a letter or digit.
 * `work:<workId>:<role>` is the convention.
 */
const CHECKOUT_KEY_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/;

/**
 * A repository that was expected to exist does not (or is empty), and the caller asked not to be
 * given an empty local repository instead.
 *
 * Thrown by `cloneOrPull` when `expectExisting: true` and the clone failed because the remote is
 * missing/empty. Without that flag the lenient `git init` fallback still runs.
 */
export class RepositoryNotReadyError extends Error {
	readonly code = 'repository_not_ready';

	constructor(
		readonly owner: string,
		readonly repo: string,
		options?: { cause?: unknown }
	) {
		super(
			`Repository ${owner}/${repo} does not exist or is empty. ` +
				'Refusing to initialise an empty local repository: the remote must be readable before this operation.'
		);
		this.name = 'RepositoryNotReadyError';
		if (options && 'cause' in options) {
			(this as Error & { cause?: unknown }).cause = options.cause;
		}
	}
}

/** Short, deterministic, case-sensitive digest — the exactness half of a checkout directory name. */
function shortDigest(input: string): string {
	return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/** Readable, filesystem-safe half of a checkout directory name. Empty for all-symbol input. */
function slugPart(text: string, maxLength: number = CHECKOUT_DIR_SLUG_MAX_LENGTH): string {
	const slug = slugifyText(text);
	if (slug.length <= maxLength) {
		return slug;
	}
	// Truncating may leave a trailing separator; drop it so no component ever ends in `-`.
	return slug.slice(0, maxLength).replace(/-+$/, '');
}

function assertValidCheckoutKey(checkoutKey: string): void {
	if (!CHECKOUT_KEY_PATTERN.test(checkoutKey)) {
		throw new Error(
			`Invalid checkout key ${JSON.stringify(checkoutKey)}: expected ${CHECKOUT_KEY_PATTERN} ` +
				"(lowercase letters, digits, ':', '_' and '-', up to 128 characters)"
		);
	}
}

/**
 * Directory NAME (one path component, relative to a base directory) for a working copy.
 *
 * Pure and deterministic, and exact: the name is a digest of the provider-visible identity plus a
 * readable slug of it. That matters because the previous key — `slugifyText(`${owner}-${repo}`)` —
 * was lossy AND case-insensitive, so two different repositories could resolve to ONE directory and
 * share branch/commit state.
 *
 * - **Unique per provider + owner + repo.** The digest covers `cloneUrl`, which each provider
 *   plugin builds from its own host, so `gitlab.com`'s `a/b` can never collide with `github.com`'s.
 * - **Case-preserving.** `Owner/Repo` and `owner/repo` hash differently, and GitHub treats them as
 *   different principals.
 * - **Filesystem-safe.** Only `[a-z0-9-]` and hex survive; no separator, colon, `..`, leading dot or
 *   trailing dot/space can be produced, whatever the input.
 * - **Bounded.** Well under `CHECKOUT_DIR_NAME_MAX_LENGTH` for any input length.
 * - **Readable.** The slug suffix keeps the owner/repository recognisable in logs.
 */
export function checkoutDirectoryName(cloneUrl: string, owner: string, repo: string, checkoutKey?: string): string {
	if (checkoutKey !== undefined) {
		assertValidCheckoutKey(checkoutKey);
		return `${CHECKOUT_DIR_PREFIX}/k/${shortDigest(checkoutKey)}-${slugPart(checkoutKey)}`;
	}

	// `cloneUrl` carries the provider host, owner and repository name byte-for-byte — the exact
	// identity, not a normalized approximation of it.
	const identity = `${cloneUrl}\u0000${owner}\u0000${repo}`;

	return `${CHECKOUT_DIR_PREFIX}/r/${shortDigest(identity)}-${slugPart(owner)}--${slugPart(repo)}`;
}

export interface GitOperationsConfig {
	readonly baseDir?: string;
	readonly defaultCommitter?: GitCommitter;
}

export class GitOperations implements IGitOperations {
	private readonly baseDir: string;
	private readonly defaultCommitter: GitCommitter;

	constructor(
		private readonly getAuth: (token: string) => GitAuth,
		private readonly getCloneUrl: (owner: string, repo: string) => string,
		config?: GitOperationsConfig
	) {
		this.baseDir = config?.baseDir ?? path.join(os.tmpdir(), 'ever-works-repos');
		this.defaultCommitter = config?.defaultCommitter ?? {
			name: 'Ever Works Bot',
			email: 'bot@ever.works'
		};
	}

	async cloneOrPull(options: GitCloneOptions): Promise<string> {
		const {
			owner,
			repo,
			token,
			committer,
			autoSwitchToMainBranch = true,
			branch,
			checkoutKey,
			expectExisting
		} = options;
		const dir = this.getLocalDir(owner, repo, checkoutKey);
		const url = this.getCloneUrl(owner, repo);
		const auth = this.getAuth(token);

		if (autoSwitchToMainBranch) {
			await this.switchToMainBranch(dir).catch(() => null);
		}

		if (await this.workExists(dir)) {
			try {
				// Re-assert `origin` before pulling. `pull` and `push` send the
				// credentials to whatever `origin` points at in `.git/config`, and a
				// persistent checkout's config is a file anything writing into the
				// checkout can change. Pinning it to the URL computed here — the one
				// this method would clone from — means a rewritten `origin` is put
				// back before any credential is used, and a checkout poisoned earlier
				// is healed on its next use. Inside the `try` on purpose: if it cannot
				// be reset, the directory is dropped and cloned fresh rather than
				// pulled from a remote nobody chose.
				await git.setConfig({ fs, dir, path: 'remote.origin.url', value: url });
				await this.pull(dir, token, committer);
				return dir;
			} catch {
				await this.removeDirSafe(dir);
			}
		}

		await fs.promises.mkdir(dir, { recursive: true });

		try {
			await git.clone({
				onAuth: () => auth,
				fs,
				http,
				dir,
				url,
				ref: branch,
				singleBranch: true
			});
		} catch (error: unknown) {
			if (this.isMissingRemoteError(error)) {
				if (expectExisting === true) {
					// A repository was expected here. The lenient path below would produce an
					// empty local repository that LOOKS successful, and the platform would then
					// commit into nothing — so drop the directory we just made and report the
					// repository instead of inventing one.
					await this.removeDirSafe(dir);
					throw new RepositoryNotReadyError(owner, repo, { cause: error });
				}

				await git.init({ fs, dir, defaultBranch: branch || 'main' });
				await git.addRemote({ fs, dir, remote: 'origin', url });
			} else {
				throw error;
			}
		}

		return dir;
	}

	async pull(dir: string, token: string, committer?: GitCommitter): Promise<void> {
		const auth = this.getAuth(token);
		const resolvedCommitter = this.mergeCommitter(committer);

		await git.pull({
			onAuth: () => auth,
			fs,
			http,
			dir,
			author: resolvedCommitter,
			singleBranch: true
		});
	}

	async add(dir: string, paths: string | string[]): Promise<void> {
		await git.add({
			fs,
			filepath: paths,
			dir
		});
	}

	async addAll(dir: string): Promise<void> {
		const statusMatrix = await git.statusMatrix({ fs, dir });

		for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
			if (headStatus === 1 && workdirStatus === 0) {
				await git.remove({ fs, dir, filepath });
			} else if (workdirStatus !== 0 && (headStatus !== workdirStatus || stageStatus !== workdirStatus)) {
				await git.add({ fs, dir, filepath });
			}
		}
	}

	async commit(dir: string, message: string, committer?: GitCommitter): Promise<string | null> {
		// Skip commit when there are no staged changes to avoid empty commits
		// that cause "unpack" errors on push
		const statusMatrix = await git.statusMatrix({ fs, dir });
		const hasStagedChanges = statusMatrix.some(([, headStatus, , stageStatus]) => headStatus !== stageStatus);
		if (!hasStagedChanges) {
			return null;
		}

		const resolvedCommitter = this.mergeCommitter(committer);

		return git.commit({
			fs,
			message,
			committer: resolvedCommitter,
			author: resolvedCommitter,
			dir
		});
	}

	async push(options: GitPushOptions): Promise<void> {
		const { dir, token, force = false, maxRetries = 3, ref, remoteRef } = options;

		if (!token) {
			throw new Error('Git token is required for push operation');
		}

		const auth = this.getAuth(token);
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// `ref`/`remoteRef` are forwarded as-is: leaving them undefined
				// keeps isomorphic-git's existing defaults (current branch →
				// its tracking branch), so callers that don't pass them are
				// unaffected.
				await git.push({
					onAuth: () => auth,
					fs,
					http,
					dir,
					ref,
					remoteRef,
					force
				});
				return;
			} catch (error: unknown) {
				const err = error as Error;
				lastError = err;
				const errorMessage = err?.message || '';

				// Empty unpack response means nothing to push (local and remote are in sync)
				if (errorMessage.includes('Expected "unpack ok"') && errorMessage.includes('but received ""')) {
					return;
				}

				const isRetryable =
					errorMessage.includes('cannot lock ref') ||
					errorMessage.includes('failed to lock') ||
					errorMessage.includes('ETIMEDOUT') ||
					errorMessage.includes('ECONNRESET') ||
					// Defence in depth for the agent-timeout trap documented above: simple-get rejects with the
					// lower-case literal 'Request timed out', which none of the codes above match.
					errorMessage.toLowerCase().includes('timed out');

				if (!isRetryable || attempt === maxRetries) {
					throw error;
				}

				await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
			}
		}

		throw lastError;
	}

	async getCurrentBranch(dir: string): Promise<string | null> {
		try {
			return (await git.currentBranch({ fs, dir })) ?? null;
		} catch {
			return null;
		}
	}

	async getMainBranch(dir: string): Promise<string | null> {
		try {
			const branches = await git.listBranches({ fs, dir });

			for (const defaultBranch of DEFAULT_BRANCHES) {
				if (branches.includes(defaultBranch)) {
					return defaultBranch;
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	async switchBranch(dir: string, branch: string, create: boolean = false): Promise<string> {
		const branches = await git.listBranches({ fs, dir });

		if (branches.includes(branch)) {
			await git.checkout({ fs, dir, ref: branch });
			return branch;
		}

		if (create) {
			await git.branch({ fs, dir, ref: branch });
			await git.checkout({ fs, dir, ref: branch });
			return branch;
		}

		throw new Error(`Branch ${branch} doesn't exist`);
	}

	async getStatus(dir: string): Promise<GitFileChange[]> {
		const statusMatrix = await git.statusMatrix({ fs, dir });
		const changes: GitFileChange[] = [];

		for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
			let status: GitFileStatus | null = null;

			if (headStatus === 0 && workdirStatus === 2) {
				status = 'added';
			} else if (headStatus === 1 && workdirStatus === 0) {
				status = 'deleted';
			} else if (headStatus === 1 && workdirStatus === 2) {
				status = 'modified';
			} else if (headStatus === 0 && workdirStatus === 0 && stageStatus === 0) {
				status = 'untracked';
			}

			if (status) {
				changes.push({ path: filepath, status });
			}
		}

		return changes;
	}

	/**
	 * Working copy directory for `owner/repo` (or for `checkoutKey` inside it).
	 *
	 * The primary directory is a pure function of the provider identity, owner and repository — no
	 * two coordinates can share it. When a checkout exists only under the pre-`v2` key, that one is
	 * returned instead: the compatibility path is deliberately additive, so a working copy that
	 * already exists is reused rather than orphaned. The new key wins as soon as it exists.
	 */
	getLocalDir(owner: string, repo: string, checkoutKey?: string): string {
		const primary = path.join(
			this.baseDir,
			checkoutDirectoryName(this.getCloneUrl(owner, repo), owner, repo, checkoutKey)
		);

		// Keys are new by construction — nothing was ever written under one.
		if (checkoutKey !== undefined) {
			return primary;
		}

		if (this.existsSync(primary)) {
			return primary;
		}

		const legacy = this.legacyLocalDir(owner, repo);
		if (legacy && this.existsSync(legacy)) {
			return legacy;
		}

		return primary;
	}

	async removeLocalDir(owner: string, repo: string, checkoutKey?: string): Promise<void> {
		// Removes exactly the directory this repository is using — the resolved one. It never
		// sweeps old-scheme checkouts on the caller's behalf, and never touches another
		// repository's working copy.
		await this.removeDirSafe(this.getLocalDir(owner, repo, checkoutKey));
	}

	async cloneBranch(params: GitCloneBranchOptions): Promise<string> {
		const { owner, repo, branch, token } = params;
		const url = this.getCloneUrl(owner, repo);
		const auth = this.getAuth(token);

		// Security: slugify the attacker-controlled repo/branch before using them in a
		// filesystem path. Without this, a branch name containing `../` sequences would
		// escape baseDir via path.join normalization (path traversal). The numeric
		// Date.now() suffix preserves directory uniqueness for legitimate inputs.
		const uniqueName = `${slugifyText(`${repo}-${branch}`)}-${Date.now()}`;
		const dir = path.join(this.baseDir, uniqueName);

		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
		await fs.promises.mkdir(dir, { recursive: true });

		await git.clone({
			fs,
			http,
			dir,
			url,
			ref: branch,
			singleBranch: true,
			onAuth: () => auth
		});

		return dir;
	}

	async renameBranch(dir: string, oldName: string, newName: string): Promise<void> {
		const branches = await git.listBranches({ fs, dir });

		if (!branches.includes(oldName)) {
			throw new Error(`Branch '${oldName}' does not exist`);
		}

		if (branches.includes(newName)) {
			if (oldName !== newName) {
				await git.checkout({ fs, dir, ref: newName });
				await git.deleteBranch({ fs, dir, ref: oldName });
			}
			return;
		}

		const commitSha = await git.resolveRef({ fs, dir, ref: oldName });
		await git.branch({ fs, dir, ref: newName, object: commitSha });
		await git.checkout({ fs, dir, ref: newName });
		await git.deleteBranch({ fs, dir, ref: oldName });
	}

	async createAndSwitchToRandomBranch(dir: string, prefix: string = 'feature'): Promise<string> {
		const existingBranches = await git.listBranches({ fs, dir });

		let branchName: string;
		let attempts = 0;
		const maxAttempts = 10;

		do {
			const timestamp = Date.now();
			const randomSuffix = Math.random().toString(36).substring(2, 8);
			branchName = `${prefix}-${timestamp}-${randomSuffix}`;
			attempts++;

			if (attempts >= maxAttempts) {
				throw new Error(`Failed to generate unique branch name after ${maxAttempts} attempts`);
			}
		} while (existingBranches.includes(branchName));

		await git.branch({ fs, dir, ref: branchName });
		await git.checkout({ fs, dir, ref: branchName });

		return branchName;
	}

	async remoteRemove(dir: string, remote: string): Promise<void> {
		await git.deleteRemote({ fs, dir, remote });
	}

	async remoteAdd(dir: string, remote: string, url: string): Promise<void> {
		await git.addRemote({ fs, dir, remote, url });
	}

	async replaceRemote(dir: string, remote: string, url: string): Promise<void> {
		try {
			await this.remoteRemove(dir, remote);
		} catch {
			// Remote might not exist
		}
		await this.remoteAdd(dir, remote, url);
	}

	async fetch(dir: string, token: string, remote: string = 'origin'): Promise<void> {
		const auth = this.getAuth(token);
		await git.fetch({
			onAuth: () => auth,
			fs,
			http,
			dir,
			remote
		});
	}

	async merge(dir: string, ours: string, theirs: string, committer?: GitCommitter): Promise<string> {
		const resolvedCommitter = this.mergeCommitter(committer);

		const result = await git.merge({
			fs,
			dir,
			ours,
			theirs,
			author: resolvedCommitter,
			committer: resolvedCommitter
		});

		return result.oid ?? '';
	}

	private mergeCommitter(committer?: GitCommitter): GitCommitter {
		return {
			name: committer?.name || this.defaultCommitter.name,
			email: committer?.email || this.defaultCommitter.email
		};
	}

	private async workExists(dir: string): Promise<boolean> {
		try {
			const stat = await fs.promises.stat(dir);
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * The pre-`v2` checkout directory for `owner/repo`, or `null` when the lossy key has nothing to
	 * point at. `slugifyText` collapses every non-alphanumeric run, so an all-symbol owner/repo
	 * yields the EMPTY string — and `path.join(baseDir, '')` is `baseDir` itself, which must never
	 * be handed back as one repository's checkout (nor removed as one).
	 */
	private legacyLocalDir(owner: string, repo: string): string | null {
		const name = slugifyText(`${owner}-${repo}`);

		if (!name || name === '.' || name === '..') {
			return null;
		}

		return path.join(this.baseDir, name);
	}

	private existsSync(dir: string): boolean {
		try {
			return fs.statSync(dir).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * True when the clone failed because the REMOTE is missing or empty — the only case the
	 * `git init` fallback is meant to absorb.
	 */
	private isMissingRemoteError(error: unknown): boolean {
		const err = error as { code?: string; message?: string };

		return (
			err?.code === 'NotFoundError' ||
			Boolean(err?.message?.includes('Could not find')) ||
			Boolean(err?.message?.includes('empty'))
		);
	}

	private async removeDirSafe(dir: string): Promise<void> {
		const attempts = 3;
		for (let i = 0; i < attempts; i++) {
			try {
				await fs.promises.rm(dir, { recursive: true, force: true });
				return;
			} catch (error: unknown) {
				const err = error as { code?: string };
				if (err?.code === 'ENOTEMPTY') {
					await fs.promises.rm(path.join(dir, '.git'), { recursive: true, force: true }).catch(() => null);
					await new Promise((resolve) => setTimeout(resolve, 50));
					continue;
				}
				throw error;
			}
		}
	}

	private async switchToMainBranch(dir: string): Promise<string | null> {
		const currentBranch = await git.currentBranch({ fs, dir });

		if (currentBranch && DEFAULT_BRANCHES.includes(currentBranch as (typeof DEFAULT_BRANCHES)[number])) {
			return currentBranch;
		}

		const branches = await git.listBranches({ fs, dir });

		for (const defaultBranch of DEFAULT_BRANCHES) {
			if (branches.includes(defaultBranch)) {
				await git.checkout({ fs, dir, ref: defaultBranch });
				return defaultBranch;
			}
		}

		return null;
	}
}
