/**
 * EW-642 — `@ever-works/qdrant-plugin`
 *
 * Qdrant-backed vector store plugin for the Ever Works Knowledge Base.
 * Ships via the dynamic plugin registry (EW-693) — NOT bundled into the
 * platform image. Operators install it on demand.
 *
 * Design notes:
 *   - `namespacePerWork = 'collection'` (RFC D5). One Qdrant collection
 *     per Work (`{collectionPrefix}-{workId}`) gives clean delete
 *     semantics (`deleteByWork` is a single `deleteCollection` call) and
 *     keeps per-Work HNSW indexes isolated for filter-pushdown speed.
 *     Pinecone, in contrast, will use `'namespace'` over one shared
 *     index because Pinecone serverless charges per index, not per
 *     namespace.
 *   - `embedsOnWrite = false` — Qdrant does not embed on the server, so
 *     every chunk MUST arrive with a non-null `embedding`. Invariant
 *     enforced at upsert time with a `VectorStoreError('invalid-input')`.
 *   - `normalize(rawScore)` branches on the configured distance metric:
 *     cosine → `(rawScore + 1) / 2`, euclid → `1 / (1 + rawScore)`,
 *     dot → sigmoid. RFC D6 — every plugin owns its score scale.
 *   - The official `@qdrant/js-client-rest` SDK is a hard runtime
 *     dependency (per workspace memory NN #17 — always prefer official
 *     SDKs over raw fetch). Construction is lazy: the client is only
 *     instantiated on the first method call so test-only consumers can
 *     pass a stub `clientFactory` via `QdrantPluginOptions`.
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

import { buildQdrantFilter, type QdrantFilter } from './qdrant-filter.js';

/**
 * Distance metric the plugin uses when provisioning a new collection.
 * Qdrant supports more metrics (Manhattan, …) but the platform only
 * exposes the three we have a normalization story for.
 */
export type QdrantDistance = 'cosine' | 'dot' | 'euclid';

const QDRANT_PROVIDER_TYPE: VectorStoreProviderType = 'qdrant';

/**
 * Minimal subset of `@qdrant/js-client-rest` the plugin actually calls.
 * Typed locally so the spec can drop in an in-memory fake without
 * pulling in the real client at test time.
 */
export interface QdrantClientPort {
	getCollections(): Promise<{ collections: Array<{ name: string }> }>;
	createCollection(
		name: string,
		config: { vectors: { size: number; distance: 'Cosine' | 'Dot' | 'Euclid' } }
	): Promise<unknown>;
	deleteCollection(name: string): Promise<unknown>;
	upsert(
		collectionName: string,
		params: {
			wait?: boolean;
			points: Array<{
				id: string | number;
				vector: number[];
				payload?: Record<string, unknown>;
			}>;
		}
	): Promise<unknown>;
	search(
		collectionName: string,
		params: {
			vector: number[];
			limit: number;
			filter?: QdrantFilter;
			with_payload?: boolean;
		}
	): Promise<
		Array<{
			id: string | number;
			score: number;
			payload?: Record<string, unknown> | null;
		}>
	>;
	delete(collectionName: string, params: { filter: QdrantFilter; wait?: boolean }): Promise<unknown>;
}

/**
 * Construction-time hook. Tests inject `clientFactory` to stub the
 * Qdrant client; production usage leaves it undefined and the plugin
 * lazily instantiates `new QdrantClient({ url, apiKey })` from the
 * resolved settings on first use. `settings` mirrors the
 * `BaseVectorStore` constructor argument so tests can seed
 * `collectionPrefix`, `vectorSize`, `distance`, etc. without going
 * through a live `PluginContext`.
 */
export interface QdrantPluginOptions {
	readonly clientFactory?: (config: { url: string; apiKey?: string }) => QdrantClientPort;
	readonly settings?: PluginSettings;
}

/**
 * Clamp `value` into `[0, 1]`. Defensive guard for the `normalize`
 * invariant — a vendor anomaly (NaN, out-of-range score) cannot break
 * the RFC D6 `[0, 1]` contract.
 */
