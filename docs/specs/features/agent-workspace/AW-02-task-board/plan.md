# AW-02 — Mission board · Implementation plan

> Translates [`spec.md`](./spec.md) into architecture, schema, endpoints and
> phasing. The plan owns implementation detail; the spec owns behaviour.

**Feature ID**: `aw-02-mission-board`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## 1. Current state in the codebase

Every path below was opened before being cited.

### 1.1 Missions — domain

| Concern | File | What is there today |
| --- | --- | --- |
| Entity | [`packages/agent/src/entities/mission.entity.ts`](../../../../../packages/agent/src/entities/mission.entity.ts) | `@Entity('missions')`. `MissionStatus` (`active`/`paused`/`completed`/`failed`), `MissionType` (`one-shot`/`scheduled`), `MissionOutcome`, `completedAt`, `schedule` (cron), `autoBuildWorks`, `outstandingIdeasCap`, `guardrailsOverride`, `missionTemplateRepo`, `missionRepo`, `sourceMissionId`, Tier-A `tenantId`/`organizationId`, `createdAt`/`updatedAt`. Index `idx_missions_user_status (userId, status)`. **No priority, no labels, no archive/trash marker, no progress timestamp, no origin, no comment thread.** |
| Service | [`packages/agent/src/missions/missions.service.ts`](../../../../../packages/agent/src/missions/missions.service.ts) | `listForUser` (899-line service; list is `find({ where, order: { updatedAt: 'DESC' }, take, skip })`), `getForUser`, `create`, `update`, `pause`, `resume`, `complete`, `delete`, `runNow`, attachments, Work relations, and a private `recordActivity()` that writes through the activity log. Ownership comes from `ownershipWhere` / `OwnershipScope`. |
| DTO + mapper | [`packages/agent/src/missions/types.ts`](../../../../../packages/agent/src/missions/types.ts) | `MissionDto` + `toMissionDto()` — the single place a new Mission field must be added to reach the wire. |
| Barrel | [`packages/agent/src/missions/index.ts`](../../../../../packages/agent/src/missions/index.ts) | Re-exports service, module, types, tick service, clone service, template config. |
| Module | [`packages/agent/src/missions/missions.module.ts`](../../../../../packages/agent/src/missions/missions.module.ts) | DI graph for the above. |
| Tick worker | [`packages/agent/src/missions/mission-tick.service.ts`](../../../../../packages/agent/src/missions/mission-tick.service.ts) | `tickDue()` — loads `ACTIVE` + `SCHEDULED` Missions (cap 500/tick), JS cron-match via [`cron-matcher.ts`](../../../../../packages/agent/src/missions/cron-matcher.ts), generates up to 5 Ideas per tick against the outstanding cap. Also backs `POST /run-now`. |
| Ownership helper | [`packages/agent/src/database/ownership-scope.ts`](../../../../../packages/agent/src/database/ownership-scope.ts) | `OwnershipScope`, `ownershipWhere<T>()` — the canonical user + Organization filter. |

### 1.2 Missions — API

[`apps/api/src/missions/missions.controller.ts`](../../../../../apps/api/src/missions/missions.controller.ts)
(`@Controller('api/me/missions')`, `@ApiTags('missions')`) already exposes list,
create, get, patch, delete, `pause`, `resume`, `complete`, `clone`, `run-now`,
`budget`, `works`, `attachments`, `goals`. Writes are `@Throttle` 30/min, clone
and run-now 10/min. Ownership is `@CurrentUser()` plus an optional
[`ScopeContextService`](../../../../../apps/api/src/scope/index.ts).
Request DTOs and their `class-validator` rules live in
[`apps/api/src/missions/dto/mission.dto.ts`](../../../../../apps/api/src/missions/dto/mission.dto.ts)
(`title` ≤ 200, `description` 1–10,000, cron ≤ 64).

### 1.3 Missions — web

| File | Today |
| --- | --- |
| [`apps/web/src/app/[locale]/(dashboard)/missions/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/missions/page.tsx>) | RSC. `PAGE_SIZE = 24`, `status`/`search`/`offset` search-params, calls `missionsAPI.list`, hands a load error to the client rather than faking an empty list. |
| [`apps/web/src/components/missions/MissionsList.tsx`](../../../../../apps/web/src/components/missions/MissionsList.tsx) | Client. `PageHeader` + `PromptComposer` quick-add + status `Select` + a grid of `MissionCard`. |
| [`apps/web/src/components/missions/MissionCard.tsx`](../../../../../apps/web/src/components/missions/MissionCard.tsx) | The existing catalog card. |
| [`apps/web/src/components/missions/MissionDetailClient.tsx`](../../../../../apps/web/src/components/missions/MissionDetailClient.tsx) | The many-section detail view the comment thread hangs off. |
| [`apps/web/src/components/missions/index.ts`](../../../../../apps/web/src/components/missions/index.ts) | Barrel for the above. |
| [`apps/web/src/lib/api/missions.ts`](../../../../../apps/web/src/lib/api/missions.ts) | `missionsAPI` — server-only typed client over the endpoints in §1.2. |
| [`apps/web/src/app/actions/dashboard/missions.ts`](../../../../../apps/web/src/app/actions/dashboard/missions.ts) | Server actions: `listMissionsAction`, `createMissionAction`, `updateMissionAction`, `deleteMissionAction`, `pauseMissionAction`, `resumeMissionAction`, `completeMissionAction`, `runMissionNowAction`, `cloneMissionAction`, attachment actions. |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) | `ROUTES.DASHBOARD_MISSIONS = '/missions'` (line 125), `DASHBOARD_MISSIONS_NEW` (126). |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) | Hardcoded nav array; "Missions" already points at `ROUTES.DASHBOARD_MISSIONS`. **No sidebar change is needed** — the board is a tab on the route the sidebar already links to. |

### 1.4 The board pattern that already exists

[`apps/web/src/components/tasks/TasksKanbanView.tsx`](../../../../../apps/web/src/components/tasks/TasksKanbanView.tsx)
is a working 712-line drag-and-drop board over `TaskStatus`, using native HTML5
DnD (`draggable` / `onDragStart` / `onDragOver` / `onDrop`), a `ColumnDef[]`
table, a `MAX_VISIBLE = 15` per-column cap, and a `RUN_ALL_MAX = 20` batch cap.
It is the reference implementation for lane rendering, card chips and drop
handling. Two sibling boards exist —
[`WorksKanbanView.tsx`](../../../../../apps/web/src/components/works/WorksKanbanView.tsx)
and
[`ActivityKanbanView.tsx`](../../../../../apps/web/src/components/activity-log/ActivityKanbanView.tsx)
— and there is **no shared board primitive** in `apps/web/src/components/ui/`.
This plan does not extract one (that is a refactor with its own blast radius); it
adds a fourth, and records the extraction as a follow-up in §13.

### 1.5 The signals the lanes derive from

| Lane input | Where it lives | Note |
| --- | --- | --- |
| Live Run | [`packages/agent/src/entities/agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts) | Has `taskId` + `workId`, **no `missionId`** — a Mission's Runs are reached through its Tasks |
| Task → Mission | [`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts) | `missionId` (nullable, no `@ManyToOne` by design), plus the denormalised `latestRunId` / `latestRunStatus` used by the Task board's run chips |
| Open escalation | [`packages/agent/src/entities/agent-escalation.entity.ts`](../../../../../packages/agent/src/entities/agent-escalation.entity.ts) | `status`, `taskId`, `runId`, `userId`; indexes `idx_agent_escalation_task_status` and `idx_agent_escalation_user_status` |
| Pending approval | [`packages/agent/src/entities/agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts) | `status` (`pending` default), `runId`, `agentId`, `userId`; index `idx_agent_action_proposals_user_status` |
| Read surfaces for both | [`apps/api/src/escalations/escalations.controller.ts`](../../../../../apps/api/src/escalations/escalations.controller.ts), [`apps/api/src/agent-approvals/agent-approvals.controller.ts`](../../../../../apps/api/src/agent-approvals/agent-approvals.controller.ts) | The board links out to these; it does not re-implement them |

