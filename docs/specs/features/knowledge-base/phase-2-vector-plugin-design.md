# KB Phase 2 — Vector store plugin abstraction (EW-642)

**Status**: `RFC — open for review`
**Last updated**: 2026-06-06
**Audience**: Platform engineers and reviewers shaping KB Phase 2 (semantic retrieval) and anyone adding a new vector store.
**Scope**: Define the plugin contract that lets any vector database back the KB's chunk store, the embedding strategy that feeds it, and the migration path from the pgvector-hard-coded code on `develop` to plugin-routed access.

Related:
[KB spec](spec.md) · [KB plan](plan.md) · [database architecture](../../architecture/database.md) · [plugin SDK](../../architecture/plugin-sdk.md) · [AI facade](../../architecture/ai-facade.md) · EW-693 (dynamic plugin distribution, merged) · EW-637 (`IStoragePlugin` precedent) · EW-643 (`transcribe()` precedent on `IAiProviderPlugin`).

---

## 1. Context and driving question

A reviewer raised the question during EW-641 implementation:

> "I wonder if that vector DB (e.g. pgvector) specified to be built as some sort of Plugin? E.g. we might want to use MANY different vector databases as plugins and whatever one is enabled, we use that one in KB plugin?"

**The answer is yes.** The platform's first principle is modularity through plugins (`CLAUDE.md` and `AGENTS.md`): every external service the runtime depends on — AI providers, storage, search, content extractors, screenshots, email, notification channels, deployments, git providers — is reached through a capability contract, not a hard-coded library. Vector databases must follow the same rule.

EW-693 (dynamic plugin distribution) just made this even cheaper: a vector-store plugin can ship as a `registry` package (`@ever-works/qdrant-plugin`, `@ever-works/pinecone-plugin`, …), installed on first enable without a platform redeploy. There is no longer any "extra weight" argument for keeping pgvector hard-coded.

What this RFC does **not** debate: whether pgvector stays the default — it does. It runs in the Postgres we already operate, requires zero new infrastructure, and is "good enough" for every Work we have today. The question is structural: every line of pgvector-specific SQL that exists on `develop` becomes the implementation of **one** plugin among many, behind a clean interface.

---

## 2. Current state on `develop`

Phase 2/a (EW-641, merged) already shipped real pgvector code:

- `apps/api/src/migrations/1779970000000-EnablePgvectorExtension.ts`
- `apps/api/src/migrations/1779975000000-CreateWorkKnowledgeChunks.ts`
- `packages/agent/src/entities/work-knowledge-chunk.entity.ts` — composite PK `(workId, id)`, `embedding` column declared as raw SQL `vector(N)`.
- `packages/agent/src/database/repositories/work-knowledge-chunk.repository.ts` — k-NN query with `WHERE workId = $1 ORDER BY embedding <=> $2 LIMIT k`.
- `packages/agent/src/services/knowledge-base.service.ts` — direct calls into the chunk repo for `upsert`, `semanticSearch`, and the RRF blend in `kb-rrf.ts`.
- `IAiProviderPlugin.createEmbedding` (optional capability) drives embedding generation today.

The semantic-search code path is therefore **already pluggable on the embedding side** (any AI provider plugin that ships `createEmbedding` works) but **not on the store side** (the chunk repo talks directly to `work_knowledge_chunks`). This RFC closes that gap.

---

## 3. Design decisions (top of the doc — vote here)

| # | Decision | Default recommendation |
|---|---|---|
| **D1** | Vector stores become a new plugin category `vector-store` with the `IVectorStorePlugin` contract in §4. | Adopt. |
| **D2** | The plugin **owns its own store**. The platform Postgres keeps only `(workId, documentId, chunkCount, lastEmbeddedAt)` coordinates for invalidation; the actual chunks + vectors live wherever the plugin puts them. | Adopt. |
| **D3** | Embedding generation stays on `IAiProviderPlugin.createEmbedding` (no separate plugin category). Selection is controlled by a per-Work setting `kbEmbeddingProviderId` plus an operator env pin `KB_EMBEDDING_PROVIDER_ID`, mirroring `KB_TRANSCRIPTION_PROVIDER_ID`. | Adopt; document the alternative in §5. |

