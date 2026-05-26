# Implementation Plan: Agents

**Feature ID**: `agents`
**Spec**: [`./spec.md`](./spec.md)
**Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-05-25

---

## 1. Architecture Summary

```mermaid
flowchart TD
    subgraph Web["apps/web — Next.js"]
        Sidebar[DashboardSidebar.tsx adds Agents+Tasks+Skills items]
        AgentsList[/agents page — cards/table/filters]
        AgentDetail[/agents/[id] — Dashboard/Activity/Instructions/Skills/Budgets/Settings]
        InstrEditor[Tiptap MD editor — 5 files]
        WorkAgentsTab[/works/[id]/agents tab]
        MissionAgentsTab[/missions/[id]/agents tab]
        IdeaAgentsTab[/ideas/[id]/agents tab]
    end

    subgraph Api["apps/api — NestJS"]
        AgentCtrl[AgentsController]
        AgentSvc[AgentService]
        AgentFileSvc[AgentFileService]
        AgentRunSvc[AgentRunService]
        AgentBudgetCtrl[AgentBudgetController]
        InternalCtrl[TriggerInternalController — reused]
    end

    subgraph Agent["packages/agent"]
        AgentRepo[AgentRepository]
        AgentRunRepo[AgentRunRepository]
        AgentBudgetRepo[AgentBudgetRepository]
        AiFacade[AiFacadeService — existing, extended]
        GitFacade[GitFacadeService — existing]
        BudgetGuard[BudgetGuardService — existing, extended for owner=agent]
        ActivityLogSvc[ActivityLogService — existing, new event types]
    end

    subgraph Tasks["packages/tasks — Trigger.dev"]
        Dispatcher[agent-heartbeat-dispatcher cron]
        Heartbeat[agent-heartbeat task]
        TaskExec[agent-task-execute task]
        ChatReply[agent-chat-reply task]
    end

    subgraph Db["Postgres"]
        AgentsT[agents]
        AgentRunsT[agent_runs]
        AgentRunLogsT[agent_run_logs]
        AgentBudgetsT[agent_budgets]
        AgentMembershipsT[agent_memberships]
        PluginUsageEventsT[plugin_usage_events — existing, +agentId column]
        ActivityLogT[activity_log — existing, new actionTypes]
    end

    subgraph Github["GitHub — source of truth"]
        MissionRepo[missionRepo/.works/agents/CEO/SOUL.md]
        WorkRepo[work-data-repo/.works/agents/...]
    end

    Sidebar --> AgentsList
    AgentsList --> AgentDetail
    AgentDetail --> InstrEditor
    AgentDetail -- "PUT /agents/:id/files/SOUL.md" --> AgentCtrl
    AgentCtrl --> AgentSvc
    AgentCtrl --> AgentFileSvc
    AgentSvc --> AgentRepo
    AgentRepo --> AgentsT
    AgentFileSvc --> GitFacade --> Github
    AgentFileSvc -. "DB-only mode (tenant)" .-> AgentsT
    Dispatcher -. polls .- AgentsT
    Dispatcher -- "runs.trigger('agent-heartbeat')" --> Heartbeat
    Heartbeat -- "remote-proxy via x-trigger-secret" --> InternalCtrl
    InternalCtrl --> AgentRunSvc
    AgentRunSvc --> AiFacade
    AiFacade -- existing flow --> PluginUsageEventsT
    AgentRunSvc -- "writes summary" --> AgentRunsT
    AgentRunSvc -- "writes logs" --> AgentRunLogsT
    AgentRunSvc -- "emits events" --> ActivityLogT
    AgentRunSvc --> BudgetGuard
    BudgetGuard -. "extended check(ownerType='agent')" .- AgentBudgetsT
    BudgetGuard -. "aggregates from" .- PluginUsageEventsT
    TaskExec --> AgentRunSvc
    ChatReply --> AgentRunSvc
```

## 2. Tech Choices

