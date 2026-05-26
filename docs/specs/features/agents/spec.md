# Feature Specification: Agents

**Feature ID**: `agents`
**Branch**: `feat/agents`
**Status**: `Draft`
**Created**: 2026-05-25
**Last updated**: 2026-05-25
**Owner**: Product (Ruslan)
**Related code today**:

- Mission/Idea hierarchy: `packages/agent/src/entities/mission.entity.ts`, `work-proposal.entity.ts` (on `develop`)
- Plugin / AI facade: `packages/agent/src/facades/ai.facade.ts`, `base.facade.ts`
- Trigger.dev integration: `apps/api/src/trigger/`, `packages/tasks/src/`
- Polymorphic budgets: `packages/agent/src/entities/work-budget.entity.ts`, `apps/api/src/budgets/`
- Activity log: `packages/agent/src/entities/activity-log.entity.ts`
- Web sidebar: `apps/web/src/components/dashboard/DashboardSidebar.tsx`
- Work tabs: `apps/web/src/components/works/detail/WorkTabs.tsx`
- The existing "Work Agent" (platform-managed): `apps/api/src/work-agent/`, `packages/agent/src/entities/work-agent-*.entity.ts`

> **Scope of this document:** product behavior — what users see and do, what an Agent is, the page hierarchy, the create flow, the run model, the budgets, the permission grid, the dashboards. Implementation details live in [plan.md](./plan.md); architecture context in [`architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md).
>
> **Hard rule (additive only):** Everything currently shipping stays. The existing Work Agent (Goal/Run/Preference) is unchanged. The existing Plugins page is unchanged. The Mission tick worker is unchanged. New surfaces are added; nothing is renamed or removed. Enforced by [Workspace AGENTS.md NN #20](file:///C:/Coding/Workspace/AGENTS.md).
>
> **Terminology note:** "Agent" with a capital A in this spec always means the **new, user-defined, named, persistent Agent entity**. The legacy platform-managed engine (Goal → Ideas) is referred to as the "Work Agent" verbatim to avoid ambiguity.

---

## 0. Implementation packaging (per the corrected ADR-006)

**Agents are a core domain concept** (entity, runtime, scope cascade, prompt assembly all stay core) — see the [partially-superseded ADR-006](../../decisions/006-agents-skills-tasks-as-core-not-plugins.md). What's pluggable:

- **The Agent's execution engine** — Agent runtime delegates each AI call to whichever **agentic-pipeline plugin** is enabled (e.g. `claude-code`, `claude-managed-agent`, `agent-pipeline`, `codex`, `opencode`, `gemini`, …). Agent runtime is the orchestrator; the agentic pipeline is the worker.
- **Skills** the Agent uses come from the `"Ever Works Skills"` plugin (or any other enabled `skills-provider`) per [ADR-012](../../decisions/012-skills-as-plugin.md).
- **Tasks** the Agent creates/transitions/comments-on are routed through the active `task-tracker` plugin per [ADR-013](../../decisions/013-task-tracking-as-plugin.md).
- **Agent templates** (CEO, CTO, …) come from [`ever-works/agents`](https://github.com/ever-works/agents) per [ADR-011](../../decisions/011-agent-templates-in-separate-repo.md).

So the Agent entity is core; everything it touches is via plugin/facade. This matches the existing plugin-first posture of the platform.

## 1. Overview

A user-defined **Agent** is a named, persistent AI worker the user creates inside Ever Works — e.g. "CEO", "VP of Engineering", "Researcher", "PR Reviewer". An Agent has an identity (`name`, optional `title`, and a `capabilities` description), an AI provider + model selection (defaulting to the user's account default), an explicit scope (Tenant, Mission, Idea, or Work), a permission set (can-create-agents, can-assign-tasks, can-spend, …), and a budget. It runs on an optional heartbeat schedule **and/or** in response to tasks assigned to it.

Agents stand alongside the existing platform-managed Work Agent (which autonomously turns Goals into Ideas). The Work Agent stays the default zero-friction path; user-defined Agents are the optional, advanced layer for users who want named specialists working across their Missions, Ideas, and Works.

Agent definitions — the four markdown files `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`, plus an `agent.yml` metadata file — live in the **scope's Git repo** (the Mission's `missionRepo` for Mission-scoped Agents; the Work's data repo for Work-scoped Agents). DB stores only metadata and a content-hash for fast read. This mirrors Constitution Principle III — Source-of-Truth Repositories.

## 2. User Scenarios

### 2.1 Primary scenarios

**S1 — Create a tenant-scoped CEO Agent (Given/When/Then).**
*Given* a signed-in user who has at least one Mission and one Work,
*When* they navigate to the new sidebar item "Agents", click "+ New Agent", fill `name = "CEO"`, `title = "Chief Executive"`, `capabilities = "You're the CEO. Make sure every Mission has a clear roadmap and each Idea ladders up to a goal."`, accept the default AI provider, leave scope on "Tenant — available to all", and click "Create",
*Then* the user is redirected to `/agents/ceo`, the Agent appears in `status='draft'`, and an `AGENT_CREATED` activity log entry is emitted.

**S2 — Switch CEO Agent to active with a daily heartbeat.**
*Given* the CEO Agent in `draft`,
*When* the user opens the Agent's Dashboard tab and clicks "Start", then sets `Heartbeat cadence = "0 9 * * *"` (daily 9am UTC) and clicks "Save",
*Then* the Agent transitions to `active`, `nextHeartbeatAt` is set to the next 9am UTC, and an `AGENT_RESUMED` entry is logged.

**S3 — Heartbeat tick runs.**
*Given* the CEO Agent is `active` and `nextHeartbeatAt` is in the past,
*When* the Trigger.dev cron `agent-heartbeat-dispatcher` fires,
*Then* the dispatcher CAS-claims the agent row (sets `status='running'`, writes a new `agent_runs` row), enqueues a Trigger.dev run, the agent's prompt + bound skills + recent activity are assembled, an AI call is made via `AiFacadeService`, a `PluginUsageEvent` is recorded, and on success the run row reaches `completed` with a `summary` field populated. `AGENT_HEARTBEAT_STARTED` and `AGENT_HEARTBEAT_COMPLETED` activity rows are emitted. `nextHeartbeatAt` is rescheduled.

**S4 — Agent creates a task for another Agent.**
*Given* the CEO Agent has `permissions.canAssignTasks = true` and there is another tenant-scoped Agent "VP-Engineering",
*When* during a heartbeat tick the CEO Agent's AI response calls the `createTask` tool with `{title, assigneeAgentIds: ["vp-engineering"], priority: "p1"}`,
*Then* a new `tasks` row is created with `createdByType='agent'`, `createdById='ceo'`, a `task_assignees` row links VP-Engineering, and `TASK_CREATED` + `TASK_ASSIGNED` activity rows are emitted.

**S5 — Mission-scoped Agent gets attached to one Mission only.**
*Given* a Mission "Cats Business" and the user creating a new Agent "Catnip Researcher" with `scope='mission'` and `missionId=<cats-business-id>`,
*When* the Agent is created,
*Then* its prompt files are written to `<missionRepo>/.works/agents/catnip-researcher/` via `GitFacadeService.commit()`, and the Agent is visible only inside `/missions/<id>/agents` (NOT on the tenant `/agents` list unless the user toggles "show all scopes").

**S6 — Budget cap blocks an AI call.**
*Given* the CEO Agent has `AgentBudget(intervalUnit='day', capCents=500, allowOverage=false)` and today's spend is already $4.95,
*When* a heartbeat tick is about to call the AI provider with estimated cost > 5c,
*Then* `BudgetGuardService.checkBudget(ownerType='agent', ownerId=ceo.id, estimatedCostCents)` returns blocked, the run is short-circuited to `status='failed'` with `errorMessage='Budget exceeded'`, an `AGENT_BUDGET_EXCEEDED` activity row is emitted, and the dispatcher does NOT auto-pause (it'll try again tomorrow when the interval resets).

**S7 — Agent edits its own SOUL.md.**
*Given* the CEO Agent has `permissions.canEditAgentFiles = true`,
*When* during a tick the AI response uses the `editAgentFile` tool to update `SOUL.md`,
*Then* the file is written via `GitFacadeService.commit()` to the scope's repo, the `agents.contentHash` column is updated, an `AGENT_FILE_EDITED` activity row is emitted with the diff in `details`.

**S8 — Mention an Agent in a Task chat.**
*Given* a Task with two assignees (a human user and an Agent), and a human typing `@ceo can you review this?` in the Task chat,
*When* the message is posted,
*Then* a `task_chat_messages` row is inserted, an `agent-chat-reply` Trigger.dev run is dispatched targeting the CEO Agent, and within ~10s a new `task_chat_messages` row from the Agent appears with `authorType='agent'`.

**S9 — Mission Template ships with pre-defined Agents.**
*Given* a Mission Template repo whose `.works/mission.yml` declares `agents: [{slug: 'founder', path: '.works/agents/founder'}]` and contains `.works/agents/founder/SOUL.md` + siblings,
*When* a user instantiates a Mission from that template via the "Use this Template" button,
*Then* the Mission scaffolder copies the `.works/agents/` subtree into the new `<slug>-mission` repo and creates a matching `agents` row + `agent_runs` queue entry (in `draft`) so the user finds the Founder Agent ready to start.

### 2.2 Edge cases & failures

**E1 — Agent name collision within scope.** Names must be unique per scope. Creating a second tenant-scoped Agent named "CEO" returns 409 with a precise error. Cross-scope duplicates are allowed (CEO at tenant + CEO inside a specific Mission), but discouraged in UI copy.

**E2 — Provider not enabled for the user.** If the user picks an AI provider that's installed but not enabled for them, the create dialog shows the same inline error the Work generator form shows today.

**E3 — Heartbeat cron malformed.** A bad cron string is rejected by `cron-parser` validation in the DTO; the dialog highlights the field. Same library the existing `WorkSchedule.cadence` validates with.

**E4 — Run timeout.** Heartbeat runs have a 30-minute Trigger.dev `maxDuration`. On timeout the run row is set to `status='failed'`, `errorMessage='timeout'`, and `agents.errorCount` is incremented. If `errorCount >= pauseAfterFailures` (default 3), the Agent is auto-paused (`status='error'`) and a notification email is sent.

**E5 — Concurrent heartbeat claim.** Two dispatcher workers race on the same Agent. The CAS-update guarantees only one wins; the loser logs and continues.

**E6 — Repo write failure.** Editing an Agent file when the Git provider returns 503: the operation is retried with the existing `gitFacade` retry policy (max 3); on terminal failure, the in-memory DTO is reverted, the user sees a toast, and a `AGENT_FILE_EDIT_FAILED` activity row is logged.

**E7 — Agent edits a file it doesn't own.** The `editAgentFile` tool only accepts paths under the agent's own `.works/agents/<slug>/` subtree. Anything else returns a tool error to the AI, which the Agent must handle.

**E8 — Permission missing.** If an Agent tries to call `createTask` without `permissions.canAssignTasks = true`, the tool returns an error to the AI before any DB write. No `tasks` row is created.

**E9 — Tenant-scoped Agent without control repo.** The Agent's MD files live in the `agents` row TEXT columns. Trying to `gitFacade.commit()` is a no-op; the API surface still serves the body via the inline storage. The UI shows a banner suggesting the user create a control repo for portability.

**E10 — Plugin not loaded at run time.** If the Agent's chosen `aiProviderId` plugin is unloaded (e.g. tenant disabled it), the heartbeat falls back through the resolution chain (Work/User/Admin). If nothing resolves, the run fails with a clear `NoProviderError` and the Agent is auto-paused.

## 3. Functional Requirements

Numbered, atomic, testable. `MUST` / `SHOULD` / `MUST NOT` per Spec Kit convention.

### 3.1 Entity lifecycle

- **FR-1** The system MUST persist a new `agents` table with the columns enumerated in [`architecture/agents-skills-tasks.md` §4.1](../../architecture/agents-skills-tasks.md).
- **FR-2** The system MUST enforce `UNIQUE(userId, scope, missionId?, ideaId?, workId?, name)` so the same name cannot collide within a scope (E1).
- **FR-3** The system MUST validate `scope`, `missionId`, `ideaId`, `workId` are mutually consistent on insert: exactly one of {missionId, ideaId, workId} non-null iff scope is the matching enum value; all three null iff scope='tenant'.
- **FR-4** The system MUST default `status` to `draft` on insert.
- **FR-5** The system MUST allow status transitions only along this graph: `draft → active`, `active ⇄ paused`, `active ⇄ running`, `active → error`, `error → paused`, `paused → active`, `* → archived`. Other transitions return 409.

### 3.2 Provider & model selection

- **FR-6** The system MUST allow `aiProviderId` to be null on insert; if null, run-time resolution follows the cascade in [`architecture/agents-skills-tasks.md` §7](../../architecture/agents-skills-tasks.md).
- **FR-7** When `aiProviderId` is set, the system MUST verify the plugin is loaded and enabled for the user (and for the scope, if scoped) at write time, returning 400 with a precise reason otherwise.
- **FR-8** The system MUST allow `modelId` to be null. If set, the system SHOULD validate it against the plugin's `listModels(settings)` at write time; if validation is unavailable (rate-limited / network failure), the system MUST accept the value optimistically and surface the failure only at first run.

### 3.3 Heartbeats

- **FR-9** The system MUST support `heartbeatCadence` as one of (a) a valid cron expression, (b) `manual` (no automatic ticks), or (c) `null` (treated as `manual`).
- **FR-10** The system MUST run an `agent-heartbeat-dispatcher` Trigger.dev cron task every `AGENT_DISPATCH_INTERVAL_MINUTES` minutes (default 1).
- **FR-11** The dispatcher MUST select Agents with `status='active'` and `nextHeartbeatAt <= now()`, CAS-update them to `status='running'`, and dispatch `agent-heartbeat` runs in batches.
- **FR-12** Each heartbeat run MUST insert an `agent_runs` row (status=`running`), update on terminal state, and emit `AGENT_HEARTBEAT_STARTED` / `AGENT_HEARTBEAT_COMPLETED` / `AGENT_HEARTBEAT_FAILED` activity rows.
- **FR-13** On `failed` terminal state the system MUST increment `agents.errorCount`. On `errorCount >= pauseAfterFailures` (default 3), the system MUST transition the agent to `status='error'` and emit `AGENT_PAUSED`.

### 3.4 Budgets

- **FR-14** The system MUST allow at most one `agent_budgets` row per Agent (UNIQUE on `agentId`).
- **FR-15** Before any AI call in a heartbeat/task/chat run, the system MUST consult `BudgetGuardService.checkBudget({ownerType:'agent', ownerId:agentId, estimatedCostCents})` and short-circuit on a `block` decision.
- **FR-16** The system MUST aggregate per-Agent spend over `intervalUnit` (hour/day/week/month/unlimited) by joining `plugin_usage_events` rows where `agentId = <id>`.
- **FR-17** The Agent's Budgets tab MUST surface current-interval spend, the cap, the remaining headroom, and the next reset timestamp. The user MUST be able to edit cap, interval, and overage-allowance via this tab.

### 3.5 Skills

- **FR-18** The system MUST allow a Skill (see [features/skills/spec.md](../skills/spec.md)) to be bound to an Agent via `skill_bindings(targetType='agent', targetId=agentId)`.
- **FR-19** The Agent's Skills tab MUST show (a) skills bound to this Agent, (b) skills inherited from the scope (Mission/Work/Tenant), (c) the platform catalog with a one-click "attach to this Agent" affordance.
- **FR-20** When the Agent runs, the assembled system message MUST follow the progressive-disclosure pattern described in [`architecture/agents-skills-tasks.md` §8](../../architecture/agents-skills-tasks.md): inject Skill name + description + body excerpt by default; full body fetched on demand.

### 3.6 Files & repo storage

- **FR-21** The system MUST treat the four files `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md` plus `agent.yml` as the canonical Agent definition.
- **FR-22** For Mission/Idea/Work-scoped Agents, the system MUST write these files to the scope's Git repo under `.works/agents/<slug>/` via `GitFacadeService.commit()` on every UI-driven save.
- **FR-23** For Tenant-scoped Agents with no control repo, the system MUST store the four MD files in `agents.fileBodyMd_*` TEXT columns and serve them via the same API.
- **FR-24** The system MUST expose `GET /agents/:id/files/:name` and `PUT /agents/:id/files/:name` (where `:name ∈ {SOUL, AGENTS, HEARTBEAT, TOOLS, agent.yml}`) returning/accepting the body as text.
- **FR-25** When a file is edited via the UI, the system MUST update `agents.contentHash` (sha256 of the canonical 5-file concatenation) and emit `AGENT_FILE_EDITED`.

### 3.7 Permissions cascade

- **FR-26** The system MUST default every `permissions.*` flag to `false` on insert.
- **FR-27** The system MUST refuse a tool call (e.g. `createTask`, `editAgentFile`, `commitToRepo`) when the corresponding permission is `false`, returning a structured tool-error to the AI.
- **FR-28** When an Agent attempts to create another Agent (via the `createSubAgent` tool, gated by `canCreateAgents`), the new Agent's scope MUST be equal to or narrower than the creator's. Tenant → anything; Mission → Mission/Idea/Work in same Mission; Work → Work in same Work only.
- **FR-29** Task assignment by an Agent MUST follow the cross-scope rules in [`architecture/agents-skills-tasks.md` §3](../../architecture/agents-skills-tasks.md).

### 3.8 Web UI

- **FR-30** The sidebar MUST gain an "Agents" item between "Works" and "Templates" (above Templates, below Works/Tasks).
- **FR-31** The `/agents` page MUST list Agents the user owns in either Cards or Table view, with a Cards/Table toggle persisted to `localStorage` (key `agents-view-mode`).
- **FR-32** The page MUST expose filter chips `All / Active / Paused / Error` mapping to the status enum per [`architecture/agents-skills-tasks.md` §6](../../architecture/agents-skills-tasks.md).
- **FR-33** The page MUST expose a scope filter (`Tenant / Mission / Idea / Work / All scopes`) defaulting to "All scopes".
- **FR-34** The `/agents/[id]` page MUST render six tabs: **Dashboard / Activity / Instructions / Skills / Budgets / Settings**.
- **FR-35** The **Dashboard tab** MUST render: a live status block (current `agents.status` + the currently-running `agent_runs` row if any, with a "Cancel run" button); a "Run activity" bar chart (last 30 days; one bar per day, height = run count); a "Tasks by priority" stacked column chart (last 30 days; colors per priority); a "Recent tasks" list (5 most recent tasks where this Agent is an assignee, reviewer, or approver, with statuses); a "Cost snapshot" card (input/output/cached tokens + USD for current `intervalUnit`).
- **FR-36** The **Activity tab** MUST reuse the existing activity-feed UI (poll-based, `ActivityFeedClient.tsx`) filtered to events with `details.agentId = <id>`, including expandable AI request/response payloads.
- **FR-37** The **Instructions tab** MUST render a 5-tab editor (one tab per MD file + `agent.yml`) backed by the existing Tiptap markdown editor (`KbEditor.tsx`) with 800ms autosave debounce and a dirty/saved indicator.
- **FR-38** The **Skills tab** MUST follow the [features/skills/spec.md §4](../skills/spec.md) layout.
- **FR-39** The **Budgets tab** MUST render the live spend bar, the interval picker, the cap input, the overage toggle, and a per-day histogram of the last 30 days.
- **FR-40** The page header MUST expose action buttons: **Run heartbeat now**, **Assign Task**, **Pause / Resume**, **Archive**, **Delete** (Delete requires a typed confirmation since archived runs cannot be recovered).

### 3.9 Per-target tabs

- **FR-41** The Work detail page (`/works/[id]`) MUST gain a tab "Agents" between "Plugins" and "Deploy", listing Agents whose scope is this Work + any tenant-scoped Agents whose `AgentMembership` includes this Work.
- **FR-42** The Mission detail page MUST gain a tab "Agents", listing Mission-scoped + tenant-scoped Agents that include this Mission.
- **FR-43** The Idea detail page MUST gain a tab "Agents", listing Idea-scoped + parent-Mission-scoped + tenant-scoped Agents.

### 3.10 Mission Template integration

- **FR-44** Mission Templates' `.works/mission.yml` MUST support an `agents: [{slug, path}]` array (and a `skills: [{slug, path}]` array per Skills spec).
- **FR-45** When a Mission is instantiated from a Template that declares agents/skills, the scaffolder MUST copy `.works/agents/` and `.works/skills/` from the template repo to the new mission repo, then insert matching `agents` and `skills` rows (status=`draft`).

## 4. Non-Functional Requirements

### 4.1 Performance

- **NFR-1** `GET /agents?scope=tenant&limit=50` p95 < 200 ms with 1000 Agents per user.
- **NFR-2** The Agents Dashboard tab time-to-first-paint p95 < 500 ms; chart aggregations may be served from a daily-rollup table populated nightly (additive, optional optimization).
- **NFR-3** Heartbeat dispatcher MUST not block for more than 5 s on a single tick even with 10 000 active Agents; batched in chunks of 200.

### 4.2 Reliability

- **NFR-4** Concurrent CAS claim MUST be safe — at most one worker may run a given Agent's heartbeat at a time.
- **NFR-5** A failed AI call MUST NOT corrupt the `agents` row (run-row status transitions, agent-row only changes `errorCount` / `status` if the threshold is crossed).
- **NFR-6** Tenant-scoped Agents without a control repo MUST continue to function indefinitely; storing 4 MD files inline has no upper-bound enforced beyond MySQL/Postgres TEXT max.

### 4.3 Security & privacy

- **NFR-7** No secrets (API keys, OAuth tokens) MUST appear in any of the four Agent MD files; the editor MUST reject save if a known-secret pattern (e.g. `sk-`, `xoxb-`, AWS access keys) is detected, mirroring the existing `x-secret` redaction policy from `settings-system.md`.
- **NFR-8** Cross-user reads MUST 404 (not leak existence), same posture as the AI Conversation feature.
- **NFR-9** An Agent's `permissions` field MUST be evaluated server-side on every tool call; client-side hiding of UI elements is for ergonomics only.

### 4.4 Observability

- **NFR-10** Every Agent run MUST emit at least two activity rows (start + terminal) so the live feed shows accurate progress.
- **NFR-11** Sentry tags `agent.id`, `agent.scope`, `agent.status`, `run.kind` MUST propagate to errors raised inside heartbeat / task / chat runs.

### 4.5 Compatibility

- **NFR-12** All `works.yml` and `mission.yml` documents that lack the new `agents:` / `skills:` arrays MUST continue to parse and run unchanged.
- **NFR-13** The existing Work Agent (Goal/Run/Preference) MUST be unaffected — no schema changes, no service-method changes, no UI changes to its dedicated settings page.

## 5. Key Entities & Domain Concepts

| Concept                | One-line definition                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent**              | A named, persistent, user-defined AI worker scoped to Tenant / Mission / Idea / Work. Backed by `agents` row + Git files.                                    |
| **AgentScope**         | Enum {`tenant`, `mission`, `idea`, `work`} on `agents.scope` constraining where the Agent appears and what it can act on.                                    |
| **AgentMembership**    | Row linking a tenant- or mission-scoped Agent to a specific Mission/Idea/Work it's allowed to operate on. Polymorphic ownerType + ownerId.                   |
| **AgentRun**           | One execution of a heartbeat / task / chat reply. Reaches a terminal state (`completed` / `failed` / `cancelled`).                                            |
| **AgentBudget**        | Per-Agent spending cap with interval (hour/day/week/month/unlimited). Re-uses the same `BudgetGuardService` cascade as `WorkBudget`.                          |
| **AgentPermissions**   | JSON object on `agents.permissions` gating tool calls (createTask, editAgentFile, commitToRepo, canCreateAgents, …).                                          |
| **Agent files**        | The five canonical files `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`, `agent.yml`. Live in the scope's Git repo (or inline for Tenant DB-only mode).   |
| **Heartbeat tick**     | A scheduled execution of an Agent driven by `agent-heartbeat-dispatcher` cron + the per-Agent `heartbeatCadence`. The Agent's "what would you do next?" loop. |

### 5.1 Sidebar i18n keys (additive)

```
dashboard.sidebar.navigation.agents       = "Agents"
dashboard.sidebar.navigation.skills       = "Skills"
dashboard.sidebar.navigation.tasks        = "Tasks"

agents.title                              = "Agents"
agents.empty.title                        = "No Agents yet"
agents.empty.cta                          = "+ New Agent"
agents.filter.all                         = "All"
agents.filter.active                      = "Active"
agents.filter.paused                      = "Paused"
agents.filter.error                       = "Error"
agents.scopeFilter.tenant                 = "Tenant"
agents.scopeFilter.mission                = "Mission"
agents.scopeFilter.idea                   = "Idea"
agents.scopeFilter.work                   = "Work"
agents.detail.tabs.dashboard              = "Dashboard"
agents.detail.tabs.activity               = "Activity"
agents.detail.tabs.instructions           = "Instructions"
agents.detail.tabs.skills                 = "Skills"
agents.detail.tabs.budgets                = "Budgets"
agents.detail.tabs.settings               = "Settings"
agents.detail.action.runNow               = "Run heartbeat now"
agents.detail.action.assignTask           = "Assign Task"
agents.detail.action.pause                = "Pause"
agents.detail.action.resume               = "Resume"
agents.detail.action.archive              = "Archive"
agents.detail.action.delete               = "Delete"
```

## 5.2 Heartbeat semantics — what an Agent does on an idle tick

When the dispatcher fires for an `active` Agent and the Agent has no pending tasks, the run is **not** a no-op. The Agent receives a synthetic user message: `"What's the next action you should take? Choose ONE."` plus the assembled system message ([`architecture/agent-prompt-assembly.md` §2](../../architecture/agent-prompt-assembly.md)). The model's response can be one of:

- **Create a Task** (when `permissions.canAssignTasks = true`) — either self-assigned or assigned to another Agent within scope.
- **Comment on an open Task** (where the Agent is an assignee/reviewer/approver) — appends a `task_chat_messages` row.
- **Edit own MD file** (when `canEditAgentFiles = true`, max 1 file per run) — for example, append a paragraph to `SOUL.md` capturing a learning.
- **Read scope state** (KB, activity, recent items) and **do nothing this tick** — recorded as `summary: "observed, no action"`.

This is configurable via `agent.yml` field `idleBehavior: 'propose' | 'noop' | 'observe'` (default `propose`). See [QUESTIONS C1](../../QUESTIONS-agents-skills-tasks.md#c1--heartbeat-tick-semantics-what-does-an-agent-do-when-nothing-is-assigned).

## 5.3 Memory model

Short-term memory (within a single run): standard tool-loop messages accumulate in the in-flight conversation. Not persisted beyond the run.

Long-term memory (across runs): the four MD files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`) are the durable, intentional store. The Agent may **edit** them via the `editAgentFile` tool (gated by permission + secret-scan + size cap + once-per-run cap). The platform does NOT auto-append to these files. See [`agent-prompt-assembly.md` §4](../../architecture/agent-prompt-assembly.md).

