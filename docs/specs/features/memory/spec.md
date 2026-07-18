# Org-wide Memory — Product Spec

**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-07-18
**Audience:** Product, Engineering (backend + frontend + AI), Design
**Internal codename:** "Cortex"
**Related code today:**

- Per-Work knowledge base (the `WorkKnowledgeDocument` family) — [`work-knowledge-document.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-document.entity.ts), [`work-knowledge-chunk.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-chunk.entity.ts), [`work-knowledge-upload.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-upload.entity.ts), [`work-knowledge-tag.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-tag.entity.ts), [`work-knowledge-citation.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-citation.entity.ts), [`work-knowledge-chunk-coordinate.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-chunk-coordinate.entity.ts); service [`knowledge-base.service.ts`](../../../../packages/agent/src/services/knowledge-base.service.ts); doc classes/enums [`kb-types.ts`](../../../../packages/agent/src/services/kb-types.ts)
- Org-level KB overlay controller (guards to mirror) — [`org-kb.controller.ts`](../../../../apps/api/src/works/org-kb.controller.ts); per-Work controller [`kb.controller.ts`](../../../../apps/api/src/works/kb.controller.ts)
- Org enumeration helper — `WorkRepository.findIdsByOrganization(orgId)` ([`work.repository.ts`](../../../../packages/agent/src/database/repositories/work.repository.ts))
- Multi-Work list guard to relax — `WorkKnowledgeDocumentRepository.list()` ([`work-knowledge-document.repository.ts`](../../../../packages/agent/src/database/repositories/work-knowledge-document.repository.ts))
- Agent memory (external backend, correlated in Postgres) — `AgentRun.memorySessionId` ([`agent-run.entity.ts`](../../../../packages/agent/src/entities/agent-run.entity.ts)); capability contract [`agent-memory.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/agent-memory.interface.ts); first-party provider [`packages/plugins/agentmemory/`](../../../../packages/plugins/agentmemory); shipped spec [`agent-memory/spec.md`](../agent-memory/spec.md)
- Embedding + retrieval seams — `IAiProviderPlugin.createEmbedding?()` ([`ai-provider.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/ai-provider.interface.ts)), vector-store capability [`vector-store.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/vector-store.interface.ts), facade [`vector-store-facade.service.ts`](../../../../packages/agent/src/facades/vector-store-facade.service.ts)
- Plugin category tuple — `PLUGIN_CATEGORIES` in [`plugin-manifest.types.ts`](../../../../packages/plugin/src/contracts/plugin-manifest.types.ts) (17 categories today; `memory`/`rag` do not exist yet)
- Content-extractor seam (ingest) — [`content-extractor.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/content-extractor.interface.ts); office-doc extractor evaluation [`office-rendering/eval-officecli.md`](../office-rendering/eval-officecli.md)
- Scope columns from EW-651 — `Work.organizationId`, `WorkKnowledgeDocument.organizationId` (real FK), denormalized `organizationId` on chunk/upload/tag/citation
- Sidebar nav — [`DashboardSidebar.tsx`](../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) L109-129 (nav array; Agents at L124)