| Concern                                | Choice                                                                                       | Rationale                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **DB persistence**                     | TypeORM entities under `packages/agent/src/entities/`                                         | Same pattern as Mission/WorkProposal already on develop.                                            |
| **Migrations**                         | `apps/api/src/migrations/<unixms>-CreateAgentsTables.ts` etc.                                 | Forward-only per Constitution V; self-applied on API boot via `migrationsRun: true`.                |
| **AI provider resolution**             | Extend `BaseFacadeService.resolvePlugin` to accept an `agentId` hint that overrides everything below it (matching FR-6/7/8). | Reuses the cascade existing for Work generators; zero new resolution code path.                    |
| **Budget enforcement**                 | Reuse `BudgetGuardService` with the polymorphic owner shape (already used for `work_budgets`).| One BudgetGuardService implementation handles both work and agent budgets via `ownerType`.          |
| **Heartbeat dispatch**                 | New Trigger.dev cron task `agent-heartbeat-dispatcher` modeled exactly on `workScheduleDispatcherTask` (`packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts`). | Same CAS-claim pattern, same polling-with-backoff, same exit conditions.                            |
| **Per-run state**                      | Trigger.dev `runs.trigger('agent-heartbeat', payload)` returns runId stored on `agent_runs.triggerRunId`. | Mirrors `WorkGenerationHistory.triggerRunId` usage.                                                  |
| **Worker → API callback**              | Existing `TriggerInternalController` + `x-trigger-secret` + `createRemoteProxy()` ([ADR-002](../../decisions/002-trigger-worker-callback-channel.md)). | New `AgentRunService` exposed via the existing internal RPC channel; no new transport.              |
| **File storage (Mission/Work scope)**  | `GitFacadeService.commit({owner, repo, message, changes: [{path, action, content}]})`         | Same call used today for `.works/works.yml` writes; commits to default branch with no PR by default.|
| **File storage (Tenant scope, v1)**    | Five TEXT columns on `agents`: `soulMd`, `agentsMd`, `heartbeatMd`, `toolsMd`, `agentYml`. UNIQUE constraint on (userId, scope='tenant', slug). | No control repo yet; ship with inline-mode and migrate later (spec Q1).                              |
| **Markdown editor**                    | Reuse `apps/web/src/components/works/detail/kb/KbEditor.tsx` (Tiptap + StarterKit + Link + Markdown export). | 800 ms autosave, dirty/saved indicator, same i18n, same DOM tree — zero new editor stack.            |
| **AI provider/model select**           | Reuse the provider+model selector from the Work generator dialog (`apps/web/src/components/works/forms/...`). | Identical drop-down shape with "Use account default" as first row.                                  |
| **Cron parsing**                       | `cron-parser` (already a dep via `WorkSchedule.cadence`).                                     | Same validator, same human-readable next-fire-time helper.                                          |
| **Activity feed re-use**               | `ActivityFeedClient.tsx` already polls; new event types only need new icon + label maps in `FeedRow`. | Polling architecture unchanged; we add rows, not transport.                                          |
| **Forms**                              | Raw `useState` + `useTransition` + server actions, matching the existing Work creation form `WorkManualForm.tsx`. | Project doesn't use react-hook-form anywhere yet; staying consistent.                               |
| **i18n**                               | next-intl JSON under `apps/web/messages/<locale>.json`, namespace `agents.*` and `dashboard.sidebar.navigation.agents`. | Same convention as every other surface.                                                              |
| **Path aliases in tests**              | Same `moduleNameMapper` Jest config that already resolves `@ever-works/*` to source.          | No new mapping needed.                                                                               |

## 3. Data Model

### 3.1 New entities