The rest of the doc justifies each of these and sketches the contract + migration.

---

## 4. The `IVectorStorePlugin` contract

```ts
// packages/plugin/src/contracts/capabilities/vector-store.interface.ts

import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

export type VectorStoreProviderType = string;

export interface VectorStoreCapabilities {
    /** Server-side metadata filter pushdown (every retrieval query must filter by workId). */
    readonly supportsMetadataFilter: boolean;
    /** Hybrid (vector + keyword) scoring in a single round trip. */
    readonly supportsHybridSearch: boolean;
    /** Multi-tenant namespace / collection per Work without a per-Work index. */
    readonly supportsNamespaces: boolean;
    /** Server-side hard delete (vs soft delete + sweep). */
    readonly supportsDelete: boolean;
    /** Native embedding dimensions the backend was provisioned for. 0 = backend-managed. */
    readonly nativeDimensions: number;
    /** Backend can re-embed on write (e.g. Weaviate text2vec modules). */
    readonly embedsOnWrite: boolean;
}

export interface KnowledgeChunk {
    readonly id: string;
    readonly workId: string;
    readonly documentId: string;
    readonly chunkIndex: number;
    readonly content: string;
    readonly tokenCount: number;
    /** Caller-side embedding. May be null when `capabilities.embedsOnWrite === true`. */
    readonly embedding?: number[] | null;
    readonly metadata?: Record<string, unknown> | null;
    readonly tenantId?: string | null;
    readonly organizationId?: string | null;
}

export interface UpsertChunksInput {
    readonly workId: string;
    readonly documentId: string;
    readonly chunks: readonly KnowledgeChunk[];
    readonly settings?: PluginSettings;
}

export interface UpsertChunksResult {
    readonly written: number;
    readonly skipped: number;
}

export interface QueryChunksInput {
    readonly workId: string;
    /** Either the embedded query vector (preferred) or raw text when `embedsOnWrite`. */
    readonly queryEmbedding?: number[];
    readonly queryText?: string;
    readonly topK: number;
    /** Caller-side metadata filter, AND-combined with the mandatory workId filter. */
    readonly filter?: Record<string, unknown>;
    readonly settings?: PluginSettings;
}

export interface QueryChunkHit {
    readonly chunk: KnowledgeChunk;
    /** Distance / score is plugin-defined; consumers must treat it as ordinal only. */
    readonly score: number;
}

export interface QueryChunksResult {
    readonly hits: readonly QueryChunkHit[];
}

export interface IVectorStorePlugin extends IPlugin {
    readonly providerType: VectorStoreProviderType;
    readonly providerName: string;
    readonly capabilities: VectorStoreCapabilities;

    upsertChunks(input: UpsertChunksInput): Promise<UpsertChunksResult>;
    queryChunks(input: QueryChunksInput): Promise<QueryChunksResult>;
    deleteByDocument(input: { workId: string; documentId: string; settings?: PluginSettings }): Promise<void>;
    deleteByWork(input: { workId: string; settings?: PluginSettings }): Promise<void>;

    /** Optional escape hatch for ad-hoc non-chunk embeddings (e.g. summary vectors for §27 future work). */
    upsertEmbedding?(input: {
        readonly workId: string;
        readonly key: string;
        readonly embedding: number[];
        readonly metadata?: Record<string, unknown>;
        readonly settings?: PluginSettings;
    }): Promise<void>;

    isAvailable(settings?: PluginSettings): Promise<boolean>;
}
```

