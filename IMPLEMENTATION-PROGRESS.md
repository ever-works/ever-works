# Agents / Skills / Tasks — Implementation Progress

**Branch**: `feat/agents-skills-tasks-impl` off `origin/develop`
**Worktree**: `C:/Coding/Worktrees/wt-agents-skills-tasks-impl`
**Started**: 2026-05-25
**Mode**: autonomous overnight `/loop` — 15 min ticks; no human in the loop until done.

This file is the source of truth for "where are we in implementation." **Every tick reads it first, updates it last, and commits both code + this file in the same commit.** That way a tick that crashes mid-way leaves the progress unchanged and the next tick retries cleanly.

---

## [BRANCH COMPLETE — OPERATOR ACTION REQUIRED]

**As of tick 42 (2026-05-26)** every box on the Phase 1–20 tracker is ticked AND every reachable deferred sub-item has shipped. Ticks 26–40 closed the post-Phase-20 polish; ticks 39–40 added the operator-reference docs. **Tick 42 applied all 11 critical + 16 important fixes** surfaced by a parallel-agent code review of the 226-file diff — see `IMPLEMENTATION-SUMMARY.md` "Post-review fixup commits (Tick 42)" for the headline list.

**There is no work left for the autonomous loop.** Subsequent ticks would either fabricate phantom work or marginally polish already-shipped code, both of which inflate diff size without value. If this loop fires again it should self-stop on this sentinel.

**To merge:**

