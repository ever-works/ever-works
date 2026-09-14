# Implementation Plan: Agent notes, personality, identity and levels

> Implementation detail for [`spec.md`](./spec.md). Per
> [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first)
> the spec owns behaviour; this document owns classes, files, columns and phases.

**Feature ID**: `AW-23-agent-identity`
**Program**: [Agent Workspace](../README.md) — Wave 3
**Branch**: `feat/aw-23-agent-identity`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Depends on**: [AW-07](../AW-07-memory-context/plan.md) — `NOTES.md`, the context-file
revision store and the load meter. This plan assumes AW-07 has landed and reuses those
mechanisms rather than re-implementing them.

---

## 1. Current state in the codebase

Every path below was read before it was cited.

### 1.1 The `Agent` entity

[`packages/agent/src/entities/agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts)
(484 lines). Relevant today:

| Concern          | Columns                                                                        | Notes                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle        | `status: AgentStatus` (`varchar(16)`, default `draft`)                         | Enum at line 49: `draft \| active \| running \| paused \| error \| archived`. The docblock above it lists the legal transitions.                                                                                                                                                    |
| Identity         | `name`, `slug`, `title`, `capabilities` (free text), `reportsToAgentId`        | `title` is free text; `reportsToAgentId` is the org chart and explicitly carries **no** authz weight.                                                                                                                                                                               |
| Permissions      | `permissions: AgentPermissions` (`simple-json`)                                | Eight booleans (`canCreateAgents`, `canAssignTasks`, `canEditSkills`, `canEditAgentFiles`, `canSpend`, `canCommitToRepo`, `canOpenPullRequests`, `canCallExternalTools`), all default `false`. `canOpenPullRequests` implies `canCommitToRepo`, enforced in `AgentsService.update`. |
| Approval posture | `guardrails: AgentGuardrails \| null`                                          | `null` = "queue every proposal".                                                                                                                                                                                                                                                    |
| Failure handling | `errorCount`, `pauseAfterFailures` (default `3`), `lastRunAt`, `lastRunStatus` | No column records _why_ the agent stopped.                                                                                                                                                                                                                                          |
| Files            | `soulMd`, `agentsMd`, `heartbeatMd`, `toolsMd`, `agentYml`, `contentHash`      | Workspace-scope agents store bodies here; Mission/Idea/Work-scope agents store them in their scope's git repo.                                                                                                                                                                      |
| Scope            | `tenantId`, `organizationId` (Tier A), `scope`, `scopeTargetId`                |                                                                                                                                                                                                                                                                                     |

Indexes at lines 204–207 include `idx_agents_user_status` on `(userId, status)` and
`idx_agents_next_heartbeat` on `(status, nextHeartbeatAt)`.

### 1.2 Pause today — one dispatch path out of six

`AgentsService.pause/resume`
([`packages/agent/src/agents/agents.service.ts`](../../../../../packages/agent/src/agents/agents.service.ts)
lines 934–939) is a thin wrapper over `transition()`, which validates against the
`USER_TRANSITIONS` table at line 194. Nothing else is written.

The **only** consumer of `status = 'paused'` on the dispatch side is the heartbeat claim:

- [`packages/agent/src/database/repositories/agent.repository.ts`](../../../../../packages/agent/src/database/repositories/agent.repository.ts)
  — `claimForHeartbeat` (line ~294) refuses unless `status = 'active'`; the CAS update at
  line ~311 adds `AND status = :active`.
- [`packages/agent/src/agents/agent-schedule-dispatcher.service.ts`](../../../../../packages/agent/src/agents/agent-schedule-dispatcher.service.ts)
  line 295 refuses anything that is not `ACTIVE` or `ERROR`.

Every other path ignores status entirely:

| Path            | Entry point                                                                                                                                 | Status check today                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task assignment | [`apps/api/src/agents/agents.controller.ts`](../../../../../apps/api/src/agents/agents.controller.ts) `assignTask`, line 1482               | **None.** It checks the agent exists, the task exists, a dispatcher is bound, dedups an in-flight run, and calls the concurrency gate. A paused agent runs. |
| Chat reply      | [`packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts)     | **None.** Only run-level status is inspected.                                                                                                               |
| Task execution  | [`packages/tasks/src/tasks/trigger/agent-task-execute.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-task-execute.task.ts) | **None.**                                                                                                                                                   |
| Delegation      | [`apps/api/src/agents/sub-agent-delegation.runner.ts`](../../../../../apps/api/src/agents/sub-agent-delegation.runner.ts) line 136          | Refuses only `ARCHIVED`. A paused child runs.                                                                                                               |
| Inbound email   | `AgentEmailAssignment` handling                                                                                                             | **None.**                                                                                                                                                   |
| Run now         | `agents.controller.ts` `POST :id/run-now`                                                                                                   | Goes through `claimForHeartbeat`, so it happens to be blocked — but with an opaque failure, not a stated refusal.                                           |

### 1.3 The single admission point that already exists

[`packages/agent/src/agents/run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts)
is a middleware chain — `(ctx, next) => Promise<verdict>` — folded by
`composeRunAdmission` into one callable, with the order expressed as data
(`DEFAULT_RUN_ADMISSION_CHAIN`). Shipped order: global stop flag (fail-**closed**), Work
concurrency valve, org/user valve, credits precheck (fail-open). Parked runs carry a
`queuedReason`; the three that exist are `concurrency-limit`,
`insufficient-credits` and `kill-switch`.

