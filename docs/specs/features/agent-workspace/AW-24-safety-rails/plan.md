# Implementation Plan: Safety rails and the trust ladder

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns
> implementation detail; the spec owns behaviour. **Every path below was verified to exist in
> the worktree before it was written down**; paths marked *(new)* do not exist yet and are
> created by this epic.

**Epic ID**: `AW-24-safety-rails`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## 1. Current state in the codebase

### 1.1 Five refusal mechanisms, five vocabularies, one screen between them

| # | Rail today | Where the decision is made | Where it is enforced | Screen |
| --- | --- | --- | --- | --- |
| 1 | **Platform stop flag** | [`packages/agent/src/fleet/fleet-kill-switch.service.ts`](../../../../../packages/agent/src/fleet/fleet-kill-switch.service.ts) over the single-row [`fleet-kill-switch.entity.ts`](../../../../../packages/agent/src/entities/fleet-kill-switch.entity.ts) | The `RUN_KILL_SWITCH` middleware in [`run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts), the fleet router, and the job lease | [`FleetKillSwitchBanner.tsx`](../../../../../apps/web/src/components/settings/FleetKillSwitchBanner.tsx) — operator-only |
| 2 | **Agent / Mission / Run pause** | `AgentStatus` in [`agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts), mission status, run steering | Status checks scattered across the dispatcher, the heartbeat cron and the steering service | Per-entity buttons |
| 3 | **Tool grants** | [`packages/agent/src/policy/tool-grant.ts`](../../../../../packages/agent/src/policy/tool-grant.ts) (pure merge) + [`tool-grant.service.ts`](../../../../../packages/agent/src/policy/tool-grant.service.ts) | `resolveGrantedTools` in [`agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts) — once per Run, at descriptor-assembly time | Agent scope only, in [`AgentCapabilitiesClient.tsx`](../../../../../apps/web/src/components/agents/AgentCapabilitiesClient.tsx) |
| 4 | **Budgets** | [`packages/agent/src/budgets/budget-guard.service.ts`](../../../../../packages/agent/src/budgets/budget-guard.service.ts) | The same guard, at the metered call | Per-Work and per-Agent surfaces |
| 5 | **Merge policy** | [`packages/agent/src/policy/merge-policy.ts`](../../../../../packages/agent/src/policy/merge-policy.ts) + [`pull-request-gate.service.ts`](../../../../../packages/agent/src/policy/pull-request-gate.service.ts) | The merge call site and the PR-open gate | [`MergePolicyCard.tsx`](../../../../../apps/web/src/components/policy/MergePolicyCard.tsx), org scope only |
| 6 | **Agent dispatch guardrails** | [`packages/agent/src/agents/guardrails.ts`](../../../../../packages/agent/src/agents/guardrails.ts) — `evaluateGuardrails()` | [`agent-approvals.service.ts`](../../../../../packages/agent/src/agent-approvals/agent-approvals.service.ts) `createProposal` | **None** |

Six mechanisms. Two screens, both narrow. No shared vocabulary, no shared order, no shared audit
record, and no way for an owner to reason about the whole.

### 1.2 The five exact blockers

- **Autonomy is a two-value enum on the Agent row.**
  [`guardrails.ts`](../../../../../packages/agent/src/agents/guardrails.ts) defines
  `mode: 'require_approval' | 'autonomous'` plus two action-type arrays, stored on
  `agents.guardrails` (nullable `simple-json`, declared at
  [`agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts) line ~331). It
  covers the four members of `AGENT_ACTION_PROPOSAL_ACTION_TYPES`
  (`spawn_agent | schedule_task | send_message | budget_override | other`). There is no
  workspace scope, no notion of a *kind of work*, and no page that renders it.

- **Approval executes nothing.** The entity docstring on
  [`agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts)
  states it outright: *"Actually executing / resuming the approved action is a follow-up
  increment — this entity is the durable queue + decision record only."*
  `AgentApprovalsService.decide()` flips `status`, `decidedById`, `decidedAt`, `decidedVia` and
  returns. Nothing re-dispatches.

- **`requireHumanApproval` is unreachable.** `PLATFORM_DEFAULT_MERGE_POLICY` in
  [`packages/contracts/src/policy/merge-policy.types.ts`](../../../../../packages/contracts/src/policy/merge-policy.types.ts)
  sets `requireHumanApproval: true`, but the only production builder of the merge decision
  context hard-codes `humanApproved: false` with a comment saying no human-approval record
  exists at finalize time. The knob and the record were never joined.

- **The stop is the operator's, not the owner's.**
  [`apps/api/src/fleet/fleet-kill-switch.controller.ts`](../../../../../apps/api/src/fleet/fleet-kill-switch.controller.ts)
  is guarded by `FleetEnabledGuard` + `IsPlatformAdminGuard` and flips one global row.
  [`fleet-panic.controller.ts`](../../../../../apps/api/src/fleet/fleet-panic.controller.ts)
  gives the owner `drain-all`, `cancel-in-flight` and `rotate-all` — all machine-scoped. Nothing
  stops a workspace that runs entirely in the cloud.

- **`AuthenticatedUser` cannot tell a person from a key.**
  [`apps/api/src/auth/types/auth.types.ts`](../../../../../apps/api/src/auth/types/auth.types.ts)
  carries no field distinguishing the two credential paths, even though
  [`auth-session.guard.ts`](../../../../../apps/api/src/auth/guards/auth-session.guard.ts) knows
  exactly which one ran (its `extractApiKey` branch never falls through to the provider path).
  FR-31 and FR-47 need that distinction.

### 1.3 What already exists and must be reused, not rebuilt

- **The composable admission chain.**
  [`run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts)
  already is the pattern this epic generalises: middlewares of shape
  `(ctx, next) => Promise<Verdict>`, folded by `composeRunAdmission`, with the order expressed as
  **data** (`DEFAULT_RUN_ADMISSION_CHAIN`) rather than control flow. The safety gate is the same
  shape with a richer verdict. Do not invent a second composition idiom.
- **The leaf-token/port idiom.**
  [`run-kill-switch.ts`](../../../../../packages/agent/src/agents/run-kill-switch.ts),
  [`tool-grant.enforcer.ts`](../../../../../packages/agent/src/policy/tool-grant.enforcer.ts) and
  [`merge-policy.enforcer.ts`](../../../../../packages/agent/src/policy/merge-policy.enforcer.ts)
  are zero-import contract files consumed via `@Optional() @Inject(...)`. Every new port here
  copies that exactly, including the fail-open/fail-closed docstring convention.
- **Narrow-only merge semantics.**
  [`packages/agent/src/policy/tool-grant.ts`](../../../../../packages/agent/src/policy/tool-grant.ts)
  and [`packages/contracts/src/policy/tool-grant.types.ts`](../../../../../packages/contracts/src/policy/tool-grant.types.ts)
  already implement "a scope may only narrow an ancestor". The ladder merge is the same rule over
  an ordered enum instead of glob arrays.
- **Envelope encryption.**
  [`plugin-secret-enc.service.ts`](../../../../../packages/agent/src/plugins/services/plugin-secret-enc.service.ts)
  (AES-256-GCM, `enc::v1::` prefix, legacy-plaintext-tolerant read) and the reusable column
  transformer [`_secret-json-column.ts`](../../../../../packages/agent/src/entities/_secret-json-column.ts).
  FR-59 applies the same transformer to
  [`auth-account.entity.ts`](../../../../../packages/agent/src/entities/auth-account.entity.ts).