```typescript
// packages/agent/src/entities/agent.entity.ts
export enum AgentScope {
    TENANT = 'tenant',
    MISSION = 'mission',
    IDEA = 'idea',
    WORK = 'work'
}
export enum AgentStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    RUNNING = 'running',
    PAUSED = 'paused',
    ERROR = 'error',
    ARCHIVED = 'archived'
}

export interface AgentPermissions {
    canCreateAgents: boolean;
    canAssignTasks: boolean;
    canEditSkills: boolean;
    canEditAgentFiles: boolean;
    canSpend: boolean;
    canCommitToRepo: boolean;
    canOpenPullRequests: boolean;
    canCallExternalTools: boolean;
}

@Entity({ name: 'agents' })
@Index('uq_agents_user_scope_slug', ['userId', 'scope', 'missionId', 'ideaId', 'workId', 'slug'], { unique: true })
@Index('idx_agents_user_status', ['userId', 'status'])
@Index('idx_agents_next_heartbeat', ['status', 'nextHeartbeatAt'])
export class Agent {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') userId: string;

    @Column({ type: 'varchar', length: 16 }) scope: AgentScope;
    @Column('uuid', { nullable: true }) missionId?: string | null;
    @Column('uuid', { nullable: true }) ideaId?: string | null;     // FK to work_proposals
    @Column('uuid', { nullable: true }) workId?: string | null;

    @Column({ length: 120 }) name: string;
    @Column({ length: 80 }) slug: string;        // derived, kebab-case
    @Column({ length: 200, nullable: true }) title?: string | null;
    @Column({ type: 'text', nullable: true }) capabilities?: string | null;

    @Column({ length: 100, nullable: true }) aiProviderId?: string | null;
    @Column({ length: 100, nullable: true }) modelId?: string | null;

    @Column({ type: 'varchar', length: 16, default: AgentStatus.DRAFT })
    status: AgentStatus;

    @Column('simple-json', { default: () => `'${JSON.stringify({
        canCreateAgents: false,
        canAssignTasks: false,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: false,
        canOpenPullRequests: false,
        canCallExternalTools: false,
    })}'` })
    permissions: AgentPermissions;

    // Tenant-scoped Agents (with multi-target reach) carry a 'targets' array
    // of {type:'mission'|'idea'|'work', id:uuid}; '*' is "all".
    @Column('simple-json', { nullable: true }) targets?: AgentTarget[] | null;

    // Heartbeat
    @Column({ type: 'varchar', length: 64, nullable: true })
    heartbeatCadence?: string | null;                                       // cron expr or 'manual'
    @Column({ type: 'timestamp', nullable: true }) nextHeartbeatAt?: Date | null;
    @Column({ type: 'timestamp', nullable: true }) lastRunAt?: Date | null;
    @Column({ length: 16, nullable: true }) lastRunStatus?: string | null;
    @Column({ type: 'int', default: 0 }) errorCount: number;
    @Column({ type: 'int', default: 3 }) pauseAfterFailures: number;

    // DB-only mode for tenant Agents with no control repo (spec Q1)
    @Column({ type: 'text', nullable: true }) soulMd?: string | null;
    @Column({ type: 'text', nullable: true }) agentsMd?: string | null;
    @Column({ type: 'text', nullable: true }) heartbeatMd?: string | null;
    @Column({ type: 'text', nullable: true }) toolsMd?: string | null;
    @Column({ type: 'text', nullable: true }) agentYml?: string | null;
    @Column({ length: 64, nullable: true }) contentHash?: string | null;

    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

```typescript
// agent-run.entity.ts
@Entity({ name: 'agent_runs' })
@Index(['agentId', 'startedAt'])
export class AgentRun {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') agentId: string;
    @Column('uuid') userId: string;
    @Column({ length: 16 }) triggerKind: 'heartbeat' | 'manual' | 'task' | 'chat' | 'event';
    @Column({ length: 16 }) status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    @Column({ length: 64, nullable: true }) triggerRunId?: string | null;   // Trigger.dev run id
    @Column({ type: 'timestamp', nullable: true }) startedAt?: Date | null;
    @Column({ type: 'timestamp', nullable: true }) finishedAt?: Date | null;
    @Column({ type: 'int', nullable: true }) durationMs?: number | null;
    @Column({ type: 'text', nullable: true }) errorMessage?: string | null;
    @Column({ type: 'text', nullable: true }) summary?: string | null;
    @Column('uuid', { nullable: true }) taskId?: string | null;             // when triggerKind='task'
    @Column('uuid', { nullable: true }) chatMessageId?: string | null;      // when triggerKind='chat'
    @CreateDateColumn() createdAt: Date;
}
```

