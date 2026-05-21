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
import { GitOperations } from '@ever-works/plugin/git';
import { formatPointer, parsePointer, ensureGitattributes, gitattributesLine } from './lfs-pointer.js';
import { lfsBatch, lfsUpload, lfsDownload, type LfsBatchTarget } from './lfs-batch.js';
import type { WorkRepoResolver, ResolvedWorkRepo } from './work-repo-resolver.js';

/**
 * EW-637 + EW-644 — GitHub-blob storage backend with optional Git LFS
 * and per-Work data-repo reuse.
 *
 * Two MODES:
 *
 * - `separate-repo` (default, backwards-compatible): writes uploads to
 *   the operator-configured `owner`/`repo`/`branch`, exactly like the
 *   pre-EW-644 plugin. Settings populated via env vars or via the
 *   dashboard UI using the reused OAuth-backed owner/repo selectors.
 *
 * - `data-repo` (new): writes uploads to the **Work's existing data
 *   repo**, looked up per-upload from the Work ID threaded through
 *   `StoragePutInput.workId`. Requires the API to inject a
 *   `WorkRepoResolver` into the plugin's `PluginContext` at boot
 *   (`storage-backend.factory.ts` does this for the github-storage
 *   backend only).
 *
 * Each mode supports an `lfsEnabled` toggle (default ON for fresh
 * deployments; OFF for already-deployed installs to preserve
 * byte-for-byte commit shape — see migration §8 in the spec).
 *
 * When LFS is enabled the plugin uploads the blob to GitHub's LFS host
 * via the LFS Batch API, then commits a pointer file (and ensures
 * `.gitattributes` covers the path prefix) via the chosen transport.
 *
 * Transport choices for the pointer/blob commit:
 *
 * - `contents-api` — direct Octokit `createOrUpdateFileContents`. Fast,
 *   no working tree. Default for `separate-repo`.
 * - `clone-and-push` — `isomorphic-git` clone + commit + push, the same
 *   path the rest of the platform uses for data-repo writes. Default
 *   for `data-repo` so we match existing platform behaviour.
 *
 * The `git-cli` LFS transport listed in the spec is intentionally
 * deferred — the LFS Batch API path is sufficient for github.com and
 * avoids a runtime dependency on the `git`/`git-lfs` binaries.
 */
export class GitHubStoragePlugin implements IPlugin, IStoragePlugin {
	readonly id = 'github-storage';
	readonly name = 'GitHub Storage';
	readonly version = '1.1.0';
	readonly category: PluginCategory = 'storage';
	readonly capabilities: readonly string[] = ['storage', 'put-object', 'get-object', 'lfs'];

