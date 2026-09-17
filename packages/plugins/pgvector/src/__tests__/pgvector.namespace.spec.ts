/**
 * AW-07 — pgvector serving namespaces that are not a Work.
 *
 * `work_knowledge_chunks` keys every row by a Work (`work_id` and
 * `document_id` are foreign keys), so a workspace's memory-fact namespace
 * cannot be written there. The host supplies a second repository of the
 * same `PgVectorChunkRepositoryPort` shape over the namespace-keyed
 * `vector_namespace_chunks` table plus a `workNamespaces.isWork(id)` probe.
 *
 * Harness: the same in-memory, cosine-distance port the contract suite in
 * `pgvector.plugin.spec.ts` uses — one instance per table — so the plugin's
 * routing is exercised without a live Postgres. The SQL behind each port
 * (`WorkKnowledgeChunkRepository`, `VectorNamespaceChunkRepository`) is
 * covered in `@ever-works/agent`'s repository specs.
 *
 * Pinned here:
 *   1. a fact embed + semantic query round trip in a namespace that is not
 *      a Work lands in, and is served from, the namespace table only;
 *   2. one namespace can never read another's vectors;
 *   3. Work-scoped KB chunk writes / reads reach the Work repository with
 *      byte-for-byte the arguments they had before namespace routing
 *      existed, and return the same hits;
 *   4. the host wiring is adopted from the plugin host's custom-capability
 *      channel, without overriding explicit wiring.
 */

import { describe, it, expect } from 'vitest';
import type { KnowledgeChunk, PluginContext } from '@ever-works/plugin';
import {
	PGVECTOR_HOST_CHUNK_TABLES_CAPABILITY,
	PgVectorPlugin,
	type PgVectorChunkRepositoryPort,
	type PgVectorHostChunkTables
} from '../pgvector.plugin.js';

interface StoredRow {
	id: string;
	key: string;
	documentId: string;
	chunkIndex: number;
	content: string;
	embedding: number[];
	metadata: Record<string, unknown> | null;
	tenantId?: string | null;
	organizationId?: string | null;
}

type RecordedCall = { method: string; args: unknown[] };

function cosineDistance(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let nA = 0;
	let nB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		nA += a[i] * a[i];
		nB += b[i] * b[i];
	}
	if (nA === 0 || nB === 0) return 1;
	return 1 - dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

/**
 * In-memory port keyed by its leftmost column (work_id for the Work table,
 * namespace_id for the namespace table). Records every call verbatim so the
 * regression test can compare arguments exactly.
 */
function createRecordingRepository(options: { leakAcrossKeys?: boolean } = {}): PgVectorChunkRepositoryPort & {
	rows: StoredRow[];
	calls: RecordedCall[];
} {
	const rows: StoredRow[] = [];
	const calls: RecordedCall[] = [];
	return {
		rows,
		calls,
		async replaceForDocument(key, documentId, chunks) {
			calls.push({ method: 'replaceForDocument', args: [key, documentId, structuredClone(chunks)] });
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i].key === key && rows[i].documentId === documentId) rows.splice(i, 1);
			}
			for (const c of chunks) {
				rows.push({
					id: c.id,
					key,
					documentId: c.documentId,
					chunkIndex: c.chunkIndex,
					content: c.content,
					embedding: (c.embedding ?? []) as number[],
					metadata: c.metadata ?? null,
					...('tenantId' in c ? { tenantId: c.tenantId } : {}),
					...('organizationId' in c ? { organizationId: c.organizationId } : {})
				});
			}
		},
		async findNearestByEmbedding(key, embedding, limit) {
			calls.push({ method: 'findNearestByEmbedding', args: [key, [...embedding], limit] });
			return rows
				.filter((row) => options.leakAcrossKeys || row.key === key)
				.map((row) => ({
					id: row.id,
					workId: row.key,
					documentId: row.documentId,
					chunkIndex: row.chunkIndex,
					content: row.content,
					distance: cosineDistance(row.embedding, embedding)
				}))
				.sort((a, b) => a.distance - b.distance)
				.slice(0, Math.max(0, limit));
		},
		async deleteByDocument(key, documentId) {
			calls.push({ method: 'deleteByDocument', args: [key, documentId] });
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i].key === key && rows[i].documentId === documentId) rows.splice(i, 1);
			}
		},
		async deleteByWork(key) {
			calls.push({ method: 'deleteByWork', args: [key] });
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i].key === key) rows.splice(i, 1);
			}
		}
	};
}