- **The credential scanner.**
  [`packages/agent/src/utils/secret-scan.ts`](../../../../../packages/agent/src/utils/secret-scan.ts)
  plus the terminal-specific layer in
  [`terminal-transcript-redaction.ts`](../../../../../packages/agent/src/agents/terminal-transcript-redaction.ts).
  FR-61 reuses both; it writes no new patterns.
- **Fail-closed single-row precedent.**
  [`fleet-kill-switch.entity.ts`](../../../../../packages/agent/src/entities/fleet-kill-switch.entity.ts)
  documents the exact posture the workspace pause copies: a read failure resolves to *stopped*,
  and setting the flag never cancels running work.
- **Scope stamping.** [`apps/api/src/scope/scope-stamping.subscriber.ts`](../../../../../apps/api/src/scope/scope-stamping.subscriber.ts)
  auto-fills `tenantId`/`organizationId` on any entity that declares both columns. Every new
  entity here declares them and gets scoping for free.
- **Polling banner idiom.** [`use-kill-switch-polling.ts`](../../../../../apps/web/src/lib/hooks/use-kill-switch-polling.ts)
  — poll unconditionally while mounted, keep the last-known state on a failed poll, server-render
  the first paint. The workspace-pause banner is a copy with a different endpoint.

---

## 2. Architecture and the seam this plugs into

### 2.1 One gate, seven rails, order as data

```
   agent decides to do something
              │
              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  classifyAction(entryPoint, actor)  ─────►  ActionCategory        │  pure
   └──────────────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  SAFETY GATE — composeSafetyRails(SAFETY_RAIL_ORDER)              │
   │                                                                   │
   │   1 platformStopRail ─► 2 workspacePauseRail ─► 3 scopePauseRail   │
   │        │                     │                      │             │
   │        └── refuse ───────────┴──────────────────────┘             │
   │                                                                   │
   │   4 grantRail ─► 5 ladderRail ─► 6 capRail ─► 7 ruleRail           │
   │        │             │              │            │                │
   │        └─ refuse ────┴── hold ──────┴── refuse ───┘                │
   └──────────────────────────────────────────────────────────────────┘
              │
     ┌────────┼─────────────┬──────────────────┐
     ▼        ▼             ▼                  ▼
   allow    refuse         hold            unclassified
     │        │             │                  │
     │        ▼             ▼                  ▼
     │   RailRefusal   RailRefusal +      RailRefusal +
     │    (refused)    AgentActionProposal  Decision + alert
     │                  (held payload)
     ▼
   the side effect happens
```

`SAFETY_RAIL_ORDER` is an exported constant array, not an `if` ladder — same reason
`DEFAULT_RUN_ADMISSION_CHAIN` is: the order is a published product promise (spec FR-19) and must
be assertable by a test rather than read out of control flow.

### 2.2 Where the gate is actually called

The gate is **not** called from the model loop. It is called at the platform's own action entry
points, all of which already exist:

| Category | Entry point that calls the gate |
| --- | --- |
| `read.external` | The search / screenshot / content-extractor facades under `packages/agent/src/facades/` |
| `write.internal`, `write.destructive` | Task, Mission, Memory and Knowledge-Base domain tool factories reached through `AGENT_DOMAIN_TOOL_SOURCES` in [`agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts) |
| `message.internal`, `message.external` | The `AGENT_EMAIL_FACADE` and `AGENT_NOTIFY_CHANNEL_FACADE` adapters ([`agent-email-facade.ts`](../../../../../packages/agent/src/agents/agent-email-facade.ts), [`agent-notify-channel-facade.ts`](../../../../../packages/agent/src/agents/agent-notify-channel-facade.ts)) |
| `publish.external` | `AGENT_GIT_FACADE` ([`agent-git-facade.ts`](../../../../../packages/agent/src/agents/agent-git-facade.ts)) + [`pull-request-gate.service.ts`](../../../../../packages/agent/src/policy/pull-request-gate.service.ts) + the deploy capability facade |
| `spend.metered` | [`budget-guard.service.ts`](../../../../../packages/agent/src/budgets/budget-guard.service.ts) call sites |
| `access.grant` | `AgentApprovalsService.createProposal` and the tool-grant / connection write services |
| `machine.run`, `machine.admin` | The fleet job dispatcher and the terminal session launcher ([`terminal-session-launcher.service.ts`](../../../../../packages/agent/src/agents/terminal-session-launcher.service.ts)) |
| `agent.fanout` | [`sub-agent-delegation.service.ts`](../../../../../packages/agent/src/agents/sub-agent-delegation.service.ts) and the schedule/trigger write services |
| MCP / plugin tools | `descriptor.invoke(...)` in [`agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) — the one place every tool call converges |

That last row is the important one and is the reason FR-14 is satisfiable: **`invokeTool` is a
single choke point** and today performs no per-call access check (grants are folded once at
descriptor-assembly time in `resolveGrantedTools`). Adding the gate there also fixes the
mid-Run-grant-change gap [AW-15](../AW-15-connections-scopes/) documents, and the two epics must
land the same hook once, not twice — AW-15 owns the grant half, AW-24 owns the ladder half, and
whichever lands first creates the hook.

### 2.3 Why the gate is not a Nest guard

Guards run on HTTP requests. Most of these actions are not HTTP requests — they are tool calls
inside a worker process, cron fires, and lease responses. The gate is a plain injected service
consumed through a leaf port, exactly like `RUN_KILL_SWITCH`, so the worker, the API and the unit
tests can all bind it (or not) independently.

### 2.4 How "within 10 seconds, no restart" is achieved

`SafetyStateCache` holds, per workspace: the resolved ladder per (agent, category), the pause row,
and a `loadedAt`. Every read checks `Date.now() - loadedAt > 10_000` and refreshes in-band. There
is no pub/sub and no websocket: a 10-second stale window is inside the FR-37 budget and needs no
new infrastructure. A write to a rung or a pause invalidates the local cache immediately for the
writing replica and lets the others expire.

Cache misses and store failures are the fail-closed path: a failed refresh sets
`mode: 'safe'` on the cache entry, every laddered category resolves to `ask`, and the API's
`GET /api/safety/overview` reports `safeMode: true` so the banner renders (spec U5 / FR-18).

### 2.5 Pause propagation

- **New work (≤ 5 s).** A new `workspacePauseRail` middleware is inserted into
  `DEFAULT_RUN_ADMISSION_CHAIN` immediately after the existing kill-switch middleware, parking the
  run with `queuedReason = 'workspace-paused'` — the same mechanism, the same sweeper exemption,
  the same `promoteParked` resume path the stop flag already uses. Schedules, triggers, mission
  ticks, heartbeats and fleet leases each gain the same single check.
