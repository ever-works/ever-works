# Agents / Skills / Tasks — Implementation Progress

**Branch**: `feat/agents-skills-tasks-impl` off `origin/develop`
**Worktree**: `C:/Coding/Worktrees/wt-agents-skills-tasks-impl`
**Started**: 2026-05-25
**Mode**: autonomous overnight `/loop` — 15 min ticks; no human in the loop until done.

This file is the source of truth for "where are we in implementation." **Every tick reads it first, updates it last, and commits both code + this file in the same commit.** That way a tick that crashes mid-way leaves the progress unchanged and the next tick retries cleanly.

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

- **Last tick #**: 17
- **Last tick at**: 2026-05-26 (tick 17 — Phase 12 complete: TaskTransitionService state machine + TasksService (CRUD + slug gen + activity events) + TasksController + 6 task activity-enum values + agent-side module wiring + API-side module + api.module registration + real /tasks list page (cards+table view toggle + status filter) + /tasks/new form + tasks API client + server actions + state-machine tests.)
- **In progress now**: (none — next tick picks up Phase 13 Task detail page + chat)

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
- [ ] **9.4** `/skills/[id]` Body + Bindings tabs — page route + server actions exist; full Tiptap-body + bindings UI deferred to a later sub-tick once the shared KbEditor toolbar is extracted.
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

- [ ] **13.1** `/tasks/[id]` page (header + sidebar + sections).
- [ ] **13.2** Chat endpoints + 5-min edit window enforcement.
- [ ] **13.3** Chat UI panel (Tiptap-lite + mention picker + KB wikilink).
- [ ] **13.4** Mention parser (server-side validates against user's owned Agents/users; strips unknown).
- [ ] **13.5** Attachments via existing KB upload pipeline.
- [ ] **13.6** Secret-scan on description + chat body writes.

### Phase 14 — Kanban + per-target tabs

- [ ] **14.1** `TasksKanbanView.tsx` adapted from `WorksKanbanView.tsx`.
- [ ] **14.2** Drag-drop status transitions (debounced 250ms PATCH).
- [ ] **14.3** Tasks tab on Work detail (extends `WorkTabs.tsx`).
- [ ] **14.4** **Mission detail tab strip** — first tab strip on Mission detail; create `MissionTabs.tsx` modeled on `WorkTabs.tsx`; Overview wraps current single-column body.
- [ ] **14.5** Idea-side per-card expansion drawer for Tasks (v1 approach, not full detail page).

### Phase 15 — Agent ↔ Task runtime tasks

- [ ] **15.1** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (maxDuration 60m).
- [ ] **15.2** `packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts` (maxDuration 5m).
- [ ] **15.3** Dispatch hook in `TaskTransitionService` on `* → in_progress` if any Agent assignee; dedup by `(taskId, agentId, generation)`.
- [ ] **15.4** Dispatch hook in `TaskChatService.post` on `@<agent-slug>` mention.
- [ ] **15.5** `AgentRunService` `kind: 'task'` and `kind: 'chat'` paths.
- [ ] **15.6** `taskId` propagation to `PluginUsageEvent` from inside task/chat runs.
- [ ] **15.7** `GET /tasks/:id/spend` per-task spend endpoint.

### Phase 16 — Tools surface wired to Agent runs (HIGH RISK)

- [ ] **16.1** `AgentToolService.resolveAllowedTools(agent)` per `agent-tools-catalog.md §4`.
- [ ] **16.2** `createTask` tool (gated by canAssignTasks).
- [ ] **16.3** `commentOnTask` tool.
- [ ] **16.4** `transitionTask` tool.
- [ ] **16.5** `editAgentFile` tool (path validation, secret scan, hash check, once-per-run).
- [ ] **16.6** `commitToRepo` tool.
- [ ] **16.7** `openPullRequest` tool.
- [ ] **16.8** `createSubAgent` tool (sub-Agents always created in `draft`, permissions all false).
- [ ] **16.9** `getActivity` / `getMissionState` / `getKbDocument` / `getSkillBody` tools.
- [ ] **16.10** Plugin pass-through tools (searchWeb / screenshot / extractContent).

### Phase 17 — Recurring tasks (F5 override)

- [ ] **17.1** Add `rrule` npm package.
- [ ] **17.2** Validate `recurrenceRule` on every write via `RRule.fromString()`.
- [ ] **17.3** Helper `computeNextOccurrence(rule, tz, from)` honoring `recurrenceEndsAt` + `recurrenceMaxOccurrences`.
- [ ] **17.4** Repository method `casClaimRecurrence(taskId, expectedNextOccurrenceAt)`.
- [ ] **17.5** Helper `cloneRecurringTaskAsInstance(template)`.
- [ ] **17.6** `TaskRecurrenceDispatcherService.dispatchDue(batchSize)`.
- [ ] **17.7** Trigger.dev cron `packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts` (every minute UTC).
- [ ] **17.8** UI: "Make this recurring" toggle + frequency picker + "Recurring" badge + "View template" link.

### Phase 18 — Dashboard + Notifications + per-feature templates browser

- [ ] **18.1** `AgentsCountTile.tsx`, `TasksInProgressTile.tsx` on Dashboard.
- [ ] **18.2** "Recent Tasks" block below "Recent Works".
- [ ] **18.3** New `Notification.category` enum values (AGENT, TASK).
- [ ] **18.4** `TaskNotificationService.emit(event, context)` wrapper around existing `NotificationsService.create()`.
- [ ] **18.5** Notification email opt-in flags (`emailAgentAlerts`, `emailTaskNotifications`) on User.
- [ ] **18.6** Templates browser components reusable across `/templates` hub + per-feature pages.

### Phase 19 — Account-transfer extension (per ADR-008 v1 requirement)

- [ ] **19.1** `ExportedAgent` type + `AccountExportService.exportAgents` + bump payload version.
- [ ] **19.2** `ExportedSkill` + `ExportedSkillBinding` + same.
- [ ] **19.3** `ExportedTask` (opt-in) + same.
- [ ] **19.4** `AccountImportService` handlers for all three.
- [ ] **19.5** `GitHubSyncService` repo layout extension (agents/, skills/, tasks/ subdirs in `ever-works-config` sync repo).
- [ ] **19.6** UI toggles in `/settings/import-export`.

### Phase 20 — Final polish + docs site

- [ ] **20.1** Update `docs/plugin-system/built-in-plugins.md` to include `everworks-skills` and `everworks-task-tracker`.
- [ ] **20.2** Add API docs for `/agents/*`, `/skills/*`, `/tasks/*` to the Docusaurus site.
- [ ] **20.3** Run `pnpm format` + `pnpm lint` + `pnpm type-check` (DO NOT run tests).
- [ ] **20.4** Open PR against develop (after spec PR #1017 merges, or with note that it depends on it).

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
