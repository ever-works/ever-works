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
		// IMPORTANT: do NOT return raw.githubusercontent.com here. That host
		// returns 404 (no token, no auth) for private repos, which is the
		// recommended setup for landing-page uploads. Callers should
		// stream through the API's owner-scoped `GET /api/uploads/:owner/:filename`
		// route, which delegates back to this plugin's `getObject(key)` over
		// the authenticated GitHub Contents API.
		// For public repos the operator can override via `cfg.publicRawUrl`
		// (env: `GITHUB_STORAGE_PUBLIC_URL_BASE`); see config().
		const url = cfg.publicRawUrl
			? `${cfg.publicRawUrl.replace(/\/$/, '')}/${repoPath}`
			: `/api/uploads/${owner}/${hash}${ext}`;
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
		// Optional public URL base for cases where the configured repo IS
		// public and operators want raw.githubusercontent.com URLs (or a
		// CDN in front of it). When unset, putObject returns an internal
		// API-routed URL; getObject streams the blob via the GitHub Contents
		// API regardless, so private-repo + no-public-url is still correct.
		const publicRawUrl = process.env.GITHUB_STORAGE_PUBLIC_URL_BASE || undefined;
		if (!token || !owner || !repo) {
			throw new Error(
				'github-storage plugin not configured: GITHUB_STORAGE_TOKEN / GITHUB_STORAGE_OWNER / GITHUB_STORAGE_REPO required'
			);
		}
		return { token, owner, repo, branch, pathPrefix, publicRawUrl };
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
	/**
	 * Optional public URL base for the repo's raw content (e.g.
	 * `https://raw.githubusercontent.com/foo/bar/main`). When set,
	 * `putObject` returns `${publicRawUrl}/${repoPath}`. When unset
	 * (the recommended setup for private repos), `putObject` returns
	 * an internal API-routed URL — `getObject` always reads through
	 * the authenticated Contents API.
	 */
	publicRawUrl?: string;
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