```typescript
// agent-run-log.entity.ts — clone of work-agent-run-log.entity.ts shape
@Entity({ name: 'agent_run_logs' })
export class AgentRunLog {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') runId: string;
    @Column({ length: 8 }) level: 'INFO' | 'WARN' | 'ERROR';
    @Column({ length: 80 }) step: string;
    @Column({ type: 'text' }) message: string;
    @Column('simple-json', { nullable: true }) metadata?: Record<string, unknown> | null;
    @CreateDateColumn() createdAt: Date;
}
```

```typescript
// agent-budget.entity.ts — owner=agent on existing polymorphic-owner shape
@Entity({ name: 'agent_budgets' })
@Index('uq_agent_budgets_agentId', ['agentId'], { unique: true })
export class AgentBudget {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') agentId: string;
    // v1 supports all 5 intervals per operator N6 override (round 9). Implements
    // multi-interval aggregator inside BudgetService (see tasks T34a in agents/tasks.md).
    @Column({ length: 16 }) intervalUnit: 'hour' | 'day' | 'week' | 'month' | 'unlimited';

    // Anchor timestamp for sub-month intervals. UTC. For 'month' = calendar-month boundary
    // (ignored at write; recomputed); for 'unlimited' = null. For 'hour'/'day'/'week' =
    // the moment the budget was created (or last reset) — periods roll forward from there.
    @Column({ type: 'timestamp', nullable: true }) intervalAnchor?: Date | null;
    @Column({ type: 'int' }) capCents: number;
    @Column({ length: 3, default: 'usd' }) currency: string;
    @Column({ type: 'boolean', default: false }) allowOverage: boolean;
    @Column({ type: 'timestamp', nullable: true }) intervalAnchor?: Date | null; // when current interval started
    @CreateDateColumn() createdAt: Date;
    @UpdateDateColumn() updatedAt: Date;
}
```

```typescript
// agent-membership.entity.ts
@Entity({ name: 'agent_memberships' })
@Index('uq_agent_membership', ['agentId', 'targetType', 'targetId'], { unique: true })
export class AgentMembership {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column('uuid') agentId: string;
    @Column({ length: 16 }) targetType: 'mission' | 'idea' | 'work' | 'wildcard';
    @Column('uuid', { nullable: true }) targetId?: string | null;            // null when targetType='wildcard'
    @CreateDateColumn() createdAt: Date;
}
```

### 3.2 Additive changes to existing entities

