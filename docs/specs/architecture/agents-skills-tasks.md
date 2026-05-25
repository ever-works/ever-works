# Architecture: Agents, Skills, and Tasks

**Status**: `Draft`
**Last updated**: 2026-05-25
**Audience**: Engineers and AI agents implementing or extending the Agents / Skills / Task-tracking layer that sits on top of the now-shipped Missions → Ideas → Works hierarchy.

---

## 1. Purpose

Three new first-class concepts are added to the platform **in addition to** the existing Mission → Idea → Work → Artifact lifecycle (see [`features/missions-ideas-works/spec.md`](../features/missions-ideas-works/spec.md)):

| Concept   | One-line definition                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent** | A named, persistent, AI-driven worker the user creates (e.g. "CEO", "VP of Engineering"). Has a model + provider, optional capabilities description, a budget, a permission set, and a scope (tenant / Mission / Idea / Work). Runs on a heartbeat and/or in response to assigned tasks. |
| **Skill** | A reusable, markdown-defined capability ("how to do X") that can be attached to an Agent or injected into a Generator. Lives in a hierarchy: platform catalog → tenant install → Mission/Idea/Work install → per-Agent skill. Same triggering shape as Anthropic Skills.   |
| **Task**  | A unit of work with status, priority, assignees (humans **and** Agents), parent/sub-tasks, blockers, reviewers, approvers, an activity log, and a flat chat. Tasks can be created by humans, by Agents, or by Generator/Mission runs.                                     |

These three concepts are **core domain concepts**, not plugins. They **use** the existing plugin system (AI providers, Git providers, search providers, etc.) but are not themselves implemented as plugins. This is recorded as a design decision in [ADR-006](../decisions/006-agents-skills-tasks-as-core-not-plugins.md).

The current platform already has a **platform-managed** "Work Agent" — `WorkAgentGoal` / `WorkAgentRun` / `WorkAgentRunLog` / `WorkAgentPreference` ([`packages/agent/src/entities/work-agent-goal.entity.ts`](../../../packages/agent/src/entities/work-agent-goal.entity.ts)) — which autonomously generates Ideas from a user goal and drives the Mission tick worker. That feature is **untouched** by this work. The new `Agent` entity introduced here is **user-defined**, named, persistent, and runs alongside the existing Work Agent without replacing it. See §11 for the exact distinction.

## 2. Cross-cutting goals