Add the category to `PLUGIN_CATEGORIES` (`packages/plugin/src/contracts/plugin-manifest.types.ts`), add `vector-store` to `SELECTABLE_PROVIDER_CATEGORIES` with `selectableInForm: false` (it's a platform-level pick, not a per-generation pick), and ship a `BaseVectorStore` abstract class under `packages/plugin/src/abstract/` that fills the obvious defaults (`isAvailable` falls back to a single round-trip `queryChunks` with `topK=0`).

**Invariants every implementation MUST honor**:

1. `workId` is the leftmost filter; cross-Work leakage is a P0 bug. The platform service layer also re-checks before returning hits.
2. `upsertChunks` is upsert-by-(workId, documentId, chunkIndex). Re-ingesting a document replaces, never appends.
3. `deleteByDocument` cascades the chunks. The platform calls it during document delete / re-ingest.
4. `queryChunks` returns at most `topK` hits, ordered best-first. Score scale is plugin-defined and consumers MUST NOT compare scores across plugins.

---

## 5. Embedding strategy

**Recommendation: keep `embed()` on `IAiProviderPlugin`** (no separate `IEmbeddingProvider` category).

Rationale:

- Slice 1 of EW-643 just added `transcribe()` to `IAiProviderPlugin` on the same justification — speech-to-text and embeddings are both "extra modalities the same provider already serves". Adding a parallel category for each would mean three categories where one suffices.
- The largest embedding providers (OpenAI, Cohere, Voyage, Mixedbread, Anthropic-via-Voyage, Vertex) are all already covered by the AI-provider category for chat completion. Forcing operators to install two plugins per vendor is friction without value.
- The runtime cost of "this AI plugin doesn't do embeddings" is one optional method check (`typeof plugin.createEmbedding === 'function'`). Cheap.

**Selection chain** for `AiFacadeService.embed()` (already implemented, now formalized):

1. `facadeOptions.providerOverride` (operator env `KB_EMBEDDING_PROVIDER_ID` threaded by the KB service).
2. Work-active or user-pinned AI provider, if it implements `createEmbedding`.
3. First registry plugin with `createEmbedding` defined AND `isAvailable()` truthy.
4. Otherwise throw `EmbeddingNotConfiguredError` → KB falls back to lexical-only retrieval.

**Per-Work setting** `kbEmbeddingProviderId` (new): if present, overrides scope-active selection so operators can keep `groq` for chat and `openai` for embeddings on the same Work without a global env pin.

**Alternative considered** — dedicated `embedding-provider` plugin category with its own `IEmbeddingProviderPlugin` interface. Trade-offs:

| Aspect | Keep on `IAiProviderPlugin` (recommended) | Dedicated `IEmbeddingProvider` |
|---|---|---|
| Vendor packaging | One plugin per vendor | Two plugins per vendor that does both |
| Lib growth | Optional method, current shape | New facade, new category, new selection chain |
| Embedding-only vendors (Voyage, Mixedbread) | Still ships as an "AI provider" with chat methods unimplemented | Cleaner — declares only the capability it serves |
| Future "embedding-only" routing UX | Harder — UI groups by provider, not capability | Easier — separate dropdown |

We can adopt the alternative later if/when the embedding-only vendor list grows past 2-3 and the chat-completion-shaped plugin shell starts to feel like a lie. Today it doesn't.

---

## 6. Selection chain for vector stores

Mirroring `AiFacadeService`:

1. **Operator pin** — `KB_VECTOR_STORE_PROVIDER_ID` env, threaded through as `facadeOptions.providerOverride`. Hard pin: missing or unavailable → throw `VectorStoreNotConfiguredError`, no fallback.
2. **Per-Work pin** — `WorkPlugin` table row marking the active vector store for this Work (same `WorkPluginRepository` the AI facade already uses).
3. **Scope-active** — registry default for the `vector-store` capability, derived from `defaultForCapabilities` on the plugin manifest.
4. **First available** — registry iteration, picking the first plugin whose `isAvailable()` is truthy.
5. **None qualifies** — throw `VectorStoreNotConfiguredError`. KB degrades to lexical-only (already the graceful-fallback path on the embedding side; same gate applies here).

The new `VectorStoreFacadeService` lives next to `AiFacadeService` in `packages/agent/src/facades/`, reuses `BaseFacadeService.resolvePlugin`, and is wired into `KnowledgeBaseService.search` / `KnowledgeBaseChunker` in place of the direct `WorkKnowledgeChunkRepository` calls.

---

## 7. Data model — plugin owns its store

The current `WorkKnowledgeChunk` entity assumes the chunk store IS a Postgres table on the platform DB. A hard plugin abstraction means we can no longer assume that — Pinecone / Weaviate / Qdrant Cloud have their own backends, and we don't want to keep a shadow copy in Postgres for them.

**Recommended shape:**

```
work_knowledge_chunk_coordinates
  - work_id           uuid    (PK part 1)
  - document_id       uuid    (PK part 2)
  - vector_store_id   text    (which plugin wrote this — registry routing key)
  - chunk_count       int
  - last_embedded_at  timestamptz
  - embedding_model   text    (for re-embed sweeps when the model changes)
  - embedding_dims    int
```

That is **all** the platform stores. The plugin owns:

- The actual chunk text + metadata.
- The vectors and the ANN index.
- The delete + upsert semantics for its backend.

Why this shape:

- Invalidation lives where it belongs: the platform knows "document D in Work W is dirty, ask the plugin to re-upsert" without needing to read the vectors itself.
- The lexical (FTS) index still lives on `work_knowledge_document.body_tsvector` — that's the platform's content, unrelated to the vector store choice.
- Re-embed sweeps and "you changed the embedding model, the old vectors are stale" detection key off `embedding_model` and `embedding_dims` columns the platform sees, not the plugin's internals.

**The pgvector plugin's "own store" happens to be a sibling Postgres table on the same database**. That's an implementation detail. From the platform's view it goes through the same `IVectorStorePlugin` boundary as Pinecone does.

**Migration shape** — the existing `work_knowledge_chunks` table is renamed `pgvector_work_knowledge_chunks` and moves into the pgvector plugin's migration set (or stays in `apps/api/src/migrations/` for now, owned by the pgvector plugin's module). The new `work_knowledge_chunk_coordinates` table is added by a tiny new migration. The existing rows are backfilled in the same migration: `INSERT INTO work_knowledge_chunk_coordinates SELECT work_id, document_id, 'pgvector', count(*), max(created_at), 'text-embedding-3-small', 1536 FROM pgvector_work_knowledge_chunks GROUP BY work_id, document_id`. Zero data loss; pgvector plugin keeps the table it already owns.

