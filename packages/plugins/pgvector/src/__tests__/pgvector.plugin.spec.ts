/**
 * EW-642 — `@ever-works/pgvector-plugin` contract tests.
 *
 * The pgvector plugin owns its SQL through the `PgVectorChunkRepositoryPort`
 * dependency-injected at construction time. These tests stub that port with
 * an in-memory cosine-distance implementation so the plugin's contract
 * surface can be exercised without a live Postgres instance.
 *
 * The 7-case suite mirrors `runVectorStoreContractSuite` in
 * `@ever-works/plugin/src/contracts/__tests__/vector-store.spec.ts` —
 * inlined here because the shared suite is not published in the package's
 * `dist` (it lives under `__tests__` which tsup deliberately excludes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
	DeleteByDocumentInput,
	DeleteByWorkInput,
	IVectorStorePlugin,
	KnowledgeChunk,
	QueryChunksInput,
	UpsertChunksInput,
	VectorStoreNamespaceMode
} from '@ever-works/plugin';
import { PgVectorPlugin, type PgVectorChunkRepositoryPort } from '../pgvector.plugin.js';

interface StoredChunk {
	id: string;
	workId: string;
	documentId: string;
	chunkIndex: number;
	content: string;
	tokenCount: number;
	embedding: number[];
	metadata: Record<string, unknown> | null;
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length) {
		throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
	}
	let dot = 0;
	let nA = 0;
	let nB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		nA += a[i] * a[i];
		nB += b[i] * b[i];
	}
	if (nA === 0 || nB === 0) return 1; // arbitrary mid-point for degenerate vectors
	const similarity = dot / (Math.sqrt(nA) * Math.sqrt(nB));
	// pgvector cosine distance = 1 - similarity, range [0, 2].
	return 1 - similarity;
}

/**
 * In-memory `PgVectorChunkRepositoryPort` that mimics the wipe-then-insert
 * + cosine k-NN semantics of `WorkKnowledgeChunkRepository` without
 * requiring a live database.
 */
function createInMemoryChunkRepository(): PgVectorChunkRepositoryPort & {
	rows: Map<string, StoredChunk>;
} {
	const rows = new Map<string, StoredChunk>();
	const key = (workId: string, id: string) => `${workId}::${id}`;

	return {
		rows,
		async replaceForDocument(workId, documentId, chunks) {
			for (const [k, row] of rows) {
				if (row.workId === workId && row.documentId === documentId) {
					rows.delete(k);
				}
			}
			for (const c of chunks) {
				rows.set(key(workId, c.id), {
					id: c.id,
					workId,
					documentId: c.documentId,
					chunkIndex: c.chunkIndex,
					content: c.content,
					tokenCount: c.tokenCount,
					embedding: (c.embedding ?? []) as number[],
					metadata: c.metadata ?? null
				});
			}
		},
		async findNearestByEmbedding(workId, embedding, limit) {
			const scored: Array<{
				id: string;
				workId: string;
				documentId: string;
				chunkIndex: number;
				content: string;
				distance: number;
			}> = [];
			for (const row of rows.values()) {
				if (row.workId !== workId) continue;
				if (!row.embedding || row.embedding.length === 0) continue;
				scored.push({
					id: row.id,
					workId: row.workId,
					documentId: row.documentId,
					chunkIndex: row.chunkIndex,
					content: row.content,
					distance: cosineDistance(row.embedding, embedding)
				});
			}
			scored.sort((a, b) => a.distance - b.distance);
			return scored.slice(0, Math.max(0, limit));
		},
		async deleteByDocument(workId, documentId) {
			for (const [k, row] of rows) {
				if (row.workId === workId && row.documentId === documentId) {
					rows.delete(k);
				}
			}
		},
		async deleteByWork(workId) {
			for (const [k, row] of rows) {
				if (row.workId === workId) {
					rows.delete(k);
				}
			}
		}
	};
}

async function createPgVectorPluginWithFakeRepo(): Promise<IVectorStorePlugin> {
	const repo = createInMemoryChunkRepository();
	const plugin = new PgVectorPlugin({ chunkRepository: repo });
	return plugin;
}

const VEC = {
	x: [1, 0, 0],
	y: [0, 1, 0],
	z: [0, 0, 1]
} as const;

function makeChunk(overrides: Partial<KnowledgeChunk> & Pick<KnowledgeChunk, 'id'>): KnowledgeChunk {
	return {
		workId: 'w1',
		documentId: 'd1',
		chunkIndex: 0,
		content: 'placeholder',
		tokenCount: 1,
		embedding: VEC.x as number[],
		metadata: null,
		tenantId: null,
		organizationId: null,
		...overrides
	};
}