| #     | Goal                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **Additive only**. Every existing surface — sidebar, Work/Mission/Idea detail pages, generators, plugins page, dashboard — keeps its current behavior. New tabs/pages/buttons are added; nothing is removed or renamed. (Project [NN #20](file:///C:/Coding/Workspace/AGENTS.md).) |
| **G2** | **Reuse plugins, don't replace them.** Agents pick an AI provider plugin the same way a Work generator does today — via `AiFacadeService` with `providerOverride` resolution. Agents pick a Git provider via `GitFacadeService` the same way. |
| **G3** | **Repo is the source of truth for definitions.** Agent definitions (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md`, `agent.yml`) and Skill definitions (`<skill>.md`) live in Git repos and are mirrored to DB for fast read. Same posture as Works' source-of-truth GitHub repos (Constitution Principle III). |
| **G4** | **Modular**. New tab on Work page = its own folder under `apps/web/src/app/[locale]/(dashboard)/works/[id]/agents/`. Same for Mission/Idea. New API module lives at `apps/api/src/agents/`, with companion modules for `skills/` and `tasks/`. |
| **G5** | **Cost-aware**. Every AI call an Agent makes records a `PluginUsageEvent` already today; the new `AgentBudget` reuses the existing polymorphic-owner pattern that landed for `work_budgets` (`packages/agent/src/budgets/`) so per-Agent budgets enforce the same way. |
| **G6** | **Observable**. Every Agent run, every Task transition, every Skill invocation lands in `ActivityLog` ([`packages/agent/src/entities/activity-log.entity.ts`](../../../packages/agent/src/entities/activity-log.entity.ts)) with new action types, surfaced in the live Activity feed. |
| **G7** | **Trigger.dev for long-running work.** Agent heartbeats and Task execution that drive AI calls run as Trigger.dev tasks via the existing dispatcher pattern (see [`trigger-integration.md`](./trigger-integration.md)). |

## 3. Scoping and ownership cascade

An Agent has **exactly one primary scope**, drawn from this hierarchy:

```
Tenant (user) ──┬── Mission ──┬── Idea ──┐
                │             │          ├── Work ── (Artifact: site / directory / repo)
                │             └── (Idea-scoped Agent)
                └── (Mission-scoped Agent)
                                                    └── (Work-scoped Agent)
(Tenant-scoped Agent)
```

| Scope            | What it sees                                                                                                                                  | Where its definition lives                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Tenant**       | Any of the user's Missions, Ideas, Works. May be linked to multiple targets via `AgentMembership` (many-to-many).                             | In the user's "control" repo (see §4.5) or DB-only if user has no control repo yet.              |
| **Mission**      | The Mission, its Ideas, and the Works derived from them.                                                                                       | `<missionRepo>/.works/agents/<agent-slug>/` — same repo the Mission entity already points at via `Mission.missionRepo` ([`mission.entity.ts`](../../../packages/agent/src/entities/mission.entity.ts)). |
| **Idea**         | The Idea and (if/when accepted) its derived Work. Idea-scoped Agents are usually short-lived: drafting, reviewing, refining the proposal.     | Inside the parent Mission's repo under `.works/ideas/<idea-id>/agents/<agent-slug>/`, OR (if Idea has no Mission) in the Idea's own scratch path. See §4.5. |
| **Work**         | The Work, its data repo, its website repo, its items, KB, generators.                                                                          | `<workDataRepo>/.works/agents/<agent-slug>/` — same data repo `works.yml` lives in.              |

Agents may be **promoted** (Idea-scoped → Mission-scoped, Mission-scoped → Tenant-scoped) but not demoted. Promotion preserves the agent's `id`, conversation history, budget ledger, and skill bindings.

**Membership for tenant-scoped Agents.** A tenant-scoped Agent has an `AgentMembership` row per Mission/Idea/Work it's connected to. The same Agent can be a member of many targets. By default a tenant-scoped Agent is "available to all" — `AgentMembership.scope = '*'` — meaning it's discoverable everywhere; users can also narrow it to an explicit set of targets.

**Mission-scoped agent membership.** A Mission-scoped Agent has implicit access to its Mission + all child Ideas + all derived Works. A user may further restrict it to a subset via the agent's `targets` JSON column (see [features/agents/plan.md §3](../features/agents/plan.md)).

**Task assignment rules.** An Agent can only assign tasks to other Agents that fall within its scope:

| Assigning agent's scope | Assignable targets                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Tenant                  | Any other Agent the assigning user owns (Tenant, Mission, Idea, Work).                        |
| Mission                 | Agents on the same Mission, its Ideas, or its Works. **Not** other Missions.                  |
| Idea                    | Agents on the same Idea, or the Idea's parent Mission (if shared), or the Idea's Work.        |
| Work                    | Agents on the same Work only.                                                                  |

Permission to assign at all is gated by the agent's `permissions.canAssignTasks` flag (see §5).

## 4. Storage model

### 4.1 Database tables (new)

All entities live under `packages/agent/src/entities/`. Each ships with a forward-only TypeORM migration in `apps/api/src/migrations/` (Constitution Principle V).

| Table                         | Purpose                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                      | The user-defined Agent. Columns: id, userId, scope (enum), missionId?, ideaId?, workId?, name, title, capabilities (text), aiProviderId?, modelId?, status (enum), permissions (jsonb), targets (jsonb), heartbeatCadence (cron or `manual`), nextHeartbeatAt, lastRunAt, lastRunStatus, errorCount, pauseAfterFailures, createdAt, updatedAt. |
| `agent_memberships`           | M:N link from a tenant- or mission-scoped Agent to Missions/Ideas/Works. Polymorphic `ownerType` + `ownerId`, reusing the polymorphic-owner shape from the existing `work_budgets` table. |
| `agent_runs`                  | One row per heartbeat or task-driven execution. Status (queued/running/completed/failed/cancelled), triggerKind (heartbeat/manual/task/event), startedAt, finishedAt, durationMs, errorMessage, summary, triggerRunId (Trigger.dev run id). |
| `agent_run_logs`              | Per-run structured log lines (level / step / message / metadata). Same shape as `work_agent_run_logs` ([`packages/agent/src/entities/work-agent-run-log.entity.ts`](../../../packages/agent/src/entities/work-agent-run-log.entity.ts)) but FK to `agent_runs.id`. |
| `agent_budgets`               | Per-Agent budget. Owner = Agent. Columns: id, agentId, intervalUnit (hour/day/week/month/unlimited), capCents, currency, allowOverage, intervalAnchor. Reuses the polymorphic-owner pattern from `work_budgets`. |
| `skills`                      | A skill definition (slug, title, description, instructionsMd, frontmatter, scope, ownerType, ownerId, contentHash, sourcePath). Hierarchy enforced by ownerType+ownerId; uniqueness on (slug, ownerType, ownerId). |
| `skill_bindings`              | Many-to-many: which skills are attached to which Agent. Also used for binding Tenant/Mission skills to a Work/Mission/Idea so Generators can inject them. Polymorphic `targetType` + `targetId`. |
| `tasks`                       | The task entity. See §4.4 + [features/task-tracking/plan.md §3](../features/task-tracking/plan.md) for full schema. |
| `task_assignees`              | M:N link from a Task to Users **or** Agents. Polymorphic assigneeType ∈ {user, agent}. |
| `task_blocks`                 | M:N: `taskId` is blocked by `blockedByTaskId`. |
| `task_reviewers`              | Same shape as `task_assignees` but for reviewers. |
| `task_approvers`              | Same shape as `task_assignees` but for approvers. |
| `task_attachments`            | File attachments stored via the existing KB upload path ([`packages/agent/src/entities/work-knowledge-upload.entity.ts`](../../../packages/agent/src/entities/work-knowledge-upload.entity.ts)) but FK to Task. |
| `task_chat_messages`          | Flat chat log per Task. authorType ∈ {user, agent}, authorId, body, mentions (jsonb), attachments (jsonb), createdAt. No threading. |
| `task_relations`              | M:N "related to": `taskId` ↔ `relatedTaskId`, with relation kind (related, duplicates, follow-up). |

### 4.2 What is NOT stored in DB

- **Agent prompt files** (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`) are the source of truth in the Git repo and only **mirrored** to a fast-read cache (the `agents` row stores a content hash; full body is fetched from Git on demand with a 5-minute LRU like the existing model-catalog cache, see [`ai-facade.md`](./ai-facade.md)).
- **Skill body text** is similarly the source of truth in Git. The `skills` row stores frontmatter + content hash; the body is read from Git on resolution.
- **Skill catalog (platform default)** is shipped in the repo at `apps/api/src/skills/catalog/` (same packaging discipline used for the Mission Templates catalog seeded on `develop`). It is NOT stored in the DB until a tenant **installs** a skill, at which point a `skills` row is created.

