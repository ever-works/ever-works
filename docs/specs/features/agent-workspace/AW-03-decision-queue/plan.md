# AW-03 — My Decisions · Implementation plan

> Translates [`spec.md`](./spec.md) into architecture, schema, endpoints and
> phasing. The plan owns implementation detail; the spec owns behaviour.

**Feature ID**: `aw-03-decision-queue`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## 1. Current state in the codebase

Every path below was opened before being cited.

### 1.1 The two backing records

| Concern | File | What is there today |
| --- | --- | --- |
| Escalation entity | [`packages/agent/src/entities/agent-escalation.entity.ts`](../../../../../packages/agent/src/entities/agent-escalation.entity.ts) | `@Entity('agent_escalations')`. `userId`, `reasonCode` `varchar(32)`, `status` `varchar(16)` default `'open'`, `runId`, `taskId`, `workId`, `agentId`, `summary` `varchar(500)`, `decisionNeeded` `text`, `attempted` `simple-json`, `confidence` `float` nullable, `confidenceSource`, `resolvedByUserId`, `resolutionNote`, `resolvedAt`, unique `dedupKey` `varchar(200)`, Tier-C `tenantId`/`organizationId`, `createdAt`. Indexes `idx_agent_escalation_task_status`, `idx_agent_escalation_work_status`, `idx_agent_escalation_user_status`. **No `missionId`, no archive marker, no first-viewed timestamp, no child questions.** |
| Escalation service | [`packages/agent/src/agents/agent-escalation.service.ts`](../../../../../packages/agent/src/agents/agent-escalation.service.ts) | `record()` (idempotent on `dedupKey`, scores confidence, mirrors to the Inbox), `listForTask`, `listOpenForUser`, `listForUser`, `getForUser`, `countOpenForWork`, `resolve`, `resolveForTask`. `INBOX_PRODUCER` and `EscalationConfidenceService` are both `@Optional()` and appended last — the positional-arity rule this package follows. |
| Escalation repository | [`packages/agent/src/database/repositories/agent-escalation.repository.ts`](../../../../../packages/agent/src/database/repositories/agent-escalation.repository.ts) | Owner-scoped reads, CAS resolve. Scope coverage is guarded by [`agent-escalation.repository.scope.spec.ts`](../../../../../packages/agent/src/database/repositories/agent-escalation.repository.scope.spec.ts). |
| Escalation contracts | [`packages/contracts/src/agents/escalation.types.ts`](../../../../../packages/contracts/src/agents/escalation.types.ts) | `AgentEscalationReasonCode` (10 members), `AgentEscalationStatus = 'open' \| 'resolved'`, `AGENT_ESCALATION_STATUSES`, caps (`MAX_SUMMARY_CHARS = 500`, `MAX_DECISION_CHARS = 1000`, `MAX_ATTEMPT_ENTRIES = 20`), `clampEscalationConfidence`, `AgentEscalationAttempt`, `AgentEscalationDto`. |
| Escalation HTTP | [`apps/api/src/escalations/escalations.controller.ts`](../../../../../apps/api/src/escalations/escalations.controller.ts) + [`dto/escalations.dto.ts`](../../../../../apps/api/src/escalations/dto/escalations.dto.ts) + [`escalations.module.ts`](../../../../../apps/api/src/escalations/escalations.module.ts) | `GET /api/escalations`, `GET /api/escalations/:id`, `POST /api/escalations/:id/resolve`. Owner-scoped, 404-never-403. **No colocated controller spec exists.** |
| Escalation chat tools | [`packages/agent/src/agents/agent-escalation-tools.ts`](../../../../../packages/agent/src/agents/agent-escalation-tools.ts) | `list_escalations` / `resolve_escalation` descriptors, reached through [`agent-domain-tool-sources.ts`](../../../../../packages/agent/src/agents/agent-domain-tool-sources.ts). |
| Approval entity | [`packages/agent/src/entities/agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts) | `@Entity('agent_action_proposals')`. `userId`, `agentId`, `runId`, `actionType` (5 members), `title` `varchar(200)`, `payload` `simple-json`, `riskFlags` `simple-json`, `status` `varchar(16)` default `'pending'`, `decidedById`, `decidedAt`, `decidedVia`, Tier-A scope, `createdAt`/`updatedAt`. Indexes on `(organizationId,status)`, `(agentId)`, `(userId,status)`. Its own docstring: *"Actually executing / resuming the approved action is a follow-up increment — this entity is the durable queue + decision record only."* |
| Approval service | [`packages/agent/src/agent-approvals/agent-approvals.service.ts`](../../../../../packages/agent/src/agent-approvals/agent-approvals.service.ts) | `createProposal`, `listPending`, `list`, `getOne`, `decide` (flips `status`/`decidedById`/`decidedAt`/`decidedVia` and nothing else), `approveAll`, `requireOwned`. |
| Approval DTO | [`packages/agent/src/agent-approvals/types.ts`](../../../../../packages/agent/src/agent-approvals/types.ts) | `AgentActionProposalDto` + `toAgentActionProposalDto` — the single place a proposal field reaches the wire. |
| Approval risk scorer | [`packages/agent/src/agent-approvals/risk-scorer.ts`](../../../../../packages/agent/src/agent-approvals/risk-scorer.ts) | Pure `RISK_SCORER`. |
| Approval HTTP | [`apps/api/src/agent-approvals/agent-approvals.controller.ts`](../../../../../apps/api/src/agent-approvals/agent-approvals.controller.ts) + [`dto/agent-approval.dto.ts`](../../../../../apps/api/src/agent-approvals/dto/agent-approval.dto.ts) | list / get / approve / reject / approve-all. **No colocated controller spec exists.** |

### 1.2 The typed-question shapes that already ship

[`packages/contracts/src/hitl/hitl-question.types.ts`](../../../../../packages/contracts/src/hitl/hitl-question.types.ts)
is a zero-dependency value-type module exporting a discriminated union of five
question kinds (`confirm`, `choice`, `multi_choice`, `text`, `approval`) with
matching answer shapes, plus `parseHitlQuestion`, `serializeHitlQuestion`,
`parseHitlAnswer`, `serializeHitlAnswer`, `validateHitlAnswer`,
`describeHitlQuestion` and the caps `HITL_MAX_PROMPT_CHARS = 1000`,
`HITL_MAX_CONTEXT_CHARS = 4000`, `HITL_MAX_OPTIONS = 25`,
`HITL_MAX_OPTION_LABEL_CHARS = 200`, `HITL_MAX_TEXT_ANSWER_CHARS = 4000`,
`HITL_MAX_NOTE_CHARS = 1000`. Its own header says G3 shipped the escalation record
and that *"a free-text question cannot be rendered as a control, cannot be
validated, and cannot be answered machine-readably. This file adds the typed
half."*

It is exported from [`packages/contracts/src/index.ts`](../../../../../packages/contracts/src/index.ts)
and today has exactly one consumer: the AI chat canvas
([`apps/web/src/components/ai/canvas/types.ts`](../../../../../apps/web/src/components/ai/canvas/types.ts),
[`components.tsx`](../../../../../apps/web/src/components/ai/canvas/components.tsx),
[`apps/web/src/lib/ai/tools/canvas.tools.ts`](../../../../../apps/web/src/lib/ai/tools/canvas.tools.ts)).
**Nothing persists a typed question anywhere.** This epic is what gives that union
storage, a queue and an answer path.

### 1.3 The park / restart seam that already exists

| Concern | File | What is there |
| --- | --- | --- |
| Run entity | [`packages/agent/src/entities/agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts) | `awaitingInput` (agent-raised park flag, exempt from sweeper reaping), `pendingInput: string[] \| null` (FIFO injection queue), `cliSessionId` (the pipeline plugin's own conversation id, survives park/restart), `attentionReason`, `queuedReason`, `interruptRequested`, `terminalEndedReason`. |
| Steering service | [`packages/agent/src/agents/run-steering.service.ts`](../../../../../packages/agent/src/agents/run-steering.service.ts) | `steer()` — injects into a live run (`queued`/`running`) and clears `awaitingInput`; `interrupt()`; `resume(runId, userId, message?, ownershipScope?)` — creates a **new** run carrying `cliSessionId`, seeds `pendingInput`, goes through `RunDispatchGateService`, dispatches via `AGENT_TASK_EXECUTE_DISPATCHER`, replays durable reviewer rejections, and returns `{ dispatched: 'new-run', runId, resumedFromRunId, carriedCliSession, queued, rejectionsReplayed }`. `isLive()` and `isResumable()` are static predicates. Throws `ConflictException` when the run is not resumable or has no `taskId`. |
| Steering port | [`packages/agent/src/tasks-domain/run-steering-port.ts`](../../../../../packages/agent/src/tasks-domain/run-steering-port.ts) | `RUN_STEERING_PORT` DI token — the leaf interface other modules depend on. |
| Dispatch tokens | [`packages/agent/src/tasks-domain/task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts) | `AGENT_TASK_EXECUTE_DISPATCHER`, `AGENT_CHAT_REPLY_DISPATCHER` — the only sanctioned way to start background work from the agent package (Constitution IV). |
| Admission gate | [`packages/agent/src/agents/run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts) | Per-Work / per-org concurrency valve; the row that consumes the slot is created inside the critical section. |
| Task unblock | [`packages/agent/src/tasks-domain/task-transition.service.ts`](../../../../../packages/agent/src/tasks-domain/task-transition.service.ts) | `transition()` stashes `previousStatus` on any → `blocked` and clears it on `blocked` → *. `listOpenBlockerIds()`, `recheckUnblockFor()`, `tryUnblockSingleTask()` (restores `previousStatus`, defaulting to `todo`), `autoUnblockResolvedTasks()`. |
| Task entity | [`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts) | `status` incl. `blocked`, `previousStatus`, `missionId` (nullable, no `@ManyToOne` by design), `latestRunId`/`latestRunStatus`. |

### 1.4 The one place resolution → restart is already implemented

[`packages/agent/src/inbox/inbox.service.ts`](../../../../../packages/agent/src/inbox/inbox.service.ts)
is the operator message center. Its `reply()` claims the row with a CAS
(`markAnswered`), routes by `kind`, and releases the claim if routing throws:

- `question` → `routeQuestionReply` (steer a live run, resume a parked one)
- `approval` → `routeApprovalReply` → `AgentApprovalsService.decide`
- `escalation` → `routeEscalationReply` → `AgentEscalationService.resolve`, then
  `tryResumeLinkedRun` → `RunSteeringService.resume`
- `notice` → nothing

`tryResumeLinkedRun` is best-effort by contract: *"the escalation IS resolved; a
resume hiccup must not undo that answer."*

**This is the behaviour the queue needs, at the wrong granularity** — it fires on a
single message reply, has no concept of "every required question answered", and is
locked inside the Inbox module. §2.2 extracts it.

Supporting files: [`inbox-producer.port.ts`](../../../../../packages/agent/src/inbox/inbox-producer.port.ts)
(`INBOX_PRODUCER`, `escalationRaised`, `proposalPending`, `notice`,
`questionRaised`), [`inbox.types.ts`](../../../../../packages/agent/src/inbox/inbox.types.ts),
[`packages/agent/src/entities/inbox-item.entity.ts`](../../../../../packages/agent/src/entities/inbox-item.entity.ts)
(`kind: question | approval | escalation | notice`, `escalationId`, `agentRunId`),
[`packages/agent/src/database/repositories/inbox-item.repository.ts`](../../../../../packages/agent/src/database/repositories/inbox-item.repository.ts),
[`apps/api/src/inbox/inbox.controller.ts`](../../../../../apps/api/src/inbox/inbox.controller.ts).

### 1.5 Web — what exists and what does not

| File | Today |
| --- | --- |
| [`apps/web/src/components/approvals/ApprovalsQueue.tsx`](../../../../../apps/web/src/components/approvals/ApprovalsQueue.tsx) | The only decision-shaped UI in the product. Client component, per-row submitting state, risk-flag badges, approve / reject / approve-all. Rendered by [`(dashboard)/(home)/dashboard-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx>) line 164, fed by [`(home)/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx>) line 123. |
| [`apps/web/src/lib/api/agent-approvals.ts`](../../../../../apps/web/src/lib/api/agent-approvals.ts) | `server-only` typed client over `/agent-approvals`, using `serverFetch`/`serverMutation` from [`server-api.ts`](../../../../../apps/web/src/lib/api/server-api.ts). |
| [`apps/web/src/app/actions/dashboard/agent-approvals.ts`](../../../../../apps/web/src/app/actions/dashboard/agent-approvals.ts) | Server actions with a `requireApprovalAuth()` defence-in-depth guard and `revalidatePath('/[locale]/(dashboard)/(home)', 'page')`. |
| `apps/web/src/lib/api/escalations.ts` | **Does not exist.** No web file reads escalations at all. |
| [`apps/web/src/components/inbox/InboxClient.tsx`](../../../../../apps/web/src/components/inbox/InboxClient.tsx) | The Inbox surface, with an `escalation` item kind and a reply composer. |
| [`apps/web/src/components/dashboard/AttentionSection.tsx`](../../../../../apps/web/src/components/dashboard/AttentionSection.tsx) | The Home "Needs attention" card list (`dashboard.attention` namespace, includes a `taskBlocked` kind). |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) | `ROUTES` at line 107; `DASHBOARD_INBOX = '/inbox'` at line 115, `DASHBOARD_MISSIONS` at 125. |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) | Hard-coded nav array; keys resolve from `dashboard.sidebar.navigation.*`. |
| [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) | `dashboard.approvals` (header / actions / actionType / riskFlags / toast), `dashboard.inbox`, `dashboard.attention`. **21 locale files** live in [`apps/web/messages/`](../../../../../apps/web/messages/) and must stay structurally identical. |

### 1.6 Cross-cutting infrastructure

| Concern | File | Note |
| --- | --- | --- |
| Migrations | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/) (175 files) | **Not** `packages/agent/src/migrations/` — that directory does not exist. [`apps/api/typeorm.config.ts`](../../../../../apps/api/typeorm.config.ts) globs `src/migrations/**`; the API self-applies on boot. The Constitution §V text says `apps/api/src/database/migrations/`; the code says `apps/api/src/migrations/`. Follow the code; the doc drift is logged in §13. |
| Entity registration | [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts), [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts), [`packages/agent/src/database/_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts) | A new entity must be added to **all three**, and the drift is asserted by [`database.module.spec.ts`](../../../../../packages/agent/src/database/database.module.spec.ts) and [`database.config.spec.ts`](../../../../../packages/agent/src/database/database.config.spec.ts). |
| Sub-module export | [`packages/agent/package.json`](../../../../../packages/agent/package.json) | 54 `exports` entries; a new `./decisions` entry is required for `apps/api` to import it. |
| Ownership | [`packages/agent/src/database/ownership-scope.ts`](../../../../../packages/agent/src/database/ownership-scope.ts) | `OwnershipScope`, `ownershipWhere<T>()` — the canonical user + Organization filter. |
| Activity log | [`packages/agent/src/activity-log/activity-log.service.ts`](../../../../../packages/agent/src/activity-log/activity-log.service.ts), [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) | `actionType` is `varchar(50)` on [`activity-log.entity.ts`](../../../../../packages/agent/src/entities/activity-log.entity.ts) line 43, so **appending enum members needs no migration**. |
| Notifications | [`packages/agent/src/notifications/notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts), [`packages/agent/src/entities/notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts) | `NotificationCategory` has `AGENT` and `TASK`; this epic adds no category and no default. |
| Job runtime | [`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/) (44 tasks) + [`index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) | Shape to copy: [`agent-run-sweeper.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-run-sweeper.task.ts) and [`digest-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/digest-dispatcher.task.ts) — `schedules.task({ id, cron, run })` spinning a `NestApplicationContext(TriggerInternalModule)`. |
| Preferences | [`packages/agent/src/entities/work-agent-preference.entity.ts`](../../../../../packages/agent/src/entities/work-agent-preference.entity.ts) | Already holds `missionDefaultOutstandingCap` — the natural home for the health-band overrides. |
| Tool grants | [`apps/api/src/tool-grants/tool-grants.controller.ts`](../../../../../apps/api/src/tool-grants/tool-grants.controller.ts) | `GET /api/tool-grants/check?toolName=&workId=&agentId=` returns a single decision — the verification an access ask uses. |
| API module graph | [`apps/api/src/api.module.ts`](../../../../../apps/api/src/api.module.ts) | `AgentApprovalsModule` imported at line 53 / listed at 195; the new `DecisionsModule` slots in beside it. |
| Web BFF scope | [`apps/web/src/lib/api/bff-scope.ts`](../../../../../apps/web/src/lib/api/bff-scope.ts) | Selector forwarding for scoped reads. Any new web client must forward scope the same way the existing ones do, or scoped reads 400. |

---

## 2. Architecture and the seam

### 2.1 One read model over two tables, one new child table

```
                       ┌──────────────────────────────────────────┐
                       │        GET /api/decisions                │
                       └──────────────────┬───────────────────────┘
                                          │
                         DecisionQueueService.list(userId, filter, scope)
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
 agent_escalations                agent_action_proposals              decision_asks
 status='open'                    status='pending'                    GROUP BY
 ownershipWhere                   ownershipWhere                      (decisionType,
 archivedAt IS NULL               archivedAt IS NULL                   decisionId)
        │                                 │                                 │
        └───────────────┬─────────────────┘                                 │
                        ▼                                                   │
              normalise to DecisionDto  ◄───────────────────────────────────┘
              id = `escalation:<uuid>` | `approval:<uuid>`
                        │
                        ▼
        ┌──────────────────────────────────────────┐
        │  blocking?  ← agent_runs.awaitingInput    │  one grouped query
        │             ← tasks.status = 'blocked'    │  per signal
        └──────────────────────────────────────────┘
                        │
                        ▼
              rank(blocking desc, confidence desc [null→0.5], createdAt asc)
```

Four queries per page, none of them N+1. The synthetic composite id follows the
precedent already set by the unified schedules read model
([`packages/agent/src/schedules/schedule-view.types.ts`](../../../../../packages/agent/src/schedules/schedule-view.types.ts),
whose `id` is `${sourceType}:${ownerId}` and is documented as *"synthetic, never a
DB PK"*).

**Why no `decisions` table.** Both backing records are load-bearing today, have
their own writers, their own idempotency keys and their own notification mirrors.
A third table would be a third writer to keep in sync, a third dedupe key, and a
migration of live data. The queue needs a *view*, and it gets one.

### 2.2 The resolution seam — extracted, not forked

The chain "close the record → compose the answer → deliver it to the agent →
unblock the Task" exists exactly once today, inside
[`InboxService.reply()`](../../../../../packages/agent/src/inbox/inbox.service.ts).
This plan **extracts** it into a new leaf service and makes the Inbox a caller, so
the two surfaces cannot drift:

```
  BEFORE                                AFTER

  InboxService.reply()                  InboxService.reply()
    ├ routeEscalationReply                ├ (unchanged claim + CAS)
    │   └ escalations.resolve             └ DecisionResolutionService.resolve(...)
    └ tryResumeLinkedRun                       │
        └ steering.resume                      │
                                               ▼
                                   DecisionResolutionService
                                     1. close the backing record
                                        (AgentEscalationService.resolve
                                         | AgentApprovalsService.decide)
                                     2. mark remaining open asks `superseded`
                                     3. compose the answer message
                                     4. deliver:
                                          live run     → RunSteeringService.steer
                                          parked run   → RunSteeringService.resume
                                          neither      → record 'none'
                                     5. TaskTransitionService.recheckUnblockFor
                                     6. activity log + analytics
                                     returns DecisionResolutionOutcome
```

`DecisionResolutionService` lives in the new `packages/agent/src/decisions/`
module. It depends on `RunSteeringService`, `TaskTransitionService`,
`AgentEscalationService`, `AgentApprovalsService` and `DecisionAskRepository` — all
`@Optional()` except the ask repository, following the positional-arity convention
this package already documents, so unit tests and the worker RPC context construct
it with one argument and degrade honestly.

**Import direction.** `inbox` already imports `agents` and `agent-approvals`
(see its constructor). `decisions` imports `agents`, `agent-approvals` and
`tasks-domain`; `inbox` imports `decisions`. Nothing imports `inbox`. No cycle.

### 2.3 The ask, and why it rides the existing typed-question union

`DecisionAsk.question` stores a serialized `HitlQuestion`
(`serializeHitlQuestion` / `parseHitlQuestion`), and `DecisionAsk.answer` stores a
serialized `HitlAnswer`, validated by `validateHitlAnswer`. The five *user-facing*
ask kinds map onto question kinds like this, and the mapping is enforced by a pure
function so an ill-formed pair is rejected at write time:

| `DecisionAsk.kind` | Permitted `HitlQuestion.kind` | Reason required when |
| --- | --- | --- |
| `decision` | `choice`, `multi_choice` | the chosen option is not `defaultOptionId` |
| `approval` | `approval`, `confirm` | `decision === 'rejected'` / `confirmed === false` |
| `fact` | `text` | never |
| `access` | `access` *(new union member)* | never |
| `action` | `action` *(new union member)* | never |

Two new members are appended to `HitlQuestionKind` in
[`packages/contracts/src/hitl/hitl-question.types.ts`](../../../../../packages/contracts/src/hitl/hitl-question.types.ts):

- `HitlAccessQuestion` — `{ kind: 'access', capability: string, toolPattern?: string,
  connectionHint?: string, grantUrl?: string }`, answered by
  `HitlAccessAnswer { kind: 'access', granted: true, verified: boolean }`.
  **`capability` and `toolPattern` are capability/tool names, never plugin ids**
  (Constitution II), and nothing here ever carries a credential value
  (Constitution VII).
- `HitlActionQuestion` — `{ kind: 'action', action: string, evidenceHint?: string }`,
  answered by `HitlActionAnswer { kind: 'action', done: true, note?: string }`.

Both get parser branches, `validateHitlAnswer` cases, `describeHitlQuestion`
cases and unit coverage in the existing
[`packages/contracts/src/__tests__/`](../../../../../packages/contracts/src/__tests__/)
suite. This is an additive union widening (Constitution X): every existing
consumer switches on the members it knows and the canvas renderer already parses
defensively, returning `null` on an unknown kind.

### 2.4 Ask materialisation — the queue is complete on day one

Asks are written by the same code path that writes the backing record, so a
decision never exists without at least one ask:

- `AgentEscalationService.record()` gains an optional `asks?: DecisionAskInput[]`.
  When absent (every caller today), one derived ask is written:
  `kind: 'decision'`, `question: { kind: 'text', prompt: <decisionNeeded, capped
  1000>, context: <summary> }`. Reason codes with a better natural shape get a
  better derived ask: `budget-stop` and `guardrail-refusal` and `merge-refused`
  derive `kind: 'approval'` with `question.kind = 'approval'`.
- `AgentApprovalsService.createProposal()` writes one derived ask:
  `kind: 'approval'`, `question: { kind: 'approval', prompt: title, action: title,
  risks: riskFlags }`.
- A backfill inside the P1 migration writes one derived ask for every currently
  open escalation and pending proposal, in batches of 500.

So P1 ships a fully populated queue with zero agent-side change. P2 lets an agent
supply its own typed asks.

### 2.5 What this epic does not touch

- The approve / reject / approve-all endpoints and their DTOs — byte for byte.
- The escalation list / get / resolve endpoints and their DTOs — byte for byte.
- The Home approval block and its server actions.
- The Inbox controller, its DTOs and its item kinds.
- `RunSteeringService`, `TaskTransitionService`, `RunDispatchGateService` — used,
  never modified, except for a widened `steer` call site.
- Any notification default.

---

## 3. Data model

### 3.1 P1 — new table `decision_asks`

Entity file: `packages/agent/src/entities/decision-ask.entity.ts`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | `@PrimaryGeneratedColumn('uuid')` |
| `userId` | `uuid` | Owner. Every read is owner-scoped |
| `decisionType` | `varchar(16)` | `'escalation' \| 'approval'` |
| `decisionId` | `uuid` | The backing row's id. Raw column, **no** `@ManyToOne` — polymorphic, and the entities-cycle rule this package documents |
| `position` | `int` default `0` | Render order, 0-based |
| `kind` | `varchar(16)` | `'decision' \| 'approval' \| 'fact' \| 'access' \| 'action'` |
| `question` | `simple-json` | A serialized `HitlQuestion` |
| `required` | `boolean` default `true` | Only required asks gate resolution (FR-21) |
| `status` | `varchar(16)` default `'open'` | `'open' \| 'answered' \| 'withdrawn' \| 'superseded'` |
| `answer` | `simple-json` nullable | A serialized `HitlAnswer` |
| `rationale` | `text` nullable | The "why", ≤ 1000 chars, enforced at the service layer |
| `answeredByUserId` | `uuid` nullable | |
| `answeredAt` | `PortableDateColumn` nullable | |
| `withdrawnByUserId` | `uuid` nullable | |
| `withdrawnAt` | `PortableDateColumn` nullable | |
| `withdrawalNote` | `text` nullable | What was posted to the agent |
| `resumedRunId` | `uuid` nullable | The run this answer started, for the undo guard |
| `dedupKey` | `varchar(200)` nullable, **unique** | `${decisionType}:${decisionId}:${questionId}` — the writers are retry-prone |
| `tenantId` | `uuid` nullable | Tier A/C, stamped by `ScopeStampingSubscriber` |
| `organizationId` | `uuid` nullable | idem |
| `createdAt` / `updatedAt` | `PortableDateColumn` | |

Indexes:

- `idx_decision_asks_decision` on `(decisionType, decisionId, position)` — the
  detail read.
- `idx_decision_asks_user_status` on `(userId, status)` — the grouped counts the
  queue read needs.
- `uq_decision_asks_dedup` unique on `(dedupKey)`.

### 3.2 P1 — additive columns on `agent_escalations`

| Column | Type | Written by |
| --- | --- | --- |
| `missionId` | `uuid` nullable | `AgentEscalationService.record()`, derived from `tasks.missionId`; backfilled by the migration |
| `archivedAt` | `PortableDateColumn` nullable | Archive / bulk archive / orphan sweep |
| `archivedByUserId` | `uuid` nullable | NULL when the sweeper archived it |
| `archivedReason` | `varchar(32)` nullable | `'user' \| 'bulk' \| 'source-gone'` |
| `firstViewedAt` | `PortableDateColumn` nullable | First detail read by a human (FR-14) |

New index `idx_agent_escalation_mission_status` on `(missionId, status)`.

`AgentEscalationStatus` gains `'archived'` in
[`packages/contracts/src/agents/escalation.types.ts`](../../../../../packages/contracts/src/agents/escalation.types.ts)
and in `AGENT_ESCALATION_STATUSES`. The column is already `varchar(16)`, so this
needs **no** migration for width. Every existing read filters `status='open'` or
`status='resolved'` explicitly, so archived rows simply drop out.

### 3.3 P1 — additive columns on `agent_action_proposals`

The same five columns (`missionId`, `archivedAt`, `archivedByUserId`,
`archivedReason`, `firstViewedAt`) plus index
`idx_agent_action_proposals_mission_status` on `(missionId, status)`.
`AgentActionProposalStatus` gains `'archived'` in
[`agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts)
and in `AGENT_ACTION_PROPOSAL_STATUSES`; the column is `varchar(16)` already.

`missionId` is derived from `runId → agent_runs.taskId → tasks.missionId` at
creation, and backfilled the same way.

### 3.4 P3 — health-band overrides and the daily roll-up

Two nullable columns on `work_agent_preferences`
([`work-agent-preference.entity.ts`](../../../../../packages/agent/src/entities/work-agent-preference.entity.ts)),
beside the existing `missionDefaultOutstandingCap`:

| Column | Type | Meaning |
| --- | --- | --- |
| `decisionHealthyMaxPerDay` | `int` nullable | NULL = inherit the platform default of **5**; clamped 1–100 at the service layer |
| `decisionQuietWindowDays` | `int` nullable | NULL = inherit the platform default of **14**; clamped 3–90 |

One new table `decision_health_snapshots`
(`packages/agent/src/entities/decision-health-snapshot.entity.ts`), one row per
user per day, written by the daily tick:

| Column | Type |
| --- | --- |
| `id` | `uuid` PK |
| `userId` | `uuid` |
| `day` | `varchar(10)` (`YYYY-MM-DD`, UTC) |
| `openedCount` | `int` |
| `resolvedCount` | `int` |
| `archivedCount` | `int` |
| `openAtSnapshot` | `int` |
| `medianPerDay7` | `float` |
| `band` | `varchar(16)` — `'quiet' \| 'healthy' \| 'heavy' \| 'flooded'` |
| `topAgentId` | `uuid` nullable |
| `topAgentCount` | `int` default `0` |
| `tenantId` / `organizationId` | `uuid` nullable |
| `createdAt` | `PortableDateColumn` |

Unique index `uq_decision_health_day` on `(userId, day)` — the tick is idempotent
per day. Index `idx_decision_health_user_day` on `(userId, day)` for the trailing
read.

### 3.5 Migrations (Constitution V, forward-only)

Authored from `apps/api/`, landing in
[`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/):

1. **`<ts>-CreateDecisionAsks.ts`** (P1) — `CREATE TABLE decision_asks` + its three
   indexes; `ALTER TABLE agent_escalations` ADD 5 columns + 1 index;
   `ALTER TABLE agent_action_proposals` ADD 5 columns + 1 index; then two
   `UPDATE … FROM tasks` backfills for `missionId`, and a batched insert of one
   derived ask per currently-open escalation and pending proposal.
   `down` drops only what `up` created.
2. **`<ts>-CreateDecisionHealthSnapshots.ts`** (P3) — `CREATE TABLE
   decision_health_snapshots` + 2 indexes; `ALTER TABLE work_agent_preferences`
   ADD 2 nullable int columns.

Hand-review rules for both: no `DROP`, no `ALTER … TYPE`, no `NOT NULL` without a
default, and the ask backfill must be chunked (500 rows) so a large workspace does
not lock the table for the whole insert.

`ScopeStampingSubscriber` stamps `tenantId`/`organizationId` on insert for both new
entities, exactly as it does for `AgentActionProposal` today.

### 3.6 Changes needing no migration

- New `ActivityActionType` members — `actionType` is `varchar(50)`.
- New `HitlQuestionKind` members — a value type, not a column type.
- `'archived'` on both status unions — both columns are already `varchar(16)`.

---

## 4. API surface

New module `apps/api/src/decisions/` — `decisions.controller.ts`,
`decisions.module.ts`, `dto/decisions.dto.ts`, `decisions.controller.spec.ts`.
Registered in [`apps/api/src/api.module.ts`](../../../../../apps/api/src/api.module.ts)
beside `AgentApprovalsModule`.

All routes are `@ApiTags('decisions')`, `@Controller('api/decisions')`, guarded by
the standard session guard, owner-scoped through `@CurrentUser()` plus the optional
`ScopeContextService` from [`apps/api/src/scope/`](../../../../../apps/api/src/scope/),
and **404-never-403** in line with every sibling controller in this area.

### 4.1 P1

| Method | Path | Body / query | Returns | Throttle |
| --- | --- | --- | --- | --- |
| `GET` | `/api/decisions` | `status` (`open`\|`answered`\|`archived`\|`all`, default `open`), `agentId`, `missionId`, `kind`, `q`, `limit` (1–100, default 25), `offset` | `{ data: DecisionDto[], meta: { total, limit, offset, openCount, blockingCount } }` | 60/min |
| `GET` | `/api/decisions/:decisionId` | `decisionId` = `escalation:<uuid>` \| `approval:<uuid>`, validated by a dedicated pipe | `DecisionDto` (stamps `firstViewedAt` on the first human read) | 60/min |
| `POST` | `/api/decisions/:decisionId/asks/:askId/answer` | `{ answer: HitlAnswer, rationale?: string }` | `{ decision: DecisionDto, resolution: DecisionResolutionOutcome \| null }` | 30/min |

`DecisionDto` (declared in `packages/agent/src/decisions/types.ts`, mirrored
manually in the web client exactly as `agent-approvals.ts` mirrors its DTO today):

```
{
  id: string                     // `escalation:<uuid>` | `approval:<uuid>`
  source: 'escalation' | 'approval'
  sourceId: string
  status: 'open' | 'resolved' | 'archived'
  title: string                  // escalation.summary | proposal.title
  context: string | null         // escalation.decisionNeeded
  attempted: { label, outcome, detail? }[]   // escalations only
  reasonCode: string | null      // escalations only
  actionType: string | null      // approvals only
  riskFlags: string[]            // approvals only
  confidence: number | null
  confidenceSource: 'ai-judge' | 'heuristic' | null
  agentId: string | null
  runId: string | null
  taskId: string | null
  workId: string | null
  missionId: string | null
  blocking: boolean
  blockingReason: 'run-parked' | 'task-blocked' | null
  dormant: boolean
  asks: DecisionAskDto[]
  requiredCount: number
  answeredCount: number
  repeatCount: number | null     // P3
  firstViewedAt: string | null
  createdAt: string
  resolvedAt: string | null
  resolvedByUserId: string | null
  archivedAt: string | null
  archivedReason: string | null
}
```

`DecisionResolutionOutcome`:

```
{
  closed: true
  delivery: 'injected' | 'resumed' | 'none' | 'failed'
  runId: string | null           // the live or newly created run
  queued: boolean                // the restart was admitted but parked
  taskUnblocked: boolean
  remainingBlockers: number
  reason: string | null          // machine token when delivery is 'none' | 'failed'
}
```

### 4.2 P2

| Method | Path | Body | Returns | Throttle |
| --- | --- | --- | --- | --- |
| `POST` | `/api/decisions/:decisionId/asks/:askId/undo` | `{ note?: string }` | `{ decision: DecisionDto, withdrawal: { posted: 'injected' \| 'recorded', runCancelled: boolean } }` | 30/min |
| `POST` | `/api/decisions/:decisionId/archive` | — | `DecisionDto` | 30/min |
| `POST` | `/api/decisions/:decisionId/restore` | — | `DecisionDto` | 30/min |
| `POST` | `/api/decisions/archive-all` | `{ ids?: string[], agentId?, missionId?, kind? }` | `{ archived: number, skipped: number }` | **5/min** |

`archive-all` caps at `DECISION_ARCHIVE_ALL_MAX = 200` per invocation, ordered
oldest-first, and skips rows that are no longer open (mirroring
`AgentApprovalsService.approveAll`'s existing skip-and-report semantics).

**There is deliberately no public `POST /api/decisions`.** Agents file decisions
through the agent-side service and the chat tool (§7), not over HTTP, so an
untrusted caller cannot manufacture a decision addressed to a human.

### 4.3 P3

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/decisions/health` | `{ band, medianPerDay7, openNow, quietDays, healthyMaxPerDay, topAgent: { id, name, count } \| null, computedAt }`; `204 No Content` when no snapshot exists yet |
| `PATCH` | `/api/decisions/health/band` | `{ healthyMaxPerDay?: 1..100, quietWindowDays?: 3..90 }` → the updated settings |

### 4.4 Endpoints reused unchanged

`POST /api/agent-approvals/:id/approve` · `/reject` · `/approve-all`,
`POST /api/escalations/:id/resolve`, `POST /api/tasks/:id/escalations/:eid/resolve`,
`POST /api/inbox/:id/reply`, `GET /api/tool-grants/check`,
`POST /api/agents/:id/runs/:runId/resume`. The first four route their resolution
through `DecisionResolutionService` after this change; their request and response
shapes do not move.

---

## 5. Web surface

### 5.1 Route and shell

- `apps/web/src/app/[locale]/(dashboard)/decisions/page.tsx` — RSC entry. Reads
  `?tab`, `?id`, `?agentId`, `?missionId`, `?kind`, `?q`, `?offset`; fetches the
  first page plus the health snapshot with `Promise.allSettled` so a failed health
  read hides the line instead of failing the page; hands a failed **list** read to
  the client as an error rather than an empty array (FR-9).
- `apps/web/src/app/[locale]/(dashboard)/decisions/decisions-client.tsx` — the
  client shell holding selection, filters and URL sync (the pattern in
  [`activity/activity-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>)).
- `apps/web/src/lib/constants.ts` — add
  `DASHBOARD_DECISIONS: '/decisions'` and
  `DASHBOARD_DECISION: (id: string) => \`/decisions?id=${id}\`` to `ROUTES`.
- `apps/web/src/components/dashboard/DashboardSidebar.tsx` — one nav entry between
  `Dashboard` and `Inbox`, label key `dashboard.sidebar.navigation.decisions`, with
  the open-count badge fed the same way the Inbox unread badge is.

### 5.2 New components — `apps/web/src/components/decisions/`

| File | Responsibility |
| --- | --- |
| `DecisionsClient.tsx` | Two-pane shell, selection, keyboard map, live region |
| `DecisionQueueList.tsx` | The ranked list, paging, position walker |
| `DecisionCard.tsx` | One row: title, agent, age, blocking chip, `n of m`, repeat chip |
| `DecisionDetail.tsx` | Header, what-happened, attempt trail, ask checklist, footer actions |
| `DecisionAskList.tsx` | Ordered asks + progress line + the pending/resolved banner |
| `DecisionAskItem.tsx` | One ask: status glyph, prompt, control, answered summary, `⋯` menu |
| `asks/AskChoice.tsx` | `decision` kind, single-select, recommended badge |
| `asks/AskMultiChoice.tsx` | `decision` kind, multi-select with the min/max hint |
| `asks/AskApproval.tsx` | `approval` kind: action, risks, Approve / Reject |
| `asks/AskFact.tsx` | `fact` kind: textarea + character counter |
| `asks/AskAccess.tsx` | `access` kind: capability line, grant link, "I have granted it" |
| `asks/AskAction.tsx` | `action` kind: optional note + "Mark done" |
| `AskRationaleField.tsx` | The shared required/optional "why" field |
| `DecisionUndoMenu.tsx` | The `⋯` menu with the two disabled-undo explanations |
| `DecisionArchiveAllDialog.tsx` | Confirmation naming the count and the filter |
| `DecisionHealthBanner.tsx` | The four bands + the adjust/hide menu (P3) |
| `DecisionEmptyState.tsx` | The two empty states (§6.7 / §6.8 of the spec) |
| `DecisionErrorState.tsx` | The never-show-an-empty-queue error state |
| `DecisionKeyboardSheet.tsx` | The `?` overlay |
| `index.ts` | Barrel |

Every one of these is a client component except `DecisionEmptyState` and
`DecisionErrorState`, which are presentational.

### 5.3 Data plumbing

- `apps/web/src/lib/api/decisions.ts` — `server-only`, `serverFetch` /
  `serverMutation`, mirroring `DecisionDto` by hand exactly as
  [`agent-approvals.ts`](../../../../../apps/web/src/lib/api/agent-approvals.ts)
  does, and forwarding scope selectors through
  [`bff-scope.ts`](../../../../../apps/web/src/lib/api/bff-scope.ts).
- `apps/web/src/lib/api/decisions.shared.ts` — the pure types and the
  band/ranking helpers shared by the server client and the client components
  (the `*.shared.ts` convention already used by `inbox.shared.ts`,
  `costs.shared.ts`, `credits.shared.ts`).
- `apps/web/src/app/actions/dashboard/decisions.ts` — server actions
  `listDecisionsAction`, `getDecisionAction`, `answerAskAction`, `undoAskAction`,
  `archiveDecisionAction`, `restoreDecisionAction`, `archiveAllDecisionsAction`,
  `getDecisionHealthAction`, `updateDecisionBandAction`; each with the
  `requireAuth` → redirect guard copied from
  [`agent-approvals.ts`](../../../../../apps/web/src/app/actions/dashboard/agent-approvals.ts)
  and a `revalidatePath('/[locale]/(dashboard)/decisions', 'page')` plus
  `revalidatePath('/[locale]/(dashboard)/(home)', 'page')` after every write, so the
  Home block and the sidebar badge stay truthful.

State: selection and filters in the URL; the list in `useState` seeded from the
RSC payload; a `useEffect` interval refetching **counts only** every 30 s while
`document.visibilityState === 'visible'` (FR-7). Answering is optimistic on the
ask's status only — never on the decision's resolution, which depends on the
server's view of the other asks.

### 5.4 Entry points added elsewhere

- [`(dashboard)/(home)/dashboard-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx>)
  — a footer link under the existing `ApprovalsQueue` block. The block itself is
  untouched.
- [`components/inbox/InboxClient.tsx`](../../../../../apps/web/src/components/inbox/InboxClient.tsx)
  — an **Open in My Decisions** link on `escalation` and `approval` items.
- The Task detail escalation feed — the same link per row.
- AW-02's `Needs you` lane links to `ROUTES.DASHBOARD_DECISIONS` with
  `?missionId=`. That link is added by AW-02; this epic only guarantees the
  filter exists.

---

## 6. Background work

Both jobs are `schedules.task` registrations in
[`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/),
exported from [`index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts),
each booting a `NestApplicationContext(TriggerInternalModule)` and delegating to an
agent-package service — the shape
[`agent-run-sweeper.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-run-sweeper.task.ts)
already uses. **No call site imports a vendor SDK** (Constitution IV).

| Task id | Cron | Delegates to | Does |
| --- | --- | --- | --- |
| `decision-queue-sweeper` (P2) | `*/30 * * * *` | `DecisionSweeperService.sweep()` | Finds open decisions whose linked Run is `cancelled` and whose Task is missing, archives them with `archivedReason='source-gone'` (FR-49), capped at 500 rows per tick; flags `dormant` is derived at read time, not written |
| `decision-health-tick` (P3) | `20 7 * * *` UTC | `DecisionHealthService.tickAll()` | Writes one `decision_health_snapshots` row per active user for yesterday (idempotent on `(userId, day)`), computes the 7-day median and band, and recomputes repeat clusters. Capped at 2000 users per tick with a cursor |

The **restart** itself is not a new job: it rides
`RunSteeringService.resume()`, which already enqueues through
`AGENT_TASK_EXECUTE_DISPATCHER`. `DecisionResolutionService` therefore never
touches a queue directly; it calls the steering service and reports what came back.

`digest-dispatcher` ([`digest-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/digest-dispatcher.task.ts))
gains one line in its existing body — "N decisions waiting" — in P3. No new cron.