- **In-flight (≤ 30 s).** `invokeTool` in
  [`agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) asks the
  gate before every tool call. When the workspace is paused it returns a `paused` verdict; the run
  ends cleanly at that boundary through the existing park path
  ([`agent-run-abort.ts`](../../../../../packages/agent/src/agents/agent-run-abort.ts)). A run
  that does not reach a boundary is *not* killed — it is listed (FR-44).

### 2.6 Held actions ride the approval record

No new queue. An action held by the ladder becomes an `AgentActionProposal` with a stored
`payload`, a `payloadDigest`, and a new `executionState`. Approving it through the **existing**
`POST /api/agent-approvals/:id/approve` now dispatches `HELD_ACTION_EXECUTION_DISPATCHER`, which
re-enters the original entry point with the stored payload and `bypassLadder: true` carried in an
internal, non-serialisable execution context — never a field on a DTO, never something a model can
set.

---

## 3. Data model

> Migrations live in `apps/api/src/migrations/` (timestamp-prefixed; the highest on `develop`
> today is `1789100000000-AddTaskGraphFanout.ts`). Entities live in
> `packages/agent/src/entities/` and **must** also be registered in
> [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts)
> — this repo has no `autoLoadEntities`, so a `forFeature`'d-but-unregistered entity throws
> `EntityMetadataNotFoundError` on first query.

### 3.1 `AutonomyGrant` — `packages/agent/src/entities/autonomy-grant.entity.ts` *(new)*

Table `autonomy_grants`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `userId` | uuid | Owner of the row; grants are user-scoped like `tool_grants` |
| `scopeType` | varchar(16) | `workspace` \| `agent` |
| `scopeId` | uuid | Organization id for `workspace` (nullable-sentinel `'00000000-…'` for bare-tenant, mirroring how `tool_grants` addresses the tenant scope), Agent id for `agent` |
| `category` | varchar(24) | One of the 13 category ids |
| `rung` | varchar(8) | `off` \| `draft` \| `ask` \| `auto` |
| `setByUserId` | uuid | Who wrote it. Never null — FR-31 |
| `note` | varchar(500) nullable | Optional reason |
| `tenantId` | uuid nullable | Stamped by the scope subscriber |
| `organizationId` | uuid nullable | Stamped by the scope subscriber |
| `createdAt` / `updatedAt` | `@PortableDateColumn` / `@UpdateDateColumn` | |

Indexes: `UNIQUE (userId, scopeType, scopeId, category)`,
`idx_autonomy_grants_scope (scopeType, scopeId)`.
No `@ManyToOne` (the EW-654 entity-cycle rule); the FKs live in the migration.

### 3.2 `RailRefusal` — `packages/agent/src/entities/rail-refusal.entity.ts` *(new)*

Table `rail_refusals`. Append-only; nothing updates a row.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `userId` | uuid | |
| `railId` | varchar(24) | `platform-stop` \| `workspace-pause` \| `scope-pause` \| `grants` \| `ladder` \| `caps` \| `rules` \| `taxonomy` |
| `category` | varchar(24) nullable | Null only for `taxonomy` refusals of an unclassifiable action |
| `verdict` | varchar(12) | `refused` \| `held` |
| `reasonCode` | varchar(32) | The closed list of spec FR-65 |
| `subjectType` | varchar(16) | `run` \| `agent` \| `mission` \| `task` \| `schedule` \| `trigger` |
| `subjectId` | uuid nullable | |
| `agentId` | uuid nullable | |
| `runId` | uuid nullable | Backlink to the receipt |
| `summary` | varchar(500) | Human-readable, credential-free, ≤ 500 chars (FR-70) |
| `requested` | `simple-json` nullable | Identifying parameters only — never a body, never a credential |
| `ceiling` | `simple-json` nullable | What the rail allowed, for the "requested vs ceiling" line |
| `proposalId` | uuid nullable | The held `agent_action_proposals` row, when `verdict = 'held'` |
| `collapseKey` | varchar(128) | `sha1(railId:agentId:category:yyyy-mm-dd)` — drives FR-68 |
| `tenantId` / `organizationId` | uuid nullable | Scope-stamped |
| `createdAt` | `@PortableDateColumn` | |

Indexes: `idx_rail_refusals_user_created (userId, createdAt DESC)`,
`idx_rail_refusals_collapse (collapseKey)`,
`idx_rail_refusals_agent_category (agentId, category, createdAt DESC)`,
`idx_rail_refusals_rail (railId, createdAt DESC)`.

### 3.3 `WorkspacePause` — `packages/agent/src/entities/workspace-pause.entity.ts` *(new)*

Table `workspace_pauses`. A row exists **only while paused**; delete on resume.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `userId` | uuid | Workspace owner |
| `tenantId` | uuid | Never null here — the pause is always tenant-anchored |
| `organizationId` | uuid nullable | Null = the bare-tenant workspace |
| `reason` | varchar(500) nullable | |
| `pausedByUserId` | uuid | |
| `pausedAt` | `@PortableDateColumn` | |
| `refusedStarts` | int default 0 | Incremented by the rail; drives the banner count |
| `cleanlyStopped` | int default 0 | Runs that parked at a boundary |
| `updatedAt` | `@UpdateDateColumn` | |

Index: `UNIQUE (tenantId, organizationId)` — Postgres partial-unique for the NULL case, written
by hand in the migration exactly as `work_budgets` does (a decorator-level `@Index` would make
TypeORM generate a non-partial duplicate on the SQLite test driver).

### 3.4 Additive columns on existing tables

**`agent_action_proposals`** (entity
[`agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts)):

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `category` | varchar(24) nullable | `NULL` | Null on rows written before this epic |
| `railId` | varchar(24) nullable | `NULL` | Which rail held it |
| `rung` | varchar(8) nullable | `NULL` | The rung in force when it was held |
| `payloadDigest` | varchar(64) nullable | `NULL` | sha256 of the canonicalised payload (FR-22) |
| `executionState` | varchar(16) | `'not_required'` | `not_required` \| `pending` \| `executing` \| `executed` \| `failed` \| `expired` \| `discarded` |
| `executedAt` | timestamp nullable | | |
| `executionRunId` | uuid nullable | | The Run that performed the execution |
| `executionError` | text nullable | | |
| `expiresAt` | timestamp nullable | | `createdAt + 14 days` for held rows |
| `staleReason` | varchar(120) nullable | | Set by the staleness checker |

`executionState` defaults to `not_required` so every pre-existing row keeps exactly its current
behaviour (Constitution X).

Two additive `AgentActionProposalActionType` members are appended — `send_external_message`,
`publish`, `merge`, `grant_access`, `machine_command`, `destructive_write`, `spend` — on a
`varchar` column, so **no migration is needed for the enum itself**, only for the columns above.

