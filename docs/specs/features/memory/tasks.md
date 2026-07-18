# Org-wide Memory — Task Checklist

**Status:** Draft v1 · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Granular checklist agents and reviewers tick off as work lands. Additive by default (NN #20);
every schema change ships its migration in the same PR (NN #16).

---

## Phase P1 — Org-wide aggregation page (search + list, no new tables)

### Repository / facade

- [ ] `WorkKnowledgeDocumentRepository.list()` — accept optional `workIds: string[]` IN-list; **keep** the mandatory-scope guard (reject unscoped calls).
- [ ] `VectorStoreFacadeService.queryChunksAcrossWorks(workIds[], …)` — pgvector row-filter path + per-Work fan-out/merge for namespace-per-Work backends; **preserve P0 `workId` filter on every chunk query**.
- [ ] `KnowledgeBaseService.orgSemanticSearch(orgId, q, filters)` — resolve org Work ids via `WorkRepository.findIdsByOrganization`, embed via `AiFacadeService.embed` (degrade to lexical-only when no embedder), RRF-blend with FTS.

### API

- [ ] New `apps/api/src/organizations/org-memory.controller.ts` — guard stack mirrored from `org-kb.controller.ts`.
- [ ] `GET /api/memory` — faceted, paginated union feed (`q`, `type[]`, `work[]`, `source[]`, `status[]`, `tag[]`, `view`, `cursor`, `limit`).
- [ ] `GET /api/memory/facets` — per-facet counts honoring other active filters.
- [ ] `GET /api/memory/stats` — `{ documentsIndexed, conceptsSynthesized: 0, worksCovered, lastIndexedAt }`.
- [ ] `POST /api/memory/documents` — `+ New`; delegates to `KnowledgeBaseService.createOrgDocument` (org-scoped `WorkKnowledgeDocument`).
- [ ] `GET /api/memory/documents/:id` — uniform item detail (proxies KB doc / agent-memory session).
- [ ] New `apps/api/src/organizations/org-memory.service.ts` — builds `MemoryItem` union feed + agent-memory read-through (best-effort, empty on failure).

### Contracts

- [ ] `MemoryItemDto`, `MemoryFeedResponseDto`, `MemoryFacetsDto`, `MemoryStatsDto`, `CreateMemoryDocumentDto` in `packages/contracts`.
- [ ] OpenAPI annotations on every endpoint.

### Web

- [ ] Web proxy `apps/web/src/app/api/organizations/[orgId]/memory/**` (passes `X-Scope-Slug`).
- [ ] Route `apps/web/src/app/[locale]/(dashboard)/organizations/[slug]/memory/page.tsx` + legacy alias.
- [ ] Search input (reuse `KbSearchPalette`, org-scoped).
- [ ] Header counts row (`{documentsIndexed} documents indexed · {conceptsSynthesized} concepts synthesized`; concepts hidden/`—` until P3).
- [ ] Filter chips `[Type][Work][Source][Status][Tag]` — multi-select, count badges, clear-all.
- [ ] List view rows: title, type/source badge, Work chip, snippet, updated-at, provenance link.
- [ ] `+ New` dialog (reuse Tiptap editor) → `POST /api/memory/documents`.
- [ ] `List | Graph` toggle (Graph disabled with "coming soon" tooltip).

### Sidebar / i18n / routing

- [ ] Insert `{ name: t('navigation.memory'), href: ROUTES.DASHBOARD_MEMORY, icon: Brain }` **after** the Agents item in `DashboardSidebar.tsx` (L124).
- [ ] Add `ROUTES.DASHBOARD_MEMORY` → `/{slug}/memory` (+ legacy `/memory`).
- [ ] `navigation.memory` i18n key in **all** locales (no half-translation).
- [ ] Hooks `useOrgMemory()`, `useMemoryFacets()`.

### Tests

- [ ] Repo guard: rejects unscoped, accepts `workIds` IN-list.
- [ ] Facade fan-out preserves `workId` filter (pgvector + namespace-per-Work paths).
- [ ] Controller membership guards (member reads, admin writes).
- [ ] `GET /api/memory` faceted shape + pagination.
- [ ] `+ New` writes an org-scoped doc (workId NULL, organizationId set, XOR CHECK holds).
- [ ] Playwright: open Memory → search → filter Type/Work → create note → appears in feed.

---

## Phase P2 — `memory` + `rag` plugin categories + first plugin

### Contracts / categories

- [ ] Append `'memory'` and `'rag'` to `PLUGIN_CATEGORIES` in `plugin-manifest.types.ts` (append-only + breadcrumb comment).
- [ ] `packages/plugin/src/contracts/capabilities/memory.interface.ts` — `IMemoryPlugin` + `MemoryScope`, `MemoryWriteInput`, `MemoryRecord`, `MemoryQuery`, `MemorySession`, `PromotionPassInput`, `SynthesisPassInput`.
- [ ] `packages/plugin/src/contracts/capabilities/rag.interface.ts` — `IRagPlugin` + `RagIngestInput`, `RagQuery`, `RagHit`.
- [ ] Type guards + optional `base-memory.ts` / `base-rag.ts` abstracts (mirror `base-vector-store.ts`).

### Facades

- [ ] `MemoryFacadeService` (`packages/agent/src/facades/memory-facade.service.ts`) — selection cascade + `MemoryNotConfiguredError` degrade-to-empty.
- [ ] `RagFacadeService` — composes `content-extractor` + `ai-provider.embed` + `vector-store` for `ingest`; blended `retrieve`.

### First-party `memory` plugin

- [ ] `packages/plugins/agentmemory/` manifest → `category: 'memory'`, `capabilities: ['memory','agent-memory']` (**additive** — keep `agent-memory`), `defaultForCapabilities: ['memory']`.
- [ ] Implement `IMemoryPlugin` over `agentmemory-client.ts` (`remember`/`recall`; `promote`/`synthesize` no-op flat tier until P3).
- [ ] Verify the shipped agent-memory pipeline suite still passes (no regression).

### Office-doc extractor (complementary)

- [ ] `@ever-works/officecli-extractor-plugin` as `content-extractor` (docx/xlsx/pptx text; `systemPlugin:false`, `autoEnable:false`) per office eval.
- [ ] **Run the Alpine/musl gate before wiring into any image build**; `mammoth`+`SheetJS` fallback if musl fails.

### Capability REST

- [ ] `apps/api/src/plugins-capabilities/memory/` + `rag/` sub-controllers (enable / select active per org).

### Tests

- [ ] Category tuple type guard accepts `memory`/`rag`.
- [ ] `MemoryFacadeService` selection cascade + degrade path.
- [ ] `agentmemory` plugin satisfies both capabilities; agent-memory pipeline unbroken.
- [ ] Office extractor `canExtract` + SSRF-guard/byte-cap reuse.

---

## Phase P3 — Graph + cognitive-memory model + synthesis + Mission/Team facets

### Cognitive-memory tables (migrations same-PR)

- [ ] `memory_entry` entity + migration (Tier A: nullable `tenantId`+`organizationId`; `partition`, `tier`, `embedding vector(1536)`, `salience`, source correlation cols).
- [ ] `memory_concept` entity + migration (Tier A; `entryCount`, `lastSynthesizedAt`).
- [ ] `memory_concept_link` entity + migration (Tier C denormalized; `(targetType,targetId)` index for graph edges).
- [ ] Enums `memory_partition` (working/episodic/semantic/procedural/user-model), `memory_tier` (session/work/org/global).
- [ ] Register all three entities in `database.config.ts` `ENTITIES` array (**same PR**; unregistered `forFeature` → runtime 500).

### Passes

- [ ] Trigger.dev `memory-promote` — salience increment/decay, threshold `session→work→org` promotion, embedding-cosine dedupe/merge; per-org cadence + budget cap.
- [ ] Trigger.dev `memory-synthesize` + `POST /api/memory/synthesize` (admin-gated) — cluster → summarize → `memory_concept` + `derived-from` links; idempotent re-synthesis.
- [ ] `GET /api/memory/stats` `conceptsSynthesized` = `COUNT(memory_concept WHERE org)`.

### Graph view

- [ ] `GET /api/memory/graph` — nodes + edges (citations, wiki-links, `memory_concept_link`), filter-aware, **server-side subgraph windowing** (node cap, top-N by weight).
- [ ] Web graph client component; wire List|Graph toggle live.

### Mission facet — **blocked on Prerequisite A**

- [ ] (Prereq, other feature) First-class Work→Mission linkage — recommended nullable `works.missionId` + one-time backfill from `acceptedFromIdeaId → WorkProposal.missionId`. **Owned by Missions/Ideas/Works, not this feature.**
- [ ] Add `[Mission ▾]` chip + `mission[]` filter + `missionId`/`missionTitle` on `MemoryItem`; feature-detect (hide if column absent).

### Team facet — **blocked on Prerequisite B (Teams feature)**

- [ ] (Prereq, Teams feature) `team_resources(teamId, resourceType, resourceId)` polymorphic join + Tier C scope cols + `(resourceType,resourceId)` reverse index + `(organizationId,teamId)` index. **New additive table owned by the Teams feature, NOT built here.**
- [ ] Add `[Team ▾]` chip via reverse lookup (`team_resources WHERE resourceType='work' AND resourceId IN (org work ids)`); feature-detect on presence of `team_resources` (hide if Teams unshipped).

### Tests

- [ ] Entity round-trips + migration idempotency (all three P3 tables).
- [ ] Promotion threshold + dedupe/merge correctness.
- [ ] Synthesis idempotency + concept-count counter.
- [ ] Graph node-cap / windowing.
- [ ] Mission chip appears only when `works.missionId` exists; Team chip only when `team_resources` exists.

---

## Cross-cutting

- [ ] Update `apps/docs/` user-facing docs: Memory (org-wide knowledge) + memory/rag plugin categories.
- [ ] No existing UI string changes other than additions (NN #20).
- [ ] Every entity touched ships its migration in the same PR (NN #16).
- [ ] All PRs target `develop` (NN #21); two consecutive green E2E runs before merge cascade.
- [ ] Invariants preserved: P0 chunk `workId` filter; KB list mandatory-scope guard; agent-memory best-effort; untrusted memory output fenced.

---

## Prerequisite ownership (tracked outside this feature)

| Prereq | Table/column | Owner feature | Consumed by |
| ------ | ------------ | ------------- | ----------- |
| A | `works.missionId` (denormalized, recommended) | Missions / Ideas / Works | P3 Mission chip |
| B | `team_resources(teamId, resourceType, resourceId)` | **Teams** | P3 Team chip |

Neither blocks P1/P2. Flag on the respective feature specs so they are not lost.

---

## JIRA linkage

Epic + per-phase Stories to be created in the `EW` project (keys added once tickets exist):

- **Epic:** Org-wide Memory (Cortex)
    - P1 — Aggregation page (search + list): _TBD_
    - P2 — `memory` + `rag` plugin categories + first plugin: _TBD_
    - P3 — Graph + cognitive-memory model + synthesis + Mission/Team facets: _TBD_
    - Prereq A — Work→Mission linkage (Missions/Ideas/Works epic): _TBD_
    - Prereq B — `team_resources` join (Teams epic): _TBD_
