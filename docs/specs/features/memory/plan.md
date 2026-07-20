# Org-wide Memory — Implementation Plan

**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)

> This plan is **additive**. Every step adds a controller, a facade method, a plugin category, a
> table, or a UI surface. Nothing existing is removed, renamed, or refactored. The per-Work KB
> workbench, the `agent-memory` capability, and the `vector-store`/`content-extractor` categories
> are untouched. Orgs that never open Memory see no change.

The plan is **three phases** matching the spec §9 phasing. Each phase is one or more PRs against
`develop` (NN #21). Every entity/schema change ships its migration in the **same PR** (NN #16).

---

## Phase P1 — Org-wide aggregation page (search + list over existing KB)

**Goal:** One org-scoped page that searches and lists everything in the org's KB. **No new
tables.** Reuses EW-651 scope columns.

### P1.1 — Repository: relax the KB list guard

- Extend `WorkKnowledgeDocumentRepository.list()`
  ([`work-knowledge-document.repository.ts`](../../../../packages/agent/src/database/repositories/work-knowledge-document.repository.ts))
  to accept an optional `workIds: string[]` IN-list **in addition to** the existing single
  `workId` / `organizationId` params.
- **Keep the mandatory-scope guard**: reject a call with none of `{ workId, organizationId,
workIds[] }`. The relaxation only adds "all Works in one org", it does not open an unscoped
  path.
- Add an index sanity check: the query filters `workId IN (…)` + `organizationId` — confirm the
  existing `(organizationId)` / `(workId)` indexes cover it; add a composite if the query planner
  needs it (migration only if an index is added).

### P1.2 — Facade: cross-Work semantic search

- Add `VectorStoreFacadeService.queryChunksAcrossWorks(workIds: string[], queryEmbedding, opts)`
  ([`vector-store-facade.service.ts`](../../../../packages/agent/src/facades/vector-store-facade.service.ts)).
    - `pgvector` (default/core): single `workId IN (…)` row-filter query.
    - namespace/collection-per-Work backends (`qdrant`): fan out per Work, merge by
      `normalizedScore`. Branch on `VectorStoreCapabilities.namespacePerWork`.
    - **Preserve the P0 invariant**: every underlying chunk query still filters `workId`. No query
      is issued without a `workId` bound.
- Add `KnowledgeBaseService.orgSemanticSearch(orgId, q, filters)` that resolves org Work ids
  (`WorkRepository.findIdsByOrganization`), embeds `q` via `AiFacadeService.embed` (degrade to
  lexical-only if no embedding provider), calls the fan-out, and RRF-blends with Postgres FTS —
  mirroring the existing per-Work `semanticSearch()` blend.

### P1.3 — API: `org-memory.controller.ts`

- New `apps/api/src/organizations/org-memory.controller.ts`, guard stack mirrored from
  [`org-kb.controller.ts`](../../../../apps/api/src/works/org-kb.controller.ts)
  (`OrganizationOwnershipGuard` + `OrganizationMembershipService.ensureMember/ensureAdmin`).
- Endpoints:
    - `GET /api/memory` — faceted union feed (KB docs + org docs + uploads + agent-memory
      read-through). Paginated (cursor).
    - `GET /api/memory/facets` — per-facet counts honoring other active filters.
    - `GET /api/memory/stats` — `{ documentsIndexed, conceptsSynthesized: 0, worksCovered,
lastIndexedAt }`.
    - `POST /api/memory/documents` — `+ New`; delegates to `KnowledgeBaseService.createOrgDocument`.
    - `GET /api/memory/documents/:id` — uniform item detail (proxies KB doc / agent-memory session).
- New service `apps/api/src/organizations/org-memory.service.ts` — builds the `MemoryItem` union
  feed, applies facets, calls `orgSemanticSearch` when `q` present, and does the agent-memory
  read-through (best-effort; empty on failure).

### P1.4 — Contracts / DTOs

- Add `MemoryItemDto`, `MemoryFeedResponseDto`, `MemoryFacetsDto`, `MemoryStatsDto`,
  `CreateMemoryDocumentDto` to `packages/contracts`.
- OpenAPI annotations on every endpoint (so the MCP server + "chat does everything" pick them up).

### P1.5 — Web: proxy + page + sidebar

- Web proxy `apps/web/src/app/api/organizations/[orgId]/memory/**` (mirrors the per-Work KB proxy;
  passes `X-Scope-Slug`).
- New route `apps/web/src/app/[locale]/(dashboard)/organizations/[slug]/memory/page.tsx` +
  legacy alias.
- Page composition (spec §4.2): search input (reuse `KbSearchPalette`), header counts, chips
  (`Type/Work/Source/Status/Tag`), List view, `+ New` dialog (reuse Tiptap editor). Graph toggle
  present but disabled (P3 tooltip).
- Sidebar: insert `{ name: t('navigation.memory'), href: ROUTES.DASHBOARD_MEMORY, icon: Brain }`
  right **after** the Agents item in
  [`DashboardSidebar.tsx`](../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx)
  (L124). Add `ROUTES.DASHBOARD_MEMORY`, hooks `useOrgMemory()` / `useMemoryFacets()`, and the
  `navigation.memory` i18n key to **all** locales.

**Tests:** repo guard (rejects unscoped, accepts workIds IN-list); facade fan-out preserves
`workId` filter; controller membership guards; `GET /api/memory` faceted shape; `+ New` writes an
org-scoped doc; Playwright — open Memory, search, filter by Type/Work, create a note.

**Out of scope P1:** graph view, cognitive-memory tables, Mission/Team chips, new plugin
categories.

---

## Phase P2 — `memory` + `rag` plugin categories + first plugin

**Goal:** Make memory frameworks and multi-doc-type RAG swappable behind a contract, beside the
existing `vector-store`/`content-extractor` categories.

### P2.1 — Category tuple + contracts

- Append `'memory'` and `'rag'` to `PLUGIN_CATEGORIES` in
  [`plugin-manifest.types.ts`](../../../../packages/plugin/src/contracts/plugin-manifest.types.ts)
  (append-only; breadcrumb comment like the `vector-store`/`job-runtime` additions).
- New `packages/plugin/src/contracts/capabilities/memory.interface.ts` — `IMemoryPlugin`
  (spec §5.2) + `MemoryScope`, `MemoryWriteInput`, `MemoryRecord`, `MemoryQuery`,
  `MemorySession`, `PromotionPassInput`, `SynthesisPassInput`.
- New `packages/plugin/src/contracts/capabilities/rag.interface.ts` — `IRagPlugin` (spec §5.3) +
  `RagIngestInput`, `RagQuery`, `RagHit`.
- Type guards + optional `base-memory.ts` / `base-rag.ts` abstracts (mirror `base-vector-store.ts`).

### P2.2 — Facades

- `MemoryFacadeService` (`packages/agent/src/facades/memory-facade.service.ts`) — selection
  cascade (env pin → per-org active `WorkPlugin`/org-plugin → `defaultForCapabilities` →
  first-enabled), mirroring `VectorStoreFacadeService`. `MemoryNotConfiguredError` degrades the
  agent-memory facet to empty rather than throwing to the page.
- `RagFacadeService` — composes `content-extractor` + `ai-provider.embed` + `vector-store` for
  `ingest`; blended `retrieve` for `orgSemanticSearch`.

### P2.3 — First-party `memory` plugin (promote `agentmemory`)

- Update [`packages/plugins/agentmemory/`](../../../../packages/plugins/agentmemory) manifest to
  declare `category: 'memory'`, `capabilities: ['memory', 'agent-memory']` — **additive**: it
  keeps the `agent-memory` capability so the shipped agent-memory pipeline is unbroken, and gains
  the org-aware `memory` capability. `defaultForCapabilities: ['memory']`.
- Implement `IMemoryPlugin` over the existing `agentmemory-client.ts` (map `remember`/`recall`
  onto `saveMemory`/`searchMemory`; `promote`/`synthesize` optional — default to no-op flat tier
  until P3).

### P2.4 — Office-doc extractor (complementary, optional)

- Land `@ever-works/officecli-extractor-plugin` as a `content-extractor` plugin per
  [`office-rendering/eval-officecli.md`](../office-rendering/eval-officecli.md)
  (`systemPlugin:false`, `autoEnable:false`, docx/xlsx/pptx text). **Run the Alpine/musl gate
  before wiring it into any image build**; fall back to `mammoth`+`SheetJS` if musl fails. This
  feeds more doc types into `rag.ingest` with no contract change.

### P2.5 — REST surface for capability management

- Extend `apps/api/src/plugins-capabilities/` with `memory/` + `rag/` sub-controllers (enable /
  select active per org), mirroring the existing capability controllers.

**Tests:** category tuple type guard; `MemoryFacadeService` selection cascade + degrade;
`agentmemory` plugin implements both capabilities without breaking the agent-memory pipeline
suite; office extractor `canExtract` + SSRF-guard reuse.

**Out of scope P2:** cognitive-memory tables, synthesis, graph, Mission/Team chips.

---

## Phase P3 — Graph + cognitive-memory model + synthesis + Mission/Team facets

**Goal:** The distilled/graph layer and the two facets that need cross-feature prerequisites.

### P3.1 — Cognitive-memory tables (migrations same-PR)

- New entities + migrations (Tier A/C conventions, EW-651): `memory_entry` (Tier A),
  `memory_concept` (Tier A), `memory_concept_link` (Tier C denormalized), enums
  `memory_partition`, `memory_tier`. Register in
  [`database.config.ts`](../../../../packages/agent/src/database/database.config.ts) `ENTITIES`
  array (**authoritative** — no `autoLoadEntities`; an unregistered `forFeature` entity throws
  `EntityMetadataNotFoundError` → 500).
- `pgvector` `embedding` columns; reuse `kb-chunker.ts` + `AiFacadeService.embed`.

### P3.2 — Auto-promotion pass

- Trigger.dev job `memory-promote` (spec §6.3): salience increment/decay, threshold-based
  `session→work→org` promotion, embedding-cosine dedupe/merge. Per-org cadence + budget cap
  (open question §10.5).

### P3.3 — Synthesis pass → concepts

- Trigger.dev job `memory-synthesize` + `POST /api/memory/synthesize` (admin-gated): cluster
  related entries/docs, summarize into `memory_concept`, write `memory_concept_link`
  `derived-from` edges. `conceptsSynthesized` counter = `COUNT(memory_concept WHERE org)`.
  Idempotent re-synthesis updates the existing concept.

### P3.4 — Graph view

- `GET /api/memory/graph` — nodes (documents/concepts/works) + edges (citations, wiki-links,
  `memory_concept_link`), honoring active filters, **server-side subgraph windowing** (cap node
  count, top-N by edge weight — open question §10.6).
- Web: new graph client component; wire the List|Graph toggle live.

### P3.5 — Mission facet (needs Prerequisite A)

- **Blocked on** a first-class Work→Mission linkage (spec §2.4-A). Recommended: denormalized
  nullable `works.missionId` (owned by Missions/Ideas/Works feature; additive column + one-time
  backfill from `acceptedFromIdeaId → WorkProposal.missionId`).
- Once present: add the `[Mission ▾]` chip + `mission[]` filter + `missionId`/`missionTitle` on
  `MemoryItem`. Feature-detect so the chip hides if the column is absent.

### P3.6 — Team facet (needs Prerequisite B — Teams feature)

- **Blocked on** `team_resources(teamId, resourceType, resourceId)` (spec §2.4-B) — a **new
  additive polymorphic join owned by the Teams feature**, NOT this one. Memory only consumes it.
- Once present: add the `[Team ▾]` chip via reverse lookup
  (`team_resources WHERE resourceType='work' AND resourceId IN (org work ids)`), joined into the
  feed. Feature-detect on the presence of `team_resources`; hide the chip if Teams hasn't shipped.

**Tests:** entity round-trips + migration idempotency; promotion threshold + dedupe; synthesis
idempotency + concept-count; graph node-cap; Mission/Team chips appear only when their
prerequisites exist.

---

## Cross-cutting concerns

### Prerequisites owned by other features (do not build here)

| Prereq | What                                                                          | Owner feature        | Blocks            |
| ------ | ----------------------------------------------------------------------------- | -------------------- | ----------------- |
| **A**  | First-class Work→Mission linkage (denormalized `works.missionId` recommended) | Missions/Ideas/Works | P3.5 Mission chip |
| **B**  | `team_resources(teamId, resourceType, resourceId)` polymorphic join           | **Teams**            | P3.6 Team chip    |

Neither blocks P1 or P2. If either slips, its chip is feature-detected and hidden; the rest of
Memory ships.

### Database safety

- Forward-only, additive migrations; no DROP / data deletion. New columns nullable on insert.
- Every P3 entity registered in the `ENTITIES` array in `database.config.ts` in the same PR
  (authoritative registration; unregistered `forFeature` → runtime 500).
- Pre-checks (fail-loud) on any backfill.

### Invariants to preserve

- **P0 chunk `workId` filter** — cross-Work search fans out per Work; never an unscoped chunk
  query.
- **KB list mandatory-scope guard** — relaxation adds a Work-ids IN-list, still rejects unscoped.
- **Agent-memory best-effort** — external backend failure degrades the facet, never the page.
- **Untrusted memory output** — fenced by consumers before any prompt injection.

### Sequencing summary

| Phase               | Depends on                     | PR target |
| ------------------- | ------------------------------ | --------- |
| P1                  | EW-651 scope columns (shipped) | `develop` |
| P2                  | P1                             | `develop` |
| P3.1–P3.4           | P2                             | `develop` |
| P3.5 (Mission chip) | Prereq A                       | `develop` |
| P3.6 (Team chip)    | Prereq B (Teams feature)       | `develop` |