| Entity                | Change                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PluginUsageEvent`    | Add nullable `agentId uuid` column + index `(agentId, occurredAt)`. Existing rows left null.                   |
| `ActivityLog`         | Extend `ActivityActionType` enum with the values listed in [architecture §10](../../architecture/agents-skills-tasks.md). No table change. |
| `WorksConfig`         | Extend Zod schema in `packages/agent/src/works-config/services/works-config.service.ts` to accept optional `agents` + `skills` arrays. Reader stays backwards-compatible. |
| `MissionTemplateManifest` | Same additive extension in `MissionTemplateManifestService`'s Zod schema.                                  |

### 3.3 Forward-only migrations

| File (timestamp prefix omitted)                | What it does                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `CreateAgentsTables.ts`                        | Creates `agents`, `agent_runs`, `agent_run_logs`, `agent_budgets`, `agent_memberships` tables and all indexes. |
| `AddAgentIdToPluginUsageEvents.ts`             | Adds `agentId` uuid (nullable) column + `(agentId, occurredAt)` index.             |
| `AddAgentActivityActionTypes.ts`               | (No-op if action type is `varchar`; the API layer enforces enum.) Documents the new strings. |
| `AddAgentsAndSkillsArraysToConfigSchemas.ts`   | No DB change; ships as a marker migration that runs `assert` against the live schema for early-warning. Optional. |

## 4. API Surface

| Method | Endpoint                              | Description                                  | Auth     | Status    |
| ------ | ------------------------------------- | -------------------------------------------- | -------- | --------- |
| GET    | `/agents`                             | List user's Agents (filters: scope, status)  | session  | New       |
| POST   | `/agents`                             | Create a new Agent                           | session  | New       |
| GET    | `/agents/:id`                         | Read one (includes status, last run summary) | session  | New       |
| PATCH  | `/agents/:id`                         | Update name/title/capabilities/provider/model/cadence/permissions/budget partial | session | New |
| DELETE | `/agents/:id`                         | Soft-archive (status → archived)             | session  | New       |
| POST   | `/agents/:id/run-now`                 | Force a heartbeat now                        | session  | New       |
| POST   | `/agents/:id/pause`                   | Pause the Agent                              | session  | New       |
| POST   | `/agents/:id/resume`                  | Resume from paused/error                     | session  | New       |
| GET    | `/agents/:id/runs`                    | List recent runs (paginated)                 | session  | New       |
| POST   | `/agents/:id/runs/:runId/cancel`      | Cancel an in-flight run                      | session  | New       |
| GET    | `/agents/:id/files/:name`             | Read SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml | session | New |
| PUT    | `/agents/:id/files/:name`             | Write one file (commits to repo or DB)       | session  | New       |
| GET    | `/agents/:id/skills`                  | List bound skills (see Skills feature)       | session  | New       |
| GET    | `/agents/:id/budget`                  | Read current budget + interval spend         | session  | New       |
| PUT    | `/agents/:id/budget`                  | Upsert AgentBudget                           | session  | New       |
| POST   | `/agents/:id/assign-task`             | UI shortcut: create a Task already assigned  | session  | New       |
| POST   | `/internal/trigger/remote/call`       | Existing remote-proxy endpoint               | x-trigger-secret | Reused |

Validation via `class-validator` DTOs in `apps/api/src/agents/dto/`. Cross-user 404 (not 403) — same posture as AI Conversation.

Rate limits: default tenant-level throttler; `/agents/:id/run-now` capped at 5 RPM/user (prevent budget abuse via UI spam).

## 5. Plugin Surface

**Nothing new shipped as a plugin in v1.** Agents reuse `ai-provider`, `git-provider`, and (optionally) `search` / `screenshot` / `content-extractor` plugins via the existing facades.

**Future reservation (not in v1):**
- `packages/plugin/src/contracts/capabilities/task-tracker.interface.ts` — interface declared, no plugin implements it, no facade consumes it. Lets v1 specs reference it.

## 6. Web / CLI Surface

### 6.1 Web routes

| Route                              | File                                                                                       | Notes                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `/agents`                          | `apps/web/src/app/[locale]/(dashboard)/agents/page.tsx`                                    | Server component fetches list.     |
| `/agents/new`                      | `apps/web/src/app/[locale]/(dashboard)/agents/new/page.tsx`                                | Create dialog hosted as a page (mirrors `/works/new`). |
| `/agents/[id]`                     | `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx` → redirects to `/agents/[id]/dashboard` | Layout file holds the tab strip. |
| `/agents/[id]/dashboard`           | …                                                                                          | Default tab.                       |
| `/agents/[id]/activity`            | …                                                                                          | Reuses `ActivityFeedClient.tsx`.   |
| `/agents/[id]/instructions`        | …                                                                                          | 5-tab Tiptap editor.               |
| `/agents/[id]/skills`              | …                                                                                          | See Skills plan.                   |
| `/agents/[id]/budgets`             | …                                                                                          | Per-Agent budget editor.           |
| `/agents/[id]/settings`            | …                                                                                          | Provider, cadence, permissions, delete. |
| `/works/[id]/agents`               | tab added under `/works/[id]/` (extends existing `WorkTabs.tsx`)                            | Lists Work-scoped + member tenant Agents. |
| `/missions/[id]/agents`            | tab added under `/missions/[id]/` — **first tab strip on Mission detail; create `MissionTabs.tsx` modeled on `WorkTabs.tsx`. Default tab "Overview" wraps the current single-column section layout.** | Same listing shape. |
| `/ideas/[id]/agents`               | gated by Ideas getting a detail page first. **Recommended v1**: surface Agents in the per-Idea expansion drawer on `/ideas` instead. See plan §12.1 + [QUESTIONS F1](../../QUESTIONS-agents-skills-tasks.md#f1--missionidea-detail-pages-dont-have-tab-strips-today). | — |

### 6.2 Sidebar wiring

Patch `apps/web/src/components/dashboard/DashboardSidebar.tsx`:
- Insert new items in this order: after `Works` add `Tasks`, then `Agents`; the existing `Templates` shifts down; after `Plugins` add `Skills` (Activity shifts down).
- Icons (lucide-react): `Bot` for Agents, `ListChecks` for Tasks, `Sparkles` for Skills (or `BookOpen` if `Sparkles` reads too cute — the existing icon vocabulary in the sidebar prefers minimal outline glyphs).

### 6.3 Dashboard additions

Patch `apps/web/src/components/dashboard/`:
- Add `AgentsCountTile.tsx` + `TasksInProgressTile.tsx`.
- Add a "Recent Tasks" section below "Recent Works" using the same row/card primitives.

### 6.4 CLI

No new CLI commands in v1. Future addition: `ever agents list / run / pause` mirroring `ever works ...`.

## 7. Background Jobs

| Trigger ID                      | Cadence                                              | What it does                                                                                | Idempotency                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-heartbeat-dispatcher`    | cron, every `AGENT_DISPATCH_INTERVAL_MINUTES` (def 1) | Polls `agents WHERE status='active' AND nextHeartbeatAt <= now()` in batches of 200; CAS-updates to `running`; calls `runs.trigger('agent-heartbeat', {agentId, runId})`. | CAS update means a second worker on the same row sees `status='running'` and skips.                                                                |
| `agent-heartbeat`               | one-shot, maxDuration=30m                            | Bootstraps Nest, loads context (files+skills+recent activity), calls AI via facade, writes summary to `agent_runs`, emits activity, optional file commits. | `agentId+runId` is unique; replays a row already at `completed` are no-op'd.                                                                       |
| `agent-task-execute`            | one-shot, maxDuration=1h                             | Same shape, but loads Task description + attachments + chat history; outputs a `task_chat_messages` row plus optional Task status transition. | Replays guarded by check `taskId + agentId + last unprocessed chat message id` in `agent_runs.taskId/chatMessageId`.                                |
| `agent-chat-reply`              | one-shot, maxDuration=5m                             | Light path for inline mention reply.                                                        | Replays guarded by `chatMessageId`.                                                                                                               |