### 1.6 The steering seam that already exists

- [`packages/agent/src/tasks-domain/task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts)
  declares the DI tokens `AGENT_TASK_EXECUTE_DISPATCHER` and
  `AGENT_CHAT_REPLY_DISPATCHER` — the only sanctioned way to start background
  work from the agent package (Constitution IV).
- [`packages/agent/src/tasks-domain/run-steering-port.ts`](../../../../../packages/agent/src/tasks-domain/run-steering-port.ts)
  declares `RUN_STEERING_PORT` with `steer({ runId, userId, message })` returning
  `{ dispatched: 'injected' | 'new-run', runId, queuedCount? }`. Bound to
  [`packages/agent/src/agents/run-steering.service.ts`](../../../../../packages/agent/src/agents/run-steering.service.ts).
  **Mid-flight steering is already solved at Task scope** — this epic reuses it at
  Mission scope rather than inventing a second mechanism.
- [`packages/agent/src/tasks-domain/task-chat.service.ts`](../../../../../packages/agent/src/tasks-domain/task-chat.service.ts)
  is the model to copy: `MAX_CHAT_BYTES = 16 * 1024`, `EDIT_WINDOW_MS = 5 * 60_000`,
  `MENTION_RE`, `KB_LINK_RE`, dedupe key `${task.id}:${mention.id}:${row.id}`,
  and an optional
  [`RunDispatchGateService`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts)
  admission check before dispatch.
- HTTP surface for the Task equivalent:
  [`apps/api/src/tasks/task-chat.controller.ts`](../../../../../apps/api/src/tasks/task-chat.controller.ts).

### 1.7 Cross-cutting infrastructure

| Concern | File | Note |
| --- | --- | --- |
| Migrations | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/) (175 files) | **Not** `packages/agent/src/migrations/` — that directory does not exist. [`apps/api/typeorm.config.ts`](../../../../../apps/api/typeorm.config.ts) globs `src/migrations/**/*{.js,.ts}` and the API self-applies on boot. The Constitution's §V text says `apps/api/src/database/migrations/`; the code says `apps/api/src/migrations/`. Follow the code and raise the doc drift separately (§13). |
| Entity barrel | [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts) | Every new entity must be exported here or TypeORM will not see it. |
| Activity log | [`packages/agent/src/activity-log/activity-log.service.ts`](../../../../../packages/agent/src/activity-log/activity-log.service.ts) + [`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) | `ActivityActionType` already has `MISSION_CREATED/PAUSED/RESUMED/COMPLETED/FAILED/DELETED/TICK_CAPPED` and `MISSION_TICK`. `actionType` is a free `varchar(50)`, so appending members needs **no** migration. |
| Notifications | [`packages/agent/src/entities/notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts) + [`notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts) | `NotificationCategory` has no `MISSION` member; `category` is `varchar(100)`, so adding one needs no migration. `deduplicationKey` is uniquely indexed per user — the staleness "once per streak" rule rides on it. |
| Job runtime | [`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/) (44 tasks) + [`index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) | Shape to copy: [`mission-tick.task.ts`](../../../../../packages/tasks/src/tasks/trigger/mission-tick.task.ts) — `schedules.task({ id, cron, run })` spinning a `NestApplicationContext(TriggerInternalModule)`. |
| Preferences | [`packages/agent/src/entities/work-agent-preference.entity.ts`](../../../../../packages/agent/src/entities/work-agent-preference.entity.ts) | Already holds `missionDefaultOutstandingCap` — the natural home for the staleness threshold. |
| Triggers | [`packages/agent/src/entities/inbound-trigger.entity.ts`](../../../../../packages/agent/src/entities/inbound-trigger.entity.ts) + [`apps/api/src/triggers/inbound-triggers.controller.ts`](../../../../../apps/api/src/triggers/inbound-triggers.controller.ts) | `mode: single-task | template` (immutable). P3 adds a `targetKind` alongside it. |
| i18n | [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) | `dashboard.missionsPage` and `dashboard.missionDetail` already exist; 20 sibling locales must be kept structurally identical. |

---

## 2. Architecture and the seam

### 2.1 One read, four lanes, no stored lane

```
   Browser (Board tab)
        │  server action  getMissionBoardAction(filters)
        ▼
   apps/web/src/lib/api/missions.ts   missionsAPI.board(filters)
        │  GET /api/me/missions/board          (X-Scope-Slug attached)
        ▼
   apps/api/src/missions/missions.controller.ts   @Get('board')
        │
        ▼
   packages/agent/src/missions/mission-board.service.ts
        │
        ├─► 1. missions  WHERE ownershipWhere(userId, scope)
        │                AND deletedAt IS NULL AND archivedAt IS NULL
        │                (+ text / priority / label / origin filters)
        │
        ├─► 2. decision counts, ONE grouped query per source, restricted to
        │      the mission ids from (1):
        │        agent_escalations  e JOIN tasks t ON t.id = e.taskId
        │          WHERE e.status='open'  GROUP BY t.missionId
        │        agent_action_proposals p JOIN agent_runs r ON r.id = p.runId
        │          JOIN tasks t ON t.id = r.taskId
        │          WHERE p.status='pending' GROUP BY t.missionId
        │
        ├─► 3. live-run counts, ONE grouped query:
        │        tasks WHERE missionId IN (…) AND latestRunStatus IN
        │          ('queued','running') GROUP BY missionId
        │
        └─► 4. deriveLane(mission, decisions, liveRuns, now)   ← PURE FUNCTION
                    in packages/agent/src/missions/mission-lane.ts
                    ↓
              { lanes: { backlog[], inFlight[], needsYou[], done[] },
                counts, needYouCount, doneTodayCount, filtersEcho }
```

Four queries total, all bounded, none per-card. `deriveLane` is a pure function
of `(missionRow, openDecisionCount, liveRunCount, now, staleAfterDays)` so it is
unit-testable without a database and cannot disagree between two readers.

### 2.2 Why the lane is derived and not a column

A stored lane would need a writer on every one of: run dispatch, run completion,
escalation open, escalation resolve, approval create, approval decide, task
transition, mission pause/resume/complete, tick. Nine writers, nine chances to
drift, and a repair job. Deriving costs three extra grouped queries on indexed
columns and can never be wrong. The only denormalised fields this epic adds are
the two that genuinely have no cheap query —
`lastProgressAt` / `lastProgressSummary` (§3.1) — and those are additive hints,
not authority: if a writer misses one, the card shows a staler line, never a
wrong lane.

### 2.3 Steering seam (P2)

```
   POST /api/me/missions/:id/comments   { body }
        ▼
   MissionCommentService.post()
        ├─ persist mission_comments row (+ parsed mentions)
        ├─ bump missions.commentCount, missions.lastProgressAt/Summary
        └─ for each @agent mention:
              resolve the newest NON-TERMINAL AgentRun among the Mission's Tasks
                 ├─ found  ─► RUN_STEERING_PORT.steer({runId, userId, message})
                 │              └─ 'injected'  → outcome = delivered
                 │              └─ 'new-run'   → fall through
                 └─ none   ─► RunDispatchGateService.admit(…)
                                 ├─ admitted → AGENT_CHAT_REPLY_DISPATCHER.enqueue
                                 │               outcome = dispatched
                                 └─ refused  → outcome = refused(reason)
```