**`agent_runs`** (entity
[`agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts)):

| Column | Type | Notes |
| --- | --- | --- |
| `stoppedByRefusalId` | uuid nullable | Links a stopped run to the refusal that stopped it, for the receipt's Rails block |

`agent_runs.queuedReason` (existing `varchar(64)`) gains two new values —
`workspace-paused` and `rail-refused` — alongside the existing `concurrency-limit`,
`insufficient-credits` and `kill-switch`. No schema change.

**`account`** (entity
[`auth-account.entity.ts`](../../../../../packages/agent/src/entities/auth-account.entity.ts)):
`accessToken`, `refreshToken`, `idToken` widen from their current types to `text` and gain the
`EncryptedJsonColumn`-style transformer from
[`_secret-json-column.ts`](../../../../../packages/agent/src/entities/_secret-json-column.ts).
The transformer's read path is already legacy-plaintext-tolerant, so the backfill is *optional*
for correctness and *required* for the guarantee — hence the one-shot job in §6.4.

### 3.5 Migrations (forward-only, one per phase, shipped with their entities)

| Phase | File *(new)* | Contents |
| --- | --- | --- |
| P1 | `apps/api/src/migrations/1789300000000-AddSafetyRailsCore.ts` | `CREATE TABLE autonomy_grants`, `rail_refusals`, `workspace_pauses` with all indexes and the hand-written partial unique on `workspace_pauses`; FK `setByUserId`/`pausedByUserId` → `users(id) ON DELETE SET NULL`. `down()` drops the three tables only. |
| P2 | `apps/api/src/migrations/1789400000000-AddHeldActionExecution.ts` | The ten `agent_action_proposals` columns and `agent_runs.stopped_by_refusal_id`; a partial index `idx_proposals_execution_pending ON agent_action_proposals (expiresAt) WHERE executionState = 'pending'`. `down()` drops the columns. |
| P3 | `apps/api/src/migrations/1789500000000-EncryptAuthAccountTokens.ts` | `ALTER TABLE account ALTER COLUMN "accessToken" TYPE text` (and the two siblings). **No data is transformed inside the migration** — encryption happens in the backfill job (§6.4) so a long-running crypto pass never blocks a boot-time `migrationsRun`. `down()` reverts the types. |

Generate each with
`cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/<Name>`
and hand-write the partial index and the FKs into the generated file.

### 3.6 Contracts — `packages/contracts/src/safety/` *(new)*

Zero-dependency value types, re-exported from
[`packages/contracts/src/index.ts`](../../../../../packages/contracts/src/index.ts) alongside the
existing `policy/` folder:

| File | Exports |
| --- | --- |
| `action-category.types.ts` | `ActionCategory` (13 ids), `ACTION_CATEGORIES` (ordered), `ACTION_CATEGORY_CEILING`, `ACTION_CATEGORY_DEFAULT`, `DRAFTABLE_CATEGORIES`, `LADDERED_CATEGORIES` |
| `trust-rung.types.ts` | `TrustRung`, `TRUST_RUNG_ORDER = ['off','draft','ask','auto']`, `compareRung`, `minRung` |
| `safety-rail.types.ts` | `SafetyRailId`, `SAFETY_RAIL_ORDER`, `SafetyReasonCode`, `SAFETY_REASON_CODES`, `SafetyVerdict` |
| `autonomy-grant.types.ts` | `AutonomyGrantScopeType`, `AutonomyGrantDto`, `ResolvedLadder`, `ResolvedLadderEntry` (`{ category, rung, decidedBy, ceiling, draftable }`) |
| `rail-refusal.types.ts` | `RailRefusalDto`, `RailRefusalGroupDto`, `RAIL_REFUSAL_PAGE_SIZE = 50`, `RAIL_REFUSAL_RETENTION_DAYS = 90`, `RAIL_REFUSAL_COLLAPSE_THRESHOLD = 50` |
| `workspace-pause.types.ts` | `WorkspacePauseState`, `WORKSPACE_PAUSE_REASON_MAX = 500`, `RESUME_BATCH_SIZE = 50`, `RESUME_BATCH_INTERVAL_MS = 10_000` |
| `safety-readiness.types.ts` | `ReadinessDto`, `READINESS_WINDOW_DAYS = 30`, `READINESS_MIN_DECISIONS = 20`, `READINESS_MIN_APPROVAL_RATE = 0.95` |
| `index.ts` | Barrel |

Also add to `packages/contracts/src/safety/`:
`HELD_ACTION_EXPIRY_DAYS = 14`, `HELD_ACTION_WARN_DAYS = 7`,
`SAFETY_CACHE_TTL_MS = 10_000`, `PAUSE_INFLIGHT_GRACE_MS = 30_000`,
`STALE_PRICE_DELTA = 0.10`.

---

## 4. The agent-side module — `packages/agent/src/safety/` *(new)*

| File | Kind | Contents |
| --- | --- | --- |
| `action-category.ts` | pure | `classifyAction(entryPoint, hints)` — a total function over a static map from entry-point id to category, plus the plugin-declared overrides; returns `null` for unclassified. |
| `trust-ladder.ts` | pure | `resolveLadder(rows, { workspaceScopeId, agentId })` — narrow-only merge over `TRUST_RUNG_ORDER`, returning a `ResolvedLadder` with `decidedBy` per entry. `validateRungWrite(current, next, ceiling, isPromotion)` — the one-rung-at-a-time and ceiling rules, returning the FIRST violation message or `null` (same shape as `validateGuardrails` in [`guardrails.ts`](../../../../../packages/agent/src/agents/guardrails.ts)). |
| `safety-rails.ts` | pure | `SafetyRailContext`, `SafetyRailMiddleware`, `composeSafetyRails(order)` — a straight port of the `composeRunAdmission` idiom in [`run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts), including its "called `next()` twice" guard. |
| `rails/*.rail.ts` | pure-ish | One file per rail: `platform-stop.rail.ts`, `workspace-pause.rail.ts`, `scope-pause.rail.ts`, `grants.rail.ts`, `ladder.rail.ts`, `caps.rail.ts`, `rules.rail.ts`. Each reads only from its port. |
| `readiness.ts` | pure | `computeReadiness(decisions, now)` → `{ ready, answered, approvalRate, withdrawn, otherRefusals }`. No model, no I/O. |
| `payload-digest.ts` | pure | Canonical JSON (sorted keys, no undefined) → sha256. Used for FR-22. |
| `safety-gate.port.ts` | leaf token | `SAFETY_GATE`, `SafetyGate { evaluate(input): Promise<SafetyVerdict> }`. Zero imports. **Fail-closed at the consumer** — an unbound port in a runtime that *should* have it is a boot assertion, not a silent pass. |
| `safety-gate.service.ts` | service | Binds the rails, owns `SafetyStateCache`, writes refusals through the refusal service, creates held proposals. |
| `safety-state.cache.ts` | service | Per-workspace ladder + pause snapshot with the 10 s TTL and the `safe` mode flag. |
| `autonomy-grant.repository.ts` / `.service.ts` | | CRUD + resolve; write path takes an explicit `actor: { userId, isHuman: true }` it cannot fabricate. |
| `rail-refusal.repository.ts` / `.service.ts` | | Append, list (filtered, paged, collapsed), prune. `record()` never throws — it logs and increments an unrecorded counter (FR-69). |
| `workspace-pause.repository.ts` / `.service.ts` | | `state()`, `pause()`, `resume()`, `countRefusedStart()`. `state()` folds every read error into `{ paused: true, unverified: true }`, exactly as `FleetKillSwitchService.state()` does. |
| `held-action.service.ts` | service | Create held proposal, mark stale, expire, and — via the dispatcher — execute. |
| `safety.module.ts` | module | Binds `SAFETY_GATE`, exports the services. Imported by `AgentsModule` and `PolicyModule`. |
| `index.ts` | barrel | New subpath export `@ever-works/agent/safety` in `packages/agent/package.json`. |

**Where the gate is bound.** [`packages/agent/src/policy/policy.module.ts`](../../../../../packages/agent/src/policy/policy.module.ts)
already binds `TOOL_GRANT_ENFORCER` and `MERGE_POLICY_ENFORCER`; `SafetyModule` imports
`PolicyModule` and binds `SAFETY_GATE` on top, so the `grants` and `rules` rails delegate to the
existing enforcers rather than re-implementing them.

---

## 5. API surface — `apps/api/src/safety/` *(new)*

Registered in [`apps/api/src/api.module.ts`](../../../../../apps/api/src/api.module.ts).

### 5.1 `safety.controller.ts` — `@Controller('api/safety')`

Class guards: `AuthSessionGuard`, `SessionScopeGuard`, `ScopeOwnershipGuard`.

| Method | Path | Body / query | Returns | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/safety/categories` | — | `{ categories: ActionCategoryDto[] }` — id, name, ceiling, default, draftable | any member |
| GET | `/api/safety/overview` | — | `{ pause, safeMode, ladder, guarantees, refusalCounts }` | any member |
| GET | `/api/safety/ladder` | `?agentId=` | `ResolvedLadder` with `decidedBy` per entry | any member |
| PUT | `/api/safety/ladder` | `{ scopeType, scopeId, category, rung, note? }` | `ResolvedLadder` | **owner + human**, `@Throttle 30/min` |
| DELETE | `/api/safety/ladder/:id` | — | `ResolvedLadder` (reverts to inherit) | owner + human, 30/min |
| GET | `/api/safety/readiness` | `?agentId=` | `ReadinessDto[]` | any member |
| GET | `/api/safety/refusals` | `?railId=&category=&agentId=&from=&to=&cursor=&limit=` | `{ items, groups, nextCursor }` | any member |
| GET | `/api/safety/refusals/:collapseKey` | `?cursor=` | Expanded rows for a collapsed group | any member |

### 5.2 `safety-pause.controller.ts` — `@Controller('api/safety/pause')`

Two verbs, never one boolean `PUT` — the same reasoning documented on
[`fleet-kill-switch.controller.ts`](../../../../../apps/api/src/fleet/fleet-kill-switch.controller.ts).

| Method | Path | Body | Returns | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/safety/pause` | — | `WorkspacePauseState` (`{ paused, reason, pausedBy, pausedAt, refusedStarts, cleanlyStopped, windingDown[] }`) | any member |
| POST | `/api/safety/pause/stop` | `{ reason?: string }` (≤ 500) | `WorkspacePauseState` | owner + human, 10/min |
| POST | `/api/safety/pause/resume` | — | `{ state, promoting: number }` | owner + human, 10/min |
| POST | `/api/safety/pause/cancel-in-flight` | `{ confirm: true }` | `{ cancelled: number }` | owner + human, 5/min |

`cancel-in-flight` reuses `FleetPanicService.cancelInFlightForUser` for fleet-routed work
([`fleet-panic.service.ts`](../../../../../apps/api/src/fleet/fleet-panic.service.ts)) and the
existing run canceller ([`agent-run-canceller.ts`](../../../../../packages/agent/src/agents/agent-run-canceller.ts))
for cloud runs. It does **not** duplicate either.

### 5.3 The human-actor guard — `apps/api/src/safety/guards/human-actor.guard.ts` *(new)*

FR-31 and FR-47 need "a person in an interactive session". Two additive changes:

1. `AuthenticatedUser` in
   [`apps/api/src/auth/types/auth.types.ts`](../../../../../apps/api/src/auth/types/auth.types.ts)
   gains `authMethod?: 'session' | 'api-key'`. **Optional**, so every existing reader is
   unaffected (Constitution X).
2. [`auth-session.guard.ts`](../../../../../apps/api/src/auth/guards/auth-session.guard.ts)
   stamps it in both branches — it already knows which one ran.

`HumanActorGuard` refuses anything that is not `'session'`, records a `RailRefusal` with reason
`non-human-actor`, and raises a decision naming the requester. A missing `authMethod` (an older
token path) is treated as **not human** — fail closed.

### 5.4 Existing endpoints that change behaviour (not shape)

- `POST /api/agent-approvals/:id/approve`
  ([`agent-approvals.controller.ts`](../../../../../apps/api/src/agent-approvals/agent-approvals.controller.ts))
  — after flipping the status it now dispatches `HELD_ACTION_EXECUTION_DISPATCHER` when
  `executionState = 'pending'`. Response shape unchanged; a new `executionState` field is added to
  the DTO.
- `POST /api/agent-approvals/approve-all` — same, per row, and skips rows whose digest fails.
- `GET /api/agents/:id` — the DTO gains a `resolvedLadder` block for the Safety tab. Additive.

---

## 6. Background work

Every item below is dispatched through a `*_DISPATCHER` DI symbol registered in
[`packages/agent/src/tasks/_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts)
and wired by
[`packages/agent/src/tasks/job-runtime.providers.ts`](../../../../../packages/agent/src/tasks/job-runtime.providers.ts).
No call site imports a vendor SDK (Constitution IV).

### 6.1 `HELD_ACTION_EXECUTION_DISPATCHER`

- Port: `packages/agent/src/tasks/held-action-execution-dispatcher.ts` *(new)* + `.types.ts`.
- Task: `packages/tasks/src/tasks/trigger/held-action-execute.task.ts` *(new)*.
- Behaviour: load the proposal, verify `executionState = 'pending'` with an atomic
  `UPDATE … SET executionState='executing' WHERE executionState='pending'` (this **is** the
  exactly-once guarantee, FR-23 — no advisory lock needed), recompute the digest, refuse on
  mismatch, re-enter the original entry point with `bypassLadder`, then stamp
  `executed`/`failed`. Returns an `{ ok, error }` envelope rather than throwing, matching
  [`run-plugin-operation.task.ts`](../../../../../packages/tasks/src/tasks/trigger/run-plugin-operation.task.ts).

### 6.2 `WORKSPACE_PAUSE_FANOUT_DISPATCHER`

- Port: `packages/agent/src/tasks/workspace-pause-fanout-dispatcher.ts` *(new)*.
- Task: `packages/tasks/src/tasks/trigger/workspace-pause-fanout.task.ts` *(new)*.
- On **pause**: park queued runs for the workspace with `queuedReason='workspace-paused'`, count
  them into `workspace_pauses.refusedStarts`, and mark schedules due inside the window as skipped.
- On **resume**: promote parked runs oldest-first in batches of 50 every 10 seconds
  (`RESUME_BATCH_SIZE` / `RESUME_BATCH_INTERVAL_MS`), reusing
  `RunDispatchGateService.promoteParked`
  ([`run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts)),
  which the stop flag already uses for exactly this.

