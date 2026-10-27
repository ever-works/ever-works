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
	GitFileStatus,
	GitFetchBranchOptions,
	GitCommitRangeOptions,
	GitCommitRangeCount
} from '../contracts/capabilities/git-provider.interface.js';
import { countCommitRange } from './commit-range.js';

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

/**
 * How long one stretch of isomorphic-git work may hold the event loop before it is made to hand it back.
 *
 * isomorphic-git (1.37) collects the whole packfile into one buffer and then indexes it — inflating every
 * object, resolving every delta, hashing every result — in loops whose only `await`s resolve at once. Those
 * are microtasks: they never let the event loop reach a timer, a socket or an HTTP request. A clone or pull
 * of a large repository therefore froze the whole process for as long as the indexing took. In the API that
 * meant `/api/health/live` went unanswered and the kubelet killed the pod (see `cloneOrPullRequests` in the
 * agent's git facade), and a workspace backup walking every Work's data repository stopped heartbeating
 * mid-domain and was failed as `stalled`.
 *
 * isomorphic-git `await`s its `onProgress` callback once per percent of the pack and once per file it checks
 * out, so a callback that yields to the macrotask queue breaks those loops into slices. Thirty seconds of
 * indexing becomes ~two hundred short stretches with the event loop running in between; nothing about the
 * git operation itself changes. The fs-backed `await`s these operations already make interleave other work
 * in exactly the same way, so this adds no new kind of interleaving.
 */
const GIT_EVENT_LOOP_SLICE_MS = (() => {
	const configured = Number(process.env.GIT_EVENT_LOOP_SLICE_MS ?? 50);
	return Number.isFinite(configured) && configured >= 0 ? configured : 50;
})();

let lastEventLoopYield = Date.now();

/**
 * The `onProgress` passed to every clone, pull and fetch: hand the event loop back once the current stretch
 * of git work has held it for {@link GIT_EVENT_LOOP_SLICE_MS}, and return at once otherwise.
 *
 * `setImmediate` rather than `setTimeout(0)`: it runs right after the poll phase, so pending I/O — a probe,
 * a heartbeat's query result, another request — is served before the git work resumes, without the 1 ms
 * floor a timer would add to each of the hundreds of calls. Exported so the slicing can be proved directly.
 */
