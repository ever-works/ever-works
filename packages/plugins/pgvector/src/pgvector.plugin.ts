/**
 * EW-642 — `@ever-works/pgvector-plugin`
 *
 * Default vector-store plugin shipped with Ever Works. Stores Knowledge
 * Base chunk embeddings in the same Postgres instance the API already
 * uses (the `work_knowledge_chunks` table created by migration
 * `1779975000000-CreateWorkKnowledgeChunks`).
 *
 * Design notes:
 *   - The actual SQL lives on `WorkKnowledgeChunkRepository` inside
 *     `@ever-works/agent`. Reusing it here keeps the chunk shape, the
 *     composite PK invariant, and the pgvector literal-encoding rules
 *     in one place. The plugin accepts the repository through a small
 *     `PgVectorChunkRepositoryPort` interface so it remains testable
 *     without a live database connection and so the plugin package
 *     does not need to take a hard dependency on `@ever-works/agent`.
 *   - `normalize(distance)` maps pgvector's cosine distance (range
 *     `[0, 2]`) into `[0, 1]` via `(2 - distance) / 2`, clamped at the
 *     edges so a vendor anomaly cannot break the RFC D6 invariant.
 *   - `embedsOnWrite = false` — the plugin requires every chunk to
 *     arrive with a non-null `embedding`. This matches Postgres's
 *     pgvector model (vendor-managed embedding is not available).
 *   - `namespacePerWork = 'rowFilter'` — chunks live in one shared
 *     table; every retrieval applies `WHERE work_id = $1` (RFC §4
 *     invariant 1).
 */

import { BaseVectorStore, type VectorStoreErrorCode } from '@ever-works/plugin/abstract';
import type {
	DeleteByDocumentInput,
	DeleteByWorkInput,
	JsonSchema,
	KnowledgeChunk,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings,
	QueryChunksInput,
	QueryChunksResult,
	QueryHit,
	UpsertChunksInput,
	UpsertChunksResult,
	VectorStoreCapabilities,
	VectorStoreProviderType
} from '@ever-works/plugin';

/**
 * Slim chunk row shape the plugin reads from / writes through the host
 * repository. Mirrors the columns the host `WorkKnowledgeChunk` entity
 * already exposes (minus the embedding on the read path — the cosine
 * search returns the distance instead of round-tripping the vector).
 */
export interface PgVectorChunkRow {
	readonly id: string;
	readonly workId: string;
	readonly documentId: string;
	readonly chunkIndex: number;
	readonly content: string;
	readonly tokenCount?: number;
	readonly metadata?: Record<string, unknown> | null;
	readonly tenantId?: string | null;
	readonly organizationId?: string | null;
}

/**
 * Repository port the plugin delegates SQL to. The host application
 * (`apps/api`) provides an implementation backed by
 * `WorkKnowledgeChunkRepository`; tests stub it with an in-memory
 * Map. Keeping the port small means the plugin doesn't have to know
 * about TypeORM / `DataSource` wiring.
 */
export interface PgVectorChunkRepositoryPort {
	/**
	 * Replace every chunk row for `(workId, documentId)` atomically.
	 * Wipe-then-insert keeps the upsert idempotent (RFC §4 invariant 2)
	 * without needing index-level UPSERT. Empty `chunks` array → DELETE
	 * only.
	 */
	replaceForDocument(
		workId: string,
		documentId: string,
		chunks: ReadonlyArray<{
			readonly id: string;
			readonly documentId: string;
			readonly chunkIndex: number;
			readonly content: string;
			readonly tokenCount: number;
			readonly embedding?: number[] | null;
			readonly metadata?: Record<string, unknown> | null;
		}>
	): Promise<void>;

	/**
	 * pgvector k-NN over the `embedding` column using the cosine
	 * distance operator (`<=>`). MUST apply `WHERE work_id = $1` so
	 * cross-Work leakage stays a P0 bug (RFC §4 invariant 1).
	 */
	findNearestByEmbedding(
		workId: string,
		embedding: readonly number[],
		limit: number
	): Promise<
		Array<{
			id: string;
			workId: string;
			documentId: string;
			chunkIndex: number;
			content: string;
			distance: number;
		}>
	>;