### 6.3 `safety-refusal-prune` (scheduled)

- Task: `packages/tasks/src/tasks/trigger/safety-refusal-prune.task.ts` *(new)*,
  `schedules.task` at `20 3 * * *` UTC — deliberately away from the 00:05 credits grant, the
  04:00 plugin-usage prune and the 07:15 digest.
- Deletes `rail_refusals` older than `RAIL_REFUSAL_RETENTION_DAYS`, in batches of 5,000, under
  `DistributedTaskLockService` (the same posture as
  [`plugin-usage-cleanup.service.ts`](../../../../../apps/api/src/budgets/plugin-usage-cleanup.service.ts)).

### 6.4 `CREDENTIAL_ENCRYPT_BACKFILL_DISPATCHER` (one-shot, P3)

- Port: `packages/agent/src/tasks/credential-encrypt-backfill-dispatcher.ts` *(new)*.
- Task: `packages/tasks/src/tasks/trigger/credential-encrypt-backfill.task.ts` *(new)*.
- Walks `account` in batches of 500, re-writing any token not already carrying the `enc::v1::`
  prefix. Idempotent and resumable by `(id > cursor)`. Triggered manually by an operator after
  the P3 migration; never on boot.

### 6.5 Held-action staleness and expiry (scheduled)

- Task: `packages/tasks/src/tasks/trigger/held-action-sweeper.task.ts` *(new)*,
  `schedules.task` at `*/15 * * * *`.