[`packages/agent/src/agents/run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts)
owns `admit()`, `drainForWork(workId, queuedReason)` (line 331) and `promoteParked()`
(line ~490, which fans `drainForWork` across every Work holding a run with that reason,
under a bounded promotion budget).

The **global stop flag** is the exact precedent for this epic's brake:
[`packages/agent/src/agents/run-kill-switch.ts`](../../../../../packages/agent/src/agents/run-kill-switch.ts)
is a zero-import leaf file declaring an interface plus an injection token; the gate
consumes it with `@Optional() @Inject(...)`; unbound it passes everything through; bound
it parks and fails closed. That is the shape the agent brake copies.

`RunAdmissionInput` today is `{ userId, workId?, organizationId? }` — it has **no
`agentId`**, which is why no middleware can see the agent. Adding the field is the whole
architectural change.

### 1.4 Where a parked run is protected from the sweeper

[`packages/agent/src/agents/agent-run-sweeper.service.ts`](../../../../../packages/agent/src/agents/agent-run-sweeper.service.ts)
line 141 passes `[QUEUED_REASON_KILL_SWITCH]` as `exemptQueuedReasons` into
`AgentRunRepository.findStuckNonTerminal`
([`agent-run.repository.ts`](../../../../../packages/agent/src/database/repositories/agent-run.repository.ts)
lines 366–428), and re-asserts the same rule in the service layer at line 160.
A new parked reason must be added in **both** places or held work is reaped.

### 1.5 The agent files

[`packages/agent/src/agents/agent-file.service.ts`](../../../../../packages/agent/src/agents/agent-file.service.ts):

- `AgentFileName` union at line 20 and the `AGENT_FILE_NAMES` allow-list at line 22.
- `assertValidName` (line 181) rejects anything outside the list.
- `readInline` (line 218) and the write mapper (line 235) switch on the name.
- `hashOf` (line 262) is the sha256 of the canonical concatenation, used as the ETag for
  optimistic concurrency on `PUT /api/agents/:id/files/:name`.
- Every write logs `AGENT_FILE_EDITED` with `prevHash` + `newHash`.

AW-07 extends this list with `NOTES.md`; this epic extends it with `PERSONALITY.md`.

### 1.6 Prompt assembly

[`packages/agent/src/agents/prompt-assembler.service.ts`](../../../../../packages/agent/src/agents/prompt-assembler.service.ts):

- `PROMPT_SEGMENTS` (line 27) is the ordered source of truth — today 11 members from
  `identity` to `output-contract`.
- `SEGMENT_TOKEN_CAPS` (line 46) — `null` means uncapped. `identity` and `role` are
  uncapped today.
- `TOTAL_SYSTEM_TOKEN_TARGET = 12_000` (line 61) is the backstop.
- Segments are emitted by `add(heading, name, body)` at line 185; `identity` is emitted
  first.
- Untrusted authored content is fenced and forged fence tokens are broken by
  `SEGMENT_FENCE_TOKEN_PATTERN` (line 486).

Spec of record: [`docs/specs/architecture/agent-prompt-assembly.md`](../../../architecture/agent-prompt-assembly.md).

### 1.7 The web surfaces

| Surface                  | File                                                                                                                                            | State today                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent detail shell       | [`apps/web/src/app/[locale]/(dashboard)/agents/[id]/layout.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/layout.tsx>) | `notFound()` when the agent is missing; renders `AgentDetailTabs`.                                                                                                                                                                                               |
| Dashboard tab (the hero) | [`apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx>)     | `STATUS_TONE` map at line 15; the hero prints **`{agent.status}` raw and untranslated** at line ~97. `IDLE_LABEL` at line 24 is keyed on `propose \| sleep \| self-improve`.                                                                                     |
| Tab strip                | [`apps/web/src/components/agents/AgentDetailTabs.tsx`](../../../../../apps/web/src/components/agents/AgentDetailTabs.tsx)                       | Ten tabs. **No new tab is added by this epic.**                                                                                                                                                                                                                  |
| Agent card in lists      | [`apps/web/src/components/agents/AgentCard.tsx`](../../../../../apps/web/src/components/agents/AgentCard.tsx)                                   | `statusLabel` (line 31) and `statusToneClass` (line 39); a coloured chip with no reason.                                                                                                                                                                         |
| Instructions editor      | [`apps/web/src/components/agents/AgentInstructionsEditor.tsx`](../../../../../apps/web/src/components/agents/AgentInstructionsEditor.tsx)       | Five pills, plain `textarea`, 800 ms autosave, `expectedHash` conflict banner.                                                                                                                                                                                   |
| API client               | [`apps/web/src/lib/api/agents.ts`](../../../../../apps/web/src/lib/api/agents.ts)                                                               | `pause()` line 461, `resume()` line 470. **`AgentIdleBehavior` is declared `propose \| sleep \| self-improve`** — drift against the backend enum `propose \| noop \| observe`, which makes `IDLE_LABEL[agent.idleBehavior]` render `undefined` for a real agent. |
| Server actions           | [`apps/web/src/app/actions/agents.ts`](../../../../../apps/web/src/app/actions/agents.ts)                                                       | `pauseAgentAction` line 75, `resumeAgentAction` line 83.                                                                                                                                                                                                         |
| Routes                   | [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) lines 180–206                                                   | `DASHBOARD_AGENT_*` helpers. No new route is added.                                                                                                                                                                                                              |
| Polling precedent        | [`apps/web/src/lib/hooks/use-kill-switch-polling.ts`](../../../../../apps/web/src/lib/hooks/use-kill-switch-polling.ts)                         | Interval constant, in-flight guard, last-known-state-on-error, server-rendered first paint. Copy this shape exactly.                                                                                                                                             |

### 1.8 Decisions, escalations and activity

- Open decisions: [`apps/api/src/agent-approvals/agent-approvals.controller.ts`](../../../../../apps/api/src/agent-approvals/agent-approvals.controller.ts)
  (pending `AgentActionProposal` rows) and
  [`apps/api/src/escalations/escalations.controller.ts`](../../../../../apps/api/src/escalations/escalations.controller.ts)
  (open `AgentEscalation` rows). Both are already agent-scoped and are the inputs to the
  `waitingOnYou` reason.
- Activity types: [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)
  lines 191–218 already contain `AGENT_PAUSED`, `AGENT_RESUMED`, `AGENT_FILE_EDITED`,
  `AGENT_TASK_ASSIGNED`. `actionType` is a free `varchar(50)`, so **adding members needs
  no migration**.
- Guardrail shape: [`packages/agent/src/agents/guardrails.ts`](../../../../../packages/agent/src/agents/guardrails.ts)
  — `{ mode: 'require_approval' | 'autonomous', autoApproveActionTypes?, blockedActionTypes? }`
  over the action types `spawn_agent | schedule_task | send_message | budget_override | other`.

### 1.9 What this epic does **not** have to build

Per [EXISTING-SUBSTRATE.md](../EXISTING-SUBSTRATE.md): the admission chain, the park/drain
machinery, the promotion budget, the agent-file endpoints with optimistic concurrency, the
activity log, the escalation and approval queues, and the 21-locale message pipeline all
exist and are tested. This epic is one middleware, six columns, three read models and a
card.

---

## 2. Architecture and the seam

```
                                 WRITE SIDE
  POST /api/agents/:id/pause  ──►  AgentsService.pause(userId, id, { note, stopInFlight })
    { note?, stopInFlight? }         │  transition()  (unchanged)
                                     ├─ AgentHaltService.halt(agentId, 'user', {note, byUserId})
                                     │      writes haltReason/haltNote/haltedAt/haltedByUserId
                                     └─ activity: AGENT_PAUSED (+ note)

  run failure classified as a       AgentHaltService.halt(agentId, 'credential', {runId, detail})
  rejected credential          ──►     + AgentsService.transition(→ paused)
                                       + activity: AGENT_BLOCKED_ON_CREDENTIAL

  POST /api/agents/:id/resume ──►  AgentsService.resume  →  AgentHaltService.clear(agentId)
                                     └─ RunDispatchGateService.promoteParkedForAgent(agentId)


                                 READ SIDE
  GET /api/agents/:id/identity ─► AgentIdentityService.build(agentId)
                                    ├─ AgentStatusReasonResolver.resolve(...)   (pure)
                                    ├─ AgentLevelService.diff(agent)            (pure)
                                    ├─ AgentLevelService.readiness(agent, runs) (pure)
                                    ├─ notes / personality first lines
                                    └─ in-flight run + next heartbeat

  GET /api/agents/status?ids=..─► AgentStatusReasonResolver over one batched query


                                 ENFORCEMENT SIDE
  every dispatch path ──► RunDispatchGateService.admit({ userId, workId, orgId, agentId })
                            └─ DEFAULT_RUN_ADMISSION_CHAIN
                                 1. killSwitch        (fail-closed)  existing
                                 2. agentBrake        (fail-closed)  NEW
                                 3. workValve                        existing
                                 4. orgValve                         existing
                                 5. creditsPrecheck   (fail-open)    existing
```

### 2.1 The single most important design decision

**The brake is a middleware in the existing admission chain, not a check at each call
site.** Adding `agentId?: string | null` to `RunAdmissionInput` and one middleware to
`DEFAULT_RUN_ADMISSION_CHAIN` means every present and future dispatch path that already
crosses `RunDispatchGateService.admit()` inherits the brake with no edit. The only call
sites that need touching are the ones that must now _pass_ `agentId` (they all already
have it in scope) and the two that do not currently go through the gate at all
(delegation and `run-now`), which get an explicit refusal instead.

This is why the epic is M and not L: the parking, the queue reason, the drain, the
promotion budget and the sweeper exemption are all existing, tested machinery. The brake
is a fourth `queuedReason` in a system built for exactly that.

### 2.2 Fail directions are deliberately opposite

| Component                                         | Direction                                           | Why                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `agentBrake` middleware                           | **fail-closed** — an unreadable agent parks the run | The control's promise is "it is stopped". A brake that fails open is not a brake. Matches the kill switch.            |
| `AgentStatusReasonResolver` read path             | **fail-soft** — keep the last known state           | A failed poll must never repaint a working agent as idle. Matches `use-kill-switch-polling`.                          |
| Unbound brake port (unit tests, trimmed installs) | pass-through                                        | Same posture as `RUN_KILL_SWITCH`; the port is optional so the gate stays constructible without the agent repository. |

### 2.3 The status reason is derived, never stored

`AgentStatusReasonResolver` is a **pure function** in the agent package:

```ts
resolve(input: {
  status: AgentStatus;
  haltReason: AgentHaltReason | null;
  haltNote: string | null;
  haltedAt: Date | null;
  haltedRunId: string | null;
  haltRepeatCount: number;
  inFlightRunId: string | null;
  inFlightActivity: string | null;
  inFlightStartedAt: Date | null;
  openDecisionCount: number;
  lastFailedRunId: string | null;
  consecutiveFailures: number;
  nextHeartbeatAt: Date | null;
  lastRunAt: Date | null;
}): AgentStatusReason
```

Precedence, evaluated top to bottom:

1. `status = archived` → `archived`
2. `status = running` **or** `inFlightRunId` present → `working`
3. `status = paused` and `haltReason = 'credential'` → `blockedOnCredential`
4. `status = paused` and `haltReason = 'cap'` → `stoppedAtACap`
5. `status = paused` and `haltReason = 'platform'` → `stoppedByThePlatform`
6. `status = paused` → `pausedByYou`
7. `status = error` → `stoppedByFailures`
8. `openDecisionCount > 0` → `waitingOnYou`
9. `status = draft` **or** `lastRunAt` is null → `notStarted`
10. otherwise → `idle`

One function, one table of cases, one unit spec. The compact card and the full card call
the same resolver server-side, which is what makes FR-7 ("they can never disagree")
structurally true rather than a promise.

### 2.4 Personality's position in the prompt

`personality` is inserted into `PROMPT_SEGMENTS` **after `role` and before
`capabilities`** — late enough that identity and role are established first, early enough
that it colours everything that follows, and always _before_ `tools`, `skills` and the
output contract so it can never displace a capability instruction under the total
backstop. Its cap is `600`, so unlike `identity`/`role` it is a capped segment and is
never the one truncated by the whole-message backstop.

Its heading is `# PERSONALITY (how you write)` and its body is fenced by the existing
untrusted-content wrapper, so a personality containing a forged turn boundary is
neutralised by machinery that already exists.

### 2.5 "From the next run" is a snapshot, not a promise

`AgentRun` gains `personalityHash` — the sha256 of the personality body, stamped at the
moment the run's prompt is assembled. The editor's "1 run in flight is still using the
previous version" line is computed by comparing the current body's hash against the
`personalityHash` of runs in a non-terminal state. This makes FR-55 checkable in a test
rather than asserted in prose.

### 2.6 Levels write, they do not gate

`AgentLevelService` is pure and stateless:

- `defaultsFor(level): { permissions: AgentPermissions; guardrails: AgentGuardrails | null }`
- `diff(agent): LevelDiffEntry[]` — one entry per field where the agent differs from its
  level's defaults
- `preview(agent, level): LevelPreview` — the diff plus `reducesAutonomy: boolean`
- `readiness(agent, stats): LevelReadiness | null`

Nothing in the runtime reads `agent.level`. `AgentApprovalsService`, `AgentToolService`
and the permission checks continue to read `agent.permissions` and `agent.guardrails`
exactly as they do today. This is what keeps AW-24 free to build a real trust ladder on
top without unwinding anything shipped here.

---

## 3. Data model

### 3.1 Changed entity — `Agent`

Six additive, nullable columns in
[`packages/agent/src/entities/agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts).
Placement: `level*` beside `title`; `haltReason*` in the `── Lifecycle ──` block after
`pauseAfterFailures`; `personalityMd` beside `agentYml` in the DB-only file block.

```ts
/** Declared autonomy tier (AW-23). NULL = never set; existing rows stay NULL. */
export enum AgentLevel {
	TRAINEE = 'trainee',
	ASSISTANT = 'assistant',
	SPECIALIST = 'specialist',
	LEAD = 'lead'
}

/** Why an Agent is not working. NULL = it is not halted. */
export enum AgentHaltReason {
	USER = 'user',
	CREDENTIAL = 'credential',
	FAILURES = 'failures',
	CAP = 'cap',
	PLATFORM = 'platform'
}

/** Non-secret descriptor of what refused the Agent. Display names only. */
export interface AgentHaltDetail {
	/** Human display name resolved through a facade — never a plugin id. */
	subjectLabel?: string;
	/** 'model-provider' | 'tool' | 'repository' | 'other' — what kind of thing it was. */
	subjectKind?: string;
}
```

| Column             | Type                 | Null | Default | Meaning                                                                                                                       |
| ------------------ | -------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `level`            | `varchar(16)`        | yes  | `null`  | `AgentLevel` or NULL for "not set".                                                                                           |
| `levelSetAt`       | `PortableDateColumn` | yes  | `null`  | When the level was last written.                                                                                              |
| `levelSetByUserId` | `uuid`               | yes  | `null`  | Who wrote it. No FK — matches `reportsToAgentId`'s raw-column posture.                                                        |
| `haltReason`       | `varchar(16)`        | yes  | `null`  | `AgentHaltReason`.                                                                                                            |
| `haltNote`         | `varchar(200)`       | yes  | `null`  | The optional human note from the pause dialog. Secret-scanned.                                                                |
| `haltedAt`         | `PortableDateColumn` | yes  | `null`  | When the halt was written.                                                                                                    |
| `haltedByUserId`   | `uuid`               | yes  | `null`  | Set only for `haltReason = 'user'`.                                                                                           |
| `haltedRunId`      | `uuid`               | yes  | `null`  | The run that caused an automatic halt.                                                                                        |
| `haltDetail`       | `simple-json`        | yes  | `null`  | `AgentHaltDetail`. **Never a credential, never a fragment of one.**                                                           |
| `haltRepeatCount`  | `int`                | no   | `0`     | Consecutive halts with the same reason; reset to 0 on clear. Drives FR-33.                                                    |
| `personalityMd`    | `text`               | yes  | `null`  | The Personality body for workspace-scope agents. Scoped agents store it in their scope's repo, exactly as the other files do. |

`PortableDateColumn` (from `packages/agent/src/entities/_types`) is required rather than
`type: 'timestamp'` — the integration specs boot on better-sqlite3 while production runs
Postgres, and the existing date columns on this entity already use it.

No new index. `haltReason` is only ever read for a single agent already fetched by
primary key, or as part of the batched status read which is keyed on `(userId, id IN …)`
and covered by `idx_agents_user_status`.

### 3.2 Changed entity — `AgentRun`

One additive column in
[`packages/agent/src/entities/agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts):

```ts
/** sha256 of the PERSONALITY.md body this run was assembled with (AW-23). */
@Column({ type: 'varchar', length: 64, nullable: true })
personalityHash?: string | null;
```

### 3.3 Changed file — `agent-file.service.ts`

- `AgentFileName` (line 20) gains `'PERSONALITY.md'`.
- `AGENT_FILE_NAMES` (line 22) appends it **last**, after `agent.yml`. Appending rather
  than inserting keeps the diff to `hashOf` a pure suffix (see below).
- `readInline` (line 218) and the write mapper (line 235) gain a `'PERSONALITY.md'` case
  mapping to `personalityMd`.
- `hashOf` (line 262) appends `+ 'YML/PERSONALITY' + merged.PERSONALITY` at the **end** of
  the concatenation.

> **Why the ETag does not break.** `contentHash` is _stored_, and `read()` returns the
> stored value. An existing row keeps its stored hash until its next write, at which point
> the hash is recomputed with the new formula — and the caller's `expectedHash`, read
> moments earlier, still matches the _old stored_ value. No backfill, no 409 storm. This
> is the same argument AW-07 makes for `NOTES.md`; both are covered by one regression
> spec asserting a write with a pre-change hash still succeeds.
>
> **Ordering with AW-07.** AW-07 inserts `NOTES.md` at position 3; this epic appends
> `PERSONALITY.md` last. The two are order-independent because both append their own
> suffix to `hashOf`. Whichever lands second rebases its suffix onto the other's.

### 3.4 Changed file — `run-admission-chain.ts`

```ts
/** Stamped when the agent brake parks a run because the Agent is paused (AW-23). */
export const QUEUED_REASON_AGENT_PAUSED = 'agent-paused' as const;

export interface RunAdmissionInput {
	userId: string;
	workId?: string | null;
	organizationId?: string | null;
	/** AW-23 — the Agent the run belongs to, so the brake middleware can see it. */
	agentId?: string | null;
}
```

`DEFAULT_RUN_ADMISSION_CHAIN` gains `agentBrakeMiddleware` in **position 2**, immediately
after the global stop flag and before the concurrency valves — a paused agent should not
consume a concurrency slot's worth of counting.

### 3.5 New leaf port — `run-agent-brake.ts`

New file `packages/agent/src/agents/run-agent-brake.ts`, zero imports, same shape as
[`run-kill-switch.ts`](../../../../../packages/agent/src/agents/run-kill-switch.ts):

```ts
export interface AgentBrakeVerdict {
	halted: boolean;
	/** 'user' | 'credential' | 'failures' | 'cap' | 'platform' — for the log line only. */
	reason?: string;
}

export interface RunAgentBrake {
	/** Fail-CLOSED at the consumer: a throw parks the run. */
	shouldHaltForAgent(agentId: string): Promise<AgentBrakeVerdict>;
}

export const RUN_AGENT_BRAKE = 'RUN_AGENT_BRAKE' as const;

/** Error.name thrown by an api-side dispatcher that read the brake after admission. */
export const AGENT_PAUSED_ERROR_NAME = 'AgentPausedError' as const;
```

### 3.6 New repository methods

[`packages/agent/src/database/repositories/agent-run.repository.ts`](../../../../../packages/agent/src/database/repositories/agent-run.repository.ts):

```ts
/** Oldest run parked for this Agent with `queuedReason`, for the resume drain. */
findOldestQueuedForAgent(agentId: string, queuedReason: string): Promise<AgentRun | null>;

/** Count + preview of runs parked for this Agent, for the "held work" panel. */
listQueuedForAgent(agentId: string, queuedReason: string, limit: number): Promise<...>;

/** Non-terminal runs of this Agent whose personalityHash differs from `hash`. */
countInFlightWithOtherPersonality(agentId: string, hash: string | null): Promise<number>;
```

Both parked-run queries mirror `findOldestQueuedForConcurrency` (line 1164) — same
`status = 'queued' AND queuedReason = :reason` predicate, keyed on `agentId` instead of
`workId`.

[`agent.repository.ts`](../../../../../packages/agent/src/database/repositories/agent.repository.ts):

```ts
/** Batched status read for the roster poll — one query, <=100 ids, user-scoped. */
findStatusRows(userId: string, ids: string[], scope?: OwnershipScope): Promise<AgentStatusRow[]>;

/** Halt/clear writes, CAS on the current halt state so a double-pause is a no-op. */
writeHalt(id: string, patch: HaltPatch): Promise<boolean>;
clearHalt(id: string): Promise<void>;
```

### 3.7 Migrations (forward-only, `apps/api/src/migrations/`)

Three files, all using `queryRunner.getTable()` existence guards and portable
`TableColumn` DDL, following
[`1789100000000-AddTaskGraphFanout.ts`](../../../../../apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts)
exactly. Column names are camelCase — that is this database's convention, verified
against every recent migration.
Timestamps are AW-23 slots 00–02 of the program's reserved migration blocks ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)),
numbered in apply order (P1 halt, P2 level, P3 personality); re-stamp before merge if `develop`
has moved past them.

| File                                   | Contents                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1791230000000-AddAgentHaltReason.ts`  | `agents.haltReason varchar(16) NULL`, `agents.haltNote varchar(200) NULL`, `agents.haltedAt timestamp NULL`, `agents.haltedByUserId uuid NULL`, `agents.haltedRunId uuid NULL`, `agents.haltDetail text NULL`, `agents.haltRepeatCount int NOT NULL DEFAULT 0`. Existing paused agents read as _"Paused by you"_ with no time and no note, which is the truthful rendering of what we know about them. |
| `1791230100000-AddAgentLevel.ts`       | `agents.level varchar(16) NULL`, `agents.levelSetAt timestamp NULL`, `agents.levelSetByUserId uuid NULL`. No backfill: every existing agent stays "not set" (FR-35).                                                                                                                                                                                                                                   |
| `1791230200000-AddAgentPersonality.ts` | `agents.personalityMd text NULL`, `agent_runs.personalityHash varchar(64) NULL`.                                                                                                                                                                                                                                                                                                                       |

Every `down()` drops in reverse order with `findColumnByName` guards, re-reading the table
between drops (sqlite rebuilds the table on `dropColumn`, which staleness the fan-out
migration documents at its own `down`).

No `DROP COLUMN` of an existing column, no rename, no data movement. Reverting loses only
the new values.

### 3.8 Contracts (`packages/contracts/src/agents/`)

Three new files, re-exported from
[`packages/contracts/src/agents/index.ts`](../../../../../packages/contracts/src/agents/index.ts)
(which is already re-exported from
[`packages/contracts/src/index.ts`](../../../../../packages/contracts/src/index.ts) line 11):

```ts
// level.types.ts
export const AGENT_LEVELS = ['trainee', 'assistant', 'specialist', 'lead'] as const;
export type AgentLevelValue = (typeof AGENT_LEVELS)[number];

export const AGENT_LEVEL_ORDER: Record<AgentLevelValue, number> = {
    trainee: 0, assistant: 1, specialist: 2, lead: 3
};

/** Promotion-readiness thresholds (spec FR-45). */
export const AGENT_LEVEL_READINESS_WINDOW_DAYS = 30;
export const AGENT_LEVEL_READINESS_MIN_RUNS = 20;
export const AGENT_LEVEL_READINESS_MAX_REJECTED_APPROVALS = 0;
export const AGENT_LEVEL_READINESS_MAX_ESCALATIONS = 1;

export interface LevelDiffEntry {
    field: string;            // 'canSpend' | 'guardrails' | ...
    levelValue: unknown;
    agentValue: unknown;
    reducesAutonomy: boolean;
}
export interface LevelPreview {
    level: AgentLevelValue;
    changes: LevelDiffEntry[];
    reducesAutonomy: boolean;
    /** sha256 of the agent's permissions+guardrails at preview time (FR-48). */
    baseHash: string;
}

// status.types.ts
export const AGENT_STATUS_REASONS = [
    'working', 'idle', 'waitingOnYou', 'pausedByYou', 'blockedOnCredential',
    'stoppedByFailures', 'stoppedAtACap', 'stoppedByThePlatform',
    'notStarted', 'archived'
] as const;
export type AgentStatusReasonCode = (typeof AGENT_STATUS_REASONS)[number];

export const AGENT_STATUS_DOT: Record<AgentStatusReasonCode,
    'green' | 'amber' | 'red' | 'grey' | 'greyOutline'> = { /* spec FR-11 */ };

export const AGENT_STATUS_POLL_INTERVAL_MS = 10_000;
export const AGENT_STATUS_BATCH_MAX = 100;

export interface AgentStatusDto {
    agentId: string;
    reason: AgentStatusReasonCode;
    /** Link target for the reason's action, when there is one. */
    linkKind?: 'run' | 'decision' | 'connection';
    linkId?: string;
    note?: string | null;
    since?: string | null;      // ISO 8601
    repeatCount?: number;
    inFlightCount: number;
    heldCount: number;
}

// identity.types.ts
export const AGENT_PERSONALITY_MAX_BYTES = 8 * 1024;
export const AGENT_PERSONALITY_TOKEN_BUDGET = 600;
export const AGENT_HALT_NOTE_MAX = 200;
export const AGENT_RESUME_PROMOTION_BUDGET = 50;

export interface AgentIdentityDto {
    agent: { id: string; name: string; slug: string; title: string | null; avatar: {...} };
    status: AgentStatusDto;
    level: {
        value: AgentLevelValue | null;
        driftCount: number;
        readiness: { nextLevel: AgentLevelValue; runs: number;
                     rejectedApprovals: number; escalations: number } | null;
    };
    notesPreview: string | null;       // first 2 lines, from AW-07
    personalityPreview: string | null; // first 2 lines
    workingOn: { runId: string; activity: string | null; startedAt: string } | null;
    nextRunAt: string | null;
}
```

Nothing here is a numeric literal repeated anywhere else — the API DTO validators, the
services and the web components all import these constants (`.claude/skills` DTS gotcha:
declare every conditional property with an explicit `if` block, never `...cond && {k:v}`).

---

## 4. API surface

All new endpoints live in the existing
[`apps/api/src/agents/agents.controller.ts`](../../../../../apps/api/src/agents/agents.controller.ts)
unless a new file is named. Auth is the module's standard `@CurrentUser()` +
`ScopeContext`; every read 404s cross-user exactly as `getOne` already does. Throttles use
the module's existing `@Throttle({ long: { … } })` convention.

### 4.1 New endpoints

| Method | Path                            | Body / query                                           | Returns                                                                                                                                     | Throttle  |
| ------ | ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `GET`  | `/api/agents/:id/identity`      | —                                                      | `AgentIdentityDto`                                                                                                                          | `120/min` |
| `GET`  | `/api/agents/status`            | `?ids=a,b,c` (≤ 100, 400 above)                        | `{ statuses: AgentStatusDto[] }`                                                                                                            | `120/min` |
| `GET`  | `/api/agents/levels`            | —                                                      | `{ levels: [{ value, defaults }] }` — static catalogue so the web never hardcodes the table                                                 | `120/min` |
| `GET`  | `/api/agents/:id/level`         | —                                                      | `{ level, diff: LevelDiffEntry[], readiness }`                                                                                              | `120/min` |
| `POST` | `/api/agents/:id/level/preview` | `{ level }`                                            | `LevelPreview` (includes `baseHash`)                                                                                                        | `30/min`  |
| `PUT`  | `/api/agents/:id/level`         | `{ level, applyDefaults: boolean, baseHash?: string }` | `AgentDto` + `{ applied: LevelDiffEntry[] }`; **409** when `applyDefaults` is true and `baseHash` is stale, carrying a fresh `LevelPreview` | `30/min`  |
| `GET`  | `/api/agents/:id/held`          | `?limit=20`                                            | `{ total, items: [{ runId, kind, title, heldAt }] }`                                                                                        | `120/min` |

> `GET /api/agents/status` and `GET /api/agents/levels` are **static segments** and must be
> declared **before** `@Get(':id')` in the controller, the same ordering constraint the
> skills controller documents for its `invocable` route. A controller spec asserts it.

### 4.2 Extended endpoints

| Endpoint                                                 | Change                                                                                                                                                                                 | Backwards compatibility                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `POST /api/agents/:id/pause`                             | Accepts an **optional** body `{ note?: string (≤200), stopInFlight?: boolean }`. Response gains `{ heldCount, inFlightCount }`.                                                        | Body was previously absent; an empty body behaves exactly as today. Response is additive. |
| `POST /api/agents/:id/resume`                            | Clears the halt, then calls `promoteParkedForAgent`. Response gains `{ releasedCount }`.                                                                                               | Additive.                                                                                 |
| `POST /api/agents/:id/run-now`                           | Returns **409 `AgentPausedError`** with `{ message: 'agentPaused' }` when the agent is paused, before creating any run row.                                                            | Today it fails opaquely inside `claimForHeartbeat`; the new refusal is earlier and named. |
| `POST /api/agents/:id/assign-task`                       | Passes `agentId` into `dispatchGate.admit(...)`. A paused agent yields `{ runId, queued: true, queuedReason: 'agent-paused' }` — the same shape the concurrency valve already returns. | The response field already exists; only a new value appears in it.                        |
| `GET                                                     | PUT /api/agents/:id/files/:name`                                                                                                                                                       | `PERSONALITY.md` is now a valid `:name`.                                                  | Additive; unknown names still 400. |
| `PATCH /api/agents/:id`                                  | **Rejects** `level` — level is written only through `PUT :id/level` so a level change can never bypass the preview.                                                                    | New 400 on a field that was never accepted.                                               |
| `GET /api/agents` and `GET /api/agents/:id`              | `AgentDto` gains `level`, `haltReason`, `haltNote`, `haltedAt`, `personalityMd` (workspace scope only, same as the other file columns).                                                | Additive fields on an existing DTO (Constitution X).                                      |
| `GET /api/agents/:id/export` / `POST /api/agents/import` | Envelope carries `level` and `PERSONALITY.md`. An import that carries a level applies the **label only**, never the defaults.                                                          | Additive; older envelopes import unchanged.                                               |

### 4.3 DTOs

New file `apps/api/src/agents/dto/agent-identity.dto.ts`, and additions to
[`apps/api/src/agents/dto/agent.dto.ts`](../../../../../apps/api/src/agents/dto/agent.dto.ts):

```ts
export class PauseAgentDto {
	@IsOptional() @IsString() @MaxLength(AGENT_HALT_NOTE_MAX) note?: string;
	@IsOptional() @IsBoolean() stopInFlight?: boolean;
}

export class SetAgentLevelDto {
	@IsIn(AGENT_LEVELS) level: AgentLevelValue;
	@IsBoolean() applyDefaults: boolean;
	@IsOptional() @IsString() @Length(64, 64) baseHash?: string;
}

export class AgentStatusQueryDto {
	@IsString() ids: string; // comma-separated; parsed + capped at AGENT_STATUS_BATCH_MAX
}
```

`AgentDto` gains `@ApiProperty({ required: false, enum: AGENT_LEVELS }) level?`, plus the
halt fields. `UpdateAgentDto` gains **no** `level` field (see §4.2).

### 4.4 Web BFF and server actions

No new BFF route handlers. The web layer already reaches the API through
[`apps/web/src/lib/api/agents.ts`](../../../../../apps/web/src/lib/api/agents.ts) and
server actions in
[`apps/web/src/app/actions/agents.ts`](../../../../../apps/web/src/app/actions/agents.ts),
which is the pattern the kill-switch poll uses. Add to the client:

```ts
agentsAPI.getIdentity(id)
agentsAPI.getStatuses(ids: string[])
agentsAPI.getLevels()
agentsAPI.getLevel(id)
agentsAPI.previewLevel(id, level)
agentsAPI.setLevel(id, { level, applyDefaults, baseHash })
agentsAPI.listHeld(id)
agentsAPI.pause(id, { note?, stopInFlight? })   // widened
```

and the matching actions `getAgentIdentityAction`, `getAgentStatusesAction`,
`getAgentLevelsAction`, `previewAgentLevelAction`, `setAgentLevelAction`,
`listAgentHeldAction`, plus a widened `pauseAgentAction(id, input?)`.

**Also fix, in the same change**: `AgentIdleBehavior` in `apps/web/src/lib/api/agents.ts`
is declared `'propose' | 'sleep' | 'self-improve'` and the backend enum is
`'propose' | 'noop' | 'observe'`. The identity card renders idle behaviour, so shipping the
card on top of a lookup that returns `undefined` for two of three real values is not an
option. Correcting the union and the `IDLE_LABEL` map in
[`agents/[id]/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx>)
is a one-line-each correctness fix inside files this epic already edits.

