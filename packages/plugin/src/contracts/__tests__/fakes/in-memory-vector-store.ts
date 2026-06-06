/**
 * EW-642 — in-memory `IVectorStorePlugin` fake.
 *
 * Purpose:
 *   - Verifies the shared contract test suite (`runVectorStoreContractSuite`)
 *     against a known-good reference implementation so the suite itself
 *     can never accidentally pass an empty implementation.
 *   - Backs every facade unit test (`vector-store.facade.spec.ts`) so they
 *     don't need a real Postgres / Qdrant / Pinecone connection.
 *   - Slice 2's `@ever-works/pgvector-plugin` tests fall back to this fake
 *     when `PGVECTOR_TEST_URL` is unset — keeping CI deterministic.
 *
 * Storage model:
 *   - Chunks live in a `Map<chunkKey, KnowledgeChunk>` keyed by
 *     `${workId}::${id}` to mirror the entity's composite PK
 *     (`workId, id`) without overlapping chunk ids across Works.
 *   - Re-upserting a `(workId, documentId)` first wipes every chunk for
 *     that pair (RFC §4 invariant 2 — replace, never append).
 *   - Query runs an O(N) cosine k-NN over chunks filtered by `workId`
 *     plus the optional `documentId`. Cosine similarity ∈ [-1, 1] is
 *     normalized into [0, 1] via `(cos + 1) / 2`, matching the
 *     `BaseVectorStore.normalize` recipe Qdrant uses in production.
 */

import { BaseVectorStore } from '../../../abstract/base-vector-store.js';
import type {
	DeleteByDocumentInput,
	DeleteByWorkInput,
	IVectorStorePlugin,
	KnowledgeChunk,
	QueryChunksInput,
	QueryChunksResult,
	QueryHit,
	UpsertChunksInput,
	UpsertChunksResult,
	VectorStoreCapabilities,
	VectorStoreProviderType
} from '../../capabilities/vector-store.interface.js';

const STORE_KEY = (workId: string, id: string): string => `${workId}::${id}`;

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`embedding dimension mismatch: ${a.length} vs ${b.length}`);
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * In-memory `IVectorStorePlugin` implementation. Not for production use —
 * only mounted in tests + dev fixtures.
 */
export class InMemoryVectorStorePlugin extends BaseVectorStore {
	readonly id = 'in-memory-vector-store';
	readonly name = 'In-Memory Vector Store (test fake)';
	readonly version = '0.0.0-test';

	readonly providerType: VectorStoreProviderType = 'in-memory';
	readonly providerName = 'In-Memory';

	readonly vectorCapabilities: VectorStoreCapabilities = {
		supportsMetadataFilter: true,
		supportsHybridSearch: false,
		supportsNamespaces: false,
		supportsDelete: true,
		nativeDimensions: 0,
		embedsOnWrite: false,
		// RFC §12 #2 / D5 — in-memory uses a single Map filtered by workId,
		// which is structurally identical to the pgvector row-filter shape.
		namespacePerWork: 'rowFilter'
	};

	private readonly chunks = new Map<string, KnowledgeChunk>();

	/** Cosine similarity ∈ [-1, 1] → normalized ∈ [0, 1]. */
	normalize(rawScore: number): number {
		return (rawScore + 1) / 2;
	}

	async upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult> {
		// Replace, never append. Wipe every existing chunk for (workId, documentId).
		const beforeCount = this.chunks.size;
		for (const [key, chunk] of this.chunks) {
			if (chunk.workId === input.workId && chunk.documentId === input.documentId) {
				this.chunks.delete(key);
			}
		}
		const removed = beforeCount - this.chunks.size;

		let written = 0;
		for (const chunk of input.chunks) {
			if (chunk.workId !== input.workId || chunk.documentId !== input.documentId) {
				throw new Error(`chunk ${chunk.id} has (workId, documentId) mismatch vs upsert input`);
			}
			if (chunk.embedding == null) {
				throw new Error(`in-memory fake requires a non-null embedding (embedsOnWrite=false)`);
			}
			this.chunks.set(STORE_KEY(chunk.workId, chunk.id), chunk);
			written++;
		}
		// `skipped` here means "previously-stored rows the upsert replaced",
		// which is the closest mirror of a real backend's idempotency signal.
		return { written, skipped: removed };
	}

	async queryChunks(input: QueryChunksInput): Promise<QueryChunksResult> {
		if (!input.queryEmbedding) {
			throw new Error('in-memory fake requires queryEmbedding (embedsOnWrite=false → queryText unsupported)');
		}

		const candidates: Array<{ chunk: KnowledgeChunk; rawScore: number }> = [];
		for (const chunk of this.chunks.values()) {
			if (chunk.workId !== input.workId) continue;
			if (input.filter?.documentId && chunk.documentId !== input.filter.documentId) continue;
			if (input.filter?.locale) {
				const locale = (chunk.metadata?.locale as string | undefined) ?? null;
				if (locale !== input.filter.locale) continue;
			}
			if (input.filter?.class) {
				const klass = (chunk.metadata?.class as string | undefined) ?? null;
				if (klass !== input.filter.class) continue;
			}
			if (chunk.embedding == null) continue;
			const score = cosineSimilarity(chunk.embedding, input.queryEmbedding);
			candidates.push({ chunk, rawScore: score });
		}

		candidates.sort((a, b) => b.rawScore - a.rawScore);

		const top = candidates.slice(0, Math.max(0, input.topK));
		const hits: QueryHit[] = top.map((c, idx) => ({
			chunk: c.chunk,
			rawScore: c.rawScore,
			normalizedScore: this.normalize(c.rawScore),
			rank: idx + 1
		}));
		return { hits };
	}

	async deleteByDocument(input: DeleteByDocumentInput): Promise<void> {
		for (const [key, chunk] of this.chunks) {
			if (chunk.workId === input.workId && chunk.documentId === input.documentId) {
				this.chunks.delete(key);
			}
		}
	}

	async deleteByWork(input: DeleteByWorkInput): Promise<void> {
		for (const [key, chunk] of this.chunks) {
			if (chunk.workId === input.workId) {
				this.chunks.delete(key);
			}
		}
	}
}

/**
 * Factory returning a fresh `InMemoryVectorStorePlugin`. The contract suite
 * accepts a factory (not a singleton) so each describe-block scenario
 * starts with an empty store and tests stay independent.
 */
export async function createInMemoryVectorStore(): Promise<IVectorStorePlugin> {
	return new InMemoryVectorStorePlugin();
}
