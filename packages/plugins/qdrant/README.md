# @ever-works/qdrant-plugin

Qdrant-backed vector store plugin for the Ever Works Knowledge Base. Stores chunk embeddings in a Qdrant cluster (managed Qdrant Cloud or self-hosted), one collection per Work.

## Plugin metadata

| Field           | Value                           |
| --------------- | ------------------------------- |
| ID              | `qdrant`                        |
| Category        | `vector-store`                  |
| Capabilities    | `vector-store`                  |
| Distribution    | `registry` (install-on-demand)  |
| Built-in        | no                              |
| System plugin   | no                              |
| Auto-enable     | no                              |
| Tenancy mode    | `collection` (one per Work)     |
| Embeds on write | no (caller-side embedding only) |
| Supports filter | yes (payload filter pushdown)   |
| Supports hybrid | no (vector-only retrieval)      |

## Why `namespacePerWork = 'collection'`

Self-hosted Qdrant prefers one collection per Work because:

- `deleteByWork` becomes a single `DELETE /collections/{name}` call instead of a payload-filter delete that has to scan the whole index.
- HNSW index parameters (`m`, `ef_construct`) can be tuned per tenant.
- Payload-filter pushdown stays fast — every collection is small enough that filter selectivity matters less.

A future Pinecone plugin will declare `namespacePerWork: 'namespace'` over one shared serverless index because Pinecone bills per index, not per namespace. Pgvector uses `'rowFilter'` because it shares a single Postgres table.

## Settings

| Setting            | Env var                    | Default                  | Notes                                                                                    |
| ------------------ | -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `qdrantUrl`        | `QDRANT_URL`               | `http://localhost:6333`  | HTTP(S) endpoint of the Qdrant instance.                                                 |
| `qdrantApiKey`     | `QDRANT_API_KEY`           | _(empty)_                | Secret. Required for Qdrant Cloud and any cluster behind auth.                           |
| `collectionPrefix` | `QDRANT_COLLECTION_PREFIX` | `ever-works-kb`          | Final collection name = `{prefix}-{workId}`.                                             |
| `embeddingModel`   | `KB_EMBEDDING_MODEL`       | `text-embedding-3-small` | Must match the model that produced the points already in the collection.                 |
| `vectorSize`       | `QDRANT_VECTOR_SIZE`       | `1536`                   | Changing requires re-creating the collection.                                            |
| `distance`         | `QDRANT_DISTANCE`          | `cosine`                 | `cosine` \| `dot` \| `euclid`. Drives both the collection config and `normalize()` math. |
| `upsertBatchSize`  | `QDRANT_UPSERT_BATCH_SIZE` | `128`                    | Points per `POST /points` request.                                                       |

## Normalization

Per RFC D6, every vector-store plugin maps its raw vendor score into `[0, 1]` (higher = better). The Qdrant plugin's `normalize()` branches on the configured distance metric:

- `cosine` similarity ∈ `[-1, 1]` → `(rawScore + 1) / 2`
- `dot` product unbounded → sigmoid `1 / (1 + exp(-rawScore))`
- `euclid` distance ∈ `[0, ∞)` → `1 / (1 + rawScore)`

All branches clamp the result to `[0, 1]` so a vendor anomaly cannot break the contract.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/qdrant-plugin build
pnpm --filter @ever-works/qdrant-plugin test
```

The default test command runs the in-memory contract suite (no Qdrant required). To run the live integration suite against a real Qdrant cluster (via testcontainers):

```bash
VECTOR_STORE_E2E=1 pnpm --filter @ever-works/qdrant-plugin test
```

CI runs only the in-memory suite by default to keep test time predictable.

## Specs

- RFC: `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md`
- Capability contract: `@ever-works/plugin/contracts/capabilities/vector-store.interface.ts`
- Distribution: EW-693 dynamic plugin registry (the platform image does **not** bundle this plugin).

## License

AGPL-3.0