---

## 5. Web surface

### 5.1 New components (`apps/web/src/components/agents/`)

| File                              | Role                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentIdentityCard.tsx`           | The full card (spec §6.1–6.5). Server component for the first paint; wraps the client status region.                                       |
| `AgentIdentityCard.unit.spec.tsx` | Every state: working, paused, blocked, errored, never-run, archived, level-not-set, drift, readiness.                                      |
| `AgentStatusDot.tsx`              | Dot + reason headline + sub-line + action link. The single renderer for status, used by the card, the compact card, the list and the hero. |
| `AgentStatusDot.unit.spec.tsx`    | One case per `AgentStatusReasonCode`, plus the "colour is never alone" assertion.                                                          |
| `AgentCompactIdentity.tsx`        | Avatar + name + dot + reason headline + level chip, for lists.                                                                             |
| `AgentLevelBadge.tsx`             | The chip, including the "not set" and drift variants.                                                                                      |
| `AgentLevelDialog.tsx`            | Radio list, defaults checkbox, live preview, reduce-autonomy relabelling, stale-preview recovery.                                          |
| `AgentLevelDialog.unit.spec.tsx`  | Preview rendering, the reduce path, the defaults-cleared path, the 409 path.                                                               |
| `AgentLevelDriftList.tsx`         | The difference list (spec §6.8).                                                                                                           |
| `AgentPauseDialog.tsx`            | Note field with a 200-char counter, in-flight line, confirm.                                                                               |
| `AgentPauseDialog.unit.spec.tsx`  | Counter, disable-at-limit, `Cmd/Ctrl+Enter`, secret-refusal surfacing.                                                                     |
| `AgentHeldWorkPanel.tsx`          | The held list (spec §6.11).                                                                                                                |

Add every one to
[`apps/web/src/components/agents/index.ts`](../../../../../apps/web/src/components/agents/index.ts).

### 5.2 New hook

`apps/web/src/lib/hooks/use-agent-status-polling.ts` — a direct structural copy of
[`use-kill-switch-polling.ts`](../../../../../apps/web/src/lib/hooks/use-kill-switch-polling.ts):

- `AGENT_STATUS_POLL_INTERVAL_MS` imported from contracts, not redeclared.
- `inFlight` ref guard so a slow response never stacks.
- Server-rendered first paint handed in as `initialState`, so the card is correct before
  the first tick.
- On error: keep the last state, set `error`, expose `lastCheckedAt`. **Never** blank.
- Adds one thing the kill-switch hook does not need: a `document.visibilitychange`
  listener that clears the interval when hidden and fires an immediate tick on return
  (FR-18).
- Accepts an array of ids and issues **one** request (FR-19).

Plus `use-agent-status-polling.unit.spec.tsx` covering the visibility pause, the
keep-last-state-on-error rule and the batching.

### 5.3 Changed surfaces

| File                                                                                                                            | Change                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agents/[id]/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx>)                           | Replace the hero `<section>` with `<AgentIdentityCard/>`, server-fetching `agentsAPI.getIdentity(id)` alongside the existing `agentsAPI.get(id)`. Keep the stat tiles, `AgentGuardrailsCard` and `AgentAttachmentsPanel` untouched below it. Fix `IDLE_LABEL`.                                                 |
| [`AgentCard.tsx`](../../../../../apps/web/src/components/agents/AgentCard.tsx)                                                  | Swap the bare status chip for `<AgentStatusDot compact/>`; keep `statusLabel`/`statusToneClass` exports so nothing else breaks.                                                                                                                                                                                |
| [`AgentsList.tsx`](../../../../../apps/web/src/components/agents/AgentsList.tsx)                                                | Mount `useAgentStatusPolling` once for the visible page of agents and thread the result down.                                                                                                                                                                                                                  |
| [`AgentInstructionsEditor.tsx`](../../../../../apps/web/src/components/agents/AgentInstructionsEditor.tsx)                      | Seven pills instead of five: Identity, Role, **Notes** (AW-07), **Personality**, Operating loop, Tools, Manifest. The pill labels become i18n keys; the file names stay. Personality's pane adds the permanent notice (FR-54), the load meter (reused from AW-07) and the "takes effect on the next run" line. |
| [`agents/[id]/instructions/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/instructions/page.tsx>) | Fetch seven files instead of five.                                                                                                                                                                                                                                                                             |
| [`agents/[id]/settings/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/settings/page.tsx>)         | A read-only level row that links to the dialog. Settings does **not** get a second way to write a level.                                                                                                                                                                                                       |

No route is added; `apps/web/src/lib/constants.ts` is not touched.

### 5.4 Data fetching

- The card's first paint is server-rendered from `GET /api/agents/:id/identity` in the RSC.
- The status region hydrates and takes over polling with the server payload as its seed.
- The level dialog fetches `GET /api/agents/levels` once and caches it for the session —
  it is static data and must not be re-fetched per open.
- The held-work panel is fetched lazily, only when the reason is a halt reason and
  `heldCount > 0`.

---

## 6. Background work

**This epic adds no scheduled job and no new dispatcher.** That is a deliberate outcome of
§2.1: the brake is a synchronous check inside an admission path that already runs, and the
release is the existing promotion path.

Two existing background components are **modified**:

1. **The stale-run sweeper.**
   [`agent-run-sweeper.service.ts`](../../../../../packages/agent/src/agents/agent-run-sweeper.service.ts)
   line 141 passes `[QUEUED_REASON_KILL_SWITCH]` as `exemptQueuedReasons`; it becomes
   `[QUEUED_REASON_KILL_SWITCH, QUEUED_REASON_AGENT_PAUSED]`. The service-layer
   belt-and-braces filter at line 160 gains the same member. Missing either half reaps
   held work and turns "nothing is lost" into a lie (FR-26).

2. **The resume drain.** `RunDispatchGateService` gains
   `promoteParkedForAgent(agentId, budget = AGENT_RESUME_PROMOTION_BUDGET)`, which reuses
   `drainForWork`'s claim-CAS-and-enqueue body via the new
   `findOldestQueuedForAgent`. It is called by `AgentsService.resume` **after** the status
   transition commits, is best-effort, and never throws — identical posture to
   `promoteParked` after a stop-flag clear.

Every enqueue inside that drain goes through the existing `*_DISPATCHER` DI symbols
(`AGENT_TASK_EXECUTE_DISPATCHER`, `AGENT_CHAT_REPLY_DISPATCHER`) that `drainForWork`
already uses, so Constitution IV is satisfied by reuse — no call site in this epic imports
a third-party SDK or touches a queue.

---

## 7. Plugin boundaries

- **No new plugin package**, because no external service is contacted. Constitution I is
  satisfied vacuously.
- **No hardcoded plugin id** (Constitution II). The credential-halt path must name what
  was rejected for the user. It does that by resolving a **display name** through the
  existing facade the failing call already went through, and storing it in
  `haltDetail.subjectLabel`. There is no `if (pluginId === 'openai')` anywhere; the halt
  detail carries a string the facade produced and a coarse `subjectKind`.
- **Credential detection.** Where [AW-09](../AW-09-runs-receipts/plan.md) has landed, the
  classifier's output is the input: a run classified `provider-error` or `tool-error`
  whose cause is an authentication rejection maps to `haltReason = 'credential'`. Where it
  has not, `AgentHaltClassifier` in `packages/agent/src/agents/agent-halt-classifier.ts`
  applies a narrow, pure predicate over the run's `errorMessage` and status code
  (`401`/`403`, and a small closed list of provider-agnostic phrases), defaulting to _not_
  a credential fault. It is deliberately conservative: a false negative costs the user the
  old three-failure path, a false positive halts a healthy agent.
- **When [AW-15](../AW-15-connections-scopes/plan.md) lands**, its connection-health
  signal becomes a second input to the same `haltReason = 'credential'` write. No schema
  change is needed for that; the seam is `AgentHaltService.halt(agentId, 'credential', …)`
  and it is already called from one place.

---

## 8. i18n

All keys under `dashboard.agentsPage` in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json), extending the
existing namespace listed in §6 of the agents inventory. **Every leaf name is camelCase
and contains no literal dot** — a dot in a leaf name is rejected by next-intl at runtime
and reds several e2e shards at once.

```jsonc
"dashboard": {
  "agentsPage": {
    "identity": {
      "workingOn": "Working on",
      "notes": "Notes",
      "personality": "Personality",
      "level": "Level",
      "edit": "Edit",
      "change": "Change",
      "openTheRun": "Open the run",
      "noNotes": "No notes yet",
      "noPersonality": "No personality set",
      "noTitle": "No title set",
      "noSchedule": "No schedule set",
      "nextRunAt": "Next run {time}",
      "nothingPaused": "Nothing — this agent is paused. {count} runs are held.",
      "showTheHeld": "Show the held",
      "startedAgo": "Started {relative}"
    },
    "status": {
      "working": "Working",
      "idle": "Idle",
      "waitingOnYou": "Waiting on you",
      "pausedByYou": "Paused by you",
      "blockedOnCredential": "Blocked on a credential",
      "stoppedByFailures": "Hit an error",
      "stoppedAtACap": "Stopped at a spend cap",
      "stoppedByThePlatform": "Stopped by the platform",
      "notStarted": "Not started",
      "archived": "Archived",
      "subWorking": "{activity}",
      "subIdle": "Next scheduled run {relative}",
      "subWaitingOnYou": "{count} decisions open",
      "subPausedByYou": "Since {time}",
      "subPausedByYouWithNote": "Since {time} — \"{note}\"",
      "subBlockedOnCredential": "{subject} rejected this agent's account at {time}.",
      "subStoppedByFailures": "{count} runs failed in a row — last one {relative}.",
      "subStoppedAtACap": "Reached its cap.",
      "subStoppedByThePlatform": "An operator stopped all agents.",
      "subNotStarted": "This agent has never run.",
      "subArchived": "Restore it to use it again.",
      "seeTheFailingRun": "See the failing run",
      "seeTheRun": "See the run",
      "fixTheConnection": "Fix the connection",
      "openTheDecision": "Open the decision",
      "repeatedHalt": "Halted for this reason twice.",
      "lastChecked": "Status last checked {relative}.",
      "stillFinishing": "{count} run still finishing",
      "stopItNow": "Stop it now"
    },
    "pause": {
      "title": "Pause {name}",
      "explainer": "It stops picking up scheduled runs, assigned tasks, chat replies, email and delegated work. Anything already held is released when you resume. Nothing is lost.",
      "noteLabel": "Why? (optional)",
      "noteCounter": "{used} / {max}",
      "inFlight": "{count} run is in flight. It will finish.",
      "cancel": "Cancel",
      "confirm": "Pause agent",
      "resumed": "Resumed — {count} held runs released.",
      "alreadyPaused": "Someone else changed this — showing the current state.",
      "runNowRefused": "This agent is paused. Resume it first.",
      "delegationRefused": "That agent is paused.",
      "noteSecret": "That looks like a secret. Remove it from the note and try again."
    },
    "held": {
      "title": "Held while {name} is paused",
      "count": "{count} items",
      "explainer": "These are released oldest first when you resume. Nothing is lost.",
      "kindTask": "Task",
      "kindChat": "Chat",
      "kindEmail": "Email",
      "heldAgo": "held {relative}",
      "empty": "Nothing is held."
    },
    "levels": {
      "notSet": "Level not set",
      "setALevel": "Set a level",
      "dialogTitle": "Level for {name}",
      "trainee": "Trainee",
      "assistant": "Assistant",
      "specialist": "Specialist",
      "lead": "Lead",
      "traineeMeaning": "Nothing leaves without you.",
      "assistantMeaning": "Routine work runs. Anything that reaches the outside waits.",
      "specialistMeaning": "Owns its lane end to end. Money and public actions still wait.",
      "leadMeaning": "Coordinates other agents and can spend within its cap.",
      "applyDefaults": "Apply this level's defaults",
      "changesHeading": "This changes {count} settings",
      "reducesHeading": "This takes autonomy away",
      "alwaysQueues": "Sending a message outside the workspace and overriding a budget always wait for you, at every level.",
      "labelOnly": "Only the level is recorded. No permission or approval setting changes — the card will show {count} settings differing from the {level} defaults.",
      "confirmApply": "Set level and apply",
      "confirmReduce": "Apply and reduce autonomy",
      "confirmLabelOnly": "Set level",
      "driftLine": "{count} settings differ from the {level} defaults",
      "showTheDifferences": "Show the differences",
      "driftTitle": "Settings that differ from the {level} defaults",
      "driftRow": "{field} — {level}: {levelValue} · this agent: {agentValue}",
      "driftExplainer": "The agent's own settings are what the platform enforces. The level is a label and a set of defaults.",
      "applyTheDefaults": "Apply the {level} defaults",
      "readiness": "Ready for {level} — {runs} runs, no rejected approvals, {escalations} escalations in {days} days.",
      "review": "Review",
      "stalePreview": "This agent changed since the preview — here is the new preview.",
      "inFlightKeepsPermissions": "{count} run in flight keeps the permissions it started with.",
      "unavailable": "Levels are unavailable right now. The agent's own settings are unchanged.",
      "fieldCanCreateAgents": "Create other agents",
      "fieldCanAssignTasks": "Assign tasks",
      "fieldCanEditSkills": "Edit skills",
      "fieldCanEditAgentFiles": "Edit its own agent files",
      "fieldCanSpend": "Spend",
      "fieldCanCommitToRepo": "Commit to a repository",
      "fieldCanOpenPullRequests": "Open pull requests",
      "fieldCanCallExternalTools": "Call external tools",
      "fieldGuardrails": "Approvals",
      "valueYes": "yes",
      "valueNo": "no",
      "guardrailsQueueEverything": "everything queues",
      "guardrailsRoutineRuns": "routine work runs; money and outside actions still queue"
    },
    "personality": {
      "pill": "Personality",
      "notice": "Personality changes how this agent writes, never what it may do. Permissions live on the Capabilities tab.",
      "empty": "No personality set — this agent writes in the platform's default voice.",
      "tryOne": "Try one:",
      "starterOne": "Short sentences. No adjectives you would not say out loud.",
      "starterTwo": "Always show your working before your conclusion.",
      "starterThree": "Write like a colleague, not a press release.",
      "use": "Use",
      "savedNextRun": "Saved — takes effect on the next run.",
      "savedNextRunInFlight": "Saved — takes effect on the next run. {count} run in flight is still using the previous version.",
      "overBudget": "Lead with the rules that matter most — the top of the file is the part that always survives.",
      "tooLarge": "Personality is limited to 8 KB. This is {size} — trim it and save again.",
      "secret": "That looks like a secret. Personality is stored as plain text and shown to the agent — remove the value in {field} and save again."
    },
    "tabs": {
      "notes": "Notes"
    }
  }
}
```

`dashboard.agentsPage.card` keeps every key it has (`statusDraft` … `statusArchived`) —
nothing is removed, so the existing list rendering keeps working through the transition.

After English lands, run the repo's locale sync so all 21 message files gain the
full key paths; a **missing parent key collapses the whole subtree**, so `identity`,
`status`, `pause`, `held`, `levels` and `personality` must each exist in every file even
when untranslated.

---

## 9. Telemetry and failure modes

### 9.1 Activity feed

Four new members appended to `ActivityActionType` in
[`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts).
`actionType` is a free `varchar(50)`, so **no migration is required** — the enum is a
TypeScript-side constraint only, exactly as the Schedules spec establishes for its own
additions.