const WORK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NS_A = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';
const NS_B = 'cccccccc-cccc-5ccc-8ccc-cccccccccccc';

const KB_DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const VEC = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function workProbe(workIds: readonly string[]) {
	const asked: string[] = [];
	return {
		asked,
		async isWork(id: string) {
			asked.push(id);
			return workIds.includes(id);
		}
	};
}

function factChunk(namespace: string, factId: string, embedding: number[], body = `fact ${factId}`): KnowledgeChunk {
	return {
		id: factId,
		workId: namespace,
		documentId: factId,
		chunkIndex: 0,
		content: body,
		tokenCount: 3,
		embedding,
		metadata: { kind: 'memory-fact', scope: 'workspace', agentId: null },
		tenantId: 't-1',
		organizationId: 'o-1'
	};
}

function kbChunk(id: string, chunkIndex: number, embedding: number[]): KnowledgeChunk {
	return {
		id,
		workId: WORK_ID,
		documentId: KB_DOC_ID,
		chunkIndex,
		content: `kb ${id}`,
		tokenCount: 2,
		embedding,
		metadata: { headingPath: ['Brand voice'] },
		tenantId: 't-1',
		organizationId: 'o-1'
	};
}

function routedPlugin() {
	const workRepo = createRecordingRepository();
	const namespaceRepo = createRecordingRepository();
	const probe = workProbe([WORK_ID]);
	const plugin = new PgVectorPlugin({
		chunkRepository: workRepo,
		namespaceChunkRepository: namespaceRepo,
		workNamespaces: probe
	});
	return { plugin, workRepo, namespaceRepo, probe };
}

