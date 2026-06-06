/**
 * EW-642 — `@ever-works/qdrant-plugin` contract tests.
 *
 * Uses an in-memory `QdrantClientPort` implementation that mimics the
 * Qdrant REST API's collection/payload semantics. The plugin's behaviour
 * surface is exercised through `runVectorStoreContractSuite`-equivalent
 * cases (inlined — the shared suite is not published in `dist`).
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
import { QdrantPlugin, type QdrantClientPort } from './qdrant.plugin.js';
import { buildQdrantFilter } from './qdrant-filter.js';
import type { QdrantFilter, QdrantFilterCondition } from './qdrant-filter.js';

interface StoredPoint {
	id: string;
	vector: number[];
	payload: Record<string, unknown>;
}

/**
 * Build an in-memory fake of the slice of `@qdrant/js-client-rest` the
 * plugin uses. Backed by a `Map<collectionName, points[]>` so deletes,
 * upserts, and filter-pushdown queries all operate against the same
 * mutable state.
 */
function createInMemoryQdrant(distance: 'Cosine' | 'Dot' | 'Euclid' = 'Cosine'): QdrantClientPort & {
	collections: Map<string, StoredPoint[]>;
	deleteCalls: string[];
} {
	const collections = new Map<string, StoredPoint[]>();
	const deleteCalls: string[] = [];

	function score(a: readonly number[], b: readonly number[]): number {
		if (a.length !== b.length) throw new Error(`dim mismatch ${a.length} vs ${b.length}`);
		let dot = 0;
		let nA = 0;
		let nB = 0;
		let sqDist = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			nA += a[i] * a[i];
			nB += b[i] * b[i];
			sqDist += (a[i] - b[i]) * (a[i] - b[i]);
		}
		if (distance === 'Cosine') {
			if (nA === 0 || nB === 0) return 0;
			return dot / (Math.sqrt(nA) * Math.sqrt(nB));
		}
		if (distance === 'Dot') return dot;
		// Euclid — Qdrant reports L2 distance (higher = worse). To keep
		// the "best-first" sort the plugin expects, we still emit the
		// raw distance; the plugin's normalize() will invert.
		return Math.sqrt(sqDist);
	}

	function passesFilter(point: StoredPoint, filter?: QdrantFilter): boolean {
		if (!filter) return true;
		for (const c of filter.must ?? []) {
			if (!matchCondition(point, c)) return false;
		}
		for (const c of filter.must_not ?? []) {
			if (matchCondition(point, c)) return false;
		}
		const should = filter.should;
		if (should && should.length > 0) {
			if (!should.some((c) => matchCondition(point, c))) return false;
		}
		return true;
	}

	function matchCondition(point: StoredPoint, c: QdrantFilterCondition): boolean {
		const value = point.payload[c.key];
		if (!c.match) return false;
		if (c.match.value !== undefined) return value === c.match.value;
		if (c.match.any) {
			if (Array.isArray(value)) {
				return value.some((v) => c.match!.any!.includes(v as string | number));
			}
			return c.match.any.includes(value as string | number);
		}
		return false;
	}

	return {
		collections,
		deleteCalls,
		async getCollections() {
			return { collections: [...collections.keys()].map((name) => ({ name })) };
		},
		async createCollection(name) {
			if (collections.has(name)) {
				const err = new Error('Collection already exists') as Error & { status: number };
				err.status = 409;
				throw err;
			}
			collections.set(name, []);
		},
		async deleteCollection(name) {
			deleteCalls.push(name);
			if (!collections.has(name)) {
				const err = new Error('Not found') as Error & { status: number };
				err.status = 404;
				throw err;
			}
			collections.delete(name);
		},
		async upsert(collectionName, params) {
			const list = collections.get(collectionName);
			if (!list) {
				const err = new Error('Collection not found') as Error & { status: number };
				err.status = 404;
				throw err;
			}
			for (const p of params.points) {
				const idx = list.findIndex((x) => x.id === String(p.id));
				const stored: StoredPoint = {
					id: String(p.id),
					vector: [...p.vector],
					payload: { ...(p.payload ?? {}) }
				};
				if (idx >= 0) list[idx] = stored;
				else list.push(stored);
			}
		},
		async search(collectionName, params) {
			const list = collections.get(collectionName);
			if (!list) {
				const err = new Error('Collection not found') as Error & { status: number };
				err.status = 404;
				throw err;
			}
			const scored = list
				.filter((p) => passesFilter(p, params.filter))
				.map((p) => ({
					id: p.id,
					score: score(p.vector, params.vector),
					payload: params.with_payload ? p.payload : null
				}));
			// Best-first: cosine/dot → higher is better; euclid → lower is
			// better. Mirror Qdrant's behaviour.
			if (distance === 'Euclid') scored.sort((a, b) => a.score - b.score);
			else scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, params.limit);
		},
		async delete(collectionName, params) {
			const list = collections.get(collectionName);
			if (!list) {
				const err = new Error('Collection not found') as Error & { status: number };
				err.status = 404;
				throw err;
			}
			const kept = list.filter((p) => !passesFilter(p, params.filter));
			collections.set(collectionName, kept);
		}
	};
}

