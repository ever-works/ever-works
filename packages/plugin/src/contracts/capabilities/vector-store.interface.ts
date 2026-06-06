/**
 * EW-642 — pluggable vector store capability.
 *
 * `IVectorStorePlugin` is the contract every vector database (pgvector,
 * Qdrant, Pinecone, Weaviate, Milvus, ...) implements so the Knowledge
 * Base can store and retrieve chunk embeddings without hard-coding any
 * particular backend. The platform owns only invalidation coordinates
 * (work_id, document_id, chunk_count, last_embedded_at); the actual
 * chunks + vectors live inside the plugin's own store.
 *
 * Design rationale lives in the RFC:
 * `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md`
 * (sections §4 contract, §6 selection chain, §7 data model).
 */

import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Free-form provider identifier ('pgvector', 'qdrant', 'pinecone', ...).
 * Mirrors the `AiProviderType` shape on `IAiProviderPlugin` so facades
 * can log + key by provider without baking in a closed enum.
 */
export type VectorStoreProviderType = string;

/**
 * How the backend models per-Work tenancy. Resolution of RFC §12 open
 * question #2 (locked in D5): every plugin MUST declare which physical
 * strategy it uses so the platform UX can hint operators correctly
 * (single collection + namespace per Work for Pinecone serverless,
 * one collection per Work for self-hosted Qdrant, row-filter on a
 * shared table for pgvector).
 */
export type VectorStoreNamespaceMode = 'collection' | 'namespace' | 'rowFilter';

/**
 * Static capabilities advertised by a vector-store plugin. The facade
 * uses these to route around features the backend lacks (e.g. skip
 * server-side hybrid search and fall back to RRF on the caller side).
 *
 * RFC §4 — every field is REQUIRED, including `namespacePerWork`
 * (locked in resolution D5).
 */
export interface VectorStoreCapabilities {
	/**
	 * Server-side metadata filter pushdown. Every retrieval query MUST
	 * filter by `workId`; backends without filter pushdown have to
	 * implement this client-side and the facade still enforces it.
	 */
	readonly supportsMetadataFilter: boolean;
	/** Hybrid (vector + keyword) scoring in a single round trip. */
	readonly supportsHybridSearch: boolean;
	/** Multi-tenant namespace / collection per Work without a per-Work index. */
	readonly supportsNamespaces: boolean;
	/** Server-side hard delete (vs soft delete + sweep). */
	readonly supportsDelete: boolean;
	/**
	 * Native embedding dimensions the backend was provisioned for.
	 * `0` = backend-managed (e.g. Weaviate text2vec modules choose
	 * dimensions per collection).
	 */
	readonly nativeDimensions: number;
	/**
	 * Backend re-embeds on write (e.g. Weaviate text2vec). When `true`,
	 * callers MAY pass `chunk.embedding = null` and the backend computes
	 * the vector. When `false`, callers MUST provide a non-null
	 * `embedding` for every chunk.
	 */
	readonly embedsOnWrite: boolean;
	/**
	 * Physical tenancy strategy this backend uses for per-Work isolation
	 * (RFC §12 #2 → resolution D5). Required so the operator UX can hint
	 * "Pinecone uses namespaces; one index serves all Works" vs "Qdrant
	 * creates one collection per Work" vs "pgvector shares a table and
	 * filters by work_id".
	 */
	readonly namespacePerWork: VectorStoreNamespaceMode;
}

/**
 * Payload aligned with the `WorkKnowledgeChunk` entity (the platform-side
 * invalidation coordinates pin the same shape). The plugin stores
 * whatever subset its backend needs; the platform only round-trips this
 * shape across the contract.
 *
 * `embedding` may be `null` when the plugin advertises
 * `capabilities.embedsOnWrite === true` and the caller wants the backend
 * to compute the vector. For every other plugin a non-null `embedding`
 * is required.
 */
