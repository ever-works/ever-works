import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, normalize, sep, extname } from 'node:path';
import { tmpdir } from 'node:os';
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
 * EW-637 — Local-filesystem storage backend.
 *
 * Refactored out of `apps/api/src/uploads/uploads.service.ts`. Keeps the
 * exact same on-disk layout (`<UPLOADS_DIR>/<ownerId>/<sha256>.<ext>`),
 * the same path-traversal defenses, and the same `/api/uploads/...` URL
 * shape so existing clients continue to work after the uploads service
 * is switched over to the plugin abstraction.
 *
 * NOTE: MIME validation and magic-byte sniffing live in the API layer
 * (UploadsService) — the plugin trusts the bytes it receives. This keeps
 * the validation logic in one place across all backends.
 */
export class LocalFsStoragePlugin implements IPlugin, IStoragePlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'local-fs';
	readonly name = 'Local Filesystem';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'storage';
	readonly capabilities: readonly string[] = ['storage', 'put-object', 'get-object'];

	readonly providerName = 'local-fs';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			uploadsDir: {
				type: 'string',
				title: 'Uploads Directory',
				description:
					'Absolute path on the API server where objects are written. Defaults to <tmpdir>/ever-works-uploads.',
				'x-envVar': 'UPLOADS_DIR'
			},
			maxBytes: {
				type: 'number',
				title: 'Max Bytes',
				description: 'Per-object size cap in bytes. Default 5242880 (5 MiB).',
				default: 5 * 1024 * 1024,
				'x-envVar': 'UPLOADS_MAX_BYTES'
			}
		}
	};

	private context?: PluginContext;

	// ============================================================================
	// IStoragePlugin
	// ============================================================================

	async putObject(input: StoragePutInput): Promise<StoragePutResult> {
		const ownerId = this.resolveOwnerId(input.ownerId);
		this.assertValidOwnerId(ownerId);

		// Storage key is sha256(buffer) + lowercase extension derived from the
		// client-supplied filename — the filename itself NEVER reaches disk
		// (defeats `../../etc/passwd`-style payloads).
		const hash = createHash('sha256').update(input.buffer).digest('hex');
		const ext = this.extractExt(input.filename);
		const objectName = `${hash}${ext}`;
		const key = `${ownerId}/${objectName}`;

		const userDir = this.ownerDir(ownerId);
		await fs.mkdir(userDir, { recursive: true });
		const absPath = this.resolveSafe(userDir, objectName);
		await fs.writeFile(absPath, input.buffer, { flag: 'w' });

		// URL is served by the API at /api/uploads/:owner/:filename
		const url = `/api/uploads/${encodeURIComponent(ownerId)}/${objectName}`;
		return { key, url };
	}

	async getObject(key: string): Promise<StorageGetResult> {
		const { ownerId, filename } = this.parseKey(key);
		const userDir = this.ownerDir(ownerId);
		const absPath = this.resolveSafe(userDir, filename);

		let buffer: Buffer;
		try {
			buffer = await fs.readFile(absPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				throw new Error(`Upload not found: ${key}`);
			}
			throw err;
		}

		// Recover MIME from extension. The API layer treats this as a hint
		// only — it re-sniffs magic bytes before serving the response.
		return { buffer, mimeType: this.mimeFromExt(filename) };
	}

	async deleteObject(key: string): Promise<void> {
		const { ownerId, filename } = this.parseKey(key);
		const userDir = this.ownerDir(ownerId);
		const absPath = this.resolveSafe(userDir, filename);
		try {
			await fs.unlink(absPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// Idempotent delete — missing is fine.
			if (code === 'ENOENT' || code === 'ENOTDIR') return;
			throw err;
		}
	}

	async isAvailable(): Promise<boolean> {
		// Local FS is always "available" — directories are created lazily.
		// The only failure mode is permissions, which we surface at putObject
		// time so the operator sees the real OS error.
		return true;
	}

	// ============================================================================
	// IPlugin lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log(
			`LocalFs storage plugin loaded; storageRoot=${this.storageRoot()} maxBytes=${this.maxBytes()}`
		);
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		try {
			const root = this.storageRoot();
			await fs.mkdir(root, { recursive: true });
			return { status: 'healthy', message: `Writable at ${root}`, checkedAt: Date.now() };
		} catch (err) {
			return {
				status: 'unhealthy',
				message: `LocalFs storage root not writable: ${err instanceof Error ? err.message : String(err)}`,
				checkedAt: Date.now()
			};
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Default object storage on local disk.',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: true,
			systemPlugin: true,
			visibility: 'hidden',
			defaultForCapabilities: ['storage', 'put-object', 'get-object'],
			icon: { type: 'lucide', value: 'HardDrive', backgroundColor: '#0ea5e9' }
		};
	}

	// ============================================================================
	// Helpers (same defenses as the legacy UploadsService)
	// ============================================================================

	private storageRoot(): string {
		// `UPLOADS_DIR` is an operator-controlled absolute path; default to
		// a per-process tmp dir so dev / CI work out of the box and never
		// collide with another instance.
		return resolve(process.env.UPLOADS_DIR || join(tmpdir(), 'ever-works-uploads'));
	}

	private maxBytes(): number {
		const v = Number(process.env.UPLOADS_MAX_BYTES);
		return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
	}

	private resolveOwnerId(ownerId: string | undefined): string {
		// When no owner is supplied (legacy callers, scripts), bucket under
		// "_shared" so files are still scoped to a directory and don't
		// pollute the storage root.
		return ownerId || '_shared';
	}

	private ownerDir(ownerId: string): string {
		return resolve(this.storageRoot(), ownerId);
	}

	private resolveSafe(ownerDir: string, filename: string): string {
		const candidate = resolve(ownerDir, filename);
		const ownerDirNorm = normalize(ownerDir + sep);
		const candidateNorm = normalize(candidate);
		if (!candidateNorm.startsWith(ownerDirNorm)) {
			throw new Error('Resolved path escapes owner storage root');
		}
		return candidate;
	}

	private assertValidOwnerId(ownerId: string): void {
		if (!ownerId || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
			throw new Error('Invalid ownerId for local-fs storage');
		}
	}

	private parseKey(key: string): { ownerId: string; filename: string } {
		const idx = key.indexOf('/');
		if (idx <= 0 || idx === key.length - 1) {
			throw new Error(`Malformed storage key: ${key}`);
		}
		const ownerId = key.slice(0, idx);
		const filename = key.slice(idx + 1);
		this.assertValidOwnerId(ownerId);
		// Filename must be `<hex>.<ext>` or `<hex>` — same shape `putObject` writes.
		if (!filename || !/^[A-Za-z0-9._-]{1,256}$/.test(filename) || filename.includes('..')) {
			throw new Error(`Malformed filename in storage key: ${filename}`);
		}
		return { ownerId, filename };
	}

	private extractExt(filename: string): string {
		const e = extname(filename || '').toLowerCase();
		// Only allow simple [a-z0-9] extensions; everything else gets dropped
		// to keep the on-disk name strictly hex.ext (no quotes, slashes, etc).
		if (!/^\.[a-z0-9]{1,8}$/.test(e)) return '';
		return e;
	}

	private mimeFromExt(filename: string): string {
		const ext = extname(filename).toLowerCase();
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
}

export default LocalFsStoragePlugin;