### 4.3 Git repo layout

For Mission-scoped Agents/Skills, the canonical layout under the existing `Mission.missionRepo` is:

```
<missionRepo>/
├── .works/
│   ├── mission.yml                              # already defined by MissionTemplateManifestService on develop
│   ├── agents/
│   │   ├── ceo/
│   │   │   ├── agent.yml                        # metadata: name, model, provider, budget, permissions
│   │   │   ├── SOUL.md                          # who am I; identity, voice
│   │   │   ├── AGENTS.md                        # who I am, what I'm responsible for, who reports to me
│   │   │   ├── HEARTBEAT.md                     # what I do on each tick when idle
│   │   │   ├── TOOLS.md                         # which tools/plugins I'm allowed to call
│   │   │   └── skills/                          # per-agent skill MD files (private to this agent)
│   │   │       └── investor-update.md
│   │   └── vp-engineering/
│   │       └── ...
│   ├── skills/                                  # Mission-level shared skills (available to all agents in this Mission)
│   │   └── pr-review.md
│   └── ideas/<idea-id>/
│       └── agents/<agent-slug>/...              # Idea-scoped agents (rarer; usually short-lived)
└── README.md
```

For Work-scoped Agents/Skills, the same `.works/agents/` and `.works/skills/` subtree lives under the Work's **data repo** (the repo `works.yml` lives in, parsed by `WorksConfigService`, [`packages/agent/src/works-config/services/works-config.service.ts`](../../../packages/agent/src/works-config/services/works-config.service.ts)).

For Tenant-scoped Agents, see §4.5.

### 4.4 YAML cross-references

The existing `works.yml` (already supports `name`, `initial_prompt`, `model`, `providers`, `schedule`, `website_repo`, `deployProvider`, `activity_sync` per `WorksConfigService`) gains an **additive** `agents:` section:

```yaml
# .works/works.yml — ADDITIONS, none of the existing fields change
agents:
    - slug: ceo
      path: .works/agents/ceo # relative to repo root
    - slug: vp-engineering
      path: .works/agents/vp-engineering

skills:
    - slug: pr-review
      path: .works/skills/pr-review.md
```

The same shape is added to `.works/mission.yml` (defined by `MissionTemplateManifestService` on develop). Schema additions are documented in [features/agents/spec.md §7](../features/agents/spec.md) and [features/skills/spec.md §6](../features/skills/spec.md).

Mission Templates may pre-declare agents and skills in their `.works/mission.yml`; when a user instantiates a Mission from a Template, the scaffolder copies `.works/agents/` and `.works/skills/` from the template repo into the freshly-created Mission repo, and inserts corresponding DB rows.