export interface KnowledgeChunk {
	/** Stable chunk id. Composite uniqueness is `(workId, id)` to mirror the entity PK. */
	readonly id: string;
	/** Owning Work — leftmost filter on every retrieval, P0 invariant. */
	readonly workId: string;
	/** Source document the chunk was derived from. */
	readonly documentId: string;
	/** 0-based chunk ordinal within the document. */
	readonly chunkIndex: number;
	/** The chunk text. Stored as-is for retrieval display + reranker rerun. */
	readonly content: string;
	/** Token count produced by the chunker. Used for budgeting at query time. */
	readonly tokenCount: number;
	/**
	 * Caller-side embedding. Required unless
	 * `capabilities.embedsOnWrite === true`, in which case `null` lets
	 * the backend compute the vector. Plugins MUST validate this
	 * invariant at upsert time and surface `VectorStoreError` with a
	 * non-retriable code when violated.
	 */
	readonly embedding?: number[] | null;
	/** Free-form metadata (headingPath, charRange, …). Round-tripped opaquely. */
	readonly metadata?: Record<string, unknown> | null;
	/** Optional tenant scoping (mirrors entity). */
	readonly tenantId?: string | null;
	/** Optional organization scoping (mirrors entity). */
	readonly organizationId?: string | null;
}

/**
 * Typed metadata filter accepted by `queryChunks`. The shape is
 * deliberately small (the platform only routes a handful of fields
 * through today) — backends that support richer filters can still
 * receive them via the catch-all `[key: string]: unknown` shape on the
 * raw query, but every first-class field is pinned here so we get
 * compile-time checks at every call site.
 */
export interface VectorFilter {
	/** Restrict to a single source document. */
	readonly documentId?: string;
	/** Restrict to chunks tagged with at least one of these tags. */
	readonly tags?: readonly string[];
	/**
	 * Restrict to a single KbDocumentClass ('research', 'reference', …).
	 * Mirrors `KB_TRANSCRIPTION_TARGET_CLASS` on the embedding side.
	 */
	readonly class?: string;
	/** Restrict to a single BCP-47 locale (e.g. 'en', 'fr-CA'). */
	readonly locale?: string;
}

/**
 * Input to `upsertChunks`. Upsert semantics are
 * by-(workId, documentId, chunkIndex) — re-ingesting a document MUST
 * replace previous chunks, never append duplicates (RFC §4 invariant 2).
 */
export interface UpsertChunksInput {
	readonly workId: string;
	readonly documentId: string;
	readonly chunks: readonly KnowledgeChunk[];
	readonly settings?: PluginSettings;
}

/**
 * Result of a successful `upsertChunks`. `written` counts new + updated
 * rows; `skipped` counts no-op duplicates the plugin detected (used by
 * the agent to short-circuit downstream events).
 */
export interface UpsertChunksResult {
	readonly written: number;
	readonly skipped: number;
}

/**
 * Input to `queryChunks`. Exactly one of `queryEmbedding` or
 * `queryText` must be supplied — plugins with
 * `capabilities.embedsOnWrite === true` accept `queryText` and embed
 * it server-side; everyone else expects `queryEmbedding`.
 */
export interface QueryChunksInput {
	readonly workId: string;
	/** Caller-side query vector. Preferred when the plugin doesn't embed on the server. */
	readonly queryEmbedding?: number[];
	/** Raw query text. Only used when `capabilities.embedsOnWrite === true`. */
	readonly queryText?: string;
	/** Maximum number of hits to return. Plugins MUST clamp to this. */
	readonly topK: number;
	/**
	 * Caller-side metadata filter, AND-combined with the mandatory
	 * `workId` filter the plugin already applies.
	 */
	readonly filter?: VectorFilter;
	readonly settings?: PluginSettings;
}

/**
 * A single retrieval hit. RFC §12 #3 → resolution D6: every plugin MUST
 * expose BOTH the raw vendor score (for diagnostics + telemetry) AND a
 * `normalizedScore ∈ [0, 1]` so consumers can fuse results across
 * plugins (e.g. RRF + cross-encoder rerank) without per-plugin
 * calibration knowledge at the call site.
 */
export interface QueryHit {
	/** The retrieved chunk. */
	readonly chunk: KnowledgeChunk;
	/**
	 * Vendor-native score / distance the backend returned. Preserved
	 * verbatim for diagnostics; consumers MUST NOT compare `rawScore`
	 * across plugins because the scale is plugin-defined.
	 */
	readonly rawScore: number;
	/**
	 * Normalized score in `[0, 1]` (higher = better) produced by
	 * `BaseVectorStore.normalize(rawScore)`. RFC D6 — mandatory; this is
	 * the score consumers use for fusion and UI confidence display.
	 */
	readonly normalizedScore: number;
	/** 1-based rank within the result set. Plugins MUST return ordered hits. */
	readonly rank: number;
}

/**
 * Result of a successful `queryChunks`. Hits are ordered best-first by
 * `normalizedScore` (ties broken by `rawScore`).
 */