- Marks `staleReason` from the four shipped triggers (FR-26), warns at 7 days, discards at 14 days
  with a notice on the decision. Uses the partial index from §3.5.

---

## 7. Plugin boundaries

### 7.1 No new external integration

This epic adds none. Constitution I is satisfied trivially.

### 7.2 One plugin-facing declaration, no plugin ids in core

Core must classify a plugin-exposed tool without knowing which plugin it is (Constitution II).
The mapping therefore comes **from the plugin's own manifest**, not from a table in core:

- Extend the manifest type in
  [`packages/plugin/src/contracts/plugin-manifest.types.ts`](../../../../../packages/plugin/src/contracts/plugin-manifest.types.ts)
  with an optional `actionCategories?: Record<string, ActionCategory>` on the `everworks.plugin`
  block — tool name (glob allowed, reusing `matchesAnyToolPattern` from
  [`packages/contracts/src/policy/tool-grant.types.ts`](../../../../../packages/contracts/src/policy/tool-grant.types.ts)
  so pattern semantics cannot drift) → category id.
- `classifyAction` consults, in order: the platform's own entry-point map → the plugin manifest
  declaration → `null` (unclassified).
- **Phasing the fail-closed cut-over.** In **P1** an unclassified plugin tool proceeds and is
  counted (`rail_refusals` is *not* written; a metric is). In **P3**, after every bundled plugin
  declares, it is refused and raises a decision. The change is a single constant,
  `UNCLASSIFIED_ACTION_POLICY: 'warn' | 'refuse'`, exported from contracts and asserted by a test.
- No plugin id appears anywhere in `packages/agent/src/safety/`. A test asserts it
  (`grep`-style import assertion, same as the existing capability tests).

### 7.3 Which bundled plugins must declare

The nine `connector` plugins, the `browser-automation` and `pty-local` utility plugins, the two
`deployment` plugins and the `github` git-provider plugin. Every other bundled plugin exposes
tools already routed through a platform facade and inherits the facade's category.

---

## 8. i18n

All keys land in [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json). Leaf key
names are camelCase and **never contain a literal `.`** — a dot in a leaf breaks next-intl at
runtime and reds every hydration spec at once. Add the parent object in **one** edit: a missing
parent key collapses the whole subtree in the 20 sibling locale files.

### 8.1 `dashboard.settings.safety`

```
title, subtitle, ownerOnly,
guarantees.{heading, caps, rungs, decisions, pause, credentials, showMe}
ladder.{heading, subtitle, scopeLabel, columnWhat, columnOff, columnDraft,
        columnAsk, columnAuto, legendCurrent, legendAvailable,
        legendNotOffered, legendAboveCeiling, decidedByWorkspace,
        decidedByAgent, decidedByPlatform, narrowedHere, revert,
        underCaps, never, readyChip, narrowedCount}
category.{readInternal, readExternal, writeInternal, writeDestructive,
          messageInternal, messageExternal, publishExternal, spendMetered,
          spendCommitment, accessGrant, machineRun, machineAdmin, agentFanout}
categoryHelp.{…same 13 leaf names…}
rung.{off, draft, ask, auto}
rungHelp.{off, draft, ask, auto}
promote.{title, nowLabel, nextLabel, recordHeading, answered, approved,
         rejected, withdrawn, otherRefusals, readyNote, nothingGraduates,
         typeToConfirm, confirmCta, cancelCta}
refuse.{skipRung, aboveCeiling, money, nonOwner, nonHuman}
pause.{runningTitle, runningSubtitle, pauseCta, dialogTitle, whatStops,
       whatDoesNotStop, reasonLabel, reasonPlaceholder, reasonCounter,
       onlyYouCanResume, confirmCta, pausedTitle, pausedBy, refusedStarts,
       cleanlyStopped, windingDown, openRun, resumeCta, cancelInFlightCta,
       cancelInFlightConfirm, cancelInFlightWarning, skippedSchedule}
safeMode.{banner, retry}
refusals.{heading, rangeLabel, railLabel, categoryLabel, agentLabel,
          columnWhen, columnRail, columnWhat, columnAgent, columnOutcome,
          heldForYou, refused, requested, ceiling, resets, openDecision,
          openRun, raiseTheCap, widenAttempt, widenAttemptHelp,
          collapsed, collapsedHint, expand, showAll, newer, older,
          emptyQuiet, emptyQuietHelp, emptyNever, emptyNeverHelp,
          errorTitle, errorHelp, retry}
rail.{platformStop, workspacePause, scopePause, grants, ladder, caps, rules, taxonomy}
reason.{platformStopped, workspacePaused, scopePaused, rungOff, rungHeld,
        ceilingRefused, capReached, grantDenied, ruleBlocked, policyRefused,
        unclassifiedAction, instructionWideningAttempt, nonHumanActor, safeMode}
loading.{footnote}
```

### 8.2 `dashboard.settings.tabs.safety`

One new value, `"Safety"`, added to the existing `dashboard.settings.tabs` object rendered by
[`settings-layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx>).

### 8.3 `dashboard.safety` (banner, outside settings)

`pausedBanner`, `pausedBannerReason`, `pausedBannerActor`, `pausedBannerCount`,
`safeModeBanner`, `resumeCta`, `expandCta`.

### 8.4 `dashboard.agentsPage.safetyTab`

`title`, `subtitle`, `narrowOnlyNote`, `guardrailsNote`, `openGuardrails`, `revert`.

### 8.5 `dashboard.decisions.heldByLadder`

`why`, `whatWillHappen`, `exactlyThis`, `expiresIn`, `stale`, `staleApproveAnyway`,
`changeTheRung`.

### 8.6 `metadata.pages.safety`

`"Safety"` — consumed by the route's `generateMetadata()`.

### 8.7 Credential copy (extends existing namespaces)

`dashboard.settings.connections.writeOnlyNotice`,
`dashboard.settings.connections.revokeAtSource`,
`dashboard.settings.connections.lastUsedBy`,
`common.credentialPasteNotice`.

After adding English, run the locale parity sync so all 20 sibling files receive the full paths;
do not hand-edit them.

---

## 9. Web surface

### 9.1 Route and shell

- `apps/web/src/app/[locale]/(dashboard)/settings/safety/page.tsx` *(new)* — server component,
  three independent `Promise.allSettled` reads (overview, ladder, refusals) so one failure never
  blanks the page (FR-73), matching the fixed pattern documented on the Fleet and Work-Agent
  settings pages.
- `apps/web/src/lib/constants.ts` — add `DASHBOARD_SETTINGS_SAFETY: '/settings/safety'`.
- [`settings-layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx>)
  — insert the **Safety** tab directly above **Danger Zone**.

### 9.2 Components *(all new, under `apps/web/src/components/safety/`)*