> **Scope of this document:** product behavior — concepts, the aggregation surface, UX, data shape, plugin contracts, phasing. Implementation details are referenced where they constrain behavior. The phased execution plan lives in the sibling [plan.md](plan.md); the task checklist in [tasks.md](tasks.md).
>
> **Hard rule (additive by default — NN #20):** This feature **EXTENDS**, it removes and renames nothing internal. The per-Work Knowledge Base workbench keeps working exactly as it does today; Memory is a **new read-mostly aggregation layer above it**, plus (in later phases) new tables and two new plugin categories that sit **beside** the existing ones. No existing entity, column, endpoint, route, plugin category, or UI surface is dropped, renamed, or repurposed. Every new column is nullable on insert; every new table stands alone; every new plugin category is appended to the tuple. Organizations that never open Memory are unaffected. The existing `agent-memory` capability, the `WorkKnowledgeDocument` family, and the `vector-store` + `content-extractor` categories are all preserved as-is.

---

## 0. TL;DR

Today, knowledge lives **per Work** (the KB workbench at `/works/:id/kb`) and agent memory
lives in an **external backend** correlated only by `agent_runs.memorySessionId`. There is no
single place to see *everything an Organization knows*. **Memory** is that place: a new
**org-wide** page, reachable from a new sidebar item **below Agents**, that aggregates every
knowledge document, chunk, and agent-memory session across every Work / Mission / Agent in the
currently-selected Organization — searchable, filterable, viewable as a list or a graph.

```
                         ┌──────────────────────────────────────────────┐
   Sidebar               │  MEMORY  (org-scoped)                         │
   ─────────             │  ┌────────────────────────────────────────┐  │
   Dashboard             │  │  🔎 search across the whole org…        │  │
   Missions              │  └────────────────────────────────────────┘  │
   Ideas                 │  [ 428 documents indexed · 63 concepts ]     │  header counts
   Works                 │  chips: [Type▾][Work▾][Mission▾][Team▾][Src▾]│  facet filters
   Tasks                 │  ┌─── List ───┐  ┌─── Graph ───┐   [+ New]   │  views + create
   Agents                │  │ • brand.md │  │      (o)—(o)  │            │
 » Memory   ◄── NEW      │  │ • personas │  │     /  |   \  │            │
   Templates             │  │ • run-4711 │  │   (o)-(o)-(o) │            │
   Plugins               │  └────────────┘  └──────────────┘            │
   …                     └──────────────────────────────────────────────┘
                                     │ GET /api/memory (org-scoped, faceted)
             ┌───────────────────────┼───────────────────────────────┐
             ▼                       ▼                               ▼
   WorkKnowledgeDocument      AgentRun.memorySessionId        memory_entry / memory_concept
   family (per-Work KB)       → agent-memory plugin backend   (P3 cognitive-memory model)
   organizationId already     (external, best-effort)         Tier A scope columns
   present → fan-in by org    correlated in Postgres          synthesis → "concepts" counter
```

Three capabilities ship in sequence:

1. **P1 — Aggregation page.** Search + list over the existing per-Work KB, fanned in across the
   Organization. Reuses the columns EW-651 already added; no new tables. `+ New` creates an
   org-level note/document.
2. **P2 — Pluggable memory.** Two **new plugin categories** — `memory` and `rag` — so memory
   frameworks and multi-doc-type retrieval pipelines are swappable behind a contract, exactly the
   way `vector-store` and `content-extractor` already are. Ship the categories + the first
   first-party `memory` plugin (promoting today's `agent-memory` provider into the new category).
3. **P3 — Cognitive memory + graph.** A new **cognitive-memory data model** (partitions ×
   tiers), an auto-promotion pass, and a synthesis pass that compiles raw entries into **linked
   concept pages** (the "concepts synthesized" counter). Plus the graph view and the
   **Mission** and **Team** filter chips — both of which depend on prerequisites called out in
   §2.4.

> **Two hard prerequisites for the Mission and Team facets (§2.4):** filtering Memory by
> **Work → Mission** needs a first-class Work→Mission linkage (today it is a two-hop traversal
> `Work.acceptedFromIdeaId → WorkProposal.missionId`), and filtering by **Team** needs a
> Work/Task/Mission ↔ Team association that **does not exist yet**. The Team association is a
> **new additive polymorphic join** (`team_resources(teamId, resourceType, resourceId)`) that
> belongs to the **Teams** feature, not this one. Both are flagged as blockers on the P3 facets;
> P1/P2 do not need them.

---

## 1. Concepts

### 1.1 Memory (the surface)

**Memory** is the Organization's single, aggregated view of everything it has learned — pulled
together from sources that are, today, scattered per-Work and per-run. It answers the question a
founder actually has: *"what does my company know about X?"* — not *"which Work's KB do I have to
open to find it?"*

Memory is **read-mostly and additive**. It does not own the per-Work KB documents; it **reads
across** them. The only rows Memory itself writes in P1 are org-level notes created via `+ New`
(which are ordinary `WorkKnowledgeDocument` rows with `organizationId` set and `workId` NULL —
the org-document shape the KB service already supports via `createOrgDocument`).

### 1.2 Knowledge sources aggregated

| Source                          | Where it lives today                                                                 | How Memory reaches it                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Per-Work KB documents**       | `work_knowledge_documents` (row = metadata; body in the Work's Git data repo)        | Fan-in by `organizationId` (real FK) over all Works in the org                        |
| **Org-level KB documents**      | Same table, `organizationId` set + `workId` NULL (`KB_ORG_INHERITABLE_CLASSES`)      | Already org-scoped; included directly                                                 |
| **KB chunks / embeddings**      | `work_knowledge_chunks` (pgvector) + vector-store plugin store                       | Semantic search fanned across the org's Works (§3.2)                                  |
| **KB uploads (source files)**   | `work_knowledge_uploads` (bytes in Storage plugin)                                   | Listed as provenance under their extracted documents                                 |
| **Agent memory sessions**       | External agent-memory backend; correlated by `agent_runs.memorySessionId`            | Read-through the `agent-memory` plugin, keyed by the org's Works/Agents (best-effort) |
| **Synthesized concepts (P3)**   | New `memory_concept` table                                                           | First-class Memory rows                                                               |

> **Agent memory stays external.** Per the shipped [agent-memory spec](../agent-memory/spec.md),
> there is deliberately **no Postgres table for memory entries** — they live in the plugin
> backend. Memory surfaces agent-memory as a **read-through facet**, never by trying to mirror it
> into our DB. Every agent-memory call is **best-effort**: a backend that is down or a provider
> that lacks `listSessions` degrades the agent-memory facet to empty, it never fails the page.

### 1.3 Views

- **List** — the default. A flat, ranked, filterable list of knowledge items (documents, notes,
  agent-memory sessions, concepts). This is all P1 needs.
- **Graph** — P3. A node-link view where nodes are documents / concepts / Works and edges are
  citations (`work_knowledge_citations`), wiki-links (already rewritten by
  `knowledge-base-wikilink-rewriter.service.ts`), and concept links (`memory_concept_link`). The
  graph is a *rendering of relationships that already exist in data*, not a new source of truth.

### 1.4 Concepts (synthesized)

A **Concept** (P3) is a compiled, deduplicated page that a synthesis pass produces from many raw
memory entries and documents — e.g. a single "Ideal Customer Profile" concept assembled from
personas docs across three Works plus what agents observed in runs. Concepts are the unit the
header's **"concepts synthesized"** counter counts. They are Ever Works' own notion of "distilled
long-term knowledge", distinct from raw indexed documents.

### 1.5 Memory framework & RAG as plugins

The mechanics of *how* memory is stored, promoted, retrieved, and synthesized are **pluggable**.
Two new capability contracts (§5) let an Organization swap the whole memory framework
(`IMemoryPlugin`) or the multi-doc-type retrieval pipeline (`IRagPlugin`) the same way it can
already swap a `vector-store` or an `ai-provider`. The built-in behavior is just the default
plugin.

---

## 2. Data model

### 2.1 Aggregation over existing columns (P1 — no new tables)

EW-651 already put the scope columns in place, so org-wide fan-in needs **zero schema change**:

- `work_knowledge_documents.organizationId` — **real FK** to `organizations(id)` (migration
  `1779991008000-UpgradeWorkKnowledgeDocumentOrganizationIdToFk.ts`), with the XOR-workId CHECK
  `work_knowledge_documents_scope_xor`. A document is either Work-scoped (`workId` set) or
  org-scoped (`organizationId` set, `workId` NULL).
- `work_knowledge_chunks.organizationId`, `work_knowledge_uploads.organizationId`,
  `work_knowledge_tags.organizationId`, `work_knowledge_citations.organizationId` — denormalized
  (no `@ManyToOne`, per the EW-651 no-cycle rule), stamped on insert by the scope subscriber.
- `works.organizationId` — real FK; `WorkRepository.findIdsByOrganization(orgId)` already
  enumerates every Work in an org.

**The one repository change P1 needs:** `WorkKnowledgeDocumentRepository.list()` currently
hard-requires a **single** `workId` **or** `organizationId` (an anti-cross-tenant-dump guard).
Relax it to accept a **`workIds: string[]` IN-list** (populated from `findIdsByOrganization`)
**while keeping the mandatory-scope guard** — i.e. it must still reject an unscoped call, it just
also accepts "all Works in this one org". This is the load-bearing query for the list view.

> **Aggregation is always org-bounded.** Every Memory query resolves the active Organization from
> the scope context first, enumerates that org's Work ids, and filters to that set ∪ the org's
> own org-scoped documents. A Memory query with no resolvable Organization returns **empty**, not
> a cross-tenant scan. (See §7.)

### 2.2 The `GET /api/memory` aggregation contract

A single faceted-search endpoint backs the page (full surface in §3). Conceptually it returns a
**union feed** of typed items with a shared shape:

```
MemoryItem {
    id: string
    kind: 'document' | 'note' | 'upload' | 'agent-memory' | 'concept'
    title: string
    snippet: string                 // highlighted match or summary
    docClass?: KbDocumentClass      // brand | legal | seo | style | glossary | personas | …
    source: 'work-kb' | 'org-kb' | 'agent-run' | 'synthesis' | 'upload'
    workId?: string;  workTitle?: string
    missionId?: string; missionTitle?: string     // §2.4 prerequisite A
    teamId?: string;  teamName?: string           // §2.4 prerequisite B
    agentId?: string; agentRunId?: string; memorySessionId?: string
    score?: number                  // blended lexical + semantic rank when a query is present
    updatedAt: string; lastIndexedAt?: string
}
```

`GET /api/memory/facets` returns the counts per facet value (for the chips), and
`GET /api/memory/stats` returns the two header counters (`documentsIndexed`,
`conceptsSynthesized`).

### 2.3 Facets and their backing columns

| Chip           | Backed by                                                                                     | Available in |
| -------------- | --------------------------------------------------------------------------------------------- | ------------ |
| **Type**       | `work_knowledge_documents.kbDocumentClass` (`KbDocumentClass` enum in `kb-types.ts`)          | P1           |
| **Work**       | `work_knowledge_documents.workId` → `works.title`                                             | P1           |
| **Source**     | derived `source` (`work-kb` / `org-kb` / `agent-run` / `synthesis` / `upload`)                | P1           |
| **Status**     | `work_knowledge_documents.status`                                                             | P1           |
| **Tag**        | `work_knowledge_tags` (per-Work catalog today; an org-tag rollup is an open question, §10)    | P1 (raw)     |
| **Mission**    | `Work → Mission` linkage — **prerequisite A (§2.4)**                                           | **P3**       |
| **Team**       | `team_resources(teamId, resourceType, resourceId)` — **prerequisite B (§2.4)**                | **P3**       |
| **Partition**  | cognitive-memory `memory_entry.partition` (§6)                                                | **P3**       |

### 2.4 Critical prerequisites for the Mission and Team facets

Two facets **cannot be built on today's schema** and are therefore deferred to P3, gated behind
prerequisites that live in *other* features. Calling them out loudly so they are not discovered
mid-implementation:

**Prerequisite A — Work → Mission linkage.** There is no direct `Work.missionId`. A Work reaches
its Mission only through a two-hop traversal: `Work.acceptedFromIdeaId` (nullable,
[`work.entity.ts`](../../../../packages/agent/src/entities/work.entity.ts) L506) →
`WorkProposal.missionId` ([`work-proposal.entity.ts`](../../../../packages/agent/src/entities/work-proposal.entity.ts) L161)
→ `Mission`. For a Memory facet we need either:

- (a) a **denormalized nullable `works.missionId`** column (additive; stamped on accept, backfilled
  once via the existing `acceptedFromIdeaId → missionId` join), **or**
- (b) a resolved join in the aggregation query (`Work` LEFT JOIN `WorkProposal` ON
  `acceptedFromIdeaId` for the `missionId`), accepting that Works not created from an Idea have no
  Mission.

Option (a) is recommended — it makes the facet a single indexed column and keeps the aggregation
query flat. This linkage is **broadly useful beyond Memory** (dashboards, Mission roll-ups) and
should be owned by the Missions/Ideas/Works feature, consumed here.

**Prerequisite B — Work / Task / Mission ↔ Team association (does not exist).** Today's
collaboration primitive is per-Work `WorkMember` (Owner/Manager/Editor/Viewer on a single Work) —
there is **no first-class Team entity that groups resources across Works**, and nothing that
associates a Team with a Mission or a Task. The Team facet needs a **new additive polymorphic
join**, owned by the **Teams** feature:

```
team_resources
    id            uuid  pk
    teamId        uuid  fk → teams(id)          on delete cascade
    resourceType  varchar   -- 'work' | 'mission' | 'task' | 'agent'
    resourceId    uuid      -- the target row's id (polymorphic; not an FK)
    tenantId      uuid  fk → tenants(id)        -- Tier C denormalized (EW-651)
    organizationId uuid fk → organizations(id)  -- Tier C denormalized
    createdAt / updatedAt
    unique (teamId, resourceType, resourceId)
    index (resourceType, resourceId)            -- reverse lookup: "which teams own this Work?"
    index (organizationId, teamId)
```

This is polymorphic-by-`(resourceType, resourceId)` on purpose — it deliberately does **not** add
`@ManyToOne` back-relations, matching the EW-651 no-cycle-on-scope-columns rule and avoiding a
fan of per-resource join tables. **This table belongs in the Teams feature's spec and migrations,
not this one.** Memory only *consumes* it: once it exists, the Team facet is a reverse lookup
(`team_resources WHERE resourceType='work' AND resourceId IN (org work ids)`) joined into the feed.

> **Phasing consequence:** the Type / Work / Source / Status / Tag chips ship in P1. The
> **Mission** chip ships when prerequisite A lands. The **Team** chip ships when prerequisite B
> lands (Teams feature). P3 assumes both are done; if Teams slips, the Team chip is simply hidden
> (feature-detected on the presence of `team_resources`), and the rest of Memory is unaffected.

### 2.5 New tables introduced by Memory itself

- **P1:** none. (Org-notes are existing `work_knowledge_documents` rows.)
- **P3 (cognitive-memory model, §6):** `memory_entry`, `memory_concept`, `memory_concept_link`,
  plus enums `memory_partition` and `memory_tier`. All follow the EW-651 Tier A/C scope-column
  conventions and each ships with its migration in the same PR (see [plan.md](plan.md) Phase 3.x).

---

## 3. API surface

All routes are **org-scoped** and mounted under a new controller
`apps/api/src/organizations/org-memory.controller.ts`, mirroring the guard stack of the existing
[`org-kb.controller.ts`](../../../../apps/api/src/works/org-kb.controller.ts):
`OrganizationOwnershipGuard` + `@OrgAdmin()`/`@OrgMember()` + `OrganizationMembershipService.ensureMember`.
The org is taken from the scope context (slug/`X-Scope-Slug`), never from a request body.

### 3.1 Endpoints

| Method + path                              | Purpose                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET /api/memory`                          | Faceted, paginated union feed of `MemoryItem`s for the active org. Query: `q`, `type[]`, `work[]`, `mission[]`, `team[]`, `source[]`, `status[]`, `view` (`list`\|`graph`), `cursor`, `limit`. |
| `GET /api/memory/facets`                   | Per-facet value counts for the chips, honoring the *other* active filters.                          |
| `GET /api/memory/stats`                    | `{ documentsIndexed, conceptsSynthesized, worksCovered, lastIndexedAt }` — the header counters.     |
| `GET /api/memory/graph`                    | Nodes + edges for the graph view (P3). Query mirrors `GET /api/memory` filters.                     |
| `POST /api/memory/documents`               | `+ New` — create an **org-level** note/document. Body `{ title, docClass?, body?, tags? }`. Delegates to `KnowledgeBaseService.createOrgDocument` (org-scoped `WorkKnowledgeDocument`). |
| `GET /api/memory/documents/:id`            | Fetch one aggregated item (proxies the KB doc/agent-memory session behind a uniform shape).          |
| `GET /api/memory/concepts` / `/:id`        | List / read synthesized concepts (P3).                                                               |
| `POST /api/memory/synthesize`              | Trigger a synthesis pass for the org (P3; admin-gated, async via Trigger.dev).                       |

**Web proxy:** `apps/web/src/app/api/organizations/[orgId]/memory/**` (mirrors the existing
per-Work KB web proxy), so the Next.js client keeps its same-origin fetch pattern and the API
sees the org via `X-Scope-Slug`.

### 3.2 Cross-Work semantic search

When `q` is present, the list feed blends lexical (Postgres FTS) and semantic results. The
per-Work `KnowledgeBaseService.semanticSearch()` enforces the **P0 `workId` filter invariant**
(every chunk query MUST filter `workId`; the composite PK `(workId, id)` is workId-first for a
future `PARTITION BY HASH`). Org-wide search therefore does **not** drop that invariant — it adds
a fan-out path:

- New facade method `VectorStoreFacadeService.queryChunksAcrossWorks(workIds: string[], …)` that
  runs the per-Work query for each id and **merges by `normalizedScore`**. `pgvector` (default,
  core) can satisfy this with a single `workId IN (…)` row-filter query; `qdrant` and other
  backends that key by collection/namespace-per-Work fan out per Work and merge in the facade.
  The capability advertises which mode it supports via `VectorStoreCapabilities.namespacePerWork`.
- Embedding of the query goes through the existing `AiFacadeService.embed()` selection chain
  unchanged. If no embedding provider is configured, org search **degrades to lexical-only**
  exactly as per-Work search does today.

### 3.3 Agent-memory read-through

The `agent-memory` facet calls the active memory provider's `searchMemory` / `listSessions`
keyed by the org's Work/Agent namespaces, correlating results back to `agent_runs` via
`memorySessionId` for provenance links. Optional methods (`listSessions`) that a backend does not
implement return an empty facet (the default `agentmemory` backend returns 404 for
`listSessions`) — never an error surfaced to the page.

---

## 4. Web UI

### 4.1 Sidebar item (new — below Agents)

Add one entry to the nav array in
[`DashboardSidebar.tsx`](../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx),
**immediately after the Agents item** (currently L124):

```tsx
{ name: t('navigation.agents'),  href: ROUTES.DASHBOARD_AGENTS, icon: Bot },
{ name: t('navigation.memory'),  href: ROUTES.DASHBOARD_MEMORY, icon: Brain },   // NEW
{ name: t('navigation.templates'), href: ROUTES.DASHBOARD_TEMPLATES, icon: LayoutTemplate },
```

- New i18n key `navigation.memory` (`"Memory"`) added to **every** locale (no half-translation).
- New route constant `ROUTES.DASHBOARD_MEMORY` → `/{slug}/memory` (slug-prefixed, per the
  Tenants & Organizations routing) with a legacy `/memory` alias for session-scoped access.
- Icon: `Brain` (lucide), matching the strokeWidth/size of siblings.

### 4.2 Page (new)

Route: `apps/web/src/app/[locale]/(dashboard)/organizations/[slug]/memory/page.tsx` (org-scoped),
with the legacy dashboard alias for the bare-Tenant view. Layout, top to bottom:

1. **Search input** (full-width, top). Debounced; drives `q`. Reuses the workbench
   `KbSearchPalette` primitive, org-scoped.
2. **Header counts** — `"{documentsIndexed} documents indexed · {conceptsSynthesized} concepts
   synthesized"` from `GET /api/memory/stats`. `conceptsSynthesized` reads `0` until P3 ships;
   the counter is present from P1 but shows `—`/hidden when synthesis is off (feature-detected).
3. **Filter chips row** — `[Type ▾] [Work ▾] [Source ▾] [Status ▾] [Tag ▾]` in P1;
   `[Mission ▾]` and `[Team ▾]` appended in P3 (feature-detected on their prerequisites, §2.4).
   Chips are multi-select; active chips show a count badge; "clear all" resets.
4. **View toggle** — `List | Graph`. Graph is disabled with a tooltip ("coming soon") until P3.
5. **`+ New`** button (top-right) — opens a lightweight create dialog (title + type + body) that
   POSTs to `/api/memory/documents` (org-level note). Reuses the Tiptap editor primitive from the
   KB workbench.
6. **List body** — ranked `MemoryItem` rows: title, type/source badge, Work/Mission chips,
   snippet, updated-at, provenance link (opens the underlying Work KB doc or the agent-run).

### 4.3 Graph view (P3)

A node-link canvas rendering the relationship edges that already exist in data (citations,
wiki-links, concept links). Nodes are color-coded by `kind`; clicking a node opens the same item
detail as the list. The graph honors the active filter chips (it renders the filtered subgraph).
Implementation is a new client component over `GET /api/memory/graph`; no new backend truth,
just a projection of existing edges + P3 `memory_concept_link` rows.

### 4.4 Reuse, not rebuild

Memory deliberately reuses the KB workbench primitives (`KbSearchPalette`, `KbTreePanel`, the
Tiptap editor, metadata panel) rather than forking them — it is a **new org-scoped composition**
of existing components, keeping the two surfaces visually and behaviorally consistent.

---

## 5. Plugin points — two new categories

Memory frameworks and multi-doc-type RAG become **first-class pluggable capabilities**, appended
to the closed `PLUGIN_CATEGORIES` tuple in
[`plugin-manifest.types.ts`](../../../../packages/plugin/src/contracts/plugin-manifest.types.ts)
(today 17 categories) — the same well-worn path by which `vector-store`, `dns`, `job-runtime`,
and `secret-store-resolver` were added (append to the tuple + add a
`capabilities/<name>.interface.ts` + a type guard + optional `base-*.ts` abstract + a facade in
`packages/agent/src/facades/`).

### 5.1 Why two categories (and how they relate to what exists)

Today, "memory/RAG" is spread across three places: `agent-memory` (shipped as a `utility`
plugin), embeddings (`ai-provider.createEmbedding`), and retrieval (`vector-store`). That is fine
for per-run agent memory but there is no seam for *org-wide memory frameworks* or *composed
retrieval pipelines*. We add:

- **`memory`** — the storage/promotion/synthesis framework. Owns how memory entries are written,
  promoted between tiers, and compiled into concepts. The first-party plugin **promotes today's
  `agentmemory` provider into this category** (it stays back-compatible with the existing
  `agent-memory` capability — additive, the old capability is not removed). Community frameworks
  (mem0/zep/langmem-style backends) become drop-in `memory` plugins.
- **`rag`** — the multi-doc-type retrieval pipeline: it **composes** an extractor (from the
  existing `content-extractor` category), an embedder (`ai-provider.createEmbedding`), and a
  store (`vector-store`) behind one contract, so "how this org does RAG over its docs" is a
  single swappable unit rather than three independently-configured seams. `rag` **orchestrates**
  the other categories; it does not replace them.

Either category can be omitted by an org; the built-in default plugin provides today's behavior.

### 5.2 `IMemoryPlugin` capability contract

```ts
// packages/plugin/src/contracts/capabilities/memory.interface.ts  (NEW)
export interface IMemoryPlugin extends IPlugin {
    readonly memoryFramework: string;                 // 'agentmemory' | 'mem0' | 'zep' | …

    // Write + retrieve (superset of today's IAgentMemoryPlugin, org/mission-aware)
    remember(input: MemoryWriteInput): Promise<MemoryRecord>;
    recall(query: MemoryQuery): Promise<MemoryRecord[]>;

    // Tiered cognitive memory (§6) — optional; default plugin implements a flat tier
    promote?(pass: PromotionPassInput): Promise<PromotionResult>;
    synthesize?(pass: SynthesisPassInput): Promise<SynthesisResult>;  // → concept pages

    // Introspection for the Memory page (all optional, best-effort)
    listSessions?(scope: MemoryScope): Promise<MemorySession[]>;
    stats?(scope: MemoryScope): Promise<{ entries: number; concepts: number }>;
}

export interface MemoryScope {
    tenantId: string | null;
    organizationId: string | null;
    workId?: string | null;
    missionId?: string | null;
    partition?: MemoryPartition;   // §6
    tier?: MemoryTier;             // §6
}
```

- **Bound facade** `MemoryFacadeService` (in `packages/agent/src/facades/`) selects the active
  memory plugin via the standard cascade (env pin → per-org active → `defaultForCapabilities` →
  first-enabled), mirroring `VectorStoreFacadeService`.
- **`buildContext` output is UNTRUSTED** — the same fencing rule as the existing agent-memory
  contract carries over: anything a memory plugin returns for injection into a prompt must be
  fenced by the consumer, never treated as instructions.

### 5.3 `IRagPlugin` capability contract

```ts
// packages/plugin/src/contracts/capabilities/rag.interface.ts  (NEW)
export interface IRagPlugin extends IPlugin {
    readonly ragStrategy: string;                     // 'default-hybrid' | 'graph-rag' | …

    ingest(input: RagIngestInput): Promise<RagIngestResult>;   // extractor → chunk → embed → store
    retrieve(query: RagQuery): Promise<RagHit[]>;              // hybrid lexical + vector + rerank
    getSupportedDocTypes(): string[];                          // ['markdown','pdf','docx','xlsx',…]
}
```

- `ingest` is where **multi-doc-type** support lives: it delegates extraction to the
  `content-extractor` category (so new doc types are new extractor plugins, not new RAG plugins),
  then chunks (reusing `kb-chunker.ts`), embeds, and upserts to the active `vector-store`.
- `retrieve` is the blended query used by `GET /api/memory` semantic search; a `graph-rag` plugin
  could override it to walk concept links.

### 5.4 How they slot beside `content-extractor` (and the office-doc extractor)

```
                 ┌─────────────────────────── rag (NEW) ───────────────────────────┐
   raw doc  ──►  │  content-extractor  ──►  kb-chunker  ──►  ai-provider.embed  ──► │  ──► vector-store
   (url/upload)  │   (existing seam)         (existing)       (existing)            │       (existing)
                 └──────────────────────────────────────────────────────────────────┘
                                                   ▲
                          memory (NEW) writes/promotes/synthesizes over the retrieved + stored knowledge
```

The **office-doc extractor** evaluated in
[`office-rendering/eval-officecli.md`](../office-rendering/eval-officecli.md) is a
**complementary `content-extractor` plugin** (`@ever-works/officecli-extractor-plugin`,
`systemPlugin:false`, `autoEnable:false`) that adds `.docx/.xlsx/.pptx` text extraction — a doc
type no current extractor handles. It plugs into the **`ingest` stage of `rag`** with zero changes
to the memory or rag contracts: more doc types flow into Memory simply by enabling more
`content-extractor` plugins. (Its high-fidelity visual render path is a separate future
"office-viewer" capability, out of scope here.) This is exactly the additive layering the two new
categories are designed for.

---

## 6. Cognitive-memory data model (P3 option)

A concrete data model for durable, structured memory — offered as the **default `memory` plugin's
storage model** and as this spec's recommended shape. It is a design *option*: an alternative
`memory` plugin may model memory differently; the contract in §5.2 is what the platform depends
on.

### 6.1 Partitions × tiers

Every memory entry has a **partition** (what *kind* of memory it is) and a **tier** (how *durable
/ wide* its scope is):

**Partitions** (`memory_partition` enum):

| Partition      | Holds                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| `working`      | Scratch context for the current session/run; short-lived                          |
| `episodic`     | "What happened" — events, run outcomes, decisions, timestamped observations       |
| `semantic`     | "What is true" — facts, definitions, entities, glossary-like knowledge            |
| `procedural`   | "How to do X" — playbooks, repeatable procedures, learned workflows               |
| `user-model`   | Preferences and traits of the human(s) the org serves / the operator             |

**Tiers** (`memory_tier` enum, widening scope):

| Tier      | Scope column set on the entry                        |
| --------- | ---------------------------------------------------- |
| `session` | a single agent-run/memory session (`memorySessionId`)|
| `work`    | one Work (`workId` + org/tenant)                     |
| `org`     | the whole Organization (`organizationId` + tenant)   |
| `global`  | tenant-wide, cross-org (`tenantId` only)             |

### 6.2 Entities (Tier A/C scope columns per EW-651; migrations in the same PR)

```
memory_entry                              -- Tier A (tenantId + organizationId, both nullable)
    id            uuid pk
    partition     memory_partition        -- working|episodic|semantic|procedural|user-model
    tier          memory_tier             -- session|work|org|global
    content       text
    embedding     vector(1536) null       -- pgvector; populated via ai-provider.embed
    workId        uuid null  fk → works(id)
    missionId     uuid null               -- once prerequisite A lands (§2.4)
    agentRunId    uuid null  fk → agent_runs(id)
    memorySessionId varchar(128) null     -- correlate to external agent memory
    sourceType    varchar null            -- 'agent-run'|'kb-document'|'manual'|'synthesis'
    sourceId      uuid null
    salience      real default 0          -- promotion score (§6.3)
    tenantId      uuid null  fk → tenants(id)
    organizationId uuid null fk → organizations(id)
    createdAt / updatedAt / lastPromotedAt
    index (organizationId, partition, tier)
    index (workId, partition)

memory_concept                            -- Tier A — a synthesized page (the "concepts" counter)
    id            uuid pk
    title         varchar
    body          text                    -- compiled markdown (may live in Git like KB docs)
    partition     memory_partition
    tier          memory_tier
    embedding     vector(1536) null
    entryCount    int                     -- how many entries were compiled in
    tenantId / organizationId  (Tier A)
    createdAt / updatedAt / lastSynthesizedAt
    index (organizationId, partition)

memory_concept_link                       -- Tier C (denormalized tenantId/organizationId)
    id            uuid pk
    conceptId     uuid fk → memory_concept(id) on delete cascade
    targetType    varchar                 -- 'entry'|'document'|'concept'|'work'
    targetId      uuid
    relation      varchar                 -- 'derived-from'|'relates-to'|'supersedes'
    weight        real default 1
    tenantId / organizationId  (Tier C, denormalized)
    unique (conceptId, targetType, targetId, relation)
    index (targetType, targetId)          -- powers the graph view edges
```

### 6.3 Auto-promotion pass

A periodic (Trigger.dev) pass that **widens** the tier of entries that prove durable:

- Increment `salience` on re-access / re-citation; decay it over time for `working`/`episodic`.
- When an entry's `salience` crosses a threshold and it recurs across multiple sessions/Works,
  **promote** it (`session → work → org`), stamping the wider scope column and `lastPromotedAt`.
- De-duplicate near-identical entries by embedding cosine similarity, merging into the
  higher-tier survivor.

This keeps `org`/`global` tiers curated (only what earned its place) rather than a dump of every
scratch observation.

### 6.4 Synthesis pass → concept pages (the "concepts synthesized" counter)

A second periodic pass (or on-demand `POST /api/memory/synthesize`) that **compiles** clusters of
related `semantic`/`procedural` entries + KB documents into a single **`memory_concept`** page:

- Cluster by embedding similarity + shared tags/`docClass` within the org.
- Summarize the cluster into one concept page (via the active `ai-provider`), writing
  `memory_concept.body` and `entryCount`.
- Write `memory_concept_link` edges (`derived-from` each source entry/document) — these are the
  edges the **graph view** renders and the provenance the concept page cites.
- `COUNT(memory_concept WHERE organizationId = active)` is the header's **"concepts
  synthesized"** number.

Concepts are re-synthesizable and idempotent-ish: a re-run updates the existing concept
(`lastSynthesizedAt`) rather than duplicating it, matching how the KB re-embed pass behaves.

---

## 7. Security

- **Org-bounded by construction.** Every Memory query resolves the Organization from the scope
  context (never a body param) and filters to `findIdsByOrganization(orgId)` ∪ the org's own
  org-scoped rows. A query with no resolvable org returns empty — there is **no** unscoped or
  cross-tenant path. This mirrors the `WorkKnowledgeDocumentRepository.list()` mandatory-scope
  guard, which the P1 relaxation must **preserve** (accept a Work-ids IN-list, still reject the
  unscoped case).
- **Membership guards.** `org-memory.controller.ts` reuses `OrganizationOwnershipGuard` +
  `OrganizationMembershipService.ensureMember`/`ensureAdmin` from the existing org-KB controller.
  Read = member; `+ New`, `synthesize`, and any promotion trigger = admin.
- **P0 chunk invariant preserved.** Cross-Work semantic search fans out **per Work** and keeps
  the `workId` filter on every chunk query; it never issues a chunk query without a `workId`
  bound (§3.2).
- **Untrusted memory output.** `buildContext`/`recall` output injected into any prompt is fenced
  by the consumer (carried over from the agent-memory contract). A memory/RAG plugin is a
  content *source*, not an instruction source.
- **Agent-memory best-effort.** A failing/unavailable external memory backend degrades that facet
  to empty; it never fails the page or leaks another org's namespace (namespaces are keyed by the
  org's own Work/Agent ids).
- **Provenance without leakage.** Item detail links resolve back to the underlying Work KB doc or
  agent-run only when the requester is a member of that Work/org; provenance ids are not exposed
  for rows outside the active org.

---

## 8. Naming

| Concept                          | Canonical name                                  | Notes                                                        |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| The feature / sidebar item / page| **Memory**                                      | i18n `navigation.memory`; route `/{slug}/memory`             |
| Internal codename                | **Cortex**                                       | never user-visible                                           |
| Aggregation endpoint             | `GET /api/memory`                               | org-scoped faceted union feed                                |
| Aggregated item                  | **MemoryItem** (`kind`: document/note/upload/agent-memory/concept) | DTO in `packages/contracts`                 |
| Synthesized page                 | **Concept** (`memory_concept`)                  | the "concepts synthesized" counter                           |
| New plugin categories            | **`memory`**, **`rag`**                         | appended to `PLUGIN_CATEGORIES`                              |
| Capability contracts             | **`IMemoryPlugin`**, **`IRagPlugin`**           | beside `IVectorStorePlugin`, `IContentExtractorPlugin`       |
| Bound facade                     | **`MemoryFacadeService`**                       | in `packages/agent/src/facades/`                             |
| Cognitive dimensions             | **partition** (working/episodic/semantic/procedural/user-model) × **tier** (session/work/org/global) | enums `memory_partition`, `memory_tier`  |
| Team↔resource join (prereq)      | **`team_resources`** `(teamId, resourceType, resourceId)` | owned by the **Teams** feature, not this one       |

DB always uses `memory_*` / `team_resources`; UI always says "Memory" and "Concepts". No two
tables, no two API surfaces for one concept.

---

## 9. Phasing

| Phase  | Scope                                                                                                          | Prereqs / gates                                    |
| ------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **P1** | Org-wide aggregation page: sidebar item, `GET /api/memory` + `/facets` + `/stats`, search + **list** view, `+ New` org-note, chips **Type/Work/Source/Status/Tag**, cross-Work lexical+semantic search (fan-out facade). **No new tables.** | Relax `WorkKnowledgeDocumentRepository.list()`; add `queryChunksAcrossWorks`. |
| **P2** | The **`memory`** and **`rag`** plugin categories: contracts, type guards, facades, and the **first first-party `memory` plugin** (promote `agentmemory` into the category, back-compat with `agent-memory`). Office-doc `content-extractor` plugin can land here as a complementary ingest source. | Append to `PLUGIN_CATEGORIES`; office musl gate (see office eval). |
| **P3** | **Graph** view, the **cognitive-memory data model** (`memory_entry`/`memory_concept`/`memory_concept_link` + enums), the **auto-promotion** + **synthesis** passes (→ "concepts synthesized" counter), and the **Mission** + **Team** filter chips. | **Prerequisite A** (Work→Mission linkage) for the Mission chip; **Prerequisite B** (`team_resources` in the Teams feature) for the Team chip. |

Each phase is independently shippable and additive. P1 delivers the headline value (one place to
search everything the org knows) on today's schema. P2 makes the machinery swappable. P3 adds the
distilled/graph layer and the two facets that need cross-feature prerequisites.

---

## 10. Open questions

1. **Org-level tag taxonomy.** `work_knowledge_tags` is a **per-Work** catalog today (comment:
   "No org-level tag taxonomy in v1"). The Tag chip in P1 shows raw per-Work tags rolled up — do
   we want a real org-tag rollup / merge in P3? (Owner: KB.)
2. **Work→Mission linkage ownership.** Prerequisite A — denormalized `works.missionId` (option a)
   vs. resolved join (option b). Recommend (a); needs a decision from the Missions/Ideas/Works
   owner since the column lives on `works`.
3. **Teams feature timing.** Prerequisite B (`team_resources`) is owned by Teams. If Teams ships
   after P3, the Team chip is feature-detected/hidden until then. Confirm the Teams spec adopts
   the polymorphic `team_resources` shape in §2.4 rather than per-resource join tables.
4. **Concept storage location.** `memory_concept.body` in Postgres vs. mirrored to the org's Git
   data repo like KB docs (two-layer persistence). Git mirroring gives history + diff for free but
   couples synthesis to a repo write. (Owner: Platform.)
5. **Synthesis cost controls.** Promotion + synthesis passes call an `ai-provider`; per-org budget
   caps / cadence (reuse `AgentBudget`?) need a policy before P3 enablement.
6. **Graph scale.** For orgs with tens of thousands of documents, the graph view needs
   server-side subgraph windowing (filtered + top-N by edge weight) rather than shipping the full
   node set — confirm the `GET /api/memory/graph` contract caps node count.

---

## 11. Cross-references

- Implementation plan: [plan.md](plan.md) · Task checklist: [tasks.md](tasks.md)
- Per-Work Knowledge Base: [`knowledge-base/spec.md`](../knowledge-base/spec.md), vector-plugin design [`knowledge-base/phase-2-vector-plugin-design.md`](../knowledge-base/phase-2-vector-plugin-design.md)
- Agent Memory (shipped): [`agent-memory/spec.md`](../agent-memory/spec.md)
- Tenants & Organizations (scope columns, slug routing): [`tenants-and-organizations/spec.md`](../tenants-and-organizations/spec.md)
- Work Members (today's collaboration primitive; contrast with the future Teams feature): [`work-members/spec.md`](../work-members/spec.md)
- Office-doc extractor evaluation: [`office-rendering/eval-officecli.md`](../office-rendering/eval-officecli.md)
- Plugin categories tuple: [`plugin-manifest.types.ts`](../../../../packages/plugin/src/contracts/plugin-manifest.types.ts)