### 4.5 Tenant-scoped agents: where do their files live?

A tenant-scoped Agent has no natural "owning repo". Two paths, applied in order:

1. **If the user has a tenant control repo** (a future addition tracked by [features/agents/spec.md §8 Open Questions Q1](../features/agents/spec.md)): files live in `<controlRepo>/.works/agents/<slug>/` and `<controlRepo>/.works/skills/<slug>.md`.
2. **Otherwise**: the Agent's prompt files live in DB-only mode. The `agents` row carries the four MD files inline in TEXT columns (no hash, no Git mirror). When the user later creates a control repo, the platform offers a one-click "export tenant Agents to repo" migration.

Either way, the API surface and UI are identical — `GET /agents/:id/files/AGENTS.md` returns the body whichever way it's stored.

## 5. Permissions model

Each Agent carries a `permissions` JSON column. Values default conservatively to `false`:

```typescript
interface AgentPermissions {
    canCreateAgents: boolean; // may create new Agents within its scope
    canAssignTasks: boolean; // may assign tasks to other Agents within its scope
    canEditSkills: boolean; // may edit/add skills (own + shared in scope)
    canEditAgentFiles: boolean; // may edit own SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md
    canSpend: boolean; // may make paid AI calls (off ⇒ heartbeats no-op; useful for dry-run agents)
    canCommitToRepo: boolean; // may write files to the scope's repo (MD content, item updates, etc.)
    canOpenPullRequests: boolean; // may open PRs against the scope's repo (escalation over canCommitToRepo)
    canCallExternalTools: boolean; // gate for the future per-tool ACL in TOOLS.md
}
```

Tenant-scoped Agents may, with `canCreateAgents = true`, create lower-scoped Agents. Work-scoped Agents may only create other Work-scoped Agents within the same Work, etc. The cascade is enforced by `AgentService.create(parentAgentId, dto)` rejecting requests that escape the parent's scope.

Permissions are evaluated server-side on **every** AI call, task assignment, skill mutation, and repo commit. The web client surfaces them as a toggle grid in the Agent settings panel.

## 6. Lifecycle

A user-defined Agent has one of these statuses, stored as a string enum on `agents.status`:

| Status      | Meaning                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `draft`     | Agent created but never run. Heartbeat dispatcher skips it.                                                   |
| `active`    | Heartbeat dispatcher considers it on each tick. Available to receive tasks from other Agents and humans.      |
| `running`   | An `agent_run` row is currently in flight for this Agent. Transitional — the dispatcher CAS-claims this state. |
| `paused`    | User-paused. Dispatcher skips. Existing in-flight runs continue.                                              |
| `error`     | Last terminal run failed and `errorCount` has crossed the `pauseAfterFailures` threshold. UI shows a banner.   |
| `archived`  | Soft-deleted by user. Hidden from active list; row kept for audit/cost history.                                |

Status transitions are documented in [features/agents/spec.md §3](../features/agents/spec.md).

The **Agents page filter chips** map to a coarser grouping: `All / Active (active+running) / Paused / Error`. This mirrors the existing Works kanban column mapping in [`apps/web/src/components/works/WorksKanbanView.tsx`](../../../apps/web/src/components/works/WorksKanbanView.tsx).

## 7. Runtime: how an Agent actually does work

An Agent gets work in three ways:

1. **Heartbeat tick.** A Trigger.dev cron task (`agentHeartbeatDispatcherTask`, modeled on the existing `workScheduleDispatcherTask`) polls every `agents.status='active'` row whose `heartbeatCadence` is due. The dispatcher CAS-claims the row, enqueues an `agent_runs` row in `running` state, and calls `runs.trigger('agent-heartbeat', { agentId, runId })`. The heartbeat task bootstraps NestJS, fetches the Agent's prompt files + bound skills + recent activity, and asks `AiFacadeService.askJson()` for the next action. Same machinery as `work-schedule-dispatcher`.
2. **Task assignment.** When a Task transitions to `in_progress` and an Agent is in `task_assignees`, an `agent-task-execute` Trigger.dev run is dispatched. The Agent's prompt context is loaded the same way as a heartbeat run, but the task description, attachments, mentioned KB files, and chat history become the immediate context. The Agent's reply lands as a `task_chat_messages` row.
3. **Inline mention / chat reply.** When a human posts a `task_chat_messages` row that `@mentions` an Agent (and the Agent is an assignee/reviewer/approver of that task), a small `agent-chat-reply` Trigger.dev run is dispatched, scoped narrowly to the chat thread. This is the lightweight path.