Passive history (last N days): read on demand via the `getActivity({since, limit})` tool — NOT injected by default. Saves tokens on idle ticks.

Cross-Agent: Agents cannot read each other's MD files. Shared knowledge flows through Tasks, KB documents, and the activity log only.

## 5.4 Cost attribution on delegated tasks

When Agent A creates a Task assigned to Agent B, and B's heartbeat runs the Task:

- **A's cost**: only the cost of A's run that created the Task (a small AI call to draft the Task body).
- **B's cost**: the cost of running the Task (potentially many AI calls in a tool loop).

Default — see [QUESTIONS D1](../../QUESTIONS-agents-skills-tasks.md#d1--delegated-tasks-who-pays). The `plugin_usage_events` row from B's run carries `agentId=B.id` and `taskId=<task.id>`, so the Task's spend endpoint can sum B's contribution; A's contribution is queryable by `agentId=A.id`.

## 5.5 Cancellation semantics

When the user clicks "Cancel run" on an in-flight `agent_runs` row:

1. UI calls `POST /agents/:id/runs/:runId/cancel`.
2. Server calls `runs.cancel(triggerRunId)` (same SDK call the Work generation cancel path uses).
3. AbortSignal propagates through `AiFacadeService` to the AI provider plugin; mid-stream call is destroyed.
4. The run row is updated to `status='cancelled'` with the partial usage recorded (a partial `PluginUsageEvent` is still written via the existing best-effort path in `AiFacadeService`).
5. Any file changes the Agent had committed before the cancel **stay** (no Git revert). The user can revert manually.
6. Activity row `AGENT_HEARTBEAT_FAILED` is NOT emitted — `AGENT_RUN_CANCELLED` is used instead.

## 5.6 Conflict resolution between Agent files

The platform does NOT pre-resolve conflicts between SOUL.md and AGENTS.md, or between AGENTS.md and the user-task input. The model reconciles, and its response surfaces the reconciliation. The platform guarantees only the **order** of injection (SOUL first → AGENTS → HEARTBEAT/preamble → TOOLS → Skills → scope → memory → task body). Order gives the earlier segments attention-position priority. See [`agent-prompt-assembly.md` §6](../../architecture/agent-prompt-assembly.md).

Permissions ALWAYS win over any file content. If `canCommitToRepo = false` but a Skill's `allowed-tools` includes `git`, the tool returns a structured error when invoked.

## 5.7 Agent ↔ Agent communication: only through Tasks

v1 has no Agent-to-Agent direct messaging channel. All cross-Agent collaboration goes through Tasks: an Agent assigns a Task, comments in a Task chat, mentions another Agent in a chat. This:

- gives every Agent ↔ Agent interaction an audit trail (`task_chat_messages` + activity log);
- attributes cost to the right Agent (executor pays);
- enforces scope via the cross-scope assignment rules in [architecture §3](../../architecture/agents-skills-tasks.md);
- avoids a new `agent_messages` table (its own auth + rate-limiting + UI surface).

See [QUESTIONS B3](../../QUESTIONS-agents-skills-tasks.md#b3--agent-to-agent-communication-forced-through-tasks-or-allow-dms).

## 5.8 Audit log of destructive actions

Beyond the `AGENT_*` event types in [architecture §10](../../architecture/agents-skills-tasks.md), the activity log records:

- `AGENT_DELETED` — the user who archived the Agent + the timestamp + a snapshot of the Agent's last `contentHash` (so post-delete forensics is possible).
- `AGENT_FILE_REVERTED` — if a `PUT /files/:name` is rejected by hash mismatch (optimistic concurrency); helps detect concurrent-edit collisions.

## 5.9 Cascade on delete

| Event                       | Cascade                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete Agent                | `agent_runs`, `agent_run_logs`, `agent_budget`, `agent_memberships`, `skill_bindings(targetType='agent')` all CASCADE. `task_assignees(assigneeType='agent', assigneeId=<id>)` row drops. Task chat messages authored by this Agent: `authorId` becomes a dangling UUID — UI renders "Deleted Agent". |
| Delete Mission              | Mission-scoped Agents CASCADE. The Mission's `missionRepo` on GitHub is NOT touched. UI prompts the user with a "delete GitHub repo separately" notice. See [QUESTIONS N1](../../QUESTIONS-agents-skills-tasks.md#n1--cascade-on-mission-delete).                                                  |
| Delete Work                 | Work-scoped Agents CASCADE. `dataRepo` / `websiteRepo` on GitHub untouched (same posture as Mission delete).                                                                                                                                                                                       |
| Delete User                 | All entities CASCADE via FK chain. Agent files stored inline (tenant scope) are removed; files in Mission/Work repos remain (the user still owns the repo on GitHub).                                                                                                                              |

## 5.10 Dry-run mode

`POST /agents/:id/dry-run` builds the prompt + estimates cost + returns the would-have-been-sent payload without invoking the AI provider. No `agent_runs` row written; doesn't count against budget. Useful during prompt iteration. See [QUESTIONS N4](../../QUESTIONS-agents-skills-tasks.md#n4--per-agent-dry-run-mode).

## 5.10a Agent avatar modes [H3 operator override — all three in v1]

Every Agent has a visual identity that appears on the Agent list cards, Task assignee chips, chat messages, dashboard, etc. Three modes — pick per Agent:

| Mode             | What it renders                                                                                       | Storage                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `initials`       | First 1-2 letters of the Agent's name in a circle, color hashed from the slug. **Default.**           | Nothing extra; rendered client-side.                                     |
| `icon`           | A lucide-react icon picked from a curated set of ~30 (Bot, Briefcase, Hammer, Microscope, …). Color same hashed palette. | `agents.avatarIcon: varchar(64) nullable` — stores the lucide icon name. |
| `image`          | Uploaded image (square, ≤ 1 MB, png / jpg / webp). Available only when tenant has file storage enabled. | `agents.avatarImageUploadId: uuid nullable` — FK to `work_knowledge_upload` (reuses existing upload pipeline). |

The Agent's settings tab exposes the three modes as a radio group. Picking `icon` opens an icon picker modal; picking `image` opens the existing KB upload modal (with "1:1 ratio recommended, ≤ 1 MB" copy). Switching modes preserves the unused-mode's data so a user can flip back without re-uploading.

Schema:
- `agents.avatarMode: varchar(8) NOT NULL DEFAULT 'initials'` (enum: `initials | icon | image`).
- `agents.avatarIcon: varchar(64) NULL` — only used when mode = `icon`.
- `agents.avatarImageUploadId: uuid NULL` — only used when mode = `image`.

When the tenant has no file storage configured, the `image` radio option is disabled with a tooltip: "Upload requires storage plugin — enable in /plugins."

## 5.11 Export AND import in v1 [N5 operator override — was ★a "export only"]

Both directions ship in v1:

- **Export**: `GET /agents/:id/export` returns a JSON envelope: `{meta, soulMd, agentsMd, heartbeatMd, toolsMd, agentYml, skillBindings, budget, avatar}`. Sharable text snapshot.
- **Import**: `POST /agents/import` accepts the same envelope shape. Creates a new Agent at the requested scope. Conflict on `(userId, scope, slug)` resolves per `?onConflict=skip|overwrite|rename` query param (default `rename` — appends `-2`, `-3`, etc.). Image avatars in the export envelope carry the upload bytes inline (base64); on import, those are re-uploaded via the existing KB upload pipeline and re-linked.

Round-tripping is byte-stable for everything except: image upload IDs (re-issued), creation timestamps (refreshed), and the slug (when renamed on conflict).

Use cases: backup/restore one Agent, share an Agent with another tenant's user, migrate an Agent between scopes (export at one scope, edit envelope JSON to switch scope, import).

This is **distinct from** the bulk account-transfer flow in [ADR-008](../../decisions/008-tenant-control-repo-deferred-to-v2.md), which round-trips ALL tenant data via the user's GitHub sync repo. The single-Agent export/import is faster and doesn't require GitHub auth.

## 6. Out of Scope (v1)

- An external task-tracker plugin (Linear, GitHub Issues, Jira). Interface reserved in [`task-tracking/spec.md`](../task-tracking/spec.md), not consumed.
- A "Hire an Agent" marketplace / catalog of pre-built Agents (analog to Mission Templates). The Mission Templates path already lets a Template pre-declare Agents; a standalone catalog ships later.
- Agent-to-agent direct messaging outside of Task chats. v1 forces all Agent ↔ Agent communication through Tasks.
- A visual "org chart" of Agents and who can assign tasks to whom. v1 shows the cross-scope rules in copy only.
- Per-tool ACLs inside `TOOLS.md`. v1 honors `canCallExternalTools` as a single global on/off; per-plugin tool ACLs are a v2 enhancement.
- "Run on event" — triggering an Agent on a custom event in addition to heartbeat + task. v2.
- A read-only public profile page for an Agent (so users can share an Agent definition publicly). v2.

## 7. Acceptance Criteria

- [ ] User can create a tenant-scoped Agent via UI; row appears in `agents`, files written to control repo (or inline TEXT if no control repo); activity log shows `AGENT_CREATED`.
- [ ] User can pick provider + model from the same dropdowns the Work creator dialog uses; "Use account default" is the first option.
- [ ] User can set a cron heartbeat; first tick fires within `AGENT_DISPATCH_INTERVAL_MINUTES` of the cron-next time.
- [ ] Heartbeat completes; new `agent_runs` row reaches `completed`; `plugin_usage_events` row carries `agentId` and `costCents`.
- [ ] Budget cap blocks the next heartbeat; `AGENT_BUDGET_EXCEEDED` row appears; UI banner displays remaining = $0.
- [ ] User edits `SOUL.md` in the Instructions tab; commit lands in the scope's repo within 5 s; `AGENT_FILE_EDITED` row appears.
- [ ] Mission-scoped Agent's files appear at `<missionRepo>/.works/agents/<slug>/` on GitHub; Tenant-scoped Agent (no control repo) files come back from `GET /agents/:id/files/SOUL.md` with no Git round-trip.
- [ ] Tab "Agents" on `/works/[id]` lists this Work's Agents + tenant-scoped Agents whose membership includes this Work.
- [ ] Mission instantiated from a Template that declares 2 Agents lands with 2 `agents` rows in `draft` and the files copied into the new mission repo.
- [ ] Agent assigns a Task to another Agent within scope; rejected when target is out of scope.
- [ ] Existing Work Agent goal/run/preference paths and the Mission tick worker still pass their existing test suites (no regression).

## 8. Open Questions

- **[NEEDS CLARIFICATION: Q1]** Should we ship a **tenant control repo** in v1 (a `<user>-control` GitHub repo created at signup, mirror of the existing `<slug>-data` repo pattern)? Or defer to v2 and live with DB-only tenant Agents? **Default for v1: defer.** Tenant Agents stored inline in DB; offer one-click "export to repo" later.
- **[NEEDS CLARIFICATION: Q2]** Should `permissions.canCreateAgents` allow an Agent to delete other Agents it created? Current draft says **no** — Agent can create, but only humans can delete. Lower blast-radius.
- **[NEEDS CLARIFICATION: Q3]** When an Agent's `aiProviderId` is null, should we cache the resolved provider per-Agent for the run-time of a single heartbeat to avoid re-resolving on every AI call inside the tick? **Probably yes** — set in `AgentRunService.execute()` setup phase.
- **[NEEDS CLARIFICATION: Q4]** The Agent name field — should we enforce kebab-case slug derivation server-side, or allow free-text names with auto-slugification (like Work titles)? Current draft says auto-slugify on the slug column (`slug` derived from `name`), and `name` is free-text.
- **[NEEDS CLARIFICATION: Q5]** The "Cost snapshot" on the Dashboard tab — should it count IN-TICK skill body fetches (which currently incur an extra AI call in some progressive-disclosure paths) as separate cost events? **Default: yes**, every AI call is its own usage event; we tag them with `metadata.purpose = 'skill-body-fetch'` so the UI can group/exclude as needed.

## 9. Constitution Gates

- [x] **I — Plugin-First**. No new plugins shipped. Agents use existing plugin categories. The reserved `task-tracker` interface is added but not consumed.
- [x] **II — Capability-Driven Resolution**. Agent provider resolution goes through `AiFacadeService.resolvePlugin`; no hardcoded provider id.
- [x] **III — Source-of-Truth Repositories**. Agent files live in the scope's Git repo; DB only mirrors metadata + hash.
- [x] **IV — Background Work via Trigger.dev**. Heartbeat dispatcher + per-Agent heartbeat task + per-Task agent execution all run on Trigger.dev.
- [x] **V — Forward-Only Migrations**. Every new table ships with an additive migration. No renames or destructive drops.
- [x] **VI — Tests Prerequisite**. Service unit tests, dispatcher CAS test, end-to-end "create → heartbeat → file edit" Playwright test.
- [x] **VII — Secret Hygiene**. NFR-7 enforces secret scan on Agent MD files; plugin settings still own credentials.
- [x] **VIII — Plugin Counts Single Source**. N/A.
- [x] **IX — Behaviour-First Specs**. This spec describes user behavior; implementation is in plan.md.
- [x] **X — Backwards Compatibility**. `agents:` / `skills:` arrays in YAML are optional; everything currently shipping is unchanged.

## 10. References

- Plan: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- UX spec (PM lens): [`../UX-DESIGN-agents-skills-tasks.md`](../UX-DESIGN-agents-skills-tasks.md)
- Implementation reuse map (engineer lens): [`../../architecture/implementation-reuse-map.md`](../../architecture/implementation-reuse-map.md)
- Architecture: [`../../architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md)
- Related feature: [Skills](../skills/spec.md), [Task-tracking](../task-tracking/spec.md), [Missions / Ideas / Works](../missions-ideas-works/spec.md)
- ADR-006: [`../../decisions/006-agents-skills-tasks-as-core-not-plugins.md`](../../decisions/006-agents-skills-tasks-as-core-not-plugins.md)
- Constitution: [`../../../.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