| Member                                                        | Written when                             | Details                                                         |
| ------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `AGENT_LEVEL_CHANGED = 'agent_level_changed'`                 | `PUT :id/level` succeeds                 | `{ from, to, appliedDefaults, changedFields: string[] }`        |
| `AGENT_BLOCKED_ON_CREDENTIAL = 'agent_blocked_on_credential'` | `AgentHaltService.halt(_, 'credential')` | `{ runId, subjectLabel, subjectKind }` — **never a credential** |
| `AGENT_RUN_HELD = 'agent_run_held'`                           | The brake parks a run                    | `{ runId, agentId, reason }`                                    |
| `AGENT_RUNS_RELEASED = 'agent_runs_released'`                 | Resume drains                            | `{ releasedCount, remaining }`                                  |

Existing `AGENT_PAUSED` gains `{ note, stopInFlight, heldCount }` in its details;
`AGENT_RESUMED` gains `{ releasedCount }`. Both are additive JSON, no shape change.

### 9.2 Run logs

`AgentRunLog` lines (INFO) written by the brake and the drain:

- `step: 'admission'`, `message: 'held — the agent is paused'`, `metadata: { agentId, reason }`
- `step: 'admission'`, `message: 'released after resume'`, `metadata: { agentId, heldMs }`
- `step: 'prompt'`, `message: 'personality applied'`, `metadata: { personalityHash, tokens, truncated }`

