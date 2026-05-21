import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { Octokit, RequestError } from 'octokit';
import type {
	IStoragePlugin,
	StoragePutInput,
	StoragePutResult,
	StorageGetResult,
	IPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema
} from '@ever-works/plugin';

/**
 * EW-637 — GitHub-blob storage backend.
 *
 * Writes each uploaded object as a file in a configured repository via
 * `PUT /repos/{owner}/{repo}/contents/{path}` (the same endpoint the
 * existing `@ever-works/github-plugin` uses for repo edits). Reads come
 * back through the matching `GET` endpoint.
 *
 * Use case: low-traffic deployments that already have a GitHub PAT (e.g.
 * the operator's "Ever Works Customers" org) and don't want to run a
 * separate object store. NOT recommended for high-volume uploads — every
 * write creates a git commit.
 *
 * Runtime gate: the plugin is "available" only when the four required
 * env vars (`GITHUB_STORAGE_TOKEN`, `GITHUB_STORAGE_OWNER`,
 * `GITHUB_STORAGE_REPO`, plus optional `GITHUB_STORAGE_BRANCH` /
 * `GITHUB_STORAGE_PATH_PREFIX`) are set. The uploads service should
 * check `isAvailable()` at boot and refuse to use this backend if it
 * returns false (rather than crashing on the first write).
 *
 * No `presignPut` — there's no way to mint a direct-upload URL into a
 * GitHub repo, the API has to mediate.
 */
export class GitHubStoragePlugin implements IPlugin, IStoragePlugin {
	readonly id = 'github-storage';
	readonly name = 'GitHub Storage';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'storage';
	readonly capabilities: readonly string[] = ['storage', 'put-object', 'get-object'];

