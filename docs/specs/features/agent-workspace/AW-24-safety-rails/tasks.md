# Task Breakdown: Safety rails and the trust ladder

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and
> ships with tests per **Constitution VI**. Every schema task ships its migration in the same PR
> per **Constitution V**.

**Epic ID**: `AW-24-safety-rails`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to guess
  a path. Paths without a marker already exist; **create** means the file is new.
- "Done when" is stated explicitly and is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each
  phase.
- Repo conventions that bite in this epic: files are kebab-case; every date column uses
  `@PortableDateColumn` (never `type: 'timestamp'`); entities carry no `@ManyToOne` (FKs live in
  the migration, EW-654 cycle rule); every new entity must be registered in
  `packages/agent/src/database/_entities-inventory.ts` or the first query throws
  `EntityMetadataNotFoundError`; i18n leaf keys are camelCase and must never contain a literal `.`.

---

# Phase P1 — The rails and the ladder

*Delivers spec FR-1 … FR-20, FR-31 … FR-39 and FR-64 … FR-81: the taxonomy, the four-rung ladder
resolved narrow-only over three scopes, the seven-rail gate, the refusal record, and the Safety
screen. Held actions are filed but not yet executed.*

## P1.1 — Contracts

- [ ] **T1. Safety contracts — the closed constants.**
  **Create** `packages/contracts/src/safety/action-category.types.ts` with `ActionCategory` (the
  13 ids of [spec §4.1](./spec.md)), `ACTION_CATEGORIES` (ordered as the spec table),
  `ACTION_CATEGORY_CEILING`, `ACTION_CATEGORY_DEFAULT`, `LADDERED_CATEGORIES`,
  `DRAFTABLE_CATEGORIES`.
  **Create** `packages/contracts/src/safety/trust-rung.types.ts` with `TrustRung`,
  `TRUST_RUNG_ORDER = ['off','draft','ask','auto']`, `compareRung()`, `minRung()`.
  **Create** `packages/contracts/src/safety/safety-rail.types.ts` with `SafetyRailId`,
  `SAFETY_RAIL_ORDER`, `SafetyReasonCode`, `SAFETY_REASON_CODES` (the 14 of FR-65),
  `SafetyVerdict`.
  **Create** `packages/contracts/src/safety/autonomy-grant.types.ts`,
  `rail-refusal.types.ts`, `workspace-pause.types.ts`, `safety-readiness.types.ts`,
  `limits.ts` (`HELD_ACTION_EXPIRY_DAYS = 14`, `HELD_ACTION_WARN_DAYS = 7`,
  `SAFETY_CACHE_TTL_MS = 10_000`, `PAUSE_INFLIGHT_GRACE_MS = 30_000`,
  `RESUME_BATCH_SIZE = 50`, `RESUME_BATCH_INTERVAL_MS = 10_000`,
  `RAIL_REFUSAL_PAGE_SIZE = 50`, `RAIL_REFUSAL_RETENTION_DAYS = 90`,
  `RAIL_REFUSAL_COLLAPSE_THRESHOLD = 50`, `RAIL_REFUSAL_SUMMARY_MAX = 500`,
  `WORKSPACE_PAUSE_REASON_MAX = 500`, `READINESS_WINDOW_DAYS = 30`,
  `READINESS_MIN_DECISIONS = 20`, `READINESS_MIN_APPROVAL_RATE = 0.95`,
  `STALE_PRICE_DELTA = 0.10`, `UNCLASSIFIED_ACTION_POLICY = 'warn'`).
  **Create** `packages/contracts/src/safety/index.ts`; **modify**
  `packages/contracts/src/index.ts` to re-export it.
  **Test**: **create** `packages/contracts/src/safety/__tests__/action-category.types.spec.ts`,
  `trust-rung.types.spec.ts`, `safety-rail.types.spec.ts` (Vitest) asserting the lists are closed,
  ordered, and match [spec §4.1](./spec.md) and FR-19/FR-65 exactly.
  **Done when**: `pnpm --filter @ever-works/contracts build && pnpm --filter @ever-works/contracts test`
  is green and `import { ACTION_CATEGORIES } from '@ever-works/contracts'` resolves from
  `apps/api`.

## P1.2 — Entities and the migration

- [ ] **T2. `AutonomyGrant` entity.**
  **Create** `packages/agent/src/entities/autonomy-grant.entity.ts` exactly per
  [plan §3.1](./plan.md) — `UNIQUE (userId, scopeType, scopeId, category)`,
  `idx_autonomy_grants_scope`, `tenantId`/`organizationId`, `@PortableDateColumn` for dates, no
  `@ManyToOne`.
  **Modify** `packages/agent/src/entities/index.ts` (export) and
  `packages/agent/src/database/_entities-inventory.ts` (register).
  **Test**: **create** `packages/agent/src/entities/__tests__/autonomy-grant.entity.spec.ts` —
  index names, portable dates, both scope columns present so
  `apps/api/src/scope/scope-stamping.subscriber.ts` will stamp it.

