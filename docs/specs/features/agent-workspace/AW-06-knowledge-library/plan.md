# AW-06 — Knowledge library · Implementation plan

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-06-knowledge-library`
**Spec:** [spec.md](./spec.md) · **Tasks:** [tasks.md](./tasks.md)
**Status:** `Draft` · **Last updated:** 2026-09-06
**Repo:** `ever-works/ever-works` (pnpm + Turborepo monorepo)

> Every path in this document was verified to exist before it was cited. Paths marked **(new)** are
> files this epic creates.

---

## 1. Current state in the codebase

### 1.1 Documents — the substrate we are building on

| What | Where |
| --- | --- |
| Document entity | [`packages/agent/src/entities/work-knowledge-document.entity.ts`](../../../../../packages/agent/src/entities/work-knowledge-document.entity.ts) — `@Entity('work_knowledge_documents')`, `workId` XOR `organizationId` CHECK, `path` / `slug` / `title` / `description`, `kbDocumentClass`, `tags`, `status`, `locked` + `lockMode`, `wordCount` / `tokenCount`, `source`, `generatedByAgentRunId`, `createdById` / `updatedById`, `lastIndexedAt`, `lastCommitSha`, `metadata`, `consolidation`, `decision`, `reviewState`, `createdAt` / `updatedAt`. Indexes on `(workId, kbDocumentClass)`, `(organizationId, kbDocumentClass)`, `(workId, status)`, `(workId, updatedAt)`. |
| Shared enums | [`packages/agent/src/entities/kb-types.ts`](../../../../../packages/agent/src/entities/kb-types.ts) — `KbDocumentClass` (11 members), `KbDocumentStatus` (`draft` / `active` / `archived`), `KbLockMode`, `KbDocumentSource`, `KbReviewState`, `KbCitationConsumerType`, `KB_ORG_INHERITABLE_CLASSES`, `KB_ALWAYS_INJECTED_CLASSES`, `WorkKbConfig` (holds `retrievalConfig.maxContextDocs = 12`, `maxContextTokens = 8000`). |
| Domain service | [`packages/agent/src/services/knowledge-base.service.ts`](../../../../../packages/agent/src/services/knowledge-base.service.ts) — create / update / delete / lock / unlock / restore-from-history / archive / accept / list / getDocument, plus `ensureCanView` / edit gates. |
| Module | [`packages/agent/src/services/knowledge-base.module.ts`](../../../../../packages/agent/src/services/knowledge-base.module.ts) |
| Repository | [`packages/agent/src/database/repositories/work-knowledge-document.repository.ts`](../../../../../packages/agent/src/database/repositories/work-knowledge-document.repository.ts), barrelled from [`packages/agent/src/database/index.ts`](../../../../../packages/agent/src/database/index.ts) |
| Per-Work REST | [`apps/api/src/works/kb.controller.ts`](../../../../../apps/api/src/works/kb.controller.ts) — `@Controller('api')`, `AuthSessionGuard`. Already has `works/:id/kb/documents/:docId/archive` (line ~341) and `.../restore` (line ~249, **restores a body from a commit SHA — not un-archive**). There is **no un-archive endpoint today.** |
| Org-scope REST | [`apps/api/src/works/org-kb.controller.ts`](../../../../../apps/api/src/works/org-kb.controller.ts) |
| Org-wide aggregation REST | [`apps/api/src/works/org-memory.controller.ts`](../../../../../apps/api/src/works/org-memory.controller.ts) — `GET memory` returns documents + facets + counts for the active Organization; `MEMORY_MAX_LIMIT = 200`. |

### 1.2 Folders — exist, but only for uploaded files and only per person

| What | Where |
| --- | --- |
| Folder entity | [`packages/agent/src/entities/memory-folder.entity.ts`](../../../../../packages/agent/src/entities/memory-folder.entity.ts) — `@Entity('memory_folders')`. `userId`, `parentId` (raw uuid, no self-relation — the no-cycle rule), `path` (materialized absolute path), `ownerAgentId`, `syncRepo`, Tier C `tenantId` / `organizationId`. Unique index `uq_memory_folders_user_path` on `(userId, path)`; index `idx_memory_folders_user_parent` on `(userId, parentId)`. |
| Folder service | [`packages/agent/src/services/memory-folders.service.ts`](../../../../../packages/agent/src/services/memory-folders.service.ts) — create / rename / move / delete, maintains the materialized `path` across a subtree. |
| Folder repository | [`packages/agent/src/database/repositories/memory-folder.repository.ts`](../../../../../packages/agent/src/database/repositories/memory-folder.repository.ts) |
| Files service | [`packages/agent/src/services/memory-files.service.ts`](../../../../../packages/agent/src/services/memory-files.service.ts) — the unified list across both upload spines. |
| Folder REST | [`apps/api/src/memory-files/memory-files.controller.ts`](../../../../../apps/api/src/memory-files/memory-files.controller.ts) (`api/memory/files/...`), module [`memory-files.module.ts`](../../../../../apps/api/src/memory-files/memory-files.module.ts), DTOs [`dto/memory-files.dto.ts`](../../../../../apps/api/src/memory-files/dto/memory-files.dto.ts). Registered at [`apps/api/src/api.module.ts:83`](../../../../../apps/api/src/api.module.ts). |

**Gap:** documents cannot be placed in a folder, and folders are invisible to teammates.

### 1.3 References — parse and resolve exist, wired into one surface only

| What | Where |
| --- | --- |
| Parser | [`packages/agent/src/services/kb-mention-parser.ts`](../../../../../packages/agent/src/services/kb-mention-parser.ts) — `parseKbMentions(text)`, grammar `@kb:[A-Za-z0-9/_.\-]+` with a `(?<![A-Za-z0-9_])` boundary. Spec at [`__tests__/kb-mention-parser.spec.ts`](../../../../../packages/agent/src/services/__tests__/kb-mention-parser.spec.ts). |
| Resolver | [`packages/agent/src/services/kb-mention-resolver.service.ts`](../../../../../packages/agent/src/services/kb-mention-resolver.service.ts) — `resolveMentions(workId, userId, mentions)`, `.md`-suffix retry, `ensureCanView` gate, dedup. |
| Context formatting | [`packages/agent/src/services/kb-prompt-formatter.ts`](../../../../../packages/agent/src/services/kb-prompt-formatter.ts) (`<kb>…</kb>` block, budget truncation) and [`kb-context-bundle.ts`](../../../../../packages/agent/src/services/kb-context-bundle.ts). |
| The **only** wiring today | [`apps/api/src/ai-conversation/openai-compat.service.ts`](../../../../../apps/api/src/ai-conversation/openai-compat.service.ts) — `parseKbMentions(latestUser)` at line ~379, inside the AI-conversation path, scoped to one Work. |
| Citations (audit of what was read) | [`packages/agent/src/entities/work-knowledge-citation.entity.ts`](../../../../../packages/agent/src/entities/work-knowledge-citation.entity.ts) — `consumerType` already includes `agent-run` and `conversation-message`. |

**Gap:** agent runs do not resolve references at all; there is no picker; there is no `#` trigger.

