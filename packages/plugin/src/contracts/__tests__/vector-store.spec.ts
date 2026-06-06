/**
 * EW-642 — reusable contract test suite for `IVectorStorePlugin`.
 *
 * Every concrete implementation (`@ever-works/pgvector-plugin`,
 * `@ever-works/qdrant-plugin`, `@ever-works/pinecone-plugin`, …) MUST
 * pass these tests. The suite encodes the RFC §4 invariants:
 *
 *   1. `workId` is the leftmost filter (cross-Work isolation).
 *   2. Upsert is by `(workId, documentId, chunkIndex)` — replace, never
 *      append — so a second upsert MUST return the same top-K (no
 *      duplicates).
 *   3. `deleteByDocument` cascades only the targeted chunks; other
 *      documents in the same Work are untouched.
 *   4. `queryChunks` returns at most `topK` hits, ordered best-first by
 *      `normalizedScore` ∈ [0, 1], with `rawScore` preserved verbatim.
 *
 * Plus the locked design resolutions:
 *   - D5 → `namespacePerWork` is one of `'collection' | 'namespace' | 'rowFilter'`.
 *   - D6 → every hit exposes BOTH `rawScore` and `normalizedScore`.
 *
 * Usage:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { runVectorStoreContractSuite } from '@ever-works/plugin/contracts/__tests__/vector-store.spec.js';
 *   import { createPgVectorStore } from './fixtures/pgvector-factory.js';
 *
 *   describe('PgVector plugin — contract', () => {
 *     runVectorStoreContractSuite(createPgVectorStore);
 *   });
 *   ```
 *
 * The suite is also self-applied at the bottom of this file against the
 * in-memory fake so the contract itself is exercised in `pnpm test`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	IVectorStorePlugin,
	KnowledgeChunk,
	VectorStoreNamespaceMode
} from '../capabilities/vector-store.interface.js';
import { createInMemoryVectorStore } from './fakes/in-memory-vector-store.js';

export interface VectorStoreContractOptions {
	/**
	 * Skip the deleteByDocument / deleteByWork tests. Only true for
	 * backends that publicly advertise `supportsDelete: false` (read-only
	 * mirrors etc.). Default `false`.
	 */
	readonly skipDelete?: boolean;
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

/**
 * Registers the EW-642 vector-store contract describe block. Pass a
 * factory that returns a fresh, empty plugin per call — the suite spins
 * one up before every test for isolation.
 */
export function runVectorStoreContractSuite(
	factory: () => Promise<IVectorStorePlugin>,
	options: VectorStoreContractOptions = {}
): void {
	describe('IVectorStorePlugin contract (EW-642)', () => {
		let plugin: IVectorStorePlugin;

		beforeEach(async () => {
			plugin = await factory();
		});

		afterEach(async () => {
			// Best-effort cleanup so factories that hand back a shared
			// backend (e.g. one Postgres schema reused by every test) don't
			// bleed state between scenarios. Errors are swallowed because
			// the in-memory fake doesn't need it.
			try {
				await plugin.deleteByWork({ workId: 'w1' });
				await plugin.deleteByWork({ workId: 'w2' });
			} catch {
				/* noop */
			}
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
			});

			const { hits } = await plugin.queryChunks({
				workId: 'w1',
				queryEmbedding: VEC.x as number[],
				topK: 2
			});

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

			expect(second.hits).toHaveLength(first.hits.length);
			expect(second.hits.map((h) => h.chunk.id)).toEqual(first.hits.map((h) => h.chunk.id));

			// Independently verify no row leaked — topK=10 must still be ≤ 3 chunks.
			const wide = await plugin.queryChunks({
				workId: 'w1',
				queryEmbedding: VEC.x as number[],
				topK: 10
			});
			expect(wide.hits).toHaveLength(3);
			const uniqueIds = new Set(wide.hits.map((h) => h.chunk.id));
			expect(uniqueIds.size).toBe(3);
		});

		(options.skipDelete ? it.skip : it)(
			'3. deleteByDocument removes only the targeted document chunks',
			async () => {
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

				await plugin.deleteByDocument({ workId: 'w1', documentId: 'd1' });

				const { hits } = await plugin.queryChunks({
					workId: 'w1',
					queryEmbedding: VEC.x as number[],
					topK: 10
				});

				expect(hits).toHaveLength(1);
				expect(hits[0].chunk.documentId).toBe('d2');
			}
		);

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

			await plugin.upsertChunks({
				workId: 'w1',
				documentId: 'd-same',
				chunks: [identicalShape('w1')]
			});
			await plugin.upsertChunks({
				workId: 'w2',
				documentId: 'd-same',
				chunks: [identicalShape('w2')]
			});

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
			const mode = plugin.vectorCapabilities.namespacePerWork;
			const allowed: readonly VectorStoreNamespaceMode[] = ['collection', 'namespace', 'rowFilter'];
			expect(allowed).toContain(mode);
		});

		it('6. normalizedScore is monotonic non-increasing across the result set', async () => {
			// Vectors with steadily decreasing similarity to `query = VEC.x`.
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
				// Mid-vector so neither raw nor normalized scores collapse to 0/1.
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
				expect('rawScore' in hit).toBe(true);
				expect('normalizedScore' in hit).toBe(true);
			}

			// rawScore MUST NOT have been silently overwritten to equal
			// normalizedScore. For any backend whose normalize() is not the
			// identity, at least one hit shows a measurable gap.
			const anyDistinct = hits.some((h) => Math.abs(h.rawScore - h.normalizedScore) > 1e-9);
			expect(anyDistinct).toBe(true);
		});
	});
}

// Self-application — exercises the contract against the in-memory fake
// every time `pnpm --filter @ever-works/plugin test` runs. Acts as a
// canary: a contract change that breaks the reference implementation
// breaks here first, before any concrete plugin's CI run.
runVectorStoreContractSuite(createInMemoryVectorStore);