All three task implementations live in `packages/tasks/src/tasks/trigger/`. Dispatcher returns task output `{ scanned: N, claimed: M, dispatched: K }` for log/metrics surfaces.

## 7.1 Rate limits per endpoint

Following the platform's `@nestjs/throttler` 3-tier global config with per-route override pattern:

| Endpoint                          | Cap                      |
| --------------------------------- | ------------------------ |
| `POST /agents`                    | 30/min/user              |
| `POST /agents/:id/run-now`        | 5/min/user               |
| `POST /agents/:id/dry-run`        | 30/min/user              |
| `PUT /agents/:id/files/:name`     | 60/min/user (UI typing autosave) |
| `GET /agents/*`                    | global throttler only    |

## 8. Security & Permissions

- All `/agents/*` routes are `@CurrentUser()` scoped — cross-user reads return 404.
- The DTO for `POST /agents` enforces `scope` ⇔ `missionId|ideaId|workId` consistency and rejects any reference to a target the requesting user doesn't own.
- The `editAgentFile` tool exposed to AI has its path argument validated to be under the agent's own subtree.
- Secret scan on file writes: a regex sweep over the body looking for known secret prefixes (`sk-`, `xoxb-`, `AKIA`, `ghp_`, `glpat-`, …). Match ⇒ reject with a precise error.
- The internal `POST /internal/trigger/remote/call` endpoint stays gated by `x-trigger-secret` (existing).
- Budget enforcement is server-side; the UI may show stale spend but the API always recomputes from `plugin_usage_events`.
- Activity log rows never embed plaintext credentials (already enforced by existing redaction in the AI facade).