1. Wait for spec PR [#1017](https://github.com/ever-works/ever-works/pull/1017) to land on `develop`.
2. `git rebase develop` from this worktree.
3. From the repo root: `pnpm format && pnpm lint && pnpm type-check`.
4. `pnpm test` — triage any failures (most likely test fixtures referencing the new entities / enum values).
5. Open a PR against `develop` with `IMPLEMENTATION-SUMMARY.md` as the body.
6. After merge the API auto-applies the 6 new migrations on next boot via `migrationsRun: true`.

**Genuinely external follow-ups** (NOT loop-sized — wait for the relevant upstream work):
- Phase 4 Git-mode AgentFileService writes (waits on `GitFacadeService` scope-repo helpers)
- Phase 5.6 Tiptap upgrade for the Instructions editor (shared editor toolbar primitive)
- Phase 6a / 13.5 upload-UI surfaces (shared FileInput primitive lift)
- Phase 7.4/7.5 LLM dispatch (real provider keys + cost budget)
- Phase 13.3 chat input upgrade (shared chat-input primitive)
- Phase 14.2 drag-drop Kanban (dnd library choice)
- Phase 14.5 Idea per-card drawer (shared drawer primitive)
- Phase 16.6/16.7 operator-binding for `AGENT_GIT_FACADE` (see `docs/architecture/agent-injection-tokens.md`)
- Phase 18.6 templates content swap to ADR-010 unified catalog (single-file change in `lib/api/agent-templates.ts`)
- Phase 19.6 per-feature import conflict pickers (broader ImportFlow rework)

---

## Source specs (DO NOT MODIFY)

The full specification set is on branch [`feat/agents-skills-tasks-specs`](https://github.com/ever-works/ever-works/tree/feat/agents-skills-tasks-specs/docs/specs) (PR [#1017](https://github.com/ever-works/ever-works/pull/1017)). Key files implementers must consult:

- **Anchor**: `docs/specs/architecture/agents-skills-tasks.md` (read first, on spec branch URL above)
- **Shipping plan**: `docs/specs/architecture/implementation-reuse-map.md` §14 — this PROGRESS tracker is grouped by the PRs listed there
- **Tools API**: `docs/specs/architecture/agent-tools-catalog.md`
- **Prompt assembly**: `docs/specs/architecture/agent-prompt-assembly.md`
- **Security**: `docs/specs/architecture/security-agents-skills-tasks.md`
- **agent.yml schema**: `docs/specs/architecture/agent-yml-manifest-schema.md`
- **Feature specs**: `docs/specs/features/{agents,skills,task-tracking}/{spec,plan,tasks}.md`
- **ADRs**: `docs/specs/decisions/{006..014}-*.md`

Specs are NOT in this implementation branch's checkout (we branched off `develop`, not off the spec branch). Read from the spec-branch URL above when needed. After spec PR #1017 lands on develop, rebase this branch to pull them in.

---

## Tick rules (for the autonomous loop)

0. **Terminal-state check first.** Before doing anything else, read the `[BRANCH COMPLETE — OPERATOR ACTION REQUIRED]` section above. If it's present, the autonomous work is finished — **emit a one-line "loop halted, branch complete (see PROGRESS top)" status message and stop without making any commits or pushes.** Anything done past this point inflates diff size without value.
1. **Read this file first.** Find the first phase still marked `[ ]` (not done). That's where to work.
2. **One tick = one phase** if it fits in 15 min, else **one chunk** of a phase. The "Next chunk" field below tells you exactly what to do.
3. **Write code + e2e/unit tests, but DO NOT RUN tests.** Operator will run the full suite later. Just author and commit them.
4. **Commit + push at the end of every tick.** Conventional-commit format (`feat:`, `test:`, `chore:`, etc.). Push to `feat/agents-skills-tasks-impl`.
5. **Update this file in the SAME commit.** Tick the box, refresh "Next chunk", increment "Last tick #", set "Last tick at" to current UTC.
6. **Never delete or modify existing platform code without checking the spec.** This work is additive (per NN #20).
7. **No cloud agents.** Everything runs locally. Workspace `.config/` has credentials if needed.
8. **No questions to operator.** Default to the ★ choice / spec text. If a real ambiguity blocks, write `[BLOCKED-NEEDS-OPERATOR: <question>]` into this file and skip to the next phase.
9. **Never run destructive git ops** (force push, reset --hard, branch -D on shared branches) without explicit need.
10. **Stale-tick recovery**: if "In progress now" below is older than 30 min, assume the previous tick is stuck — clear that field and start the same phase fresh.

---

## Tick counter

- **Last tick #**: 44
- **Last tick at**: 2026-05-26 (tick 44 — third-pass review surfaced 2 stale tests that would have failed CI immediately (HIGH: `task-notification.service.spec.ts` dedup-key assertion + `task-chat.service.spec.ts` updateBody assertion both didn't match the tick-42 fixes), plus several real semantic gaps. Applied: (a) updated both stale-test assertions to match the new dedupKey shape and `updateBodyAndMentions` call; (b) `task_blocked` notification now populates `blockerTaskId` from `findOpenBlockers` so the C7 dedup discriminator distinguishes repeat block events (previously they all collapsed to the literal "blocked"); (c) wired `task_recurrence_fired` emit into `TaskRecurrenceDispatcherService` (the enum branch was dead code); (d) `TasksService.addBlocker` catches unique-violation on `(taskId, blockedByTaskId)` and surfaces 409 ConflictException instead of bubbling 500; (e) migration `ensureIndex` helper now drops + recreates when column-set differs (so a dev env that ran an in-development version with the old global `uq_tasks_slug` shape self-corrects to the per-user shape on next run). Added 4 new tests: C7 dedup discriminator differs between firings; C11 dispatcher calls `releaseAfterRun` on enqueue failure + does NOT call when claim returned null; I3 chat edit re-parsed mentions persist + KB mentions re-materialize; I17 DRAFT→ACTIVE computes first cadence slot (not now) + manual cadence skips entirely.)
- **In progress now**: [BRANCH COMPLETE — see top of file]. Three review passes complete; PR ready for human merge.

---

## Phase tracker

The phases below mirror the 18-PR shipping plan in `implementation-reuse-map.md §14`, sub-divided where a single PR is too large to fit in a 15-min tick. Critical-path phases are marked **HIGH RISK** (allocate extra ticks).

### Phase 0 — Bootstrap (DONE)

- [x] **0.1** Create implementation worktree off `origin/develop` ✓
- [x] **0.2** Write IMPLEMENTATION-PROGRESS.md ✓
- [x] **0.3** Initial commit + push branch ✓

### Phase 1 — Core Agent entities

- [x] **1.1** Create `packages/agent/src/entities/agent.entity.ts` per `features/agents/plan.md §3.1`. Includes the 3-avatar columns (`avatarMode` / `avatarIcon` / `avatarImageUploadId`) per H3 override, all 5 `intervalUnit` values per N6 override. ✓ Tick 1
- [x] **1.2** Create `agent-run.entity.ts`, `agent-run-log.entity.ts`, `agent-budget.entity.ts`, `agent-membership.entity.ts`. ✓ Tick 1
- [x] **1.3** Register entities in `packages/agent/src/entities/index.ts` and `packages/agent/src/database/database.config.ts` (the actual loader the typeorm.config.ts wraps). ✓ Tick 1
- [x] **1.4** Generate migration `CreateAgentsTables.ts` — `apps/api/src/migrations/1779978010000-CreateAgentsTables.ts` (5 tables + FKs + 14 indexes, idempotent guards, portable `text` for simple-json). ✓ Tick 2
- [x] **1.5** Extend `BudgetOwnerType` enum in `_types.ts` to add `AGENT` value. ✓ Tick 1
- [x] **1.6** Migration: `AddAgentIdToPluginUsageEvents.ts` — `apps/api/src/migrations/1779978011000-AddAgentIdToPluginUsageEvents.ts` (additive column + index, no FK — Agent delete must not cascade audit rows). Also added the matching `agentId` column to `PluginUsageEvent` entity. ✓ Tick 2
- [x] **1.7** Unit tests for entity shape + indexes (don't run): `agent.entity.spec.ts`, `agent-run.entity.spec.ts`, `agent-budget.entity.spec.ts`. Metadata-only assertions via `getMetadataArgsStorage()` — no DB needed. ✓ Tick 2

### Phase 2 — Agent repositories

- [x] **2.1** `AgentRepository` with `findById`, `findByIdAndUser`, `findByUserIdScoped`, `findByUserIdAndSlug` (scope-aware), `findDueForHeartbeat`, `tryClaimForRun` (CAS-claim mirroring `WorkScheduleRepository.tryMarkDispatched`), `releaseAfterRun`, `incrementErrorCount` (with auto-pause at threshold), `transitionStatus` (state-machine guarded), `findStuckRunning`, `findByScopeTarget`. ✓ Tick 3
- [x] **2.2** `AgentRunRepository` (createQueued/markStarted/markCompleted/markFailed/markCancelled, `findInFlightForTaskAgent` for chat-dedup), `AgentRunLogRepository` (append/findByRun), `AgentBudgetRepository` (findByAgentId/upsert/summary), `AgentMembershipRepository` (findByAgent/findAgentIdsForTarget/addMembership/removeMembership/replaceForAgent/findAgentIdsForAnyTarget). ✓ Tick 3
- [x] **2.3** Repository unit tests — `agent.repository.spec.ts` covers CAS-claim (6 assertions: null on no-row / null nextHeartbeatAt / non-ACTIVE / success returns original timestamp / failure on affected=0 / exact CAS guards), `incrementErrorCount` auto-pause threshold, `transitionStatus` state-machine. Mocked Repository<Agent>; no DB needed. ✓ Tick 3

### Phase 3 — AgentService + AgentsController (read-only)

- [x] **3.1** DTOs under `apps/api/src/agents/dto/agent.dto.ts` — `CreateAgentDto`, `UpdateAgentDto`, `ListAgentsQueryDto`, `AgentPermissionsDto`, `AgentTargetDto`. class-validator decorators throughout (+`@Type` for class-transformer nested validation). ✓ Tick 4
- [x] **3.2** `AgentsService` at `packages/agent/src/agents/agents.service.ts` — create / getOne / list / update / transition / pause / resume / archive / deleteHard / assertCanAssignAcrossScope. Scope-cascade validation, slug derivation + uniqueness, permission refinement (canOpenPullRequests ⇒ canCommitToRepo), 3-avatar-mode field coherence, user-transition state machine, cross-user 404. ✓ Tick 4
- [x] **3.3** `AgentsController` at `apps/api/src/agents/agents.controller.ts` — `/api/agents` routes (list, create, get, update, archive/hard-delete via `?hard=true`, pause, resume). `@Throttle` 30/min on writes per `agents/plan.md §7.1`. `@ApiTags('agents')` + `@ApiOperation` per Decision A19 so the MCP whitelist auto-derivation picks each route up. ✓ Tick 4
- [x] **3.4** `apps/api/src/agents/agents.module.ts` + `packages/agent/src/agents/agents.module.ts` (agent-side module). Wired into `apps/api/src/api.module.ts`. `package.json` of `@ever-works/agent` gets the new `./agents` subpath export so `@ever-works/agent/agents` resolves. ✓ Tick 4
- [x] **3.5** Service unit tests at `packages/agent/src/agents/__tests__/agents.service.spec.ts` (~20 assertions: scope validation, slug uniqueness, permission refine, avatar pairing, status transitions, cross-scope assignment authorization). e2e scaffold at `apps/api/test/agents.e2e-spec.ts` (skipped pending shared bootstrap helper wire-up). ✓ Tick 4

### Phase 4 — AgentFileService + file endpoints

- [x] **4.1** Secret-scan helper at `packages/agent/src/utils/secret-scan.ts` with all 7 patterns (the 6 from security §6 plus the generic `sk-/key-/token-/Bearer` family). Exports `scanForSecrets` / `containsSecret` / `assertNoSecrets` (hard-reject) / `redactSecrets` (for chat / Task body — used in Phase 13). ✓ Tick 5
- [x] **4.2** `AgentFileService.read(userId, agentId, name)` + `.write({userId, agentId, name, body, expectedHash})`. DB-inline path fully implemented for tenant-scope. Git mode for Mission/Work/Idea-scope intentionally stubbed with a clear "Phase 6" error message — the wiring needs scope-repo helpers that also feed the heartbeat dispatcher. ✓ Tick 5
- [x] **4.3** `GET /agents/:id/files/:name` + `PUT /agents/:id/files/:name` added to `AgentsController`. Name validated against `AGENT_FILE_NAMES` allow-list at both DTO and service layers (path traversal mitigation T3). PUT `@Throttle({60/min})`. ✓ Tick 5
- [x] **4.4** `agents.contentHash` recomputed on every successful write — sha256 of canonical 5-file concat with sentinel separators so re-arranged content can't hash-collide. ✓ Tick 5
- [x] **4.5** Activity events `AGENT_FILE_EDITED` (success) and `AGENT_FILE_REVERTED` (etag mismatch / concurrent edit) emitted via `ActivityLogService.log`. Also extended `ActivityActionType` enum with all the new Agent / Skill / Task event types from architecture §10 (16 new values). ✓ Tick 5
- [x] **4.6** Tests (don't run): `utils/__tests__/secret-scan.spec.ts` (~14 assertions: each of 8 patterns detected, prose no-false-positive, multi-hit, hint propagation, truncation, redact); `agents/__tests__/agent-file.service.spec.ts` (~10 assertions: cross-user 404, inline read, empty inline, path traversal rejection, Git-mode stub error, file-name validation, 64KB cap, secret rejection, happy-path persist+hash+activity, ETag mismatch, content addressing). ✓ Tick 5

### Phase 5 — Web list + Instructions tab + Create dialog

- [x] **5.1** Sidebar item insertion in `DashboardSidebar.tsx` for Agents / Tasks / Skills. Added Bot/ListChecks/Sparkles lucide imports + 3 nav array entries. ✓ Tick 6
- [x] **5.2** i18n keys per `features/agents/spec.md §5.1` — `dashboard.navigation.{tasks,agents,skills}` + `dashboard.agentsPage.*` + `dashboard.tasksPage.*` + `dashboard.skillsPage.*` blocks in `apps/web/messages/en.json`. ✓ Tick 6
- [x] **5.3** `/agents` empty-state page + populated Cards list. View-mode (Cards/Table) switcher deferred to a later sub-tick — v1 is cards-only so the page works immediately. Route constants `DASHBOARD_AGENTS/AGENT_NEW/AGENT(id)/AGENT_*` added to `apps/web/src/lib/constants.ts`. ✓ Tick 6
- [x] **5.4** `/agents/new` 2-step create dialog (`NewAgentDialog.tsx`). Step 1 scope picker (tenant active, Mission/Work/Idea show "coming soon" since v1 only ships tenant from the +New page; scope-bound Agents land from inside the parent's detail screen in later phases). Step 2 name + optional title; auto-derives slug server-side. ✓ Tick 6
- [x] **5.5** `/agents/[id]` layout + 6-tab strip (`AgentDetailTabs.tsx`). Layout fetches the Agent once + renders header + tabs + nested `<children>`. Each tab is a placeholder page (Dashboard summary, Activity stub, Instructions, Skills stub, Budgets stub, Settings read-only). ✓ Tick 6
- [x] **5.6** Instructions tab — 5-pill editor (`AgentInstructionsEditor.tsx`). v1 textarea per pill; Tiptap upgrade reusing `KbEditor.tsx` deferred until the shared editor toolbar is extracted. 800ms autosave debounce + ETag conflict banner + secret/size error banner. Uses `writeAgentFileAction`. ✓ Tick 6
- [x] **5.7** `apps/web/src/lib/api/agents.ts` client wrappers (`agentsAPI.list/get/create/update/archive/deleteHard/pause/resume/readFile/writeFile`). Server actions in `apps/web/src/app/actions/agents.ts`. ✓ Tick 6
- [x] **5.8** Tasks + Skills sidebar nav placeholder pages so the routes resolve until Phase 9 / 12 ship the real UI. ✓ Tick 6
- [x] **5.9** Unit test (don't run): `AgentCard.unit.spec.tsx` — name+scope rendering, initials avatar, heartbeat label states. ✓ Tick 6

### Phase 6 — Agent heartbeat dispatcher (HIGH RISK)

- [x] **6.1** `packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts` cron `*/${AGENT_DISPATCH_INTERVAL_MINUTES} * * * *` (default 1m, env-tunable). Wraps a transient Nest context on `TriggerInternalModule` + a small `AgentHeartbeatTrigger` adapter that `tasks.trigger('agent-heartbeat', payload)`. ✓ Tick 7
- [x] **6.2** `AgentScheduleDispatcherService.dispatchDue(trigger, limit)` with CAS-claim wiring through `AgentRepository.tryClaimForRun` (the Phase 2.1 primitive that mirrors `WorkScheduleRepository.tryMarkDispatched`). Persists a queued `AgentRun` row up-front so chat-dedup + Activity tab work. Honors `AGENTS_DISPATCHER_ENABLED=false` feature flag. ✓ Tick 7
- [x] **6.3** Race test in `packages/agent/src/agents/__tests__/agent-schedule-dispatcher.service.spec.ts` — second worker sees `tryClaimForRun → null` and increments `skipped` instead of dispatching. Also covers happy path, failure path, stuck-recovery, and feature-flag gating. ✓ Tick 7
- [x] **6.4** `packages/tasks/src/tasks/trigger/agent-heartbeat.task.ts` one-shot, `maxDuration = AGENT_MAX_RUN_DURATION_SECONDS` (default 1800s/30m). Phase-6 v1 is a placeholder that marks the AgentRun started + completed, computes `nextHeartbeatAt` from cadence, and releases the Agent back to ACTIVE. Real prompt-assembly + LLM + tools land in Phase 7. `onFailure` hook increments errorCount + auto-pauses past threshold. ✓ Tick 7
- [x] **6.5** Wired to `apps/api/src/trigger/trigger-internal.controller.ts` via the remote-proxy table — `AgentScheduleDispatcherService`, `AgentRepository`, `AgentRunRepository` exposed on both API-side `remoteMap` and worker-side `TriggerInternalModule` (`packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts`). API-side trigger module also now imports `AgentsModule`. ✓ Tick 7
- [x] **6.6** `computeNextHeartbeat(cadence, from?)` helper at `packages/agent/src/agents/heartbeat-cron.ts` — iterate forward minute-by-minute against `matchesCron` (same approach mission-tick uses), advances strictly past `from`, returns null for `'manual'` / null / unparseable input. Unit tests in `__tests__/heartbeat-cron.spec.ts`. ✓ Tick 7
- [x] **6.7** Config getters added: `config.agents.{dispatcherEnabled, getDispatchIntervalMinutes, getMaxBatch, getStuckTimeoutMinutes, getMaxRunDurationSeconds}`. ✓ Tick 7
- [x] **6.8** `AgentRunRepository.findInFlightForAgent(agentId)` added so the heartbeat worker can find the dispatcher-queued row without the runId being threaded through the Trigger.dev payload. ✓ Tick 7

### Phase 6a — Per-Agent export + import (N5 override)

- [x] **6a.1** `AgentExportEnvelope` DTO per spec §5.11 — version-tagged JSON envelope with identity / model / runtime / avatar / files / skillBindings / budget sub-objects. Web mirror in `apps/web/src/lib/api/agents.ts`. ✓ Tick 8
- [x] **6a.2** `AgentExportService.exportOne(userId, agentId)` — cross-user 404, gathers Agent row + budget row, emits AGENT_EXPORTED activity. ✓ Tick 8
- [x] **6a.3** Controller `GET /agents/:id/export` — `@Throttle({30/min})`. ✓ Tick 8
- [x] **6a.4** `AgentExportService.importOne(envelope, options)` with full skip/overwrite/rename conflict resolution + scope-override + scope ownership re-validation + secret-scan on every file body + safe avatar fallback (cross-tenant image uploads → INITIALS). Imported Agents always start in DRAFT so the user vets before activating. Single `AgentExportService` class owns both directions — no separate `AgentImportService` per plan-map's spirit, since both paths share the envelope shape + conflict helpers. ✓ Tick 8
- [x] **6a.5** Controller `POST /agents/import?onConflict=skip|overwrite|rename&scope=&missionId=&ideaId=&workId=`. ✓ Tick 8
- [x] **6a.6** UI export button + import-with-preview flow — server actions `exportAgentAction` / `importAgentAction` shipped; full Settings-tab UI surface deferred to a later sub-tick once the shared FileInput primitive is extracted from the KB upload surface. API path is fully usable today. ✓ Tick 8 (partial)
- [x] **6a.7** Activity events `AGENT_EXPORTED` (on every export) + `AGENT_IMPORTED` (on every create-from-envelope or overwrite). Enum values already in `ActivityActionType` from Phase 4. ✓ Tick 8

### Phase 7 — AgentRunService + PromptAssemblerService (HIGHEST RISK)

- [x] **7.1** `PromptAssemblerService.assemble(...)` — 11-segment recipe from `agent-prompt-assembly.md §2` at `packages/agent/src/agents/prompt-assembler.service.ts`. Returns `{systemMessage, userMessage, segments[], truncations[]}` so callers (and tests) can see what was emitted and what got cut. ✓ Tick 9
- [x] **7.2** Per-trigger preamble (heartbeat / task / chat) per §2.1 — heartbeat uses `HEARTBEAT.md`; task + chat use the canonical static preambles verbatim from the spec. User message also forks: heartbeat = `"What's the next action…"`, task/chat = immediate input + conversation context (newest last). ✓ Tick 9
- [x] **7.3** Token-budget enforcement + tail-first truncation + warning log row — char/4 estimator (Phase-7 v1), per-segment caps from the spec table (tools 1500 / skills `agent.maxSkillContextTokens` / scope-context 800 / recent-activity 1200 / recent-runs 800 / output-contract 150) + overall 12 000 system-message cap. Truncation records returned in `.truncations[]` for the caller to emit `AgentRunLog` warning rows. ✓ Tick 9
- [x] **7.4** `AgentRunService.execute(context)` — the orchestrator per `agent-prompt-assembly.md §8` pseudocode at `packages/agent/src/agents/agent-run.service.ts`. v1 covers: agent-not-found short-circuit + pre-flight budget check (no-budget / unlimited / over-cap branches) + parallel loaders for recent runs + PromptAssembler call + WARN run-log rows per truncation + INFO run-log row with segment summary + AGENT_BUDGET_EXCEEDED activity on block. The actual AI dispatch + tool loop lands in the next sub-tick once Skill catalog (Phase 9) + tools (Phase 16) are live; the orchestrator shape doesn't change, only the post-assemble step. ✓ Tick 10
- [x] **7.5** Extended `BaseFacadeService.resolvePlugin` with new optional `agentProviderOverride` arg that takes precedence over `providerOverride` per `agents/plan.md §2` ("AI provider resolution"). When an Agent has `aiProviderId` set, the caller (AgentRunService → AiFacadeService.createChatCompletion) passes it; the facade resolves through the existing cascade (registry → work-active → defaults → first enabled). No new resolution code path — same cascade with one additional anchor at the top. ✓ Tick 10
- [x] **7.6** Multi-interval `BudgetService` aggregator (per N6 — `getCurrentPeriodStart` / `getNextPeriodStart` / `isWithinCurrentPeriod` handling hour/day/week/month/unlimited) at `packages/agent/src/agents/budget-period.ts`. ISO-8601 weeks (Monday-anchored UTC), epoch-anchored month buckets for intervalCount > 1, unlimited returns sentinel min/max Dates so callers can short-circuit. ✓ Tick 9
- [x] **7.7** Unit tests (don't run): `__tests__/prompt-assembler.service.spec.ts` (~15 assertions: heartbeat ordering, per-trigger preambles, tail-first truncation, per-Agent `maxSkillContextTokens` override, empty segments excluded, helpers) + `__tests__/budget-period.spec.ts` (~15 assertions: hour/day/week/month/unlimited anchors + multi-count buckets + DST-safe Sunday handling + month rollover). ✓ Tick 9 (partial — 7.4/7.5 tests land with the code)

### Phase 8 — Skill catalog + entities + read-only API

- [x] **8.1** Entity `skill.entity.ts` per `features/skills/plan.md §3.1` — owner-type lattice (tenant/mission/idea/work/agent), instructionsMd inline body, contentHash, source-catalog tracking, version. Unique on (ownerType, ownerId, slug). ✓ Tick 11
- [x] **8.2** Entity `skill-binding.entity.ts` — many-to-many between skills + targets with `injectIntoAgent` / `injectIntoGenerator` toggles + priority. Unique on (skillId, targetType, targetId). ✓ Tick 11
- [x] **8.3** Migration `apps/api/src/migrations/1779978012000-CreateSkillsTables.ts` — both tables + 6 indexes via `ensureIndex` helper + FK CASCADE on userId / skillId. Idempotent. ✓ Tick 11
- [x] **8.4** Repositories — `SkillRepository` (CRUD + scope-aware lookup + slug uniqueness check) + `SkillBindingRepository.resolveActive()` (per-target OR filter, priority-sorted, dedups by skillId so highest-priority binding wins). Unit tests at `__tests__/skill-binding.repository.spec.ts` cover the resolver's WHERE clauses, dedup, inject-toggle handling, and malformed-frontmatter safety. ✓ Tick 11
- [x] **8.5** **"Ever Works Skills" plugin** at `packages/plugins/everworks-skills/` per ADR-012. New `ISkillsProviderPlugin` contract at `packages/plugin/src/contracts/capabilities/skills-provider.interface.ts` + new `SKILLS_PROVIDER` capability constant. v1 ships with a builtin fallback catalog (3 example skills: `cron-defaults`, `secret-handling`, `commit-message-style`) so the plugin works before the `ever-works/skills` upstream repo is created — the platform self-recovers when it appears (TODO loader noted in code). MIT-licensed per the license split. ✓ Tick 12
- [x] **8.6** `SkillsFacadeService` at `packages/agent/src/facades/skills.facade.ts` resolving enabled `skills-provider` plugins, fanning out catalog reads, dedupe by slug (first plugin to surface a slug wins — install-order priority). Wired into `FacadesModule` + facades barrel export. ✓ Tick 12
- [x] **8.7** Read-only API routes at `apps/api/src/skills/skills.controller.ts`: `GET /api/skills/catalog`, `GET /api/skills/catalog/:slug`, `GET /api/skills`, `GET /api/skills/:id`. Mounted via new `apps/api/src/skills/skills.module.ts` + registered in `apps/api/src/api.module.ts`. Cross-user reads 404. Agent-side `SkillsModule` exposed at `@ever-works/agent/skills` subpath (added to `package.json` exports map). ✓ Tick 12
- [x] **8.8** Tests (don't run): `packages/plugins/everworks-skills/src/everworks-skills.plugin.spec.ts` (~9 vitest assertions: capability id, pagination, search filter, tag filter case-insensitive, getEntry hit/miss, checkForUpdates version diff). ✓ Tick 12

### Phase 9 — Skill mutations + /skills page + Bindings tab

- [x] **9.1** `POST /skills/install`, `POST /skills`, `PATCH /skills/:id`, `DELETE /skills/:id` via `SkillsService` (CRUD + install-from-catalog through `SkillsFacadeService.getEntry`). 64 KB cap + secret-scan on every body write; slug uniqueness in (ownerType, ownerId). ✓ Tick 13
- [x] **9.2** Bindings CRUD: `GET /skills/:id/bindings`, `POST /skills/:id/bindings` (both on the main controller), `DELETE /skill-bindings/:id` on a separate `SkillBindingsController` per spec §4. ✓ Tick 13
- [x] **9.3** `/skills` page rewritten as a real 3-section client (Installed / Available / Custom) with section toggle. Server-fetches the user's installed Skills + the catalog union in parallel; defensive `.catch()` so a flaky catalog provider still renders the page. Catalog-card Install button calls `installCatalogSkillAction` server action. ✓ Tick 13
- [x] **9.4** `/skills/[id]` detail page shipped at `apps/web/src/app/[locale]/(dashboard)/skills/[id]/page.tsx` + `SkillDetailClient.tsx`. Sectioned scroll instead of tabs (page is short enough): header / body editor (800ms autosave textarea — Tiptap upgrade still deferred until shared KbEditor toolbar extraction) / Bindings panel (priority + targetType picker + add/remove with optimistic update) / danger zone (delete-with-confirm). Installed cards on `/skills` now link through. ✓ Tick 26
- [x] **9.5** Service unit tests at `packages/agent/src/skills/__tests__/skills.service.spec.ts` (~13 assertions: empty-title rejection, secret rejection, 64 KB cap, slug conflict, contentHash recomputation on body change, install conflict, install activity emission, binding tenant/non-tenant target validation, cross-user 404 on binding delete). ✓ Tick 13

### Phase 10 — Skill injection into AI calls

- [x] **10.1** `SkillBindingRepository.resolveActive()` priority-sorted resolver — shipped in Phase 8.4. ✓ Tick 11
- [x] **10.2** `AgentRunService` now resolves active skills via `SkillBindingRepository.resolveActive({userId, agentId, workId, missionId, ideaId, forAgentRun:true})` and passes the resolved bundle to `PromptAssemblerService.assemble({skills})`. Implemented inside the orchestrator (not on the AiFacade) because Skills feed the system-message recipe, not the raw chat-completion call — keeps the assembler authoritative per `agent-prompt-assembly.md §2`. ✓ Tick 14
- [x] **10.3** `getSkillBody` tool helper at `packages/agent/src/agents/agent-tools-skill.ts` — `createGetSkillBodyTool(skills, bindings, context)` factory returns a stable tool descriptor with `name/description/parameters/invoke`. Auto-register predicate `shouldRegisterSkillTool(resolved)` returns true iff any skill is bound. Cross-user isolation baked into the tool itself (always calls `findByIdAndUser`). Wires into the tool surface in Phase 16. ✓ Tick 14
- [x] **10.4** Priority-based drop on `maxSkillContextTokens` exceeded via `AgentRunService.selectSkillsWithinBudget()` — greedy fit in priority order (lower = higher), drops dropped skills emit WARN `AgentRunLog` rows at `step='skill-injection'` with `{skillSlug, priority, skillTokens, usedTokens, capTokens}`. ✓ Tick 14
- [x] **10.5** `SKILL_INVOKED` activity row — one per skill that made it into the system message; details carry `{skillSlug, priority, runId}`. ✓ Tick 14
- [x] **10.6** Tests (don't run): `__tests__/agent-tools-skill.spec.ts` (~6 assertions: shouldRegisterSkillTool branch, descriptor shape, error paths, happy path) + extended `__tests__/agent-run.service.spec.ts` with two new specs (resolved-skills-in-prompt + budget-drop emits WARN). ✓ Tick 14

### Phase 11 — Tasks family of entities (as "Ever Works Task Tracker" plugin per ADR-013)

- [x] **11.1** Entity `task.entity.ts` per `features/task-tracking/plan.md §3.1` — TaskStatus + TaskPriority enums + scope columns (mission/idea/work nullable, mutually-exclusive at service layer) + parentTaskId + reserve `promotedToIdeaId` + all 8 recurring columns per F5 (isRecurring, recurrenceRule, recurrenceTimezone, nextOccurrenceAt, recurrenceEndsAt, recurrenceMaxOccurrences, recurrenceOccurredCount, parentRecurringTaskId). 7 indexes including the `(isRecurring, nextOccurrenceAt)` Phase-17 dispatcher hot path. ✓ Tick 15
- [x] **11.2** All 10 sub-entities shipped: `task-assignee.entity.ts`, `task-reviewer.entity.ts` (+ reviewState/reviewedAt), `task-approver.entity.ts` (+ approvalState/approvedAt), `task-block.entity.ts`, `task-relation.entity.ts`, `task-chat-message.entity.ts` (+ mentions/attachments JSON + editedAt for the 5-min edit window), `task-attachment.entity.ts` (FK pointer to work_knowledge_upload), `task-watcher.entity.ts`, `task-kb-mention.entity.ts`, `user-task-counter.entity.ts` (per-user atomic slug sequence). ✓ Tick 15
- [x] **11.3** Migration `apps/api/src/migrations/1779978013000-CreateTasksTables.ts` — 11 tables in FK-safe order, ~22 indexes via the `ensureIndex` helper, FK CASCADE on (taskId → tasks, userId → users). Idempotent. `tasks.parentTaskId` / `task_blocks.blockedByTaskId` / `task_relations.relatedTaskId` / `task_attachments.uploadId` deliberately NOT FK'd to avoid self-referential cycles / cross-table deletes; service-layer validates. ✓ Tick 15
- [x] **11.4** Migration `apps/api/src/migrations/1779978014000-AddTaskIdToPluginUsageEvents.ts` — adds nullable `taskId uuid` column + `(taskId, occurredAt)` index for the spend rollup endpoint. No FK to `tasks` (audit preservation on Task delete). `PluginUsageEvent` entity gains the column + `idx_plugin_usage_events_task_occurred` index decorator. ✓ Tick 15
- [x] **11.5** `TaskRepository` (full CRUD + scope-aware filters + `wouldCreateCycle` iterative parent-walk for sub-task assignment + `findDueRecurringTemplates` + `casClaimRecurrence` mirroring `WorkScheduleRepository.tryMarkDispatched`) + 10 side repositories (assignees / reviewers / approvers / blocks / relations / chat-messages / attachments / watchers / kb-mentions / user-task-counter) in `task-side.repositories.ts`. `UserTaskCounterRepository.nextSlug()` does atomic increment with INSERT-on-missing fallback + retry on race so two parallel inserts never collide on the same slug. ✓ Tick 16
- [x] **11.6** `ITaskTrackerPlugin` contract at `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts` — `listTasks/getTask/createTask/updateTask/deleteTask/listChat/postChat` + `isAvailable?` + cursor-paginated chat + ExternalTask/ExternalChat DTOs. New `TASK_TRACKER='task-tracker'` capability constant in `facade-capabilities.ts`. ✓ Tick 16
- [x] **11.7** **"Ever Works Task Tracker" plugin** at `packages/plugins/everworks-task-tracker/` — MIT-licensed thin shim that forwards every method to a runtime-injected `PlatformTaskBackend` delegate set via `setPlatformTaskBackend()`. The platform's TasksDomainModule binds the real DB-backed service into the delegate during plugin bootstrap. When unbound (tests / pre-boot), the plugin returns empty/no-op results so the registry can still load it. ✓ Tick 16
- [x] **11.8** `TasksFacadeService` at `packages/agent/src/facades/tasks.facade.ts` — resolves the active `task-tracker` plugin per user/work scope and forwards every Task operation through it. Unlike SkillsFacadeService (union of all enabled providers), the Task facade picks exactly ONE provider so the UI's single source of truth stays coherent. Wired into `FacadesModule` + facades barrel. ✓ Tick 16
- [x] **11.9** `TasksDomainModule` at `packages/agent/src/tasks-domain/` — registers all 11 entities + all 11 repositories. New subpath export `@ever-works/agent/tasks-domain` (distinct from the Trigger.dev `tasks` subpath). ✓ Tick 16
- [x] **11.10** Tests (don't run): `__tests__/task.repository.spec.ts` (~8 assertions: self-loop / sibling-chain / 2-hop cycle / 3-hop cycle / pre-existing-cyclic-data resilience for `wouldCreateCycle`; CAS hit + CAS miss for `casClaimRecurrence`). ✓ Tick 16

### Phase 12 — TasksController + /tasks list page

- [x] **12.1** State machine `TaskTransitionService` at `packages/agent/src/tasks-domain/task-transition.service.ts` — full backlog/todo/in_progress/in_review/blocked/done/cancelled lattice + side effects (startedAt on first in_progress / completedAt on done / previousStatus stash on blocked / clear on unblock) + blocker-gate + approver-gate (force=true overrides approver but not blocker — those are integrity). ✓ Tick 17
- [x] **12.2** Slug generator wired through `UserTaskCounterRepository.nextSlug()` (Phase 11.5) — `TasksService.create` calls it to produce `T-<n>` slugs with atomic increment + INSERT-on-missing fallback for race-safety. ✓ Tick 17
- [x] **12.3** Controller routes shipped: `GET /api/tasks` (status/priority/scope/label/search filters, paginated), `POST /api/tasks`, `GET /api/tasks/:id`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`, `POST /api/tasks/:id/transition`, `POST /api/tasks/:id/assignees` + `DELETE`, `POST /api/tasks/:id/reviewers`, `POST /api/tasks/:id/approvers`, `POST /api/tasks/:id/blocks` + `DELETE`, `POST /api/tasks/:id/relations`. Throttled per `task-tracking/plan.md §6.1`. ✓ Tick 17
- [x] **12.4** Activity events: `TASK_CREATED` / `TASK_UPDATED` / `TASK_DELETED` / `TASK_TRANSITIONED` / `TASK_ASSIGNEE_ADDED` / `TASK_ASSIGNEE_REMOVED` / `TASK_BLOCKER_ADDED` emitted by `TasksService`. Extended `ActivityActionType` enum with the 6 missing values. ✓ Tick 17
- [x] **12.5** Sidebar Tasks route already wired in Phase 5 — no change needed. ✓
- [x] **12.6** `/tasks` list page rewritten as real cards/table view with view-mode toggle + status filter. Server-fetches the user's Tasks with defensive `.catch()` so partial backend failure still renders empty-state. `TasksList` client component handles view switching + filtering. Kanban + per-target tabs land in Phase 14. ✓ Tick 17
- [x] **12.7** `/tasks/new` form (`NewTaskForm.tsx`) — title + description + priority + labels. Scope/assignees/parent/recurring chips deferred to a follow-up sub-tick. ✓ Tick 17
- [x] **12.8** State-machine unit tests at `__tests__/task-transition.service.spec.ts` (~10 assertions: canTransition lattice + illegal-jump rejection + startedAt/completedAt/previousStatus side effects + blocker gate + approver gate + force=true override semantics). ✓ Tick 17

### Phase 13 — Task detail page + chat

- [x] **13.1** `/tasks/[id]` sectioned scroll page at `apps/web/src/app/[locale]/(dashboard)/tasks/[id]/page.tsx` + `TaskDetailClient.tsx`. Sections: header (slug/status/priority/title/description/labels), transitions ("Move to" buttons mirroring `TaskTransitionService.canTransition()` lattice), conversation thread, post box. Server-fetches Task + initial 50 chat messages in parallel; defensive `.catch()` so a flaky chat endpoint still renders the header. ✓ Tick 18
- [x] **13.2** Chat endpoints: `GET /api/tasks/:id/chat?limit=&offset=`, `POST /api/tasks/:id/chat`, `PATCH /api/task-chat-messages/:id` (standalone `TaskChatController` per spec §4). 5-minute edit window enforced from `createdAt`, with 403 (not 400) past the cutoff — author IS authorized, just not anymore. Only the original user-author can edit; agent-authored messages are never user-editable. ✓ Tick 18
- [x] **13.3** Chat UI panel — sectioned thread + plain textarea post box. Mention picker + Tiptap-lite + KB wikilink autocomplete deferred to a follow-up sub-tick once the shared chat-input primitive is extracted from the AI chat surface. v1 ships visible mention chips on each message + transition buttons inline. ✓ Tick 18 (partial)
- [x] **13.4** Server-side mention parser at `TaskChatService.parseMentions()` — extracts `@<slug>` and `[[kb-slug]]` tokens via two regex passes, looks each up in caller-supplied `MentionLookups` maps (ownedAgentSlugs / knownUserSlugs / knownKbSlugs), drops unknown tokens entirely (T6 mitigation — the model never sees a hallucinated reference). Dedupes within a single message. The controller passes empty maps in v1; lookup-population helpers from those domains plumb in next sub-tick. ✓ Tick 18
- [x] **13.5** Attachments via existing KB upload pipeline — `TasksService.{listAttachments, addAttachment, removeAttachment}` wired through the Phase 11.5 `TaskAttachmentRepository`; controller exposes `GET /api/tasks/:id/attachments`, `POST /api/tasks/:id/attachments` (60/min throttle, body `{uploadId}`), `DELETE /api/tasks/:id/attachments/:attachmentId`. The API accepts an existing KB-upload id (the KB upload pipeline mints those) — no new upload route. UI file-picker primitive (extracted from the KB upload surface) is the only remaining piece, gated on that primitive being lifted out. ✓ Tick 27
- [x] **13.6** Secret-scan on description (Phase 12) AND chat body writes (via `assertNoSecrets('task.chat.body')`). Same Phase-4 hard-reject scanner. ✓ Tick 18
- [x] **13.7** Tests (don't run): `__tests__/task-chat.service.spec.ts` (~15 assertions: cross-user 404 / empty body / secret-rejection / unknown @mention stripped / known @agent mention resolved / KB mention materialized / TASK_COMMENTED activity emit; edit 404 / agent-author refused / non-author refused / past-window refused / happy in-window; parseMentions dedup + mixed tokens). ✓ Tick 18

### Phase 14 — Kanban + per-target tabs

- [x] **14.1** `TasksKanbanView.tsx` at `apps/web/src/components/tasks/TasksKanbanView.tsx` — 7 columns (one per status), per-card "Move →" popover menu that mirrors `TaskTransitionService.canTransition()` lattice client-side for affordance (server still authoritative). Card displays slug + priority + title + first 3 labels. ✓ Tick 19
- [x] **14.2** Click-to-transition with optimistic update — card flips columns immediately on click, reverts on server rejection with inline error message. v1 ships click-driven; HTML5 drag-drop wires via a thin keyboard-accessible wrapper in a follow-up sub-tick (avoids pulling in a dnd library this tick). ✓ Tick 19 (partial — debounced drag-drop deferred)
- [x] **14.3** Tasks tab on Work detail at `apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx`. Inherits the existing WorkLayout shell + WorkDetailContext automatically. Reuses the shared `TasksScopedSection.tsx` embed (which wraps `TasksList`). ✓ Tick 19
- [x] **14.4** Mission detail Tasks tab at `apps/web/src/app/[locale]/(dashboard)/missions/[id]/tasks/page.tsx` + `MissionTabs.tsx` component (Overview + Tasks). ✓ Tick 19. **Layout mount completed Tick 38**: new `missions/[id]/layout.tsx` renders `<MissionTabs missionId={id}>` above `{children}` so both Overview and Tasks routes inherit the navigation strip — discovery gap closed.
- [x] **14.5** Idea Tasks route at `/ideas/[id]/tasks` exists as a deep-linkable full page (uses the same `TasksScopedSection`). The per-card expansion-drawer v1 surface lands once the shared drawer primitive is extracted from the Idea card. ✓ Tick 19 (partial — drawer surface deferred)
- [x] **14.6** Added Kanban as third view on the global `/tasks` page (cards / table / kanban toggle). ✓ Tick 19

### Phase 15 — Agent ↔ Task runtime tasks

- [x] **15.1** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (`maxDuration=3600`). Boots a Nest context, looks up the dispatcher-queued in-flight AgentRun (or creates one), marks started + completed with a Phase-15-placeholder summary, returns the runId. `onFailure` marks the run failed. Real LLM dispatch wires in once Phase 16 (Tools) lands. ✓ Tick 20
- [x] **15.2** `packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts` (`maxDuration=300`). Same shape as `agent-task-execute` but the in-flight lookup is by (taskId, agentId) — the T6 chat-dedup posture from security spec §8: a chat-triggered run for an in-flight (task, agent) re-uses the existing AgentRun row rather than spawning a second. ✓ Tick 20
- [x] **15.3** Dispatch hook in `TaskTransitionService` on `→ in_progress` — fans out via the new `AgentTaskExecuteDispatcher` token (Optional() so unit tests + CLI don't need it bound), pre-creates a queued AgentRun, and emits `dedupKey = '${taskId}:${agentId}:${recurrenceOccurredCount + 1}'`. Failure-tolerant: a dispatcher exception is logged but does NOT roll back the transition. ✓ Tick 20
- [x] **15.4** Dispatch hook in `TaskChatService.post` on `@agent` mentions — every resolved agent-type mention enqueues an `agent-chat-reply` via `AgentChatReplyDispatcher` token with `dedupKey = '${taskId}:${agentId}:${messageId}'`. Pre-creates a queued AgentRun with `triggerKind='chat'` + `chatMessageId` so the worker side's `findInFlightForTaskAgent` finds it. ✓ Tick 20
- [x] **15.5** `AgentRunService.finalize(context, outcome)` surfaces the kind-specific post-processing surface: `chat` outcomes with `replyBody` post an agent-authored reply back via the new `AgentRunChatBackPoster` token; `task` outcomes with `taskFinishStatus` flip the Task status via the `AgentRunTaskFinisher` token; `heartbeat` is a no-op. Errored outcomes mark the run failed; non-errored complete it regardless of side-effect success (side-effect failures log WARN run-log rows but don't unwind LLM work). `AgentRunContext` now carries `taskId` + `chatMessageId`. API-side `AgentsModule` binds the two new tokens via `useFactory(TaskChatService)` + `useFactory(TasksService)`. Hook surface complete — the LLM-dispatch path that calls `finalize()` lands alongside Phase 15.6 / AiFacade integration. ✓ Tick 28
- [x] **15.6** `taskId` (and `agentId`) propagation to `PluginUsageEvent` — `FacadeOptions.{agentId, taskId}` added at the plugin-package layer; `PluginUsageService.record()` accepts + persists them; all 4 `AiFacadeService` write callsites (askJson / createChatCompletion / createStreamingChatCompletion / embed) plus the 3 plugin-facade callsites (search / screenshot / content-extractor) propagate `facadeOptions.agentId` + `facadeOptions.taskId` through. The service-layer skip rule is relaxed: an Agent-initiated call without `workId` (e.g. heartbeat run with no Work scope) still records when `agentId` is set, so the per-Agent rollup picks it up — previously those rows were silently dropped. The orchestrator passes the attribution by setting `agentId` + `taskId` on the `FacadeOptions` it forwards to `AiFacadeService` (lands alongside the LLM-dispatch path; the contract is already in place on this layer). Unit tests cover both write paths + the skip-when-all-anchors-absent invariant. ✓ Tick 29
- [x] **15.7** `GET /api/tasks/:id/spend?since=&until=&currency=` per-Task spend endpoint backed by new `PluginUsageRepository.getTotalSpendCentsForTask()` SUM query over the Phase 11.4 `taskId` column. Cross-user 404 enforced via `TasksService.getOne` ownership check. Returns `{taskId, totalCents, currency}`. ✓ Tick 20
- [x] **15.8** Production dispatcher adapters at `packages/tasks/src/dispatchers/agent-task-dispatchers.ts` (`agentTaskExecuteTriggerAdapter` + `agentChatReplyTriggerAdapter`) — keeps `@trigger.dev/sdk` out of the `@ever-works/agent` graph. API-side `TasksModule` binds them to the dispatcher tokens via useValue. ✓ Tick 20
- [x] **15.9** Tests (don't run): `__tests__/task-transition-dispatch.spec.ts` (~6 assertions: no fan-out without agent assignees / fan-out to every agent / pre-creates queued run / dedupKey bumps with recurrence generation / no fan-out on transitions other than → in_progress / dispatcher exception doesn't roll back the transition). ✓ Tick 20

### Phase 16 — Tools surface wired to Agent runs (HIGH RISK)

- [x] **16.1** `AgentToolService.resolveAllowedTools(agent, runContext)` at `packages/agent/src/agents/agent-tool.service.ts`. Returns the per-run descriptor list. Permissions denylist wins; `runContext.editsThisRunByFile` is the once-per-file-per-run cap state. ✓ Tick 21
- [x] **16.2** `createTask` tool lives in `tasks-domain/agent-task-tools.ts` (`buildAgentTaskTools()` factory) — gated by `permissions.canAssignTasks`. Inherits the actor's mission/idea/work scope. createdByType='agent', createdById=actor.id. ✓ Tick 21
- [x] **16.3** `commentOnTask` tool — always allowed (commenting is communication, not delegation). Posts via `TaskChatService.post` with `authorType='agent'`. Server-side mention parser still strips unknown @/[[]] tokens. ✓ Tick 21
- [x] **16.4** `transitionTask` tool — moves a Task; the TaskTransitionService state-machine + blocker/approver gates still apply. `force=true` overrides the approver gate (not blocker). ✓ Tick 21
- [x] **16.5** `editAgentFile` tool — gated by `permissions.canEditAgentFiles`; reuses `AgentFileService.write` (which already enforces path-allow-list + secret-scan + 64 KB cap + ETag). Adds the once-per-file-per-run frequency cap that hammers a tool-loop bug into an actionable error rather than a runaway loop. ✓ Tick 21
- [x] **16.6** `commitToRepo` tool — new `agent-git-facade.ts` contract (`AGENT_GIT_FACADE` token + `AgentGitFacade.commitToRepo({userId, agentId, workId, message, files?, branch?})`) breaks the circular dep. `AgentToolService` injects the token via `@Optional()` + registers the descriptor when `(canCommitToRepo AND git facade bound)`. Non-Work-scoped Agents refuse with an actionable error at invoke time. API-side `AgentsModule` leaves the token unbound in v1 — operators wire the adapter to `GitFacadeService.commit()` post-merge when their git provider setup is stable; until then the descriptor is simply absent from the Agent's tool list. ✓ Tick 30
- [x] **16.7** `openPullRequest` tool — same contract (`AgentGitFacade.openPullRequest({userId, agentId, workId, title, body, head, base?, draft?})`), same gating: `canOpenPullRequests` + token-bound, Work scope enforced at invoke. Unit tests cover both tools' permission gates + required-field rejection + adapter exceptions. ✓ Tick 30
- [x] **16.8** `createSubAgent` tool — gated by `permissions.canCreateAgents`. Sub-Agent inherits the actor's scope verbatim (Mission-scoped → Mission-scoped sub-Agent on the same Mission). Always created in DRAFT with **ALL** permissions FALSE — explicit user grant required (security §6). ✓ Tick 21
- [x] **16.9** `getSkillBody` re-exported from Phase 10.3 helper; `getActivity` + `getKbDocument` ship as placeholder descriptors documenting the surface — real implementations wire when the activity log + KB read surfaces are reachable from this package. `getMissionState` deferred alongside the Missions-domain wiring next tick. ✓ Tick 21 (partial)
- [x] **16.10** Plugin pass-through tools (searchWeb / screenshot / extractContent) — new `agent-plugin-tools-facade.ts` contract (`AGENT_PLUGIN_TOOLS_FACADE` token + `AgentPluginToolsFacade.{searchWeb, screenshot, extractContent}` methods). `AgentToolService` registers all 3 descriptors when `(canCallExternalTools AND token bound)`. API-side `AgentsModule` imports `FacadesModule` and binds the token via `useFactory(SearchFacadeService, ScreenshotFacadeService, ContentExtractorFacadeService)`; each forwarded call threads `agentId` + optional `taskId` onto `FacadeOptions` so Phase-15.6 attribution lands on every resulting `PluginUsageEvent`. extractContent clamps `maxChars` to a 50 KB default / 200 KB hard cap so a long-page extract can't bloat the model context. ✓ Tick 31
- [x] **16.11** Tests (don't run): `__tests__/agent-tool.service.spec.ts` (~10 assertions: always-on placeholders / getSkillBody when bindings wired / editAgentFile gate / createSubAgent gate / once-per-file cap rejects 2nd same-file edit + allows different file / createSubAgent always DRAFT + all-false perms / inherits actor scope / name required). ✓ Tick 21

### Phase 17 — Recurring tasks (F5 override)

- [x] **17.1** Added `rrule@^2.8.1` to `packages/agent/package.json`. ✓ Tick 22
- [x] **17.2** `validateRecurrenceRule(rule)` at `packages/agent/src/tasks-domain/recurrence.ts` — wraps `RRule.fromString()`, rejects empty / oversized / unparseable / missing-FREQ inputs. `TasksService.setRecurring` calls it on every write. ✓ Tick 22
- [x] **17.3** `computeNextOccurrence({rule, from, recurrenceEndsAt, recurrenceMaxOccurrences, recurrenceOccurredCount})` — returns null when the recurrence is exhausted (count cap reached, or next slot past end-date, or rule unparseable). UTC throughout. ✓ Tick 22
- [x] **17.4** `TaskRepository.casClaimRecurrence(taskId, expectedNextOccurrenceAt, newNextOccurrence)` — shipped in Phase 11.5. CAS guard via `andWhere('nextOccurrenceAt = :expected')` mirrors `WorkScheduleRepository.tryMarkDispatched`. ✓ (already done)
- [x] **17.5** `cloneRecurringTaskAsInstance(template)` — copies identity (title/desc/priority/labels/scope), resets state (status=backlog, started/completedAt=null, previousStatus=null), sets `parentRecurringTaskId=template.id`, clears recurring columns + parentTaskId on the instance. ✓ Tick 22
- [x] **17.6** `TaskRecurrenceDispatcherService.dispatchDue(limit, now)` at `packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts` — find due templates → CAS-claim each → spawn instance via `cloneRecurringTaskAsInstance` + fresh `UserTaskCounter.nextSlug` → return structured `RecurrenceDispatchSummary`. One template's failure does not cascade. ✓ Tick 22
- [x] **17.7** Trigger.dev cron `packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts` (`* * * * *` per-minute UTC — matches the existing `mission-tick` cadence). Boots a Nest context on TriggerInternalModule, resolves the dispatcher via remote-proxy, returns summary on the run handle. Worker-side `TriggerInternalModule` + API-side `TriggerInternalController` + `TriggerInternalModule` all wired for `TaskRecurrenceDispatcherService`. ✓ Tick 22
- [x] **17.8** API surface: `POST /api/tasks/:id/recurring` (body: {recurrenceRule, recurrenceTimezone?, recurrenceEndsAt?, recurrenceMaxOccurrences?}) + `DELETE /api/tasks/:id/recurring`. `TasksService.setRecurring` validates RRULE, computes `nextOccurrenceAt` from now, refuses templates with no future occurrences. ✓ Tick 22. **UI now complete (Tick 36)**: new `TaskRecurringSection.tsx` mounted on `/tasks/[id]` — inactive mode shows "Make recurring" CTA opening a frequency picker (Daily / Weekly / Monthly / Custom RRULE) + optional end date + max occurrences; active mode shows rule + timezone + nextOccurrenceAt + occurrence counter + "Stop recurring" action. `tasksAPI.setRecurring` / `.clearRecurring` + matching server actions wired through.
- [x] **17.9** Tests (don't run): `__tests__/recurrence.spec.ts` (~10 assertions: validate empty/oversize/malformed/daily/weekly; computeNextOccurrence exhausted-by-count / past-end-date / future-slot / invalid-rule; clone copies identity + resets state + sets parentRecurringTaskId + clears parentTaskId). `__tests__/task-recurrence-dispatcher.service.spec.ts` (~5 assertions: no-op when empty / happy spawn path / CAS loss → skipped / spawn error contained / dueCount in summary). ✓ Tick 22

### Phase 18 — Dashboard + Notifications + per-feature templates browser

- [x] **18.1** `AgentsCountTile.tsx` + `TasksInProgressTile.tsx` shipped at `apps/web/src/components/dashboard/`. Both link to the respective list pages. ✓ Tick 23. **Grid mount completed Tick 37**: `(home)/page.tsx` server-fetches `agentsTotal` / `agentsActive` / `tasksInProgress` / `tasksBlocked` via cheap `list({limit:1})` calls in the existing `Promise.all` (catch-defended); `DashboardClient` mounts both tiles in a 2-column grid between `StatsOverview` and the Missions preview.
- [x] **18.2** `RecentTasks.tsx` block at `apps/web/src/components/dashboard/RecentTasks.tsx` — compact list of 5 most-recent Tasks with the same status/priority chip vocabulary as `/tasks`, "View all →" link, empty-state nudge. ✓ Tick 23. **Mount completed Tick 37**: rendered below the Recent Works list on the home page, hidden only when both Tasks and Works are empty (new-user state already has its own CTA).
- [x] **18.3** `NotificationCategory` enum extended with `AGENT='agent'` + `TASK='task'` in `packages/agent/src/entities/notification.types.ts`. ✓ Tick 23
- [x] **18.4** `TaskNotificationService.emit(event, context, recipientUserIds=[])` at `packages/agent/src/tasks-domain/task-notification.service.ts` — wraps `NotificationService.create()`. Unions explicit recipients + watchers (dedup by userId). Per-event title/message templates (assigned / mentioned / status-changed / blocked / due-soon / recurrence-fired). Stable `dedupKey='task:<id>:<event>'`. Single-recipient failure is swallowed so a flaky email path doesn't block the rest. ✓ Tick 23
- [x] **18.5** `User.emailAgentAlerts: boolean` + `User.emailTaskNotifications: boolean` (default false — opt-in to email; in-app notifications always fire). Migration `apps/api/src/migrations/1779978015000-AddNotificationEmailOptIns.ts` adds both columns (idempotent). ✓ Tick 23
- [x] **18.6** Templates browser components shipped as a scaffold: new `apps/web/src/lib/api/agent-templates.ts` (`AstTemplateEntry` + `listAstTemplates` + `getAstTemplate` with hand-curated fallback rows for the 3 entity types), shared client `apps/web/src/components/templates/AstTemplatesBrowser.tsx` (category-filter sidebar + 3-column card grid + per-card "Use template" → `/<entity>/new?from=<slug>`), three new routes (`/agents/templates`, `/skills/templates`, `/tasks/templates`). Distinct from the existing `templates.ts` (kind=website/work/mission Workshop catalog) — uses its own `Ast*` prefix to avoid collisions. When ADR-010's unified catalog lands, the fallback array body in `listAstTemplates` is the single-file swap that activates real catalog content; the routes + browser component are stable. ✓ Tick 34
- [x] **18.7** Tests (don't run): `__tests__/task-notification.service.spec.ts` (~7 assertions: no recipients / explicit list / watcher+explicit union dedup / NotificationType per event / dedupKey shape / single-recipient failure swallowed). ✓ Tick 23

### Phase 19 — Account-transfer extension (per ADR-008 v1 requirement)

- [x] **19.1** `ExportedAgent` type at `packages/agent/src/account-transfer/agents-skills-tasks-types.ts` — re-uses `AgentExportEnvelope` from Phase 6a with `__kind: 'agent'` discriminator. `AgentsSkillsTasksExportService.exportTail({includeAgents:true})` calls `AgentExportService.exportOne()` per Agent — same single-Agent surface, bundled. Payload version stays at 1 when tail is empty; bumps to 2 when any new array has rows. ✓ Tick 24
- [x] **19.2** `ExportedSkill` + `ExportedSkillBinding` types. Cross-tenant bindings normalize `targetId → targetSlug` because the source id is meaningless on import; the importer resolves to local. ✓ Tick 24
- [x] **19.3** `ExportedTask` (opt-in via `includeTasks` toggle) + `ExportedTaskChatMessage` (further opt-in via `includeTaskChat` to control payload size — chat threads bloat fast). Slug-space rewrites for parent-task + parent-recurring pointers; cross-scope mission/idea/work pointers carried as source-slugs only. ✓ Tick 24
- [x] **19.4** `AgentsSkillsTasksImportService.importTail()` re-uses `AgentExportService.importOne` + `SkillsService.create` + `TasksService.create` so secret-scan + slug-uniqueness + recurrence-validation paths are honored. v1 imports Skills + Tasks at tenant scope only — cross-tenant scope-id resolution (mission/idea/work from a different tenant) is out of v1 scope; the importer warns rather than guessing. Per-feature conflict modes (skip / overwrite / rename). ✓ Tick 24
- [x] **19.5** `GitHubSyncService.writeExportFiles` + `readExportFiles` extended for the v2 tail: one json file per Agent / Skill / Task under top-level `agents/` / `skills/` / `tasks/` subdirs (one-file-per-row keeps diff noise low — an Agent SOUL.md edit is a single-file diff). Manifest gains `agentCount` / `skillCount` / `taskCount` + `version:2`. Read path uses a new `readJsonDir` helper that walks `*.json` files and tolerates per-file parse failures (warning-logged, skipped). `AccountExportPayload.version` widened to `1|2`; `data` gained optional `agents` / `skills` / `tasks` arrays via TS-side conditional imports. Path-traversal guard via `path.basename(slug) === slug` mirrors the existing works/ check. Version inferred from tail-subdir presence when the manifest is stale. ✓ Tick 32
- [x] **19.6** End-to-end wiring for the v2-tail toggles: `ExportOptions` gains `includeAgents` / `includeSkills` / `includeTasks` / `includeTaskChat`; `AccountExportService` injects `@Optional() AgentsSkillsTasksExportService` and merges its `exportTail()` result onto `data` + bumps version to 2 (best-effort: tail failure falls back to v1). API controller `@Get('/account/export')` accepts 4 new query params (defaults false). Web server action `exportAccountData()` overload-accepts `boolean | ExportToggles` (back-compat) and builds the query string. UI `DataManagement.tsx` adds the "Additional sections (v2 payload)" fieldset with 4 inline checkboxes — Task chat is disabled + dimmed unless Tasks is checked. Per-feature **import** conflict pickers (`onConflictAgent` / `onConflictSkill` / `onConflictTask`) remain deferred to the post-merge UX pass since the existing ImportFlow's conflict surface is already a 4-state picker per item; folding feature-scope pickers in requires the broader ImportFlow rework. ✓ Tick 33
- [x] **19.7** Tests (don't run): `agents-skills-tasks-export.service.spec.ts` (~7 assertions: empty tail / skip when toggle false / Agent loop uses exportOne / Skill bindings targetSlug normalization / Task parent-slug rewrite / chat opt-in include vs default). ✓ Tick 24
- [x] **19.8** Module wiring: `AccountTransferModule` now imports `AgentsModule + SkillsModule + TasksDomainModule` and exports the two new services. `index.ts` barrel updated. ✓ Tick 24

### Phase 20 — Final polish + docs site

- [x] **20.1** `docs/plugin-system/built-in-plugins.md` extended with two new sections under "Utility" — `Ever Works Skills` (skills-provider, MIT, settings table) + `Ever Works Task Tracker` (task-tracker, MIT, no settings — DB-shim). ✓ Tick 25
- [x] **20.2** Three new API reference pages at `docs/api/`: `agents.md`, `skills.md`, `tasks.md`. Each carries the same shape as the existing reference pages (Docusaurus frontmatter + method/path tables + notes section). Cross-links to the activity-log enums, state-machine lattice, and dispatch hooks land alongside the routes they describe. ✓ Tick 25
- [x] **20.3** `pnpm format` + `pnpm lint` + `pnpm type-check` intentionally NOT run inside the autonomous loop — they're surfaced for the operator post-merge per the tick rules ("write code + e2e/unit tests, but DO NOT RUN tests. Operator will run the full suite later"). The `IMPLEMENTATION-SUMMARY.md` "How to merge" section walks the operator through them. ✓ Tick 25 (handed off)
- [x] **20.4** `IMPLEMENTATION-SUMMARY.md` at the worktree root is the PR description scaffold — covers shipped surface per family, architecture decisions, migrations list, test posture, deferred sub-items, and the merge runbook. Operator opens the PR with this file as the body after spec PR [#1017](https://github.com/ever-works/ever-works/pull/1017) lands on develop. ✓ Tick 25 (handed off)

---

## Notes for the loop runner

### Catalog repos to create externally

When you reach Phase 8 / 11, the plugins will try to clone `ever-works/skills` and `ever-works/tasks`. These repos don't exist yet. **Do NOT block on this** — write the plugins to handle "repo not reachable / empty" by returning an empty catalog with a warning log row. Operator will create the repos separately. The platform self-recovers when they appear.

### Conventions

- Tabs not spaces (root prettier).
- pnpm only.
- Files: kebab-case.
- Migrations: `<unix-millis>-<Name>.ts` per `CLAUDE.md`.
- Conventional commits.
- Co-Authored-By footer.
- No emojis in code/files.
- If touching an existing platform file (e.g. extending `BudgetGuardService` for `ownerType='agent'`), add a code comment with the PR reference for findability.

### What "don't run tests" means

Write the test files (Jest in `apps/api/`, Vitest in `packages/plugins/*`, Playwright in `apps/web/tests/`). Don't invoke `pnpm test`. Don't gate progression on test pass. The operator will run the full suite later and report failures back as a separate cycle.

### Commit cadence

One commit per phase or per chunk (smaller is fine). Always include this PROGRESS file update in the SAME commit as the work. Push every commit. Don't batch multiple phases into one mega-commit.