- [ ] **T3. `RailRefusal` entity.** *(parallel with T2)*
  **Create** `packages/agent/src/entities/rail-refusal.entity.ts` per [plan §3.2](./plan.md), with
  all four indexes and `summary` capped at 500.
  **Modify** the same two registry files.
  **Test**: **create** `packages/agent/src/entities/__tests__/rail-refusal.entity.spec.ts`.

- [ ] **T4. `WorkspacePause` entity.** *(parallel with T2)*
  **Create** `packages/agent/src/entities/workspace-pause.entity.ts` per [plan §3.3](./plan.md).
  Do **not** put a decorator-level unique index on `(tenantId, organizationId)` — it must be a
  hand-written Postgres partial unique in the migration, for the same reason `work_budgets` does
  it that way (a decorator index makes TypeORM generate a non-partial duplicate on the SQLite test
  driver).
  **Modify** the same two registry files.
  **Test**: **create** `packages/agent/src/entities/__tests__/workspace-pause.entity.spec.ts` —
  asserts there is **no** decorator-level unique index on the pair.

- [ ] **T5. P1 migration.**
  **Create** `apps/api/src/migrations/1791240000000-AddSafetyRailsCore.ts`.
  `up()`: `CREATE TABLE autonomy_grants`, `rail_refusals`, `workspace_pauses` with every index
  from [plan §3.1–3.3](./plan.md); the hand-written
  `CREATE UNIQUE INDEX uq_workspace_pauses_scope ON workspace_pauses (tenantId, organizationId)`
  plus its `WHERE organizationId IS NULL` partial sibling; FKs `setByUserId`, `pausedByUserId`,
  `userId` → `users(id) ON DELETE SET NULL` (or `CASCADE` for `userId`, matching
  `tool_grants`).
  `down()`: drop the three tables only.
  Generate with
  `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddSafetyRailsCore`,
  then hand-write the partial index and the FKs into the generated file.
  **Done when**: a fresh database and a database with existing rows both migrate cleanly, the
  migration is re-runnable with no additional writes, and no statement is a `DROP` or a rename.

## P1.3 — The pure core

- [ ] **T6. The taxonomy.**
  **Create** `packages/agent/src/safety/action-category.ts` exporting
  `ENTRY_POINT_CATEGORY` (the static map of [plan §2.2](./plan.md)) and
  `classifyAction(entryPointId, { pluginId?, toolName?, manifestCategories? })` returning
  `ActionCategory | null`. Resolution order: platform entry point → plugin manifest declaration
  (glob-matched with `matchesAnyToolPattern` from
  `packages/contracts/src/policy/tool-grant.types.ts`) → `null`. Where two categories plausibly
  apply, return the more restrictive (FR-6) using a documented restrictiveness order.
  **Test**: **create** `packages/agent/src/safety/__tests__/action-category.spec.ts`.

- [ ] **T7. The ladder — resolve and validate.** *(parallel with T6)*
  **Create** `packages/agent/src/safety/trust-ladder.ts` exporting
  `resolveLadder(rows, { workspaceScopeId, agentId })` → `ResolvedLadder` (narrow-only merge over
  `TRUST_RUNG_ORDER`, `decidedBy` per entry, shipped defaults for missing rows) and
  `validateRungWrite({ current, next, ceiling, draftable, isPromotion })` returning the FIRST
  violation message or `null` — same return shape as `validateGuardrails` in
  `packages/agent/src/agents/guardrails.ts`, so the two read alike.
  **Test**: **create** `packages/agent/src/safety/__tests__/trust-ladder.resolve.spec.ts` and
  `trust-ladder.validate.spec.ts` covering narrow-only, ceilings, one-rung-at-a-time,
  `spend.commitment` immovable, Draft not offered for non-draftable categories, and unrestricted
  demotion.

- [ ] **T8. The rail chain.**
  **Create** `packages/agent/src/safety/safety-rails.ts` with `SafetyRailContext`,
  `SafetyRailNext`, `SafetyRailMiddleware`, `SafetyVerdict` and
  `composeSafetyRails(order: readonly SafetyRailMiddleware[])`. Port the
  `composeRunAdmission` idiom from `packages/agent/src/agents/run-admission-chain.ts` **including
  its "called `next()` more than once" guard**.
  **Test**: **create** `packages/agent/src/safety/__tests__/safety-rails.compose.spec.ts`.