---

## 7. Plugin boundaries

- **No new plugin package.** Nothing in this epic talks to an external service.
  Constitution I is satisfied vacuously.
- **No hardcoded plugin id anywhere** (Constitution II). An `access` ask names a
  **capability** (`analytics.read`) and optionally a **tool pattern** the existing
  tool-grant matcher understands. The "Open connections" link resolves through the
  existing plugins surface by capability; it never hard-codes a plugin id, and the
  service layer rejects an `access` question whose `capability` is empty.
- **Verification** uses `GET /api/tool-grants/check` (existing) when
  `toolPattern` is present; otherwise the grant is recorded as self-reported with
  `verified: false` (FR-19).
- **Secrets** (Constitution VII): an `access` question carries the *name* of what is
  needed and a link. The DTO has no field capable of holding a value, and a service
  guard rejects any `access` question whose `connectionHint` matches the existing
  secret-scan patterns.
- The agent-side authoring path in P2 is a chat tool
  (`packages/agent/src/decisions/decision-tools.ts`), added to
  [`agent-domain-tool-sources.ts`](../../../../../packages/agent/src/agents/agent-domain-tool-sources.ts)
  the same way `buildEscalationTools` is, with keyword slots "needs a decision",
  "ask the owner", "blocked on approval", "waiting on access".