| Component | Renders |
| --- | --- |
| `SafetyGuarantees.tsx` | The five statements + their **Show me** links |
| `TrustLadderTable.tsx` | The grid; owns arrow-key roving focus and the accessible-name composition (FR-81) |
| `RungCell.tsx` | One cell: current / available / not-offered / above-ceiling, each with text |
| `PromoteDialog.tsx` | The confirmation, the 30-day record, the typed confirmation for Auto |
| `LadderRefusalNote.tsx` | The four inline refusal messages |
| `WorkspacePauseCard.tsx` | Running/paused states, winding-down list, cancel-in-flight |
| `WorkspacePauseDialog.tsx` | The pause confirmation with the two lists and the reason field |
| `RefusalLog.tsx` | Filters, rows, collapsed groups, empty/error states, paging |
| `RefusalRow.tsx` | One row incl. the widen-attempt callout |

Outside that folder:

| Component | Where |
| --- | --- |
| `apps/web/src/components/safety/WorkspacePausedBanner.tsx` | Mounted in the dashboard shell, fed by `use-workspace-pause-polling` |
| `apps/web/src/components/agents/AgentSafetyTab.tsx` | New tab registered in [`AgentDetailTabs.tsx`](../../../../../apps/web/src/components/agents/AgentDetailTabs.tsx) |

### 9.3 Data plumbing

- `apps/web/src/lib/api/safety.ts` *(new)* — typed client, mirroring
  [`apps/web/src/lib/api/fleet.ts`](../../../../../apps/web/src/lib/api/fleet.ts).
- `apps/web/src/app/actions/settings/safety.ts` *(new)* — server actions for the four writes.
- `apps/web/src/lib/hooks/use-workspace-pause-polling.ts` *(new)* — a copy of
  [`use-kill-switch-polling.ts`](../../../../../apps/web/src/lib/hooks/use-kill-switch-polling.ts)
  at a 15-second interval, server-rendered first paint, last-known state retained on a failed poll.

---

## 10. Telemetry and failure modes

### 10.1 Activity log