- [ ] **T9. The seven rails.** *(parallel with T8 once T8's types land)*
  **Create** `packages/agent/src/safety/rails/platform-stop.rail.ts`,
  `workspace-pause.rail.ts`, `scope-pause.rail.ts`, `grants.rail.ts`, `ladder.rail.ts`,
  `caps.rail.ts`, `rules.rail.ts`. `grants.rail.ts` delegates to `TOOL_GRANT_ENFORCER`
  (`packages/agent/src/policy/tool-grant.enforcer.ts`); `rules.rail.ts` delegates to
  `MERGE_POLICY_ENFORCER` (`packages/agent/src/policy/merge-policy.enforcer.ts`);
  `platform-stop.rail.ts` delegates to `RUN_KILL_SWITCH`
  (`packages/agent/src/agents/run-kill-switch.ts`). None re-implements an existing decision.
  **Test**: **create** `packages/agent/src/safety/__tests__/rails.each.spec.ts` — one `describe`
  per rail asserting verdict, reason code, and that the rail's context type exposes no
  model-writable field (FR-15).

- [ ] **T10. Readiness and the digest.** *(parallel with T9)*
  **Create** `packages/agent/src/safety/readiness.ts` (`computeReadiness(decisions, now)`) and
  `packages/agent/src/safety/payload-digest.ts` (canonical JSON → sha256).
  **Test**: **create** `packages/agent/src/safety/__tests__/readiness.spec.ts` and
  `payload-digest.spec.ts` — thresholds at their boundaries; key-order independence; a one-byte
  change changes the digest.

## P1.4 — Services and the module

- [ ] **T11. Repositories and services.**
  **Create** `packages/agent/src/safety/autonomy-grant.repository.ts` + `.service.ts`,
  `rail-refusal.repository.ts` + `.service.ts`, `workspace-pause.repository.ts` + `.service.ts`.
  `AutonomyGrantService.write()` takes `actor: { userId: string; isHuman: true }` — a type the
  caller cannot fabricate without going through the guard (T18).
  `RailRefusalService.record()` **never throws**: it logs and increments an unrecorded counter
  (FR-69). `WorkspacePauseService.state()` folds every read error into
  `{ paused: true, unverified: true }`, mirroring `FleetKillSwitchService.state()` in
  `packages/agent/src/fleet/fleet-kill-switch.service.ts`.
  **Test**: **create** `packages/agent/src/safety/__tests__/rail-refusal.service.spec.ts` and
  `workspace-pause.service.spec.ts`.

- [ ] **T12. The state cache.**
  **Create** `packages/agent/src/safety/safety-state.cache.ts` — per-workspace ladder + pause
  snapshot with `SAFETY_CACHE_TTL_MS`, a `safe` flag set on any refresh failure, and immediate
  local invalidation on a write.
  **Test**: **create** `packages/agent/src/safety/__tests__/safety-state.cache.spec.ts` — a stale
  entry refreshes; a failed refresh sets `safe` and resolves every laddered category to `ask`
  (FR-18); a write invalidates.

- [ ] **T13. The gate port and service.**
  **Create** `packages/agent/src/safety/safety-gate.port.ts` — a **leaf** file with zero imports
  (the same circular-dep dodge documented on `packages/agent/src/agents/run-kill-switch.ts`),
  exporting `SAFETY_GATE` and `SafetyGate { evaluate(input): Promise<SafetyVerdict> }`, with a
  docblock stating the fail posture: unbound in a unit test = pass-through; unbound in a runtime
  that declares it needs it = boot assertion.
  **Create** `packages/agent/src/safety/safety-gate.service.ts` binding the rails in
  `SAFETY_RAIL_ORDER`, reading through the cache, and calling `RailRefusalService.record()` on
  every non-allow verdict.
  **Create** `packages/agent/src/safety/safety.module.ts` (imports `PolicyModule`, binds
  `SAFETY_GATE`, exports the services) and `packages/agent/src/safety/index.ts`.
  **Modify** `packages/agent/package.json` to add the `./safety` subpath export, and
  `packages/agent/jest.config.js` if a new module mapping is needed.
  **Done when**: `cd packages/agent && pnpm test` is green and
  `import { SAFETY_GATE } from '@ever-works/agent/safety'` resolves from `apps/api`.

## P1.5 — Calling the gate

- [ ] **T14. The one choke point.**
  **Modify** `packages/agent/src/agents/agent-run.service.ts` — in `invokeTool`, call
  `SAFETY_GATE.evaluate()` before `descriptor.invoke(...)`, injected
  `@Optional() @Inject(SAFETY_GATE)`. On `refused`, return a tool result naming the rail, the
  category and the rung — never throw. On `held`, return a tool result saying the action is held
  and pointing at the decision. On `allow`, proceed unchanged.
  **Note**: [AW-15](../AW-15-connections-scopes/) wants a hook at the same line for per-call grant
  checks. Whichever epic lands first creates the hook; the second adds its rail to
  `SAFETY_RAIL_ORDER` rather than a second call.
  **Test**: **create** `packages/agent/src/agents/__tests__/agent-run.safety-gate.spec.ts` — an
  unbound port behaves exactly as today; a refusal returns a result and does not fail the run
  (FR-30).

- [ ] **T15. The facade entry points.**
  **Modify** the platform action entry points listed in [plan §2.2](./plan.md) to call the gate
  with their entry-point id: the email and notify-channel facade adapters
  (`packages/agent/src/agents/agent-email-facade.ts` consumers,
  `agent-notify-channel-facade.ts` consumers), the git facade
  (`packages/agent/src/agents/agent-git-facade.ts` consumers) and
  `packages/agent/src/policy/pull-request-gate.service.ts`, the sub-agent delegation service
  (`packages/agent/src/agents/sub-agent-delegation.service.ts`), and the terminal session
  launcher (`packages/agent/src/agents/terminal-session-launcher.service.ts`).
  **Done when**: every category in `LADDERED_CATEGORIES` has at least one call site, asserted by
  **create** `packages/agent/src/safety/__tests__/entry-point-coverage.spec.ts`, which fails if a
  category has no registered entry point.

- [ ] **T16. Guardrail interop.**
  **Modify** `packages/agent/src/agent-approvals/agent-approvals.service.ts` — where an Agent
  carries `guardrails` **and** a resolved rung, take the stricter of the two. Do not change
  `evaluateGuardrails` itself; do not change the response shape.
  **Test**: **create** `packages/agent/src/agents/__tests__/guardrails.ladder-interop.spec.ts` —
  the stricter wins; a null guardrail changes nothing; a null ladder row falls back to the shipped
  default.

## P1.6 — API

- [ ] **T17. Safety controller.**
  **Create** `apps/api/src/safety/safety.module.ts`, `safety.controller.ts`, and
  `apps/api/src/safety/dto/{put-ladder.dto.ts,list-refusals.dto.ts}` implementing the eight routes
  of [plan §5.1](./plan.md). Class guards `AuthSessionGuard`, `SessionScopeGuard`
  (`apps/api/src/scope/session-scope.guard.ts`), `ScopeOwnershipGuard`
  (`apps/api/src/scope/scope-ownership.guard.ts`). Cross-workspace ids return **404, never 403**,
  matching every controller in this area. `@Throttle` 30/min on the two writes.
  **Modify** `apps/api/src/api.module.ts` to register `SafetyModule`.
  **Test**: **create** `apps/api/src/safety/safety.controller.spec.ts`.

- [ ] **T18. The human-actor guard.**
  **Modify** `apps/api/src/auth/types/auth.types.ts` — add optional
  `authMethod?: 'session' | 'api-key'` to `AuthenticatedUser` (optional, so no existing reader
  changes — Constitution X).
  **Modify** `apps/api/src/auth/guards/auth-session.guard.ts` — stamp it in both branches; the
  guard already knows which path ran.
  **Create** `apps/api/src/safety/guards/human-actor.guard.ts` and
  `apps/api/src/safety/decorators/human-only.decorator.ts`. A non-session actor is refused,
  a `RailRefusal` with reason `non-human-actor` is recorded, and a decision is raised naming the
  requester. A **missing** `authMethod` is treated as not-human.
  **Apply** `@HumanOnly()` to `PUT/DELETE /api/safety/ladder`.
  **Test**: **create** `apps/api/src/safety/guards/human-actor.guard.spec.ts`; **modify**
  `apps/api/src/auth/guards/auth-session.guard.spec.ts` to assert the stamp on both branches.

## P1.7 — Background

- [ ] **T19. Refusal prune.**
  **Create** `packages/tasks/src/tasks/trigger/safety-refusal-prune.task.ts` — a
  `schedules.task` at `20 3 * * *` UTC calling the prune over internal RPC, batching 5,000 rows,
  guarded by `DistributedTaskLockService`
  (`packages/agent/src/cache/distributed-task-lock.service.ts`), mirroring
  `apps/api/src/budgets/plugin-usage-cleanup.service.ts`.
  **Modify** `packages/tasks/src/tasks/trigger/index.ts` to export it.
  **Done when**: rows older than `RAIL_REFUSAL_RETENTION_DAYS` are gone after one run, the task is
  idempotent, and two overlapping ticks do not double-delete.

## P1.8 — Web

- [ ] **T20. i18n first.**
  **Modify** `apps/web/messages/en.json` — add the whole `dashboard.settings.safety` subtree of
  [plan §8.1](./plan.md) in **one** edit (a missing parent key collapses the subtree in every
  sibling locale), plus `dashboard.settings.tabs.safety`, `dashboard.safety.*` and
  `metadata.pages.safety`. Every leaf is camelCase and contains **no literal `.`**.
  Run the locale parity sync so all 20 sibling files receive the full paths; do not hand-edit them.
  **Done when**: `pnpm --filter web lint` passes and no locale file is missing a path.

- [ ] **T21. The Safety screen.**
  **Create** `apps/web/src/app/[locale]/(dashboard)/settings/safety/page.tsx` — a server component
  fetching overview, ladder and refusals with **`Promise.allSettled`**, each panel degrading
  independently (FR-73), following the pattern already documented on the Fleet and Work-Agent
  settings pages.
  **Create** `apps/web/src/lib/api/safety.ts` and
  `apps/web/src/app/actions/settings/safety.ts`.
  **Create** `apps/web/src/components/safety/{SafetyGuarantees,TrustLadderTable,RungCell,PromoteDialog,LadderRefusalNote,RefusalLog,RefusalRow}.tsx`
  and their `.unit.spec.tsx` siblings.
  **Modify** `apps/web/src/lib/constants.ts` — add
  `DASHBOARD_SETTINGS_SAFETY: '/settings/safety'`.
  **Modify** `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx` — insert
  the **Safety** tab directly above **Danger Zone**.
  **Done when**: the screen renders all four states of [spec §6.2, §6.3, §6.9, §6.10](./spec.md),
  every string resolves from the catalogue, and the ladder is an arrow-key grid whose cells carry
  the rung in their accessible name (FR-80, FR-81).

- [ ] **T22. Agent Safety tab.** *(parallel with T21)*
  **Create** `apps/web/src/components/agents/AgentSafetyTab.tsx` +
  `AgentSafetyTab.unit.spec.tsx` rendering [spec §6.11](./spec.md): resolved rung, `decidedBy`,
  narrow-only note, revert control, and the guardrails cross-link.
  **Modify** `apps/web/src/components/agents/AgentDetailTabs.tsx` to register the tab.
  **Modify** `apps/api/src/agents/agents.controller.ts` — add `resolvedLadder` to the detail DTO
  (additive only).

- [ ] **T23. P1 end-to-end.**
  **Create** `apps/web/e2e/safety-trust-ladder.spec.ts` — defaults render; promote one rung;
  skipping a rung refused; a ceiling refused; money not clickable; demotion instant; a non-owner
  sees everything read-only.
  **Create** `apps/web/e2e/safety-refusal-log.spec.ts` — filters, paging at 50, collapsed group +
  expand, and the three empty/error states.
  **Create** `apps/web/e2e/safety-a11y.spec.ts` — arrow-key grid, focus order, accessible names
  carry the rung as text, axe pass.
  **Done when**: all three are green locally and in CI.

> **P1 ship gate:** the ladder is enforced at every entry point; nothing that worked before stops
> working; unclassified plugin tools warn and are counted but are not refused.

---

# Phase P2 — Hold and execute

*Delivers spec FR-21 … FR-30: an action held by the ladder is stored verbatim, shown in
**My Decisions**, and executed byte-for-byte exactly once on approval.*

- [ ] **T24. Proposal columns + migration.**
  **Modify** `packages/agent/src/entities/agent-action-proposal.entity.ts` — add `category`,
  `railId`, `rung`, `payloadDigest`, `executionState` (default `'not_required'`), `executedAt`,
  `executionRunId`, `executionError`, `expiresAt`, `staleReason` per [plan §3.4](./plan.md).
  Append `send_external_message`, `publish`, `merge`, `grant_access`, `machine_command`,
  `destructive_write`, `spend` to `AGENT_ACTION_PROPOSAL_ACTION_TYPES` (additive; the column is a
  `varchar`, so the enum itself needs no migration).
  **Modify** `packages/agent/src/entities/agent-run.entity.ts` — add nullable
  `stoppedByRefusalId`.
  **Create** `apps/api/src/migrations/1791240100000-AddHeldActionExecution.ts` adding the eleven
  columns plus the partial index
  `idx_proposals_execution_pending ON agent_action_proposals (expiresAt) WHERE executionState = 'pending'`.
  `down()` drops the columns.
  **Test**: **modify** the existing proposal entity spec to assert the default keeps pre-existing
  rows at `not_required`.

- [ ] **T25. Held-action service.**
  **Create** `packages/agent/src/safety/held-action.service.ts` — `hold()` (store the resolved
  payload with credentials stripped, compute the digest, set `expiresAt = now + 14 days`,
  `executionState = 'pending'`), `markStale()`, `expire()`, `discardForRungOff()`.
  **Modify** `packages/agent/src/safety/rails/ladder.rail.ts` to call `hold()` on a `draft`/`ask`
  verdict and put the proposal id on the `RailRefusal`.
  **Test**: **create** `packages/agent/src/safety/__tests__/held-action.service.spec.ts` — raising
  a rung leaves holds held; lowering to `off` discards with a notice (FR-27); credentials never
  reach the stored payload (FR-21).

- [ ] **T26. The executor dispatcher.**
  **Create** `packages/agent/src/tasks/held-action-execution-dispatcher.ts` (token + interface,
  leaf file, following `packages/agent/src/tasks/webhook-delivery-dispatcher.ts`) and
  `held-action-execution.types.ts`.
  **Modify** `packages/agent/src/tasks/_tasks-symbols.ts` (add the symbol) and
  `packages/agent/src/tasks/job-runtime.providers.ts` (bind it).
  **Create** `packages/tasks/src/tasks/trigger/held-action-execute.task.ts`; **modify**
  `packages/tasks/src/tasks/trigger/index.ts`.
  The task claims the row with an atomic
  `UPDATE … SET executionState='executing' WHERE id=:id AND executionState='pending'` — **this is
  the exactly-once guarantee (FR-23)**, no advisory lock — recomputes and compares the digest,
  refuses on mismatch, re-enters the original entry point with an internal `bypassLadder`
  execution context that is never a DTO field, then stamps `executed`/`failed`. Returns an
  `{ ok, error }` envelope rather than throwing, matching
  `packages/tasks/src/tasks/trigger/run-plugin-operation.task.ts`.
  **Test**: **create** `packages/agent/src/safety/__tests__/held-action-executor.spec.ts` — a
  second concurrent claim is a no-op; a digest mismatch refuses and never executes.

- [ ] **T27. Approve executes.**
  **Modify** `apps/api/src/agent-approvals/agent-approvals.controller.ts` and
  `packages/agent/src/agent-approvals/agent-approvals.service.ts` — after the existing status
  flip, dispatch `HELD_ACTION_EXECUTION_DISPATCHER` when `executionState = 'pending'`.
  `approve-all` does the same per row and skips digest failures. Response shapes are unchanged;
  `executionState` is an **additive** DTO field in
  `packages/agent/src/agent-approvals/types.ts`.
  **Test**: **create** `apps/api/src/agent-approvals/agent-approvals.controller.spec.ts` (the
  controller has no spec today — this task adds the first one) asserting dispatch only for pending
  rows, already-decided rows still 409, and an unchanged response shape; **modify**
  `packages/agent/src/agent-approvals/__tests__/agent-approvals.service.spec.ts` for the service
  half.

- [ ] **T28. Staleness and expiry sweeper.**
  **Create** `packages/tasks/src/tasks/trigger/held-action-sweeper.task.ts` — a `schedules.task`
  at `*/15 * * * *` marking `staleReason` from the four triggers of FR-26, warning at 7 days
  (`safety.heldActionExpiring`), and discarding at 14 days with a notice on the decision. Uses the
  T24 partial index.
  **Modify** `packages/tasks/src/tasks/trigger/index.ts`.
  **Done when**: a held row crosses each boundary exactly once and the sweeper is idempotent
  across overlapping ticks.

- [ ] **T29. Notification event keys.**
  **Modify** the notification event-type registry consumed by
  `apps/api/src/notifications/notification-preferences.controller.ts` to add
  `safety.heldActionExpiring` (in-app on, email on) and `safety.widenAttempt` (in-app on, email
  off).
  **Modify** `apps/web/messages/en.json` — the two labels under the existing notifications
  namespace.

- [ ] **T30. Activity types.**
  **Modify** `packages/agent/src/entities/activity-log.types.ts` — append
  `SAFETY_RUNG_CHANGED`, `WORKSPACE_PAUSED`, `WORKSPACE_RESUMED`,
  `WORKSPACE_CANCEL_IN_FLIGHT`, `SAFETY_HELD_ACTION_EXECUTED`, `SAFETY_REFUSAL_SUMMARY`.
  **No migration** — `actionType` is a free `varchar(50)`; the enum is a TypeScript-side
  constraint only.
  **Modify** the ladder and pause services to emit them via
  `packages/agent/src/activity-log/activity-log.service.ts`. Individual refusals emit **nothing**;
  only the hourly collapsed summary does (FR-68).
  **Modify** `apps/web/messages/en.json` — labels for the six new types under the existing
  activity namespace.

- [ ] **T31. The held decision card and the Rails block.**
  **Create** `apps/web/src/components/safety/HeldActionPanel.tsx` +
  `HeldActionPanel.unit.spec.tsx` rendering [spec §6.12](./spec.md) — why, the exact payload,
  expiry, and the stale variant with its second confirmation.
  **Modify** the decision detail surface owned by [AW-03](../AW-03-decision-queue/) to mount it,
  and the run-receipt surface owned by [AW-09](../AW-09-runs-receipts/) to render the **Rails**
  block of [spec §6.14](./spec.md).
  **Modify** `apps/web/messages/en.json` — `dashboard.decisions.heldByLadder.*`.

- [ ] **T32. P2 end-to-end.**
  **Create** `apps/web/e2e/safety-held-send.spec.ts` — a Draft rung holds a send; the decision
  carries the exact body; approve sends once and a stored-vs-sent byte diff is empty; reject sends
  nothing; a stale hold needs the second confirmation; two simultaneous approvals produce one
  send.

> **P2 ship gate:** approving does the thing. `requireHumanApproval` on the merge path is
> satisfiable for the first time.

---

# Phase P3 — Pause and the one-way mirror

*Delivers spec FR-40 … FR-63: an owner-operated workspace pause enforced by the platform, and the
write-only-credential invariant made total.*

- [ ] **T33. Pause in the admission chain.**
  **Modify** `packages/agent/src/agents/run-admission-chain.ts` — add
  `QUEUED_REASON_WORKSPACE_PAUSED = 'workspace-paused'` and a `workspacePauseRail` middleware
  inserted immediately **after** the existing kill-switch middleware in
  `DEFAULT_RUN_ADMISSION_CHAIN`, fail-closed at the consumer exactly as the kill-switch middleware
  is.
  **Modify** `packages/agent/src/agents/run-dispatch-gate.service.ts` — re-export the reason and
  teach `promoteParked` about it (it already does this for `kill-switch`), and exempt
  workspace-paused rows from the stuck-run sweeper while the pause holds.
  **Test**: **create** `packages/agent/src/agents/__tests__/run-admission-chain.workspace-pause.spec.ts`
  — mirrors the existing `run-admission-chain.kill-switch.spec.ts`.

- [ ] **T34. The other six start points.**
  **Modify** the schedule dispatcher
  (`packages/agent/src/services/work-schedule-dispatcher.service.ts`), the agent schedule
  dispatcher (`packages/agent/src/agents/agent-schedule-dispatcher.service.ts`), the mission tick
  (`packages/agent/src/missions/mission-tick.service.ts`), the inbound trigger delivery path, the
  fleet job lease (`apps/api/src/fleet/fleet-jobs.controller.ts` → the agent-side lease service)
  and the outbound message path to consult `WorkspacePauseService.state()` before starting.
  A schedule due while paused is **skipped, not queued** (FR-50), and records the skip on the
  schedule.
  **Test**: **create** `packages/agent/src/safety/__tests__/pause-start-points.spec.ts` — one case
  per start point, asserting all seven refuse within the FR-42 budget.

- [ ] **T35. In-flight stop.**
  **Modify** `packages/agent/src/agents/agent-run.service.ts` — the T14 gate call also returns
  `paused`; on `paused` the run ends cleanly through the existing park path
  (`packages/agent/src/agents/agent-run-abort.ts`) with state preserved. A run that does not reach
  a boundary within `PAUSE_INFLIGHT_GRACE_MS` is **listed, never killed** (FR-44).
  **Test**: **modify** `packages/agent/src/agents/__tests__/agent-run.safety-gate.spec.ts`.

- [ ] **T36. Pause fan-out dispatcher.**
  **Create** `packages/agent/src/tasks/workspace-pause-fanout-dispatcher.ts` +
  `.types.ts`; **modify** `packages/agent/src/tasks/_tasks-symbols.ts` and
  `job-runtime.providers.ts`.
  **Create** `packages/tasks/src/tasks/trigger/workspace-pause-fanout.task.ts`; **modify**
  `packages/tasks/src/tasks/trigger/index.ts`.
  On pause: park queued runs, count into `workspace_pauses.refusedStarts`, mark due schedules
  skipped. On resume: promote oldest-first in batches of `RESUME_BATCH_SIZE` every
  `RESUME_BATCH_INTERVAL_MS`, reusing `RunDispatchGateService.promoteParked`.
  **Done when**: a 10,000-item backlog drains at the documented rate and the task is resumable
  after a worker restart.

- [ ] **T37. Pause API.**
  **Create** `apps/api/src/safety/safety-pause.controller.ts` and
  `apps/api/src/safety/dto/{stop-pause.dto.ts,cancel-in-flight.dto.ts}` implementing the four
  routes of [plan §5.2](./plan.md). **Two verbs, never a boolean `PUT`** — the same reasoning
  documented on `apps/api/src/fleet/fleet-kill-switch.controller.ts`. `@HumanOnly()` plus
  owner-only on all three writes; `@Throttle` 10/min on stop and resume, 5/min on
  cancel-in-flight. `cancel-in-flight` reuses `FleetPanicService.cancelInFlightForUser`
  (`apps/api/src/fleet/fleet-panic.service.ts`) for fleet-routed work and
  `packages/agent/src/agents/agent-run-canceller.ts` for cloud runs — it duplicates neither.
  **Test**: **create** `apps/api/src/safety/safety-pause.controller.spec.ts`.

- [ ] **T38. Pause UI.**
  **Create** `apps/web/src/components/safety/{WorkspacePauseCard,WorkspacePauseDialog,WorkspacePausedBanner}.tsx`
  and their `.unit.spec.tsx` siblings, rendering [spec §6.6, §6.7, §6.8](./spec.md).
  **Create** `apps/web/src/lib/hooks/use-workspace-pause-polling.ts` — a copy of
  `apps/web/src/lib/hooks/use-kill-switch-polling.ts` at 15 s, server-rendered first paint,
  last-known state retained on a failed poll.
  **Modify** the dashboard shell layout to mount the banner, and every surface named in FR-52 to
  show the pause reason rather than an unexplained absence of activity.
  **Modify** `apps/web/messages/en.json` — `dashboard.settings.safety.pause.*`,
  `dashboard.settings.safety.safeMode.*`, `dashboard.safety.*`.

- [ ] **T39. Command palette entries.** *(parallel with T38)*
  **Modify** the palette registry owned by [AW-01](../AW-01-command-palette/) to add
  `Pause everything`, `Resume everything` and `Safety`.

- [ ] **T40. Credential columns + migration.**
  **Modify** `packages/agent/src/entities/auth-account.entity.ts` — widen `accessToken`,
  `refreshToken` and `idToken` to `text` and apply the transformer from
  `packages/agent/src/entities/_secret-json-column.ts`. Keep the existing `@Exclude()` markers —
  encryption is defence in depth, not a replacement.
  **Create** `apps/api/src/migrations/1791240200000-EncryptAuthAccountTokens.ts` — column type
  changes only; **no data transformation inside the migration**, so a boot-time `migrationsRun`
  never blocks on a crypto pass. `down()` reverts the types.
  **Test**: **create** `packages/agent/src/entities/__tests__/auth-account.encryption.spec.ts` — a
  legacy plaintext row still reads; a written row carries the `enc::v1::` prefix.

- [ ] **T41. Encryption backfill.**
  **Create** `packages/agent/src/tasks/credential-encrypt-backfill-dispatcher.ts` + `.types.ts`;
  **modify** `_tasks-symbols.ts` and `job-runtime.providers.ts`.
  **Create** `packages/tasks/src/tasks/trigger/credential-encrypt-backfill.task.ts`; **modify**
  `packages/tasks/src/tasks/trigger/index.ts`.
  Batches of 500, resumable by `(id > cursor)`, skips rows already prefixed, triggered manually by
  an operator after T40 — never on boot.
  **Done when**: running it twice writes nothing the second time, and interrupting it mid-run
  leaves every row readable.

- [ ] **T42. Refuse to boot without a key.**
  **Modify** `packages/agent/src/plugins/services/plugin-secret-enc.service.ts` — extend
  `assertKeyAvailableInProd()` so the silent plaintext fallback survives **only** in local
  development, and every other environment (preview, staging, self-hosted) refuses to start.
  Log a prominent warning at every boot in development.
  **Test**: **modify** the service's existing spec to cover the three environment classes.

- [ ] **T43. Outbound scanning and the paste notice.**
  **Modify** the model-provider dispatch path to run
  `packages/agent/src/utils/secret-scan.ts` over every outbound payload, replacing matches with a
  placeholder and incrementing `safety_redactions_total`.
  **Modify** the chat-message, memory-fact, task-comment and knowledge-document write paths to
  store the masked form and return a one-time notice
  (`common.credentialPasteNotice`) to the author.
  **Test**: **create** `packages/agent/src/safety/__tests__/outbound-scan.spec.ts`.

- [ ] **T44. The serialisation invariant.**
  **Create** `packages/agent/src/safety/__tests__/secret-never-serialized.spec.ts` — enumerate
  every entity carrying a secret-bearing column (plugin settings, notification channel target
  config, MCP auth headers, repository env files, connected-account tokens) and every DTO mapper
  that touches them, and assert none can emit a raw value. The test must **fail** when a new
  secret-bearing column is added without a mapper.
  **Modify** the credential row UI to render exactly [spec §6.13](./spec.md), including the
  revoke-at-source line.
  **Modify** `apps/web/messages/en.json` — the `dashboard.settings.connections.*` additions of
  [plan §8.7](./plan.md).

- [ ] **T45. Flip the unclassified policy.**
  **Modify** the bundled plugins named in [plan §7.3](./plan.md) to declare
  `actionCategories` in their `everworks.plugin` manifest block; **modify**
  `packages/plugin/src/contracts/plugin-manifest.types.ts` to type and validate the field, and
  reject an unknown category id at load.
  **Modify** `packages/contracts/src/safety/limits.ts` — `UNCLASSIFIED_ACTION_POLICY = 'refuse'`.
  **Test**: **modify** `packages/agent/src/safety/__tests__/action-category.spec.ts` — an
  unclassified action now refuses and raises a decision.
  **Done when**: every bundled plugin declares, and the constant flip is a one-line diff covered by
  a test.

- [ ] **T46. P3 end-to-end.**
  **Create** `apps/web/e2e/safety-workspace-pause.spec.ts` — pause → banner everywhere → all seven
  start points refuse → winding-down list → restart still paused → resume → banner gone; an
  API-key attempt is refused and recorded.
  **Create** `apps/web/e2e/safety-secret-write-only.spec.ts` — no surface reveals a value; the
  mask, last-used and revoke-at-source copy render; a pasted credential is stored masked with the
  rotate notice.

- [ ] **T47. Telemetry and alerts.**
  **Modify** the monitoring wiring in `packages/monitoring` to register the counters and
  histogram of [plan §10.3](./plan.md) and the four alert thresholds.
  **Done when**: `safety_digest_mismatch_total`, `safety_unclassified_actions_total`,
  `safety_safe_mode_seconds_total` and `safety_refusals_unrecorded_total` are all visible in the
  dashboard, and a synthetic digest mismatch fires the page.

- [ ] **T48. Documentation.**
  **Create** `docs/specs/features/agent-workspace/AW-24-safety-rails/` cross-links in
  `docs/specs/features/agent-workspace/TRACKER.md` (status per phase).
  **Modify** `docs/specs/features/policy-matrices/` to link forward to this epic as the surface
  that now renders both matrices, without changing their own semantics.
  **Done when**: the tracker reflects P1/P2/P3 status and no doc claims the ladder is unbuilt.

> **P3 ship gate:** an owner can stop their own workspace, and every credential is write-only by
> construction, proved by a test rather than by a policy statement.

---

## Cross-phase reminders

- **Never** widen a response shape by renaming a field; add and alias (Constitution X).
- **Never** call a queue directly; every background item goes through a `*_DISPATCHER` symbol
  registered in `packages/agent/src/tasks/_tasks-symbols.ts` (Constitution IV).
- **Never** land an entity change without its migration in the same PR (Constitution V).
- **Never** add an i18n leaf containing a literal `.`; it breaks at runtime and reds several
  end-to-end shards at once.
- **Never** log, serialise, export or prompt with a credential value (Constitution VII) — T44 is
  the test that keeps this true after this epic ships.