export async function yieldToEventLoop(): Promise<void> {
	if (Date.now() - lastEventLoopYield < GIT_EVENT_LOOP_SLICE_MS) {
		return;
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	lastEventLoopYield = Date.now();
}

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

/**
 * Passed as `corsProxy` on every network call. isomorphic-git reads
 * `http.corsProxy` from the checkout's config when the argument is `undefined`
 * (and only then); an empty string is "no proxy" and skips that read.
 */
const NO_CORS_PROXY = '';

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
				await this.pullFrom(dir, token, url, committer);
				return dir;
			} catch {
				await this.removeDirSafe(dir);
			}
		}

		await fs.promises.mkdir(dir, { recursive: true });

		try {
			await git.clone({
				onAuth: () => auth,
				// Keeps a large pack's indexing from freezing the event loop; see `yieldToEventLoop`.
				onProgress: yieldToEventLoop,
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
		await this.pullFrom(dir, token, await this.remoteUrl(dir, 'origin'), committer);
	}

	private async pullFrom(dir: string, token: string, url: string, committer?: GitCommitter): Promise<void> {
		const auth = this.getAuth(token);
		const resolvedCommitter = this.mergeCommitter(committer);

		await git.pull({
			onAuth: () => auth,
			onProgress: yieldToEventLoop,
			fs,
			http,
			dir,
			author: resolvedCommitter,
			singleBranch: true,
			// See `remoteUrl`: the checkout's config never chooses where this goes.
			remote: 'origin',
			url,
			corsProxy: NO_CORS_PROXY
		});
	}

	/**
	 * The URL a network operation on `dir` sends the credentials to, read from
	 * `remote.<remote>.url` ONLY.
	 *
	 * Left to itself, isomorphic-git (1.37) picks the destination from the
	 * checkout's own config: `remote.origin.pushurl` over `remote.origin.url`
	 * for a push, `branch.<ref>.remote` (another remote entirely) for a pull or
	 * fetch, and `http.corsProxy` — which routes the request, `Authorization`
	 * header included, through another host — for all three. Each was
	 * reproduced against a local stand-in server receiving the token. (Its
	 * internal push also honours `branch.<ref>.pushRemote` and
	 * `remote.pushDefault`, but the public `push` defaults `remote` to
	 * `'origin'` first.) A checkout's config is a file; anything that has written into the
	 * checkout, now or in an earlier run, could have set any of them. Passing
	 * the remote, this URL and an empty proxy explicitly means none of those
	 * keys is ever read. `cloneOrPull` re-asserts `remote.origin.url` itself,
	 * and a push that knows its repository computes the URL instead
	 * (`GitPushOptions.owner`/`repo`).
	 */
	private async remoteUrl(dir: string, remote: string): Promise<string> {
		const url: unknown = await git.getConfig({ fs, dir, path: `remote.${remote}.url` });
		if (typeof url !== 'string' || url.trim().length === 0) {
			throw new Error(`No URL is configured for git remote '${remote}' in ${dir}`);
		}
		return url;
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
		const { dir, token, force = false, maxRetries = 3, ref, remoteRef, owner, repo } = options;

		if (!token) {
			throw new Error('Git token is required for push operation');
		}

		const auth = this.getAuth(token);
		// A caller that names the repository gets the URL this provider computes
		// for it; otherwise `origin`'s URL, and nothing else, from the config.
		const url = owner && repo ? this.getCloneUrl(owner, repo) : await this.remoteUrl(dir, 'origin');
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
					force,
					remote: 'origin',
					url,
					corsProxy: NO_CORS_PROXY
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
			onAuth: () => auth,
			onProgress: yieldToEventLoop
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
			onProgress: yieldToEventLoop,
			fs,
			http,
			dir,
			remote,
			url: await this.remoteUrl(dir, remote),
			corsProxy: NO_CORS_PROXY
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

	// ── APW-02 T48 — the private copy's sync (FR-63) ──────────────────────
	//
	// The read and the move a private copy's upstream sync needs, built so a
	// provider plugin never has to reach for isomorphic-git itself. Every network
	// call names its URL (computed by this provider from the coordinates, never
	// read from the checkout's config), its remote and an empty CORS proxy — see
	// the credential note in the repository's CLAUDE.md.

	/** The remote name `fetchBranch` files a second repository's history under by default. */
	static readonly FETCH_BRANCH_DEFAULT_REMOTE = 'upstream';

	async fetchBranch(options: GitFetchBranchOptions): Promise<string | null> {
		const { dir, owner, repo, branch, token } = options;
		const remote = options.remote || GitOperations.FETCH_BRANCH_DEFAULT_REMOTE;
		if (!token) {
			throw new Error('Git token is required for fetch operation');
		}
		const auth = this.getAuth(token);
		try {
			const result = await git.fetch({
				onAuth: () => auth,
				onProgress: yieldToEventLoop,
				fs,
				http,
				dir,
				remote,
				url: this.getCloneUrl(owner, repo),
				ref: branch,
				remoteRef: branch,
				singleBranch: true,
				tags: false,
				corsProxy: NO_CORS_PROXY
			});
			if (result?.fetchHead) return result.fetchHead;
			return await this.resolveRef(dir, `refs/remotes/${remote}/${branch}`);
		} catch (error: unknown) {
			const err = error as { code?: string };
			// The repository has no such branch: an answer, not a failure.
			if (err?.code === 'NotFoundError') return null;
			throw error;
		}
	}

	async resolveRef(dir: string, ref: string): Promise<string | null> {
		try {
			return await git.resolveRef({ fs, dir, ref });
		} catch (error: unknown) {
			const err = error as { code?: string };
			if (err?.code === 'NotFoundError') return null;
			throw error;
		}
	}

	async hasCommit(dir: string, oid: string): Promise<boolean> {
		if (!/^[0-9a-f]{40}$/i.test(oid)) return false;
		try {
			await git.readCommit({ fs, dir, oid });
			return true;
		} catch (error: unknown) {
			const err = error as { code?: string };
			if (err?.code === 'NotFoundError' || err?.code === 'ObjectTypeError') return false;
			throw error;
		}
	}

	async findMergeBase(dir: string, oids: readonly [string, string]): Promise<string | null> {
		const bases = (await git.findMergeBase({ fs, dir, oids: [...oids] })) as string[];
		return Array.isArray(bases) && bases.length > 0 ? bases[0] : null;
	}

	async countCommitsBetween(dir: string, options: GitCommitRangeOptions): Promise<GitCommitRangeCount> {
		const cache = {};
		return countCommitRange(
			async (oid) => {
				const { commit } = await git.readCommit({ fs, dir, oid, cache });
				return { parents: commit.parent, timestamp: commit.committer?.timestamp ?? 0 };
			},
			options.include,
			options.exclude,
			options.max
		);
	}

	async writeBranchRef(dir: string, branch: string, oid: string): Promise<void> {
		if (!branch || branch.startsWith('refs/') || branch.includes('..')) {
			throw new Error(`Refusing to write the local branch '${branch}'`);
		}
		await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
	}

	async removeWorkingCopy(dir: string): Promise<void> {
		// Only a directory under this instance's base directory — the place
		// `cloneBranch` creates them — and never the base directory itself.
		const base = path.resolve(this.baseDir);
		const target = path.resolve(dir);
		if (target === base || !target.startsWith(base + path.sep)) {
			throw new Error('Refusing to remove a directory outside the working-copy base directory');
		}
		await this.removeDirSafe(target);
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
