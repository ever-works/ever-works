# Memory Files — implementation notes (session/feat-memory-files)

Feature E of the platform build program: a **Files** area inside the
existing `/memory` page — browse ALL files (chat uploads + KB
originals/org uploads) in one place, organized into user-defined
folders; folders can be Global or owned by one agent; upload into
folders; manual "Sync now" of a folder to a Git repo; folder tree CRUD.
Everything is **additive** — the existing memory panels, uploads
pipeline and KB lifecycle are untouched.

## What shipped

### Data model

- **New entity `memory_folders`**
  (`packages/agent/src/entities/memory-folder.entity.ts`):
  `id, userId, tenantId?, organizationId?, name varchar(120),
parentId uuid NULL, path varchar(512), ownerAgentId uuid NULL,
syncRepo simple-json NULL, timestamps`. - `path` is the materialized absolute path (`/a/b`), **unique per
  userId** (`uq_memory_folders_user_path`), maintained by
  `MemoryFoldersService` with a portable subtree rewrite
  (`'…' || substr(path, n)` works on postgres AND better-sqlite3). - `ownerAgentId NULL` = Global folder; set = private to that agent. - `syncRepo` holds repo **coordinates only**
  (`{repoUrl?, owner?, repo?, branch?, dirPrefix?}`) — never
  credentials; the git facade resolves tokens at sync time. - Registered in `_entities-inventory.ts`, `_entity-names.ts`,
  `entities/index.ts`; repository in `_repository-inventory.ts`
  (DatabaseModule-owned, so the module-shape drift spec counts it
  automatically).
- **Folder membership columns** — `user_uploads.folderId` and
  `work_knowledge_uploads.folderId` (nullable uuid; NULL = unfiled ⇒
  root). Membership only; deleting a folder unlinks (`SET NULL` FK on
  postgres + service-level unlink), never touches bytes.
- **Migrations** (`apps/api/src/migrations/`):
    - `1786830000000-CreateMemoryFolders.ts` — portable Table API; FK to
      users (CASCADE); deliberately **no scope XOR CHECK** (the
      ScopeStampingSubscriber lesson from `CreateWorkflows`) and **no
      self-FK on parentId** (subtree deletes are one statement).
    - `1786830001000-AddMemoryFolderIdToUploads.ts` — adds `folderId` +
      index to both upload tables; FK (`ON DELETE SET NULL`) postgres-only
      (sqlite cannot add an FK without a table rebuild; service re-checks
      ownership on every write anyway).

### Services (`packages/agent/src/services/`, wired by `MemoryFilesModule`)

- **`MemoryFoldersService`** — tree CRUD + every path invariant:
  create (child path = parent path + `/name`, 409 on duplicate),
  rename/move with whole-subtree path rewrite, cannot move into own
  subtree (422), delete refuses non-empty without `recursive` (422),
  recursive delete unlinks files across BOTH spines then drops the
  subtree; cross-user folder ids are 404.
- **`MemoryFilesService`** — the unified list + move. Merges
  `user_uploads` (owner = caller) and `work_knowledge_uploads` (org rows
  of the active org via `workId IS NULL` + `organizationId`, PLUS Work
  rows of Works the caller owns via a join on `works.userId`) into one
  `{id, source, filename, mime, size, folderId, ownerAgentId,
provenance, updatedAt, sha256?}` row shape. **Provenance** is
  batch-mapped (one query per edge table, no N+1): mission /
  work-proposal (idea) / agent attachment edges key on the upload
  **sha256**; task attachment edges key on the KB upload **row id**; an
  edge-less plain upload is `chat: true`. `moveFiles` validates the
  whole batch first (cross-user ⇒ 404, nothing written), then
  files/unfiles rows on both spines.
- **`MemoryFolderSyncService`** — manual "Sync now" (v1 GitHub via
  `GitFacadeService`, same clone→write→addAll→status→commit→push shape
  as the KB git mirror): walks the folder **subtree**, skips files over
  5 MB into a reported skip list, per-file read failures mark that file
  `failed` and continue, filenames sanitized to one path segment and
  resolved-inside-clone checked, 422 unless `syncRepo` resolves
  owner/repo (explicit fields or parsed from a github `repoUrl`). Byte
  reading is a caller-injected delegate because the two spines read
  through different storage stacks that live in apps/api.

### API (`apps/api/src/memory-files/`, registered in `api.module.ts`)

`@Controller('api/memory/files')`, global JWT guard, active org from
`ScopeContextService` (never a param):