Six additive `ActivityActionType` members in
[`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)
(appended; `actionType` is a free `varchar(50)`, so **no migration**):

`safety_rung_changed`, `workspace_paused`, `workspace_resumed`,
`workspace_cancel_in_flight`, `safety_held_action_executed`,
`safety_refusal_summary` (the hourly collapsed entry of FR-68).

Each carries actor, scope, category and old/new values in `details`. **Individual refusals never
write an Activity row** — that is what `rail_refusals` is for, and mixing them would drown the
Live Feed ([AW-04](../AW-04-live-feed/)).

### 10.2 Notifications

Two new event keys registered with the existing preference system
([`notification-preferences.controller.ts`](../../../../../apps/api/src/notifications/notification-preferences.controller.ts)):

| Key | Default in-app | Default email | Fires |
| --- | --- | --- | --- |
| `safety.heldActionExpiring` | on | on | 7 days before a held action expires |
| `safety.widenAttempt` | on | off | An instruction attempted to widen a rung |

Pause and resume reuse the existing workspace-level notification path; safe mode raises an
operational alert, not a user notification.

### 10.3 Metrics and error reporting

Counters (through `packages/monitoring`): `safety_gate_evaluations_total{verdict}`,
`safety_gate_latency_ms` (histogram), `safety_refusals_total{rail,reason}`,
`safety_refusals_unrecorded_total`, `safety_unclassified_actions_total{tool}`,
`safety_safe_mode_seconds_total`, `safety_held_actions_total{state}`,
`safety_digest_mismatch_total`, `workspace_pause_refused_starts_total`.

Alert thresholds: any `safety_digest_mismatch_total` increment pages immediately;
`safety_unclassified_actions_total` > 0.1% of gated actions over 24 h pages;
`safety_safe_mode_seconds_total` > 60 in any 5-minute window pages;
`safety_refusals_unrecorded_total` > 0 warns.

### 10.4 Failure modes and the chosen degradation

| Failure | Behaviour | Why |
| --- | --- | --- |
| Ladder/pause store unreachable | **Safe mode**: every laddered category behaves as `ask`; reads unaffected; banner + page | FR-18. A safety control that fails open is not one |
| `SAFETY_GATE` port unbound in a runtime that declares it needs it | Boot assertion fails | The opposite choice — silently passing — is how a DI mistake becomes a breach |
| `SAFETY_GATE` unbound in a unit test / non-API context | Every action passes, exactly as today | Mirrors `TOOL_GRANT_ENFORCER`'s documented posture; tests must not need the whole graph |
| Refusal write fails | Action still refused; `safety_refusals_unrecorded_total`++ | FR-69 — the record must never be able to let an action through |
| Held-action digest mismatch | Execution refused, proposal → `failed`, page | Something rewrote an approved payload. Never execute it |
| Job runtime unreachable at resume | Pause row cleared, promotion retried by the existing sweeper | Resume must not be blocked by a queue outage |
| Encryption key missing at boot | Refuse to start (outside local development) | FR-60, closing the observed silent-plaintext fallback |
| Plugin declares an unknown category id | Manifest validation rejects the plugin at load; existing installs keep their last-good manifest | Fail loudly at install, never at call time |

---

## 11. Test plan

### 11.1 Unit — Jest, `packages/agent` (`cd packages/agent && pnpm test`)

| File *(new)* | Asserts |
| --- | --- |
| `src/safety/__tests__/action-category.spec.ts` | The map is total over the entry-point registry; unknown returns `null`; plugin declarations override nothing the platform owns; the most-restrictive rule of FR-6 |
| `src/safety/__tests__/trust-ladder.resolve.spec.ts` | Narrow-only merge; `decidedBy` correctness; a raise below the workspace is refused; missing rows yield shipped defaults |
| `src/safety/__tests__/trust-ladder.validate.spec.ts` | One-rung-at-a-time; ceilings; `spend.commitment` immovable; Draft not offered for non-draftable categories; demotion unrestricted |
| `src/safety/__tests__/safety-rails.compose.spec.ts` | Order matches `SAFETY_RAIL_ORDER`; first refusal wins; `next()` twice throws |
| `src/safety/__tests__/rails.each.spec.ts` | One describe per rail: verdict, reason code, and that no rail reads a model-writable field |
| `src/safety/__tests__/readiness.spec.ts` | The four thresholds, boundary values, and that readiness never mutates a grant |
| `src/safety/__tests__/payload-digest.spec.ts` | Key-order independence; undefined handling; a one-byte change changes the digest |
| `src/safety/__tests__/workspace-pause.service.spec.ts` | Read error → `paused: true, unverified: true`; pause never cancels; resume batches at 50/10 s |
| `src/safety/__tests__/rail-refusal.service.spec.ts` | `record()` never throws; collapse key; 500-char summary truncation; no credential ever lands in `requested` |
| `src/safety/__tests__/held-action.service.spec.ts` | Exactly-once via the CAS update; digest mismatch refuses; expiry and staleness; raise-does-not-release, off-discards |
| `src/safety/__tests__/secret-never-serialized.spec.ts` | **The invariant (FR-63):** enumerate every entity with a secret-bearing column and every DTO mapper, and assert none emits a raw value. Fails loudly when a new secret column is added without a mapper |
| `src/agents/__tests__/guardrails.ladder-interop.spec.ts` | Where guardrails and a rung disagree, the stricter wins; a null guardrail changes nothing |

### 11.2 Contracts — Vitest, `packages/contracts`

`src/safety/__tests__/action-category.types.spec.ts`,
`trust-rung.types.spec.ts`, `safety-rail.types.spec.ts` — the constants are closed, ordered, and
match the spec tables exactly (this is the anti-drift test NFR-10 asks for).

### 11.3 Controller specs — Jest, `apps/api`

| File *(new)* | Asserts |
| --- | --- |
| `src/safety/safety.controller.spec.ts` | Every route's scope check; foreign id → 404 not 403; ceiling and skip refusals as 400 with the message; throttle decorators present |
| `src/safety/safety-pause.controller.spec.ts` | Two verbs not a boolean PUT; reason length; cancel-in-flight requires `confirm: true`; owner-only |
| `src/safety/guards/human-actor.guard.spec.ts` | `session` allowed; `api-key` refused **and recorded**; missing `authMethod` refused |
| `src/agent-approvals/agent-approvals.controller.spec.ts` *(new — this controller has no spec today)* | Approve dispatches the executor only when `executionState = 'pending'`; approve-all skips digest failures; response shape unchanged |
| `src/auth/guards/auth-session.guard.spec.ts` *(extend existing)* | `authMethod` stamped on both branches |

### 11.4 End-to-end — Playwright, `apps/web/e2e/`

| File *(new)* | Covers |
| --- | --- |
| `safety-trust-ladder.spec.ts` | Defaults render; promote one rung; skip refused; ceiling refused; money not clickable; demote instant; non-owner read-only |
| `safety-workspace-pause.spec.ts` | Pause → banner everywhere → new work refused → winding-down list → resume → banner gone; API-key attempt refused |
| `safety-held-send.spec.ts` | Draft rung holds a send; decision carries the exact body; approve sends once; reject sends nothing; stale double-confirm |
| `safety-refusal-log.spec.ts` | Filters, paging at 50, collapsed group + expand, empty/never/error states |
| `safety-secret-write-only.spec.ts` | No surface reveals a value; the mask, last-used and revoke-at-source copy render; a pasted credential is masked with the rotate notice |
| `safety-a11y.spec.ts` | Arrow-key grid, focus order, accessible names carry the rung in text, axe pass |

---

## 12. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — The rails and the ladder (spec FR-1 … FR-20, FR-31 … FR-39, FR-64 … FR-81)

Contracts, the three entities and the P1 migration; the pure taxonomy, ladder and rail chain; the
gate service bound in `SafetyModule`; refusal recording; the `/api/safety` controller; the Safety
screen with guarantees, ladder and refusal log; the Agent Safety tab; i18n; the daily prune.
The gate is called at the platform facades and at `invokeTool`. Held actions are **not** yet
executed — a `Draft`/`Ask` rung refuses with a clear message and files a proposal, which behaves
exactly as approvals do today. Unclassified plugin tools **warn**.

*Ships:* the ladder is real and enforced. Nothing that used to work stops working.

### P2 — Hold and execute (spec FR-21 … FR-30)

The `agent_action_proposals` columns and the P2 migration; the held-action service, digest,
staleness sweeper and expiry; `HELD_ACTION_EXECUTION_DISPATCHER` and its task; the approve path
change; the decision card's held-action view; the run receipt's Rails block.

*Ships:* approving does the thing. Closes the "approval is a note to self" gap and makes
`requireHumanApproval` satisfiable on the merge path for the first time.

### P3 — Pause and the one-way mirror (spec FR-40 … FR-63)

`workspace_pauses` wiring into the admission chain and the six other start points; the pause
controller, dialog, card and banner; the resume promoter; cancel-in-flight; the P3 migration and
the credential encryption backfill; the boot-time key assertion; outbound payload scanning; the
serialisation invariant test; `UNCLASSIFIED_ACTION_POLICY` flipped to `refuse` once every bundled
plugin declares.

*Ships:* an owner can stop their own workspace, and every credential is write-only by
construction rather than by convention.

---

## 13. Constitution compliance

| Gate | Status | Justification |
| --- | --- | --- |
| **I — Plugin package for every external integration** | ✅ | No external integration is added. The only plugin-facing change is a manifest declaration. |
| **II — No hardcoded plugin id outside the plugin** | ✅ | Categories for plugin tools come from the plugin's own manifest; a test asserts `packages/agent/src/safety/` imports no plugin package. |
| **III — Content lives in user repos** | ✅ | Rungs, pauses and refusals are platform metadata; no work content is touched. |
| **IV — Background work via `*_DISPATCHER`** | ✅ | Four dispatchers (§6), all registered in `_tasks-symbols.ts` and bound by `job-runtime.providers.ts`; no call site imports a vendor SDK. |
| **V — Forward-only migrations, same PR** | ✅ | Three migrations (§3.5), each shipped with its entities, each additive, none destructive; the credential encryption is a resumable backfill job, not a blocking DDL data pass. |
| **VI — Tests are a prerequisite** | ✅ | 12 unit suites, 3 contracts suites, 5 controller specs, 6 end-to-end specs (§11), including the FR-63 invariant test. |
| **VII — Secret hygiene** | ✅ | §4.7 of the spec *is* this principle, extended: encryption at rest for connected-account tokens, boot refusal without a key, outbound scanning, and an automated serialisation invariant. |
| **VIII — Single source for plugin lists** | ✅ | No plugin count or list appears in this epic. |
| **IX — Spec is behaviour-first** | ✅ | `spec.md` names no class, file or endpoint; every implementation detail is here. |
| **X — Backwards compatibility** | ✅ | `authMethod` is optional; `executionState` defaults to `not_required`; new action-type and activity-type members are appended to `varchar` columns; every existing response shape is unchanged, with only additive fields. |

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| The gate at `invokeTool` adds latency to every tool call | 10-second cache, pure in-memory evaluation, a p95 budget in NFR-1, and a benchmark in the acceptance list |
| Two epics both want a hook at `invokeTool` ([AW-15](../AW-15-connections-scopes/) for grants) | Whichever lands first creates the hook; the second adds a rail to `SAFETY_RAIL_ORDER`. Agreed in the plan of both epics |
| Fail-closed safe mode could stop a healthy workspace on a transient store blip | Safe mode is `ask`, not `off`; reads and running work continue; a 60-second window pages |
| The unclassified cut-over breaks third-party plugin installs | Warn in P1, refuse in P3, one constant, and an open question about a visible grace period |
| Owner-only writes are enforced against a role model that does not exist yet | The check is the existing workspace-owner check, isolated in one guard, so it becomes the first real role check when roles land |
| Encrypting connected-account tokens touches the login path | The transformer's read path is legacy-plaintext-tolerant, so the backfill can run at any time and be interrupted safely |

---

## 15. References

- [`spec.md`](./spec.md) · [`tasks.md`](./tasks.md)
- [Program overview](../README.md) · [Existing substrate](../EXISTING-SUBSTRATE.md)
- [AW-03 — My Decisions](../AW-03-decision-queue/) · [AW-15 — Connections and scopes](../AW-15-connections-scopes/) · [AW-17 — Costs, caps and credits](../AW-17-costs-caps/)
- [Constitution](../../../../../.specify/memory/constitution.md)
- Existing policy specs: [`docs/specs/features/policy-matrices/`](../../policy-matrices/)
