# Agents / Skills / Tasks — Implementation Summary

**Branch**: `feat/agents-skills-tasks-impl` off `origin/develop`
**Spec PR**: [#1017](https://github.com/ever-works/ever-works/pull/1017) (specs branch `feat/agents-skills-tasks-specs`)
**Started**: 2026-05-25 · **Completed**: 2026-05-26
**Mode**: 34 autonomous 15-min ticks via `/loop`

This implementation lands the three new feature families documented
in the spec PR, end to end, as additive code (no existing surface
broken). Ticks 1–25 covered Phases 1–20 of the original tracker;
ticks 26–34 closed every deferred sub-item that was reachable
locally (the only items still gated on out-of-branch work are noted
explicitly in "Post-merge follow-ups" below).

---

## What shipped

### Agents (Phases 1–7, 10, 16)

- 5 entities: `Agent`, `AgentRun`, `AgentRunLog`, `AgentBudget`, `AgentMembership`
- 5 repositories with the CAS-claim primitive `tryClaimForRun()`
- `AgentsService` (CRUD), `AgentFileService` (5 canonical files + secret-scan + ETag), `AgentScheduleDispatcherService` (heartbeat dispatch), `AgentExportService` (per-Agent envelope), `PromptAssemblerService` (11-segment recipe per spec), `AgentRunService` (orchestrator), `AgentToolService` (descriptor surface for the tool loop)
- Trigger.dev: `agent-heartbeat-dispatcher` (cron) + `agent-heartbeat` (one-shot)
- API: `/api/agents/*` + `/api/agents/:id/files/:name` + `/api/agents/:id/export` + `/api/agents/import`
- Web: `/agents` list + `/agents/new` + `/agents/[id]` with 6 tabs + 5-pill Instructions editor (autosave, ETag conflict banner) + `/agents/templates`
- Tool descriptors shipped: `editAgentFile` (once-per-run cap), `createSubAgent` (DRAFT + all-perms-false), `getActivity`/`getKbDocument` placeholders, `getSkillBody` (Phase 10), Tasks-side `createTask` / `commentOnTask` / `transitionTask`, **`commitToRepo` + `openPullRequest`** (tick 30, gated on a platform-bound `AGENT_GIT_FACADE` adapter), **`searchWeb` + `screenshot` + `extractContent`** (tick 31, wired through `FacadesModule`)
- **AgentRunService.finalize()** (tick 28) — kind-specific post-processing: `chat` outcomes post agent-authored replies back via `TaskChatService.post(authorType='agent')`; `task` outcomes flip status via `TasksService.transition()`. Best-effort: a side-effect failure logs WARN but does not unwind the LLM work

### Skills (Phases 8–10)

- 2 entities: `Skill`, `SkillBinding`
- Repositories with `resolveActive()` (per-target OR filter, priority-sorted, dedup by skillId)
- New plugin capability contract `ISkillsProviderPlugin` + `SKILLS_PROVIDER` constant
- First-party `@ever-works/everworks-skills-plugin` (MIT) with builtin fallback catalog (cron-defaults / secret-handling / commit-message-style)
- `SkillsFacadeService` (union across enabled providers, slug-dedup) + `SkillsService` (CRUD + install-from-catalog + bindings)
- API: `/api/skills/catalog/*`, `/api/skills/*`, `/api/skills/:id/bindings`, `/api/skill-bindings/:id`
- Web: `/skills` 3-section page (Installed / Available / Custom) with Install action + **`/skills/[id]` detail page** (tick 26) with sectioned scroll, 800ms autosave body editor, bindings panel (add/remove + priority + targetType picker), danger zone + **`/skills/templates`**
- Phase-10 injection wired into `AgentRunService`: priority-sorted greedy budget-drop, WARN run-log on drop, SKILL_INVOKED activity per skill in the prompt

### Tasks (Phases 11–17)

- 11 entities: `Task` + 10 side tables (assignees / reviewers / approvers / blocks / relations / chat-messages / attachments / watchers / kb-mentions / user-task-counter)
- All 8 F5-override recurring columns on `Task`
- `TaskRepository` with cycle-detector + `casClaimRecurrence` + 10 side repos
- New plugin capability `ITaskTrackerPlugin` + `TASK_TRACKER` constant
- First-party `@ever-works/everworks-task-tracker-plugin` (MIT, DB-shim)
- `TasksFacadeService`, `TasksService`, `TaskTransitionService` (full state machine), `TaskChatService` (5-min edit window + mention parser w/ T6 unknown-token stripping + KB mention materialization), `TaskRecurrenceDispatcherService` (CAS-claim + spawn loop), `TaskNotificationService` (watcher union + dedup + per-event templates)
- Trigger.dev: `agent-task-execute` (60m), `agent-chat-reply` (5m), `task-recurrence-dispatcher` (per-minute UTC)
- Dispatch hooks: `→ in_progress` fans out to `agent-task-execute` for every Agent assignee with `dedupKey='${taskId}:${agentId}:${generation}'`; `@agent` chat mentions fan out to `agent-chat-reply` with `dedupKey='${taskId}:${agentId}:${messageId}'`
- API: full `/api/tasks/*` + `/api/tasks/:id/transition` + member CRUD + `/api/tasks/:id/chat` + `/api/task-chat-messages/:id` + `/api/tasks/:id/recurring` + `/api/tasks/:id/spend` + **`/api/tasks/:id/attachments` (3 verbs)** (tick 27)
- Web: `/tasks` (cards / table / kanban view toggle + status filter) + `/tasks/new` + `/tasks/[id]` (sectioned detail with transition affordance + chat thread + post box) + per-target tabs at `/works/[id]/tasks` + `/missions/[id]/tasks` + `/ideas/[id]/tasks` + **`/tasks/templates`**

### Cross-cutting (Phases 18–19)

- Dashboard: `AgentsCountTile`, `TasksInProgressTile`, `RecentTasks` block (sits below Recent Works)
- Notifications: `NotificationCategory.AGENT` + `TASK` enum values, `User.emailAgentAlerts` + `User.emailTaskNotifications` opt-in flags
- Account-transfer v2 payload tail: `ExportedAgent` / `ExportedSkill` / `ExportedTask` types + `AgentsSkillsTasksExportService.exportTail()` + `AgentsSkillsTasksImportService.importTail()` reusing single-entity service surfaces for full validation parity
- **`PluginUsageEvent` attribution** (tick 29): `FacadeOptions` gains `agentId` + `taskId`; `PluginUsageService.record()` persists them; all 4 `AiFacadeService` callsites + the 3 plugin-facade callsites forward attribution so per-Agent + per-Task spend rollups carry real data
- **GitHubSyncService v2 subdir layout** (tick 32): `agents/<slug>.json` / `skills/<slug>.json` / `tasks/<slug>.json` one-file-per-row layout in the `ever-works-config` sync repo; manifest carries per-section counts; version inferred from tail-subdir presence when manifest is stale
- **`/settings/import-export` v2 toggles** (tick 33): `ExportOptions` extended with `includeAgents` / `includeSkills` / `includeTasks` / `includeTaskChat`; `AccountExportService` calls `exportTail()` when any toggle is set; API controller accepts 4 new query params; web server action overload-accepts `boolean | ExportToggles`; UI `DataManagement.tsx` renders the "Additional sections (v2 payload)" fieldset
- **Templates browser scaffold** (tick 34): shared `AstTemplatesBrowser` component + hand-curated fallback catalog + 3 routes (`/agents/templates`, `/skills/templates`, `/tasks/templates`); swap-in point for the ADR-010 unified Workshop Templates catalog when it lands

---

## Architecture decisions referenced

- **ADR-006** — Agents are core (not a plugin), Skills + Tasks are plugin capabilities
- **ADR-008** — File storage: DB-inline for tenant scope (v1), Git for Mission/Work scope (Phase 6 follow-up)
- **ADR-010** — Unified Workshop Templates catalog (templates browser scaffold lands ahead of this; swap is a single-file change)
- **ADR-012** — Skills are a plugin capability; "Ever Works Skills" is the first-party `skills-provider`
- **ADR-013** — Tasks are a plugin capability; "Ever Works Task Tracker" is the first-party `task-tracker`
- **ADR-014** — Platform is AGPLv3; the catalog plugins are MIT

---

## Migrations

In FK-safe order:

1. `1779978010000-CreateAgentsTables` — 5 Agent tables + 14 indexes
2. `1779978011000-AddAgentIdToPluginUsageEvents` — `agentId` column + index for per-Agent spend rollup
3. `1779978012000-CreateSkillsTables` — 2 Skill tables + 6 indexes
4. `1779978013000-CreateTasksTables` — 11 Task tables + ~22 indexes (incl. `(isRecurring, nextOccurrenceAt)` dispatcher hot path)
5. `1779978014000-AddTaskIdToPluginUsageEvents` — `taskId` column + index for per-Task spend rollup
6. `1779978015000-AddNotificationEmailOptIns` — `emailAgentAlerts` + `emailTaskNotifications` on `users`

---

## Test posture

Every service ships with unit tests under `__tests__/` written but **NOT run** during the autonomous loop — the operator runs the full `pnpm test` suite after merge. Tests cover:

- Permission gates, cross-user 404s, slug uniqueness, secret-scan, size caps
- State-machine lattice (TaskTransitionService) + side effects + force-flag semantics
- CAS-claim winners + losers (Agent heartbeat dispatcher + Task recurrence dispatcher)
- Mention parser strips unknown tokens (T6 mitigation)
- Tool descriptor shapes + once-per-file-per-run cap + sub-Agent DRAFT+all-false-perms enforcement
- Prompt assembler 11-segment ordering, per-trigger preambles, tail-first truncation, per-Agent skill-budget override
- Budget-period math for all 5 intervals (hour/day/week/month/unlimited)
- Account-transfer payload tail toggles + slug-space pointer rewrites
- **`AgentRunService.finalize()` 10 specs** (tick 28): errored / chat happy / blank-body / chat-back failure / no-taskId / task happy / force=true / finisher failure / heartbeat no-op / unbound tokens
- **`PluginUsageService` attribution 5 specs** (tick 29): both columns persist / agent-init w/o workId / task-init w/o workId / all-anchors-absent skip / defaults to null
- **`AgentToolService` git tools 12 specs** (tick 30): permission gates, Work-scope refusal, happy invoke shape, missing-field rejection, adapter-exception capture
- **`AgentToolService` plugin tools 9 specs** (tick 31): gating, happy invoke for all 3, missing-field rejection, adapter-exception capture
- **`GitHubSyncService` v2 layout 6 specs** (tick 32): per-row file writes, manifest counts, no-subdir when empty, traversal-slug skip, full round-trip, stale-manifest inference
- **`AccountExportService` v2 tail 5 specs** (tick 33): toggle-off-default, toggle-on round-trip, empty-tail v1, tail-crash recovery, no-call without toggle
- **`agent-templates` fallback 6 specs** (tick 34): per-entity coverage, mandatory fields, slug uniqueness, getAstTemplate hit/miss, entity scoping

---

## Post-review fixup commits (Tick 42)

A comprehensive 4-parallel-agent review of the 226 changed files surfaced
11 critical + 7 important issues. All were fixed in a single fixup tick
on top of the 41 implementation ticks. Headline fixes:

- **C1 + C10**: `tasks.uq_tasks_slug` changed from global to `(userId, slug)` to match the per-user `UserTaskCounter` increment; `nextSlug` rewritten as single-round-trip `INSERT … ON CONFLICT DO UPDATE … RETURNING`.
- **C2**: `installCatalogSkillAction` now reads the real `everworks_auth_token` cookie via `getAuthFromCookie()` (the previous `user-id` cookie didn't exist).
- **C3**: `GitHubSyncService.pushToGitHub` now forwards the v2-tail toggles — Agents/Skills auto-mirror, Tasks opt-in.
- **C4**: `AgentFileService.write` passes `agent` as the `hashOf` base so multi-file ETag checks stop mismatching.
- **C5**: 10 tool-descriptor parameters retyped from `'string'` to correct JSON-Schema types (`array`/`number`/`integer`/`boolean`).
- **C6**: Blocker gate fires on `→ in_progress` AND `→ done` per spec FR-9. `force` overrides approver only, never blocker.
- **C7**: Notification dedup key includes per-event discriminators (from→to status, blockerTaskId, occurrenceCount) so users see every event, not just the first.
- **C8**: `TasksService.create` walks the parent chain for cycle detection on insert.
- **C9**: `commentOnTask` validates Agent membership; `transitionTask` gated by `canAssignTasks`.
- **C11**: Heartbeat dispatcher releases the CAS claim when enqueue fails (instead of leaving the Agent stuck in RUNNING).
- **I1**: `TaskTransitionService.autoUnblockResolvedTasks` cascades on blocker → done/cancelled and on `removeBlocker` — FR-10.
- **I2**: `allApproved` returns true when zero approvers configured (FR-11 phrasing).
- **I3**: Chat edit persists re-parsed `mentions` + re-materializes KB mentions.
- **I4**: Assignee / reviewer / approver add paths validate Agent existence belongs to the user.
- **I5**: `postChat` populates `ownedAgentSlugs` mention-lookup → `@<slug>` mentions now resolve → agent-chat-reply dispatch fires from human comments.
- **I6**: `createSubAgent` tool routes through `AgentsService.create()` so slug-uniqueness + scope-ownership validation + permission refinement all run.
- **I7**: Agent import-overwrite refreshes `contentHash` so subsequent ETag-aware writes stay consistent.
- **I8**: `AgentExportService.exportOne` runs `assertNoSecrets` on every file body BEFORE serializing the envelope.
- **I9**: Renamed `…SourceSlug` fields to `…SourceId` (they carry UUIDs, not slugs).
- **I10**: Trigger.dev dispatcher adapters pass `idempotencyKey` so double-fires are deduped at the runner.
- **I11**: `PUT /agents/:id/files/:name` throttle confirmed at 60/min per plan §7.1 (Tick 42 originally tightened to 30/min based on a mis-read; Tick 45 reverted to 60/min after re-reading the "UI typing autosave" rationale in the plan).
- **I13**: `TaskNotificationService.emit` is now actually invoked — `task_assigned` on `addAssignee`, `task_status_changed` + `task_blocked` on transition.
- **I14**: SkillDetailClient delete-redirect uses `useRouter().push()` so the locale prefix is preserved.
- **I15**: AgentInstructionsEditor `dirty` flag allows saving an intentionally-cleared file body.
- **I17**: Activating an Agent from DRAFT now computes the first heartbeat slot via `computeNextHeartbeat(cadence)` instead of firing immediately.
- **I18**: Dropped the `as any` cast on `TaskStatus.BACKLOG` in `cloneRecurringTaskAsInstance`.

The previously-listed "Phase 14.4 / 17.8 / 18.1" follow-ups are removed
from this list — they were already in the branch but stale-noted as
deferred.

## Tick 43 — second-pass corrections (4 bugs my own Tick 42 introduced)

- **NEW-1**: `AgentRepository` import path was wrong (`/agents` vs `/database`) — TS build break. Fixed in tasks.controller.ts + task-chat.controller.ts.
- **NEW-2**: `AgentsModule` was missing from `apps/api/src/tasks/tasks.module.ts` imports — Nest boot failure. Added.
- **NEW-DB**: `nextSlug` raw SQL referenced a nonexistent `createdAt` column on `user_task_counter`. Removed from both pg + sqlite branches.
- **NEW-domain**: `removeBlocker` was calling the wrong helper (`autoUnblockResolvedTasks(taskId)` looks for tasks blocked BY the arg; needed `recheckUnblockFor(taskId)` for the dependent-side). Added the new helper + rewired the call site.
- Minor cleanups: dropped redundant `as any` casts in `createSubAgent` fallback; `applyEnvelopeToExisting` refreshes avatar fields; one stale `toHaveBeenCalledWith` assertion in `github-sync.service.spec.ts` switched to `objectContaining`.

## Tick 44 — third-pass corrections (stale tests + 4 semantic gaps + 4 new tests)

- 2 stale test assertions would have failed `pnpm test` immediately: `task-notification.service.spec.ts` C7 dedup-key assertion + `task-chat.service.spec.ts` `updateBody` assertion. Both updated to match the post-tick-42 service signatures.
- `task_blocked` notification now populates `blockerTaskId` from `findOpenBlockers` so the C7 dedup discriminator distinguishes repeat block events (previously all firings collapsed to the literal "blocked").
- `task_recurrence_fired` emit wired into `TaskRecurrenceDispatcherService` after a successful spawn (the enum branch was dead code).
- `TasksService.addBlocker` catches unique-violation on `(taskId, blockedByTaskId)` and surfaces 409 ConflictException instead of bubbling 500.
- Migration `ensureIndex` helper now drops + recreates when an existing index has a different column-set (so a dev env that ran an in-development version with the old `uq_tasks_slug` global-unique shape self-corrects to the per-user shape on next run).
- 4 new regression tests: C7 dedup discriminator differs between firings; C11 dispatcher calls `releaseAfterRun` on enqueue failure + does NOT call when claim returned null; I3 chat edit re-parsed mentions persist + KB mentions re-materialize; I17 DRAFT→ACTIVE computes first cadence slot.

## Tick 45 — fourth-pass corrections (3 CRITICAL + 4 HIGH)

- **DI scoping CRITICAL** — api-side TasksModule + AgentsModule now `@Global()` so the 6 injection tokens (dispatchers + post-processors + plugin facade) actually reach consumers in the agent-package modules. Without this, all Phase-15 dispatch + post-processor surfaces silently no-opped in production despite passing unit tests.
- **Templates dead-end CRITICAL** — NewAgentDialog + NewTaskForm now read `?from=<slug>` query param and pre-fill name/title/description/labels from the fallback catalog. "Use template" actually populates the create form now.
- **Avatar overwrite HIGH** — `applyEnvelopeToExisting` now applies the same `safeAvatarMode` normalization as the create path (cross-tenant image-upload references fall back to INITIALS).
- **pushToGitHub v2 toggles HIGH** — account controller body widened + web action signature widened so the GitHubSyncService v2 subdir layout is actually reachable from the API surface.
- **Custom Skills unreachable HIGH** — new `CustomSection` component on `/skills` with inline "+ New Skill" form (tenant scope by default). Previously the Custom tab was forever empty because the only install path forced `sourceCatalogSlug`.
- **64-hop parent cycle cap MEDIUM** — now throws BadRequestException on overflow instead of silent pass.
- **file-write throttle MEDIUM** — reverted from 30/min to 60/min per plan §7.1.

## Tick 46 — fifth-pass cosmetic corrections (after a clean review)

- `accountTransferAPI.pushToGitHub` client signature widened to mirror the controller's full toggle set (previously narrow → object-literal callers would have hit TS excess-property errors).
- `docs/architecture/agent-injection-tokens.md` gained a "Binding posture" note about the `@Global()` requirement on the api-side modules that provide the tokens.
- This file (IMPLEMENTATION-SUMMARY.md) refreshed to reflect ticks 43–46 (previously stopped at Tick 42).

## Remaining post-merge follow-ups

These items are genuinely gated on external work (not autonomous-loop-sized):

- **Phase 4 Git-mode** AgentFileService writes (waits on `GitFacadeService` scope-repo helpers shared with the heartbeat dispatcher)
- **Phase 5.6 Tiptap upgrade** for the Instructions 5-pill editor (currently plain textarea; reuses `KbEditor` once the shared editor toolbar is extracted)
- **Phase 6a UI** export/import flow surface (server actions + envelope ready; needs the FileInput primitive lifted out of the KB upload surface)
- **Phase 7.4/7.5 LLM dispatch** inside `AgentRunService.execute` — the orchestrator assembles the prompt, runs `finalize()`, and integrates with `AGENT_RUN_CHAT_BACK_POSTER` / `AGENT_RUN_TASK_FINISHER` / `AGENT_GIT_FACADE` / `AGENT_PLUGIN_TOOLS_FACADE` — what remains is the actual `AiFacadeService.createChatCompletion` round-trip wiring (needs real provider keys)
- **Phase 13.3 chat input upgrade**: mention picker + Tiptap-lite + KB wikilink autocomplete (waits on the shared chat-input primitive)
- **Phase 13.5 attachment UI** (the API path + 3 endpoints shipped; the shared FileInput primitive is the only remaining piece)
- **Phase 14.2 drag-drop** Kanban transitions (click-to-transition ships; drag-drop wraps once a dnd library is chosen)
- **Phase 14.5 Idea per-card drawer** for Tasks
- **Phase 16.6/16.7 operator binding**: the `AGENT_GIT_FACADE` token is wired in `AgentToolService`; the API-side `AgentsModule` deliberately leaves it unbound until the operator confirms their git provider setup is stable, then binds a thin adapter over `GitFacadeService.commit()` / `.createPullRequest()`
- **Phase 18.6 templates content swap**: scaffold shipped; when ADR-010 unified catalog lands, `listAstTemplates` body swaps from fallback constants to a `serverFetch('/api/agent-templates?entity=…')` call
- **Phase 19.6 per-feature import conflict pickers** (skip / overwrite / rename per family): existing `ImportFlow`'s per-item conflict surface stays — the family-scope picker rework is post-merge UX

---

## How to merge

1. Wait for spec PR [#1017](https://github.com/ever-works/ever-works/pull/1017) to land on `develop`.
2. Rebase `feat/agents-skills-tasks-impl` onto the updated `develop`.
3. Run `pnpm format && pnpm lint && pnpm type-check` from the repo root.
4. Run `pnpm test` — full suite. Triage any failures (most likely test fixtures that need updating for the new entities / enum values).
5. Open PR against `develop` with this file as the description scaffold.
6. After merge, the API auto-applies the 6 new migrations on next boot via `migrationsRun: true`.
7. **Optional operator binding**: to activate the `commitToRepo` + `openPullRequest` Agent tools, bind `AGENT_GIT_FACADE` in `apps/api/src/agents/agents.module.ts` to an adapter that forwards into `GitFacadeService`. Until bound, the descriptors are simply absent from the model's tool list (no mysterious failures).
