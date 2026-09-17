import type { Readable } from 'node:stream';
import type { IPlugin } from '../plugin.interface.js';

/**
 * EW-637 — pluggable object storage.
 *
 * `IStoragePlugin` is the contract every storage backend (local-fs, S3,
 * MinIO, GitHub blob, ...) implements. The API's uploads service depends
 * only on this interface and selects an implementation at boot time from
 * the `STORAGE_BACKEND` env var (default: `local-fs`).
 *
 * Capabilities are declared in the plugin's `everworks.plugin.capabilities`
 * field:
 *   - `put-object` (required) — accepts a buffer + metadata, returns a key + URL
 *   - `get-object` (required) — reads a previously written key
 *   - `presigned-put` (optional) — backend can mint a direct-to-cloud upload
 *     URL the browser uses to skip the API process. S3 / MinIO support
 *     this; local-fs and GitHub-blob do not (the API has to mediate).
 *   - `put-object-stream` (optional, AW-22) — backend accepts a `Readable`
 *     instead of a `Buffer`, so an object larger than memory can be written.
 *     Added for the workspace-backup archive, which may run to gigabytes.
 *   - `get-object-stream` (optional, AW-22) — backend hands back a
 *     `Readable`, so the same object can be served without buffering it.
 *
 * Both streaming capabilities are OPTIONAL and additive: every existing
 * plugin keeps working untouched, and no plugin major version is needed.
 * A consumer that wants them PROBES for the method
 * (`typeof plugin.putObjectStream === 'function'`) rather than checking a
 * backend id — a backend without them is a smaller size ceiling, never a
 * wrong result.
 */
export interface StoragePutInput {
	/** Bytes to write. */
	readonly buffer: Buffer;
	/** Client-supplied filename. NOT used as the storage key — only for
	 *  derived extension / Content-Disposition. The key is opaque. */
	readonly filename: string;
	/** Already-validated MIME type. The uploads service magic-byte-sniffs
	 *  BEFORE handing the buffer here; plugins MUST NOT re-trust the client. */
	readonly mimeType: string;
	/** Byte length, matches `buffer.length`. Passed explicitly so the plugin
	 *  doesn't have to recompute it for backends that want it as metadata. */
	readonly size: number;
	/**
	 * Optional owner identifier (typically the user id, anonymous or real).
	 * Used by user-scoped backends (local-fs path-scopes by ownerId; S3 can
	 * embed it in the key prefix). Plugins SHOULD NOT trust this for
	 * authorization — that lives in the API layer. They use it only to
	 * derive the key prefix for the chosen layout.
	 */
	readonly ownerId?: string;
	/**
	 * Optional Work ID. Backends that resolve their destination per-Work
	 * require this — e.g. `@ever-works/github-storage-plugin` in mode
	 * `data-repo` uses it to look up the Work's data repo coordinates
	 * (`Work.owner`, branch, OAuth token) at upload time. Backends that
	 * don't care (local-fs, aws-s3, minio, github-storage in mode
	 * `separate-repo`) ignore it. Anonymous uploads leave this undefined.
	 * Added in EW-644.
	 */
	readonly workId?: string;
}

/**
 * Result of a successful `putObject`. `key` is the canonical reference the
 * uploads service hands back to clients; `url` is the read URL (either the
 * S3 object URL, the local `/api/uploads/<owner>/<file>` route, or the
 * GitHub `raw.githubusercontent.com` URL — backend's choice).
 */
export interface StoragePutResult {
	readonly key: string;
	readonly url: string;
}

/**
 * Bytes + MIME for a previously written key. The uploads service uses this
 * for the read route. MIME is whatever the plugin can recover (S3 returns
 * it from `Content-Type` metadata; local-fs sniffs again).
 */
export interface StorageGetResult {
	readonly buffer: Buffer;
	readonly mimeType: string;
}

/**
 * Input for the optional `putObjectStream` (AW-22). Same metadata as
 * {@link StoragePutInput}, with the buffer replaced by a stream so the
 * caller never has to hold the object.
 */
export interface StoragePutStreamInput {
	/** Bytes to write, consumed lazily. The plugin owns draining it. */
	readonly stream: Readable;
	/** Client-supplied filename. NOT used as the storage key — only for
	 *  derived extension / Content-Disposition. The key is opaque. */
	readonly filename: string;
	/** Already-validated MIME type. */
	readonly mimeType: string;
	/**
	 * Expected byte length when the caller knows it. Backends that need a
	 * content length up front (some object stores) use it; the rest ignore
	 * it. Absent means "unknown until the stream ends".
	 */
	readonly expectedSize?: number;
	/** Optional owner identifier, used only to derive the key prefix. */
	readonly ownerId?: string;
	/** Optional Work ID, for backends that resolve their destination per-Work. */
	readonly workId?: string;
}

/**
 * Result of the optional `getObjectStream` (AW-22). `size` is present when
 * the backend knows it without reading the object, so a caller can set
 * `Content-Length` before the first byte.
 */
export interface StorageGetStreamResult {
	readonly stream: Readable;
	readonly mimeType: string;
	readonly size?: number;
}

/**
 * Input for `presignPut`. The plugin returns a URL + (for backends that
 * need it — e.g. POST policies) extra fields the browser includes in the
 * multipart form. For pure presigned PUT (S3 v4 signed PUT), `fields` is
 * undefined.
 */