async function createQdrantPluginWithFakeClient(opts?: { distance?: 'cosine' | 'dot' | 'euclid' }): Promise<{
	plugin: QdrantPlugin;
	fake: ReturnType<typeof createInMemoryQdrant>;
}> {
	const distanceUI: 'cosine' | 'dot' | 'euclid' = opts?.distance ?? 'cosine';
	const distanceQdrant: 'Cosine' | 'Dot' | 'Euclid' =
		distanceUI === 'cosine' ? 'Cosine' : distanceUI === 'dot' ? 'Dot' : 'Euclid';
	const fake = createInMemoryQdrant(distanceQdrant);
	const plugin = new QdrantPlugin({
		clientFactory: () => fake,
		settings: {
			qdrantUrl: 'http://localhost:6333',
			collectionPrefix: 'test-kb',
			vectorSize: 3,
			distance: distanceUI,
			upsertBatchSize: 128
		}
	});
	return { plugin, fake };
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

describe('QdrantPlugin — metadata', () => {
	it('reports providerType=qdrant and capability=vector-store', () => {
		const plugin = new QdrantPlugin();
		expect(plugin.id).toBe('qdrant');
		expect(plugin.providerType).toBe('qdrant');
		expect(plugin.category).toBe('vector-store');
		expect(plugin.capabilities).toContain('vector-store');
	});

	it('advertises collection tenancy and embedsOnWrite=false', () => {
		const plugin = new QdrantPlugin();
		expect(plugin.vectorCapabilities.namespacePerWork).toBe('collection');
		expect(plugin.vectorCapabilities.embedsOnWrite).toBe(false);
		expect(plugin.vectorCapabilities.supportsDelete).toBe(true);
		expect(plugin.vectorCapabilities.supportsNamespaces).toBe(true);
	});

	it('cosine normalize: -1 → 0, 0 → 0.5, 1 → 1', () => {
		const plugin = new QdrantPlugin();
		// default distance = cosine
		expect(plugin.normalize(-1)).toBe(0);
		expect(plugin.normalize(0)).toBe(0.5);
		expect(plugin.normalize(1)).toBe(1);
	});

	it('clamps non-finite raw scores defensively (NaN/Infinity → 0)', () => {
		// Defensive guard: a vendor anomaly must never escape as a
		// non-finite normalized score. clamp01 maps every non-finite
		// input (NaN, ±Infinity) to 0 — the safe lower bound — rather
		// than guessing at the operator's intent.
		const plugin = new QdrantPlugin();
		expect(plugin.normalize(NaN)).toBe(0);
		expect(plugin.normalize(Number.POSITIVE_INFINITY)).toBe(0);
		expect(plugin.normalize(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	it('euclid distance setting flips normalize behaviour (1 / (1 + d))', async () => {
		const { plugin } = await createQdrantPluginWithFakeClient({ distance: 'euclid' });
		expect(plugin.normalize(0)).toBe(1);
		expect(plugin.normalize(1)).toBe(0.5);
		expect(plugin.normalize(3)).toBeCloseTo(0.25, 5);
	});

	it('dot distance setting uses sigmoid', async () => {
		const { plugin } = await createQdrantPluginWithFakeClient({ distance: 'dot' });
		expect(plugin.normalize(0)).toBeCloseTo(0.5, 5);
		expect(plugin.normalize(100)).toBeCloseTo(1, 5);
		expect(plugin.normalize(-100)).toBeCloseTo(0, 5);
	});

	it('collectionNameFor uses the configured prefix', async () => {
		const { plugin } = await createQdrantPluginWithFakeClient();
		expect(plugin.collectionNameFor('w-42')).toBe('test-kb-w-42');
	});
});

describe('IVectorStorePlugin contract (EW-642) — qdrant', () => {
	let plugin: IVectorStorePlugin;
	let fake: ReturnType<typeof createInMemoryQdrant>;

	beforeEach(async () => {
		const built = await createQdrantPluginWithFakeClient();
		plugin = built.plugin;
		fake = built.fake;
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

	it('4. cross-Work isolation — query for w1 NEVER returns w2 hits (collection-per-Work)', async () => {
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
		// And the physical collections are distinct (collection-per-Work).
		expect([...fake.collections.keys()].sort()).toEqual(['test-kb-w1', 'test-kb-w2']);
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
		// cosine raw ∈ [-1, 1] vs normalized ∈ [0, 1] — they must differ
		// for at least one hit.
		const anyDistinct = hits.some((h) => Math.abs(h.rawScore - h.normalizedScore) > 1e-9);
		expect(anyDistinct).toBe(true);
	});

	it('deleteByWork drops the whole collection', async () => {
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

		expect(fake.collections.has('test-kb-w1')).toBe(true);

		await plugin.deleteByWork({ workId: 'w1' } satisfies DeleteByWorkInput);

		expect(fake.collections.has('test-kb-w1')).toBe(false);
		expect(fake.deleteCalls).toContain('test-kb-w1');
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

	it('queryChunks on a missing collection returns empty hits (not-found short-circuit)', async () => {
		const { hits } = await plugin.queryChunks({
			workId: 'w-does-not-exist',
			queryEmbedding: VEC.x as number[],
			topK: 5
		});
		expect(hits).toEqual([]);
	});
});

describe('buildQdrantFilter', () => {
	it('returns undefined for an empty / missing filter', () => {
		expect(buildQdrantFilter(undefined)).toBeUndefined();
		expect(buildQdrantFilter({})).toBeUndefined();
		expect(buildQdrantFilter({ tags: [] })).toBeUndefined();
	});

	it('maps documentId to a single equality match', () => {
		expect(buildQdrantFilter({ documentId: 'doc-1' })).toEqual({
			must: [{ key: 'documentId', match: { value: 'doc-1' } }]
		});
	});

	it('maps class to a single equality match', () => {
		expect(buildQdrantFilter({ class: 'research' })).toEqual({
			must: [{ key: 'class', match: { value: 'research' } }]
		});
	});

	it('maps locale to a single equality match', () => {
		expect(buildQdrantFilter({ locale: 'en' })).toEqual({
			must: [{ key: 'locale', match: { value: 'en' } }]
		});
	});

	it('maps tags to a match.any over the array', () => {
		expect(buildQdrantFilter({ tags: ['a', 'b'] })).toEqual({
			must: [{ key: 'tags', match: { any: ['a', 'b'] } }]
		});
	});

	it('AND-combines every present field into a single must clause', () => {
		const filter = buildQdrantFilter({
			documentId: 'doc-1',
			class: 'research',
			locale: 'en',
			tags: ['a']
		});
		expect(filter?.must).toHaveLength(4);
	});
});
