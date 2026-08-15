# Skills — invocation slugs + companion files (implementation notes)

Branch: `session/feat-skill-files`. Feature brief: "Skills: invocation slug + skill files".

Two related additions to the Skills feature:

1. **Invocation slug** — an optional per-account slash command (`/plan`) on a Skill. Typing it at
   the start of a chat message injects that Skill's FULL body into that turn.
2. **Skill files** — companion files (scripts / references / configs / assets) uploaded through the
   existing uploads spine, listed to the model as a manifest with on-demand retrieval.

---

## Data model

### `skills.invocationSlug` (new column)

`varchar(64) NULL`. Normalized to `^[a-z0-9][a-z0-9-]*$` (trim, drop one leading `/`, lowercase).

Uniqueness is **per `userId` and enforced in `SkillsService`**, not by a DB constraint — a service
check can name the conflicting skill in the 409 (`Invocation slug "/plan" is already used by skill
"Planning Guide"`), which a unique-index violation cannot. The migration adds a NON-unique
`idx_skills_user_invocation` on `(userId, invocationSlug)` to serve the lookup that runs on every
slash-prefixed chat message.

### `skill_files` (new table)

| column                        | type         | note                                                          |
| ----------------------------- | ------------ | ------------------------------------------------------------- |
| `id`                          | uuid PK      |                                                               |
| `skillId`                     | uuid         | FK → `skills.id` ON DELETE CASCADE                            |
| `userId`                      | uuid         | FK → `users.id` ON DELETE CASCADE; every read is scoped by it |
| `uploadId`                    | varchar(64)  | the upload's **sha256** — the key into `user_uploads`         |
| `filename`                    | varchar(255) | display name inside the skill; unique per skill               |
| `kind`                        | varchar(16)  | `script` \| `reference` \| `asset` \| `config`                |
| `sizeBytes`                   | int          |                                                               |
| `mime`                        | varchar(128) |                                                               |
| `tenantId` / `organizationId` | uuid NULL    | EW-657 Tier C scope columns                                   |
| `createdAt` / `updatedAt`     | timestamp    |                                                               |

Indexes: `uq_skill_files_skill_filename` (unique `skillId,filename`), `idx_skill_files_skill`,
`idx_skill_files_user`.

**The bytes are NOT in this table.** They live in the uploads spine (`user_uploads` + the active
Storage plugin), content-addressed by sha256. Deleting a `skill_files` row therefore removes the
_reference_, never the bytes (which may be shared with other references).

Migration: `apps/api/src/migrations/1786820000000-AddSkillInvocationSlugAndSkillFiles.ts` — one
nullable column + one table, both behind `hasColumn` / `hasTable` guards, written with the portable
`Table`/`TableColumn` API so it runs on Postgres and better-sqlite3 alike. Nothing to backfill.

Entity registration (the "missing from ENTITIES inventory → 500" bug class): `SkillFile` is in
`entities/index.ts`, `database/_entities-inventory.ts` and `database/_entity-names.ts`.

### Kind taxonomy (agent-plugins spec US-6)

`script` entries are **CODE and DATA-ONLY in v1** — readable through `getSkillFile`, never executed.
`reference` / `config` / `asset` are plain data. The `getSkillFile` tool description states this
explicitly so the model does not assume an execution path exists.

---

## Endpoints (`apps/api/src/skills/skills.controller.ts`)

| method | route                                  | note                                                                                                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `api/skills/invocable`                 | the caller's slugged skills; declared BEFORE `:id` so the literal segment wins routing (`:id` runs `ParseUUIDPipe` and would 400 on `invocable`) |
| POST   | `api/skills/:id/files`                 | multipart `file` + optional `kind`; 2 MB cap, 20 files/skill                                                                                     |
| GET    | `api/skills/:id/files`                 | list                                                                                                                                             |
| GET    | `api/skills/:id/files/:fileId/content` | text only; `Content-Disposition: attachment` + `nosniff`                                                                                         |
| DELETE | `api/skills/:id/files/:fileId`         | removes the row, not the bytes                                                                                                                   |

`invocationSlug` was added to `CreateSkillDto` and `UpdateSkillDto` (accepts the as-typed shape,
optional leading `/` and uppercase; the service normalizes). Ownership is checked BEFORE any bytes
are stored, so a cross-user skill id 404s without an orphan write. Cross-user reads are 404, never 403.

**Upload mime coercion**: the uploads spine enforces a fixed mime allow-list, and browsers report
`.py` / `.sh` / `.toml` with exotic or empty mimes. The controller decodes the buffer as strict
UTF-8; if that succeeds and the declared mime is one the spine would **reject**, it stores as
`text/plain`. The display filename and `kind` keep the real identity.

The reject test is the spine's own `UploadsService.acceptsSaveFileMime` — deliberately NOT a
`startsWith('text/')` heuristic. Review pass found that using the loose test broke the flagship case:
Chrome and Firefox declare `.py` as `text/x-python`, which passes `startsWith('text/')` but is not in
the spine's `TEXT_LIKE_MIMES` map, so the coercion was skipped and every script upload 400'd with
`MimeNotAllowed`. `apps/api/src/skills/skills.controller.spec.ts` pins the hand-off against the real
predicate so the two cannot drift again.