export interface StoragePresignInput {
	readonly filename: string;
	readonly mimeType: string;
	readonly size: number;
	readonly ownerId?: string;
}

export interface StoragePresignResult {
	/** Pre-signed URL the browser uploads to. */
	readonly url: string;
	/** The key the object will be stored under, so the client can echo it
	 *  back to the API when submitting the prompt. */
	readonly key: string;
	/** Optional form fields for POST-policy style presigning. When using
	 *  PUT-style signed URLs (default for S3 SigV4), leave undefined. */
	readonly fields?: Record<string, string>;
	/** ISO-8601 timestamp the URL stops accepting uploads at. */
	readonly expiresAt: string;
}

/**
 * Storage plugin interface — capability `storage`.
 *
 * Concrete implementations live in `packages/plugins/local-fs`,
 * `packages/plugins/aws-s3`, `packages/plugins/minio`, and
 * `packages/plugins/github-storage`.
 */
export interface IStoragePlugin extends IPlugin {
	/** Backend name for facade identification ('local-fs', 'aws-s3', ...). */
	readonly providerName: string;

	/** Write an object. Returns the storage key + a URL the API can hand back. */
	putObject(input: StoragePutInput): Promise<StoragePutResult>;

	/** Read an object by key. Throws if not found. */
	getObject(key: string): Promise<StorageGetResult>;

	/** Delete an object by key. Idempotent — deleting a missing key is a no-op. */
	deleteObject(key: string): Promise<void>;

	/**
	 * Optional: mint a pre-signed upload URL so the browser can stream
	 * bytes directly to the storage backend, skipping the API. S3 / MinIO
	 * implement this; local-fs / GitHub do not.
	 */
	presignPut?(input: StoragePresignInput): Promise<StoragePresignResult>;

	/**
	 * Optional (AW-22, capability `put-object-stream`): write an object from
	 * a stream instead of a buffer, so its size is bounded by the backend
	 * rather than by the process's memory.
	 *
	 * Implementations MUST NOT collect the stream into a buffer — that would
	 * satisfy the signature while defeating the reason it exists. local-fs
	 * pipes to a temporary path and renames; object stores use a multipart
	 * upload. Backends whose write API is not a streaming target (GitHub
	 * blobs) leave this unset, and callers fall back to `putObject` under a
	 * smaller size ceiling.
	 */
	putObjectStream?(input: StoragePutStreamInput): Promise<StoragePutResult>;

	/**
	 * Optional (AW-22, capability `get-object-stream`): read an object back
	 * as a stream, so a large object can be served without buffering it.
	 * Throws if the key is not found, exactly like `getObject`.
	 */
	getObjectStream?(key: string): Promise<StorageGetStreamResult>;

	/**
	 * Reconstruct the plugin's canonical storage key from the legacy
	 * `/api/uploads/:ownerId/:filename` URL shape. Each backend layers
	 * its own path prefix on top of `<ownerId>/<filename>` (`uploads/...`
	 * for S3/MinIO/GitHub; bare `<ownerId>/<filename>` for local-fs), so
	 * the API's read route cannot guess the right key without asking the
	 * plugin. Returns the exact key the plugin would have written for
	 * `putObject({ ownerId, filename })`.
	 *
	 * Plugins that follow the bare `<ownerId>/<filename>` convention
	 * (local-fs) can leave this unset — the uploads service falls back
	 * to that shape — but any backend with a prefix MUST implement it,
	 * otherwise owner-gated reads will 404 for files it successfully
	 * wrote (Codex P1 finding on PR #890).
	 *
	 * EW-644 — the optional third argument is the `workId` the caller
	 * received as a `?workId=` query param on the serve route. Backends
	 * that resolve their destination per-Work (e.g. github-storage in
	 * mode `data-repo`) encode it into the returned key so a subsequent
	 * `getObject`/`deleteObject` can recover the Work's coordinates
	 * without an external lookup. Backends that ignore `workId` (local-fs,
	 * S3, MinIO) just emit the same shape as before.
	 */
	deriveKey?(ownerId: string, filename: string, workId?: string): string;

	/**
	 * Optional: delete every object stored under a given owner. Called
	 * by the `anonymous-user-cleanup` schedule when an anon user TTL
	 * expires — without it, the user row goes away but their uploaded
	 * files leak forever on disk / S3 / GitHub. Implementations should
	 * be idempotent (missing owner directory or empty prefix is a no-op)
	 * and resilient (one failed delete shouldn't abort the rest of the
	 * batch). Returns the number of objects deleted.
	 *
	 * Plugins that can't enumerate by owner cheaply may leave this unset;
	 * the cleanup service then skips storage GC for that backend (logged
	 * once at boot via the plugin manifest, not on every cleanup tick).
	 */
	deleteAllByOwner?(ownerId: string): Promise<{ deleted: number }>;

	/** Whether the backend is healthy / configured. Used by the
	 *  uploads service at startup to fail loudly when the operator
	 *  selected an unconfigured backend. */
	isAvailable(): Promise<boolean>;
}

/**
 * Type guard for storage plugins.
 */
export function isStoragePlugin(plugin: IPlugin): plugin is IStoragePlugin {
	return plugin.capabilities.includes('put-object') && plugin.capabilities.includes('get-object');
}
