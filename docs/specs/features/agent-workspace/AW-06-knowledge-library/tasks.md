# AW-06 — Knowledge library · Task breakdown

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-06-knowledge-library`
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** `Draft` · **Last updated:** 2026-09-06

---

## How to use

- Tasks run **top to bottom**. A task marked `(parallel)` may run alongside the one before it.
- Every task names the files to create or modify and states what **done** means.
- Every task belongs to a phase: **P1** the shelf, **P2** read state and references, **P3** export
  at scale and PDF. Each phase leaves `develop` green on its own.
- Add new tasks at the bottom rather than renumbering.
- Repo commands, from the repo root unless stated: `pnpm lint`, `pnpm type-check`, `pnpm test`,
  `pnpm build`. Migration authoring runs from `apps/api/`.

---

# Phase P1 — The shelf

## P1.1 — Data model

- [ ] **T1 · Entity — reader state**
      Create `packages/agent/src/entities/knowledge-document-reader-state.entity.ts` with
      `@Entity('knowledge_document_reader_states')` and the columns in
      [plan §3.1](./plan.md#31-new-entity--reader-state): `id`, `userId`, `documentId`,
      `lastOpenedAt`, `lastReadRevision` (int, default 0), `pinnedAt`, `tenantId`,
      `organizationId`, `createdAt`, `updatedAt`. Raw uuid columns, **no `@ManyToOne` to `User`**
      (no-cycle rule — follow `memory-folder.entity.ts`). Declare the three indexes.
      **Done:** the entity compiles, and its doc comment states why read state cannot live on the
      document row.

- [ ] **T2 · Register the entity in all three registries**
      Modify `packages/agent/src/entities/index.ts` (add the `export *`),
      `packages/agent/src/database/_entity-names.ts` (insert `'KnowledgeDocumentReaderState'`
      alphabetically into `AGENT_ENTITY_NAMES`), and
      `packages/agent/src/database/_entities-inventory.ts` (add the class to `ENTITIES`, line ~171).
      **Done:** the drift spec in `packages/agent/src/database/database.module.spec.ts` passes.

- [ ] **T3 · Columns on the document entity**
      Modify `packages/agent/src/entities/work-knowledge-document.entity.ts`: add `folderId`
      (`folder_id`, uuid, nullable), `revision` (int, not null, default 1), `revisionAt`
      (`revision_at`, timestamptz, nullable), `normalizedContentHash`
      (`normalized_content_hash`, varchar(64), nullable), `archivedAt` (`archived_at`), and
      `archivedById` (`archived_by_id`, uuid, nullable). Add the three new `@Index` declarations
      from [plan §3.2](./plan.md#32-new-columns-on-work_knowledge_documents).
      **Done:** compiles; each column carries a doc comment, and `revision`'s comment explains
      explicitly why `updatedAt` cannot be used instead.

- [ ] **T4 · Scope column and enum on the folder entity**
      Modify `packages/agent/src/entities/memory-folder.entity.ts`: add
      `export enum MemoryFolderScope { USER = 'user', ORGANIZATION = 'organization' }` and a
      `scope` column (varchar(16), not null, default `'user'`). Update the class doc comment to
      describe the two scopes and the two partial unique indexes.
      **Done:** compiles; the existing per-person semantics are unchanged when `scope = 'user'`.

- [ ] **T5 · Migration (SAME PR as T1–T4 — Constitution V)**
      Create `apps/api/src/migrations/1791060000000-AddKnowledgeLibraryFoldersAndReadState.ts`
      implementing the eight ordered steps in [plan §3.5](./plan.md#35-the-migration). Generate the
      starting point from `apps/api/` with
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddKnowledgeLibraryFoldersAndReadState`,
      then hand-edit: the partial-index recreation and the `revision_at` / `archived_at` backfills
      will not be generated.
      **Done:** the SQL is additive; the only `DROP INDEX` is `uq_memory_folders_user_path`,
      immediately recreated as a partial index over the same rows; `down()` carries a comment
      stating that reverting discards organization-scope folders and only unfiles documents;
      the migration applies cleanly to a database restored from a pre-change dump.