### 1.4 Where the memory-recall splice lives (the pattern to copy)

[`packages/agent/src/agents/agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) lines ~376–445 splice a fenced recall block into `prompt.systemMessage` via `resolveMemoryRecall` from
[`packages/agent/src/services/memory-recall.ts`](../../../../../packages/agent/src/services/memory-recall.ts), emitting a step log for every outcome (`injected` / `empty` / `no-provider` / `failed`).
[`packages/agent/src/pipeline/full-pipeline-executor.service.ts`](../../../../../packages/agent/src/pipeline/full-pipeline-executor.service.ts) and
[`packages/agent/src/pr-review/pr-review.service.ts`](../../../../../packages/agent/src/pr-review/pr-review.service.ts) use the same helper.
**Reference resolution splices in exactly here, immediately after recall.**

### 1.5 Web surfaces

| What | Where |
| --- | --- |
| Org-wide knowledge page (RSC) | [`apps/web/src/app/[locale]/(dashboard)/memory/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/memory/page.tsx>) |
| Its client shell | [`apps/web/src/components/memory/MemoryShell.tsx`](../../../../../apps/web/src/components/memory/MemoryShell.tsx) (766 lines: search box, header counters, facet chips, ranked document list) + `MemoryFilesPanel`, `MemoryUploadsPanel`, `AgentMemoryPanel`, `MemoryReviewPanel`, `MemoryConsolidationSettings`, `MemoryMeetingsPanel` |
| Route constant | [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) — `ROUTES.DASHBOARD_MEMORY = '/memory'` (line 164) |
| BFF proxies | [`apps/web/src/app/api/memory/route.ts`](../../../../../apps/web/src/app/api/memory/route.ts), `api/memory/files/**`, `api/memory/review/**`, `api/memory/health/route.ts` |
| API clients | [`apps/web/src/lib/api/memory.ts`](../../../../../apps/web/src/lib/api/memory.ts), [`memory-types.ts`](../../../../../apps/web/src/lib/api/memory-types.ts), [`kb.ts`](../../../../../apps/web/src/lib/api/kb.ts) |
| Per-Work workbench | [`apps/web/src/app/[locale]/(dashboard)/works/[id]/kb/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/kb/page.tsx>) → [`apps/web/src/components/kb/workbench/WorkbenchShell.tsx`](../../../../../apps/web/src/components/kb/workbench/WorkbenchShell.tsx), with `KbTreePanel`, `KbDocumentHeader`, `KbDocumentContextMenu`, `KbMetadataPanel`, `TiptapEditor` |
| Existing typeahead precedents | [`apps/web/src/components/skills/SlashCommandAutocomplete.tsx`](../../../../../apps/web/src/components/skills/SlashCommandAutocomplete.tsx) (a `/` popup with a module-level cache, used from [`apps/web/src/components/tasks/TaskDetailClient.tsx`](../../../../../apps/web/src/components/tasks/TaskDetailClient.tsx)); [`apps/web/src/components/kb/workbench/extensions/mention-suggestion.ts`](../../../../../apps/web/src/components/kb/workbench/extensions/mention-suggestion.ts) and [`wikilink-suggestion.ts`](../../../../../apps/web/src/components/kb/workbench/extensions/wikilink-suggestion.ts) (rich-text suggestion plugins) |
| Composers that must gain `#` | [`apps/web/src/components/ai/ChatInput.tsx`](../../../../../apps/web/src/components/ai/ChatInput.tsx), [`apps/web/src/components/common/PromptComposer.tsx`](../../../../../apps/web/src/components/common/PromptComposer.tsx) (shared by `/missions`, `/ideas`, `/new`, `/agents`, `/works/new`), [`apps/web/src/components/agents/Composer.tsx`](../../../../../apps/web/src/components/agents/Composer.tsx), `TaskDetailClient.tsx` (comments), `TiptapEditor.tsx` (document bodies) |

### 1.6 Background work + audit

| What | Where |
| --- | --- |
| Dispatcher symbols | [`packages/agent/src/tasks/_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts) — 7 `KB_*_DISPATCHER` symbols today |
| Binding factory | [`packages/agent/src/tasks/job-runtime.providers.ts`](../../../../../packages/agent/src/tasks/job-runtime.providers.ts) |
| A dispatcher to copy | [`packages/agent/src/tasks/kb-embed-document-dispatcher.ts`](../../../../../packages/agent/src/tasks/kb-embed-document-dispatcher.ts) + [`kb-embed-document.types.ts`](../../../../../packages/agent/src/tasks/kb-embed-document.types.ts) |
| Task implementations | [`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/) — `kb-mirror-document.task.ts`, `kb-embed-document.task.ts`, `kb-reconcile.task.ts`, barrelled by [`index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) |
| Storage plugin token | `KB_STORAGE_PLUGIN`, provided globally by [`apps/api/src/uploads/kb-storage.module.ts`](../../../../../apps/api/src/uploads/kb-storage.module.ts) |
| Activity log enum | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) — has `KB_DOCUMENT_CREATED/UPDATED/DELETED/LOCKED/UNLOCKED/RESTORED`, `MEMORY_FOLDER_CREATED/DELETED/SYNCED`. **No archive, un-archive, filed, renamed or exported members yet.** |
| Entity registries | [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts), [`packages/agent/src/database/_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts) (`AGENT_ENTITY_NAMES`), [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts) (`ENTITIES`, line 171) |
| Migrations | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/) — 175 files, latest `1789100000000-AddTaskGraphFanout.ts` |
| Contracts | [`packages/contracts/src/kb/`](../../../../../packages/contracts/src/kb/) — `kb-document.types.ts`, `kb-tree.types.ts`, `kb-search.types.ts`, `index.ts`, re-exported from [`packages/contracts/src/index.ts:5`](../../../../../packages/contracts/src/index.ts) |

---

## 2. Architecture and the seam