## 9. Observability

- Activity log: every event type from architecture §10 is wired through `ActivityLogService.recordActivity({actionType, workId?, details: {agentId, ...}})`.
- Sentry: per-run breadcrumbs with `agent.id`, `agent.scope`, `run.kind`; failures escalated as Sentry errors with the run id in the tags.
- PostHog: `agent_created`, `agent_paused`, `agent_archived`, `agent_heartbeat_succeeded`, `agent_heartbeat_failed`, `agent_budget_exceeded`.
- Worker-side logs bridge to API logs through the existing `logger-bridge` (`trigger-worker.md`).
- New admin tile on `/admin/usage`: per-Agent spend rollup (admin-only). Reuses existing `admin-usage.controller.ts`.

## 10. Phased Rollout

**Phase 1 — Data model + read-only API.**
1.1 Entities + migrations + repository classes + tests.
1.2 `AgentService` + `AgentsController` (list/get/create/patch/archive only; no runtime).
1.3 Patch `WorksConfigService` + `MissionTemplateManifestService` to accept optional `agents` array.
1.4 i18n keys + sidebar item (renders empty list page).

**Phase 2 — File storage + Instructions tab.**
2.1 `AgentFileService` (Git mode for Mission/Work scopes, DB inline for Tenant).
2.2 `/agents/[id]/instructions` Tiptap editor (reuse `KbEditor.tsx` with file-tab switcher).
2.3 `AGENT_FILE_EDITED` activity row.

**Phase 3 — Runtime.**
3.1 `agent-heartbeat-dispatcher` cron task + `AgentRunRepository` + CAS-claim logic.
3.2 `agent-heartbeat` Trigger.dev task + `AgentRunService.execute()` skeleton.
3.3 Extend `BudgetGuardService` for `ownerType='agent'` + add `agentId` to `plugin_usage_events`.
3.4 Extend `AiFacadeService` resolution chain.
3.5 Skill assembly hook (depends on Skills feature Phase 2; can be stubbed early).

**Phase 4 — Dashboards, charts, surfaces.**
4.1 `/agents/[id]/dashboard` tab — live status + 30-day bar chart + tasks list + cost snapshot.
4.2 `/agents/[id]/activity` tab — filtered reuse of `ActivityFeedClient.tsx`.
4.3 `/agents/[id]/budgets` tab — interval picker, cap, overage, histogram.
4.4 Per-target tabs (Work / Mission / Idea).
4.5 Dashboard tiles + Recent Tasks list.

**Phase 5 — Task-driven runtime (depends on Task-tracking Phase 1).**
5.1 `agent-task-execute` + `agent-chat-reply` Trigger.dev tasks.
5.2 `createTask`, `commentOnTask`, `editAgentFile`, `commitToRepo`, `createSubAgent` tools exposed to AI calls.
5.3 Permission enforcement at tool boundary.

**Phase 6 — Mission Template integration.**
6.1 Extend the Mission scaffolder to copy `.works/agents/` + `.works/skills/` from template repos.
6.2 Insert `agents` rows in `draft` for copied agents.
6.3 E2E test: instantiate a template that declares 2 agents → 2 rows visible.

**Default-on plan:** Phase 1 ships behind a `FEATURE_AGENTS` env flag (default off). Once Phase 5 is green in staging and the migration is verified on prod replicas, flip to default on.