---

## 8. Default plugin: `@ever-works/pgvector-plugin`

Lives at `packages/plugins/pgvector/`. Manifest:

- `category: 'vector-store'`
- `capabilities: ['vector-store']`
- `defaultForCapabilities: ['vector-store']`
- `distribution: 'core'` (it's the platform default; ship it in the image).
- `systemPlugin: true` — operators can't disable it without picking another vector store first; the registry rejects "no vector store selected" at boot.

Settings:

- `embeddingModel` (default `text-embedding-3-small`, 1536d) — surfaced so changing the model triggers a re-embed sweep.
- `indexType` (`ivfflat` default, `hnsw` opt-in once we're on PG17+).
- `lists` / `ef_search` index tuning knobs.

Implementation:

- Wraps the existing `WorkKnowledgeChunkRepository` SQL behind `IVectorStorePlugin`. ~No business logic changes — it's the same k-NN, same composite-PK rules, same RRF integration~ — just routed through the contract.

---

## 9. Next-up plugin packages (post-EW-642)

| Plugin | Backend | License | Why ship next |
|---|---|---|---|
| `@ever-works/qdrant-plugin` | Qdrant (self-host or Cloud) | Apache 2.0 | Strong throughput, good k8s story, vendor-neutral. Easiest non-Postgres path. |
| `@ever-works/pinecone-plugin` | Pinecone (managed only) | proprietary | Customer ask — Pinecone is the default in many enterprises and serverless customers don't want to operate Postgres extensions. |

**Surveyed but not shipped first** (each gets a plugin package only when a customer asks):

- Weaviate (self-host / Cloud, BSD-3) — module-friendly, good for `embedsOnWrite=true`.
- Milvus / Zilliz Cloud (Apache 2.0) — strong throughput, heavier ops.
- Chroma (Apache 2.0) — fine for dev, less proven at scale.
- Vespa — overkill for our chunk-store use case; revisit if we add hybrid lexical+vector ranking.
- Vercel Postgres + pgvector — works with the existing pgvector plugin pointed at a different connection string; no new plugin needed.
- Supabase Vector — same; reuse the pgvector plugin with their connection.
- LanceDB — embedded / file-based; interesting for offline CLI use cases, low priority.

---

## 10. Test strategy

- **Contract tests** in `packages/plugin/src/contracts/__tests__/vector-store.spec.ts` — every plugin must pass the same suite: upsert → query (top-K), upsert idempotency, `deleteByDocument` removes only the targeted chunks, cross-Work leakage rejected.
- **Plugin tests** — pgvector plugin runs against the test Postgres (already in CI); Qdrant / Pinecone plugins run against testcontainers (Qdrant) or a recorded HTTP fixture (Pinecone), gated behind `VECTOR_STORE_E2E=1`.
- **Agent tests** — `KnowledgeBaseService` and `KnowledgeBaseChunker` get an in-memory fake `IVectorStorePlugin` so the agent-level RRF and chunking logic is tested without the DB.

---

## 11. Phase 2 sequencing (after this RFC is approved)

1. **This RFC merges to `develop`** as a design doc (no production code).
2. **EW-642 slice 1** — add the `IVectorStorePlugin` contract, `BaseVectorStore`, `VectorStoreFacadeService`, contract tests. No consumer migration yet.
3. **EW-642 slice 2** — extract the pgvector code into `@ever-works/pgvector-plugin`, route `KnowledgeBaseService` through the facade, ship `work_knowledge_chunk_coordinates` + backfill.
4. **EW-642 slice 3** — `@ever-works/qdrant-plugin`, full contract-test pass.
5. **Phase 2 acceptance** — A20-A23 unchanged in `acceptance.md`; the plugin abstraction is invisible to acceptance criteria, which only care about retrieval behavior end-to-end.

---

## 12. Open questions (for human review)

1. **`embedsOnWrite` plugins** (Weaviate text2vec) — should the platform still own embedding generation, or let the plugin handle it when the capability flag is set? Recommendation: prefer platform-side embedding (one billing line, one cache, one re-embed strategy), accept the plugin-side path only when the backend physically can't accept caller-side vectors. Need a decision.
2. **Multi-tenant collections** — Pinecone serverless prefers one index with namespace-per-Work; self-hosted Qdrant prefers one collection. The plugin owns this choice via `capabilities.supportsNamespaces`, but the platform may want a hint in the manifest about the operator-facing UX (`namespacePerWork: 'collection' | 'namespace' | 'rowFilter'`). Worth deciding before the Qdrant plugin ships.
3. **Score normalization** — every plugin returns scores on its own scale. Today consumers use the score only as an ordinal input to RRF; if we later want to expose a numeric "confidence" to the UI, we need either per-plugin calibration or a normalization helper on `BaseVectorStore`. Out of scope for slice 1.
4. **Re-embed sweeps** — when `embeddingModel` changes on the pgvector plugin's settings, do we re-embed lazily (on next document write) or schedule a Trigger.dev task? Recommendation: lazy + a CLI command to force a sweep; flagged for the Phase 2 plan.

---

End of RFC. Reviewer suggested changes welcomed inline.