describe('PgVectorPlugin — namespaces that are not a Work (AW-07)', () => {
	it('round trip: a fact embeds into the namespace table and a semantic query returns it', async () => {
		const { plugin, workRepo, namespaceRepo } = routedPlugin();

		await plugin.upsertChunks({
			workId: NS_A,
			documentId: 'f-close',
			chunks: [factChunk(NS_A, 'f-close', VEC.x, 'We never quote under ten days')]
		});
		await plugin.upsertChunks({
			workId: NS_A,
			documentId: 'f-far',
			chunks: [factChunk(NS_A, 'f-far', VEC.z, 'Invoices go out on the 1st')]
		});

		expect(workRepo.calls).toEqual([]);
		expect(namespaceRepo.rows.map((r) => [r.key, r.id])).toEqual([
			[NS_A, 'f-close'],
			[NS_A, 'f-far']
		]);
		// The namespace table records the owning workspace.
		expect(namespaceRepo.rows[0]).toMatchObject({ tenantId: 't-1', organizationId: 'o-1' });

		const result = await plugin.queryChunks({ workId: NS_A, queryEmbedding: [0.9, 0.1, 0], topK: 5 });
		expect(result.hits.map((h) => h.chunk.documentId)).toEqual(['f-close', 'f-far']);
		expect(result.hits[0].normalizedScore).toBeGreaterThan(result.hits[1].normalizedScore);
		expect(result.hits.every((h) => h.chunk.workId === NS_A)).toBe(true);
		expect(workRepo.calls).toEqual([]);
	});

	it('re-embedding a fact replaces its vector — never a second one', async () => {
		const { plugin, namespaceRepo } = routedPlugin();
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-1', chunks: [factChunk(NS_A, 'f-1', VEC.x)] });
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-1', chunks: [factChunk(NS_A, 'f-1', VEC.y)] });
		expect(namespaceRepo.rows).toHaveLength(1);
		expect(namespaceRepo.rows[0].embedding).toEqual(VEC.y);
	});

	it('isolation: a query in one workspace namespace never returns another namespace’s vectors', async () => {
		const { plugin } = routedPlugin();
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] });
		await plugin.upsertChunks({ workId: NS_B, documentId: 'f-b', chunks: [factChunk(NS_B, 'f-b', VEC.x)] });

		const a = await plugin.queryChunks({ workId: NS_A, queryEmbedding: VEC.x, topK: 10 });
		const b = await plugin.queryChunks({ workId: NS_B, queryEmbedding: VEC.x, topK: 10 });

		expect(a.hits.map((h) => h.chunk.documentId)).toEqual(['f-a']);
		expect(b.hits.map((h) => h.chunk.documentId)).toEqual(['f-b']);
	});

	it('isolation holds even if a namespace repository ever leaked rows across keys', async () => {
		const workRepo = createRecordingRepository();
		const leaky = createRecordingRepository({ leakAcrossKeys: true });
		const plugin = new PgVectorPlugin({
			chunkRepository: workRepo,
			namespaceChunkRepository: leaky,
			workNamespaces: workProbe([])
		});
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] });
		await plugin.upsertChunks({ workId: NS_B, documentId: 'f-b', chunks: [factChunk(NS_B, 'f-b', VEC.x)] });

		const b = await plugin.queryChunks({ workId: NS_B, queryEmbedding: VEC.x, topK: 10 });
		expect(b.hits.map((h) => h.chunk.documentId)).toEqual(['f-b']);
	});

	it('forget / purge deletes route to the namespace table and stay inside the namespace', async () => {
		const { plugin, workRepo, namespaceRepo } = routedPlugin();
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] });
		await plugin.upsertChunks({ workId: NS_B, documentId: 'f-b', chunks: [factChunk(NS_B, 'f-b', VEC.x)] });

		await plugin.deleteByDocument({ workId: NS_A, documentId: 'f-a' });
		expect(namespaceRepo.rows.map((r) => r.id)).toEqual(['f-b']);

		await plugin.deleteByWork({ workId: NS_B });
		expect(namespaceRepo.rows).toEqual([]);
		expect(workRepo.calls).toEqual([]);
	});

	it('a failing Work probe surfaces a retriable internal error and writes nothing', async () => {
		const workRepo = createRecordingRepository();
		const namespaceRepo = createRecordingRepository();
		const plugin = new PgVectorPlugin({
			chunkRepository: workRepo,
			namespaceChunkRepository: namespaceRepo,
			workNamespaces: {
				isWork: async () => {
					throw new Error('connection reset');
				}
			}
		});
		await expect(
			plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] })
		).rejects.toMatchObject({ name: 'VectorStoreError', code: 'internal', retriable: true });
		expect(workRepo.calls).toEqual([]);
		expect(namespaceRepo.calls).toEqual([]);
	});
});

describe('PgVectorPlugin — Work-scoped Knowledge Base behaviour is unchanged (regression)', () => {
	async function runKbScenario(plugin: PgVectorPlugin) {
		await plugin.upsertChunks({
			workId: WORK_ID,
			documentId: KB_DOC_ID,
			chunks: [kbChunk('c-0', 0, VEC.x), kbChunk('c-1', 1, VEC.y)]
		});
		const hits = await plugin.queryChunks({ workId: WORK_ID, queryEmbedding: VEC.x, topK: 2 });
		await plugin.deleteByDocument({ workId: WORK_ID, documentId: KB_DOC_ID });
		await plugin.deleteByWork({ workId: WORK_ID });
		return hits;
	}

	it('hands the Work repository byte-for-byte the same calls with namespace routing wired as without it', async () => {
		const legacyRepo = createRecordingRepository();
		const legacyHits = await runKbScenario(new PgVectorPlugin({ chunkRepository: legacyRepo }));

		const { plugin, workRepo, namespaceRepo, probe } = routedPlugin();
		const routedHits = await runKbScenario(plugin);

		expect(workRepo.calls).toEqual(legacyRepo.calls);
		expect(JSON.stringify(workRepo.calls)).toBe(JSON.stringify(legacyRepo.calls));
		expect(routedHits).toEqual(legacyHits);
		expect(namespaceRepo.calls).toEqual([]);
		// Work rows never gain the namespace-only scope fields.
		const [, , rows] = workRepo.calls[0].args as [string, string, Array<Record<string, unknown>>];
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(
				['chunkIndex', 'content', 'documentId', 'embedding', 'id', 'metadata', 'tokenCount'].sort()
			);
		}
		expect(probe.asked.every((id) => id === WORK_ID)).toBe(true);
	});

	it('without namespace routing wired, every namespace still goes to the Work repository (pre-AW-07 path)', async () => {
		const workRepo = createRecordingRepository();
		const plugin = new PgVectorPlugin({ chunkRepository: workRepo });
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] });
		expect(workRepo.calls.map((c) => c.method)).toEqual(['replaceForDocument']);
	});
});