`RUN_STEERING_PORT` and `AGENT_CHAT_REPLY_DISPATCHER` are both `@Optional()`
injections in the Task path today; the Mission path mirrors that so unit tests
and installs without the API layer degrade to "store the comment, mark it
`not-addressed`" instead of throwing.

### 2.4 What this epic does **not** touch

- `MissionTickService` keeps its cron, its 500-per-tick cap and its 5-Ideas-per-
  tick cap. The board reads its output; it does not change its behaviour.
- `DELETE /api/me/missions/:id` keeps hard-deleting. Trash is a new verb.
- `TasksKanbanView` and the Task board are untouched.
- The sidebar, the shell and the Home page are untouched by P1. (AW-19 will
  consume the board summary later; that is its epic, not this one.)

---

## 3. Data model

### 3.1 P1 — new columns on `missions`

All additive, all nullable or defaulted, no column removed or renamed.
Added to [`packages/agent/src/entities/mission.entity.ts`](../../../../../packages/agent/src/entities/mission.entity.ts)
and mirrored into `MissionDto` + `toMissionDto()` in
[`types.ts`](../../../../../packages/agent/src/missions/types.ts).

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `priority` | `varchar(4)` | `'p3'` | Same five-step scale as `Task.priority`. Reuses `TaskPriority` values verbatim — no new enum |
| `labels` | `simple-json` | `NULL` | `string[]`, ≤ 8 entries, each `[a-z0-9][a-z0-9._-]{0,31}`. Mirrors `Task.labels` exactly |
| `archivedAt` | `PortableDateColumn` nullable | `NULL` | Archive marker. Precedent: `Goal.archivedAt` |
| `deletedAt` | `PortableDateColumn` nullable | `NULL` | Trash marker. Precedent: `GithubAppInstallation.deletedAt`. **Soft** — the hard delete stays `DELETE …/:id` |
| `lastProgressAt` | `PortableDateColumn` nullable | `NULL` | Staleness anchor and In-flight recency clause |
| `lastProgressSummary` | `varchar(280)` nullable | `NULL` | The live status line. Plain text, never markup |
| `lastProgressKind` | `varchar(32)` nullable | `NULL` | `run_started` \| `run_completed` \| `run_failed` \| `tick` \| `task_transition` \| `decision_opened` \| `decision_resolved` \| `comment` — drives the card icon |
| `commentCount` | `int` | `0` | Denormalised; the thread is the authority, this is the card's chip |
| `createdByType` | `varchar(16)` | `'user'` | `user` \| `schedule` \| `agent` |
| `createdById` | `uuid` nullable | `NULL` | User id, Trigger id, or Agent id, matching `createdByType`. `NULL` allowed for pre-existing rows |

`MissionOriginType` and `MissionProgressKind` are declared as string-union types
next to `MissionStatus` in the entity file — not TypeScript enums — so a new
member never needs a migration, matching how `TaskActorType` is declared.