	readonly providerName = 'github-storage';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['separate-repo', 'data-repo'],
				default: 'separate-repo',
				title: 'Storage mode',
				description:
					"Where uploads land. `separate-repo`: dedicated GitHub repo you pick below. `data-repo`: the Work's existing data repo — coordinates resolved per upload from the Work entity.",
				'x-envVar': 'GITHUB_STORAGE_MODE'
			},
			token: {
				type: 'string',
				title: 'Token',
				description:
					'GitHub PAT with `contents:write` scope on the storage repo. Ignored in `data-repo` mode (the Work-owner OAuth token is used).',
				'x-secret': true,
				'x-envVar': 'GITHUB_STORAGE_TOKEN',
				'x-showIf': { field: 'mode', value: 'separate-repo' }
			},
			owner: {
				type: 'string',
				title: 'Owner',
				description: 'GitHub user or org that owns the storage repo.',
				'x-envVar': 'GITHUB_STORAGE_OWNER',
				'x-widget': 'github-owner',
				'x-showIf': { field: 'mode', value: 'separate-repo' }
			},
			repo: {
				type: 'string',
				title: 'Repository',
				description: 'Storage repository name.',
				'x-envVar': 'GITHUB_STORAGE_REPO',
				'x-widget': 'github-repo',
				'x-showIf': { field: 'mode', value: 'separate-repo' }
			},
			branch: {
				type: 'string',
				title: 'Branch',
				description: 'Branch to commit blobs to.',
				default: 'main',
				'x-envVar': 'GITHUB_STORAGE_BRANCH',
				'x-showIf': { field: 'mode', value: 'separate-repo' }
			},
			pathPrefix: {
				type: 'string',
				title: 'Path Prefix',
				description: 'Prefix prepended to every blob path (default `uploads`).',
				default: 'uploads',
				'x-envVar': 'GITHUB_STORAGE_PATH_PREFIX'
			},
			lfsEnabled: {
				type: 'boolean',
				default: true,
				title: 'Enable LFS (Large File Storage)',
				description:
					'When on, uploads are stored as Git LFS objects: the bytes live on GitHub LFS; the tree gets a tiny pointer file. Recommended for any non-tiny binaries.',
				'x-envVar': 'GITHUB_STORAGE_LFS_ENABLED'
			},
			transport: {
				type: 'string',
				enum: ['auto', 'contents-api', 'clone-and-push'],
				default: 'auto',
				title: 'Write transport',
				description:
					'How the pointer or blob is committed. `auto` picks `contents-api` for `separate-repo` and `clone-and-push` for `data-repo`. Override only if you have a specific reason.',
				'x-envVar': 'GITHUB_STORAGE_TRANSPORT'
			}
		},
		required: ['mode']
	};

	private context?: PluginContext;
	private octokitCache = new Map<string, Octokit>();

	async putObject(input: StoragePutInput): Promise<StoragePutResult> {
		const cfg = await this.resolveCfg(input);
		const ownerId = sanitizeOwner(input.ownerId);
		const buffer = input.buffer;
		const hash = createHash('sha256').update(buffer).digest('hex');
		const ext = sanitizeExt(input.filename);
		const path = `${cfg.pathPrefix}/${ownerId}/${hash}${ext}`;

		if (cfg.lfsEnabled) {
			await this.putLfs(cfg, path, buffer, hash, ownerId, ext);
		} else {
			await this.putRaw(cfg, path, buffer, hash, ownerId, ext);
		}

		// EW-644 — in `data-repo` mode, encode the resolved workId in
		// the returned key (and URL query string) so a subsequent
		// `getObject`/`deleteObject` can recover the Work coordinates
		// without an external lookup. `separate-repo` mode keeps the
		// flat `<prefix>/<ownerId>/<file>` key shape for backwards
		// compatibility (Codex P1 finding: reads/deletes round-trip in
		// data-repo mode).
		const isDataRepo = cfg.mode === 'data-repo' && input.workId;
		const key = isDataRepo ? encodeDataRepoKey(input.workId!, path) : path;
		const url = cfg.publicRawUrl
			? `${cfg.publicRawUrl.replace(/\/$/, '')}/${path}`
			: isDataRepo
				? `/api/uploads/${ownerId}/${hash}${ext}?workId=${encodeURIComponent(input.workId!)}`
				: `/api/uploads/${ownerId}/${hash}${ext}`;
		return { key, url };
	}

	async getObject(key: string): Promise<StorageGetResult> {
		// EW-644 — a `dr:<workId>:<path>` key (data-repo mode) carries
		// its workId; resolve the repo via the WorkRepoResolver and
		// fetch from there. Otherwise fall back to the configured
		// `separate-repo` global env vars.
		const dr = decodeDataRepoKey(key);
		const cfg = dr ? await this.cfgForReadFromWork(dr.workId) : this.cfgForRead();
		const actualPath = dr ? dr.path : key;
		const octokit = this.client(cfg.token);
		const { data } = await octokit.rest.repos.getContent({
			owner: cfg.owner,
			repo: cfg.repo,
			path: actualPath,
			ref: cfg.branch
		});
		if (Array.isArray(data) || data.type !== 'file') {
			throw new Error(`GitHub storage key is not a file: ${actualPath}`);
		}
		const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
		const pointer = parsePointer(decoded.toString('utf8'));
		if (pointer) {
			// LFS pointer file — fetch the actual bytes from the LFS host.
			const target: LfsBatchTarget = {
				owner: cfg.owner,
				repo: cfg.repo,
				token: cfg.token,
				hostBase: process.env.GITHUB_STORAGE_API_HOST || undefined
			};
			const batch = await lfsBatch(target, pointer, 'download');
			if (batch.kind === 'error') {
				throw new Error(`LFS batch (download) failed: HTTP ${batch.status}: ${batch.message}`);
			}
			if (batch.kind !== 'action' || !batch.download) {
				throw new Error('LFS batch (download) returned no actionable download URL');
			}
			const dl = await lfsDownload(batch.download);
			if (!dl.ok) {
				throw new Error(`LFS object download failed: HTTP ${dl.status}: ${dl.message}`);
			}
			return { buffer: dl.buffer, mimeType: guessMime(actualPath) };
		}
		return { buffer: decoded, mimeType: guessMime(actualPath) };
	}

	async deleteObject(key: string): Promise<void> {
		const dr = decodeDataRepoKey(key);
		const cfg = dr ? await this.cfgForReadFromWork(dr.workId) : this.cfgForRead();
		const actualPath = dr ? dr.path : key;
		const octokit = this.client(cfg.token);
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner: cfg.owner,
				repo: cfg.repo,
				path: actualPath,
				ref: cfg.branch
			});
			if (Array.isArray(data) || data.type !== 'file') return;
			// Best-effort LFS object purge is not attempted: GitHub's LFS
			// purge endpoint is not in the public API. The pointer commit
			// goes; the underlying LFS object stays referenced by any old
			// commits on the branch. That's the standard `git lfs rm`
			// trade-off — documented in the README.
			await octokit.rest.repos.deleteFile({
				owner: cfg.owner,
				repo: cfg.repo,
				path: actualPath,
				message: `delete-upload: ${actualPath}`,
				sha: data.sha,
				branch: cfg.branch
			});
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) return;
			throw err;
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			const mode = readMode();
			if (mode === 'data-repo') {
				// In data-repo mode, availability is "the resolver is
				// wired up" — we can't probe an actual repo without a
				// Work ID. The resolver's presence implies the API can
				// reach the DB.
				return this.workRepoResolver() !== undefined;
			}
			const cfg = this.cfgForRead();
			const octokit = this.client(cfg.token);
			await octokit.rest.repos.get({ owner: cfg.owner, repo: cfg.repo });
			return true;
		} catch {
			return false;
		}
	}

	deriveKey(ownerId: string, filename: string, workId?: string): string {
		const base = `${readPathPrefix()}/${ownerId}/${filename}`;
		// EW-644 — in data-repo mode the read-side caller is expected to
		// supply the workId (from the `?workId=` query string the serve
		// route propagates). Encode it the same way `putObject` did so
		// `getObject` / `deleteObject` can recover the Work's coordinates.
		if (workId && readMode() === 'data-repo') {
			return encodeDataRepoKey(workId, base);
		}
		return base;
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log(`GitHub storage plugin loaded (mode=${readMode()}, lfs=${readLfsEnabled()})`);
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.octokitCache.clear();
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const available = await this.isAvailable();
		return {
			status: available ? 'healthy' : 'unhealthy',
			message: available
				? 'GitHub storage backend reachable'
				: 'GitHub storage not configured or token lacks repo access',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Stores uploaded objects as commits in a GitHub repository. Supports per-Work data repos and Git LFS.',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: false,
			systemPlugin: false,
			icon: { type: 'lucide', value: 'Github', backgroundColor: '#181717' }
		};
	}

	// ============================================================================
	// Internals
	// ============================================================================

	private async putRaw(
		cfg: ResolvedConfig,
		path: string,
		buffer: Buffer,
		hash: string,
		ownerId: string,
		ext: string
	): Promise<void> {
		const message = `upload(${ownerId}): ${hash}${ext}`;
		await this.commitFile(cfg, path, buffer, message);
	}

	private async putLfs(
		cfg: ResolvedConfig,
		path: string,
		buffer: Buffer,
		hash: string,
		ownerId: string,
		ext: string
	): Promise<void> {
		const target: LfsBatchTarget = {
			owner: cfg.owner,
			repo: cfg.repo,
			token: cfg.token,
			hostBase: process.env.GITHUB_STORAGE_API_HOST || undefined
		};
		const batch = await lfsBatch(target, { oid: hash, size: buffer.length }, 'upload');
		if (batch.kind === 'error') {
			throw new Error(
				`LFS batch (upload) failed: HTTP ${batch.status}: ${batch.message}. ` +
					'Is Git LFS enabled on the target repo?'
			);
		}
		if (batch.kind === 'action' && batch.upload) {
			const up = await lfsUpload(batch.upload, buffer);
			if (!up.ok) {
				throw new Error(`LFS object upload failed: HTTP ${up.status}: ${up.message}`);
			}
		}
		// batch.kind === 'already-exists' → blob already present, skip upload, still commit pointer.

		// EW-644 (Greptile P1 fix): write `.gitattributes` and the pointer
		// file via the SAME transport in a single transaction. The
		// previous flow committed `.gitattributes` via Contents API and
		// the pointer via the configured transport — under
		// `clone-and-push` that produced two commits via two different
		// mechanisms on the same branch, racing each other's HEAD.
		const pointer = formatPointer(hash, buffer.length);
		const message = `upload(${ownerId}): ${hash}${ext} (lfs)`;
		const gitattributesPatch = await this.resolveGitattributesPatch(cfg);
		const files: TransportFile[] = [];
		if (gitattributesPatch) files.push(gitattributesPatch);
		files.push({ path, content: Buffer.from(pointer, 'utf8') });
		await this.commitFiles(cfg, files, message);
	}

	/**
	 * EW-644 — read the repo's current `.gitattributes` and compute the
	 * patch that adds the LFS tracking line for the configured path
	 * prefix, idempotently. Returns `null` when the line is already
	 * present (no .gitattributes commit needed). Separated from the
	 * actual write so we can hand the file shape to whichever transport
	 * is in use — avoids the non-ff race Greptile flagged.
	 */
	private async resolveGitattributesPatch(cfg: ResolvedConfig): Promise<TransportFile | null> {
		const octokit = this.client(cfg.token);
		const path = '.gitattributes';
		let existingContent: string | null = null;
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner: cfg.owner,
				repo: cfg.repo,
				path,
				ref: cfg.branch
			});
			if (!Array.isArray(data) && data.type === 'file') {
				existingContent = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
			}
		} catch (err) {
			if (!(err instanceof RequestError) || err.status !== 404) {
				throw err;
			}
		}
		const updated = ensureGitattributes(existingContent, cfg.pathPrefix);
		if (updated === null) return null;
		return { path, content: Buffer.from(updated, 'utf8') };
	}

	/**
	 * Commit one or more files through the configured transport, in a
	 * single atomic operation. For `clone-and-push` that's one clone +
	 * one commit + one push (avoids the non-ff race Greptile flagged
	 * when LFS adds `.gitattributes` alongside a pointer). For
	 * `contents-api` it's per-file `createOrUpdateFileContents` calls
	 * because the API has no multi-file commit endpoint that surfaces
	 * sha-based optimistic concurrency the way we need — but each
	 * Contents API call IS sha-guarded, so per-file is safe enough.
	 */
	private async commitFiles(cfg: ResolvedConfig, files: TransportFile[], message: string): Promise<void> {
		if (files.length === 0) return;
		const transport = resolveTransport(cfg);
		if (transport === 'clone-and-push') {
			await this.commitViaCloneAndPush(cfg, files, message);
			return;
		}
		await this.commitViaContentsApi(cfg, files, message);
	}

	private async commitFile(cfg: ResolvedConfig, path: string, bytes: Buffer, message: string): Promise<void> {
		await this.commitFiles(cfg, [{ path, content: bytes }], message);
	}

	private async commitViaContentsApi(cfg: ResolvedConfig, files: TransportFile[], message: string): Promise<void> {
		const octokit = this.client(cfg.token);
		// Contents API doesn't expose multi-file commits, so we issue
		// per-file PUTs. Each looks up the current sha first so concurrent
		// writers race correctly (the 422 from a sha mismatch surfaces as
		// an upstream error the caller can retry).
		for (const file of files) {
			let existingSha: string | undefined;
			try {
				const { data } = await octokit.rest.repos.getContent({
					owner: cfg.owner,
					repo: cfg.repo,
					path: file.path,
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
			const fileMessage = file.path === '.gitattributes' ? 'chore(lfs): track uploads via git lfs' : message;
			await octokit.rest.repos.createOrUpdateFileContents({
				owner: cfg.owner,
				repo: cfg.repo,
				path: file.path,
				message: fileMessage,
				content: file.content.toString('base64'),
				branch: cfg.branch,
				...(existingSha ? { sha: existingSha } : {})
			});
		}
	}

	private async commitViaCloneAndPush(cfg: ResolvedConfig, files: TransportFile[], message: string): Promise<void> {
		const ops = this.gitOperations();
		const dir = await ops.cloneOrPull({
			owner: cfg.owner,
			repo: cfg.repo,
			token: cfg.token,
			branch: cfg.branch,
			autoSwitchToMainBranch: false
		});
		const fs = await import('node:fs');
		const nodePath = await import('node:path');
		// EW-644 (Greptile P1 fix) — write every file in the working tree
		// BEFORE staging/committing so a single commit + single push
		// covers .gitattributes + the pointer/blob. Avoids the non-ff
		// race where two sequential pushes hit the same branch.
		for (const file of files) {
			const full = nodePath.join(dir, file.path);
			await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
			await fs.promises.writeFile(full, file.content);
			await ops.add(dir, file.path);
		}
		await ops.commit(dir, message);
		await ops.push({ dir, token: cfg.token });
	}

	private gitOperations(): GitOperations {
		// `clone-and-push` matches the existing platform default for
		// data-repo writes — see packages/plugin/src/git/git-operations.ts.
		return new GitOperations(
			(token: string) => ({ username: 'x-access-token', password: token }),
			(owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`
		);
	}

	private client(token: string): Octokit {
		const existing = this.octokitCache.get(token);
		if (existing) return existing;
		const octokit = new Octokit({ auth: token });
		this.octokitCache.set(token, octokit);
		return octokit;
	}

	private workRepoResolver(): WorkRepoResolver | undefined {
		const ctx = this.context as unknown as { workRepoResolver?: WorkRepoResolver } | undefined;
		return ctx?.workRepoResolver;
	}

	/**
	 * EW-644 — resolve read-side coordinates for a `data-repo` mode
	 * key. The key was minted by `putObject` with `dr:<workId>:<path>`
	 * (or by `deriveKey` with a `workId` arg), so we just look the Work
	 * up via the resolver and use the same credentials the writer used.
	 *
	 * Throws if the resolver isn't wired (misconfigured deployment) or
	 * if the resolver can't satisfy the lookup (e.g. Work deleted since
	 * the upload was written — that's a stable 404 from the caller's
	 * perspective).
	 */
	private async cfgForReadFromWork(workId: string): Promise<ResolvedConfig> {
		const resolver = this.workRepoResolver();
		if (!resolver) {
			throw new Error(
				'github-storage: data-repo key encountered but no WorkRepoResolver is wired into PluginContext.'
			);
		}
		const resolved: ResolvedWorkRepo = await resolver.resolve(workId);
		return {
			mode: 'data-repo',
			lfsEnabled: readLfsEnabled(),
			pathPrefix: readPathPrefix(),
			publicRawUrl: process.env.GITHUB_STORAGE_PUBLIC_URL_BASE || undefined,
			...resolved
		};
	}

	private cfgForRead(): ResolvedConfig {
		const mode = readMode();
		const lfsEnabled = readLfsEnabled();
		const pathPrefix = readPathPrefix();
		const branch = process.env.GITHUB_STORAGE_BRANCH || 'main';
		const owner = process.env.GITHUB_STORAGE_OWNER || '';
		const repo = process.env.GITHUB_STORAGE_REPO || '';
		const token = process.env.GITHUB_STORAGE_TOKEN || '';
		if (!owner || !repo || !token) {
			throw new Error(
				mode === 'data-repo'
					? 'github-storage: cannot read in `data-repo` mode without a workId-aware read path or configured fallback env vars.'
					: 'github-storage plugin not configured: GITHUB_STORAGE_TOKEN / GITHUB_STORAGE_OWNER / GITHUB_STORAGE_REPO required'
			);
		}
		const publicRawUrl = process.env.GITHUB_STORAGE_PUBLIC_URL_BASE || undefined;
		return { mode, lfsEnabled, owner, repo, branch, pathPrefix, token, publicRawUrl };
	}

	private async resolveCfg(input: StoragePutInput): Promise<ResolvedConfig> {
		const mode = readMode();
		const lfsEnabled = readLfsEnabled();
		const pathPrefix = readPathPrefix();
		const publicRawUrl = process.env.GITHUB_STORAGE_PUBLIC_URL_BASE || undefined;
		if (mode === 'data-repo') {
			if (!input.workId) {
				throw new Error(
					"github-storage mode 'data-repo' requires StoragePutInput.workId — anonymous uploads are not supported in this mode."
				);
			}
			const resolver = this.workRepoResolver();
			if (!resolver) {
				throw new Error(
					"github-storage mode 'data-repo' requires a WorkRepoResolver in PluginContext. Wire it up in storage-backend.factory.ts."
				);
			}
			const resolved: ResolvedWorkRepo = await resolver.resolve(input.workId);
			return { mode, lfsEnabled, ...resolved, pathPrefix, publicRawUrl };
		}
		const owner = process.env.GITHUB_STORAGE_OWNER || '';
		const repo = process.env.GITHUB_STORAGE_REPO || '';
		const branch = process.env.GITHUB_STORAGE_BRANCH || 'main';
		const token = process.env.GITHUB_STORAGE_TOKEN || '';
		if (!owner || !repo || !token) {
			throw new Error(
				'github-storage mode `separate-repo` requires GITHUB_STORAGE_TOKEN / GITHUB_STORAGE_OWNER / GITHUB_STORAGE_REPO.'
			);
		}
		return { mode, lfsEnabled, owner, repo, branch, pathPrefix, token, publicRawUrl };
	}
}

interface ResolvedConfig extends ResolvedWorkRepo {
	mode: 'separate-repo' | 'data-repo';
	lfsEnabled: boolean;
	pathPrefix: string;
	publicRawUrl?: string;
}

/** A single file inside a transport-level commit. */
interface TransportFile {
	readonly path: string;
	readonly content: Buffer;
}

function readMode(): 'separate-repo' | 'data-repo' {
	const raw = (process.env.GITHUB_STORAGE_MODE || 'separate-repo').toLowerCase();
	return raw === 'data-repo' ? 'data-repo' : 'separate-repo';
}

function readLfsEnabled(): boolean {
	const raw = process.env.GITHUB_STORAGE_LFS_ENABLED;
	if (raw === undefined) {
		// Backwards-compatibility migration rule (spec §8): if mode is
		// unset AND the legacy env vars are present, treat LFS as OFF so
		// existing deployments keep the same commit shape. Fresh
		// deployments hit the schema default `true` instead.
		const legacy =
			!process.env.GITHUB_STORAGE_MODE && !!process.env.GITHUB_STORAGE_OWNER && !!process.env.GITHUB_STORAGE_REPO;
		return !legacy;
	}
	return /^(1|true|yes|on)$/i.test(raw);
}

function readPathPrefix(): string {
	return (process.env.GITHUB_STORAGE_PATH_PREFIX || 'uploads').replace(/(^\/+|\/+$)/g, '');
}

function resolveTransport(cfg: ResolvedConfig): 'contents-api' | 'clone-and-push' {
	const raw = (process.env.GITHUB_STORAGE_TRANSPORT || 'auto').toLowerCase();
	if (raw === 'contents-api') return 'contents-api';
	if (raw === 'clone-and-push') return 'clone-and-push';
	return cfg.mode === 'data-repo' ? 'clone-and-push' : 'contents-api';
}

/**
 * EW-644 — opaque key encoding for `data-repo` mode.
 *
 * In `data-repo` mode the plugin needs to remember which Work a key
 * belongs to so a later `getObject`/`deleteObject` can resolve the right
 * repo + token via `WorkRepoResolver`. We encode it directly into the
 * storage key as a `dr:<workId>:<path>` prefix.
 *
 * - `<workId>` is a UUID (validated upstream by UploadsService). The
 *   resolver re-validates it via `WorkRepository.findById(...)`.
 * - `<path>` is the same `<pathPrefix>/<ownerId>/<hash><ext>` shape
 *   `separate-repo` mode uses.
 *
 * Why a prefix instead of a side table: keeps the plugin stateless,
 * survives restarts, and round-trips through every storage-key consumer
 * (the API serve route, the read-by-key flow, future GC tasks) with no
 * extra plumbing.
 */
export function encodeDataRepoKey(workId: string, path: string): string {
	return `dr:${workId}:${path}`;
}

export function decodeDataRepoKey(key: string): { workId: string; path: string } | null {
	if (!key.startsWith('dr:')) return null;
	const rest = key.slice(3);
	const sep = rest.indexOf(':');
	if (sep < 0) return null;
	const workId = rest.slice(0, sep);
	const path = rest.slice(sep + 1);
	if (!workId || !path) return null;
	return { workId, path };
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

// Re-export helpers that consumers (and tests) may use.
export { formatPointer, parsePointer, ensureGitattributes, gitattributesLine };
export default GitHubStoragePlugin;