### 9.3 Product analytics

Through the existing `packages/monitoring` surface:
`agent.level.set` (`{ from, to, appliedDefaults }`), `agent.level.readiness_shown`,
`agent.paused` (`{ hasNote, heldCount }`), `agent.resumed` (`{ releasedCount, pausedMs }`),
`agent.halted` (`{ reason, repeatCount }`), `agent.personality.saved`
(`{ tokens, overBudget }`). No payload carries free text the user typed.

### 9.4 Failure modes

| Failure                                                | Behaviour                                                                                                      | Rationale                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Brake port unbound                                     | Pass-through                                                                                                   | Unit tests and trimmed installs must still construct the gate. Matches `RUN_KILL_SWITCH`. |
| Brake read throws                                      | **Park the run**                                                                                               | FR-30. The brake fails closed.                                                            |
| Halt write fails after a successful status transition  | The agent is paused with no reason; the card shows _"Paused by you"_ with no time. Logged as a warning.        | A missing reason is a degraded label. A failed pause would be a lie.                      |
| `promoteParkedForAgent` throws                         | Swallowed and logged; the agent is resumed, held runs stay held until the next terminal transition drains them | Never fail a resume because the drain hiccuped. Matches `promoteParked`.                  |
| Identity read fails                                    | The page falls back to today's hero rendering with the raw status chip                                         | The detail page must never 500 because a new panel could not compose.                     |
| Status poll fails                                      | Last known state + _"last checked"_ line                                                                       | FR-20.                                                                                    |
| Level catalogue read fails                             | Dialog shows _"Levels are unavailable right now"_; nothing is written                                          | FR-44's corollary: the level is never guessed client-side.                                |
| Personality secret scan trips                          | 422 naming the field; body not stored; editor keeps the text                                                   | Constitution VII.                                                                         |
| `PERSONALITY.md` present but AW-07's `NOTES.md` is not | The editor renders six pills instead of seven                                                                  | The two files are independent; neither blocks the other.                                  |

