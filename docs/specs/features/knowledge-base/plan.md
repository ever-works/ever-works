# Knowledge Base — implementation plan

**Status**: `Draft`
**Last updated**: 2026-05-21
**Audience**: Engineers planning or executing the Knowledge Base build.

This plan is the engineering-execution complement to [spec.md](spec.md). The spec is the _what_; this is the _how_ and _when_. Phasing matches the canonical "phased delivery" section of the spec.

## Tracking

- **JIRA Epic**: `EW-XXX` — Knowledge Base v1 (link to be filled in once the Epic exists).
- **Child tickets**: one per phase below, with sub-tasks per deliverable.
- **Spec source of truth**: [spec.md](spec.md).
- **Decision log**: [spec.md §26](spec.md#26-confirmed-decisions).

## Phase 1 — foundation (target: first reviewable PR)

The smallest credible vertical slice that proves the data model, the storage abstraction, and the API contract. **No UI in this phase beyond a CRUD-bound API.**

### Deliverables

1. **Entities** in `packages/agent/src/entities/`:
    - `work-knowledge-document.entity.ts`
    - `work-knowledge-upload.entity.ts`
    - `work-knowledge-tag.entity.ts`
    - `work-knowledge-citation.entity.ts`
    - `work-knowledge-chunk.entity.ts` (composite PK on `(workId, id)` — see spec §15.2)
2. **Migrations** under `apps/api/src/migrations/` (`{unix-millis}-{PascalCase}.ts`):
    - `EnablePgvectorExtension` — `CREATE EXTENSION IF NOT EXISTS vector;`
    - `CreateWorkKnowledgeDocuments` — including the `work_id XOR organization_id` CHECK constraint
    - `CreateWorkKnowledgeUploads`
    - `CreateWorkKnowledgeTags`
    - `CreateWorkKnowledgeCitations`
    - `CreateWorkKnowledgeChunks` — composite PK + ivfflat index on `(workId, embedding)`
    - `AddWorkKbConfigColumn` — `kb_config` simple-json on `works`
3. **DTOs** in `packages/contracts/src/kb/` — `KbDocumentDto`, `KbDocumentBodyDto`, `KbUploadDto`, `KbSearchHit`, `KbTreeNode`, `CitationDto`, `KbDocumentClass` union.
4. **Service skeleton** `packages/agent/src/services/knowledge-base.service.ts`:
    - Constructor wiring (repositories, storage plugin resolver, content-extractor resolver, Git provider).
    - Method stubs with JSDoc: `resolveDocuments`, `createDocument`, `updateDocument`, `deleteDocument`, `ingestUpload`, `search`, `rebuildIndex`, `resolveContext`.
    - No method bodies beyond `throw new NotImplementedException()` — bodies land in subsequent PRs.
5. **REST endpoints** in `apps/api/src/works/` (the existing `WorksController` per the spec §12 routing convention):
    - `GET /api/works/:id/kb/documents` + `POST /api/works/:id/kb/documents`
    - `GET/PATCH/DELETE /api/works/:id/kb/documents/:docId`
    - Lock / unlock / restore endpoints
    - Upload endpoints (placeholder — accept multipart but persist only the row, not yet extract)
    - Tree, search (lexical-only), tags
    - All wired with the existing `WorkMemberGuard` and `@ApiBearerAuth` decorators
6. **Tests**:
    - Entity unit tests covering the `workId XOR organizationId` CHECK constraint, the indexed columns, the cascade rules.
    - Service unit tests for `resolveContext` budget truncation logic (mocking the repositories).
    - One API e2e test covering create → list → update → delete on a document.
7. **Backfill job** in `packages/tasks/`:
    - Iterates existing Works, initializes empty `.content/kb/` structure in each data repo (idempotent).
8. **Documentation**:
    - Append a "Knowledge Base entities" section to `docs/specs/architecture/database.md` listing the new entities + the inheritance pattern + the pgvector dependency.
    - Append a dated entry to whatever the platform's change-log convention is (mirror existing PR entries in `docs/`).

### Out of Phase 1

- Embedding generation (Phase 2).
- Workbench UI (deferred to a separate web-only PR within Phase 1 — see Phase 1B).
- Extraction pipeline (Phase 1B).
- Org-level inheritance UI (Phase 2).
- Agent runtime integration (Phase 2).

### Phase 1B (still in foundation, second PR)

- Workbench MVP: tree + Tiptap editor + drag-and-drop upload + PDF / DOCX / Markdown extraction.
- Ingest pipeline (receive → normalize → extract → materialize → index), as Trigger.dev jobs in `packages/tasks/`.
- Per-document lock UI.
- Activity log integration.

## Phase 2 — agent integration + retrieval

Builds on Phase 1's data model.

### Deliverables

1. **Embedding generation** via platform-managed embedding lane.
    - Add `embed(input)` to AI provider plugin contract in `packages/plugin/`.
    - Implement for `openai` plugin (default `text-embedding-3-small`).
    - Trigger.dev job in `packages/tasks/` to chunk + embed on document insert / update.
    - Hybrid chunker (heading-aware + fixed-size fallback).
2. **Semantic retrieval** wired into `KnowledgeBaseService.search` (RRF blend of lexical + semantic).
3. **`KbPromptFormatter`** in `packages/agent/src/services/kb-prompt-formatter.ts` — produces the standardized context block injected into every pipeline.
4. **Pipeline integration** — every pipeline in `packages/plugins/{standard-pipeline,agent-pipeline,claude-code,…}` consumes `KbContextBundle` via the orchestrator.
5. **AI conversation `@kb` mentions** + citation rendering.
6. **Agent tools** — `kb_search`, `kb_read`, `kb_write`, `kb_lock` exposed to agent-pipelines via the existing tool-registration surface.
7. **Org-level legal / style / seo inheritance** — entity-level support exists in Phase 1; this phase implements the fan-out Trigger.dev job + `.org/{class}/` materialization in the Work's data repo + admin endpoints.
8. **Community-PR and scheduled-regen lock respect** — `CommunityPrService` and `ScheduledUpdateService` consult `WorkKnowledgeDocument.locked` and `lockMode` before mutating any KB doc.
9. **Tests**:
    - Service tests for hybrid chunking against fixture documents.
    - Eval suite for retrieval-quality regression (lexical-only baseline vs. blended).
    - E2E test for an org-level legal doc being inherited and overridden by a Work.

## Phase 3 — polish

1. **Video / audio normalization** via ffmpeg (Trigger.dev job).
2. **Transcription** via AI provider `transcribe(file)` capability (added to plugin contract, implemented in `openai` and `anthropic` plugins).
3. **Embedded-app outputs** — agents can write `index.html` + assets folders as KB documents; workbench renders them in a sandboxed iframe.
4. **`output`-class agent writes** — agents can promote their conversation responses into the KB with full provenance tracking.
5. **MCP exposure** — `apps/mcp` gains a `kb` namespace (list / read / search / create / update / upload).
6. **CLI exposure** — `apps/cli` gains `ever works kb {list,show,upload,edit,search,sync}` commands.
7. **Wikilink resolver + rename rewriter** — when a document is renamed or moved, all `[[wikilinks]]` and relative-path references across the KB are updated automatically.
8. **Reconciliation job** — daily sweep detecting Git ↔ DB drift, surfacing `kb.lock.violation` and orphan-storage cases in the workbench.
9. **Full telemetry event set** per spec §23.

## Dependencies + risk

- **pgvector**: must be enabled on every platform Postgres deployment before Phase 1 migrations run. Coordinate with the platform-infra deploy runbook.
- **OAuth token scope for `github-storage`**: KB upload commits go through the same `github-storage` plugin path that already commits items. No new token scope needed.
- **Trigger.dev workers**: ingest pipeline + embedding generation + sweeper will add real load. Confirm worker count + concurrency limits before Phase 2.
- **Embedding cost**: default `text-embedding-3-small` is ~$0.02/M tokens — modest, but at scale (large org with many Works) becomes a real line item. The budget-system integration in §19.3 of the spec must land in Phase 1 so usage is observable from day one.

## Definition of done per phase

Each phase ends with:

- All deliverables landed in `develop`.
- PR review loop completed per workspace NN #14 / #18.
- CI green per NN #19.
- Acceptance criteria from [acceptance.md](acceptance.md) for that phase verified manually + by CI.
- JIRA child ticket transitioned to Done.