| Route                                                    | What                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/memory/files/tree`                             | folder tree + per-folder file counts                                                                   |
| `GET /api/memory/files?folderId=&source=&q=`             | unified rows; no `folderId` = unfiled root; `q` searches everywhere                                    |
| `POST /api/memory/files/upload` (multipart, `folderId?`) | UploadsService.saveFile (full validation pipeline) + folder link by sha256                             |
| `POST /api/memory/files/folders`                         | create (name, parentId?, ownerAgentId?)                                                                |
| `PATCH /api/memory/files/folders/:id`                    | rename / move (`parentId` or `moveToRoot`) / configure `syncRepo` (`clearSyncRepo` to remove)          |
| `DELETE /api/memory/files/folders/:id?recursive=`        | 422 unless empty or recursive; unlink-only for files                                                   |
| `POST /api/memory/files/folders/:id/sync`                | manual sync; `{folderId, commitSha, results[]}` incl. skip list                                        |
| `PATCH /api/memory/files/move`                           | batch move `{files:[{source,id}], folderId\|null}`                                                     |
| `DELETE /api/memory/files/:id?source=`                   | unlink only — **bytes are never destroyed in v1**                                                      |
| `GET /api/memory/files/:id/download?source=`             | bytes via the owning spine; CSP + nosniff + active-MIME collapse, same posture as `/api/uploads` serve |

Download delegation: `upload` rows → `UploadsService.readFile`
(owner-scoped storage key); KB Work rows → `KnowledgeBaseService.
getUploadBytes` (existing `ensureCanView` gate); KB org rows → new
additive `KnowledgeBaseService.getOrgUploadBytes(organizationId, id)`
(pins `workId IS NULL` + org; controller asserts org membership first,
mirroring `OrgMemoryController`).

### Web (`apps/web`)

- **`MemoryFilesPanel`** (`src/components/memory/MemoryFilesPanel.tsx`),
  mounted in `MemoryShell` above the Originals panel (all existing
  panels kept): breadcrumb + folder-first table (Name/Size/Modified),
  New Folder inline form, Upload button (multi-file, uploads into the
  current folder), per-row move (folder select) + download, folder
  delete (confirm-then-recursive on 422) + "Sync now" (shown when a
  syncRepo is configured), agent-owner badge on agent folders,
  All/Global/Agents scope toggle, empty state.
- **Drag-and-drop upload** reuses the workbench `UploadDropZone`
  verbatim (its `targetClass` argument is meaningless here and ignored)
  — dropping OS files on the table uploads them into the browsed folder.
- **Preview** — `MemoryFilePreview.tsx` mounts the SAME KB viewers the
  workbench uses, dispatched through the shared
  `works/detail/kb/viewers/pick-viewer.ts` helper (pdf / docx / xlsx /
  image / video / audio). `pickKbViewer` answers `'text'` for
  markdown/plain/unknown MIMEs; unlike the KB (which has a rendered body
  to show) Files only has bytes, so the overlay fetches text payloads up
  to 256 KB itself and renders them, and shows a download card for
  anything else. Viewers receive the Files download URL — the route's
  `Content-Disposition: attachment` only steers top-level navigations,
  not the viewers' own fetches / `<img>` / `<source>` loads.
- **Search** — a debounced (300 ms) `q` box. A non-empty query hits the
  API's search mode, which spans EVERY folder, so the breadcrumb and
  folder rows step aside while it is active.
- **Sync target editor** — the gear on a folder row opens an inline
  `owner / repo / branch / dirPrefix` form (`PATCH …/folders/:id`).
  Without it "Sync now" could never appear, since the API only offers
  sync once `syncRepo` is configured. Repo COORDINATES only — no
  credentials are ever entered here; the git facade resolves tokens.
- **BFF proxies** under `src/app/api/memory/files/…` (shared
  `proxy.ts`, streams multipart upstream and relays binary downloads
  with Content-Type/Disposition intact).
- Client-safe types in `src/lib/api/memory-files-types.ts`.
- i18n: `dashboard.memoryPage.files.*` added to **all 21** locale files
  (English values copied verbatim, per convention; inserted textually so
  no locale file was reformatted).

### Activity (convention #9)

Folder-tree state changes emit activity rows through the existing
`ActivityLogService`, via three **additive** `ActivityActionType`
entries (`memory_folder_created` / `_deleted` / `_synced`) — the
`activity-log.types.spec.ts` "catch silent additions" count pin moved
123 → 126 in the same commit. `MemoryFoldersService.recordActivity` is
best-effort: a logging failure is warned and swallowed, never failing
the folder operation. `ActivityLogModule` is imported by
`MemoryFilesModule` so the `@Optional()` injection actually resolves
(the KnowledgeBaseModule post-cascade lesson). No feed category work was
needed — `categoryForActivityLog` falls through to `settings`.

## Agent access rule (brief item 4)

Folders with `ownerAgentId` are private to that agent. There is **no
agent-runtime read path over `user_uploads` today** (verified:
`AgentFileService` reads only the five canonical agent files;
attachment tools attach by hash, they don't browse), so the rule is
enforced where the reads actually happen now:

- `MemoryFilesService.list({ agentId })` and
  `MemoryFoldersService.getTree({ agentId })` drop files/folders whose
  folder is owned by a different agent;
- covered by unit tests (`ownerAgent access rule` describe block).

**Runtime follow-up:** when an agent file-browse tool over user files
lands, it must call these services **with its `agentId`** — never the
bare repositories — to inherit the privacy rule.

## Tests

- `packages/agent/src/services/__tests__/memory-folders.service.spec.ts`
  — path maintenance, subtree move, uniqueness (409), delete guards
  (422 / recursive unlink), cross-user 404. (12 tests)
- `…/memory-files.service.spec.ts` — sources merged + sorted, batch
  provenance mapping (mission/task/chat), source filter, ownerAgent
  filter, move cross-user 404 before any write. (12 tests)
- `…/memory-folder-sync.service.spec.ts` — mocked GitFacade: expected
  repo paths under dirPrefix (real temp-dir fs), commit/push wiring,
  skip list without reading bytes, per-file failure continues, empty
  folder touches no git, repoUrl parsing, 422 unconfigured. (7 tests)
- `apps/api/src/migrations/__tests__/CreateMemoryFolders.spec.ts` —
  better-sqlite3 harness (house pattern): all columns, idempotent up(),
  per-user path uniqueness (same path two users OK / same user rejected),
  both-scope-columns row accepted (no XOR CHECK), dangling parentId
  accepted (no self-FK), down() drops. (6 tests)
- `…/AddMemoryFolderIdToUploads.spec.ts` — nullable folderId + index on
  both spines, existing rows backfill NULL, idempotent, no-op when the
  upload tables are absent, down() removes. (5 tests)
- `apps/api/src/memory-files/memory-files.controller.spec.ts` — the
  contracts that live in the controller, not the services: org comes
  from the scope context only, `q` widens the list past the browsed
  folder, upload validates the folder BEFORE storing bytes, DELETE is
  unlink-only, download collapses active MIMEs / sanitizes the
  Content-Disposition filename / routes per spine (Work rows through the
  KB view gate, org rows behind `ensureMember`, no active org ⇒ 404).
  (18 tests)
- `apps/web/src/components/memory/MemoryFilePreview.unit.spec.tsx` —
  viewer dispatch per MIME, `source`-carrying download URL, inline text
  fetch + its size cap, unsupported fallback, close/Escape. (7 tests)
- `…/MemoryFilesPanel.unit.spec.tsx` — folder-rows-first listing, search
  issues a folder-less `q` list and hides folder rows, drop-to-upload,
  preview overlay opens, sync-target editor PATCHes the folder.
  (5 tests)

Commands:

```bash
# NOTE: `--testPathPattern` matches the FULL path, and this worktree is
# named `wt-feat-memory-files` — a `memory-files` pattern therefore runs
# the entire suite. Pass spec paths instead.
cd packages/agent && npx jest src/services/__tests__/memory-folders.service.spec.ts src/services/__tests__/memory-files.service.spec.ts src/services/__tests__/memory-folder-sync.service.spec.ts src/entities/__tests__/activity-log.types.spec.ts
cd apps/api && npx jest src/memory-files src/migrations/__tests__/CreateMemoryFolders.spec.ts src/migrations/__tests__/AddMemoryFolderIdToUploads.spec.ts
cd apps/web && npx vitest run src/components/memory/
cd packages/agent && pnpm type-check
cd apps/api && pnpm type-check
cd apps/web && pnpm type-check
npx turbo build --filter=@ever-works/agent --filter=ever-works-api --filter=ever-works-web
```

Full agent suite also run green during the second session (478 suites /
8627 tests — the worktree-name effect above ran everything).

## Known follow-ups

- **Agent runtime wiring** of the ownerAgentId rule (see above).
- **Sync**: no scheduled sync (manual only, per brief); sync currently
  targets the branch as-checked-out (`branch` passed to cloneOrPull);
  deletions in the repo are not mirrored (additive writes only).
- **Agent-owned folders cannot be CREATED from the UI** — the API takes
  `ownerAgentId` on folder create and the panel renders the badge and
  the Agents scope filter, but there is no agents-list BFF proxy under
  `apps/web/src/app/api/agents/` to populate a picker (only `[id]`).
  Add the list proxy and an owner select in the New Folder form when the
  agent runtime starts creating/consuming these folders.
- **Downloads for very large files** buffer in memory (same as the
  existing `/api/uploads` serve route); streaming is a shared follow-up.
- The Files list caps at 200 rows per source with no pagination UI yet.
- `DELETE /api/memory/files/:id` is unlink-only by design (v1 additive
  rule); real byte deletion is explicitly out of scope.
- **Account export/import** does not cover uploads today, so the new
  `folderId` columns cannot be silently dropped by a transfer whitelist
  (verified: no upload table appears in
  `packages/agent/src/account-transfer/`). If uploads ever join the
  export surface, `memory_folders` + both `folderId` columns must be
  added to the whitelist in the same PR (3-place-whitelist bug class).
