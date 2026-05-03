# Task Breakdown: Advanced Prompts

**Feature ID**: `advanced-prompts`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-02

---

## Phase 1 — Schema & contracts

- [x] **T1**. `WorkAdvancedPrompts` entity at
      `packages/agent/src/entities/work-advanced-prompts.entity.ts`
    - All 7 prompt fields as `text NULL`; one-to-one with `Work`
      with cascade delete.
    - Export from `packages/agent/src/entities/index.ts`.
- [x] **T2**. Migration adding `work_advanced_prompts` table
      with unique index on `workId`. Additive only.
- [x] **T3** (parallel with T2). DTO
      `UpdateWorkAdvancedPromptsDto` at
      `packages/agent/src/dto/work-advanced-prompts.dto.ts`
      with `@IsOptional() @IsString() @MaxLength(2000)` and
      `sanitizeString` Transform per field.
- [x] **T4**. Response interface `WorkAdvancedPromptsResponseDto`
      mirroring the entity with timestamps as ISO strings.

## Phase 2 — Repository

- [x] **T5**. `WorkAdvancedPromptsRepository` at
      `packages/agent/src/database/repositories/work-advanced-prompts.repository.ts`
    - `findByWorkId(id) → entity | null`
    - `createOrUpdate(id, fields) → entity` (upsert)
    - `delete(id) → void`
    - Tests: `…repository.spec.ts` with in-memory dataset.

## Phase 3 — Service

- [x] **T6**. `WorkAdvancedPromptsService` at
      `packages/agent/src/services/work-advanced-prompts.service.ts`
    - `getAdvancedPrompts(workId) → response | null`
    - `updateAdvancedPrompts(workId, userId, dto) → response`
      with editor-role check
    - `getPromptsForGeneration(workId) → AdvancedPromptsContext`
      returning a fully-populated context object (null fields preserved)
    - Tests: `…service.spec.ts` with mocked repository + role checker.
- [x] **T7**. Wire into the work module so the service is
      injectable from the API controller and from the items generator.

## Phase 4 — Pipeline integration

- [x] **T8**. `appendCustomPrompt(base, custom?) → string` utility at
      `packages/agent/src/items-generator/utils/prompt.util.ts`.
    - Empty/null/whitespace-only `custom` returns `base` unchanged.
    - Non-empty `custom` is trimmed and appended after the
      `## Additional User Instructions:` header.
    - Tests cover: null, undefined, empty string, whitespace-only,
      and a normal multi-line prompt.
- [x] **T9**. Add `advancedPrompts?: AdvancedPromptsContext | null`
      to `GenerationContext` in
      `packages/agent/src/items-generator/interfaces/pipeline.interface.ts`.
- [x] **T10**. Load advanced prompts in
      `ItemsGeneratorService.generateItems()` via
      `getPromptsForGeneration(workId)` and attach to context
      **before** the pipeline executor starts. Always reload fresh
      (do not restore from checkpoint).
- [x] **T11**. Wire each pipeline step to call `appendCustomPrompt`
      with its respective context field:
    - Step 4a `AiItemGenerationService` → `itemGeneration`
    - Step 4b `SearchQueryGenerationService` → `searchQuery`
    - Step 6 `ContentFilteringService` → `relevanceAssessment`
    - Step 7 `ItemExtractionService` → `itemExtraction`
    - Step 8 `AiDeduplicator` → `deduplication`
    - Step 9 `CategoryProcessingService` → `categorization`
    - Step 10 `SourceValidationService` → `sourceValidation`

## Phase 5 — API surface

- [x] **T12**. `GET /api/works/:id/advanced-prompts` controller
      method on `apps/api/src/works/works.controller.ts`.
- [x] **T13**. `PUT /api/works/:id/advanced-prompts` controller
      method with editor-role guard.
- [x] **T14**. Swagger `@ApiOperation` / `@ApiResponse` decorators
      for both endpoints.
- [x] **T15**. e2e tests in `apps/api/test/` covering: viewer cannot
      update (403), editor can update (200), invalid (>2000 chars)
      returns 400, missing work returns 404.

## Phase 6 — Web UI

- [x] **T16**. API client at `apps/web/src/lib/api/work.ts`:
    - `getAdvancedPrompts(id)`
    - `updateAdvancedPrompts(id, data)`
- [x] **T17**. Server action
      `updateAdvancedPrompts(workId, data)` at
      `apps/web/src/app/actions/dashboard/works.ts` with Zod
      validation (max 2000 chars per field).
- [x] **T18**. `AdvancedPromptsSettings` component at
      `apps/web/src/components/works/detail/settings/AdvancedPromptsSettings.tsx`:
    - Collapsible section, collapsed by default
    - Lazy-load on first expand
    - 7 textareas with auto-resize and character counter
    - Single Save button with loading state
    - Toast on success / error
- [x] **T19**. Embed component in `SettingsForm.tsx`.
- [x] **T20**. Translations under
      `dashboard.workDetail.settings.advancedPrompts.*` in
      `apps/web/messages/en.json` and other locale files.

## Phase 7 — Docs

- [x] **T21**. User-facing doc
      `docs/features/advanced-prompts.md` with the per-prompt usage
      examples and customization tips.
- [x] **T22**. Cross-link from `docs/features/index.md` and
      `apps/docs/sidebarsPlatform.ts`.
- [x] **T23**. Retrospective spec / plan / tasks (this set).

## Phase 8 — Quality gates

- [x] **T24**. `pnpm format && pnpm lint && pnpm test && pnpm build`
      green.
- [x] **T25**. `pnpm --filter ever-works-docs build` produces no
      broken-link warnings.

## Definition of Done

- [x] All 7 prompt fields editable from the UI and respected at run time
- [x] Editor-only authorization on PUT, all roles can read on GET
- [x] Sanitisation + length cap enforced at the DTO layer
- [x] `appendCustomPrompt` covered by unit tests for empty / whitespace / normal cases
- [x] Per-step integration covered by unit tests and one e2e
- [x] Constitution gates in `spec.md` §9 confirmed satisfied