function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

export class QdrantPlugin extends BaseVectorStore {
	readonly id = 'qdrant';
	readonly name = 'Ever Works Qdrant Vector Store';
	readonly version = '0.1.0';

	readonly providerType: VectorStoreProviderType = QDRANT_PROVIDER_TYPE;
	readonly providerName = 'qdrant';

	readonly vectorCapabilities: VectorStoreCapabilities = {
		supportsMetadataFilter: true,
		supportsHybridSearch: false,
		supportsNamespaces: true,
		supportsDelete: true,
		nativeDimensions: 0,
		embedsOnWrite: false,
		namespacePerWork: 'collection'
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			qdrantUrl: {
				type: 'string',
				title: 'Qdrant URL',
				description:
					'HTTP(S) endpoint of the Qdrant instance. Defaults to the local dev container on `http://localhost:6333`.',
				default: 'http://localhost:6333',
				'x-envVar': 'QDRANT_URL'
			},
			qdrantApiKey: {
				type: 'string',
				title: 'Qdrant API Key',
				description:
					'API key for managed Qdrant Cloud or any deployment behind auth. Leave blank for unsecured local clusters.',
				'x-secret': true,
				'x-envVar': 'QDRANT_API_KEY'
			},
			collectionPrefix: {
				type: 'string',
				title: 'Collection Prefix',
				description:
					'Prefix used to derive the per-Work collection name. Final collection = `{prefix}-{workId}`. Change with care: existing collections will not be renamed.',
				default: 'ever-works-kb',
				'x-envVar': 'QDRANT_COLLECTION_PREFIX'
			},
			embeddingModel: {
				type: 'string',
				title: 'Embedding Model',
				description:
					'Embedding model the host AI provider uses to vectorize chunks before they reach Qdrant. Must match the model that produced the rows already in the target collection, otherwise recall will drop sharply.',
				default: 'text-embedding-3-small',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'KB_EMBEDDING_MODEL'
			},
			vectorSize: {
				type: 'number',
				title: 'Vector Size',
				description:
					'Dimension of the embedding vectors. Default 1536 matches `text-embedding-3-small`. Changing this requires re-creating the collection (Qdrant does not allow resizing in place).',
				default: 1536,
				minimum: 1,
				maximum: 16000,
				'x-envVar': 'QDRANT_VECTOR_SIZE'
			},
			distance: {
				type: 'string',
				title: 'Distance Metric',
				description:
					'Similarity metric Qdrant uses when ranking points. `cosine` is the default and matches the rest of the platform; `dot` is appropriate for already-normalized vectors; `euclid` for L2.',
				default: 'cosine',
				enum: ['cosine', 'dot', 'euclid'],
				'x-envVar': 'QDRANT_DISTANCE'
			},
			upsertBatchSize: {
				type: 'number',
				title: 'Upsert Batch Size',
				description:
					'How many points to send per `POST /collections/{name}/points` request. Lower values reduce per-request memory, higher values improve throughput.',
				default: 128,
				minimum: 1,
				maximum: 4096,
				'x-envVar': 'QDRANT_UPSERT_BATCH_SIZE'
			}
		}
	};

	private readonly clientFactory?: QdrantPluginOptions['clientFactory'];
	private client?: QdrantClientPort;
	/** Collections we have already ensured exist for this process. */
	private readonly ensuredCollections = new Set<string>();

	constructor(options: QdrantPluginOptions = {}) {
		super(options.settings ?? {});
		this.clientFactory = options.clientFactory;
	}

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		context.logger.log('qdrant plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.client = undefined;
		this.ensuredCollections.clear();
		await super.onUnload();
	}

	/**
	 * Map a Qdrant raw score into `[0, 1]` (higher = better) based on
	 * the configured distance metric. RFC D6 — every plugin owns its
	 * score scale.
	 *
	 * - `cosine` similarity ∈ `[-1, 1]` → `(rawScore + 1) / 2`.
	 * - `dot` product is unbounded → sigmoid `1 / (1 + exp(-rawScore))`.
	 * - `euclid` distance ∈ `[0, ∞)` → `1 / (1 + rawScore)`.
	 */
	normalize(rawScore: number): number {
		const distance = this.resolveDistance(this.settings);
		switch (distance) {
			case 'cosine':
				return clamp01((rawScore + 1) / 2);
			case 'euclid':
				return clamp01(1 / (1 + Math.max(0, rawScore)));
			case 'dot':
				return clamp01(1 / (1 + Math.exp(-rawScore)));
			default: {
				const _exhaustive: never = distance;
				return clamp01((rawScore + 1) / 2);
			}
		}
	}

	async isAvailable(settings?: PluginSettings): Promise<boolean> {
		try {
			const client = this.getClient(settings);
			await client.getCollections();
			return true;
		} catch {
			return false;
		}
	}

	async upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult> {
		const settings = input.settings ?? this.settings;
		const collection = this.collectionNameFor(input.workId, settings);
		const batchSize = this.resolveBatchSize(settings);

		// Validate every chunk up-front so we don't half-write a batch on
		// a downstream `null embedding`.
		for (const chunk of input.chunks) {
			if (chunk.workId !== input.workId || chunk.documentId !== input.documentId) {
				throw this.wrapVendorError(
					new Error(`chunk ${chunk.id} has (workId, documentId) mismatch vs upsert input`),
					'invalid-input',
					false
				);
			}
			if (chunk.embedding == null) {
				throw this.wrapVendorError(
					new Error(`chunk ${chunk.id} has no embedding (embedsOnWrite=false)`),
					'invalid-input',
					false
				);
			}
		}

		if (input.chunks.length === 0) {
			return { written: 0, skipped: 0 };
		}

		const client = this.getClient(settings);
		await this.ensureCollection(client, collection, settings);

		// Delete every existing point for the (documentId) — replace, not
		// append (RFC §4 invariant 2). One collection per Work means we
		// only need to scope by `documentId`.
		try {
			await client.delete(collection, {
				filter: {
					must: [{ key: 'documentId', match: { value: input.documentId } }]
				},
				wait: true
			});
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}

		const points = input.chunks.map((chunk) => ({
			id: chunk.id,
			vector: chunk.embedding as number[],
			payload: {
				workId: chunk.workId,
				documentId: chunk.documentId,
				chunkIndex: chunk.chunkIndex,
				content: chunk.content,
				tokenCount: chunk.tokenCount ?? 0,
				...(chunk.metadata ?? {})
			}
		}));

		try {
			for (let i = 0; i < points.length; i += batchSize) {
				const slice = points.slice(i, i + batchSize);
				await client.upsert(collection, { points: slice, wait: true });
			}
		} catch (err) {
			throw this.normalizeError(err, 'internal', true);
		}

		return { written: points.length, skipped: 0 };
	}

	async queryChunks(input: QueryChunksInput): Promise<QueryChunksResult> {
		const settings = input.settings ?? this.settings;
		const embedding = input.queryEmbedding;
		if (!embedding || embedding.length === 0) {
			throw this.wrapVendorError(
				new Error('qdrant requires queryEmbedding (embedsOnWrite=false → queryText unsupported)'),
				'invalid-input',
				false
			);
		}
		if (input.topK <= 0) {
			return { hits: [] };
		}

		const collection = this.collectionNameFor(input.workId, settings);
		const client = this.getClient(settings);

		let rawResults: Array<{ id: string | number; score: number; payload?: Record<string, unknown> | null }>;
		try {
			rawResults = await client.search(collection, {
				vector: [...embedding],
				limit: input.topK,
				filter: buildQdrantFilter(input.filter),
				with_payload: true
			});
		} catch (err) {
			// A missing collection is the most common operator mistake →
			// surface as `not-found` rather than `internal` so the facade
			// can short-circuit retries and return an empty result set.
			if (isQdrantNotFound(err)) {
				return { hits: [] };
			}
			throw this.normalizeError(err, 'internal', true);
		}

		const hits: QueryHit[] = [];
		let rank = 1;
		for (const row of rawResults) {
			const payload = row.payload ?? {};
			const rowWorkId = String(payload['workId'] ?? '');
			if (rowWorkId && rowWorkId !== input.workId) {
				// Defensive — collection-per-Work already isolates, but if
				// an operator ever re-uses a collection across Works we
				// surface the leak instead of silently returning rows.
				continue;
			}
			if (input.filter?.documentId) {
				const rowDocId = String(payload['documentId'] ?? '');
				if (rowDocId !== input.filter.documentId) continue;
			}
			const chunk: KnowledgeChunk = {
				id: String(row.id),
				workId: rowWorkId || input.workId,
				documentId: String(payload['documentId'] ?? ''),
				chunkIndex: Number(payload['chunkIndex'] ?? 0),
				content: String(payload['content'] ?? ''),
				tokenCount: Number(payload['tokenCount'] ?? 0),
				embedding: null,
				metadata: extractMetadata(payload),
				tenantId: null,
				organizationId: null
			};
			hits.push({
				chunk,
				rawScore: row.score,
				normalizedScore: this.normalize(row.score),
				rank
			});
			rank++;
		}
		return { hits };
	}

	async deleteByDocument(input: DeleteByDocumentInput): Promise<void> {
		const settings = input.settings ?? this.settings;
		const collection = this.collectionNameFor(input.workId, settings);
		const client = this.getClient(settings);
		try {
			await client.delete(collection, {
				filter: {
					must: [{ key: 'documentId', match: { value: input.documentId } }]
				},
				wait: true
			});
		} catch (err) {
			if (isQdrantNotFound(err)) return;
			throw this.normalizeError(err, 'internal', true);
		}
	}

	async deleteByWork(input: DeleteByWorkInput): Promise<void> {
		const settings = input.settings ?? this.settings;
		const collection = this.collectionNameFor(input.workId, settings);
		const client = this.getClient(settings);
		try {
			await client.deleteCollection(collection);
			this.ensuredCollections.delete(collection);
		} catch (err) {
			if (isQdrantNotFound(err)) {
				this.ensuredCollections.delete(collection);
				return;
			}
			throw this.normalizeError(err, 'internal', true);
		}
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const ok = await this.isAvailable();
		return {
			status: ok ? 'healthy' : 'unhealthy',
			message: ok ? 'qdrant plugin is ready' : 'qdrant plugin cannot reach the configured cluster',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Qdrant-backed vector store for the Ever Works Knowledge Base. One collection per Work, configurable distance metric. Ships via the dynamic plugin registry (EW-693).',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: false,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the qdrant plugin?',
				'',
				'`qdrant` is a vector-store plugin that stores Knowledge Base chunk embeddings in a Qdrant cluster — managed (Qdrant Cloud) or self-hosted.',
				'',
				'## Why use it?',
				'',
				'- **Purpose-built ANN engine** — HNSW indexes with payload filters pushed down to the storage layer',
				'- **Collection-per-Work isolation** — `deleteByWork` is a single API call, recall stays stable across tenants',
				'- **Operates outside Postgres** — keeps the API DB small and offloads vector load to dedicated hardware',
				'',
				'## How it works',
				'',
				'On first use the plugin creates `{collectionPrefix}-{workId}` with the configured `vectorSize` and `distance` metric. Upsert wipes the existing points for the document, then writes the new batch. `queryChunks` runs a HNSW search filtered by payload; `deleteByWork` drops the collection.'
			].join('\n')
		};
	}

	/**
	 * Build the collection name for a given Work. Exposed (non-private)
	 * so the spec can assert the naming convention.
	 */
	collectionNameFor(workId: string, settings?: PluginSettings): string {
		const resolved = settings ?? this.settings;
		const prefix = (resolved['collectionPrefix'] as string | undefined) ?? 'ever-works-kb';
		return `${prefix}-${workId}`;
	}

	/**
	 * Lazily instantiate the Qdrant client. Caches on the instance so
	 * subsequent calls reuse the same connection pool.
	 */
	private getClient(settings?: PluginSettings): QdrantClientPort {
		if (this.client) return this.client;
		const resolved = settings ?? this.settings;
		const url = (resolved['qdrantUrl'] as string | undefined) ?? 'http://localhost:6333';
		const apiKey = resolved['qdrantApiKey'] as string | undefined;

		if (this.clientFactory) {
			this.client = this.clientFactory({ url, apiKey });
			return this.client;
		}

		// Dynamic import so consumers that pass a `clientFactory` (tests)
		// never need to have `@qdrant/js-client-rest` installed. In
		// production the SDK is a hard dependency declared in
		// `package.json`.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { QdrantClient } = require('@qdrant/js-client-rest') as {
			QdrantClient: new (config: { url: string; apiKey?: string }) => QdrantClientPort;
		};
		this.client = new QdrantClient({ url, apiKey });
		return this.client;
	}

	private async ensureCollection(
		client: QdrantClientPort,
		collection: string,
		settings: PluginSettings
	): Promise<void> {
		if (this.ensuredCollections.has(collection)) return;
		try {
			const { collections } = await client.getCollections();
			if (collections.some((c) => c.name === collection)) {
				this.ensuredCollections.add(collection);
				return;
			}
		} catch (err) {
			throw this.normalizeError(err, 'unavailable', true);
		}

		const vectorSize = Number((settings['vectorSize'] as number | undefined) ?? 1536);
		const distance = this.resolveDistance(settings);
		try {
			await client.createCollection(collection, {
				vectors: { size: vectorSize, distance: toQdrantDistance(distance) }
			});
			this.ensuredCollections.add(collection);
		} catch (err) {
			// Concurrent first-write race → "already exists". Idempotent.
			if (isQdrantAlreadyExists(err)) {
				this.ensuredCollections.add(collection);
				return;
			}
			throw this.normalizeError(err, 'internal', true);
		}
	}

	private resolveDistance(settings: PluginSettings): QdrantDistance {
		const value = (settings['distance'] as string | undefined) ?? 'cosine';
		if (value === 'cosine' || value === 'dot' || value === 'euclid') return value;
		return 'cosine';
	}

	private resolveBatchSize(settings: PluginSettings): number {
		const raw = settings['upsertBatchSize'];
		const value = typeof raw === 'number' ? raw : 128;
		return Math.max(1, Math.floor(value));
	}

	/**
	 * Preserve already-shaped `VectorStoreError` instances so the
	 * caller-supplied code/retriable survive, otherwise wrap.
	 */
	private normalizeError(err: unknown, code: VectorStoreErrorCode, retriable: boolean): Error {
		if (err instanceof Error && err.name === 'VectorStoreError') {
			return err;
		}
		return this.wrapVendorError(err, code, retriable);
	}
}

function toQdrantDistance(distance: QdrantDistance): 'Cosine' | 'Dot' | 'Euclid' {
	switch (distance) {
		case 'cosine':
			return 'Cosine';
		case 'dot':
			return 'Dot';
		case 'euclid':
			return 'Euclid';
	}
}

/**
 * Strip the platform-managed payload keys so the round-tripped
 * `metadata` only contains caller-supplied fields.
 */
function extractMetadata(payload: Record<string, unknown>): Record<string, unknown> | null {
	const reserved = new Set(['workId', 'documentId', 'chunkIndex', 'content', 'tokenCount']);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (!reserved.has(k)) out[k] = v;
	}
	return Object.keys(out).length === 0 ? null : out;
}

function isQdrantNotFound(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const status = readStatus(err);
	if (status === 404) return true;
	return /not.?found|doesn't exist|does not exist/i.test(err.message);
}

function isQdrantAlreadyExists(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const status = readStatus(err);
	if (status === 409) return true;
	return /already exists|conflict/i.test(err.message);
}

function readStatus(err: Error): number | undefined {
	const anyErr = err as Error & { status?: number; statusCode?: number };
	return anyErr.status ?? anyErr.statusCode;
}

export default QdrantPlugin;