	readonly providerName = 'github-storage';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			token: {
				type: 'string',
				title: 'Token',
				description: 'GitHub PAT with `contents:write` scope on the storage repo.',
				'x-secret': true,
				'x-envVar': 'GITHUB_STORAGE_TOKEN'
			},
			owner: {
				type: 'string',
				title: 'Owner',
				description: 'GitHub user or org that owns the storage repo.',
				'x-envVar': 'GITHUB_STORAGE_OWNER'
			},
			repo: {
				type: 'string',
				title: 'Repository',
				description: 'Storage repository name.',
				'x-envVar': 'GITHUB_STORAGE_REPO'
			},
			branch: {
				type: 'string',
				title: 'Branch',
				description: 'Branch to commit blobs to.',
				default: 'main',
				'x-envVar': 'GITHUB_STORAGE_BRANCH'
			},
			pathPrefix: {
				type: 'string',
				title: 'Path Prefix',
				description: 'Prefix prepended to every blob path (default `uploads`).',
				default: 'uploads',
				'x-envVar': 'GITHUB_STORAGE_PATH_PREFIX'
			}
		},
		required: ['token', 'owner', 'repo']
	};

	private context?: PluginContext;

	async putObject(input: StoragePutInput): Promise<StoragePutResult> {
		const cfg = this.config();
		const octokit = this.client(cfg);

		const hash = createHash('sha256').update(input.buffer).digest('hex');
		const ext = sanitizeExt(input.filename);
		const owner = sanitizeOwner(input.ownerId);
		const repoPath = `${cfg.pathPrefix}/${owner}/${hash}${ext}`;
		const content = input.buffer.toString('base64');

		// PUT /repos/{owner}/{repo}/contents/{path} — creates or updates.
		// If the same hash is uploaded twice (idempotent put), we look up
		// the existing SHA so the second commit doesn't 409.
		let existingSha: string | undefined;
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner: cfg.owner,
				repo: cfg.repo,
				path: repoPath,
				ref: cfg.branch
			});
			if (!Array.isArray(data) && data.type === 'file') {
				existingSha = data.sha;
			}
		} catch (err) {
			if (!(err instanceof RequestError) || err.status !== 404) {
				throw err;
			}
		}

		await octokit.rest.repos.createOrUpdateFileContents({
			owner: cfg.owner,
			repo: cfg.repo,
			path: repoPath,
			message: `upload(${owner}): ${hash}${ext}`,
			content,
			branch: cfg.branch,
			...(existingSha ? { sha: existingSha } : {})
		});

		const key = repoPath;
		// Always return the owner-gated API route. `UploadsService.saveImage`
		// rewrites this to the same shape anyway (Codex P1 fix in PR #894),
		// so the plugin no longer tries to hand back a public CDN URL.
		// Public-repo operators who want raw URLs can read the storage key
		// off the upload response and build their own URL — there is no
		// internal consumer for the old `publicRawUrl` path.
		const url = `/api/uploads/${owner}/${hash}${ext}`;
		return { key, url };
	}

	async getObject(key: string): Promise<StorageGetResult> {
		const cfg = this.config();
		const octokit = this.client(cfg);
		const { data } = await octokit.rest.repos.getContent({
			owner: cfg.owner,
			repo: cfg.repo,
			path: key,
			ref: cfg.branch
		});
		if (Array.isArray(data) || data.type !== 'file') {
			throw new Error(`GitHub storage key is not a file: ${key}`);
		}
		// `content` is base64, possibly with newlines depending on the endpoint.
		const buffer = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
		return { buffer, mimeType: guessMime(key) };
	}

	async deleteObject(key: string): Promise<void> {
		const cfg = this.config();
		const octokit = this.client(cfg);
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner: cfg.owner,
				repo: cfg.repo,
				path: key,
				ref: cfg.branch
			});
			if (Array.isArray(data) || data.type !== 'file') return;
			await octokit.rest.repos.deleteFile({
				owner: cfg.owner,
				repo: cfg.repo,
				path: key,
				message: `delete-upload: ${key}`,
				sha: data.sha,
				branch: cfg.branch
			});
		} catch (err) {
			// Idempotent delete — 404 is fine.
			if (err instanceof RequestError && err.status === 404) return;
			throw err;
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			const cfg = this.config();
			const octokit = this.client(cfg);
			await octokit.rest.repos.get({ owner: cfg.owner, repo: cfg.repo });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * GitHub-storage keys are `<pathPrefix>/<ownerId>/<filename>`. The
	 * pathPrefix is config-controlled (default `uploads`), so even the
	 * "bare" case still differs from the legacy `<ownerId>/<filename>`
	 * shape used by local-fs. Implementing this lets the owner-gated
	 * read route reach the right path on the GitHub Contents API
	 * regardless of how the operator configured the prefix
	 * (Codex P1 finding on PR #890).
	 */
	deriveKey(ownerId: string, filename: string): string {
		const cfg = this.config();
		return `${cfg.pathPrefix}/${ownerId}/${filename}`;
	}

	/**
	 * Delete every file under `<pathPrefix>/<ownerId>/` — called by the
	 * anon cleanup schedule. GitHub Contents API doesn't have a bulk
	 * delete: we list the directory, then iterate `deleteFile` per
	 * entry. Each delete creates a commit, so cleanup of N files takes
	 * N commits — acceptable since this runs once a day off-peak.
	 *
	 * Idempotent: a missing directory returns 0 deletes, errors per
	 * file are logged + counted but don't abort the batch.
	 */
	async deleteAllByOwner(ownerId: string): Promise<{ deleted: number }> {
		const cfg = this.config();
		const octokit = this.client(cfg);
		const ownerPath = `${cfg.pathPrefix}/${sanitizeOwner(ownerId)}`;

		let entries: Array<{ path: string; sha: string; type: string }>;
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner: cfg.owner,
				repo: cfg.repo,
				path: ownerPath,
				ref: cfg.branch
			});
			if (!Array.isArray(data)) {
				// Single file at exactly the owner path — unusual, but treat as the only entry.
				if (data.type === 'file') {
					entries = [{ path: data.path, sha: data.sha, type: 'file' }];
				} else {
					entries = [];
				}
			} else {
				entries = data
					.filter((d): d is typeof d & { sha: string } => typeof d.sha === 'string')
					.map((d) => ({ path: d.path, sha: d.sha, type: d.type }));
			}
		} catch (err) {
			// Missing owner dir → idempotent no-op.
			if (err instanceof RequestError && err.status === 404) {
				return { deleted: 0 };
			}
			throw err;
		}

		let deleted = 0;
		for (const entry of entries) {
			if (entry.type !== 'file') continue;
			try {
				await octokit.rest.repos.deleteFile({
					owner: cfg.owner,
					repo: cfg.repo,
					path: entry.path,
					message: `gc(anon-cleanup): ${entry.path}`,
					sha: entry.sha,
					branch: cfg.branch
				});
				deleted += 1;
			} catch (err) {
				if (err instanceof RequestError && err.status === 404) continue;
				this.context?.logger.warn?.(
					`github-storage deleteAllByOwner: failed to delete ${entry.path}: ${
						err instanceof Error ? err.message : String(err)
					}`
				);
			}
		}
		return { deleted };
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('GitHub storage plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const available = await this.isAvailable();
		return {
			status: available ? 'healthy' : 'unhealthy',
			message: available
				? 'GitHub storage repo reachable'
				: 'GitHub storage not configured or token lacks repo access',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Stores uploaded objects as commits in a GitHub repository.',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: false,
			systemPlugin: false,
			icon: { type: 'lucide', value: 'Github', backgroundColor: '#181717' }
		};
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	private config(): GitHubStorageConfig {
		const token = process.env.GITHUB_STORAGE_TOKEN || '';
		const owner = process.env.GITHUB_STORAGE_OWNER || '';
		const repo = process.env.GITHUB_STORAGE_REPO || '';
		const branch = process.env.GITHUB_STORAGE_BRANCH || 'main';
		const pathPrefix = (process.env.GITHUB_STORAGE_PATH_PREFIX || 'uploads').replace(/(^\/+|\/+$)/g, '');
		if (!token || !owner || !repo) {
			throw new Error(
				'github-storage plugin not configured: GITHUB_STORAGE_TOKEN / GITHUB_STORAGE_OWNER / GITHUB_STORAGE_REPO required'
			);
		}
		return { token, owner, repo, branch, pathPrefix };
	}

	private client(cfg: GitHubStorageConfig): Octokit {
		return new Octokit({ auth: cfg.token });
	}
}

interface GitHubStorageConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	pathPrefix: string;
}

function sanitizeExt(filename: string): string {
	const e = extname(filename || '').toLowerCase();
	if (!/^\.[a-z0-9]{1,8}$/.test(e)) return '';
	return e;
}

function sanitizeOwner(ownerId: string | undefined): string {
	if (!ownerId) return '_shared';
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
		throw new Error('Invalid ownerId for github-storage');
	}
	return ownerId;
}

function guessMime(key: string): string {
	const ext = extname(key).toLowerCase();
	switch (ext) {
		case '.png':
			return 'image/png';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.gif':
			return 'image/gif';
		case '.webp':
			return 'image/webp';
		case '.pdf':
			return 'application/pdf';
		case '.txt':
			return 'text/plain';
		case '.json':
			return 'application/json';
		default:
			return 'application/octet-stream';
	}
}

export default GitHubStoragePlugin;