**New indexes** (the board's hot path):

```sql
CREATE INDEX idx_missions_board_scan
    ON missions (userId, deletedAt, archivedAt, status);
CREATE INDEX idx_missions_progress
    ON missions (userId, lastProgressAt);
```

`idx_missions_board_scan` covers the board's primary filter; `idx_missions_progress`
covers the staleness sweep and the In-flight sort.

### 3.2 P1 — new column on `work_agent_preferences`

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `missionStaleAfterDays` | `int` nullable | `NULL` | `NULL` = inherit the platform default of `2`. Clamped 1–30 at the service layer, exactly like `missionDefaultOutstandingCap`'s clamp pattern |

### 3.3 P2 — new table `mission_comments`

New entity `packages/agent/src/entities/mission-comment.entity.ts`, exported from
[`entities/index.ts`](../../../../../packages/agent/src/entities/index.ts).
Deliberately isomorphic to
[`task-chat-message.entity.ts`](../../../../../packages/agent/src/entities/task-chat-message.entity.ts).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `missionId` | `uuid` | `@ManyToOne(() => Mission, { onDelete: 'CASCADE' })` — Mission is already imported by nothing in the entities cycle path, so the relation is safe here (unlike Task's owner columns) |
| `authorType` | `varchar(8)` | `'user'` \| `'agent'` — reuses `TaskActorType` |
| `authorId` | `uuid` | |
| `body` | `text` | ≤ 16 KB enforced at the service layer, matching `MAX_CHAT_BYTES` |
| `mentions` | `simple-json` nullable | `{ type: 'user'\|'agent'\|'kb', id?, slug? }[]` — same shape as `TaskChatMention` |
| `deliveryOutcome` | `varchar(16)` nullable | `not-addressed` \| `delivered` \| `dispatched` \| `refused` |
| `deliveryDetail` | `varchar(200)` nullable | Refusal reason, safe free text. **Never** a payload value or a secret |
| `deliveredRunId` | `uuid` nullable | The Run the message reached |
| `editedAt` | `PortableDateColumn` nullable | 5-minute window |
| `tenantId`, `organizationId` | `uuid` nullable | Tier C scope denormalisation, stamped from the parent Mission |
| `createdAt`, `updatedAt` | | |

```sql
CREATE INDEX idx_mission_comment_mission_created
    ON mission_comments (missionId, createdAt);
CREATE INDEX idx_mission_comment_author
    ON mission_comments (authorType, authorId);
```

### 3.4 P3 — new column on `inbound_triggers`

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `targetKind` | `varchar(16)` | `'task'` | `task` \| `mission`. **Immutable after create**, like the existing `mode` and `sourceType` |

When `targetKind = 'mission'`, the fire path creates a Mission (origin
`schedule`, `createdById` = the Trigger id) instead of a Task, reusing
`taskTitleTemplate` / `taskDescriptionTemplate` placeholder expansion verbatim.

### 3.5 Migrations (Constitution V, forward-only)

Authored from `apps/api/` with
`pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/<Name>`,
reviewed by hand, and landing in
[`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/).

| Phase | File | Contents |
| --- | --- | --- |
| P1 | `<ts>-AddMissionBoardColumns.ts` | 10 `ADD COLUMN` on `missions`, 1 on `work_agent_preferences`, 2 `CREATE INDEX`. No `DROP`, no `ALTER … TYPE`, no `NOT NULL` without a default |
| P2 | `<ts>-CreateMissionComments.ts` | `CREATE TABLE mission_comments` + 2 indexes + FK to `missions` with `ON DELETE CASCADE` |
| P3 | `<ts>-AddInboundTriggerTargetKind.ts` | 1 `ADD COLUMN` on `inbound_triggers` with default `'task'` |

**Backfill.** None is required and none is written. `createdByType` defaults to
`'user'`, which is factually correct for every row that can exist before P1
(spec FR-34). `priority` defaults to `'p3'`. `lastProgressAt` stays `NULL`, which
`deriveLane` reads as "no recorded progress" — never as "stale" — so no Mission
is retroactively flagged.

**Down migrations** drop only what the up migration added, in reverse order.

### 3.6 Enum-shaped additions that need no migration

- `ActivityActionType` gains `MISSION_ARCHIVED`, `MISSION_UNARCHIVED`,
  `MISSION_TRASHED`, `MISSION_RESTORED`, `MISSION_PURGED`, `MISSION_STALE_FLAGGED`,
  `MISSION_COMMENT_POSTED` in
  [`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts).
  `actionType` is `varchar(50)`; the enum is a TypeScript-side constraint only.
- `NotificationCategory` gains `MISSION = 'mission'` in
  [`notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts).
  `category` is `varchar(100)`.

---

## 4. API surface

All new routes hang off the existing
[`apps/api/src/missions/missions.controller.ts`](../../../../../apps/api/src/missions/missions.controller.ts)
(`api/me/missions`) except the comment thread, which gets its own controller in
the same module — mirroring how
[`task-chat.controller.ts`](../../../../../apps/api/src/tasks/task-chat.controller.ts)
sits beside `tasks.controller.ts`.

Every route: authenticated (`@CurrentUser()`), Organization-scoped via
`ScopeContextService`, 404-no-leak on a foreign id, Swagger-decorated
(`@ApiTags('missions')` + `@ApiOperation`) so the MCP whitelist derivation picks
it up.

### 4.1 P1

| Method | Path | Throttle | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/me/missions/board` | 120/min | The four-lane read model |
| `POST` | `/api/me/missions/:id/archive` | 30/min | Set `archivedAt`; idempotent |
| `POST` | `/api/me/missions/:id/unarchive` | 30/min | Clear `archivedAt`; idempotent |
| `POST` | `/api/me/missions/:id/trash` | 30/min | Set `deletedAt`; also clears `archivedAt`; idempotent |
| `POST` | `/api/me/missions/:id/restore` | 30/min | Clear `deletedAt` **and** `archivedAt`; idempotent |

`GET /api/me/missions/board` query DTO (`MissionBoardQueryDto`):

```ts
class MissionBoardQueryDto {
  @IsOptional() @IsString() @MaxLength(200)          search?: string;
  @IsOptional() @IsIn(['p0','p1','p2','p3','p4'], { each: true })
                @Transform(csvToArray)                priority?: TaskPriority[];
  @IsOptional() @IsString({ each: true }) @ArrayMaxSize(8)
                @Transform(csvToArray)                label?: string[];
  @IsOptional() @IsIn(['user','schedule','agent'], { each: true })
                @Transform(csvToArray)                origin?: MissionOriginType[];
  @IsOptional() @IsInt() @Min(1) @Max(200)            laneLimit?: number;   // default 50
  @IsOptional() @IsInt() @Min(1) @Max(90)             doneWindowDays?: number; // default 7
  @IsOptional() @IsIn(['backlog','in_flight','needs_you','done'])
                                                      lane?: MissionLane;  // fetch one lane (Show more)
  @IsOptional() @IsInt() @Min(0)                      laneOffset?: number;
}
```

Response (`MissionBoardDto`, declared beside `MissionDto` in
[`packages/agent/src/missions/types.ts`](../../../../../packages/agent/src/missions/types.ts)):

```ts
interface MissionBoardCardDto {
  id: string;
  title: string;
  priority: TaskPriority;            // 'p0'…'p4'
  labels: string[];
  status: MissionStatus;             // for the Paused chip
  outcome: MissionOutcome | null;
  completedAt: Date | null;
  origin: { type: MissionOriginType; id: string | null; name: string | null };
  lastProgressAt: Date | null;
  lastProgressSummary: string | null;   // <= 280, plain text
  lastProgressKind: MissionProgressKind | null;
  liveRunCount: number;
  openDecisionCount: number;
  commentCount: number;
  isStale: boolean;
  href: string;                      // computed server-side from ROUTES
}

interface MissionBoardLaneDto {
  lane: MissionLane;
  total: number;                     // UNBOUNDED true count (spec FR-7)
  cards: MissionBoardCardDto[];      // <= laneLimit
  hasMore: boolean;
  degraded?: 'decision-counts';      // this lane's decision query failed
}

interface MissionBoardDto {
  lanes: MissionBoardLaneDto[];      // always 4, always in board order
  needYouCount: number;
  doneTodayCount: number;
  staleAfterDays: number;            // the effective threshold, echoed for copy
  generatedAt: Date;
}
```

`doneTodayCount` needs the viewer's day boundary. The client sends its IANA zone
as `?tz=`; the server validates it against `Intl.supportedValuesOf('timeZone')`
and falls back to UTC on anything unrecognised, so a hostile value can never
reach a query.

**Additive DTO changes**: `CreateMissionDto` and `UpdateMissionDto` in
[`dto/mission.dto.ts`](../../../../../apps/api/src/missions/dto/mission.dto.ts)
each gain optional `priority` (`@IsIn` the five values) and `labels`
(`@IsArray` + `@ArrayMaxSize(8)` + `@Matches(/^[a-z0-9][a-z0-9._-]{0,31}$/, { each: true })`).
Normalisation to lower case happens in `MissionsService`, not the DTO, so every
caller (API, MCP, CLI) gets the same behaviour.

**Behaviour change to an existing route, and why it is safe.**
`GET /api/me/missions` starts excluding rows with `archivedAt` or `deletedAt` set,
and gains `?include=archived|trashed|all`. No such row can exist before the P1
migration runs, so no existing consumer can observe a change (spec §11,
Constitution X).

### 4.2 P2

| Method | Path | Throttle | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/me/missions/:id/comments` | 120/min | Paginated thread, oldest first, 50/page |
| `POST` | `/api/me/missions/:id/comments` | 20/min | Post; returns the row **with its delivery outcome** |
| `PATCH` | `/api/me/missions/:id/comments/:commentId` | 20/min | Edit within 5 minutes; 409 after |

```ts
class PostMissionCommentDto {
  @IsString() @MinLength(1) @MaxLength(16_384) body: string;
}
```

Response rows carry `deliveryOutcome`, `deliveryDetail`, `deliveredRunId` so the
UI renders the annotation without a second call. There is deliberately **no**
delete endpoint — matching the Task thread, which has none either.

### 4.3 P3

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/inbound-triggers` | Accepts `targetKind` (immutable) |
| `POST` | `/api/me/missions/bulk/archive` | `{ ids: string[] }`, ≤ 100 ids, 10/min |

Agent-proposed Missions do **not** get a new public endpoint: an Agent proposes
through the existing `agent_action_proposals` path with a new
`AgentActionProposalActionType` member, and the Mission is created by the
approval handler once a human approves. That keeps every Agent-initiated write on
the one rail that already has risk scoring and guardrails.

---

## 5. Web surface

### 5.1 Route and shell

No new route. `/missions` gains a tab strip.
[`apps/web/src/app/[locale]/(dashboard)/missions/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/missions/page.tsx>)
becomes a dispatcher on `?tab=`:

```
missions/page.tsx (RSC)
  ├─ tab=board     (default) → board data via getMissionBoardAction  → <MissionBoard/>
  ├─ tab=list                → today's missionsAPI.list path         → <MissionsList/>   (unchanged)
  ├─ tab=archived            → missionsAPI.list({ include:'archived' })→ <MissionShelf variant="archived"/>
  └─ tab=trashed             → missionsAPI.list({ include:'trashed' })→ <MissionShelf variant="trash"/>
```

The tab choice persists to `localStorage['missions-tab']` (same pattern as the
Activity page's view-mode persistence) and is mirrored into the URL so a board is
shareable. Every fetch keeps the existing page's discipline: `try/catch` at the
call site, the error handed to the client component, never a fake empty state.

### 5.2 New components — `apps/web/src/components/missions/board/`

| File | Role |
| --- | --- |
| `MissionBoard.tsx` | Client shell. Owns filter state, the poll, drag state, optimistic mutations. Renders the header counters, `MissionBoardFilters`, and four `MissionLane`s |
| `MissionLane.tsx` | One lane: header (name, count, sort tooltip), scroll body, `Show N more` footer, per-lane empty line, per-lane error panel |
| `MissionBoardCard.tsx` | The card in §6.3 of the spec. Chips, live status line (plain text, `title` attribute for the untruncated value), `MissionCardMenu` |
| `MissionCardMenu.tsx` | The card menu; each action maps to an existing or new server action |
| `MissionBoardFilters.tsx` | Search + priority + label + origin, URL-synced, `Clear filters` |
| `MissionBoardHeader.tsx` | `N need you · N done today` + `+ New Mission` |
| `NewMissionDialog.tsx` | Quick-create. Built on [`components/ui/dialog.tsx`](../../../../../apps/web/src/components/ui/dialog.tsx) (Headless UI), not a new modal system |
| `MissionBoardSkeleton.tsx` | Four lane frames, three skeleton cards each |
| `MissionBoardEmpty.tsx` | Whole-board empty; wraps the shared [`components/common/EmptyState.tsx`](../../../../../apps/web/src/components/common/EmptyState.tsx) |
| `MissionShelf.tsx` | The Archived and Trash tabs (one component, a `variant` prop) |
| `MissionPurgeDialog.tsx` | Type-the-title confirmation |
| `useMissionBoardPoll.ts` | The refresh policy in spec FR-10, modelled on [`use-task-run-polling.ts`](../../../../../apps/web/src/lib/hooks/use-task-run-polling.ts) but visibility-aware |

P2 adds `apps/web/src/components/missions/MissionCommentThread.tsx`, mounted from
[`MissionDetailClient.tsx`](../../../../../apps/web/src/components/missions/MissionDetailClient.tsx).
Note the Task equivalent is currently inlined inside `TaskDetailClient.tsx` with
no extracted component, so there is nothing to reuse; the Mission thread is built
standalone and the shared extraction is recorded as a follow-up (§13).

All exports go through
[`apps/web/src/components/missions/index.ts`](../../../../../apps/web/src/components/missions/index.ts).

### 5.3 State and data fetching

- **First paint** is server-rendered from the RSC page, so lanes have data on
  load; the client hook takes over for refreshes.
- **Refresh** re-invokes `getMissionBoardAction` with the current filters and
  diffs by mission id. Card DOM identity is keyed on the id so a refresh never
  remounts a card that did not change (spec FR-11).
- **Optimism**: archive, trash, restore, priority and label edits apply locally
  first, then reconcile. A rejected mutation reverts the card and raises a
  `sonner` toast with the server's message — the existing toast mechanism, no new
  dependency.
- **Undo**: the toast's action calls the inverse endpoint (`unarchive` / `restore`).
  All four are idempotent, so a double-click cannot corrupt state.
- **Drag** uses the same native HTML5 handlers `TasksKanbanView` uses; the
  `Needs you` lane simply omits `onDragOver`/`onDrop` and renders the explanatory
  toast on `onDragEnter` release.

### 5.4 New server actions — `apps/web/src/app/actions/dashboard/missions.ts`

Appended to the existing file, matching its shape exactly:
`getMissionBoardAction`, `archiveMissionAction`, `unarchiveMissionAction`,
`trashMissionAction`, `restoreMissionAction`, `setMissionPriorityAction`,
`setMissionLabelsAction`, and (P2) `listMissionCommentsAction`,
`postMissionCommentAction`, `editMissionCommentAction`.
Each delegates to a new method on `missionsAPI` in
[`apps/web/src/lib/api/missions.ts`](../../../../../apps/web/src/lib/api/missions.ts).

---

## 6. Background work

Both jobs are Trigger.dev-shaped files under
[`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/),
registered in its `index.ts`, each spinning a `NestApplicationContext(TriggerInternalModule)`
and delegating to a service in the agent package — the shape
[`mission-tick.task.ts`](../../../../../packages/tasks/src/tasks/trigger/mission-tick.task.ts)
already uses. Neither imports `@trigger.dev/sdk` from the agent package; the
agent package only ever sees its own service classes and the `*_DISPATCHER`
tokens (Constitution IV).

| Task file | Cron | Delegates to | What it does | Idempotency |
| --- | --- | --- | --- | --- |
| `mission-staleness-sweep.task.ts` | `7 * * * *` (hourly, offset to avoid the minute-boundary pile-up) | `MissionStalenessService.sweep()` in `packages/agent/src/missions/mission-staleness.service.ts` | Scans Missions that `deriveLane` puts in `In flight` with `lastProgressAt` older than the effective threshold, and raises **one** notification each | `Notification.deduplicationKey = mission-stale:${missionId}:${floor(lastProgressAt/1000)}` — the unique `(userId, deduplicationKey)` index makes a re-run a no-op, and a Mission that moves gets a new key, satisfying spec FR-31 |
| `mission-trash-purge.task.ts` | `23 4 * * *` (daily, beside the existing `task-branch-gc` at `41 4 * * *`) | `MissionTrashService.purgeDue()` | Hard-deletes Missions whose `deletedAt` is older than 30 days, cascading `mission_comments`; writes a `MISSION_PURGED` activity row per deletion | Batched at 200 per run with a `deletedAt < cutoff` predicate; a re-run finds nothing |

**No new dispatcher token.** Comment-triggered Runs use the existing
`AGENT_CHAT_REPLY_DISPATCHER`; live-Run injection uses the existing
`RUN_STEERING_PORT`. Nothing in this epic calls a queue directly.

**Progress writers** (§3.1 `lastProgressAt/Summary/Kind`) are **not** jobs. They
are single-statement updates issued in-line by the services that already own each
event, guarded so a failure logs and continues rather than failing the caller —
the same posture `MissionsService.recordActivity()` already takes:

| Event | Writer |
| --- | --- |
| Run dispatched / terminal for a Task with a `missionId` | `packages/agent/src/tasks-domain/task-run-denorm.service.ts` (already writes `Task.latestRunStatus`; extend the same call) |
| Task status transition | `packages/agent/src/tasks-domain/task-transition.service.ts` |
| Scheduled tick produced Ideas | `packages/agent/src/missions/mission-tick.service.ts` |
| Escalation opened / resolved | the escalation writer path in `packages/agent/src/agents/` |
| Approval created / decided | the proposal writer path in `packages/agent/src/agents/` |
| Comment posted | `MissionCommentService` (P2) |

---

## 7. Plugin boundaries

**No plugin package is added and none is touched.** This feature reads
first-party tables, writes first-party tables, and reaches Agent execution only
through DI tokens declared in the agent package. Specifically:

- **Constitution I** — nothing external is integrated. The board calls no third
  party.
- **Constitution II** — no plugin id appears anywhere in the diff. Agent
  execution goes through `AGENT_CHAT_REPLY_DISPATCHER` / `RUN_STEERING_PORT`,
  which resolve to whatever the workspace has configured. A grep for a provider
  name in this epic's files must return nothing; that grep is a review gate.
- **Constitution III** — priority, labels, board markers and comments are
  platform metadata about delegated work, not Work content. No item, category or
  config moves into the database.

If a future workspace wants a third-party board mirror (an issue tracker, say),
that is a plugin declaring a capability, not a branch inside `MissionBoardService`.
Nothing in this design blocks that; nothing in this design starts it.

---

## 8. i18n

All keys land in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) under the
**existing** `dashboard.missionsPage` namespace (plus a small addition to
`dashboard.missionDetail` in P2), then are mirrored structurally into the 20
sibling locale files. Leaf names are camelCase and contain **no literal dot** —
next-intl rejects dotted leaves at runtime and the hydration spec turns that into
a multi-shard red.

```
dashboard.missionsPage.tabs.board            "Board"
dashboard.missionsPage.tabs.list             "List"
dashboard.missionsPage.tabs.archived         "Archived"
dashboard.missionsPage.tabs.trash            "Trash"

dashboard.missionsPage.board.subtitle        "Everything your Agents are working on, in one queue."
dashboard.missionsPage.board.needYou         "{count} need you"
dashboard.missionsPage.board.doneToday       "{count} done today"
dashboard.missionsPage.board.sortTooltip     "Sorted by priority, then oldest first."
dashboard.missionsPage.board.showMore        "Show {count} more"
dashboard.missionsPage.board.showingOf       "Showing {shown} of {total}"
dashboard.missionsPage.board.notADropTarget  "Needs you is set by the work, not by hand."
dashboard.missionsPage.board.refreshedAt     "Updated {time}"

dashboard.missionsPage.board.lanes.backlog          "Backlog"
dashboard.missionsPage.board.lanes.inFlight         "In flight"
dashboard.missionsPage.board.lanes.needsYou         "Needs you"
dashboard.missionsPage.board.lanes.done             "Done"
dashboard.missionsPage.board.lanes.backlogHint      "Queued — an Agent will pick it up."
dashboard.missionsPage.board.lanes.inFlightHint     "Being worked right now."
dashboard.missionsPage.board.lanes.needsYouHint     "Waiting on a decision from you."
dashboard.missionsPage.board.lanes.doneHint         "Finished in the last {days} days."
dashboard.missionsPage.board.lanes.emptyBacklog     "Nothing queued."
dashboard.missionsPage.board.lanes.emptyInFlight    "Nothing in flight."
dashboard.missionsPage.board.lanes.emptyNeedsYou    "Nothing needs you."
dashboard.missionsPage.board.lanes.emptyDone        "Nothing finished in the last {days} days."
dashboard.missionsPage.board.lanes.countLabel       "{name}, {count} Missions"

dashboard.missionsPage.board.error.title       "Couldn't load the board."
dashboard.missionsPage.board.error.body        "Your Missions are safe — this is a display problem."
dashboard.missionsPage.board.error.retry       "Try again"
dashboard.missionsPage.board.error.openList    "Open the List tab instead"
dashboard.missionsPage.board.error.laneCounts  "Decision count unavailable"

dashboard.missionsPage.card.stale              "Stale"
dashboard.missionsPage.card.staleTooltip       "No progress for {days} days. Last progress {timestamp}."
dashboard.missionsPage.card.paused             "Paused"
dashboard.missionsPage.card.openDecision       "Open decision"
dashboard.missionsPage.card.openDecisionCount  "{count, plural, one {# open decision} other {# open decisions}}"
dashboard.missionsPage.card.commentCount       "{count} comments"
dashboard.missionsPage.card.commentOverflow    "99+"
dashboard.missionsPage.card.moreLabels         "+{count}"
dashboard.missionsPage.card.completedOn        "Completed {date}"

dashboard.missionsPage.priority.p0             "Urgent"
dashboard.missionsPage.priority.p1             "High"
dashboard.missionsPage.priority.p2             "Medium"
dashboard.missionsPage.priority.p3             "Normal"
dashboard.missionsPage.priority.p4             "Low"

dashboard.missionsPage.origin.user             "You"
dashboard.missionsPage.origin.schedule         "Schedule"
dashboard.missionsPage.origin.agent            "{agentName}"
dashboard.missionsPage.origin.filterLabel      "Origin"

dashboard.missionsPage.filters.search          "Search"
dashboard.missionsPage.filters.priority        "Priority"
dashboard.missionsPage.filters.label           "Label"
dashboard.missionsPage.filters.clear           "Clear filters"

dashboard.missionsPage.menu.open               "Open Mission"
dashboard.missionsPage.menu.chat               "Chat about it"
dashboard.missionsPage.menu.priority           "Priority"
dashboard.missionsPage.menu.labels             "Labels…"
dashboard.missionsPage.menu.runNow             "Run now"
dashboard.missionsPage.menu.pause              "Pause"
dashboard.missionsPage.menu.complete           "Complete…"
dashboard.missionsPage.menu.archive            "Archive"
dashboard.missionsPage.menu.trash              "Move to Trash"
dashboard.missionsPage.menu.disabledReason     "{action} is unavailable: {reason}"

dashboard.missionsPage.quickCreate.title         "New Mission"
dashboard.missionsPage.quickCreate.descLabel     "What should your Agents keep doing?"
dashboard.missionsPage.quickCreate.descHint      "At least 10 characters."
dashboard.missionsPage.quickCreate.titleLabel    "Title (optional)"
dashboard.missionsPage.quickCreate.titleHint     "Leave blank and we'll write one from the above"
dashboard.missionsPage.quickCreate.priorityLabel "Priority"
dashboard.missionsPage.quickCreate.labelsLabel   "Labels"
dashboard.missionsPage.quickCreate.addLabel      "+ Add label"
dashboard.missionsPage.quickCreate.fullForm      "Need a cadence, a cap or guardrails? Use the full form."
dashboard.missionsPage.quickCreate.submit        "Create Mission"
dashboard.missionsPage.quickCreate.cancel        "Cancel"
dashboard.missionsPage.quickCreate.error         "Couldn't create the Mission. Please try again."
dashboard.missionsPage.quickCreate.labelLimit    "Up to 8 labels per Mission."
dashboard.missionsPage.quickCreate.labelFormat   "Labels use lower-case letters, numbers, dots, dashes and underscores."

dashboard.missionsPage.shelf.archivedLead      "Archived Missions stay out of the board but keep everything they produced."
dashboard.missionsPage.shelf.trashLead         "Missions here are deleted for good 30 days after you trash them."
dashboard.missionsPage.shelf.archivedOn        "Archived {date}"
dashboard.missionsPage.shelf.deletedOn         "Deleted {date} · purged in {days} days"
dashboard.missionsPage.shelf.restore           "Restore"
dashboard.missionsPage.shelf.deleteForever     "Delete forever"
dashboard.missionsPage.shelf.emptyArchived     "Nothing archived."
dashboard.missionsPage.shelf.emptyArchivedHint "Archive a Mission from its card menu when it is no longer live."
dashboard.missionsPage.shelf.emptyTrash        "Trash is empty."

dashboard.missionsPage.purge.title             "Delete \"{title}\" forever?"
dashboard.missionsPage.purge.body              "This removes the Mission and its comments permanently. Ideas, Works and Tasks it created are not deleted. This cannot be undone."
dashboard.missionsPage.purge.confirmLabel      "Type the Mission title to confirm"
dashboard.missionsPage.purge.confirm           "Delete forever"

dashboard.missionsPage.toasts.archived         "Mission archived"
dashboard.missionsPage.toasts.trashed          "Moved to Trash"
dashboard.missionsPage.toasts.restored         "Mission restored"
dashboard.missionsPage.toasts.undo             "Undo"
dashboard.missionsPage.toasts.moveFailed       "Couldn't move that Mission."

dashboard.missionsPage.banner.archived         "This Mission is archived. It is hidden from the board."
dashboard.missionsPage.banner.trashed          "This Mission is in Trash and will be deleted on {date}."

dashboard.missionDetail.comments.heading       "Comments"
dashboard.missionDetail.comments.placeholder   "Reply to steer the Agent…"
dashboard.missionDetail.comments.send          "Send"
dashboard.missionDetail.comments.edit          "Edit"
dashboard.missionDetail.comments.edited        "(edited)"
dashboard.missionDetail.comments.template      "Insert a change of direction"
dashboard.missionDetail.comments.templateBody  "Change of direction: <what changed>.\nKeep <what still applies>. Drop <what no longer applies>.\nIf this invalidates work you have already done, say so and estimate the rework before you redo it — do not silently start over."
dashboard.missionDetail.comments.delivered     "Delivered to the running Agent"
dashboard.missionDetail.comments.queued        "No Run in flight — queued for the next one"
dashboard.missionDetail.comments.refused       "Couldn't reach the Agent — {reason}"
dashboard.missionDetail.comments.rateLimited   "You're commenting too fast. Try again in a moment."
dashboard.missionDetail.comments.empty         "No comments yet. Reply here to steer the Agent."
dashboard.missionDetail.comments.loadMore      "Load older comments"

dashboard.missionsPage.notifications.staleTitle "{title} hasn't moved in {days} days"
dashboard.missionsPage.notifications.staleBody  "It's been in flight since {date} with no progress. Open it to see where it stopped."

dashboard.settings.workAgent.missionStaleAfterDays        "Flag a Mission as stale after"
dashboard.settings.workAgent.missionStaleAfterDaysHint    "Between 1 and 30 days. Applies to Missions that are in flight."
```

The 20 sibling locales get the same key tree in the same PR; a missing key in one
locale is a build-visible regression, so they land together.

---

## 9. Telemetry and failure modes

### 9.1 Activity log (`ActivityLogService.log`)

| Action type | When | Payload |
| --- | --- | --- |
| `mission_archived` / `mission_unarchived` | archive / unarchive | `{ missionId }` |
| `mission_trashed` / `mission_restored` | trash / restore | `{ missionId }` |
| `mission_purged` | retention sweep or Delete forever | `{ missionId, title, trashedAt, commentsDeleted }` |
| `mission_stale_flagged` | first flag of a streak | `{ missionId, lastProgressAt, thresholdDays }` |
| `mission_comment_posted` | comment posted | `{ missionId, commentId, deliveryOutcome }` — **never the body** |

Every emitter stamps `userId`, `tenantId` and `organizationId` from the parent
Mission, as the cron-emitter rule requires, and wraps the write in `try/catch`
so a logging failure never fails the user's action.

### 9.2 Product analytics

Fired client-side through the existing PostHog wiring in
[`packages/monitoring/`](../../../../../packages/monitoring/):
`mission_board_opened` (with lane counts and whether any filter is active),
`mission_board_filter_applied`, `mission_card_dragged` (from lane → to lane →
accepted/refused), `mission_quick_created`, `mission_archived`,
`mission_restored`, `mission_comment_posted` (with `deliveryOutcome`, no body),
`mission_steering_template_inserted`.

### 9.3 Sentry

A `mission_board` tag on the board read span; breadcrumbs for each of the four
queries so a slow board is attributable to one of them; the lane-derivation
inputs (counts only, never titles) on the error context.

### 9.4 Failure modes and the chosen degradation

| Failure | Behaviour |
| --- | --- |
| Mission query fails | Whole-board error panel (spec §6.9). Lane frames stay. Never an empty board |
| Decision-count query fails | The other three lanes render normally; `Needs you` renders with `degraded: 'decision-counts'` and the copy "Decision count unavailable". Missions are **not** silently demoted to `In flight` |
| Live-run query fails | `liveRunCount` treated as 0; the 24-hour progress clause still places recently-active Missions in `In flight`. A card can under-report, never over-report |
| Progress writer throws | Logged at `warn`, swallowed. The user's action succeeds; the card shows a staler line |
| Steering port unbound | `deliveryOutcome = 'dispatched'` via the chat dispatcher, or `'not-addressed'` if that is also unbound. The comment is always stored |
| No job runtime configured | `deliveryOutcome = 'refused'`, `deliveryDetail` names it, the UI links to `/settings/job-runtime`. The existing shell-level degraded banner already warns globally |
| Staleness sweep fails mid-batch | Per-Mission `try/catch`; the dedup key makes the next run idempotent |
| Purge sweep fails mid-batch | Same. `deletedAt < cutoff` is re-evaluated each run |
| Two tabs mutate the same Mission | All four board mutations are idempotent set/clear operations; the loser is a no-op, not a 409 |
| Clock skew on `doneToday` | Server computes the day boundary from the validated `tz`; a client with a wrong clock changes nothing server-side |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest)

| File | Covers |
| --- | --- |
| `packages/agent/src/missions/__tests__/mission-lane.spec.ts` | `deriveLane` truth table: all six precedence branches, the paused case, the 24-hour recency clause, `lastProgressAt = NULL`, and that trashed beats archived beats done |
| `packages/agent/src/missions/__tests__/mission-board.service.spec.ts` | Filter composition, lane caps vs. true totals, `doneTodayCount` across a timezone boundary, per-source degradation, ownership scoping |
| `packages/agent/src/missions/__tests__/mission-staleness.service.spec.ts` | Threshold boundaries (47 h / 49 h at default 2 days), clamp 1–30, one notification per streak, re-flag after movement, no flag outside `In flight` |
| `packages/agent/src/missions/__tests__/mission-trash.service.spec.ts` | 30-day cutoff either side, cascade of comments, batch cap, idempotent re-run |
| `packages/agent/src/missions/__tests__/mission-comment.service.spec.ts` (P2) | 16 KB cap, 5-minute edit window either side, mention parsing, all four delivery outcomes, `commentCount` and `lastProgressAt` side effects, the 20/min limiter |
| `packages/agent/src/missions/__tests__/missions.service.spec.ts` (extend) | Label normalisation and the 8-label cap, priority default, archive/trash/restore idempotency, the `include` filter on `listForUser` |

### 10.2 Controller specs — API (Jest, colocated)

Matching the existing pattern
(`apps/api/src/tasks/tasks.controller.scope.spec.ts`,
`tasks.controller.board-visibility.spec.ts`):

| File | Covers |
| --- | --- |
| `apps/api/src/missions/missions.controller.board.spec.ts` | `GET /board` shape, query validation (bad priority, `laneLimit` 0 and 201, hostile `tz`), throttle wiring |
| `apps/api/src/missions/missions.controller.shelf.spec.ts` | archive / unarchive / trash / restore: happy path, idempotent repeat, 404-no-leak for a foreign id, identical bodies across all four |
| `apps/api/src/missions/missions.controller.scope.spec.ts` | Organization scoping on every new route |
| `apps/api/src/missions/dto/mission.dto.spec.ts` (extend) | `priority` and `labels` validation on create and update |
| `apps/api/src/missions/mission-comments.controller.spec.ts` (P2) | Post / list / edit, 16 KB rejection, 409 after the edit window, 404-no-leak |

### 10.3 End-to-end — web (Playwright, `apps/web/e2e/`)

Named to match the existing `flow-mission-*` family:

| File | Covers |
| --- | --- |
| `apps/web/e2e/flow-mission-board-ui-journey.spec.ts` | Open `/missions`, assert four lanes and both header counters, apply a filter, clear it, open a card, `Show 50 more` |
| `apps/web/e2e/flow-mission-board-quick-create.spec.ts` | `n` opens the dialog, validation on a 9-character description, create, the card appears in Backlog with its chips, the error path preserves the typed text |
| `apps/web/e2e/flow-mission-board-archive-trash.spec.ts` | Archive → Undo → archive → Archived tab → Restore; trash → Trash tab → purge date copy → Delete forever behind the typed title |
| `apps/web/e2e/flow-mission-board-lane-moves.spec.ts` | Drag Backlog → In flight, In flight → Backlog, drop on Done opens the completion dialog and cancelling changes nothing, `Needs you` refuses with its toast |
| `apps/web/e2e/flow-mission-board-empty-and-error.spec.ts` | Zero-Mission empty board, single empty lane keeps its frame, forced board error keeps the lane frames and offers the List tab |
| `apps/web/e2e/flow-mission-board-keyboard.spec.ts` | Arrow navigation across lanes, `Enter`, `e`, `Delete`, `/`, `Esc`, and that `e` and `Delete` are inert while a text input has focus |
| `apps/web/e2e/flow-mission-comment-steering.spec.ts` (P2) | Post a comment with a live Run → "Delivered"; with none → "queued"; with the runtime unconfigured → refusal with the settings link; edit at 4 min, refused at 6 |
| `apps/web/e2e/flow-mission-board-a11y.spec.ts` | axe scan of the Board, Archived and Trash tabs and the quick-create dialog; lane regions carry names and live counts |

### 10.4 Web unit specs

Colocated `*.unit.spec.tsx` beside each component, matching
`MissionCard.unit.spec.tsx` and friends: `MissionBoardCard`, `MissionLane`,
`MissionBoardFilters`, `NewMissionDialog`, `MissionShelf`,
`MissionCommentThread` (P2). The card spec must assert that a status line
containing `<script>` and a markdown link renders as literal text.

### 10.5 What must be green before merge

`pnpm format:check`, `pnpm lint`, `pnpm type-check`, the agent + api Jest suites,
the touched Playwright shards, and a locale-key consistency check across the 21
message files.

---

## 11. Phasing

Each phase is independently shippable, leaves `develop` green, and is useful on
its own.

### P1 — The board (the bulk of the value)

Schema: `AddMissionBoardColumns` (10 columns on `missions`, 1 on
`work_agent_preferences`, 2 indexes).
Domain: `mission-lane.ts` (pure), `MissionBoardService`, `MissionStalenessService`,
`MissionTrashService`; progress writers wired into the six existing event owners;
`MissionsService` gains archive / unarchive / trash / restore, label
normalisation and the `include` filter.
API: `GET /board`, the four shelf verbs, additive create/update DTO fields.
Web: the tab strip, `MissionBoard` and its nine sibling components, the shelf,
the quick-create dialog, the poll hook, the new server actions.
Jobs: the staleness sweep and the trash purge.
i18n: everything in §8 except the `missionDetail.comments.*` block.

**Ships without**: comments (the card's comment chip is simply absent while the
count is 0), non-human origins (every Mission is origin `user`, which is true),
and the staleness settings control (the platform default of 2 days applies).

### P2 — The thread and steering

Schema: `CreateMissionComments`.
Domain: `MissionCommentService` reusing `RUN_STEERING_PORT`,
`AGENT_CHAT_REPLY_DISPATCHER` and `RunDispatchGateService`.
API: the three comment routes.
Web: `MissionCommentThread` on the detail page, the change-of-direction template
button, live comment counts on cards.
i18n: `dashboard.missionDetail.comments.*`.

### P3 — The whole queue

Schema: `AddInboundTriggerTargetKind`.
Domain: the Trigger fire path branches on `targetKind`; a new
`AgentActionProposalActionType` member lets an Agent propose a Mission through the
existing approval rail.
API: `targetKind` on trigger create; bulk archive.
Web: origin chips light up with real non-`user` values; the origin filter becomes
meaningful; the staleness threshold control lands in the work-agent settings page;
`Archive all Done older than 30 days` bulk action.

**Sequencing.** P1 has no dependency. P2 depends on P1 only for the
`commentCount` column. P3 depends on P1 for the origin columns. Nothing here
blocks or is blocked by another epic; AW-03 and AW-04 consume the same underlying
signals but through their own surfaces.

---

## 12. Constitution compliance

| Principle | Status | Justification |
| --- | --- | --- |
| **I — Plugin-first** | ✅ | No external integration is added; nothing in this epic calls a third party. |
| **II — Capability-driven** | ✅ | No plugin id anywhere. Agent execution is reached only via `AGENT_CHAT_REPLY_DISPATCHER` and `RUN_STEERING_PORT`; a provider-name grep over the diff must be empty, and that is a review gate. |
| **III — Source-of-truth repos** | ✅ | Priority, labels, board markers and comments are metadata about delegated work. No Work item, category or config moves into the database. |
| **IV — Job runtime** | ✅ | Both new crons are Trigger-shaped files in `packages/tasks/src/tasks/trigger/` delegating to agent-package services; every Run started from a comment goes through the existing dispatcher token. The agent package never imports a vendor SDK. |
| **V — Forward-only migrations** | ✅ | Three additive migrations in `apps/api/src/migrations/`, one per phase, no `DROP`, no type change, no `NOT NULL` without a default, no backfill needed. |
| **VI — Tests** | ✅ | §10: 6 agent-package unit suites, 5 controller specs, 8 Playwright specs, 6 colocated web unit specs. `deriveLane` is pure precisely so its truth table is exhaustively testable. |
| **VII — Secrets** | ✅ | No secret is introduced, read, logged or returned. `deliveryDetail` carries a reason string, never a payload value. |
| **VIII — Plugin counts** | ✅ | No plugin added; `docs/plugin-system/built-in-plugins.md` untouched. |
| **IX — Behaviour-first spec** | ✅ | `spec.md` names no class, file or library; every implementation detail is in this document. |
| **X — Backwards compatibility** | ✅ | All new request and response fields are optional and additive. The one default change (`GET /api/me/missions` excluding archived and trashed rows) cannot be observed by any existing consumer, because no such row can exist before P1's migration. `DELETE /api/me/missions/:id` keeps its current hard-delete semantics for direct callers. |

---

## 13. Follow-ups deliberately not taken here

1. **Extract a shared board primitive.** Four independent board implementations
   will exist after P1 (`TasksKanbanView`, `WorksKanbanView`,
   `ActivityKanbanView`, `MissionBoard`). Consolidating them is a real refactor
   with its own regression surface and should be its own change.
2. **Extract a shared comment-thread component.** The Task thread is inlined in
   `TaskDetailClient.tsx`; the Mission thread is built standalone in P2. Merging
   them afterwards is cheap and safe; merging them during P2 is not.
3. **Constitution §V path drift.** The Constitution names
   `apps/api/src/database/migrations/`; the code and `typeorm.config.ts` use
   `apps/api/src/migrations/`. Raise a one-line constitution amendment rather
   than silently following one or the other.
4. **Cursor pagination for `GET /board`.** Offset paging within a lane is
   adequate at the 50/200 caps; revisit if a workspace exceeds a few thousand
   Missions.

---

## 14. References

- Spec: [`./spec.md`](./spec.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Program overview: [`../README.md`](../README.md)
- Constitution: [`../../../../../.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Missions, Ideas and Works: [`../../missions-ideas-works/`](../../missions-ideas-works/)
- Task tracking (priority scale, comment thread, board precedent): [`../../task-tracking/`](../../task-tracking/)
- Schedules: [`../../schedules/spec.md`](../../schedules/spec.md)
- Tenants and Organizations (scope columns): [`../../tenants-and-organizations/`](../../tenants-and-organizations/)
</content>
