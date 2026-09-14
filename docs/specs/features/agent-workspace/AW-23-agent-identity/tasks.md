# Task Breakdown: Agent notes, personality, identity and levels

> Ordered tasks derived from [`plan.md`](./plan.md). Each task names the files to create or
> modify, what "done" means, and its phase. Execute top to bottom. Every task ships with
> its tests ([Constitution VI](../../../../../.specify/memory/constitution.md#vi-tests-are-a-prerequisite-not-a-follow-up)).

**Feature ID**: `AW-23-agent-identity`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`.
- Repo root is the monorepo root; every path below is relative to it.
- Commands run from the directory named in the task.
- `develop` must be green after each **phase**, not each task — but no task may leave a
  type error or a failing existing test behind.
- Add new tasks at the bottom rather than renumbering.
- **AW-07 is a hard dependency of P3 only.** T37 (the seven-pill editor) and T38
  (`NOTES.md` on the card) assume `NOTES.md`, the context-file revision store and the load
  meter have landed. Everything in P1 and P2 is independent of AW-07 and can proceed in
  parallel with it.

---

## Phase P1 — The brake and the stated reason

> P1 changes nothing about what an agent _is_. It makes the platform tell the truth about
> what an agent is _doing_, and makes Pause mean what its label says. Shipped alone it is
> already the highest-value half of the epic.

### P1.a — Contracts and data model

- [ ] **T1. Status and identity contracts.**
      Create `packages/contracts/src/agents/status.types.ts` and
      `packages/contracts/src/agents/identity.types.ts`; export both from
      `packages/contracts/src/agents/index.ts` (which
      `packages/contracts/src/index.ts` already re-exports at line 11).
      Contents exactly as plan §3.8: `AGENT_STATUS_REASONS`, `AgentStatusReasonCode`,
      `AGENT_STATUS_DOT`, `AGENT_STATUS_POLL_INTERVAL_MS = 10_000`,
      `AGENT_STATUS_BATCH_MAX = 100`, `AgentStatusDto`, `AgentIdentityDto`,
      `AGENT_HALT_NOTE_MAX = 200`, `AGENT_RESUME_PROMOTION_BUDGET = 50`.
      Declare every optional property with an explicit `if` block, never
      `...cond && { k: v }` — the conditional spread breaks declaration emit.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations and
      the constants import cleanly from `@ever-works/contracts`.

- [ ] **T2. Halt columns on `Agent`.**
      Modify `packages/agent/src/entities/agent.entity.ts`. Add the `AgentHaltReason` enum
      and the `AgentHaltDetail` interface beside the existing `AgentStatus` enum; add
      `haltReason`, `haltNote`, `haltedAt`, `haltedByUserId`, `haltedRunId`, `haltDetail`,
      `haltRepeatCount` in the `── Lifecycle ──` block after `pauseAfterFailures`, per
      plan §3.1. Use `PortableDateColumn` for `haltedAt`, not `type: 'timestamp'`.
      Export the enum from `packages/agent/src/entities/index.ts` and from
      `packages/agent/src/agents/index.ts` (which already re-exports `AgentStatus`).
      **Done when**: `pnpm --filter @ever-works/agent build` passes and the columns appear
      on the entity metadata.

- [ ] **T3. Halt migration.**
      Create `apps/api/src/migrations/1791230000000-AddAgentHaltReason.ts`, class
      `AddAgentHaltReason1791230000000`. Seven `queryRunner.addColumn` calls guarded by
      `getTable('agents')` + `findColumnByName`, portable `TableColumn` DDL, camelCase
      column names — copy the structure of
      `apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts` verbatim, including its
      re-read-the-table-between-drops comment in `down()`.
      `haltRepeatCount` is `int NOT NULL DEFAULT 0`; every other column is nullable.
      **No backfill** — existing paused agents read as "Paused by you" with no time.
      **Done when**: `cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts`
      applies cleanly on an empty database and on one already at
      the newest `develop` migration, and `migration:revert` reverses it.

- [ ] **T4. Parked-run reason and the admission input. (parallel with T5)**
      Modify `packages/agent/src/agents/run-admission-chain.ts`: add
      `export const QUEUED_REASON_AGENT_PAUSED = 'agent-paused' as const;` beside the other
      three reason constants, and add `agentId?: string | null` to `RunAdmissionInput`.
      Re-export the constant from `packages/agent/src/agents/index.ts` alongside the
      existing `QUEUED_REASON_*` exports.
      **Done when**: the package builds and no existing caller of `admit()` breaks (the new
      field is optional).

- [ ] **T5. The brake port. (parallel with T4)**
      Create `packages/agent/src/agents/run-agent-brake.ts` — a **leaf file with zero
      imports**, mirroring `packages/agent/src/agents/run-kill-switch.ts`. Export
      `AgentBrakeVerdict`, `RunAgentBrake`, `RUN_AGENT_BRAKE` and
      `AGENT_PAUSED_ERROR_NAME`, with a docblock stating the fail-CLOSED consumer posture.
      Re-export from `packages/agent/src/agents/index.ts`.
      **Done when**: the file has no `import` statement and the package builds.

### P1.b — Domain services

- [ ] **T6. `AgentStatusReasonResolver`.**
      Create `packages/agent/src/agents/agent-status-reason.ts` — a **pure** module, no
      Nest decorators, no IO — implementing the ten-step precedence ladder from plan §2.3
      and returning `AgentStatusDto` minus the fields the caller supplies.
      Create `packages/agent/src/agents/__tests__/agent-status-reason.spec.ts` covering
      every branch **in precedence order**, plus: `archived` beats everything; `working`
      beats `waitingOnYou`; `notStarted` only when `lastRunAt` is null; a paused agent with
      `haltReason = null` still resolves `pausedByYou`.
      **Done when**: `cd packages/agent && npx jest --testPathPattern='agent-status-reason'`
      is green and the resolver has no dependency on a repository.

- [ ] **T7. `AgentHaltService`.**
      Create `packages/agent/src/agents/agent-halt.service.ts` with
      `halt(agentId, reason, { note?, byUserId?, runId?, detail? })` and `clear(agentId)`.
      `halt` writes the columns from T2, increments `haltRepeatCount` when the incoming
      reason equals the stored one and resets it to 1 otherwise, and transitions the agent
      to `paused` through the existing `AgentsService.transition` path (never by writing
      `status` directly). `clear` nulls every halt column and zeroes the counter.
      Add `writeHalt`/`clearHalt` to
      `packages/agent/src/database/repositories/agent.repository.ts` as CAS updates so a
      double-pause is a no-op that preserves the original note, time and author.
      Create `packages/agent/src/agents/__tests__/agent-halt.service.spec.ts`.
      **Done when**: the repeat-count and no-op-on-double-pause cases pass.

- [ ] **T8. `AgentHaltClassifier`.**
      Create `packages/agent/src/agents/agent-halt-classifier.ts` — a pure predicate
      `isCredentialFault(input: { statusCode?: number; errorMessage?: string | null }):
boolean` over HTTP 401/403 plus a small **closed, provider-agnostic** phrase list.
      It must default to `false`. It must **never** copy any part of `errorMessage` into
      the returned halt detail; the detail's `subjectLabel` is supplied by the caller from
      a facade-resolved display name.
      Create `packages/agent/src/agents/__tests__/agent-halt-classifier.spec.ts` including
      a case asserting a token-shaped string in the error never reaches the detail.
      **Done when**: green, and no plugin id appears anywhere in the file.

- [ ] **T9. The brake service and its middleware.**
      Create `packages/agent/src/agents/agent-brake.service.ts` implementing
      `RunAgentBrake` over `AgentRepository` (a single indexed read of `status` +
      `haltReason` by id).
      Modify `packages/agent/src/agents/run-admission-chain.ts` to add
      `agentBrakeMiddleware`, and insert it into `DEFAULT_RUN_ADMISSION_CHAIN` at
      **position 2** — after the kill switch, before the Work valve.
      Modify `packages/agent/src/agents/run-dispatch-gate.service.ts` to consume the port
      with `@Optional() @Inject(RUN_AGENT_BRAKE)` and thread `input.agentId` into the
      admission context, exactly as it already threads the kill switch.
      Bind `AgentBrakeService` to `RUN_AGENT_BRAKE` in
      `packages/agent/src/agents/agents.module.ts`.
      Create `packages/agent/src/agents/__tests__/run-admission-agent-brake.spec.ts`:
      paused parks with `agent-paused`; active passes; **unbound port passes**; **a
      throwing port parks** (fail-closed); the middleware runs before the Work valve so a
      paused agent never consumes a concurrency count.
      **Done when**: green, and the existing `run-admission-chain.spec.ts` and
      `run-admission-chain.kill-switch.spec.ts` still pass unchanged.

- [ ] **T10. Held-run queries and the resume drain.**
      Modify `packages/agent/src/database/repositories/agent-run.repository.ts`: add
      `findOldestQueuedForAgent(agentId, queuedReason)` and
      `listQueuedForAgent(agentId, queuedReason, limit)`, both mirroring
      `findOldestQueuedForConcurrency` (line 1164) with `agentId` in place of `workId`.
      Modify `packages/agent/src/agents/run-dispatch-gate.service.ts`: add
      `promoteParkedForAgent(agentId, budget = AGENT_RESUME_PROMOTION_BUDGET)` reusing the
      claim-CAS-and-enqueue body of `drainForWork`, best-effort and never throwing.
      Create `packages/agent/src/database/repositories/agent-run.parked-for-agent.spec.ts`
      covering ordering, the reason predicate and cross-agent isolation.
      **Done when**: green, and `drainForWork`'s existing specs are untouched.

- [ ] **T11. Sweeper exemption.**
      Modify `packages/agent/src/agents/agent-run-sweeper.service.ts`: line ~141 passes
      `[QUEUED_REASON_KILL_SWITCH, QUEUED_REASON_AGENT_PAUSED]`, and the service-layer
      filter at line ~160 gains the same member. **Both halves are required** — the SQL
      predicate and the belt-and-braces service filter.
      Create
      `packages/agent/src/agents/__tests__/agent-run-sweeper.paused-exemption.spec.ts`
      asserting a run parked `agent-paused` survives a sweep at both layers.
      **Done when**: green.

### P1.c — API

- [ ] **T12. Pause and resume bodies.**
      Modify `apps/api/src/agents/dto/agent.dto.ts`: add `PauseAgentDto`
      (`note?` ≤ `AGENT_HALT_NOTE_MAX`, `stopInFlight?`).
      Modify `apps/api/src/agents/agents.controller.ts`:
      `POST :id/pause` accepts the optional body, secret-scans the note with the same
      helper the agent-file writes use, calls `AgentHaltService.halt(id, 'user', …)`, and
      returns `{ …agent, heldCount, inFlightCount }`. When `stopInFlight` is true it
      additionally requests the existing cooperative interrupt on each in-flight run.
      `POST :id/resume` calls `AgentHaltService.clear` then
      `promoteParkedForAgent`, returning `{ …agent, releasedCount }`.
      Extend the existing `AGENT_PAUSED` / `AGENT_RESUMED` activity details per plan §9.1.
      **Done when**: an empty pause body behaves byte-for-byte as today.

- [ ] **T13. Refuse dispatch to a paused agent.**
      Modify `apps/api/src/agents/agents.controller.ts`: - `assignTask` (line 1482) passes `agentId: id` into `this.dispatchGate.admit(...)`;
      no other change — a paused agent now returns the existing
      `{ runId, queued: true, queuedReason: 'agent-paused' }` shape. - `POST :id/run-now` throws a `409` named `AgentPausedError` **before** any run row
      is created when the agent is paused.
      Modify `apps/api/src/agents/sub-agent-delegation.runner.ts` (line ~136, which today
      refuses only `ARCHIVED`) to also refuse `PAUSED` with a named reason written to the
      parent's run log.
      **Done when**: no dispatch path reaches a paused agent, verified by T15.

- [ ] **T14. Identity, status-batch and held endpoints.**
      Create `apps/api/src/agents/dto/agent-identity.dto.ts` and
      `apps/api/src/agents/agent-identity.service.ts` (composes the resolver, the in-flight
      run, the open-decision count from the approvals and escalations repositories, the
      next heartbeat, and — in P1 — empty level and personality previews).
      Modify `apps/api/src/agents/agents.controller.ts` to add
      `GET :id/identity`, `GET /status?ids=`, `GET :id/held`.
      Add `findStatusRows(userId, ids, scope?)` to
      `packages/agent/src/database/repositories/agent.repository.ts` — **one** query, ids
      capped at `AGENT_STATUS_BATCH_MAX`, user- and scope-filtered.
      **`GET /status` is a static segment and MUST be declared before `@Get(':id')`.**
      **Done when**: 100 ids succeed in one query, 101 is a 400, and another user's ids are
      filtered out rather than 404-ing the batch.

- [ ] **T15. Controller and e2e API specs for P1.**
      Create `apps/api/src/agents/agents.controller.pause.spec.ts` and
      `apps/api/src/agents/agents.controller.status-batch.spec.ts`; extend
      `apps/api/src/agents/sub-agent-delegation.runner.spec.ts` and
      `apps/api/test/agents.e2e-spec.ts`.
      Cover: empty pause body unchanged; a 201-character note rejected; a second pause is a
      no-op preserving note/time/author and writing no second activity row; `run-now` 409s
      and creates no run row; `assign-task` returns `queuedReason: 'agent-paused'`; resume
      reports `releasedCount`; delegation to a paused child is refused; and the full
      pause → assign → resume → dispatched cycle against the real gate.
      **Done when**: `cd apps/api && pnpm test` is green.

### P1.d — Web

- [ ] **T16. Client, actions and the idle-behaviour fix.**
      Modify `apps/web/src/lib/api/agents.ts`: add `getIdentity`, `getStatuses`,
      `listHeld`; widen `pause(id, input?)`.
      **In the same change, correct `AgentIdleBehavior`** from
      `'propose' | 'sleep' | 'self-improve'` to `'propose' | 'noop' | 'observe'` to match
      the backend enum in `packages/agent/src/entities/agent.entity.ts`, and fix the
      `IDLE_LABEL` map in
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx` accordingly — the
      identity card renders idle behaviour and the current map returns `undefined` for two
      of the three real values.
      Modify `apps/web/src/app/actions/agents.ts`: add `getAgentIdentityAction`,
      `getAgentStatusesAction`, `listAgentHeldAction`; widen `pauseAgentAction`.
      **Done when**: `pnpm --filter web type-check` passes with no `any` added.

- [ ] **T17. The status polling hook.**
      Create `apps/web/src/lib/hooks/use-agent-status-polling.ts` as a structural copy of
      `apps/web/src/lib/hooks/use-kill-switch-polling.ts`: interval from
      `AGENT_STATUS_POLL_INTERVAL_MS` (imported, never redeclared), an `inFlight` ref
      guard, a server-rendered `initialState` seed, and **last-known-state on error**.
      Add what the kill-switch hook does not have: a `visibilitychange` listener that
      clears the interval when hidden and fires an immediate tick on return, and an
      id-array input producing **one** request.
      Create `apps/web/src/lib/hooks/use-agent-status-polling.unit.spec.tsx`.
      **Done when**: the visibility-pause, keep-last-state and batching cases pass.

- [ ] **T18. `AgentStatusDot`.**
      Create `apps/web/src/components/agents/AgentStatusDot.tsx` and
      `AgentStatusDot.unit.spec.tsx`; export from
      `apps/web/src/components/agents/index.ts`.
      One renderer for every status everywhere: dot, headline, sub-line and the reason's
      action link (`run` / `decision` / `connection`). A `compact` variant drops the
      sub-line but **never** the headline.
      **Done when**: there is one test per `AgentStatusReasonCode`, plus an assertion that
      no state renders colour without accompanying text.

- [ ] **T19. `AgentIdentityCard`, `AgentPauseDialog`, `AgentHeldWorkPanel`.**
      Create `apps/web/src/components/agents/AgentIdentityCard.tsx`,
      `AgentCompactIdentity.tsx`, `AgentPauseDialog.tsx`, `AgentHeldWorkPanel.tsx` and the
      unit specs named in plan §5.1; export all from the components barrel.
      The card is a server component for its first paint and wraps a client status region
      driven by T17. In P1 the **Level** and **Personality** rows render their empty
      states.
      Keyboard: `P` pauses/resumes, `Esc` cancels, `Cmd/Ctrl+Enter` confirms, focus lands
      in the note field.
      **Done when**: every state in spec §6.1–6.6 and §6.11 renders, and nothing renders
      `undefined`.

- [ ] **T20. Mount the card and the dot.**
      Modify `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`: replace the hero
      `<section>` with `<AgentIdentityCard/>` fed by `agentsAPI.getIdentity(id)`; keep the
      stat tiles, `AgentGuardrailsCard` and `AgentAttachmentsPanel` below it untouched. Add
      a defensive fallback to today's rendering when the identity read throws.
      Modify `apps/web/src/components/agents/AgentCard.tsx` to use
      `<AgentStatusDot compact/>` while **keeping** its `statusLabel`/`statusToneClass`
      maps exported.
      Modify `apps/web/src/components/agents/AgentsList.tsx` to mount
      `useAgentStatusPolling` once for the visible page and thread results down.
      **Done when**: no tab, no route and no i18n key is removed.

- [ ] **T21. i18n for P1.**
      Modify `apps/web/messages/en.json`: add `dashboard.agentsPage.identity`,
      `.status`, `.pause` and `.held` exactly as listed in plan §8.
      Every leaf name is camelCase and contains **no literal dot**.
      Then run the repo's locale sync so all 21 message files gain the full key
      paths — a missing **parent** key collapses the whole subtree.
      **Done when**: `pnpm --filter web test` shows no next-intl console error and the
      locale sync reports no missing paths.

- [ ] **T22. P1 end-to-end specs.**
      Create `apps/web/e2e/agent-identity-card.spec.ts` and
      `apps/web/e2e/agent-pause-brake.spec.ts`; extend
      `apps/web/e2e/agent-lifecycle-status.spec.ts` with an assertion that the status chip
      is now accompanied by its reason.
      `agent-pause-brake.spec.ts` walks: pause with a note → the card shows it → assign a
      task → the held panel shows one item → **Run now** is refused with the exact copy →
      Resume → the toast reports one released.
      Pin the status region with a stable test id rather than a role query.
      **Done when**: both specs pass locally and in CI.

> **P1 ships here.** `develop` is green, the brake is enforced, and every agent states why
> it is not working.

---

## Phase P2 — Levels

### P2.a — Contracts and data model

- [ ] **T23. Level contracts.**
      Create `packages/contracts/src/agents/level.types.ts`; export from
      `packages/contracts/src/agents/index.ts`.
      `AGENT_LEVELS`, `AgentLevelValue`, `AGENT_LEVEL_ORDER`,
      `AGENT_LEVEL_READINESS_WINDOW_DAYS = 30`, `AGENT_LEVEL_READINESS_MIN_RUNS = 20`,
      `AGENT_LEVEL_READINESS_MAX_REJECTED_APPROVALS = 0`,
      `AGENT_LEVEL_READINESS_MAX_ESCALATIONS = 1`, `LevelDiffEntry`, `LevelPreview`.
      **Done when**: no readiness threshold appears as a literal anywhere else in the repo.

- [ ] **T24. Level columns on `Agent`.**
      Modify `packages/agent/src/entities/agent.entity.ts`: add the `AgentLevel` enum and
      the `level`, `levelSetAt`, `levelSetByUserId` columns beside `title` per plan §3.1;
      export the enum from the entities and agents barrels.
      **Done when**: `pnpm --filter @ever-works/agent build` passes.

- [ ] **T25. Level migration.**
      Create `apps/api/src/migrations/1791230100000-AddAgentLevel.ts`, class
      `AddAgentLevel1791230100000`. Three guarded additive columns, camelCase names,
      portable `TableColumn` DDL, guarded `down()`.
      **No backfill** — every existing agent stays `NULL` ("Level not set", spec FR-35).
      **Done when**: run and revert both clean, and a post-migration query confirms zero
      agents were assigned a level.

### P2.b — Domain service

- [ ] **T26. `AgentLevelService`.**
      Create `packages/agent/src/agents/agent-level.ts` — pure and stateless:
      `defaultsFor(level)`, `diff(agent)`, `preview(agent, level)`,
      `readiness(agent, stats)`, plus `hashSettings(agent)` producing the `baseHash` used
      for stale-preview detection.
      The defaults table is the FR-38 table, field for field. `send_message` and
      `budget_override` must **never** appear in any level's `autoApproveActionTypes`.
      Create `packages/agent/src/agents/__tests__/agent-level.spec.ts` and
      `agent-level-readiness.spec.ts` covering the whole table, the empty diff on a
      matching agent, `reducesAutonomy` set only when a permission is lost, the exact
      readiness thresholds, `null` at Lead, and `null` one run short.
      **Done when**: green, and nothing in the runtime reads `agent.level`.

### P2.c — API

- [ ] **T27. Level endpoints.**
      Modify `apps/api/src/agents/dto/agent.dto.ts`: add `SetAgentLevelDto`; add `level`
      and the halt fields to `AgentDto`; **do not** add `level` to `UpdateAgentDto`.
      Modify `apps/api/src/agents/agents.controller.ts`: add `GET /levels` (static
      catalogue, **declared before `@Get(':id')`**), `GET :id/level`,
      `POST :id/level/preview`, `PUT :id/level`. `PUT` returns **409** with a fresh
      `LevelPreview` when `applyDefaults` is true and `baseHash` no longer matches.
      `PATCH :id` rejects a `level` field with a 400.
      Write the `AGENT_LEVEL_CHANGED` activity row per plan §9.1 — the enum member is
      appended to `packages/agent/src/entities/activity-log.types.ts` and needs **no
      migration** (`actionType` is a free `varchar(50)`).
      **Done when**: the level can only be written through `PUT :id/level`.

- [ ] **T28. Level controller spec.**
      Create `apps/api/src/agents/agents.controller.level.spec.ts` covering preview, apply,
      label-only, the stale-`baseHash` 409 carrying a fresh preview, `PATCH :id` rejecting
      `level`, and the activity write.
      Create `apps/api/src/agents/agents.controller.identity.spec.ts` covering the identity
      shape, cross-user 404, the composer-throws fallback, and **route ordering**
      (`GET /status` and `GET /levels` resolve before `GET /:id`).
      **Done when**: `cd apps/api && pnpm test` is green.

### P2.d — Web

- [ ] **T29. Level components.**
      Create `apps/web/src/components/agents/AgentLevelBadge.tsx`,
      `AgentLevelDialog.tsx`, `AgentLevelDriftList.tsx` and the unit specs from plan §5.1;
      export from the barrel.
      The dialog fetches `GET /api/agents/levels` **once per session** and caches it, shows
      a live preview, sorts removals first under **This takes autonomy away**, relabels its
      confirm button to **Apply and reduce autonomy**, replaces the change list with the
      label-only sentence when the defaults checkbox is cleared, and recovers from the 409
      by rendering the fresh preview.
      Keyboard: `L` opens it, `Tab` walks the four radios then the checkbox then the
      buttons, `Cmd/Ctrl+Enter` confirms.
      **Done when**: every state in spec §6.7–6.9 renders.

- [ ] **T30. Wire levels into the card and settings.**
      Modify `apps/web/src/components/agents/AgentIdentityCard.tsx` so the **Level** row
      shows the value, its one-sentence meaning, the drift count with **Show the
      differences**, and the readiness line when and only when the thresholds are met.
      Modify `apps/web/src/lib/api/agents.ts` and `apps/web/src/app/actions/agents.ts` for
      `getLevels`, `getLevel`, `previewLevel`, `setLevel`.
      Modify `apps/web/src/app/[locale]/(dashboard)/agents/[id]/settings/page.tsx` to add a
      **read-only** level row linking to the dialog. Settings must not become a second
      write path.
      **Done when**: the level is written from exactly one place in the UI.

- [ ] **T31. i18n for P2.**
      Modify `apps/web/messages/en.json`: add `dashboard.agentsPage.levels` exactly as
      listed in plan §8, including every `field*` label so the drift list never prints a
      raw property name. Run the locale sync.
      **Done when**: no next-intl console error and the locale sync is clean.

- [ ] **T32. P2 end-to-end spec.**
      Create `apps/web/e2e/agent-level.spec.ts`: set Specialist with defaults → the preview
      lists four changes → confirm → the card shows Specialist with no drift → clear a
      permission on the Capabilities tab → the drift line reads 1 → step down to Assistant
      → the heading and the confirm button relabel.
      **Done when**: green in CI.

> **P2 ships here.** Levels are visible, previewed, confirmed and reversible; nothing is
> promoted automatically.

---

## Phase P3 — Personality and the finished card

> **Requires AW-07.** T34 assumes `NOTES.md` is already in `AGENT_FILE_NAMES`, and T37–T38
> reuse AW-07's load meter, skipped-region marker and revision store.

### P3.a — Data model

- [ ] **T33. Personality columns.**
      Modify `packages/agent/src/entities/agent.entity.ts`: add `personalityMd` beside
      `agentYml` in the DB-only file block.
      Modify `packages/agent/src/entities/agent-run.entity.ts`: add
      `personalityHash: varchar(64) | null`.
      Add `AGENT_PERSONALITY_MAX_BYTES = 8 * 1024` and
      `AGENT_PERSONALITY_TOKEN_BUDGET = 600` to
      `packages/contracts/src/agents/identity.types.ts`.
      **Done when**: both packages build.

- [ ] **T34. Personality migration.**
      Create `apps/api/src/migrations/1791230200000-AddAgentPersonality.ts`, class
      `AddAgentPersonality1791230200000`: `agents.personalityMd text NULL` and
      `agent_runs.personalityHash varchar(64) NULL`, guarded, portable, with a guarded
      `down()` that re-reads each table between drops.
      **Done when**: run and revert both clean.

- [ ] **T35. `PERSONALITY.md` in the file family.**
      Modify `packages/agent/src/agents/agent-file.service.ts`:
      add `'PERSONALITY.md'` to the `AgentFileName` union (line 20) and **append** it to
      `AGENT_FILE_NAMES` (line 22) after `agent.yml`; add its cases to `readInline`
      (line 218) and the write mapper (line 235); append
      `+ 'YML/PERSONALITY' + merged.PERSONALITY` to the **end** of `hashOf` (line 262).
      Enforce `AGENT_PERSONALITY_MAX_BYTES` and run the same secret scan the other five
      files use on write.
      Create `packages/agent/src/agents/__tests__/agent-file.personality.spec.ts`,
      including **the ETag regression**: a write carrying a hash computed _before_ the name
      list changed still succeeds, because `contentHash` is stored and returned rather than
      recomputed on read.
      **Done when**: green, and `PUT /api/agents/:id/files/PERSONALITY.md` round-trips.

### P3.b — Prompt assembly

- [ ] **T36. The `personality` prompt segment.**
      Modify `packages/agent/src/agents/prompt-assembler.service.ts`:
      insert `'personality'` into `PROMPT_SEGMENTS` (line 27) **after `role` and before
      `capabilities`**; add `personality: 600` to `SEGMENT_TOKEN_CAPS` (line 46); emit it
      with `add('PERSONALITY (how you write)', 'personality', input.agent.personalityMd)`
      in the matching position (line ~197). It rides the existing untrusted-content fence
      and the existing `SEGMENT_FENCE_TOKEN_PATTERN` breaker.
      Stamp `personalityHash` onto the run at assembly time.
      Add `countInFlightWithOtherPersonality(agentId, hash)` to
      `packages/agent/src/database/repositories/agent-run.repository.ts`.
      Create
      `packages/agent/src/agents/__tests__/prompt-assembler.personality.spec.ts`: correct
      position; capped at 600; a forged fence token broken; an absent personality emits
      **nothing**, not an empty heading.
      **Done when**: green, and the existing prompt-assembler specs still pass.

### P3.c — Web and API finish

- [ ] **T37. Seven-pill instructions editor.**
      Modify `apps/web/src/components/agents/AgentInstructionsEditor.tsx` to render seven
      pills — Identity, Role, **Notes** (AW-07), **Personality**, Operating loop, Tools,
      Manifest — with the pill labels driven by i18n keys while the file names stay the
      canonical ones. The Personality pane adds: the permanent notice (spec FR-54, not
      dismissible), AW-07's load meter against the 600-token budget, the marked skipped
      region when over budget, the three starter examples for the empty state, and the
      "takes effect on the next run" save line that names in-flight runs when there are
      any.
      Modify `apps/web/src/app/[locale]/(dashboard)/agents/[id]/instructions/page.tsx` to
      fetch seven files.
      **Done when**: the editor degrades to six pills if AW-07's `NOTES.md` is absent,
      without an error.

- [ ] **T38. Personality on the card, and export/import.**
      Modify `apps/web/src/components/agents/AgentIdentityCard.tsx` so the **Notes** and
      **Personality** rows show their first two lines with **Edit** links.
      Modify `packages/agent/src/agents/agent-export.service.ts` so the envelope carries
      `level` and `PERSONALITY.md`; an import applies the level **label only** and never
      its defaults.
      **Done when**: an agent round-trips through export and import with its personality
      and level intact and its permissions unchanged.

- [ ] **T39. i18n for P3.**
      Modify `apps/web/messages/en.json`: add `dashboard.agentsPage.personality` and
      `dashboard.agentsPage.tabs.notes` exactly as listed in plan §8. Run the locale sync.
      **Done when**: no next-intl console error and the locale sync is clean.

- [ ] **T40. P3 end-to-end spec.**
      Create `apps/web/e2e/agent-personality.spec.ts`: write a personality → the save line
      says next run → the meter reads under budget → paste 9 KB → the size error → paste a
      key-shaped string → the secret refusal with the unsaved text preserved → start a run
      → edit the personality → the in-flight line appears.
      **Done when**: green in CI.

> **P3 ships here.** The card is complete and voice is a first-class, safely changeable
> thing.

---

## Cross-cutting closeout

- [ ] **T41. Telemetry.**
      Append `AGENT_LEVEL_CHANGED`, `AGENT_BLOCKED_ON_CREDENTIAL`, `AGENT_RUN_HELD` and
      `AGENT_RUNS_RELEASED` to `packages/agent/src/entities/activity-log.types.ts` (no
      migration — `actionType` is `varchar(50)`), and emit the run-log lines and the
      product-analytics events listed in plan §9.2–9.3 through the existing
      `packages/monitoring` surface. No payload may carry free text the user typed.
      **Done when**: every event in plan §9 has a call site and none carries a credential
      or a note body.

- [ ] **T42. Quality gate.**
      From the repo root: `pnpm lint`, `pnpm type-check`, `pnpm test`, then
      `cd apps/web && pnpm playwright test --grep "agent-(identity|pause|level|personality)"`.
      **Done when**: all green, with no new `eslint-disable` and no `any` introduced.

- [ ] **T43. Documentation.**
      Update `docs/specs/features/agent-workspace/TRACKER.md` (AW-23 spec → `Draft`, impl →
      the current state) and add a short section on the level ladder, the halt reasons and
      the brake to `docs/specs/architecture/agents-skills-tasks.md`. Note the new
      `personality` segment and its 600-token cap in
      `docs/specs/architecture/agent-prompt-assembly.md` so the segment table there does
      not drift.
      **Done when**: no stale segment count or file count remains in either architecture
      doc.

---

## Task-to-requirement map

| Tasks                        | Requirements covered                             |
| ---------------------------- | ------------------------------------------------ |
| T2, T3, T7, T8               | FR-16, FR-17, FR-31, FR-32, FR-33                |
| T4, T5, T9, T10, T11, T13    | FR-21 – FR-27, FR-30, NFR-2, NFR-3               |
| T6, T14, T17, T18            | FR-10 – FR-15, FR-18 – FR-20, NFR-8              |
| T12, T19, T20                | FR-1 – FR-9, FR-28, FR-29                        |
| T23 – T30                    | FR-34 – FR-48                                    |
| T33 – T38                    | FR-49 – FR-61, FR-63, FR-64                      |
| T37, T38                     | FR-62 (surfacing only; the file itself is AW-07) |
| T21, T31, T39                | Program rule #8 (i18n)                           |
| T15, T22, T28, T32, T40, T42 | Constitution VI                                  |
| T41                          | NFR-5, NFR-4                                     |
| T3, T25, T34                 | Constitution V                                   |