All three paths share `AgentRunService.execute(agentId, context)`:

```
load(agent) → load(skill bindings) → load(scope's files) → assemble prompt
  → resolve AI provider via AiFacadeService.resolvePlugin({providerId, userId, workId})
  → enforce AgentBudget cap via BudgetGuardService (existing service, extended for owner=agent)
  → call AI provider (chat/askJson/stream depending on operation)
  → record PluginUsageEvent (existing flow)
  → write summary + outcome to agent_runs row
  → emit activity_log rows for every meaningful step
  → optional: commit any file changes via GitFacadeService
```

The "resolve AI provider" step is identical to today's Work generator path — `BaseFacadeService.resolvePlugin()` ([`packages/agent/src/facades/base.facade.ts`](../../../packages/agent/src/facades/base.facade.ts)) — except the new resolution order is:

```
Agent.aiProviderId    (per-Agent explicit choice)
  → Work/Mission/Idea active provider (scope-specific binding)
  → User default provider
  → Admin default provider
```

## 8. Skills: definition and injection

A Skill is a markdown file shaped like an Anthropic Skill: YAML frontmatter on top, instructions in the body.

```markdown
---
name: pr-review
description: Review a pull request and post inline comments grouped by severity.
allowed-tools: [github, semgrep]
---

# Steps

1. ...
```

Resolution hierarchy when an Agent or Generator looks up "what skills do I have available?":

```
platform catalog  (apps/api/src/skills/catalog/)
  ← shipped with the platform; ~1000+ entries expected; never written to from runtime
tenant installed   (skills row, ownerType='tenant', ownerId=userId)
  ← rows materialized when user installs a catalog skill OR creates a tenant skill
Mission installed  (skills row, ownerType='mission', ownerId=missionId)
Idea installed     (skills row, ownerType='idea', ownerId=ideaId)
Work installed     (skills row, ownerType='work', ownerId=workId)
Agent (private)    (skills row, ownerType='agent', ownerId=agentId, marked agentPrivate=true)
```

**Injection into Generators.** A `skill_bindings` row with `targetType='work'` (or `'mission'` / `'idea'`) and `injectIntoGenerator = true` causes that skill to be added to the system message for any generator run on that target. The injection happens in `AiFacadeService.assembleSystemMessage()` (new helper alongside `resolveModel`, [`packages/agent/src/facades/ai.facade.ts`](../../../packages/agent/src/facades/ai.facade.ts)) where the resolved skills' bodies are concatenated under a `## Skills` section into the system prompt. This mirrors how `WorkAdvancedPrompts` already augments generation prompts ([`packages/agent/src/entities/work-advanced-prompts.entity.ts`](../../../packages/agent/src/entities/work-advanced-prompts.entity.ts)).

**Triggering style.** Skills follow Anthropic's "progressive disclosure" pattern. By default, a Skill's frontmatter `description` and the first ~200 chars of its body are injected as a system-message hint; the AI provider only requests the full body when context warrants it. This keeps prompt sizes manageable even with many skills bound. The exact injection budget is set per-Agent via `agent.yml: maxSkillContextTokens` (default 4000).

The full Skills design is in [features/skills/spec.md](../features/skills/spec.md).

## 9. Tasks: minimal but extensible

A Task has:

- Identity: `id`, `slug` (short human-readable), `userId`, scope (workId? / missionId? / ideaId?).
- Status: enum `(backlog, todo, in_progress, in_review, blocked, done, cancelled)`.
- Priority: enum `(p0, p1, p2, p3, p4)`.
- Labels: `string[]` (tags).
- Cardinality: `parentTaskId?`, and via join tables: assignees, reviewers, approvers, blockers, relations.
- Body: a `description` markdown field (rendered via the existing Tiptap editor used in `KbEditor.tsx`).
- Lineage: `createdBy` (polymorphic: user OR agent), `startedAt`, `completedAt`, `createdAt`, `updatedAt`.
- Side channels: attachments (FK to existing KB upload table), KB mentions (Wikilinks parsed by the existing `WikiLinkExtension` in `KbEditor.tsx`), chat (flat).

**External task tracker plugin (future, not part of v1).** A new `task-tracker` plugin capability is reserved for a later release. When set on a Mission/Idea/Work, the platform proxies create/update/list calls to e.g. a Linear or GitHub Issues plugin instead of using `tasks` rows. The plugin interface lives in `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts` from day one (declared but not consumed) so v1 specs can reference it. This deferred path is ADR-flagged at [features/task-tracking/spec.md §8 Q3](../features/task-tracking/spec.md).