describe('PgVectorPlugin — metadata', () => {
	it('reports providerType=pgvector and capability=vector-store', () => {
		const plugin = new PgVectorPlugin();
		expect(plugin.id).toBe('pgvector');
		expect(plugin.providerType).toBe('pgvector');
		expect(plugin.category).toBe('vector-store');
		expect(plugin.capabilities).toContain('vector-store');
	});

	it('advertises rowFilter tenancy and embedsOnWrite=false', () => {
		const plugin = new PgVectorPlugin();
		expect(plugin.vectorCapabilities.namespacePerWork).toBe('rowFilter');
		expect(plugin.vectorCapabilities.embedsOnWrite).toBe(false);
		expect(plugin.vectorCapabilities.supportsDelete).toBe(true);
		expect(plugin.vectorCapabilities.nativeDimensions).toBe(1536);
	});

	it('normalize(0) === 1, normalize(2) === 0, normalize(1) === 0.5', () => {
		const plugin = new PgVectorPlugin();
		expect(plugin.normalize(0)).toBe(1);
		expect(plugin.normalize(2)).toBe(0);
		expect(plugin.normalize(1)).toBe(0.5);
	});

	it('normalize clamps out-of-range distances to [0, 1]', () => {
		const plugin = new PgVectorPlugin();
		expect(plugin.normalize(-1)).toBe(1);
		expect(plugin.normalize(3)).toBe(0);
		expect(plugin.normalize(NaN)).toBe(0);
	});
});