Text uploads are secret-scanned with the **same** scanner skill bodies use (`assertNoSecrets` +
`assertNoInjectionTokens`, inside `SkillFilesService.add`).

---

## Runtime: how a skill actually reaches the model

### Slash invocation

`AgentRunService.execute` — for `kind: 'chat'` runs only — parses a leading `/<slug>` off
`immediateInput` (word-boundary; `see /plan` and `//plan` do not match), looks it up **scoped to the
run's userId**, and appends an `# INVOKED SKILL` block carrying the full body to the system message.
The user's message is left byte-identical, command text included.

- Unknown `/foo` = plain text, no error.
- A failed lookup logs WARN and the run continues without the injection (best-effort).
- The body is fenced and neutralized exactly like the assembler's other untrusted segments — a skill
  body is user-authored content, so it cannot forge its own `</invoked-skill>` boundary or emit chat
  template markers, and the block header states it must not override identity/tools/output contract.
- Emits an `AgentRunLog` row (`step: 'skill-invocation'`) and a `SKILL_INVOKED` activity row.

### Activity

`SkillFilesService` writes `SKILL_FILE_EDITED` on add and on remove. That enum entry already
existed with no producer anywhere in the codebase; adding/removing a companion file changes what the
model can read for a skill, which is what it names. No enum change was needed, so no new activity
labels. Logging is best-effort — a failing or unbound `ActivityLogService` degrades to no row, never
a failed write.

The chat surface that reaches this path is **task chat**: `postTaskChat` → `agent-chat-reply` task →
`AgentRunService.execute({ kind: 'chat', immediateInput: <message body> })`.

### File manifest + `getSkillFile`

`resolveSkillsForRun` batches one `findBySkillIds` query for the skills that survived the token
budget and attaches their files. `PromptAssemblerService` renders one compact line inside the
existing `<skill>` block:

```
files: run.sh (script, 64 B); guide.md (reference, 2.0 KB) — retrieve content with the getSkillFile tool.
```

A skill with no files emits the historical block shape byte-for-byte (pinned by a spec).

`AgentToolService` registers `getSkillFile({ skillSlug, filename })` alongside `getSkillBody` under
the same predicate (the agent has skill bindings). It resolves through the agent's ACTIVE bindings,
returns text for text-like mimes, and returns a structured refusal for binary ones. Unknown slug or
filename errors list what IS available rather than 404-ing blind.

**Port/adapter split**: the agent package owns the tool but cannot reach storage, so it declares the
`SKILL_FILE_CONTENT_READER` token; `apps/api/src/skills/skill-file-content-reader.service.ts`
implements it over `UploadsService` + `UserUploadRepository`, and the `@Global()` api `AgentsModule`
binds the token (pinned in `agents.module.spec.ts`). Unbound, `getSkillFile` still lists files but
refuses every read. The reader decodes with `TextDecoder('utf-8', { fatal: true })` so a binary
payload mislabeled with a text mime is refused rather than returned as mojibake.

Every new constructor parameter across `AgentRunService`, `AgentToolService` and the two
account-transfer services is **trailing and `@Optional()`**, so existing positional constructor
calls (many unit tests) keep working and an unbound dependency degrades the feature instead of
failing DI.

---

## Web

- `SkillDetailClient` — new **Invocation Slug** section (input with a literal `/` prefix chip; empty
  save clears the command; 409s surface the API message) and new **Files** section — the whole card
  is a drop target (highlight ring while dragging) as well as a picker button, with a kind picker
  defaulting by extension, kind badge + size per row, and delete.
- `NewSkillDialog` — Invocation Slug field on create.
- `SkillsPageClient` — `/slug` chip on the skill card when set.
- `SlashCommandAutocomplete.tsx` (new) — shared `useSlashCommands` hook + `SlashCommandPopup`.
  Mounted **only** on the **task-chat composer in `TaskDetailClient`** — task chat is the one surface
  whose messages run through `AgentRunService` with `kind: 'chat'`, which is where a leading
  `/<invocation-slug>` is resolved. One module-level cache means one fetch per page load across
  composers; a failed fetch is not cached so a later keystroke retries.
    - **Not** mounted on `PromptComposer` (review-pass fix). Every `PromptComposer` call site — `/new`,
      `/works/new`, and the Missions / Ideas / Agents / Works quick-adds — feeds an entity-creation
      server action, not a chat run. The popup there offered a completion the server never resolves
      and baked a literal `"/plan "` into the created entity's description. `PromptComposer.unit.spec.tsx`
      now pins that the popup does not open and that the composer never fetches `/api/skills/invocable`.
    - Dismissal and the highlighted index are stored against the query they belong to and derived back
      out rather than reset from an effect — `react-hooks/set-state-in-effect` is an ERROR in this
      repo's eslint config and the composer re-renders on every keystroke.
- Proxy routes `app/api/skills/invocable/route.ts` and `app/api/skills/[id]/files/route.ts` translate
  the session cookie to a Bearer for browser-side fetches (same posture as `/api/uploads/file`).
