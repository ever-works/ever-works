# Knowledge Base — task checklist

**Status**: `Draft`
**Last updated**: 2026-05-21
**Audience**: Engineers picking up tickets from the JIRA Epic. This is the granular work breakdown that feeds JIRA sub-tasks under each phase ticket.

See [spec.md](spec.md) for the technical contract, [plan.md](plan.md) for the phasing rationale, and [acceptance.md](acceptance.md) for the gate conditions.

## Phase 1A — data model + service skeleton + REST CRUD (one PR)

### Entities
- [ ] `packages/agent/src/entities/work-knowledge-document.entity.ts` — full column set per spec §6.1
- [ ] `packages/agent/src/entities/work-knowledge-upload.entity.ts` — per spec §6.2
- [ ] `packages/agent/src/entities/work-knowledge-tag.entity.ts` — per spec §6.3
- [ ] `packages/agent/src/entities/work-knowledge-citation.entity.ts` — per spec §6.4
- [ ] `packages/agent/src/entities/work-knowledge-chunk.entity.ts` — composite PK `(workId, id)` per spec §15.2 D8
- [ ] Add new entities to the `ENTITIES` registry in the platform's database module
- [ ] Add `kbConfig` simple-json column to `Work` entity per spec §6.5

### Migrations (`apps/api/src/migrations/`)
- [ ] `<ts>-EnablePgvectorExtension.ts` — idempotent `CREATE EXTENSION IF NOT EXISTS vector;`
- [ ] `<ts>-CreateWorkKnowledgeDocuments.ts` — table + `workId XOR organizationId` CHECK constraint + indexes
- [ ] `<ts>-CreateWorkKnowledgeUploads.ts` — table + sha256 dedup index
- [ ] `<ts>-CreateWorkKnowledgeTags.ts`
- [ ] `<ts>-CreateWorkKnowledgeCitations.ts` — append-only, no update path
- [ ] `<ts>-CreateWorkKnowledgeChunks.ts` — composite PK + ivfflat index on `(workId, embedding)`
- [ ] `<ts>-AddWorkKbConfigColumn.ts`
- [ ] Each migration includes its `down()` revert
- [ ] Generate migrations via `pnpm typeorm migration:generate` from `apps/api/`, **read the SQL** before committing (per workspace NN #16)

### DTOs (`packages/contracts/src/kb/`)
- [ ] `kb-document.dto.ts` — `KbDocumentDto`, `KbDocumentBodyDto`
- [ ] `kb-upload.dto.ts` — `KbUploadDto`
- [ ] `kb-search.dto.ts` — `KbSearchHit`
- [ ] `kb-tree.dto.ts` — `KbTreeNode`
- [ ] `citation.dto.ts` — `CitationDto`
- [ ] `kb-document-class.ts` — union type with the ten class values
- [ ] Barrel export from `packages/contracts/src/index.ts`

### Service skeleton (`packages/agent/src/services/knowledge-base.service.ts`)
- [ ] NestJS `@Injectable()` class
- [ ] Repository injection for all five entities
- [ ] Method stubs with JSDoc only (no bodies):
  - [ ] `resolveDocuments(workId, filter): Promise<KbDocumentDto[]>`
  - [ ] `getDocument(workId, idOrPath): Promise<KbDocumentBodyDto>`
  - [ ] `createDocument(workId, input): Promise<KbDocumentBodyDto>`
  - [ ] `updateDocument(workId, docId, patch): Promise<KbDocumentBodyDto>`
  - [ ] `deleteDocument(workId, docId): Promise<void>`
  - [ ] `lockDocument(workId, docId, mode): Promise<KbDocumentBodyDto>`
  - [ ] `unlockDocument(workId, docId): Promise<KbDocumentBodyDto>`
  - [ ] `restoreDocument(workId, docId, commitSha): Promise<KbDocumentBodyDto>`
  - [ ] `ingestUpload(workId, file, opts): Promise<KbUploadDto>` (placeholder)
  - [ ] `search(workId, query, filter): Promise<KbSearchHit[]>` (lexical only in Phase 1)
  - [ ] `resolveContext(workId, opts): Promise<KbContextBundle>` (stub — populated in Phase 2)
  - [ ] `rebuildIndex(workId): Promise<void>`
  - [ ] `resolveInheritableDocuments(workId, classes?)` — for org overlay
- [ ] Module wiring in `packages/agent/src/services/services.module.ts` (or whatever the existing convention is)

### REST endpoints (`apps/api/src/works/`)
- [ ] Extend `WorksController` with the KB route set per spec §12
- [ ] Validation pipes (class-validator on input DTOs)
- [ ] `WorkMemberGuard` for read endpoints (Viewer+), Editor+ for writes, Owner for lock/unlock/restore
- [ ] OpenAPI / Swagger annotations on each route
- [ ] Map service errors → HTTP responses via existing exception filter

### Org-level admin endpoints
- [ ] `apps/api/src/organizations/` controller additions:
  - [ ] `GET /api/organizations/:orgId/kb/documents?class=…`
  - [ ] `POST /api/organizations/:orgId/kb/documents`
  - [ ] `PATCH /api/organizations/:orgId/kb/documents/:docId`
  - [ ] `DELETE /api/organizations/:orgId/kb/documents/:docId`
- [ ] Restrict POST/PATCH `class` to `legal | style | seo` with 400 on violation
- [ ] OrganizationAdminGuard for all four
- [ ] Service stub for `resolveInheritableDocuments` — actual fan-out lands in Phase 2

### Tests (Phase 1A scope)
- [ ] Entity unit tests in `packages/agent/test/entities/` — one file per new entity:
  - [ ] CHECK constraint behavior (insert both workId + organizationId → reject; insert neither → reject)
  - [ ] Cascade-delete behavior on parent removal
  - [ ] simple-json column round-trip
- [ ] Service unit tests for `resolveContext` budget truncation logic with mocked repos
- [ ] API e2e test (`apps/api/test/`) for the document CRUD lifecycle

### Backfill (Trigger.dev or one-time CLI task)
- [ ] `packages/tasks/` job that iterates existing Works and writes an empty `.content/kb/` skeleton via the configured `github-storage` plugin
- [ ] Idempotent; safe to re-run
- [ ] Sets `Work.kbConfig` to platform defaults if absent

### Documentation
- [ ] New section in `docs/specs/architecture/database.md`: "## N. Knowledge Base Entities" describing the five entities + the inheritance pattern + pgvector dependency
- [ ] Link the new section back from the spec
- [ ] Update `docs/specs/architecture/database-migrations.md` if it has an examples list (mention the pgvector enable migration as the canonical "extension enable" pattern)
- [ ] PR description references the JIRA Epic + spec URL

## Phase 1B — workbench MVP + ingest pipeline (separate PR)

- [ ] Workbench page route at `apps/web/src/app/[locale]/(dashboard)/works/[id]/kb/page.tsx`
- [ ] Nested editor route `apps/web/src/app/[locale]/(dashboard)/works/[id]/kb/[...path]/page.tsx`
- [ ] Tree panel (KB / Originals tab toggle)
- [ ] Tiptap editor wired to the existing settings (locale, theme)
- [ ] Inline viewers: PDF.js (PDFs), native `<video>`/`<audio>`, image viewer
- [ ] DOCX/PPTX/XLSX viewers behind dynamic imports + per-format size caps from spec §14.5
- [ ] Drag-and-drop upload with classification modal
- [ ] Ingest pipeline (Trigger.dev jobs in `packages/tasks/`):
  - [ ] Receive job (already partially covered by upload API)
  - [ ] Normalize job (skip when format is "kept as-is"; only video/audio normalize)
  - [ ] Extract job (calls configured content-extractor plugins)
  - [ ] Materialize job (writes sidecar `.yml` + `.md` to Git data repo via configured Git provider)
  - [ ] Index job (rebuild `.index.yml` + Postgres `tsvector` for FTS)
- [ ] Activity log emits the kinds listed in spec §19.1
- [ ] Per-document lock UI (file menu in tree + lock state chip in document header)
- [ ] Search palette wired to lexical-only `/api/works/:id/kb/search`

## Phase 2 — agent integration + retrieval

- [ ] Plugin contract: optional `embed(input)` capability in `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts`
- [ ] Implement `embed` in `packages/plugins/openai/`
- [ ] Trigger.dev job: chunk + embed on document insert/update + delete cascade to chunks
- [ ] Hybrid chunker in `packages/agent/src/services/kb-chunker.ts` (heading-aware + fixed-size fallback)
- [ ] `KnowledgeBaseService.search` blends lexical + semantic via RRF
- [ ] `KbPromptFormatter` in `packages/agent/src/services/kb-prompt-formatter.ts`
- [ ] `KbContextBundle` plumbed into every pipeline plugin's invocation signature
- [ ] Pipeline integration tests with fixture KB documents
- [ ] AI conversation: `@kb:<path-or-id>` parser + autocomplete + citation marker resolver
- [ ] Citation hover-card component (workbench-side)
- [ ] Agent tools: `kb_search`, `kb_read`, `kb_write`, `kb_lock`, `kb_unlock` registered to agent-pipelines
- [ ] Org-level inheritance fan-out:
  - [ ] Trigger.dev job that materializes `.org/{class}/` overlay into every Work in the org
  - [ ] Triggered on POST/PATCH/DELETE of org-level inheritable docs
  - [ ] Workbench surfaces inherited docs as read-only with an "override locally" affordance
- [ ] Community PR + scheduled regen consult `locked` and `lockMode` before mutating any KB doc
- [ ] Comparison generator reads `competitors` and `research` classes automatically
- [ ] LLM eval suite (`vitest.eval.config.ts` style) for retrieval-quality regression
- [ ] Budget integration: `kb-embedding` category in `UsageLedgerEntry`

## Phase 3 — polish

- [ ] Video → MP4 normalization via ffmpeg (Trigger.dev job)
- [ ] Audio → MP3 normalization via ffmpeg
- [ ] Plugin contract: optional `transcribe(file)` capability
- [ ] Implement `transcribe` in `openai` (Whisper) and `anthropic` plugins
- [ ] Embedded-app output rendering (HTML decks / dashboards inside `outputs/<slug>/` folders)
- [ ] `output`-class agent writes — "promote conversation response to KB" action
- [ ] MCP namespace `kb.*` in `apps/mcp/` (list / read / search / create / update / upload)
- [ ] CLI subcommand group `ever works kb {list, show, upload, edit, search, sync}` in `apps/cli/`
- [ ] Wikilink resolver + rename-aware reference rewriter
- [ ] Reconciliation job: daily Git ↔ DB diff, `kb.lock.violation` surfacing, orphan-storage detection with 7-day grace per spec §9.6
- [ ] Sweeper telemetry events emitted to PostHog
- [ ] All PostHog event kinds from spec §23 wired

## Cross-cutting

- [ ] **Permissions matrix verified** against `WorkMemberGuard` for every new endpoint (spec §20)
- [ ] **Quotas enforced** at service layer (spec §21)
- [ ] **No KB body content** in webhooks, telemetry, or activity-log payloads (spec §22)
- [ ] **Markdownlint / prettier / lint / typecheck** clean on every PR
- [ ] **PR review loop** completed per workspace NN #14 / #18 / #19 — bots triaged before merge