---

## 10. Test plan

### 10.1 Unit — `packages/agent` (Jest)

| File                                                                             | Covers                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/src/agents/__tests__/agent-status-reason.spec.ts`                | Every branch of the precedence ladder in §2.3, in order; the `archived`-beats-everything rule; `working` beating `waitingOnYou`; `notStarted` only when never run.                                                                                                                               |
| `packages/agent/src/agents/__tests__/agent-level.spec.ts`                        | `defaultsFor` for all four levels against the FR-38 table, field by field; `diff` on a matching agent returns `[]`; `preview` sets `reducesAutonomy` only when at least one field loses a permission; `send_message` and `budget_override` never appear in any level's `autoApproveActionTypes`. |
| `packages/agent/src/agents/__tests__/agent-level-readiness.spec.ts`              | The exact thresholds (20 / 0 / 1 / 30 days); `null` at Lead; `null` one run short; the numbers are echoed back.                                                                                                                                                                                  |
| `packages/agent/src/agents/__tests__/run-admission-agent-brake.spec.ts`          | Paused agent parks with `agent-paused`; active agent passes; unbound port passes; a throwing port **parks**; the middleware sits before the Work valve so a paused agent never consumes a count.                                                                                                 |
| `packages/agent/src/agents/__tests__/agent-halt-classifier.spec.ts`              | 401/403 and the closed phrase list map to `credential`; everything else does not; a message containing a token-shaped string never reaches the halt detail.                                                                                                                                      |
| `packages/agent/src/agents/__tests__/agent-halt.service.spec.ts`                 | Halt writes reason/time/author/run; a second halt with the same reason increments `haltRepeatCount`; a different reason resets it; clear zeroes everything.                                                                                                                                      |
| `packages/agent/src/agents/__tests__/prompt-assembler.personality.spec.ts`       | The `personality` segment is emitted after `role` and before `capabilities`; capped at 600; a forged fence token is broken; an absent personality emits nothing (not an empty heading).                                                                                                          |
| `packages/agent/src/agents/__tests__/agent-file.personality.spec.ts`             | `PERSONALITY.md` reads and writes; an unknown name still throws; **a write with a hash computed before the name list changed still succeeds** (the ETag regression).                                                                                                                             |
| `packages/agent/src/database/repositories/agent-run.parked-for-agent.spec.ts`    | `findOldestQueuedForAgent` ordering, the reason predicate, cross-agent isolation.                                                                                                                                                                                                                |
| `packages/agent/src/agents/__tests__/agent-run-sweeper.paused-exemption.spec.ts` | A run parked `agent-paused` survives a sweep at both the SQL and the service layer.                                                                                                                                                                                                              |

### 10.2 Controller specs — `apps/api` (Jest)

| File                                                               | Covers                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/agents/agents.controller.identity.spec.ts`           | `GET :id/identity` shape and cross-user 404; the fallback when the composer throws; **route ordering** — `GET /status` and `GET /levels` resolve before `GET /:id`.                                                                                                                                                           |
| `apps/api/src/agents/agents.controller.level.spec.ts`              | Preview, apply, label-only, the 409 on a stale `baseHash` carrying a fresh preview, `PATCH :id` rejecting `level`, the activity write.                                                                                                                                                                                        |
| `apps/api/src/agents/agents.controller.pause.spec.ts`              | Empty body behaves as today; a 201-char note is rejected; a second pause is a no-op preserving note/time/author and writes no second activity row; `run-now` on a paused agent 409s and creates no run; `assign-task` on a paused agent returns `queued: true, queuedReason: 'agent-paused'`; resume reports `releasedCount`. |
| `apps/api/src/agents/agents.controller.status-batch.spec.ts`       | 100 ids succeed, 101 is a 400, another user's ids are filtered out rather than 404-ing the batch.                                                                                                                                                                                                                             |
| `apps/api/src/agents/sub-agent-delegation.runner.spec.ts` (extend) | Delegation to a paused child is refused with the named reason and creates no run.                                                                                                                                                                                                                                             |
| `apps/api/test/agents.e2e-spec.ts` (extend)                        | Pause → assign-task → resume, end to end against the real gate, asserting the run is parked and then dispatched.                                                                                                                                                                                                              |