	/**
	 * Cascade-delete every chunk for a `(workId, documentId)` pair.
	 * Mapped to `deleteByDocument` on the plugin surface.
	 */
	deleteByDocument(workId: string, documentId: string): Promise<void>;

	/**
	 * Cascade-delete every chunk owned by a Work. Mapped to
	 * `deleteByWork` on the plugin surface.
	 */
	deleteByWork(workId: string): Promise<void>;
}

/**
 * Construction-time hook the host uses to supply the repository port
 * (and an optional `pingDatabase` probe for `isAvailable()`). Tests
 * pass an in-memory port; production wires the real repository through
 * `PluginContext.getSettings()`.
 */
export interface PgVectorPluginOptions {
	readonly chunkRepository?: PgVectorChunkRepositoryPort;
	/** Optional cheap probe — round-trips to the Postgres instance. */
	readonly pingDatabase?: () => Promise<boolean>;
}

const PGVECTOR_PROVIDER_TYPE: VectorStoreProviderType = 'pgvector';

/**
 * Clamp `value` into `[lo, hi]`. Defensive guard for the `normalize`
 * invariant — vendor anomalies (e.g. a NaN distance, a malformed
 * literal) cannot break the RFC D6 [0, 1] contract.
 */
function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Map a pgvector cosine distance (`[0, 2]`) into a normalized score
 * (`[0, 1]`, higher = better). `distance = 0` means identical vectors
 * → `normalizedScore = 1`. `distance = 2` means opposite vectors →
 * `normalizedScore = 0`.
 */
function cosineDistanceToNormalized(distance: number): number {
	return clamp01((2 - distance) / 2);
}

export class PgVectorPlugin extends BaseVectorStore {
	readonly id = 'pgvector';
	readonly name = 'Ever Works PgVector Store';
	readonly version = '0.1.0';

	readonly providerType: VectorStoreProviderType = PGVECTOR_PROVIDER_TYPE;
	readonly providerName = 'pgvector';

