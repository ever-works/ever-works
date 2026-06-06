/**
 * EW-642 — abstract base class for vector-store plugins.
 *
 * Concrete implementations (`@ever-works/pgvector-plugin`,
 * `@ever-works/qdrant-plugin`, …) extend `BaseVectorStore` so they
 * inherit:
 *
 *   - the boilerplate `category = 'vector-store'` + manifest token
 *     `capabilities = ['vector-store']` declaration;
 *   - the `wrapVendorError` helper that converts a backend's native
 *     error into the platform-shaped `VectorStoreError`;
 *   - the default `isAvailable()` returning `true` (subclasses override
 *     when they can run a cheap probe — pgvector pings the connection,
 *     Qdrant hits `GET /collections`, Pinecone hits `describe_index`).
 *
 * Subclasses must implement `normalize(rawScore)` (RFC D6 — every
 * plugin owns its score scale) plus the four core methods.
 *
 * Design rationale: `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md`.
 */

import { BasePlugin } from './base-plugin.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';
import type { PluginLogger } from '../contracts/plugin-context.interface.js';
import type { PluginSettings } from '../settings/settings.types.js';
import type {
	IVectorStorePlugin,
	VectorStoreCapabilities,
	VectorStoreProviderType,
	UpsertChunksInput,
	UpsertChunksResult,
	QueryChunksInput,
	QueryChunksResult,
	DeleteByDocumentInput,
	DeleteByWorkInput
} from '../contracts/capabilities/vector-store.interface.js';

/**
 * Stable error-code taxonomy for vector-store failures. Facades key off
 * `code` for retry / surface decisions; new codes are appended as
 * needed without breaking existing handlers.
 */
export type VectorStoreErrorCode =
	| 'unavailable'
	| 'unauthorized'
	| 'invalid-input'
	| 'not-found'
	| 'conflict'
	| 'rate-limited'
	| 'timeout'
	| 'internal';

/**
 * Error thrown out of `IVectorStorePlugin` methods after vendor errors
 * have been normalized. Carries a stable `code` for callers to branch
 * on plus a `retriable` flag so the facade knows whether to back off
 * and retry vs surface the failure immediately.
 */
export class VectorStoreError extends Error {
	readonly code: VectorStoreErrorCode;
	readonly retriable: boolean;
	readonly cause?: Error;

	constructor(message: string, code: VectorStoreErrorCode, retriable: boolean, cause?: Error) {
		super(message);
		this.name = 'VectorStoreError';
		this.code = code;
		this.retriable = retriable;
		if (cause) {
			this.cause = cause;
		}
	}
}

/**
 * Abstract base class for vector-store plugins. See file header for the
 * contract recap.
 */
export abstract class BaseVectorStore extends BasePlugin implements IVectorStorePlugin {
	readonly category: PluginCategory = 'vector-store';
	readonly capabilities: readonly string[] = ['vector-store'];

	abstract readonly providerType: VectorStoreProviderType;
	abstract readonly providerName: string;
	abstract readonly vectorCapabilities: VectorStoreCapabilities;

	/**
	 * Caller-supplied settings snapshot. Concrete plugins typically
	 * read connection strings + index tuning knobs out of this. The
	 * field is kept `protected` so subclasses can re-resolve on each
	 * call when the facade passes per-call `settings` (mirrors the
	 * `BaseAiProvider.resolveConfig` pattern).
	 */
	protected readonly settings: PluginSettings;

	/**
	 * Optional logger handed in by the facade. Concrete plugins use it
	 * for structured connection / query telemetry. Marked optional so
	 * the plugin loader (`new()`) path still works — the loader calls
	 * `onLoad(context)` which provides the real `context.logger` via
	 * `BasePlugin.logger`.
	 */
	protected readonly injectedLogger?: PluginLogger;

	constructor(settings: PluginSettings = {}, logger?: PluginLogger) {
		super();
		this.settings = settings;
		this.injectedLogger = logger;
	}

	/**
	 * Map a vendor-native score / distance into `[0, 1]` (higher =
	 * better). Required by RFC D6 — `QueryHit.normalizedScore` is the
	 * fusion-friendly score consumers display in the UI and feed into
	 * RRF / cross-encoder rerank. Implementations:
	 *
	 *   - pgvector returns cosine distance ∈ `[0, 2]` → `1 - rawScore / 2`.
	 *   - Qdrant returns cosine similarity ∈ `[-1, 1]` → `(rawScore + 1) / 2`.
	 *   - Pinecone returns dot-product similarity, range model-dependent
	 *     → sigmoid or min-max within the result set.
	 */
	abstract normalize(rawScore: number): number;

	abstract upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult>;
	abstract queryChunks(input: QueryChunksInput): Promise<QueryChunksResult>;
	abstract deleteByDocument(input: DeleteByDocumentInput): Promise<void>;
	abstract deleteByWork(input: DeleteByWorkInput): Promise<void>;

	/**
	 * Default availability probe — returns `true`. Concrete plugins
	 * override with a cheap round-trip (pgvector pings the connection,
	 * Qdrant hits `GET /collections`, Pinecone hits `describe_index`).
	 * The default `true` is safe for the in-memory test fake; production
	 * plugins MUST override.
	 */
	async isAvailable(_settings?: PluginSettings): Promise<boolean> {
		return true;
	}

	/**
	 * Convert any vendor-thrown error into a `VectorStoreError`. Use
	 * this at every public method's outermost `catch` so the facade
	 * sees a consistent shape regardless of which backend is wired in.
	 *
	 * @param err - The raw vendor error (may be anything, including non-Error throws).
	 * @param code - The stable taxonomy code the facade branches on.
	 * @param retriable - Whether the facade should back off and retry.
	 * @param message - Optional human-readable override; defaults to the vendor message.
	 */
	protected wrapVendorError(
		err: unknown,
		code: VectorStoreErrorCode,
		retriable: boolean,
		message?: string
	): VectorStoreError {
		const cause = err instanceof Error ? err : new Error(String(err));
		const finalMessage = message ?? `${this.providerName} ${code}${cause.message ? `: ${cause.message}` : ''}`;
		return new VectorStoreError(finalMessage, code, retriable, cause);
	}
}