---

## 8. i18n

One new namespace, `dashboard.decisions`, added to
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) and
structurally mirrored into the **20** sibling locale files in
[`apps/web/messages/`](../../../../../apps/web/messages/) (English values are
acceptable placeholders in the siblings; the *structure* must match or next-intl
throws at runtime). **Every leaf key is camelCase and contains no literal dot.**

```
dashboard.decisions
  title                       "My Decisions"
  subtitle                    "Everything waiting on you, and nothing else."
  counts
    open                      "{count} open"
    blocking                  "{count} blocking"
  tabs
    open                      "Open"
    answered                  "Answered"
    archived                  "Archived"
  filters
    agent                     "Agent"
    mission                   "Mission"
    kind                      "Kind"
    search                    "Search decisions"
    clear                     "Clear filters"
  kind
    decision                  "Choice"
    approval                  "Approval"
    fact                      "Fact"
    access                    "Access"
    action                    "Action"
  card
    blocking                  "Blocking"
    blockingRunParked         "Run paused"
    blockingTaskBlocked       "Task blocked"
    dormant                   "Open 30+ days"
    confidence                "{percent}% sure"
    notScored                 "not scored"
    progress                  "{answered} of {required}"
    repeat                    "Asked {count} times"
  detail
    whatHappened              "What happened"
    whatItTried               "What it tried"
    asksHeading               "What this needs from you"
    pendingMany               "Answer all {count} and {agent} picks this up where it stopped."
    pendingOne                "One more and {agent} picks this up where it stopped."
    positionWalker            "{index} / {total}"
    nextDecision              "Next decision"
    previousDecision          "Previous decision"
    openRun                   "Open Run"
    openTask                  "Open Task"
    openMission               "Open Mission"
    decidedBy                 "Decided by {name}"
  ask
    recommended               "RECOMMENDED"
    answer                    "Answer"
    cancel                    "Cancel"
    approve                   "Approve"
    reject                    "Reject"
    confirmRejection          "Confirm rejection"
    openConnections           "Open connections"
    granted                   "I have granted it"
    markDone                  "Mark done"
    noteOptional              "Note (optional)"
    multiSelectHint           "Choose {min}–{max}"
    needs                     "Needs {capability}"
    characterCount            "{count} / {max}"
    answeredBy                "{decision} by {name} · {time}"
  rationale
    labelRequired             "Why? (required)"
    labelOptional             "Why? (optional)"
    helper                    "One sentence is enough. This is what the agent learns from."
    tooLong                   "Keep it under {max} characters."
    missing                   "Add one sentence explaining why."
  resolution
    resumed                   "{agent} is picking the work back up."
    injected                  "Sent to the Run that is already going."
    none                      "Answered. There was no paused work left to restart."
    queued                    "Queued — waiting for a free slot."
    failed                    "Answered, but the agent could not be restarted automatically."
    runNow                    "Run now"
    otherBlockers             "Answered. This Task is still waiting on {count} other blocker(s)."
  undo
    label                     "Undo"
    blockedActed              "Undo — {agent} already acted on this. Undo cannot unsend or unspend."
    blockedWindow             "Undo — the 10-minute window has passed."
    withdrawnBanner           "You withdrew this {time}. {agent} has been told."
    previousAnswer            "Previous answer: {answer}"
    copyAnswer                "Copy answer"
  archive
    one                       "Archive"
    all                       "Archive all"
    dialogTitle               "Archive {count} decisions?"
    dialogBody                "They close unanswered. Nothing restarts and nothing is approved. You can restore any of them from Archived."
    dialogOverCap             "This archives the oldest {cap}. Run it again for the rest."
    dialogFilter              "Filtered by: {filter}"
    confirm                   "Archive {count}"
    restore                   "Restore"
    resultPlain               "Archived {count}."
    resultSkipped             "Archived {count}. {skipped} were already answered."
    autoReason                "Archived automatically — the work it belonged to is gone."
  health
    healthy                   "Healthy — about {count} decisions a day."
    heavy                     "Heavy — {count} decisions a day. Your agents are asking things their instructions could answer."
    flooded                   "Flooded — {count} open. Answer what matters, archive the rest, then fix the instructions."
    quiet                     "Nothing has needed you in two weeks. Worth spot-checking what your agents decided on their own."
    topAgent                  "Most of them: {agent}."
    openInstructions          "Open instructions"
    reviewRuns                "Review recent Runs"
    adjustBand                "Adjust the band"
    hideForDays               "Hide for 30 days"
    bandDialogTitle           "Adjust your decision band"
    bandHealthyMax            "Healthy ceiling (decisions per day)"
    bandQuietWindow           "Quiet window (days)"
  repeat
    banner                    "{agent} has asked this {count} times in {days} days."
    writeRule                 "Write this into {agent}'s instructions"
  empty
    quietTitle                "Nothing needs you right now."
    quietBody                 "That is either very good news, or your agents are deciding things they should be asking you about."
    quietFootnote             "Nothing has needed you in {days} days."
    firstRunTitle             "No decisions yet."
    firstRunBody              "When an agent hits something it should not decide alone — spending money, reaching a customer, choosing between two real directions — it stops and asks you here."
    openAgents                "Open Agents"
    safetyRails               "Safety rails"
    archivedTitle             "Nothing archived."
    answeredTitle             "Nothing answered yet."
  error
    title                     "Could not load your decisions."
    body                      "We did not show an empty queue, because we cannot tell whether it is empty."
    retry                     "Try again"
    lastKnown                 "Last known: {count} open, {time} ago."
  overLimit
    note                      "{count} further questions were not recorded — this decision was too long."
    hint                      "Answer these; the agent will ask again if it still needs more."
  access
    stillDenied               "That access still is not granted. Nothing was changed."
    selfReported              "Recorded on your word — we could not verify this grant."
  conflict
    answered                  "Someone else answered this a moment ago."
    archived                  "This decision was archived."
  loadMore                    "Load {count} more"
  keyboard
    title                     "Keyboard shortcuts"
    …one leaf per binding in spec §6.17
  toast
    answered                  "Answered."
    withdrawn                 "Answer withdrawn."
    archived                  "Decision archived."
    restored                  "Decision restored."
    error                     "Something went wrong. Please try again."
```