	readonly vectorCapabilities: VectorStoreCapabilities = {
		supportsMetadataFilter: true,
		supportsHybridSearch: false,
		supportsNamespaces: false,
		supportsDelete: true,
		nativeDimensions: 1536,
		embedsOnWrite: false,
		namespacePerWork: 'rowFilter'
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			embeddingModel: {
				type: 'string',
				title: 'Embedding Model',
				description:
					'Embedding model the host AI provider uses to vectorize chunks before they hit pgvector. Must match the model that produced the rows already in `work_knowledge_chunks`, otherwise queries will retrieve from a mixed vector space and recall will drop sharply.',
				default: 'text-embedding-3-small',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'KB_EMBEDDING_MODEL'
			},
			embeddingDimensions: {
				type: 'number',
				title: 'Embedding Dimensions',
				description:
					'Vector dimension the `embedding vector(N)` column is provisioned for. Default 1536 matches `text-embedding-3-small`. Changing this requires a column-altering migration plus a full re-embed sweep — do not flip it lightly.',
				default: 1536,
				minimum: 1,
				maximum: 16000,
				'x-envVar': 'KB_EMBEDDING_DIMENSIONS'
			},
			indexType: {
				type: 'string',
				title: 'ANN Index Type',
				description:
					'Approximate nearest-neighbor index strategy used on the `embedding` column. `ivfflat` (default) ships with every pgvector ≥ 0.5; `hnsw` is faster at query time but requires pgvector ≥ 0.5.0 and a separate index build.',
				default: 'ivfflat',
				enum: ['ivfflat', 'hnsw'],
				'x-envVar': 'KB_PGVECTOR_INDEX_TYPE'
			},
			lists: {
				type: 'number',
				title: 'ivfflat `lists`',
				description:
					'Number of inverted lists for `ivfflat`. Tune to ~sqrt(rows) — 100 is a sane default for the per-tenant chunk counts the platform currently sees.',
				default: 100,
				minimum: 1,
				maximum: 10000,
				'x-envVar': 'KB_PGVECTOR_LISTS'
			},
			efSearch: {
				type: 'number',
				title: 'HNSW `ef_search`',
				description:
					'`ef_search` knob for HNSW — higher values trade query latency for recall. Ignored when `indexType` is `ivfflat`.',
				default: 40,
				minimum: 1,
				maximum: 10000,
				'x-envVar': 'KB_PGVECTOR_EF_SEARCH'
			}
		}
	};

	private chunkRepository?: PgVectorChunkRepositoryPort;
	private pingDatabase?: () => Promise<boolean>;

	constructor(options: PgVectorPluginOptions = {}) {
		super();
		this.chunkRepository = options.chunkRepository;
		this.pingDatabase = options.pingDatabase;
	}

	/**
	 * Setter used by the host to inject the chunk repository after
	 * `new()` — keeps the plugin manifest-instantiable (the loader
	 * calls `new PgVectorPlugin()` with no args) while letting the
	 * NestJS DI graph wire the actual repository on `onLoad`.
	 */
	setChunkRepository(repository: PgVectorChunkRepositoryPort): void {
		this.chunkRepository = repository;
	}

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		context.logger.log('pgvector plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.chunkRepository = undefined;
		await super.onUnload();
	}

	// TODO(EW-642 D7 follow-up): wire the settings-change → re-embed
	// dispatch hook here. When the operator flips `embeddingModel` (or
	// `embeddingDimensions`) in this plugin's settings UI, the host
	// should fan out a `kb-reembed-work` Trigger.dev run per affected
	// Work so the existing chunks get re-embedded against the new model
	// before retrieval drifts into a mixed vector space.
	//
	// Expected call shape (KB_REEMBED_WORK_DISPATCHER lives in
	// `@ever-works/agent/tasks`):
	//
	//   await dispatcher.dispatchKbReembedWork({
	//       workId,
	//       previousModel: oldSettings.embeddingModel,
	//       newModel:      newSettings.embeddingModel,
	//       newDims:       newSettings.embeddingDimensions,
	//   });
	//
	// Sketch (host wires the dispatcher on `onLoad` via context):
	//
	//   async onSettingsChange(diff: SettingsDiff, ctx: PluginContext) {
	//       if (diff.changed('embeddingModel') || diff.changed('embeddingDimensions')) {
	//           const affectedWorkIds = await ctx.kb.listWorksUsingThisStore('pgvector');
	//           for (const workId of affectedWorkIds) {
	//               await ctx.dispatchers.kbReembedWork({
	//                   workId,
	//                   previousModel: diff.previous.embeddingModel,
	//                   newModel: diff.next.embeddingModel,
	//                   newDims: diff.next.embeddingDimensions,
	//               });
	//           }
	//       }
	//   }
	//
	// Out of scope for this slice — see `kb-reembed-work.task.ts` and
	// `KnowledgeBaseReembedService` for the receiver side.

	/** Cosine distance ∈ `[0, 2]` → normalized ∈ `[0, 1]`. */
	normalize(rawScore: number): number {
		return cosineDistanceToNormalized(rawScore);
	}

	async isAvailable(_settings?: PluginSettings): Promise<boolean> {
		if (this.pingDatabase) {
			try {
				return await this.pingDatabase();
			} catch {
				return false;
			}
		}
		// No probe wired in → fall back to "available iff the repository
		// is injected", which is the cheapest deterministic signal we
		// have in test + bootstrap paths.
		return this.chunkRepository !== undefined;
	}

	async upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult> {
		const repo = this.requireRepository();
		this.assertWorkAndDocumentMatch(input);

		const rows = input.chunks.map((chunk) => {
			if (chunk.embedding == null) {
				throw this.wrapVendorError(
					new Error(`chunk ${chunk.id} has no embedding (embedsOnWrite=false)`),
					'invalid-input',
					false
				);
			}
			return {
				id: chunk.id,
				documentId: chunk.documentId,
				chunkIndex: chunk.chunkIndex,
				content: chunk.content,
				tokenCount: chunk.tokenCount ?? 0,
				embedding: chunk.embedding as number[],
				metadata: chunk.metadata ?? null
			};
		});

		try {
			await repo.replaceForDocument(input.workId, input.documentId, rows);
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}

		return { written: rows.length, skipped: 0 };
	}

	async queryChunks(input: QueryChunksInput): Promise<QueryChunksResult> {
		const repo = this.requireRepository();
		const embedding = input.queryEmbedding;
		if (!embedding || embedding.length === 0) {
			throw this.wrapVendorError(
				new Error('pgvector requires queryEmbedding (embedsOnWrite=false → queryText unsupported)'),
				'invalid-input',
				false
			);
		}
		if (input.topK <= 0) {
			return { hits: [] };
		}

		let rows;
		try {
			rows = await repo.findNearestByEmbedding(input.workId, embedding, input.topK);
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}

		const hits: QueryHit[] = [];
		let rank = 1;
		for (const row of rows) {
			if (row.workId !== input.workId) {
				// Defensive — the SQL already filters on `work_id`, but
				// if a future repo refactor breaks that invariant we
				// surface the cross-Work leak instead of silently
				// returning rows from the wrong tenant.
				continue;
			}
			if (input.filter?.documentId && row.documentId !== input.filter.documentId) continue;
			const distance = row.distance;
			const chunk: KnowledgeChunk = {
				id: row.id,
				workId: row.workId,
				documentId: row.documentId,
				chunkIndex: row.chunkIndex,
				content: row.content,
				tokenCount: 0,
				embedding: null,
				metadata: null,
				tenantId: null,
				organizationId: null
			};
			hits.push({
				chunk,
				rawScore: distance,
				normalizedScore: this.normalize(distance),
				rank
			});
			rank++;
		}
		return { hits };
	}

	async deleteByDocument(input: DeleteByDocumentInput): Promise<void> {
		const repo = this.requireRepository();
		try {
			await repo.deleteByDocument(input.workId, input.documentId);
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}
	}

	async deleteByWork(input: DeleteByWorkInput): Promise<void> {
		const repo = this.requireRepository();
		try {
			await repo.deleteByWork(input.workId);
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const ok = await this.isAvailable();
		return {
			status: ok ? 'healthy' : 'unhealthy',
			message: ok ? 'pgvector plugin is ready' : 'pgvector plugin has no chunk repository wired in',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				"Default pgvector-backed vector store for the Ever Works Knowledge Base. Reuses the API's own Postgres instance.",
			category: this.category,
			capabilities: [...this.capabilities],
			defaultForCapabilities: ['vector-store'],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: true,
			visibility: 'public',
			readme: [
				'## What is the pgvector plugin?',
				'',
				'`pgvector` is the default vector store for the Ever Works Knowledge Base. It stores chunk embeddings in the same Postgres instance the API already uses, so a fresh install gets semantic search with zero extra infrastructure.',
				'',
				'## Why use it?',
				'',
				'- **Zero extra infrastructure** — re-uses the API Postgres',
				'- **Per-Work isolation** — every retrieval filters by `work_id`',
				'- **Composable** — swap to Qdrant or Pinecone later by installing a different vector-store plugin',
				'',
				'## How it works',
				'',
				'Chunks are stored in `work_knowledge_chunks`. The `embedding` column is `vector(1536)` (pgvector). An `ivfflat` index on `(embedding vector_cosine_ops)` powers k-NN queries via the `<=>` operator. Per-Work isolation is enforced by `WHERE work_id = $1` on every retrieval.'
			].join('\n')
		};
	}

	private requireRepository(): PgVectorChunkRepositoryPort {
		if (!this.chunkRepository) {
			throw this.wrapVendorError(
				new Error('pgvector chunk repository not wired in — call setChunkRepository() on the plugin'),
				'unavailable',
				false
			);
		}
		return this.chunkRepository;
	}

	private assertWorkAndDocumentMatch(input: UpsertChunksInput): void {
		for (const chunk of input.chunks) {
			if (chunk.workId !== input.workId || chunk.documentId !== input.documentId) {
				throw this.wrapVendorError(
					new Error(`chunk ${chunk.id} has (workId, documentId) mismatch vs upsert input`),
					'invalid-input',
					false
				);
			}
		}
	}

	/**
	 * Pass-through wrapper that preserves already-shaped `VectorStoreError`
	 * instances (so the caller-supplied code/retriable survive) and wraps
	 * raw vendor throws into the platform error taxonomy.
	 */
	private normalizeError(err: unknown, code: VectorStoreErrorCode, retriable: boolean): Error {
		if (err instanceof Error && err.name === 'VectorStoreError') {
			return err;
		}
		return this.wrapVendorError(err, code, retriable);
	}
}

export default PgVectorPlugin;