Full Task design in [features/task-tracking/spec.md](../features/task-tracking/spec.md).

## 10. Activity log additions

New `ActivityActionType` enum values, all using the existing `activity_log` table ([`packages/agent/src/entities/activity-log.entity.ts`](../../../packages/agent/src/entities/activity-log.entity.ts)):

| Type                            | When emitted                                                              |
| ------------------------------- | ------------------------------------------------------------------------- |
| `AGENT_CREATED`                 | User creates an Agent.                                                    |
| `AGENT_PAUSED` / `AGENT_RESUMED`| User changes status.                                                      |
| `AGENT_HEARTBEAT_STARTED`       | Trigger.dev kicked off a heartbeat run.                                   |
| `AGENT_HEARTBEAT_COMPLETED`     | Run reached `completed`.                                                  |
| `AGENT_HEARTBEAT_FAILED`        | Run reached `failed`.                                                     |
| `AGENT_FILE_EDITED`             | SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md edited (committed to repo). |
| `AGENT_BUDGET_EXCEEDED`         | Heartbeat or task execution refused due to budget cap.                    |
| `SKILL_INSTALLED`               | User installed a platform catalog skill at any scope.                     |
| `SKILL_ATTACHED_TO_AGENT`       | User attached a Skill to an Agent (binding row created).                  |
| `SKILL_INVOKED`                 | An AI call's response shows the model used a specific skill.              |
| `TASK_CREATED` / `TASK_UPDATED` | Task transitions.                                                          |
| `TASK_ASSIGNED`                 | A user or Agent became an assignee.                                       |
| `TASK_COMMENTED`                | A `task_chat_messages` row was inserted.                                  |
| `TASK_COMPLETED`                | Status moved to `done`.                                                   |

The `details` JSON column carries event-specific payloads. Live activity feed (poll-based today, [`apps/web/src/components/works/detail/activity/ActivityFeedClient.tsx`](../../../apps/web/src/components/works/detail/activity/ActivityFeedClient.tsx)) gets new icon mappings — additive on the existing `FeedRow` switch.

## 11. Relationship to the existing "Work Agent"

The platform already has a `WorkAgentGoal`/`WorkAgentRun` system that **autonomously generates Ideas** from a user-provided Goal ([`packages/agent/src/entities/work-agent-goal.entity.ts`](../../../packages/agent/src/entities/work-agent-goal.entity.ts), `apps/api/src/work-agent/`). Mission ticks also use this engine to spawn child Ideas. Crucially:

| Aspect                | Existing "Work Agent" (platform-managed)                              | New "Agent" (user-defined)                                                            |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Identity**          | Anonymous; there is exactly one Work Agent per user.                  | Named (e.g. "CEO"); user creates many.                                                |
| **Persistence**       | Runs are stateless; only Goal + Preference rows persist.              | Persistent entity; has files, budget, history, conversation across runs.              |
| **What it does**      | Proposes Ideas, plans Work creation, requires user approval.          | Anything its prompt + skills + tools enable — drafts, reviews, code, content, chat.   |
| **Where its prompts live** | Hardcoded in the API service code.                                | Markdown files in the scope's Git repo.                                               |
| **Cardinality scope** | One per user.                                                          | Many per user, scoped to Tenant/Mission/Idea/Work.                                    |

The two coexist permanently. The Work Agent stays as the **default** way the platform turns a Goal into Ideas and Ideas into Works. User-defined Agents are the **optional, advanced** layer that does more specialized work.

## 12. Touchpoints with existing surfaces

### 12.1 Sidebar additions

Order (additive, nothing removed) — see [features/agents/spec.md §5.1](../features/agents/spec.md) for exact i18n keys:

```
Dashboard
Missions          (existing)
Ideas             (existing)
Works             (existing)
Tasks             ← NEW (below Works, per user spec)
Agents            ← NEW (above Templates, below Works/Tasks)
Templates         (existing — pushes down by 2)
Plugins           (existing)
Skills            ← NEW (right below Plugins)
Activity          (existing)
Settings          (existing)
```

The user spec said "Agents above Templates, below Works" and "Skills below Plugins" — both satisfied. "Tasks below Works" places Tasks between Works and Agents.

### 12.2 Tabs on existing detail pages

**Important finding from research:** Only the Work detail page has a tab strip today ([`WorkTabs.tsx`](../../../apps/web/src/components/works/detail/WorkTabs.tsx)). Mission detail renders a single-column section layout (Overview / live runs / Ideas / Works / Spend / Activity / Clone affordance); Idea has no dedicated detail page (Ideas show as cards on Missions and `/ideas`). Adding new "tabs" to Mission/Idea pages is therefore **creating** a tab strip there for the first time.