Two keys are added outside the namespace:

- `dashboard.sidebar.navigation.decisions` = `"My Decisions"`
- `dashboard.approvals.seeAll` = `"See all decisions ({count})"`
- `metadata.pages.decisions` — title/description, mirroring the existing
  `metadata.pages.*` entries.

---

## 9. Telemetry and failure modes

### 9.1 Activity log

New `ActivityActionType` members appended to
[`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)
(no migration — `varchar(50)`):

| Member | Written when |
| --- | --- |
| `DECISION_OPENED = 'decision_opened'` | An escalation or proposal is created with its asks |
| `DECISION_VIEWED = 'decision_viewed'` | First human read (stamps `firstViewedAt`) |
| `DECISION_ANSWERED = 'decision_answered'` | An ask is answered; `details` carries `askKind`, `hadRationale` — **never the answer text** |
| `DECISION_RESOLVED = 'decision_resolved'` | The last required ask closed the decision; `details` carries `delivery`, `queued`, `taskUnblocked` |
| `DECISION_WITHDRAWN = 'decision_withdrawn'` | An answer was undone |
| `DECISION_ARCHIVED = 'decision_archived'` | `details.reason` ∈ `user` \| `bulk` \| `source-gone` |
| `DECISION_RESTORED = 'decision_restored'` | Restored from Archived |

Every entry names the acting user. Free-text answers, rationales and prompts are
**not** written to the activity log — only shapes and counts.

### 9.2 Product analytics

Client events through the existing PostHog provider
([`apps/web/src/components/posthog/PostHogProvider.tsx`](../../../../../apps/web/src/components/posthog/PostHogProvider.tsx)):
`decision_queue_opened` (with `openCount`, `blockingCount`, `band`),
`decision_ask_answered` (`askKind`, `secondsSinceViewed`, `hadRationale`),
`decision_resolved` (`delivery`, `askCount`, `secondsToResolve`),
`decision_undone` (`secondsSinceAnswer`), `decision_archive_all`
(`count`, `skipped`), `decision_band_changed` (`from`, `to`),
`decision_repeat_rule_opened`. No event carries prompt or answer text.

### 9.3 Sentry

A restart failure inside `DecisionResolutionService` reports through the existing
monitoring package with `decisionId`, `runId`, `taskId` and the thrown reason — and
**no** prompt content. Everything else on this surface logs at `warn` and degrades.

### 9.4 Failure modes and chosen degradation

| Failure | Chosen behaviour |
| --- | --- |
| List read throws | Error state with `Try again` and the last cached count. Never an empty list |
| Health read throws / no snapshot yet | Health line hidden; page renders |
| `RUN_STEERING_PORT` unbound (no job runtime) | Answer recorded, decision closed, `delivery: 'failed'`, banner + `Run now` |
| `resume()` throws `ConflictException` (not resumable / no task) | `delivery: 'none'` with the machine reason; decision stays closed |
| Dispatch gate parks the restart | `delivery: 'resumed'`, `queued: true`, "Queued — waiting for a free slot." |
| Two answers race the same ask | CAS on `status='open'`; loser gets `409` plus the recorded answer and author |
| Answer arrives for an archived decision | `409` with `conflict.archived`; `Restore` offered |
| Archive-all races a resolution | Non-open rows skipped and counted |
| Tool-grant check unavailable during an `access` answer | Treated as unverifiable → self-reported, flagged in the record. It never blocks the user |
| Backfill finds a malformed `decisionNeeded` | The derived ask falls back to `"A decision is needed."` and the row is logged; the migration never fails on data |
| Ask `question` fails `parseHitlQuestion` on read | The ask renders as a plain text ask with the raw prompt and a warning chip; it is never dropped from the checklist |

---

## 10. Test plan

### 10.1 Unit — contracts (Vitest)

- `packages/contracts/src/__tests__/hitl-question.access-action.spec.ts` — parse,
  serialize, validate and describe both new question kinds; unknown-kind payload
  returns `null`; an `access` answer against an `action` question fails validation.

### 10.2 Unit — agent package (Jest)

- `packages/agent/src/decisions/__tests__/decision-ask.spec.ts` — the pure
  kind↔question mapping table, the required-reason predicate at every branch, the
  10-ask cap and the dropped-count report, prompt/context/option caps.
- `packages/agent/src/decisions/__tests__/decision-queue.service.spec.ts` — ranking
  truth table: blocking first; unscored ranked at 0.5 (above `0.4`, below `0.6`);
  age tie-break; archived and resolved excluded from `open`; limit clamped at 100.
- `packages/agent/src/decisions/__tests__/decision-resolution.service.spec.ts` —
  the delivery precedence matrix (live → inject, parked → resume, neither → none,
  throw → failed), remaining-required-asks gating, superseded marking when a
  pre-existing path closes the record, `taskUnblocked` vs `remainingBlockers`, and
  the guarantee that a restart failure never rolls back the answer.
- `packages/agent/src/decisions/__tests__/decision-undo.service.spec.ts` — the two
  undo guards at their boundaries (9 min 59 s / 10 min 01 s; run `queued` vs
  `running`), the withdrawal note composition, and that the withdrawn answer is
  retained.
- `packages/agent/src/decisions/__tests__/decision-archive.service.spec.ts` — the
  200 cap, oldest-first ordering, skip-and-report, and that archive never resolves
  or restarts.
- `packages/agent/src/decisions/__tests__/decision-health.spec.ts` — every band
  boundary (0-in-14-days, 1, 5, 6, 15, 16 per day, 26 open), clamping of both
  overrides, and idempotency of the daily snapshot.
- `packages/agent/src/decisions/__tests__/decision-repeat.spec.ts` — the 3-in-14
  clustering threshold and its advisory-only guarantee.
- `packages/agent/src/decisions/__tests__/decision-ask-materialiser.spec.ts` — the
  derived ask per reason code and per action type.
- `packages/agent/src/database/repositories/decision-ask.repository.scope.spec.ts` —
  owner scoping on every read and write, mirroring
  [`agent-escalation.repository.scope.spec.ts`](../../../../../packages/agent/src/database/repositories/agent-escalation.repository.scope.spec.ts).
- Extend [`packages/agent/src/inbox/__tests__/`](../../../../../packages/agent/src/inbox/__tests__/) —
  an Inbox escalation reply still resolves and still resumes after the extraction,
  and now also supersedes any remaining asks.
- Extend `packages/agent/src/database/database.module.spec.ts` /
  `database.config.spec.ts` — the two new entities appear in all three registries.

### 10.3 Controller specs — API (Jest, colocated)

- `apps/api/src/decisions/decisions.controller.spec.ts` — every route: the
  composite-id pipe rejecting `garbage`, `escalation:not-a-uuid` and
  `unknown:<uuid>`; limit clamping; 404 for a foreign id; 409 on a double answer;
  409 on answering an archived decision; the archive-all cap and skip counts; the
  `204` from `/health` with no snapshot; band clamping on `PATCH /health/band`.
- `apps/api/src/escalations/escalations.controller.spec.ts` — **new file**; the
  controller has no spec today. Covers list / get / resolve and the new
  supersede-plus-unblock behaviour on resolve.
- `apps/api/src/agent-approvals/agent-approvals.controller.spec.ts` — **new file**;
  same reasoning. Covers approve / reject / approve-all and the new
  supersede-plus-restart behaviour.

### 10.4 End-to-end — web (Playwright, `apps/web/e2e/`)

Naming follows the existing `flow-*.spec.ts` convention (e.g.
[`flow-agent-approvals-queue-deep.spec.ts`](../../../../../apps/web/e2e/flow-agent-approvals-queue-deep.spec.ts)).

| File | Covers |
| --- | --- |
| `flow-decisions-queue.spec.ts` | The queue renders both record types, ranking, tabs, filters in the URL, paging, position walker, both empty states, the error state |
| `flow-decisions-typed-asks.spec.ts` | All five controls render and validate; the required reason on reject and on a non-recommended choice; the over-limit note |
| `flow-decisions-auto-unblock.spec.ts` | Answering the last ask closes the decision, restarts the parked Run, unblocks the Task, and shows each of the five resolution lines |
| `flow-decisions-undo-withdrawal.spec.ts` | Undo inside the window; both disabled variants; the withdrawal reaching the agent; the reopened decision |
| `flow-decisions-archive-all.spec.ts` | Single archive + restore; the confirmation naming the count; the 200 cap copy; skip reporting |
| `flow-decisions-health-band.spec.ts` | The four bands at their boundaries, the override dialog, the hidden line when no snapshot exists |
| `flow-decisions-validation-authz-matrix.spec.ts` | Foreign ids 404 (never 403); malformed answers rejected; throttles; the archived-decision conflict |
| `flow-decisions-a11y.spec.ts` | Keyboard map, focus order, the live region, and axe over the queue and detail panes |

### 10.5 Web unit specs (Vitest)

- `apps/web/src/components/decisions/DecisionAskItem.unit.spec.tsx`
- `apps/web/src/components/decisions/asks/AskChoice.unit.spec.tsx`
- `apps/web/src/components/decisions/DecisionHealthBanner.unit.spec.tsx`
- `apps/web/src/lib/api/decisions.shared.unit.spec.ts`

### 10.6 Green before merge

`pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm --filter ever-works-api test`,
and the eight Playwright specs above. Per the repository's own note, i18n leaf keys
must be camelCase with no literal dot or the hydration spec reds several shards at
once — the i18n task in [`tasks.md`](./tasks.md) is a first-class entry for that
reason.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — The queue and the unblock

**Ships:** `decision_asks` + the additive columns and their migration; the derived
ask materialiser and the backfill; `DecisionQueueService`;
`DecisionResolutionService` extracted from the Inbox and made the single resolution
path for all four pre-existing doors; `GET /api/decisions`,
`GET /api/decisions/:id`, `POST …/answer`; `/decisions` with the two panes, the
five controls in read/answer form, ranking, filters, paging, both empty states, the
error state, the keyboard map; the sidebar entry and the Home / Inbox / Task links;
the `dashboard.decisions` namespace; the unit, controller and four e2e specs that
cover the above.

**Value on its own:** the escalation queue becomes visible for the first time, and
answering anything restarts the work.

### P2 — Typed asks, undo, archive

**Ships:** the two new question kinds in contracts; the agent-side authoring path
(`DecisionAskService.fileDecision` + the chat tool + the 10-ask cap and its
over-limit note); the access-grant verification against the tool-grant check;
undo with its two guards and the posted withdrawal; single archive, restore,
`archive-all`; the `decision-queue-sweeper` job; the remaining e2e specs.

**Value on its own:** one interruption can carry everything the agent needs, a
too-fast answer is recoverable, and a queue can be declared bankrupt.

### P3 — The health signal

**Ships:** `decision_health_snapshots` + the band-override columns and their
migration; `DecisionHealthService` and the `decision-health-tick` job; the health
line with its four bands and its adjust/hide menu; `GET /api/decisions/health`
and `PATCH /api/decisions/health/band`; repeat clustering, the `Asked N times` chip
and the write-to-instructions action; one line in the daily digest.

**Value on its own:** the queue stops being a chore and starts being a diagnostic.

---

## 12. Constitution compliance

| Principle | ✓ | Justification |
| --- | --- | --- |
| I — Plugin-first | ✓ | No external integration is added. The access ask links to existing connection surfaces and never calls a provider |
| II — Capability-driven | ✓ | An access ask names a capability or tool pattern; no plugin id appears anywhere outside a plugin package, and the service rejects an empty capability |
| III — Source-of-truth repos | ✓ | Decisions are platform metadata; no work content moves into the database |
| IV — Job runtime | ✓ | The restart rides `RunSteeringService` → `AGENT_TASK_EXECUTE_DISPATCHER`; the sweeper and the health tick are `schedules.task` registrations. No call site imports a vendor SDK |
| V — Forward-only migrations | ✓ | Two migrations: one `CREATE TABLE` + additive nullable columns + a chunked backfill; one `CREATE TABLE` + two nullable columns. No drop, no rename, no type change |
| VI — Tests | ✓ | 10 unit suites, 3 controller specs (two of which cover controllers that have none today), 8 e2e specs, 4 web unit specs |
| VII — Secrets | ✓ | An access ask stores a capability name and a link; the DTO has no value-bearing field and a service guard rejects secret-shaped hints. Answers and rationales never reach the activity log or analytics |
| VIII — Plugin counts | n/a | No plugin added |
| IX — Behaviour-first spec | ✓ | [`spec.md`](./spec.md) carries no class name, file path or code; this plan owns all of it |
| X — Backwards compatibility | ✓ | Every existing endpoint keeps its path, method and response shape. The three vocabulary additions (`archived` ×2, `access`/`action`) are additive union members that existing consumers ignore |

---

## 13. Follow-ups deliberately not taken here

1. **The Constitution's migration path is wrong.** §V says
   `apps/api/src/database/migrations/`; the code and
   [`apps/api/typeorm.config.ts`](../../../../../apps/api/typeorm.config.ts) say
   `apps/api/src/migrations/`. Fix the document in its own change; this plan follows
   the code.
2. **Executing an approved action.** Approval hands the decision back to the agent.
   A platform-side executor for spawn / schedule / send / budget-override is a
   separate epic with its own safety surface.
3. **Extracting a shared queue primitive.** `ApprovalsQueue`, `InboxClient` and now
   `DecisionQueueList` are three list-with-detail surfaces with no shared primitive
   under `apps/web/src/components/ui/`. This plan adds a fourth rather than
   refactoring three during a feature.
4. **Per-organisation roles.** The guard seam exists and `ensureAdmin` is currently
   identical to `ensureMember`. Decision routing needs it; it is not this epic's to
   build.
5. **Retiring the second inbound-trigger UI** and the other duplicated surfaces
   noted in the inventory — unrelated cleanup.
6. **Writing a fact answer into Memory.** Belongs to AW-07; the hook point is the
   `fact` branch of `DecisionResolutionService`.

---

## 14. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [`../README.md`](../README.md) ·
  substrate audit: [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md) (row **S2**)
- Constitution: [`../../../../../.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- House-style example: [`../../schedules/spec.md`](../../schedules/spec.md)
- Adjacent plans: [`../AW-02-mission-board/plan.md`](../AW-02-mission-board/plan.md),
  [`../AW-04-live-feed/`](../AW-04-live-feed/), [`../AW-19-home/`](../AW-19-home/)