```
                        ┌─────────────────────────────────────────────────────┐
   apps/web             │  /memory  →  MemoryShell                            │
                        │    ├── (existing) List · Files · Agent memory ·     │
                        │    │              Review · Uploads · Meetings       │
                        │    └── LibraryPanel            ◄── NEW              │
                        │            ├── LibraryFolderRail                    │
                        │            ├── LibraryDocumentList                  │
                        │            └── ArchivedPanel                        │
                        │  /works/[id]/kb → KbDocumentHeader gains the same   │
                        │            pin / file / archive / export controls   │
                        │  every composer → DocumentReferenceAutocomplete     │
                        └───────────────┬─────────────────────────────────────┘
                                        │  BFF  /api/knowledge/**
                        ┌───────────────▼─────────────────────────────────────┐
   apps/api             │  KnowledgeLibraryController      (new module)       │
                        │   api/knowledge/library|tree|search|documents|export│
                        │  KbController        + .../unarchive  (added)       │
                        │  MemoryFilesController + ?scope=organization (added)│
                        └───────────────┬─────────────────────────────────────┘
                                        │
      ┌─────────────────────────────────▼──────────────────────────────────────┐
      │  packages/agent                                                        │
      │                                                                        │
      │   KnowledgeLibraryService ─── reads ──► WorkKnowledgeDocumentRepository │
      │        │                                     (+ folderId, revision)    │
      │        ├── uses ─► MemoryFoldersService  (shared-scope folders)         │
      │        └── uses ─► KnowledgeReaderStateService ─► reader-state repo NEW │
      │                                                                        │
      │   KnowledgeBaseService  ── bumps `revision` on substantive change ──┐   │
      │                            (normalized-body hash comparison)        │   │
      │                                                                     ▼   │
      │   KbMentionResolverService  ◄── extended: `#` grammar + org-wide scope  │
      │        ▲                                                               │
      │        └── spliced into AgentRunService right after memory recall       │
      │                                                                        │
      │   KNOWLEDGE_EXPORT_DISPATCHER ─► packages/tasks knowledge-export.task   │
      └────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Seam decisions and why

1. **Folders are the existing folder entity with a new scope, not a new entity.** `memory_folders`
   already implements the materialized-path tree, the no-cycle rule, subtree rewrites on rename,
   and the API. Adding a `scope` discriminator (`user` | `organization`) is strictly cheaper than a
   parallel tree, and it honours the program's no-duplicate-nouns rule.
2. **Document→folder membership is one nullable column on the document**, mirroring how
   `user_uploads.folderId` and `work_knowledge_uploads.folderId` already work. `ON DELETE SET NULL`
   gives us FR-14 (deleting a folder unfiles, never deletes) for free.
3. **Read state is its own table, keyed `(userId, documentId)`, written lazily.** No row exists
   until a person opens or pins a document, so a 2 000-document library with 50 members does not
   allocate 100 000 rows on day one.
4. **`revision` is a dedicated integer, not `updatedAt`.** `updatedAt` is an `@UpdateDateColumn`
   that moves whenever the mirror task stamps `lastCommitSha` or the embed task stamps
   `lastIndexedAt` — using it would fire `UPDATED` for every reader on every background sweep. This
   is the single most important correctness decision in the epic (spec S-11).
5. **The library is a panel on the existing knowledge page, not a new route.** The org-wide
   aggregation, the scope resolution, the search box and the facet plumbing are already there.
6. **Reference resolution moves into a shared helper** that both the AI-conversation path and the
   agent-run path call, so `@kb:` behaviour cannot drift between surfaces.

---

## 3. Data model

All changes are additive. One new table, five new document columns, one new folder column, two
index changes (both widenings), and two new TypeScript enums. Per Constitution V the entity changes
and the migration ship **in the same PR**.

### 3.1 New entity — reader state

**File (new):** `packages/agent/src/entities/knowledge-document-reader-state.entity.ts`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | generated |
| `userId` | `uuid NOT NULL` | raw uuid, no `@ManyToOne` (no-cycle rule) |
| `documentId` | `uuid NOT NULL` | FK → `work_knowledge_documents.id`, `ON DELETE CASCADE` |
| `lastOpenedAt` | `timestamptz NULL` | set the first time the document is recorded as read |
| `lastReadRevision` | `int NOT NULL DEFAULT 0` | `0` means "opened before, treat as unread" — this is what **mark as unread** writes |
| `pinnedAt` | `timestamptz NULL` | non-null ⇒ pinned; ordering key for the pinned group |
| `tenantId` | `uuid NULL` | Tier C scope stamp |
| `organizationId` | `uuid NULL` | Tier C scope stamp |
| `createdAt` / `updatedAt` | timestamps | |

Indexes:

- `uq_knowledge_reader_state_user_doc` UNIQUE `(userId, documentId)`
- `idx_knowledge_reader_state_user_pinned` `(userId, pinnedAt)` — the pinned group query
- `idx_knowledge_reader_state_doc` `(documentId)` — cascade + per-document cleanups

Registration (three places, or the drift spec fails):

- `export * from './knowledge-document-reader-state.entity'` in `packages/agent/src/entities/index.ts`
- `'KnowledgeDocumentReaderState'` inserted alphabetically into `AGENT_ENTITY_NAMES` in `packages/agent/src/database/_entity-names.ts`
- the class added to `ENTITIES` in `packages/agent/src/database/_entities-inventory.ts`

### 3.2 New columns on `work_knowledge_documents`

**File:** `packages/agent/src/entities/work-knowledge-document.entity.ts`

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `folder_id` | `uuid NULL` | `NULL` | FK → `memory_folders.id`, `ON DELETE SET NULL`. `NULL` ⇒ **Unfiled**. |
| `revision` | `int NOT NULL` | `1` | Monotonic substantive-change counter (FR-23). |
| `revision_at` | `timestamptz NULL` | `NULL` | When `revision` last moved — powers the "changed 06:04" column without trusting `updatedAt`. |
| `normalized_content_hash` | `varchar(64) NULL` | `NULL` | SHA-256 of the whitespace-normalized body. The comparison input for FR-24. |
| `archived_at` | `timestamptz NULL` | `NULL` | Set on archive, cleared on un-archive. |
| `archived_by_id` | `uuid NULL` | `NULL` | FK → `users.id`, `ON DELETE SET NULL`. Renders "archived 12 Aug by …". |

New indexes:

- `idx_wkd_folder` on `(folder_id)` — the folder-filtered list
- `idx_wkd_org_status_revision_at` on `(organization_id, status, revision_at DESC)` — the default library sort
- `idx_wkd_work_status_revision_at` on `(work_id, status, revision_at DESC)` — the per-Work variant

The document's folder must belong to the same Organization; this is a **service-layer** invariant
(422 on violation), not a database CHECK, because the document's effective organization can come
from its Work rather than from its own `organizationId`.

### 3.3 New column + index change on `memory_folders`