### 10.3 End-to-end — `apps/web/e2e` (Playwright)

| File                                                   | Covers                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/e2e/agent-identity-card.spec.ts`             | All six card states render a dot **and** a sentence; archived is read-only; never-run offers Activate; no `undefined` anywhere in the card.                                                                                                |
| `apps/web/e2e/agent-pause-brake.spec.ts`               | Pause with a note → the card shows it → assign a task → the held panel shows one item → Run now is refused with the exact copy → Resume → the toast reports one released.                                                                  |
| `apps/web/e2e/agent-level.spec.ts`                     | Set Specialist with defaults → the preview lists four changes → confirm → the card shows Specialist with no drift; then clear a permission by hand → the drift line reads 1; then step down to Assistant → the heading and button relabel. |
| `apps/web/e2e/agent-personality.spec.ts`               | Write a personality → the save line says next run → the meter reads under budget → paste 9 KB → the size error → paste a key-shaped string → the secret refusal with the text preserved.                                                   |
| `apps/web/e2e/agent-lifecycle-status.spec.ts` (extend) | The existing lifecycle spec gains an assertion that the status chip is now accompanied by its reason.                                                                                                                                      |

Follow the repo's Playwright conventions; prefer role-based locators sparingly on this
surface — `*ByRole` is the recurring flake source in `apps/web` — and pin the status
region with a stable test id.

### 10.4 Component unit specs — `apps/web` (Vitest)

`AgentStatusDot.unit.spec.tsx`, `AgentIdentityCard.unit.spec.tsx`,
`AgentLevelDialog.unit.spec.tsx`, `AgentPauseDialog.unit.spec.tsx`,
`use-agent-status-polling.unit.spec.tsx` — as listed in §5.1–5.2.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green on its own.

### P1 — The brake and the stated reason

The safety half. Ships without levels and without personality.

- `1791230000000-AddAgentHaltReason.ts`.
- `AgentHaltReason` enum, halt columns, `AgentHaltService`, `AgentHaltClassifier`.
- `AgentStatusReasonResolver` + its unit spec.
- `agentId` on `RunAdmissionInput`; `run-agent-brake.ts`; `agentBrakeMiddleware` in
  position 2; `AgentBrakeService` bound in
  [`packages/agent/src/agents/agents.module.ts`](../../../../../packages/agent/src/agents/agents.module.ts).
- `assign-task` passes `agentId`; delegation and `run-now` refuse explicitly.
- Sweeper exemption in both places.
- `promoteParkedForAgent` + `findOldestQueuedForAgent`.
- Pause body, resume counts, `GET :id/identity` (level and personality fields present but
  always empty), `GET /status`, `GET :id/held`.
- `AgentStatusDot`, `AgentIdentityCard` (with the level and personality rows showing their
  empty states), `AgentPauseDialog`, `AgentHeldWorkPanel`,
  `use-agent-status-polling`.
- The `AgentIdleBehavior` union fix.
- i18n: `identity`, `status`, `pause`, `held`.
- Tests: §10.1 rows 1, 4–6, 9–10; §10.2 rows 1, 3–5; §10.3 rows 1–2.

**Ships:** an agent that says why it stopped, and a pause that is actually a stop.

### P2 — Levels

- `1791230100000-AddAgentLevel.ts`.
- `AgentLevel` enum, level columns, `AgentLevelService` (defaults, diff, preview,
  readiness).
- `GET /levels`, `GET :id/level`, `POST :id/level/preview`, `PUT :id/level`;
  `PATCH :id` rejects `level`.
- `AgentLevelBadge`, `AgentLevelDialog`, `AgentLevelDriftList`; the level row on the card
  lights up; the read-only row on Settings.
- i18n: `levels`.
- Tests: §10.1 rows 2–3; §10.2 row 2; §10.3 row 3.

**Ships:** a one-word answer to "how much rope does this one have", with the defaults to
back it.

### P3 — Personality and the finished card

- `1791230200000-AddAgentPersonality.ts`.
- `PERSONALITY.md` in the file name list, the read/write mapper and `hashOf`.
- `personality` in `PROMPT_SEGMENTS` with a 600 cap; `personalityHash` stamped at
  assembly.
- `countInFlightWithOtherPersonality` and the in-flight line.
- Seven-pill instructions editor; the permanent notice; the load meter and the
  skipped-region marker reused from AW-07; revision history and restore reused from AW-07.
- Export/import carries the level label and the personality body.
- i18n: `personality`, `tabs.notes`.
- Tests: §10.1 rows 7–8; §10.3 row 4.

**Ships:** an agent with a voice that changes safely, and the complete identity card.

---

## 12. Constitution compliance

| Principle                              | Status | Justification                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I — Plugin-first**                   | ✅     | No external service is contacted; no plugin package is added or bypassed.                                                                                                                                                                                          |
| **II — Capability-driven**             | ✅     | The halt detail stores a facade-resolved display name; no plugin id is branched on outside a plugin.                                                                                                                                                               |
| **III — Source-of-truth repositories** | ✅     | `PERSONALITY.md` follows the existing split exactly: database column for workspace-scope agents, the scope's git repo for scoped agents. No content is relocated.                                                                                                  |
| **IV — Job runtime**                   | ✅     | No new job. The resume drain reuses `drainForWork`, which enqueues through the existing `*_DISPATCHER` DI symbols. No call site imports a third-party SDK.                                                                                                         |
| **V — Forward-only migrations**        | ✅     | Three additive migrations, all nullable except one `int` with a default, all with guarded `down()`. No rename, no drop, no backfill.                                                                                                                               |
| **VI — Tests**                         | ✅     | 10 unit specs, 6 controller/e2e API specs, 5 Playwright specs, 5 component specs, named in §10.                                                                                                                                                                    |
| **VII — Secrets**                      | ✅     | `haltDetail` carries a display name and a coarse kind; the classifier never copies the error body into it. Personality and the pause note are secret-scanned on write with the same helper the five existing files use. No new log line prints agent file content. |
| **VIII — Plugin counts**               | ✅     | Not applicable.                                                                                                                                                                                                                                                    |
| **IX — Behaviour-first spec**          | ✅     | `spec.md` names no class, no file and no endpoint; every one of them lives here.                                                                                                                                                                                   |
| **X — Backwards compatibility**        | ✅     | No field renamed or removed. `pause`/`resume` keep their paths and verbs; the body is newly optional, the response is additive. `AgentDto` grows. The one new refusal (`PATCH :id` with `level`) is on a field that was never accepted.                            |

### 12.1 Program rules

| Rule                                           | Status | Justification                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additive only (#1)                             | ✅     | Ten tabs stay ten. Six statuses stay six. Five files become six (AW-07) then seven. Nothing is renamed.                                                                                                                                                                                                                     |
| No duplicate nouns (#2)                        | ✅     | Level is a field, halt reason is a field, status reason is derived, personality joins the existing file family, notes belongs to AW-07. Nothing new enters the program vocabulary table.                                                                                                                                    |
| Behaviour-first spec (#3)                      | ✅     | See IX.                                                                                                                                                                                                                                                                                                                     |
| Plugin-first for external (#4)                 | ✅     | Nothing external.                                                                                                                                                                                                                                                                                                           |
| Job runtime (#5)                               | ✅     | See IV.                                                                                                                                                                                                                                                                                                                     |
| Migrations in the same change (#6)             | ✅     | Each phase's migration is a task in the same phase as its entity edit.                                                                                                                                                                                                                                                      |
| Tests are a prerequisite (#7)                  | ✅     | See VI.                                                                                                                                                                                                                                                                                                                     |
| i18n (#8)                                      | ✅     | §8; every leaf camelCase, no literal dot.                                                                                                                                                                                                                                                                                   |
| Every surface answers "what did it cost?" (#9) | ✅     | This epic spends nothing new — no model call, no sweep, no job. The only spend it touches is the `canSpend` default, shown in the preview before it is written. The voice preview is deliberately routed through chat so it inherits chat's existing cost accounting and receipt rather than inventing a second spend path. |

---

## 13. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [README](../README.md) · [Existing substrate](../EXISTING-SUBSTRATE.md) · [Tracker](../TRACKER.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Depends on: [AW-07 plan](../AW-07-memory-context/plan.md)
- Related plans: [AW-09](../AW-09-runs-receipts/plan.md) · [AW-15](../AW-15-connections-scopes/plan.md)
- Architecture of record: [`docs/specs/architecture/agent-prompt-assembly.md`](../../../architecture/agent-prompt-assembly.md) ·
  [`docs/architecture/agent-injection-tokens.md`](../../../../architecture/agent-injection-tokens.md) ·
  [`docs/specs/architecture/agents-skills-tasks.md`](../../../architecture/agents-skills-tasks.md)
