import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
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
		const { owner, repo, token, committer, autoSwitchToMainBranch = true, branch } = options;
		const dir = this.getLocalDir(owner, repo);
		const url = this.getCloneUrl(owner, repo);
		const auth = this.getAuth(token);

		if (autoSwitchToMainBranch) {
			await this.switchToMainBranch(dir).catch(() => null);
		}

		if (await this.workExists(dir)) {
			try {
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
			const err = error as { code?: string; message?: string };
			if (
				err?.code === 'NotFoundError' ||
				err?.message?.includes('Could not find') ||
				err?.message?.includes('empty')
			) {
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

	getLocalDir(owner: string, repo: string): string {
		return path.join(this.baseDir, slugifyText(`${owner}-${repo}`));
	}

	async removeLocalDir(owner: string, repo: string): Promise<void> {
		await this.removeDirSafe(this.getLocalDir(owner, repo));
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