describe('IVectorStorePlugin contract (EW-642) — pgvector', () => {
	let plugin: IVectorStorePlugin;

	beforeEach(async () => {
		plugin = await createPgVectorPluginWithFakeRepo();
	});

	it('1. upsert + query returns the closest hit first with normalized scores in [0,1]', async () => {
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd1',
			chunks: [
				makeChunk({ id: 'c-x', chunkIndex: 0, content: 'x-chunk', embedding: VEC.x as number[] }),
				makeChunk({ id: 'c-y', chunkIndex: 1, content: 'y-chunk', embedding: VEC.y as number[] }),
				makeChunk({ id: 'c-z', chunkIndex: 2, content: 'z-chunk', embedding: VEC.z as number[] })
			]
		} satisfies UpsertChunksInput);

		const { hits } = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 2
		} satisfies QueryChunksInput);

		expect(hits).toHaveLength(2);
		expect(hits[0].chunk.content).toBe('x-chunk');
		for (const hit of hits) {
			expect(hit.normalizedScore).toBeGreaterThanOrEqual(0);
			expect(hit.normalizedScore).toBeLessThanOrEqual(1);
		}
	});

	it('2. upsert is idempotent — re-running with the same chunks returns the same top-K (no duplicates)', async () => {
		const chunks = [
			makeChunk({ id: 'c-x', chunkIndex: 0, content: 'x-chunk', embedding: VEC.x as number[] }),
			makeChunk({ id: 'c-y', chunkIndex: 1, content: 'y-chunk', embedding: VEC.y as number[] }),
			makeChunk({ id: 'c-z', chunkIndex: 2, content: 'z-chunk', embedding: VEC.z as number[] })
		];

		await plugin.upsertChunks({ workId: 'w1', documentId: 'd1', chunks });
		const first = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 3
		});

		await plugin.upsertChunks({ workId: 'w1', documentId: 'd1', chunks });
		const second = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 3
		});

		expect(second.hits.length).toBe(first.hits.length);
		expect(second.hits.map((h) => h.chunk.id)).toEqual(first.hits.map((h) => h.chunk.id));

		const wide = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 10
		});
		expect(wide.hits).toHaveLength(3);
		expect(new Set(wide.hits.map((h) => h.chunk.id)).size).toBe(3);
	});

	it('3. deleteByDocument removes only the targeted document chunks', async () => {
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd1',
			chunks: [
				makeChunk({
					id: 'd1-c0',
					documentId: 'd1',
					chunkIndex: 0,
					content: 'd1-chunk-0',
					embedding: VEC.x as number[]
				})
			]
		});
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd2',
			chunks: [
				makeChunk({
					id: 'd2-c0',
					documentId: 'd2',
					chunkIndex: 0,
					content: 'd2-chunk-0',
					embedding: VEC.y as number[]
				})
			]
		});

		await plugin.deleteByDocument({ workId: 'w1', documentId: 'd1' } satisfies DeleteByDocumentInput);

		const { hits } = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 10
		});

		expect(hits).toHaveLength(1);
		expect(hits[0].chunk.documentId).toBe('d2');
	});

	it('4. cross-Work isolation — query for w1 NEVER returns w2 hits even with identical embeddings', async () => {
		const identicalShape = (workId: string) =>
			makeChunk({
				id: `${workId}-c0`,
				workId,
				documentId: 'd-same',
				chunkIndex: 0,
				content: `${workId}-content`,
				embedding: VEC.x as number[]
			});

		await plugin.upsertChunks({ workId: 'w1', documentId: 'd-same', chunks: [identicalShape('w1')] });
		await plugin.upsertChunks({ workId: 'w2', documentId: 'd-same', chunks: [identicalShape('w2')] });

		const w1Hits = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 10
		});

		expect(w1Hits.hits).toHaveLength(1);
		expect(w1Hits.hits[0].chunk.workId).toBe('w1');
		for (const hit of w1Hits.hits) {
			expect(hit.chunk.workId).not.toBe('w2');
		}
	});

	it('5. namespacePerWork advertises one of the three allowed values', () => {
		const allowed: readonly VectorStoreNamespaceMode[] = ['collection', 'namespace', 'rowFilter'];
		expect(allowed).toContain(plugin.vectorCapabilities.namespacePerWork);
	});

	it('6. normalizedScore is monotonic non-increasing across the result set', async () => {
		const variants: Array<readonly [string, number[]]> = [
			['c-0', [1, 0, 0]],
			['c-1', [0.9, 0.1, 0]],
			['c-2', [0.7, 0.3, 0]],
			['c-3', [0.4, 0.6, 0]],
			['c-4', [0, 1, 0]]
		];

		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd1',
			chunks: variants.map(([id, embedding], idx) =>
				makeChunk({
					id,
					chunkIndex: idx,
					content: id,
					embedding: embedding as number[]
				})
			)
		});

		const { hits } = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 5
		});

		expect(hits).toHaveLength(5);
		for (let i = 0; i < hits.length - 1; i++) {
			expect(hits[i].normalizedScore).toBeGreaterThanOrEqual(hits[i + 1].normalizedScore);
		}
	});

	it('7. rawScore + normalizedScore are both preserved and distinct fields', async () => {
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd1',
			chunks: [
				makeChunk({ id: 'c-x', chunkIndex: 0, embedding: VEC.x as number[] }),
				makeChunk({ id: 'c-y', chunkIndex: 1, embedding: VEC.y as number[] })
			]
		});

		const { hits } = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: [0.5, 0.5, 0],
			topK: 2
		});

		expect(hits).toHaveLength(2);
		for (const hit of hits) {
			expect(typeof hit.rawScore).toBe('number');
			expect(Number.isFinite(hit.rawScore)).toBe(true);
			expect(typeof hit.normalizedScore).toBe('number');
			expect(hit.normalizedScore).toBeGreaterThanOrEqual(0);
			expect(hit.normalizedScore).toBeLessThanOrEqual(1);
		}
		const anyDistinct = hits.some((h) => Math.abs(h.rawScore - h.normalizedScore) > 1e-9);
		expect(anyDistinct).toBe(true);
	});

	it('deleteByWork cascades every chunk owned by the work', async () => {
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd1',
			chunks: [makeChunk({ id: 'a', embedding: VEC.x as number[] })]
		});
		await plugin.upsertChunks({
			workId: 'w1',
			documentId: 'd2',
			chunks: [makeChunk({ id: 'b', documentId: 'd2', embedding: VEC.y as number[] })]
		});

		await plugin.deleteByWork({ workId: 'w1' } satisfies DeleteByWorkInput);

		const wide = await plugin.queryChunks({
			workId: 'w1',
			queryEmbedding: VEC.x as number[],
			topK: 10
		});
		expect(wide.hits).toHaveLength(0);
	});

	it('upsert with a null embedding throws invalid-input (embedsOnWrite=false)', async () => {
		await expect(
			plugin.upsertChunks({
				workId: 'w1',
				documentId: 'd1',
				chunks: [makeChunk({ id: 'no-embed', embedding: null })]
			})
		).rejects.toThrow(/embedding/);
	});

	it('queryChunks with no embedding throws invalid-input', async () => {
		await expect(
			plugin.queryChunks({
				workId: 'w1',
				topK: 1
			})
		).rejects.toThrow(/queryEmbedding/);
	});
});