- i18n: `dashboard.skillsPage.detail.invocation.*`, `.detail.files.*` and
  `dashboard.skillsPage.newPage.invocation*` added to **all 20** locale files (English copy in each,
  per house rule).

---

## Account transfer (interop)

New skill fields survive export/import. Per the account-transfer whitelist bug class, all **three**
explicit whitelist places were updated:

1. `agents-skills-tasks-types.ts` — `ExportedSkill.invocationSlug?` + `.files?`, new
   `ExportedSkillFile` interface. Both optional: older envelopes simply lack them.
2. `agents-skills-tasks-export.service.ts` — emits `invocationSlug` (null when unset) and a `files[]`
   of metadata only.
3. `agents-skills-tasks-import.service.ts` — re-applies `invocationSlug` **after** create so a
   per-user slug collision degrades to a warning in `summary.skills.errors` instead of dropping the
   whole skill; restores file rows **only for uploads the importing account already owns** (sha256
   match in `user_uploads`), reporting the rest rather than creating dangling references into
   someone else's storage.

Bytes are deliberately NOT in the envelope — `uploadId` is content-addressed, so an account that
owns or re-uploads the same bytes reconnects automatically.

---

## Divergence from the spec text

`docs/specs/features/skills/tasks.md` T14 sketched a `SkillFileService` that wrote skill **bodies**
to a git repo. This branch implements something different under a similar name: companion files over
the **uploads spine**. Reasons: the uploads spine already provides magic-byte sniffing, sha256
content addressing, per-user ownership rows and a pluggable storage backend; and the sidecar taxonomy
in `docs/specs/features/agent-plugins/spec.md` US-6 (scripts are CODE, execution-gated; references
and assets are data) is about companion files, not bodies. T14's git-backed body storage is
untouched and still open.

---

## Test commands

```bash
# agent package (Jest) — services, run pipeline, tools, account transfer
cd packages/agent && npx jest src/skills src/account-transfer \
  src/agents/__tests__/agent-run-slash-invocation.spec.ts \
  src/agents/__tests__/agent-tools-skill-file.spec.ts \
  src/agents/__tests__/prompt-assembler-file-manifest.spec.ts

# api (Jest) — the module pin that keeps SKILL_FILE_CONTENT_READER bound,
# the migration, and the controller↔uploads-spine mime hand-off
cd apps/api && npx jest src/agents/agents.module.spec.ts \
  src/skills/skills.controller.spec.ts \
  src/migrations/__tests__/AddSkillInvocationSlugAndSkillFiles.spec.ts

# web (Vitest) — the shared slash-command autocomplete
cd apps/web && npx vitest run src/components/skills/SlashCommandAutocomplete.unit.spec.tsx \
  src/components/common/PromptComposer.unit.spec.tsx

# type-check + build
cd packages/agent && pnpm type-check
cd apps/api && pnpm type-check
cd apps/web && pnpm type-check
npx turbo build --filter=ever-works-api... --filter=ever-works-web...
```

New/updated specs: `skill-invocation.spec.ts`, `skills.service.invocation.spec.ts`,
`skill-files.service.spec.ts`, `agent-run-slash-invocation.spec.ts`, `agent-tools-skill-file.spec.ts`,
`prompt-assembler-file-manifest.spec.ts`, the two `agents-skills-tasks-*.service.spec.ts`,
`AddSkillInvocationSlugAndSkillFiles.spec.ts`, `agents.module.spec.ts`,
`SlashCommandAutocomplete.unit.spec.tsx`.

Note: `--testPathPattern` is a no-op on this repo's Jest version (renamed to `--testPathPatterns`) —
passing it silently runs the WHOLE suite. Pass explicit paths, as above.

---

## Known follow-ups (not in this branch)

- **No Playwright e2e** for the file endpoints or the slash flow. The existing
  `flow-skills-validation-authz-matrix.spec.ts` pins rejected-field lists that `invocationSlug` does
  not disturb (it is whitelisted on both DTOs), so nothing there needed changing — but a
  `flow-skill-files-*.spec.ts` covering upload → manifest → delete would be worth adding.
- **`defaultKindForFilename` is duplicated** in `packages/agent/src/skills/skill-files.service.ts`
  and `apps/web/src/components/skills/SkillDetailClient.tsx` (the agent package is server-only, so
  the web copy cannot import it). The server value wins — the client only pre-selects the picker —
  but the extension lists can drift. A shared `packages/contracts` constant would fix it.
- **Scripts stay data-only.** Executing a `script` companion file is the natural next step and is
  gated per agent-plugins US-6; nothing in this branch runs one.
- **Orphaned uploads are not GC'd.** Deleting a skill file leaves the content-addressed bytes in the
  spine. That matches how other references behave today; a spine-wide reaper is the general fix.
- **`invocationSlug` uniqueness is service-enforced only.** Two concurrent writes could in principle
  both pass the check. A partial unique index on `(userId, invocationSlug) WHERE invocationSlug IS
NOT NULL` would close the race, at the cost of the friendlier 409 message.