**File:** `packages/agent/src/entities/memory-folder.entity.ts`

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `scope` | `varchar(16) NOT NULL` | `'user'` | `'user'` (today's behaviour, per-person, holds uploaded files) or `'organization'` (new, shared, holds documents). |

New enum in the same file:

```ts
export enum MemoryFolderScope {
    USER = 'user',
    ORGANIZATION = 'organization',
}
```

Index change (a **widening**, forward-only, no data loss):

1. `DROP INDEX uq_memory_folders_user_path` and recreate it as a **partial** unique index
   `uq_memory_folders_user_path` on `(user_id, path) WHERE scope = 'user'`. Every existing row is
   backfilled to `scope = 'user'` first, so the constraint it enforces over existing data is
   identical.
2. `CREATE UNIQUE INDEX uq_memory_folders_org_path` on `(organization_id, path)
   WHERE scope = 'organization'`.
3. `CREATE INDEX idx_memory_folders_org_parent` on `(organization_id, parent_id)
   WHERE scope = 'organization'`.

The down migration recreates the original non-partial unique index after deleting organization-scope
rows — documented in the migration's `down()` with an explicit comment that running it discards
shared folders (documents are only unfiled, never deleted).

### 3.4 New enum members on the activity-log action type

**File:** `packages/agent/src/entities/activity-log.types.ts` — appended, nothing reordered.
`actionType` is a free `varchar(50)`, so **no migration is required** for these:

```
KB_DOCUMENT_ARCHIVED   = 'kb_document_archived'
KB_DOCUMENT_UNARCHIVED = 'kb_document_unarchived'
KB_DOCUMENT_FILED      = 'kb_document_filed'
KB_DOCUMENT_EXPORTED   = 'kb_document_exported'
MEMORY_FOLDER_RENAMED  = 'memory_folder_renamed'
```

### 3.5 The migration

**File (new):** `apps/api/src/migrations/1789200000000-AddKnowledgeLibraryFoldersAndReadState.ts`

Ordered steps in `up()`:

1. `ALTER TABLE memory_folders ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'user'`.
2. `UPDATE memory_folders SET scope = 'user' WHERE scope IS NULL` (belt and braces).
3. Drop and recreate `uq_memory_folders_user_path` as partial; create
   `uq_memory_folders_org_path` and `idx_memory_folders_org_parent`.
4. `ALTER TABLE work_knowledge_documents` add `folder_id`, `revision`, `revision_at`,
   `normalized_content_hash`, `archived_at`, `archived_by_id`.
5. FK `work_knowledge_documents.folder_id → memory_folders(id) ON DELETE SET NULL`;
   FK `work_knowledge_documents.archived_by_id → users(id) ON DELETE SET NULL`.
6. Backfill `revision = 1` (the column default already does this) and
   `revision_at = COALESCE(updated_at, created_at)` so the first library render has a sensible
   sort key. Backfill `archived_at = updated_at WHERE status = 'archived'`.
7. Create the three new document indexes (§3.2).
8. `CREATE TABLE knowledge_document_reader_states` with its three indexes and two FKs.

`normalized_content_hash` is intentionally **left NULL** by the migration. The first substantive-
change check on a document with a NULL hash computes and stores the hash and does **not** bump the
revision — so no document in the fleet fires a spurious `UPDATED` on the day this ships. This
"first touch seeds, never notifies" rule is unit-tested.

---

## 4. API

All endpoints are JWT-guarded with `AuthSessionGuard` and take the caller from `@CurrentUser()`.
Organization scope is resolved from the active scope context exactly as the existing org-memory
controller does.

### 4.1 New module

**Files (new):**
`apps/api/src/knowledge-library/knowledge-library.controller.ts`,
`knowledge-library.module.ts`,
`dto/knowledge-library.dto.ts`.
Registered in `apps/api/src/api.module.ts` next to `MemoryFilesApiModule` (line 83).

| Method | Path | Body / query | Auth |
| --- | --- | --- | --- |
| `GET` | `api/knowledge/library` | `folderId?` (`uuid` \| `unfiled`), `pinned?`, `unread?` (`new`\|`updated`\|`any`), `archived?` (`exclude`\|`only`\|`include`, default `exclude`), `q?`, `class?` (repeatable), `workId?`, `sort?` (`recent`\|`title`\|`unread`, default `recent`), `limit?` (default 50, max 200), `cursor?` | view |
| `GET` | `api/knowledge/tree` | — | view |
| `GET` | `api/knowledge/search` | `q` (required, 1–128 chars), `limit?` (default 8, max 8) | view |
| `POST` | `api/knowledge/documents/:docId/pin` | — | view |
| `DELETE` | `api/knowledge/documents/:docId/pin` | — | view |
| `POST` | `api/knowledge/documents/:docId/read` | `{ revision?: number }` | view |
| `POST` | `api/knowledge/documents/:docId/unread` | — | view |
| `POST` | `api/knowledge/read-all` | `{ folderId?: string \| null }` | view |
| `PATCH` | `api/knowledge/documents/file` | `{ documentIds: string[] (1–100), folderId: string \| null }` | edit |
| `POST` | `api/knowledge/documents/:docId/unarchive` | — | edit |
| `POST` | `api/knowledge/export` | `{ folderId?, documentIds?, format: 'md' \| 'pdf', includeArchived?: boolean, includeOriginals?: boolean }` | view |
| `GET` | `api/knowledge/export/:jobId` | — | view (owner only) |
| `GET` | `api/knowledge/documents/:docId/export` | `format=md` | view |

Throttling (`@Throttle`, matching the existing memory-files conventions): folder writes and filing
60/min, read/unread/pin 120/min, search 120/min, export 10/min.

`GET api/knowledge/library` response (cursor-paginated):

```ts
interface KbLibraryDocumentDto extends KbDocumentDto {
    folderId: string | null;
    folderPath: string | null;     // "/Playbooks/Support", null when unfiled
    revision: number;
    revisionAt: string | null;
    archivedAt: string | null;
    archivedByName: string | null;
    readState: 'new' | 'updated' | 'read';
    pinnedAt: string | null;
}

interface KbLibraryListDto {
    documents: KbLibraryDocumentDto[];
    nextCursor: string | null;
    total: number;
    unreadCount: number;           // exact, library-wide, for the header
}
```

`GET api/knowledge/tree` response:

```ts
interface KbLibraryFolderNodeDto {
    id: string;
    name: string;
    path: string;                  // materialized, "/Playbooks/Support"
    parentId: string | null;
    depth: number;                 // 1..5
    documentCount: number;         // direct children
    subtreeDocumentCount: number;
    hasUnread: boolean;            // the rollup DOT (subtree-wide, per caller)
    children: KbLibraryFolderNodeDto[];
}

interface KbLibraryTreeDto {
    folders: KbLibraryFolderNodeDto[];
    unfiled: { documentCount: number; hasUnread: boolean };
    archivedCount: number;
    hasUnread: boolean;            // the nav-item dot
    folderCount: number;           // against the 500 cap
}
```

### 4.2 Additive changes to existing controllers

| File | Change |
| --- | --- |
| `apps/api/src/works/kb.controller.ts` | Add `POST works/:id/kb/documents/:docId/unarchive` for symmetry with the existing `/archive`, delegating to the same service method the library controller uses. **Do not touch `/restore`** — it keeps meaning "restore a body from a commit SHA". |
| `apps/api/src/memory-files/memory-files.controller.ts` | `POST api/memory/files/folders` gains an optional `scope` field (default `'user'` — byte-identical behaviour when omitted). `GET api/memory/files/tree` gains an optional `scope` query param (default `'user'`). `PATCH`/`DELETE api/memory/files/folders/:id` gain organization-admin authorization for `scope = 'organization'` rows. |
| `apps/api/src/memory-files/dto/memory-files.dto.ts` | Add `scope?: MemoryFolderScope` to the create-folder and tree DTOs with `@IsEnum` + `@IsOptional`. |
| `apps/api/src/works/org-memory.controller.ts` | Unchanged. The library is a sibling read, not a replacement. |

### 4.3 Contracts

**File (new):** `packages/contracts/src/kb/kb-library.types.ts`, exported from
`packages/contracts/src/kb/index.ts`:

`KbReadState` (`'new' | 'updated' | 'read'`), `KbLibrarySort`, `KbLibraryArchivedFilter`,
`KbLibraryDocumentDto`, `KbLibraryListDto`, `KbLibraryFolderNodeDto`, `KbLibraryTreeDto`,
`KbLibraryExportRequestDto`, `KbLibraryExportJobDto`, `KbDocumentReferenceDto` (the picker row),
`KbResolvedReferenceDto` (what a run receipt shows).

Constants live here too so the web and the API cannot drift:
`KB_LIBRARY_PAGE_SIZE_DEFAULT = 50`, `KB_LIBRARY_PAGE_SIZE_MAX = 200`,
`KB_LIBRARY_FOLDER_MAX_DEPTH = 5`, `KB_LIBRARY_FOLDER_NAME_MAX = 120`,
`KB_LIBRARY_FOLDERS_MAX_PER_ORG = 500`, `KB_LIBRARY_PINS_MAX_PER_USER = 20`,
`KB_LIBRARY_FILE_BATCH_MAX = 100`, `KB_LIBRARY_READ_DWELL_MS = 2000`,
`KB_LIBRARY_ROLLUP_CACHE_MS = 30_000`, `KB_REFERENCE_PICKER_LIMIT = 8`,
`KB_REFERENCE_PICKER_DEBOUNCE_MS = 150`, `KB_REFERENCE_MAX_PER_MESSAGE = 5`,
`KB_REFERENCE_TOKEN_BUDGET = 6000`, `KB_EXPORT_SYNC_MAX_DOCS = 25`,
`KB_EXPORT_MAX_DOCS = 2000`, `KB_EXPORT_MAX_BYTES = 200 * 1024 * 1024`,
`KB_EXPORT_LINK_TTL_HOURS = 24`.

### 4.4 Domain services

**Files (new) under `packages/agent/src/services/`:**

- `knowledge-library.service.ts` — the list / tree / search / file / archive / unarchive
  orchestration. Depends on `WorkKnowledgeDocumentRepository`, `MemoryFoldersService`,
  `KnowledgeReaderStateService`, `KnowledgeBaseService` (for the access gates), `ActivityLogService`.
- `knowledge-reader-state.service.ts` — `getStatesFor(userId, documentIds)`,
  `markRead(userId, documentId, revision)`, `markUnread`, `markFolderRead(userId, folderId)`,
  `pin` / `unpin`, `rollupsFor(userId)` (one grouped query + a 30 s per-user in-memory cache keyed
  by `userId`, invalidated on that user's own writes).
- `kb-content-hash.ts` — pure `normalizeBody(md: string): string` and
  `hashNormalizedBody(md: string): string`. Normalization: strip a UTF-8 BOM, normalize line
  endings to `\n`, collapse every run of whitespace to a single space, trim. Nothing else — no
  Markdown parsing, so the function stays cheap and testable.
- `knowledge-export.service.ts` — builds the archive. ≤ 25 documents synchronously; above that it
  dispatches the job and returns a job id.

**File (new) under `packages/agent/src/database/repositories/`:**
`knowledge-document-reader-state.repository.ts`, barrelled from
`packages/agent/src/database/index.ts`.

**Changes to `packages/agent/src/services/knowledge-base.service.ts`:**

- On every create/update, compute the normalized hash; bump `revision` and set `revision_at` only
  when the hash changed **or** title / description / tags / class changed, and only when the stored
  hash was not `NULL` (the seeding rule from §3.5).
- Add `archiveDocument` bookkeeping (`archived_at`, `archived_by_id`) and a new
  `unarchiveDocument(docId, userId)` that flips `status` back to `active`, clears the archive
  columns, and is idempotent.
- Exclude `status = 'archived'` from the context-bundle document selection (this may already be
  implied by the active-status filter; the change makes it explicit and adds a test).

**Changes to `packages/agent/src/services/kb-mention-parser.ts`:**

Add a second accepted prefix. The exported function keeps its name and signature; the regex becomes
a two-alternative union:

- `@kb:<reference>` — unchanged, still the canonical wire form.
- `#<reference>` — new, where `<reference>` uses the same character class, is not preceded by a word
  character, and is **not** followed by whitespace (so `# Heading` is never a reference). The
  returned `KbMention` gains a `prefix: '@kb:' | '#'` field so callers can render differently.

Ambiguity is resolved in the **resolver**, not the parser: a `#` mention that matches zero or more
than one visible document resolves to `null` (spec FR-53). `@kb:` keeps its existing
first-match-wins behaviour so nothing regresses.

**Changes to `packages/agent/src/services/kb-mention-resolver.service.ts`:**

- Accept an org-wide scope (`{ workId?: string; organizationId: string }`) so a reference typed in
  a composer that is not inside a Work still resolves.
- Return `ambiguous: true` when a `#` reference matches more than one document.
- Enforce `KB_REFERENCE_MAX_PER_MESSAGE` and `KB_REFERENCE_TOKEN_BUDGET`, returning per-document
  `injectedTokens` and `truncated` flags for the run receipt.

**New splice in `packages/agent/src/agents/agent-run.service.ts`:**
Immediately after the memory-recall block (currently ending around line 445), parse the run's
prompt for references, resolve them, format them through `kb-prompt-formatter.ts`, append to
`prompt.systemMessage`, write one `WorkKnowledgeCitation` row per resolved document with
`consumerType = 'agent-run'`, and emit a `kb-references` step log with
`{ resolved, unresolved, ambiguous, truncated, tokens }` — mirroring how the recall step logs its
four outcomes. The same helper is called from
`packages/agent/src/pipeline/full-pipeline-executor.service.ts`.

---

## 5. Web

### 5.1 New components

**Directory (new):** `apps/web/src/components/knowledge/`

| Component | Responsibility |
| --- | --- |
| `LibraryPanel.tsx` | The panel itself: holds filter/sort state, fetches the tree and the first page, renders the rail and the list. Mounted by `MemoryShell.tsx` behind a `Library` tab, mirroring how `MemoryFilesPanel` is mounted today. |
| `LibraryFolderRail.tsx` | The folder tree with rollup dots, expand/collapse, keyboard navigation, context menu, `+ New folder`, and the `Unfiled` / `Archived` pseudo-rows. |
| `LibraryDocumentList.tsx` | Grouped, virtualized list (`Pinned`, then per-folder groups), infinite scroll on `nextCursor`, bulk selection. |
| `LibraryDocumentRow.tsx` | One row: unread marker, title, badge, breadcrumb, description, relative time, hover controls, overflow menu. |
| `ReadStateBadge.tsx` | The `NEW` / `UPDATED` pill. Exposes its meaning as text for assistive technology, never colour alone. |
| `FolderPickerDialog.tsx` | The **File into folder…** dialog, including inline folder creation and the `Unfiled` option. |
| `LibraryExportDialog.tsx` | Format choice, the include toggles, the async note, and the over-cap messages. |
| `LibraryArchivedPanel.tsx` | The Archived view with Restore / Export per row. |
| `useReadDwell.ts` | The 2 s dwell hook: an `IntersectionObserver` plus a timer, cancelled on unmount, fires the mark-read call at most once per (document, revision). |
| `useLibraryRollups.ts` | Fetch + 30 s cache + optimistic invalidation of the rollup dots. |

**File (new):** `apps/web/src/components/common/DocumentReferenceAutocomplete.tsx` — the `#`
picker. Deliberately modelled on `apps/web/src/components/skills/SlashCommandAutocomplete.tsx`
(client component, module-level cache, degrades to "no popup, text submits as typed" on any
failure) but with a debounced server query rather than a single cached list, because the document
set is large.

**Changes to existing web files:**

| File | Change |
| --- | --- |
| `apps/web/src/components/memory/MemoryShell.tsx` | Add a `Library` tab and mount `LibraryPanel`. Tab choice persisted in `localStorage` under `memory-tab` and mirrored to `?view=library`, following the pattern already used for view-mode persistence elsewhere in the dashboard. |
| `apps/web/src/app/[locale]/(dashboard)/memory/page.tsx` | Pre-fetch the tree and the first library page server-side so the panel has no loading flash on a deep link. |
| `apps/web/src/components/kb/workbench/KbDocumentHeader.tsx` | Add the badge, pin, folder breadcrumb, archive/unarchive and export controls. |
| `apps/web/src/components/kb/workbench/KbDocumentContextMenu.tsx` | Add File / Pin / Archive / Export entries. |
| `apps/web/src/components/ai/ChatInput.tsx`, `apps/web/src/components/common/PromptComposer.tsx`, `apps/web/src/components/agents/Composer.tsx`, `apps/web/src/components/tasks/TaskDetailClient.tsx` | Mount `DocumentReferenceAutocomplete` on the `#` trigger. `TaskDetailClient` already hosts `SlashCommandAutocomplete`, so it gains a second trigger, not a new pattern. |
| `apps/web/src/components/kb/workbench/extensions/` | New `document-reference-suggestion.ts` alongside the existing `mention-suggestion.ts` and `wikilink-suggestion.ts`, so `#` works inside document bodies too. |
| `apps/web/src/lib/constants.ts` | No new route. The library is `ROUTES.DASHBOARD_MEMORY` with `?view=library`; add `DASHBOARD_MEMORY_LIBRARY` as a derived constant next to the existing `DASHBOARD_MEMORY_MEETINGS`. |

### 5.2 Data fetching

- **API client (new):** `apps/web/src/lib/api/knowledge-library.ts` (`server-only`, via `serverFetch`,
  attaching the scope header exactly as `apps/web/src/lib/api/memory.ts` does) and a client-safe
  type module `apps/web/src/lib/api/knowledge-library-types.ts`.
- **BFF proxies (new)** under `apps/web/src/app/api/knowledge/`:
  `library/route.ts`, `tree/route.ts`, `search/route.ts`, `read-all/route.ts`,
  `documents/file/route.ts`, `documents/[docId]/pin/route.ts`,
  `documents/[docId]/read/route.ts`, `documents/[docId]/unread/route.ts`,
  `documents/[docId]/unarchive/route.ts`, `documents/[docId]/export/route.ts`,
  `export/route.ts`, `export/[jobId]/route.ts`.
  These mirror `apps/web/src/app/api/memory/files/**`, including its shared `proxy.ts` helper
  pattern. Browser calls go through `browserApiFetch` (which stamps the per-tab scope header), never
  bare `fetch` — the same rule `MemoryShell.tsx` already follows.
- Server components pre-fetch the tree and page 1; everything after that is client-side.

### 5.3 State rules

- Read state is optimistic: the badge clears locally the instant the dwell timer fires, and rolls
  back if the call fails.
- Rollup dots are fetched separately from the list and animate in — they must never cause layout
  shift (spec S-29).
- Bulk selection lives in the list, not in a global store.
- The "changed while you were reading" banner is driven by comparing the revision in the last list
  payload against the revision returned by the document fetch; no websocket is required for P1.

---

## 6. Background work

One new job. Dispatched through the configured job-runtime provider via a `*_DISPATCHER` DI symbol
— never a direct queue call (Constitution IV).

| Piece | File |
| --- | --- |
| Symbol | `KNOWLEDGE_EXPORT_DISPATCHER` added to `packages/agent/src/tasks/_tasks-symbols.ts` |
| Dispatcher + payload type (new) | `packages/agent/src/tasks/knowledge-export-dispatcher.ts`, `packages/agent/src/tasks/knowledge-export.types.ts` — copy the shape of `kb-embed-document-dispatcher.ts` |
| Binding | Registered in `packages/agent/src/tasks/job-runtime.providers.ts` |
| Task implementation (new) | `packages/tasks/src/tasks/trigger/knowledge-export.task.ts`, exported from `packages/tasks/src/tasks/trigger/index.ts` |

Job behaviour:

1. Resolve the document set (folder subtree or explicit ids), re-checking view access **per
   document** as the requesting user — the job must not widen access.
2. Stream each body from the Work's source-of-truth repository via the git facade; on failure,
   record the document in a `MISSING.txt` entry and continue (spec S-28).
3. Assemble a `.zip` with `jszip` (already a dependency of `packages/agent`), mirroring the folder
   tree as directories and writing `<slug>.md` with YAML front matter.
4. Abort with a typed error if the running total passes `KB_EXPORT_MAX_BYTES`.
5. Write the archive through the `KB_STORAGE_PLUGIN` token (provided globally by
   `apps/api/src/uploads/kb-storage.module.ts`) under `kb-exports/{userId}/{jobId}.zip`.
6. Notify the requester through `packages/agent/src/notifications/notification.service.ts` with a
   link that expires after `KB_EXPORT_LINK_TTL_HOURS`.
7. Idempotency: the job id is derived as `kb-export:{userId}:{requestHash}` so a retried dispatch
   does not produce two archives.

Concurrency: the task declares a `queue:` config like `kb-embed-document.task.ts` so a burst of
exports cannot starve the mirroring and embedding queues.

**No other background work is added.** Read state is derived lazily on read; nothing fans out when
a revision bumps.

---

## 7. Plugin boundaries

- **P1 and P2 add no plugin and no external integration.** Markdown assembly and zipping are
  first-party; storage already goes through the storage plugin token; git access already goes
  through `packages/agent/src/facades/git.facade.ts`.
- **P3 PDF export** is the one external-ish capability. Per Constitution I it ships as a new
  capability interface `packages/plugin/src/contracts/capabilities/document-render.interface.ts`
  plus a first-party plugin package `packages/plugins/document-render-local/`, resolved through a
  new `packages/agent/src/facades/document-render.facade.ts`. The export service asks the facade
  for "something that can render Markdown to PDF for this scope" and **never** names a plugin id
  (Constitution II). If no plugin is installed, the PDF option is hidden in the UI and the endpoint
  returns `503` with a message naming the missing capability, not a plugin.
- Adding that plugin updates the canonical list in `docs/plugin-system/built-in-plugins.md` and
  nowhere else (Constitution VIII).

---

## 8. i18n

New keys in `apps/web/messages/en.json`, then mirrored into the 20 sibling locale files. **Leaf key
names are camelCase and contain no literal dot** — a dot in a leaf name breaks next-intl at runtime
and reds several end-to-end shards at once.

Under the existing `dashboard.memoryPage` namespace, a new `library` object:

```
dashboard.memoryPage.tabs.list | library | files | agentMemory | review | uploads

dashboard.memoryPage.library.title
                            .subtitle
                            .searchPlaceholder
                            .unreadCount                 {count}
                            .sortLabel | sortRecent | sortTitle | sortUnread
                            .filterUnreadOnly | filterPinnedOnly | filterClass | filterWork
                            .loadMore
                            .allDocuments | unfiled | archivedView | newFolder
                            .badgeNew | badgeUpdated
                            .badgeNewTooltip | badgeUpdatedTooltip | folderDotTooltip
                            .pin | unpin | pinLimitReached
                            .fileInto | fileIntoTitle | fileIntoConfirm
                            .fileIntoUnfiled | fileIntoNewFolder | fileBatchLimit
                            .markRead | markUnread | markFolderRead | markFolderReadUndo
                            .archive | restore | archivedSubtitle | archivedEmpty
                            .restoredToast | restoredToUnfiledToast
                            .exportMarkdown | exportPdf | exportFolder
                            .exportDialogTitle | exportFormatMarkdown | exportFormatPdf
                            .exportIncludeArchived | exportIncludeOriginals | exportAsyncNote
                            .exportQueuedToast | exportReadyNotice | exportPartialNotice
                            .exportOverDocumentCap | exportTooLarge | exportLinkExpired
                            .emptyTitle | emptyBody | emptyAskAgent
                            .emptyFolderTitle | emptyFolderBody | emptyFolderAction
                            .noResults | clearSearch | searchArchived
                            .loadFailed | tryAgain | allCaughtUp
                            .folderRename | folderNewSub | folderDelete
                            .folderDeleteConfirm | folderDepthLimit
                            .folderNameDuplicate | folderNameLength
                            .folderCycleRejected | folderLimitReached
                            .noEditAccessFile | noEditAccessArchive
                            .changedWhileReading | reload
```

Shared across every composer, under `common`:

```
common.documentReference.pickerHint
                        .noMatch
                        .noMatchHint
                        .emptyLibrary
                        .ambiguousHint          {reference} {count}
                        .notFoundHint           {reference}
                        .tooManyHint            {max} {overflow}
                        .archivedSuffix
                        .archivedTooltip
                        .referenceTruncated     {tokens}
                        .referenceUnresolved    {count}
```

`metadata.pages.memory` is unchanged (the library is a view on the same page, not a new route).

---

## 9. Telemetry and failure modes

### 9.1 Activity log (audited, low frequency)

Emitted through `packages/agent/src/activity-log/activity-log.service.ts` with the new action types
from §3.4: filing (`kb_document_filed`, details `{ documentId, fromFolderId, toFolderId }`),
archive / un-archive, export request and completion, and folder create / rename / delete.
Marking read and pinning are **not** audited (FR-66) — they are personal and high-frequency.

### 9.2 Product analytics

Via `packages/monitoring`, following the `kb.reconcile.completed` naming already used by
`packages/agent/src/services/knowledge-base-reconcile.service.ts`:

| Event | Properties |
| --- | --- |
| `knowledge.library.viewed` | `documentCount`, `folderCount`, `unreadCount`, `pinnedCount` |
| `knowledge.document.filed` | `batchSize`, `toUnfiled` |
| `knowledge.document.pinned` / `.unpinned` | `pinCount` |
| `knowledge.document.archived` / `.unarchived` | `class`, `source` |
| `knowledge.readstate.marked` | `mode` (`open` \| `manual` \| `folder`), `count` |
| `knowledge.export.requested` / `.completed` / `.failed` | `format`, `documentCount`, `bytes`, `durationMs`, `missingCount` |
| `knowledge.reference.resolved` | `surface`, `count`, `tokens`, `truncatedCount` |
| `knowledge.reference.unresolved` | `surface`, `reason` (`notFound` \| `ambiguous` \| `noAccess` \| `overLimit`) |

`knowledge.reference.unresolved` with `reason = notFound` is the single most useful signal in the
epic: a rising rate means people are trying to reference documents that do not exist yet, which is
a content gap, not a bug.

### 9.3 Failure modes and what the user sees

| Failure | Behaviour |
| --- | --- |
| Rollup query slow or failing | Dots are omitted; the list still renders. Never block the list on rollups. |
| Mark-read call fails | The badge rolls back with a quiet toast; nothing is lost, the next dwell retries. |
| Folder tree fetch fails | The rail shows the error state; the document list still renders unfiltered. |
| A document's body cannot be read from the repository | It still lists (the row is metadata); opening it shows the existing workbench error; exporting records it in `MISSING.txt`. |
| Reference resolution throws mid-run | The run **continues** without the reference block and logs a `kb-references` step with `failed` — matching the memory-recall contract, which never fails a run. |
| Export storage plugin unavailable | `503` with `Exports need a storage plugin, which is not configured in this deployment.` |
| Two people file the same document simultaneously | Last write wins; the loser's list refreshes on the next fetch. No lock. |
| Revision bumps between a person's list render and their open | The document fetch returns the newer revision, the read mark is written against the revision they actually saw, and the S-14 banner appears. |

---

## 10. Test plan

### 10.1 Unit — `packages/agent` (Jest)

| File | Covers |
| --- | --- |
| `packages/agent/src/services/__tests__/kb-content-hash.spec.ts` **(new)** | Whitespace normalization; identical hashes for reflowed text; different hashes for a one-character change; BOM and CRLF handling. |
| `packages/agent/src/services/__tests__/knowledge-reader-state.service.spec.ts` **(new)** | The `NEW` / `UPDATED` / `READ` state machine; mark-unread lands on `UPDATED`, never `NEW`; folder mark-read covers the subtree and only the actor; the 30 s rollup cache and its invalidation; pin cap of 20. |
| `packages/agent/src/services/__tests__/knowledge-library.service.spec.ts` **(new)** | Default archived exclusion; pinned-first sort; folder-depth 5 refusal; sibling name uniqueness; move-into-own-subtree refusal; cross-organization filing refusal; 100-document batch cap; folder delete unfiles rather than deletes. |
| `packages/agent/src/services/__tests__/knowledge-export.service.spec.ts` **(new)** | ≤ 25 synchronous vs > 25 asynchronous; directory mirroring; front matter; `MISSING.txt`; the 2 000-document and 200 MB caps. |
| `packages/agent/src/services/__tests__/kb-mention-parser.spec.ts` **(extend)** | `#ref` parses; `# Heading` does not; `foo#ref` does not; `@kb:` behaviour is byte-identical to today; the `prefix` field. |
| `packages/agent/src/services/__tests__/kb-mention-resolver.service.spec.ts` **(extend)** | Ambiguous `#` resolves to null; organization-wide scope; the 5-document and 6 000-token budgets; inaccessible and nonexistent are indistinguishable. |
| `packages/agent/src/services/knowledge-base.service.revision.spec.ts` **(new)** | Revision bumps on a body change, a title change, a tag change; does **not** bump on `lastCommitSha` / `lastIndexedAt` writes; does not bump when the stored hash is NULL (the seeding rule). |
| `packages/agent/src/services/__tests__/memory-folders.service.spec.ts` **(extend)** | Organization-scope folders; the 500-folder cap; the two partial unique indexes; per-person folders are unaffected. |
| `packages/agent/src/agents/__tests__/agent-run.references.spec.ts` **(new)** | The splice injects a reference block; a resolution failure does not fail the run; a citation row is written per resolved document. |
| `packages/agent/src/database/__tests__/…` | The entity-registry drift spec in `packages/agent/src/database/database.module.spec.ts` passes with the new entity. |

### 10.2 Controller specs — `apps/api` (Jest)

| File | Covers |
| --- | --- |
| `apps/api/src/knowledge-library/knowledge-library.controller.spec.ts` **(new)** | Every endpoint's happy path; validation of every query param and cap; 403 for filing without edit access; 404 (never 403-with-detail) for a document outside the caller's scope; throttle decorators present. |
| `apps/api/src/works/kb.controller.spec.ts` **(new or extend)** | `unarchive` is idempotent, requires edit access, and does not disturb `/restore`. |
| `apps/api/src/memory-files/memory-files.controller.spec.ts` **(extend)** | Omitting `scope` is byte-identical to today; `scope=organization` create requires organization-admin; the tree filters by scope. |

### 10.3 End-to-end — `apps/web/e2e` (Playwright)

| File | Covers |
| --- | --- |
| `apps/web/e2e/flow-knowledge-library-shelf.spec.ts` **(new)** | Open the Library tab, create a folder, file documents, pin, sort, paginate, empty states. |
| `apps/web/e2e/flow-knowledge-library-read-state.spec.ts` **(new)** | `NEW` → open → cleared; edit → `UPDATED`; folder rollup dot appears and clears; mark folder read + undo; a second account's badges are unaffected. |
| `apps/web/e2e/flow-knowledge-library-archive-export.spec.ts` **(new)** | Archive, confirm removal from the list and the picker, restore to the original folder, restore to Unfiled when the folder is gone, Markdown export, over-cap message. |
| `apps/web/e2e/flow-knowledge-reference-composer.spec.ts` **(new)** | `#` opens the picker in the chat composer and in task comments; selection inserts a chip; ambiguity and no-match hints; the archived affix; `# Heading` is untouched in a document body. |
| `apps/web/e2e/flow-kb-workbench-metadata.spec.ts` **(extend)** | The workbench header's new pin / file / archive / export controls. |

New unit specs also accompany every new web component, following the co-located
`*.unit.spec.tsx` convention already used throughout `apps/web/src/components/memory/` and
`apps/web/src/components/kb/workbench/`.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — The shelf (folders, filing, archive/restore, list)

Schema + migration (§3), the library module and its read endpoints, shared folders, filing,
un-archive, the Library panel with the folder rail and list, the Archived view, i18n, and the P1
tests. Read state is **not** in P1: badges are absent, and the list sorts by `revisionAt`.

*Why first:* it is the only phase with a migration, and every later phase reads its columns.

### P2 — Read state, pins and references

The reader-state table's service and endpoints, the badges, the rollup dots, the dwell hook, pins,
mark-read / mark-unread / mark-folder-read, the parser and resolver extensions, the `#` picker in
every composer, the agent-run splice, and the run-receipt reference list.

*Why second:* it is the highest-value half of the epic but depends on `revision` existing and being
correct in production for a while, which P1 delivers.

### P3 — Export at scale and PDF

The synchronous Markdown export ships in P1 (it is a single document and needs no job). P3 adds the
background zip export job, notification delivery, the expiring link, the `document-render`
capability, the first-party PDF plugin, and PDF as an export format.

*Why last:* it is the only part that introduces a plugin, and it is the part users can most easily
work around in the meantime.

Dependency note: this epic has no blocking dependency on another epic. It **feeds** AW-09
(run receipts show resolved documents), AW-07 (the context-load meter counts reference tokens),
AW-13 (export-ready notifications), and AW-01 (documents become command-palette results).

---

## 12. Constitution compliance

| Gate | Status | Justification |
| --- | --- | --- |
| **I — Plugin-first** | ✅ | P1/P2 add no external integration. P3's PDF rendering is a new capability interface plus a first-party plugin package, resolved through a facade. |
| **II — Capability-driven resolution** | ✅ | No plugin id appears outside the plugin package; the export service asks the facade for a renderer. |
| **III — Source-of-truth repositories** | ✅ | Document bodies stay in the Work's data repository; the library adds only metadata columns and one metadata table. Export reads from the repository, it does not become a second source. |
| **IV — Job runtime** | ✅ | The one background job is dispatched via `KNOWLEDGE_EXPORT_DISPATCHER`; no vendor SDK import at any call site. |
| **V — Forward-only migrations** | ✅ | One migration, additive columns plus index widenings, shipped in the same PR as the entity changes. The only `DROP INDEX` is immediately followed by a partial recreation covering the same existing data. |
| **VI — Tests** | ✅ | §10 names 10 unit files, 3 controller specs and 5 end-to-end specs, plus co-located component specs. |
| **VII — Secret hygiene** | ✅ | No new secret. Export links are scoped to the requester and expire in 24 hours; the archive path includes the user id so one person's export is never enumerable from another's. |
| **VIII — Plugin counts** | ✅ | Only P3 adds a plugin, and only the canonical plugin doc records it. |
| **IX — Behaviour-first specs** | ✅ | `spec.md` contains no class names, file paths or code; all of that lives here. |
| **X — Backwards compatibility** | ✅ | `@kb:` is unchanged (spec FR-52); `scope` defaults to `'user'` so every existing folder call behaves identically; `/restore` keeps its meaning and the new inverse of `/archive` is called `/unarchive`; every new column is nullable or defaulted. |

---

## 13. Cross-references

- Spec: [spec.md](./spec.md) · Tasks: [tasks.md](./tasks.md)
- Program: [../README.md](../README.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Knowledge Base feature spec: [../../knowledge-base/](../../knowledge-base/)
- Memory feature spec: [../../memory/](../../memory/)
- Database architecture (entities, migrations, repositories): [`docs/specs/architecture/database.md`](../../../architecture/database.md)
- Job-runtime pluggability: [`docs/specs/decisions/015-job-runtime-provider-pluggability.md`](../../../decisions/015-job-runtime-provider-pluggability.md)