See [QUESTIONS F1](../QUESTIONS-agents-skills-tasks.md#f1--missionidea-detail-pages-dont-have-tab-strips-today) for the open choice.

| Page                      | Existing structure                                                                            | Proposed change                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/works/[id]`             | Tab strip ([`WorkTabs.tsx`](../../../apps/web/src/components/works/detail/WorkTabs.tsx)): Overview / Activity / Items / KB / Generator / Plugins / Deploy / Settings | **Append tabs**: Agents, Skills, Tasks (before Settings). No structural change.                                |
| `/missions/[id]`          | Single-column sections (`MissionDetailClient.tsx`). No tab strip.                              | Promote to tabbed layout: "Overview" tab holds the current sections; add Agents, Skills, Tasks as new tabs.    |
| `/ideas/[id]`             | No detail page today; Ideas render as cards in lists.                                          | Create the detail page with tabs Overview / Build / Activity / Agents / Tasks. Skills inherited from parent Mission/Tenant only — no tab. |

### 12.3 Dashboard additions

Two new stat blocks below the existing tile row (which today is `[Missions][Ideas][Works][Items][Sites][Spend]`):

- **Agents enabled** — count of `status='active'` agents across all scopes.
- **Tasks in progress** — count of `status='in_progress'` tasks, with sub-counts "open" (`backlog+todo`) and "blocked" surfaced in a tooltip.

And a "Recent Tasks" list below the existing "Recent Works" preview, identical visual treatment, with a "View all (N)" link to `/tasks`.

### 12.4 Generator-side Skill injection

A new tab "Skills" on the Work detail page (between Generator and Plugins per the user's spec). UI follows the [Plugins page pattern](../../../apps/web/src/components/plugins/PluginsList.tsx) (installed + available, sortable). Skills marked **active** on this Work are injected into the system message for any generator run on this Work. See [features/skills/plan.md §4](../features/skills/plan.md).

## 13. Background jobs

Three new Trigger.dev tasks, all modeled on the shipped `work-schedule-dispatcher` (see [`trigger-integration.md` §10](./trigger-integration.md)).

| Task ID                          | Kind | Cadence                  | What it does                                                                                                    |
| -------------------------------- | ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `agent-heartbeat-dispatcher`     | cron | every `AGENT_DISPATCH_INTERVAL_MINUTES` minutes (default 1) | Polls due Agents (`status='active'` AND `nextHeartbeatAt <= now()`), CAS-claims, dispatches `agent-heartbeat` runs. |
| `agent-heartbeat`                | one-shot, 30 min max | dispatched | Single Agent's heartbeat tick — load context, call AI, write changes, emit activity.                                        |
| `agent-task-execute`             | one-shot, 1 hour max | dispatched | One Agent working on one Task — load context, call AI, post chat message, transition Task if instructed.                    |

The existing remote-proxy callback channel from [ADR-002](../decisions/002-trigger-worker-callback-channel.md) is reused unchanged — the worker calls `POST /internal/trigger/remote/call` with `x-trigger-secret` and `AgentService`/`TaskService` are exposed via `createRemoteProxy()`.

## 14. Observability

- **Activity log**: all new event types above, with `details.agentId` / `details.taskId` populated for filtering.
- **Sentry tags**: `agent.id`, `agent.scope`, `task.id`, `run.kind` propagated through the existing logger bridge (see [`trigger-worker.md`](./trigger-worker.md)).
- **PostHog events**: `agent_created`, `agent_paused`, `task_created`, `skill_installed` mirrored from activity log for product analytics.
- **Per-Agent metrics tab**: input/output/cached token totals, USD cost (by day / week / month), bound skill list, last-N runs. Reads the existing `plugin_usage_events` table joined on a new `agentId` column (additive — see [features/agents/plan.md §3.3](../features/agents/plan.md)).

## 15. Constitution gates

| Principle                                            | Status   | Notes                                                                                                                          |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| I — Plugin-First                                     | OK       | Agents/Skills/Tasks are not new plugin categories. They USE AI/Git/search plugins. A future `task-tracker` capability is reserved (§9). |
| II — Capability-Driven Resolution                    | OK       | Agent picks AI provider via `AiFacadeService.resolvePlugin` (no hardcoded provider ID).                                         |
| III — Source-of-Truth Repositories                   | OK       | Agent/Skill definitions live in Git; DB stores only metadata + content hash + last-known body cache.                            |
| IV — Background Work via Trigger.dev                 | OK       | Heartbeat dispatcher + per-Agent + per-Task tasks shipped.                                                                       |
| V — Forward-Only Migrations                          | OK       | Every new table ships with an additive TypeORM migration in the same PR.                                                        |
| VI — Tests Prerequisite                              | OK       | Agent service unit tests (Jest), Skill resolver unit tests, Task chat E2E (Playwright), plugin contract test for `task-tracker`. |
| VII — Secret Hygiene                                 | OK       | Agents do not store their own credentials; they reuse plugin settings via the existing 3-tier cascade.                          |
| VIII — Plugin Counts Single Source                   | N/A      | No new plugin shipped in v1.                                                                                                     |
| IX — Behaviour-First Specs                           | OK       | Feature specs describe user behavior; this architecture doc reserves implementation detail.                                     |
| X — Backwards Compatibility                          | OK       | `agents:` / `skills:` sections added to `works.yml` and `mission.yml` are optional; old configs remain valid.                   |

## 16. Open questions

The detailed open questions are consolidated in [`../QUESTIONS-agents-skills-tasks.md`](../QUESTIONS-agents-skills-tasks.md). Headlines that affect the architecture in this doc:

- **Tenant control repo (v1 or v2?)** — affects §4.5. Default: defer to v2; tenant Agent files inline in DB. See [ADR-008](../decisions/008-tenant-control-repo-deferred-to-v2.md).
- **Skill catalog placement** — affects §4.2 / §8. Default: in-monorepo. See [ADR-007](../decisions/007-skill-catalog-in-monorepo.md).
- **Mission/Idea detail tab strips** — affects §12.2. Default: create the tab strip when adding the new tabs.
- **Tenant Agent cross-Mission visibility** — affects §3. Default: yes by default.
- **Persist Mission tick cap-hit events** — current gap on develop; small fix, decide whether to land here or separately.

## 17. References

- [`features/agents/spec.md`](../features/agents/spec.md) — Agents product spec.
- [`features/agents/plan.md`](../features/agents/plan.md) — Agents implementation plan.
- [`features/agents/tasks.md`](../features/agents/tasks.md) — Agents task breakdown.
- [`features/skills/spec.md`](../features/skills/spec.md) — Skills product spec.
- [`features/skills/plan.md`](../features/skills/plan.md) — Skills implementation plan.
- [`features/skills/tasks.md`](../features/skills/tasks.md) — Skills task breakdown.
- [`features/task-tracking/spec.md`](../features/task-tracking/spec.md) — Task-tracking product spec.
- [`features/task-tracking/plan.md`](../features/task-tracking/plan.md) — Task-tracking implementation plan.
- [`features/task-tracking/tasks.md`](../features/task-tracking/tasks.md) — Task-tracking task breakdown.
- [`features/missions-ideas-works/spec.md`](../features/missions-ideas-works/spec.md) — Parent hierarchy this layer sits inside.
- [`decisions/006-agents-skills-tasks-as-core-not-plugins.md`](../decisions/006-agents-skills-tasks-as-core-not-plugins.md) — Why these are core, not plugins.
- [`ai-facade.md`](./ai-facade.md) — Provider resolution and cost tracking re-used by Agents.
- [`settings-system.md`](./settings-system.md) — 3-tier settings cascade applied to Agent provider/model choice.
- [`trigger-integration.md`](./trigger-integration.md) — Worker dispatch and callback channel re-used by Agent heartbeats.
- [`activity-log.md`](./activity-log.md) — Activity feed re-used and extended.
- [`agent-prompt-assembly.md`](./agent-prompt-assembly.md) — exact prompt-assembly recipe (companion deep-dive).
- [`agent-tools-catalog.md`](./agent-tools-catalog.md) — canonical tool API surface exposed to Agents.
- [`security-agents-skills-tasks.md`](./security-agents-skills-tasks.md) — threat model and mitigations.
- [`../REVIEW-NOTES-agents-skills-tasks.md`](../REVIEW-NOTES-agents-skills-tasks.md) — round-3 critical-review notes.
- [`../QUESTIONS-agents-skills-tasks.md`](../QUESTIONS-agents-skills-tasks.md) — open questions.
- [`../features/user-journeys-agents-skills-tasks.md`](../features/user-journeys-agents-skills-tasks.md) — five end-to-end user stories.
- ADRs: [006](../decisions/006-agents-skills-tasks-as-core-not-plugins.md), [007](../decisions/007-skill-catalog-in-monorepo.md), [008](../decisions/008-tenant-control-repo-deferred-to-v2.md), [009](../decisions/009-tasks-vs-items-vs-kb-distinction.md).
- Constitution: [`.specify/memory/constitution.md`](../../../.specify/memory/constitution.md).