- [ ] **T6 · Migration test** *(parallel with T5)*
      Add a case to `apps/api/src/migrations/__tests__/` following the existing convention there.
      **Done:** the test asserts every new column exists with the right nullability and default,
      both partial unique indexes exist, and both foreign keys are `ON DELETE SET NULL`.

- [ ] **T7 · Activity-log action types**
      Modify `packages/agent/src/entities/activity-log.types.ts`: append
      `KB_DOCUMENT_ARCHIVED`, `KB_DOCUMENT_UNARCHIVED`, `KB_DOCUMENT_FILED`,
      `KB_DOCUMENT_EXPORTED`, `MEMORY_FOLDER_RENAMED` with a comment describing each `details`
      payload. Reorder nothing.
      **Done:** no migration needed (the column is varchar); existing enum members are untouched.

## P1.2 — Contracts

- [ ] **T8 · Library contract types and constants**
      Create `packages/contracts/src/kb/kb-library.types.ts` with the DTOs and every constant listed
      in [plan §4.3](./plan.md#43-contracts). Export it from
      `packages/contracts/src/kb/index.ts`.
      **Done:** `pnpm --filter @ever-works/contracts build` emits declarations without the
      conditional-spread DTS failure (use explicit `if` blocks, never `...cond && { k: v }`).

- [ ] **T9 · Contract unit spec** *(parallel with T8)*
      Create `packages/contracts/src/kb/__tests__/kb-library.types.spec.ts` next to the existing
      `kb-document-class.spec.ts`.
      **Done:** asserts every numeric constant's exact value, so a silent limit change breaks a test.

## P1.3 — Domain services

- [ ] **T10 · Reader-state repository**
      Create `packages/agent/src/database/repositories/knowledge-document-reader-state.repository.ts`
      with `findForUser(userId, documentIds)`, `upsertRead`, `upsertPin`, `deletePin`,
      `bulkMarkRead(userId, documentIds, revisions)`, `rollupsForUser(userId)`.
      Barrel it from `packages/agent/src/database/index.ts`.
      **Done:** `rollupsForUser` is a **single** grouped query returning per-folder booleans — no
      N+1 across folders.

- [ ] **T11 · Content-hash helper**
      Create `packages/agent/src/services/kb-content-hash.ts` exporting pure `normalizeBody` and
      `hashNormalizedBody`. Normalization: strip BOM, `\r\n` → `\n`, collapse every whitespace run
      to one space, trim.
      **Done:** pure, no I/O, no module state. Export it from
      `packages/agent/src/services/index.ts`.

- [ ] **T12 · Revision bumping in the document service**
      Modify `packages/agent/src/services/knowledge-base.service.ts`: on create and update, compute
      the normalized hash and bump `revision` + `revisionAt` **only** when the hash changed or the
      title / description / tags / class changed, and **only** when the stored hash was not `NULL`
      (first touch seeds the hash and never notifies).
      **Done:** background writes that only touch `lastCommitSha`, `lastIndexedAt` or chunk
      coordinates leave `revision` alone — asserted by a test, not by inspection.

- [ ] **T13 · Archive bookkeeping and un-archive**
      Modify `packages/agent/src/services/knowledge-base.service.ts`: `archiveDocument` also sets
      `archivedAt` / `archivedById`; add `unarchiveDocument(docId, userId)` that flips `status` to
      `active`, clears both columns, is idempotent, requires edit access, and logs
      `kb_document_unarchived`. Make the exclusion of `status = 'archived'` from context selection
      explicit.
      **Done:** archiving twice and un-archiving twice are both no-ops with a 200.

- [ ] **T14 · Shared-scope folders**
      Modify `packages/agent/src/services/memory-folders.service.ts` to accept a `scope`, enforce
      depth ≤ 5, sibling-name uniqueness (case-insensitive), name length 1–120, the 500-folder
      per-organization cap, and the move-into-own-subtree refusal for organization-scope folders.
      Organization-scope writes require organization-admin. Delete unfiles documents (the FK does
      the work) as well as files.
      **Done:** every per-person code path is byte-identical when `scope` is omitted, proven by the
      existing spec still passing untouched.

- [ ] **T15 · Knowledge-library service**
      Create `packages/agent/src/services/knowledge-library.service.ts`: `list`, `tree`, `search`,
      `fileDocuments`, and delegation to archive / un-archive. Scope every query to the caller's
      visible Works plus the active Organization, exactly as the org-memory aggregation does.
      Register it in `packages/agent/src/services/knowledge-base.module.ts` (providers **and**
      exports).
      **Done:** filing across organizations returns 422; a batch above 100 returns 422; the default
      list excludes archived documents; `tree` returns `hasUnread: false` everywhere in P1 (read
      state lands in P2) without a second code path.

- [ ] **T16 · Service unit specs** *(parallel with T15)*
      Create `packages/agent/src/services/__tests__/kb-content-hash.spec.ts`,
      `packages/agent/src/services/__tests__/knowledge-library.service.spec.ts`, and
      `packages/agent/src/services/knowledge-base.service.revision.spec.ts`. Extend
      `packages/agent/src/services/__tests__/memory-folders.service.spec.ts`.
      **Done:** every limit in [plan §4.3](./plan.md#43-contracts) has a passing negative test.

## P1.4 — API

- [ ] **T17 · Library module and controller**
      Create `apps/api/src/knowledge-library/knowledge-library.controller.ts`,
      `knowledge-library.module.ts` and `dto/knowledge-library.dto.ts` implementing the read
      endpoints (`GET library`, `GET tree`, `GET search`), `PATCH documents/file`,
      `POST documents/:docId/unarchive`, and `GET documents/:docId/export?format=md`. Guard with
      `AuthSessionGuard`, take the caller from `@CurrentUser()`, add full Swagger decorators, and
      apply the throttles from [plan §4.1](./plan.md#41-new-module).
      Register the module in `apps/api/src/api.module.ts` beside `MemoryFilesApiModule` (line ~83).
      **Done:** every DTO uses `class-validator`; a document outside the caller's scope returns
      **404**, never 403 with detail.

- [ ] **T18 · Un-archive on the per-Work controller**
      Modify `apps/api/src/works/kb.controller.ts`: add
      `POST works/:id/kb/documents/:docId/unarchive` delegating to the same service method as T13.
      **Do not modify `/restore`** — it keeps meaning "restore a body from a commit SHA"; the
      Swagger description of both must say so explicitly to prevent future confusion.
      **Done:** the two endpoints coexist with unambiguous documentation.

- [ ] **T19 · Scope on the folder endpoints**
      Modify `apps/api/src/memory-files/memory-files.controller.ts` and
      `apps/api/src/memory-files/dto/memory-files.dto.ts`: optional `scope` on folder create and on
      the tree query (default `'user'`), organization-admin authorization for organization-scope
      rename / move / delete.
      **Done:** every existing request shape produces byte-identical behaviour.

- [ ] **T20 · Controller specs**
      Create `apps/api/src/knowledge-library/knowledge-library.controller.spec.ts` and
      `apps/api/src/works/kb.controller.spec.ts`; extend
      `apps/api/src/memory-files/memory-files.controller.spec.ts`.
      **Done:** happy path plus validation, authorization and throttle assertions for every P1
      endpoint.

## P1.5 — Web

- [ ] **T21 · API client and BFF proxies**
      Create `apps/web/src/lib/api/knowledge-library.ts` (`server-only`, `serverFetch`, scope
      header — mirror `apps/web/src/lib/api/memory.ts`) and
      `apps/web/src/lib/api/knowledge-library-types.ts` (client-safe types). Create the P1 BFF
      routes under `apps/web/src/app/api/knowledge/`: `library/route.ts`, `tree/route.ts`,
      `search/route.ts`, `documents/file/route.ts`, `documents/[docId]/unarchive/route.ts`,
      `documents/[docId]/export/route.ts`, following the `apps/web/src/app/api/memory/files/**`
      pattern including its shared `proxy.ts` helper.
      **Done:** each route has a `route.unit.spec.ts` next to it, as the memory routes do.

- [ ] **T22 · Library panel shell**
      Create `apps/web/src/components/knowledge/LibraryPanel.tsx`,
      `LibraryFolderRail.tsx`, `LibraryDocumentList.tsx`, `LibraryDocumentRow.tsx`,
      `FolderPickerDialog.tsx`, `LibraryArchivedPanel.tsx` per
      [plan §5.1](./plan.md#51-new-components), implementing the wireframes in
      [spec §6.1–6.7](./spec.md#6-ux).
      **Done:** loading, empty-library, empty-folder, no-results, load-failed and over-limit states
      all render with the exact copy from the spec; the list virtualizes and paginates on
      `nextCursor`.

- [ ] **T23 · Mount the Library tab**
      Modify `apps/web/src/components/memory/MemoryShell.tsx` to add the `Library` tab and mount
      `LibraryPanel`, persisting the choice in `localStorage` under `memory-tab` and mirroring it to
      `?view=library`. Modify
      `apps/web/src/app/[locale]/(dashboard)/memory/page.tsx` to pre-fetch the tree and page 1.
      Add `DASHBOARD_MEMORY_LIBRARY` to `apps/web/src/lib/constants.ts` beside the existing
      `DASHBOARD_MEMORY_MEETINGS`.
      **Done:** the other panels are untouched; a deep link to `?view=library` renders without a
      loading flash.

- [ ] **T24 · Workbench header controls**
      Modify `apps/web/src/components/kb/workbench/KbDocumentHeader.tsx` and
      `KbDocumentContextMenu.tsx` to add the folder breadcrumb, File, Archive / Restore and Export
      controls, with the disabled-state tooltips from [spec §6.3](./spec.md#6-ux).
      **Done:** view-only members see the controls disabled with the exact tooltip copy, never
      hidden.

- [ ] **T25 · Component unit specs** *(parallel with T22–T24)*
      Add co-located `*.unit.spec.tsx` files for every new component, matching the convention in
      `apps/web/src/components/memory/` and `apps/web/src/components/kb/workbench/`.
      **Done:** each spec covers the component's empty, error and over-limit states.

## P1.6 — i18n, tests, docs

- [ ] **T26 · i18n keys (P1 subset)**
      Add the P1 keys from [plan §8](./plan.md#8-i18n) to `apps/web/messages/en.json`, then mirror
      them into all 20 sibling locale files in `apps/web/messages/`.
      **Done:** every leaf key name is camelCase and contains **no literal dot**; the hydration
      spec that fails on a missing-message console error stays green.

- [ ] **T27 · End-to-end specs (P1)**
      Create `apps/web/e2e/flow-knowledge-library-shelf.spec.ts` and
      `apps/web/e2e/flow-knowledge-library-archive-export.spec.ts`; extend
      `apps/web/e2e/flow-kb-workbench-metadata.spec.ts`.
      **Done:** they cover create folder → file documents → sort → paginate → archive → restore →
      restore-to-Unfiled → single-document Markdown export → over-cap message. Prefer
      `getByTestId` / `getByRole` with explicit names; avoid bare `*ByRole` queries that go flaky
      under CI load.

- [ ] **T28 · Docs**
      Add `docs/features/knowledge-library.md` describing the shelf, folders, archive and export
      for end users; cross-link it from `docs/features/index.md` and add it to
      `apps/docs/sidebarsPlatform.ts` (the sidebar is manual — unlisted files render as orphans).
      **Done:** `pnpm --filter ever-works-docs build` produces no broken-link warnings.

- [ ] **T29 · P1 gate**
      Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the repo
      root.
      **Done:** all green; the epic's `TRACKER.md` row is updated to `P1 shipped`.

---

# Phase P2 — Read state, pins and references

## P2.1 — Read-state service

- [ ] **T30 · Reader-state service**
      Create `packages/agent/src/services/knowledge-reader-state.service.ts` with
      `getStatesFor`, `markRead`, `markUnread`, `markFolderRead`, `pin`, `unpin`, `rollupsFor`.
      Implement the 30 s per-user rollup cache and invalidate it on that user's own writes.
      Register in `packages/agent/src/services/knowledge-base.module.ts`.
      **Done:** `markUnread` writes `lastReadRevision = 0` and preserves `lastOpenedAt` so the badge
      is `UPDATED`, never `NEW`; the pin cap of 20 is enforced with a typed error.

- [ ] **T31 · Wire read state into the library service**
      Modify `packages/agent/src/services/knowledge-library.service.ts` so `list` joins reader
      state to produce `readState` and `pinnedAt` per row, `tree` produces real `hasUnread`
      rollups, and the default sort becomes pinned-first then `revisionAt` descending.
      **Done:** one extra query per list page, not one per row; the pinned group is computed from
      the `(userId, pinnedAt)` index.

- [ ] **T32 · Reader-state unit spec** *(parallel with T30)*
      Create `packages/agent/src/services/__tests__/knowledge-reader-state.service.spec.ts`.
      **Done:** covers the full state machine from [spec §5.1](./spec.md#51-document-read-state--states-and-transitions),
      subtree folder mark-read, actor isolation, the cache and its invalidation, and the pin cap.

## P2.2 — Read-state API

- [ ] **T33 · Read-state endpoints**
      Modify `apps/api/src/knowledge-library/knowledge-library.controller.ts` to add
      `POST/DELETE documents/:docId/pin`, `POST documents/:docId/read`,
      `POST documents/:docId/unread`, and `POST read-all`, with the throttles from
      [plan §4.1](./plan.md#41-new-module).
      **Done:** all four require only view access; none of them writes an activity-log entry
      (spec FR-66); the controller spec asserts both.

- [ ] **T34 · Read-state BFF routes** *(parallel with T33)*
      Create `apps/web/src/app/api/knowledge/documents/[docId]/pin/route.ts`,
      `.../read/route.ts`, `.../unread/route.ts` and `apps/web/src/app/api/knowledge/read-all/route.ts`,
      each with a `route.unit.spec.ts`.
      **Done:** browser calls go through `browserApiFetch`, never bare `fetch`.

## P2.3 — Read-state UI

- [ ] **T35 · Badges, dots and the dwell hook**
      Create `apps/web/src/components/knowledge/ReadStateBadge.tsx`,
      `useReadDwell.ts` and `useLibraryRollups.ts`. Wire them into `LibraryDocumentRow`,
      `LibraryFolderRail` and the workbench header.
      **Done:** the badge exposes `New` / `Updated` as text to assistive technology; the dwell timer
      fires exactly once per (document, revision) and is cancelled on unmount; rollup dots animate
      in and never shift layout.

- [ ] **T36 · Mark-read affordances and undo**
      Add **Mark as read**, **Mark as unread**, **Mark folder as read** (with a 10 s undo) and the
      pin control to `LibraryDocumentRow`, the folder context menu and the workbench header, with
      the keyboard bindings from [spec §6.12](./spec.md#612-keyboard-affordances).
      **Done:** optimistic updates roll back on failure; the undo restores every affected row's
      prior revision, not just its badge.

- [ ] **T37 · "Changed while you were reading" banner**
      Add the banner from [spec §6.11](./spec.md#611-the-changed-while-you-were-reading-banner) to
      the document reader in `apps/web/src/components/kb/workbench/`.
      **Done:** non-blocking, does not steal focus, and dismissing it leaves the read mark at the
      revision the person actually saw.

## P2.4 — References

- [ ] **T38 · Parser: the `#` prefix**
      Modify `packages/agent/src/services/kb-mention-parser.ts` to accept `#<reference>` alongside
      `@kb:<reference>`, add the `prefix` field to `KbMention`, and reject `#` followed by
      whitespace and `#` preceded by a word character.
      Extend `packages/agent/src/services/__tests__/kb-mention-parser.spec.ts`.
      **Done:** every existing assertion in that spec still passes unmodified; `# Heading` in a
      Markdown body is never a reference.

- [ ] **T39 · Resolver: organization scope, ambiguity, budgets**
      Modify `packages/agent/src/services/kb-mention-resolver.service.ts` to accept
      `{ workId?, organizationId }`, return `ambiguous` for a `#` reference matching more than one
      visible document, and enforce `KB_REFERENCE_MAX_PER_MESSAGE` and
      `KB_REFERENCE_TOKEN_BUDGET`, reporting `injectedTokens` and `truncated` per document.
      Extend `packages/agent/src/services/__tests__/kb-mention-resolver.service.spec.ts`.
      **Done:** an inaccessible document and a nonexistent one produce identical results
      (spec FR-60), asserted by a test.

- [ ] **T40 · Reference-search endpoint**
      Add `GET api/knowledge/search` handling to
      `apps/api/src/knowledge-library/knowledge-library.controller.ts` (if not already added in
      T17, tighten it here): at most 8 results, archived excluded, ranked
      most-recently-read-by-me → title prefix → title substring → slug.
      Create the BFF route `apps/web/src/app/api/knowledge/search/route.ts`.
      **Done:** P95 under 200 ms against a 2 000-document library; throttled 120/min.

- [ ] **T41 · The `#` picker component**
      Create `apps/web/src/components/common/DocumentReferenceAutocomplete.tsx`, modelled on
      `apps/web/src/components/skills/SlashCommandAutocomplete.tsx` but with a 150 ms debounced
      server query. Include a `__resetDocumentReferenceCache()` test seam, as the slash-command
      component does.
      **Done:** every failure mode degrades to "no popup, text submits as typed"; loading,
      no-match and empty-library states match [spec §6.9](./spec.md#69-the--reference-picker-in-a-composer).

- [ ] **T42 · Mount the picker in every composer**
      Modify `apps/web/src/components/ai/ChatInput.tsx`,
      `apps/web/src/components/common/PromptComposer.tsx`,
      `apps/web/src/components/agents/Composer.tsx`, and
      `apps/web/src/components/tasks/TaskDetailClient.tsx` (which already hosts the slash-command
      popup — add a second trigger, not a second pattern). Create
      `apps/web/src/components/kb/workbench/extensions/document-reference-suggestion.ts` beside the
      existing `mention-suggestion.ts` and `wikilink-suggestion.ts`, and register it on
      `apps/web/src/components/kb/workbench/TiptapEditor.tsx`.
      **Done:** `#` opens the picker in all five surfaces; the pre-send hints from
      [spec §6.9](./spec.md#69-the--reference-picker-in-a-composer) render for ambiguous, not-found
      and over-limit references.

- [ ] **T43 · Reference rendering after send**
      Render a resolved reference as the document title hyperlinked, with the hover card and the
      `(archived)` affix from [spec §6.10](./spec.md#610-how-a-reference-renders-after-sending).
      Touch `apps/web/src/components/ai/ChatMessageContent.tsx` and the task-comment renderer.
      **Done:** an unresolved reference renders as plain text with no link and no hover card.

- [ ] **T44 · Agent-run splice**
      Modify `packages/agent/src/agents/agent-run.service.ts` to parse, resolve, format and inject
      references immediately after the memory-recall block (currently ending around line 445),
      write one `WorkKnowledgeCitation` per resolved document with `consumerType = 'agent-run'`,
      and emit a `kb-references` step log with `{ resolved, unresolved, ambiguous, truncated,
      tokens }`. Apply the same helper in
      `packages/agent/src/pipeline/full-pipeline-executor.service.ts`.
      Create `packages/agent/src/agents/__tests__/agent-run.references.spec.ts`.
      **Done:** a resolution failure logs and **continues** — it never fails the run, matching the
      memory-recall contract.

- [ ] **T45 · Conversation path uses the shared helper**
      Modify `apps/api/src/ai-conversation/openai-compat.service.ts` (the `parseKbMentions` call at
      line ~379) to route through the same resolver entry point as T44, so `@kb:` and `#` cannot
      drift between surfaces.
      **Done:** the existing conversation behaviour is unchanged for `@kb:`, proven by the existing
      specs passing untouched.

## P2.5 — P2 wrap-up

- [ ] **T46 · i18n keys (P2 subset)**
      Add the read-state, pin and `common.documentReference.*` keys from
      [plan §8](./plan.md#8-i18n) to `apps/web/messages/en.json` and all 20 sibling locales.
      **Done:** camelCase leaves, no literal dots.

- [ ] **T47 · End-to-end specs (P2)**
      Create `apps/web/e2e/flow-knowledge-library-read-state.spec.ts` and
      `apps/web/e2e/flow-knowledge-reference-composer.spec.ts`.
      **Done:** read-state covers `NEW` → open → cleared, edit → `UPDATED`, rollup dot appear and
      clear, mark-folder-read plus undo, and a second account's badges being unaffected;
      reference covers picker → insert → send → resolved link, ambiguity and no-match hints, the
      archived affix, and `# Heading` staying literal.

- [ ] **T48 · Telemetry**
      Emit the events in [plan §9.2](./plan.md#92-product-analytics) through `packages/monitoring`,
      and the activity-log entries in [plan §9.1](./plan.md#91-activity-log-audited-low-frequency).
      **Done:** marking read and pinning emit analytics but **no** activity-log rows.

- [ ] **T49 · P2 gate**
      Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done:** all green; `TRACKER.md` updated to `P2 shipped`.

---

# Phase P3 — Export at scale and PDF

- [ ] **T50 · Export service**
      Create `packages/agent/src/services/knowledge-export.service.ts`: resolve the document set,
      re-check view access **per document** as the requesting user, stream bodies through
      `packages/agent/src/facades/git.facade.ts`, assemble a `.zip` with `jszip` (already a
      dependency of `packages/agent`) mirroring the folder tree, write `<slug>.md` with YAML front
      matter, record unreadable documents in `MISSING.txt`, and abort past `KB_EXPORT_MAX_BYTES`.
      Deliver ≤ 25 documents synchronously; dispatch above that.
      Create `packages/agent/src/services/__tests__/knowledge-export.service.spec.ts`.
      **Done:** the caps in [spec §4.6](./spec.md#46-export) each produce the exact message from
      [spec §6.8](./spec.md#68-export-dialog).

- [ ] **T51 · Dispatcher symbol and binding**
      Add `KNOWLEDGE_EXPORT_DISPATCHER` to `packages/agent/src/tasks/_tasks-symbols.ts`; create
      `packages/agent/src/tasks/knowledge-export-dispatcher.ts` and
      `packages/agent/src/tasks/knowledge-export.types.ts` copying the shape of
      `packages/agent/src/tasks/kb-embed-document-dispatcher.ts`; register the binding in
      `packages/agent/src/tasks/job-runtime.providers.ts`.
      **Done:** no call site imports a job-runtime vendor SDK (Constitution IV).

- [ ] **T52 · Background task**
      Create `packages/tasks/src/tasks/trigger/knowledge-export.task.ts` and export it from
      `packages/tasks/src/tasks/trigger/index.ts`. Give it a `queue:` config so exports cannot
      starve the mirror and embed queues. Derive the idempotency key as
      `kb-export:{userId}:{requestHash}`. Write the archive through the `KB_STORAGE_PLUGIN` token
      (provided globally by `apps/api/src/uploads/kb-storage.module.ts`) at
      `kb-exports/{userId}/{jobId}.zip`.
      **Done:** a retried dispatch produces one archive, not two.

- [ ] **T53 · Export endpoints and notification**
      Add `POST api/knowledge/export` and `GET api/knowledge/export/:jobId` to
      `apps/api/src/knowledge-library/knowledge-library.controller.ts` (owner-only on the poll),
      and notify the requester through
      `packages/agent/src/notifications/notification.service.ts` with a link expiring after
      `KB_EXPORT_LINK_TTL_HOURS`. Create the BFF routes
      `apps/web/src/app/api/knowledge/export/route.ts` and `export/[jobId]/route.ts`.
      **Done:** an expired link returns the exact `exportLinkExpired` copy; a missing storage plugin
      returns `503` naming the missing **capability**, never a plugin id.

- [ ] **T54 · Export dialog**
      Create `apps/web/src/components/knowledge/LibraryExportDialog.tsx` implementing
      [spec §6.8](./spec.md#68-export-dialog), including the queued / ready / partial toasts and the
      two over-cap messages.
      **Done:** all six export states render with the exact copy.

- [ ] **T55 · Document-render capability**
      Create `packages/plugin/src/contracts/capabilities/document-render.interface.ts` and export it
      from `packages/plugin/src/contracts/capabilities/index.ts`; create
      `packages/agent/src/facades/document-render.facade.ts` and register it in
      `packages/agent/src/facades/facades.module.ts` and `index.ts`.
      **Done:** the export service asks the facade for a renderer for the scope and never names a
      plugin id (Constitution II).

- [ ] **T56 · First-party PDF plugin**
      Create `packages/plugins/document-render-local/` — ESM, `tsup`, Vitest, an `everworks.plugin`
      block in `package.json` declaring the `document-render` capability, and a settings JSON
      schema. Add it to the canonical list in `docs/plugin-system/built-in-plugins.md` and **only**
      there (Constitution VIII).
      **Done:** `pnpm build:plugins` succeeds; the plugin's own Vitest suite passes; with the plugin
      absent, the PDF option is hidden in the UI and the endpoint returns `503`.

- [ ] **T57 · i18n keys (P3 subset) and end-to-end coverage**
      Add the remaining export keys across all 21 locale files; extend
      `apps/web/e2e/flow-knowledge-library-archive-export.spec.ts` with the asynchronous zip path
      (queued → notification → download) and the PDF format.
      **Done:** camelCase leaves, no literal dots; the e2e asserts the 24-hour link and the partial
      `MISSING.txt` outcome.

- [ ] **T58 · P3 gate and epic close-out**
      Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`. Update
      `spec.md` status to `Implemented`, mark this file `Done`, update
      `docs/specs/features/agent-workspace/TRACKER.md`, and resolve or re-file every
      `[NEEDS CLARIFICATION]` marker in [spec §9](./spec.md#9-open-questions).
      **Done:** all green, no unresolved clarification markers left silently in the spec.

---

## Definition of done (whole epic)

- Every checkbox above is ticked.
- Every functional requirement in [spec §4](./spec.md#4-functional-requirements) has a passing
  unit, controller or end-to-end test.
- Every acceptance criterion in [spec §8](./spec.md#8-acceptance-criteria) has been run by a
  reviewer against the merged change.
- `pnpm format:check` and `pnpm lint` are green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- The constitution gates in [spec §10](./spec.md#10-constitution-gates) and
  [plan §12](./plan.md#12-constitution-compliance) are confirmed satisfied.
- The Agent Workspace program vocabulary table in [../README.md](../README.md) carries the one new
  noun this epic introduced (**reader state**), added in the same change that ships it.
