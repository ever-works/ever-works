# Agents/Skills/Tasks — Follow-ups (post-PR-#1019)

Lands on top of `develop` (which already contains PR #1019). Branch:
`feat/agents-skills-tasks-followups`.

## Tier 1 — High-impact

### FU-1 · LLM dispatch in `AgentRunService.execute`

- New `AGENT_AI_DISPATCH_FACADE` injection token + contract
  (`packages/agent/src/agents/agent-ai-dispatch-facade.ts`). Same posture
  as the other agent tokens — agent-side declares the interface;
  api-side `AgentsModule` binds a thin adapter over
  `AiFacadeService.createChatCompletion`.
- `AgentRunService` gains two optional deps (`AgentToolService` +
  `AgentAiDispatchFacade`). When both unbound, the assemble-only branch
  still fires (backward compat with the existing 7-arg unit-test
  constructor calls).
- New `runToolLoop` private drives up to 10 round-trips: resolves tools
  via `AgentToolService`, feeds tool results back as `tool` messages,
  surfaces cap-hits + provider exceptions as ERROR run-log rows.
- Virtual `transitionTask` tool exposed only on `task` runs — captures
  the model's transition intent without doing the flip. `finalize()`
  runs the actual transition via `AGENT_RUN_TASK_FINISHER`.
- `agent-run-execute.spec.ts` covers chat reply, task transition
  capture, heartbeat, AI exception, tool-loop cap, and the
  assemble-only fallback.

### FU-2 · 6 missing Agents API controller routes

Wires `agents/plan.md §4`'s runtime surface:

| Endpoint | Behaviour |
|---|---|
| `POST /api/agents/:id/run-now` | dispatches `agent-heartbeat` immediately via new `AgentScheduleDispatcherService.dispatchOne` |
| `GET /api/agents/:id/runs?limit=&offset=` | paginated AgentRun history + total |
| `POST /api/agents/:id/runs/:runId/cancel` | flips queued/running → cancelled via new `AgentRunRepository.cancel` |
| `GET /api/agents/:id/skills` | active SkillBinding rollup |
| `GET /api/agents/:id/budget` | 30-day spend rollup via `PluginUsageRepository.getTotalSpendCentsForOwner('agent', …)` |
| `POST /api/agents/:id/assign-task` | pre-creates AgentRun + enqueues `agent-task-execute` |

Writes are throttled 30/60s per plan §7.1, log `AGENT_RUN_TRIGGERED` /
`AGENT_RUN_CANCELLED` / `AGENT_TASK_ASSIGNED` on success. `assign-task`
de-dups against in-flight runs for the same (taskId, agentId).

New supporting surface: `AgentRunRepository.countByAgent` / `cancel` /
`findByIdAndUser`, two new `ActivityActionType` values, and re-exported
activity types from `@ever-works/agent/activity-log`.

`agents.controller.runtime.spec.ts` covers all 6 endpoints.

### FU-3 · Mission/Work/Idea-scoped Agent creation entry points

- `NewAgentDialog` accepts a `pinned` prop (`{ scope, missionId/workId/ideaId, parentLabel }`).
  When set: step 1 is skipped, scope is locked, parent id forwards into
  `createAgent(…)`, and a scope chip appears above step 2.
- Three new page routes mount the dialog with the matching pin:
  `/missions/[id]/agents/new`, `/works/[id]/agents/new`,
  `/ideas/[id]/agents/new`.
- Entry points: Agents tab on `MissionTabs`, "+ New Agent" button in
  `WorkHeader`, Bot affordance on `IdeaCard` next to the Build CTA.

### FU-4 · 3 placeholder Agent-detail tabs

`activity`, `skills`, `budgets` now ship full surfaces:

- `AgentActivityClient` — paginated runs from `agentsAPI.listRuns`,
  status chip + trigger-kind tag, cancel affordance on queued/running
  rows.
- `AgentSkillsClient` — bound Skills list with priority + targetType,
  remove-binding affordance via existing `DELETE /api/skill-bindings/:id`.
- `AgentBudgetsClient` — Intl.NumberFormat money display, progress bar
  with cap-aware color tier (primary < amber < danger). No-cap case
  hides the bar.

`agentsAPI` gains `listRuns` / `listSkills` / `getBudget` / `runNow` /
`cancelRun`.

### FU-5 · Attachment UI on Task detail

- `TaskAttachmentsSection` mounted between transitions and conversation
  on `TaskDetailClient`.
- Drag-drop dropzone + multi-file picker. Uploads route through new
  `/api/uploads` Next proxy (mirrors `works/[id]/kb/uploads/route.ts`
  pattern: cookie → Authorization Bearer, body streamed with
  duplex:'half', upstream status surfaced verbatim).
- After upload, calls `attachUploadAction` → `POST /api/tasks/:id/attachments`.
- List rows show filename + size (captured client-side) + attached-at
  timestamp + per-row detach button.
- `attachUploadAction` / `detachAttachmentAction` server actions
  revalidate `/tasks/:id`.

## Tier 2 — UX polish

### FU-6 · i18n keys for Tasks/Skills/Templates

- New `dashboard.tasksPage.{list, newDialog, detail, recurring, status}`,
  `.skillsPage.{list, detail}`, `.templatesPage.*` namespaces in
  `en.json`.
- Threaded `useTranslations` through `TasksList` (filter labels +
  status select + empty state) and `TaskDetailClient` (Move-to heading,
  transition button labels, conversation heading, draft placeholder,
  Post button).
- Locale strategy matches the existing pages — en.json holds canonical
  keys; non-en falls back via next-intl until translation arrives. No
  es/fr keys added (neither has agentsPage either today).
- Follow-on threading for SkillDetailClient / SkillsPageClient /
  TaskRecurringSection / NewTaskForm / AstTemplatesBrowser is
  mechanical now that these keys exist; can ride a polish pass.

### FU-7 · Recurring picker friendly controls

- Time-of-day picker (`<input type="time">`) → emits `BYHOUR=H;BYMINUTE=M`.
- Day-of-week chip strip for Weekly → emits `BYDAY=MO,TU,…`. Save
  blocked when Weekly has no days selected.
- Day-of-month numeric picker for Monthly (1-31) → emits `BYMONTHDAY=X`.
- Timezone free-text with datalist of common IANA names. Defaults to
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, falls back to UTC.
- Client-side validation: regex on FREQ token + Weekly-needs-BYDAY.
  Server's full `rrule` parse remains authoritative (agent-side).

### FU-8 · Skills binding picker UI

- New `SkillBindingTargetPicker` replaces the raw UUID textbox on the
  bindings panel:
  - `tenant` → disabled input (auto-fills server-side)
  - `agent` → loads via `agentsAPI.list({ limit: 100 })`
  - `mission` → `missionsAPI.list()`
  - `idea` → `workProposalsAPI.list(['pending','accepted'])`
  - `work` → `workAPI.getAll({ limit: 100 })`
- Search filter above the listbox (case-insensitive substring),
  sized to min(5, options+1).
- Falls back to a paste-uuid input when the endpoint errors or returns
  nothing.
- Added explanatory copy: "Lower priority numbers win when multiple
  bindings overlap — priority 1 = highest precedence."

### FU-9 · Kanban drag-and-drop transitions

- HTML5 drag-drop without library dependency. Cards `draggable`;
  `onDragStart` stashes the task id (React state + dataTransfer
  fallback).
- Columns evaluate `NEXT_STATUS[src.status]` on each `dragOver` — only
  legal targets `preventDefault()` and light up with a primary ring.
  Illegal columns stay inert.
- Drop routes through the existing `handleMove` → `transitionTaskAction`
  flow (optimistic update + revert on rejection).
- Click-popover preserved as the keyboard-accessible fallback.

### FU-10 · GitHub-sync v2 toggles UI

- 4 new toggles (Include Agents / Skills / Tasks / Task chat) added to
  `GitHubSync.tsx`, matching `DataManagement.tsx`'s shape exactly.
- `handlePush` forwards all 4 into the existing `pushToGitHub` action
  (HIGH-pri PASS-4 fix had already widened its signature).
- includeTaskChat is gated on includeTasks (toggling Tasks off resets
  the chat flag).
- Persistence to `UserSyncConfig` is server-side; the UI defaults
  all-off so v1 syncs keep the v1 payload until the user opts in.

### FU-11 · Templates browser content swap to ADR-010 catalog

- `listAstTemplates(entity)` gains an env-flag gate
  (`NEXT_PUBLIC_AGENT_TEMPLATES_CATALOG=1`). When on, lazy-imports
  `serverFetch` and hits `/api/agent-templates?entity=<entity>`. When
  off (default) or on with fetch failure, returns the hand-curated
  fallback constants.
- Lazy import keeps `getAuthAccessCookie` (server-only) out of the
  client bundle when the flag is off.
- `agent-templates.spec.ts` gains a 3-test describe block covering
  flag-on success, flag-on error → fallback, flag-off → no fetch.
- When ADR-010 ships the catalog endpoint, an operator flips
  `NEXT_PUBLIC_AGENT_TEMPLATES_CATALOG` to `'1'` and the swap is
  automatic; no further code change in this repo.

## Tier 3 — Operator decisions (deferred)

These genuinely need operator input before they can land:

- **FU-12** · Transition lattice `done → in_progress` divergence from
  spec FR-8 — soft re-open path needs either a spec carve-out or a
  tightening of `TaskTransitionService.ALLOWED[DONE]`.
- **FU-13** · `AGENT_GIT_FACADE` binding — needs operator preference on
  committer identity (Agent name? user email?) + git provider
  resolution.
- **FU-14** · Phase 4 Git-mode `AgentFileService` writes — needs
  `GitFacadeService` scope-repo helpers that don't exist yet.

`FOLLOWUP-PROGRESS.md` carries the running log.

## Test posture

Per the FU prompt's operating rules: **tests were written as files but
NOT run.** The operator runs the suite (agent jest + web vitest +
build) at review time. Type-checks pass for both the agent package
(`packages/agent`) and `apps/web`; the API typecheck is clean for the
agents/* surfaces (unrelated package-not-built errors for `@ever-works/monitoring`
etc. are pre-existing in this worktree without a full root build).

## What didn't ship

Beyond Tier 3 (which is intentionally deferred):

- Full i18n threading for SkillDetailClient / SkillsPageClient /
  TaskRecurringSection / NewTaskForm / AstTemplatesBrowser. Keys exist
  in `en.json`; threading is a mechanical follow-up.
- es/fr translations for the new namespaces — matching the existing
  convention of en-only for `dashboard.agentsPage.*` etc.
- ADR-010 unified catalog ENDPOINT itself (FU-11 wires the **client**;
  the server endpoint is operator-led work).