## 11. Risks & Mitigations

| Risk                                                                                          | Likelihood | Impact   | Mitigation                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Heartbeat dispatcher floods Trigger.dev when many Agents go active                            | Medium     | Medium   | Cap dispatch batch at 200/tick; backpressure via Trigger.dev queue depth alarms.                        |
| Agent edits secret-bearing settings file by mistake                                           | Low        | High     | Secret-scan regex on every `PUT /agents/:id/files/:name`; reject with precise error.                    |
| Tenant Agents in DB-only mode grow large TEXT columns                                         | Low        | Low      | Soft cap 64 KB per file; warn the user in the editor footer.                                            |
| Concurrent file edits between UI and AI tool calls produce write-write conflicts in Git       | Low        | Medium   | `gitFacade.commit()` retries on push failure (existing); UI shows a "merge needed" banner when retry exhausts. |
| Trigger.dev outage stalls all heartbeats                                                      | Low        | High     | The dispatcher logs "stalled" after N failed dispatches and surfaces on the existing `/admin/health` page. |
| Cost overrun via runaway heartbeat loop                                                       | Medium     | High     | `AgentBudget` enforced before every AI call; daily cap defaults to a sensible $5/day on Agent create.   |
| Mission scaffolder breaks on malformed template `agents` array                                | Medium     | Low      | Zod validation in `MissionTemplateManifestService` (existing pattern); fail-soft warns user, proceeds without agents. |
| AI provider plugin is unloaded while Agent depends on it                                      | Medium     | Medium   | Resolution falls back through the cascade; auto-pause only after `pauseAfterFailures` consecutive failures. |

## 12. Constitution Reconciliation

| Principle                       | Met? | Notes                                                                                                                          |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| I — Plugin-First                | ✓    | Agents are not plugins. Reserved `task-tracker` interface stays decorative.                                                     |
| II — Capability-Driven Resolution| ✓   | Provider resolution goes through `AiFacadeService.resolvePlugin`.                                                               |
| III — Source-of-Truth Repos     | ✓    | Files live in Git; DB only stores hash + (for tenant mode) inline body until a control repo exists.                             |
| IV — Background Work via Trigger.dev | ✓ | Three Trigger.dev tasks shipped; no in-process long-running work.                                                                 |
| V — Forward-Only Migrations     | ✓    | All migrations additive; no drops.                                                                                              |
| VI — Tests Prerequisite         | ✓    | Phase plan ships service unit tests, dispatcher CAS unit test, Playwright create→heartbeat→file-edit happy path.                |
| VII — Secret Hygiene            | ✓    | Secret-scan regex on file writes; plugin settings still hold credentials.                                                       |
| VIII — Plugin Counts Single Source | N/A | No new plugin.                                                                                                                  |
| IX — Behaviour-First Specs      | ✓    | spec.md is behavior; plan.md is implementation.                                                                                 |
| X — Backwards Compatibility     | ✓    | All YAML additions optional; old configs still parse and run.                                                                   |

## 13. References

- Spec: [`./spec.md`](./spec.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Architecture: [`../../architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md)
- AI Facade: [`../../architecture/ai-facade.md`](../../architecture/ai-facade.md)
- Trigger Integration: [`../../architecture/trigger-integration.md`](../../architecture/trigger-integration.md)
- Activity Log: [`../../architecture/activity-log.md`](../../architecture/activity-log.md)
- Settings System: [`../../architecture/settings-system.md`](../../architecture/settings-system.md)
- Missions/Ideas/Works: [`../missions-ideas-works/spec.md`](../missions-ideas-works/spec.md)
- ADR-002 (worker callback): [`../../decisions/002-trigger-worker-callback-channel.md`](../../decisions/002-trigger-worker-callback-channel.md)
- ADR-006 (agents-not-plugins): [`../../decisions/006-agents-skills-tasks-as-core-not-plugins.md`](../../decisions/006-agents-skills-tasks-as-core-not-plugins.md)