describe('PgVectorPlugin — host wiring through the plugin host (AW-07)', () => {
	function contextWith(tables: PgVectorHostChunkTables | undefined): PluginContext {
		const logger = { log() {}, warn() {}, error() {}, debug() {} };
		return {
			pluginId: 'under-test',
			logger,
			getCustomCapability: <T>(name: string) =>
				(name === PGVECTOR_HOST_CHUNK_TABLES_CAPABILITY ? tables : undefined) as T | undefined
		} as unknown as PluginContext;
	}

	it('pins the capability name the host publishes under', () => {
		expect(PGVECTOR_HOST_CHUNK_TABLES_CAPABILITY).toBe('vector-store:host-chunk-tables');
	});

	it('adopts the host tables from its PluginContext and serves facts and the KB through them', async () => {
		const workRepo = createRecordingRepository();
		const namespaceRepo = createRecordingRepository();
		const plugin = new PgVectorPlugin();
		expect(await plugin.isAvailable()).toBe(false);

		await plugin.onLoad(
			contextWith({
				chunkRepository: workRepo,
				namespaceChunkRepository: namespaceRepo,
				workNamespaces: workProbe([WORK_ID]),
				pingDatabase: async () => true
			})
		);

		expect(await plugin.isAvailable()).toBe(true);
		await plugin.upsertChunks({ workId: NS_A, documentId: 'f-a', chunks: [factChunk(NS_A, 'f-a', VEC.x)] });
		await plugin.upsertChunks({ workId: WORK_ID, documentId: KB_DOC_ID, chunks: [kbChunk('c-0', 0, VEC.x)] });
		expect(namespaceRepo.rows.map((r) => r.id)).toEqual(['f-a']);
		expect(workRepo.rows.map((r) => r.id)).toEqual(['c-0']);
	});

	it('reports unavailable when the host probe says the database cannot serve vectors', async () => {
		const plugin = new PgVectorPlugin();
		await plugin.onLoad(
			contextWith({ chunkRepository: createRecordingRepository(), pingDatabase: async () => false })
		);
		expect(await plugin.isAvailable()).toBe(false);
	});

	it('explicit wiring wins over the host capability', async () => {
		const explicitRepo = createRecordingRepository();
		const hostRepo = createRecordingRepository();
		const plugin = new PgVectorPlugin({ chunkRepository: explicitRepo });
		await plugin.onLoad(contextWith({ chunkRepository: hostRepo }));

		await plugin.upsertChunks({ workId: WORK_ID, documentId: KB_DOC_ID, chunks: [kbChunk('c-0', 0, VEC.x)] });
		expect(explicitRepo.calls).toHaveLength(1);
		expect(hostRepo.calls).toEqual([]);
	});

	it('still fails loudly (unavailable) when neither explicit wiring nor the host capability exists', async () => {
		const plugin = new PgVectorPlugin();
		await plugin.onLoad(contextWith(undefined));
		await expect(plugin.queryChunks({ workId: WORK_ID, queryEmbedding: VEC.x, topK: 1 })).rejects.toMatchObject({
			name: 'VectorStoreError',
			code: 'unavailable'
		});
	});
});
