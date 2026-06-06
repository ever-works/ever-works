# @ever-works/pgvector-plugin

Default vector-store plugin for the Ever Works Knowledge Base. Stores chunk embeddings in the same Postgres instance the API already uses (via the `work_knowledge_chunks` table created by the agent migrations).

## Plugin metadata

| Field           | Value                          |
| --------------- | ------------------------------ |
| ID              | `pgvector`                     |
| Category        | `vector-store`                 |
| Capabilities    | `vector-store`                 |
| Default for     | `vector-store`                 |
| Distribution    | `core`                         |
| Built-in        | yes                            |
| System plugin   | yes                            |
| Auto-enable     | yes                            |
| Native dims     | 1536                           |
| Tenancy mode    | `rowFilter` (per-Work via SQL) |
| Embeds on write | no                             |

## Why pgvector is the default

- **Zero extra infrastructure.** Re-uses the API Postgres.
- **Composable.** Swap to Qdrant or Pinecone later by installing a different `vector-store` plugin — no code changes in `KnowledgeBaseService`.
- **Per-Work isolation.** Every retrieval applies `WHERE work_id = $1` (RFC §4 invariant 1).

## Settings

- **Embedding Model** — embedding model the host AI provider uses to vectorize chunks. Must match the rows already in `work_knowledge_chunks`; mismatched models retrieve from a mixed vector space and recall drops sharply. Default `text-embedding-3-small`.
- **Embedding Dimensions** — `vector(N)` column dimension. Default `1536`. Changing this requires a column-altering migration plus a full re-embed sweep.
- **ANN Index Type** — `ivfflat` (default) or `hnsw`. `hnsw` is faster at query time but needs pgvector ≥ 0.5.0 and a separate index build.
- **ivfflat `lists`** — number of inverted lists. Tune to `~sqrt(rows)`; `100` is a sane default for the per-tenant chunk counts the platform currently sees.
- **HNSW `ef_search`** — recall-vs-latency knob for HNSW. Ignored when `indexType=ivfflat`.

## Specs

- RFC: `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md`
- Capability contract: `@ever-works/plugin/contracts/capabilities/vector-store.interface.ts`
- Migrations: `apps/api/src/migrations/1779970000000-EnablePgvectorExtension.ts`, `1779975000000-CreateWorkKnowledgeChunks.ts`, `1780400000000-CreateWorkKnowledgeChunkCoordinates.ts`

## Local development

```bash
pnpm install
pnpm --filter @ever-works/pgvector-plugin build
pnpm --filter @ever-works/pgvector-plugin test
```

## License

AGPL-3.0