export interface QueryChunksResult {
	readonly hits: readonly QueryHit[];
}

/**
 * Input to `deleteByDocument`. Cascades all chunks for the
 * `(workId, documentId)` pair. Called during document delete and
 * re-ingest (RFC §4 invariant 3).
 */
export interface DeleteByDocumentInput {
	readonly workId: string;
	readonly documentId: string;
	readonly settings?: PluginSettings;
}

/**
 * Input to `deleteByWork`. Cascades every chunk owned by the Work.
 * Called during Work deletion and tenant offboarding.
 */
export interface DeleteByWorkInput {
	readonly workId: string;
	readonly settings?: PluginSettings;
}

/**
 * Input to the optional `upsertEmbedding` escape hatch. Lets the
 * platform store non-chunk embeddings (e.g. per-document summary
 * vectors planned for future "section-of-interest" retrieval). Plugins
 * MAY leave this unimplemented; consumers MUST guard with `typeof
 * plugin.upsertEmbedding === 'function'`.
 */
export interface UpsertEmbeddingInput {
	readonly workId: string;
	/** Caller-defined key — opaque to the plugin, used for retrieval. */
	readonly key: string;
	readonly embedding: number[];
	readonly metadata?: Record<string, unknown>;
	readonly settings?: PluginSettings;
}

/**
 * Vector-store plugin contract — capability `vector-store`.
 *
 * Concrete implementations:
 *   - `@ever-works/pgvector-plugin` (default, ships with the platform image)
 *   - `@ever-works/qdrant-plugin` (next slice)
 *   - `@ever-works/pinecone-plugin` (customer-driven slice)
 *
 * Selection chain lives on `VectorStoreFacadeService` (`packages/agent/src/facades/`):
 *   1. operator env pin `KB_VECTOR_STORE_PROVIDER_ID`
 *   2. per-Work pin via `WorkPlugin`
 *   3. scope-active registry default
 *   4. first available registry plugin
 *   5. otherwise throw `VectorStoreNotConfiguredError`
 *
 * RFC §4 invariants every implementation MUST honor:
 *   1. `workId` is the leftmost filter; cross-Work leakage is a P0 bug.
 *   2. Upsert is by `(workId, documentId, chunkIndex)` — replace, never append.
 *   3. `deleteByDocument` cascades the chunks.
 *   4. `queryChunks` returns at most `topK` hits, ordered best-first.
 */
export interface IVectorStorePlugin extends IPlugin {
	/** Provider identifier ('pgvector', 'qdrant', …). */
	readonly providerType: VectorStoreProviderType;
	/** Human-readable backend name for logs + facade identification. */
	readonly providerName: string;
	/**
	 * Static capability flags. NOTE: this shadows `IPlugin.capabilities`
	 * (which is a `readonly string[]` of capability tokens) with a
	 * structured object — implementations MUST still declare the string
	 * `'vector-store'` in their manifest's `capabilities` array; the
	 * structured object lives at runtime for facade routing.
	 */
	readonly vectorCapabilities: VectorStoreCapabilities;

	/** Upsert chunks for a `(workId, documentId)` pair. RFC §4 invariant 2. */
	upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult>;

	/** Run a vector query within a single Work. RFC §4 invariant 4. */
	queryChunks(input: QueryChunksInput): Promise<QueryChunksResult>;

	/** Cascade-delete every chunk for a document. RFC §4 invariant 3. */
	deleteByDocument(input: DeleteByDocumentInput): Promise<void>;

	/** Cascade-delete every chunk owned by a Work. */
	deleteByWork(input: DeleteByWorkInput): Promise<void>;

	/**
	 * Optional: write a non-chunk embedding (summary vectors, future
	 * "section-of-interest" indexes). Plugins MAY leave this unset.
	 */
	upsertEmbedding?(input: UpsertEmbeddingInput): Promise<void>;

	/** Whether the backend is healthy / configured. */
	isAvailable(settings?: PluginSettings): Promise<boolean>;
}

/**
 * Type guard for vector-store plugins. Checks the capability token
 * advertised on the plugin manifest (consistent with `isStoragePlugin`
 * + `isAiProviderPlugin`). The structured `vectorCapabilities` object
 * is a runtime-only convenience — the manifest token is the truth.
 */
export function isVectorStorePlugin(plugin: IPlugin): plugin is IVectorStorePlugin {
	return plugin.capabilities.includes('vector-store');
}
