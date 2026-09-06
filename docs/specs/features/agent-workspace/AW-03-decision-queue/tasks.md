# AW-03 — My Decisions · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries
> explicit file paths and a definition of done. Every task ships with its tests
> (Constitution VI). Work top to bottom; tasks marked `(parallel)` may run
> alongside the task immediately above them.

**Feature ID**: `aw-03-decision-queue`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- All paths are repo-relative to the monorepo root.
- Run everything with `pnpm` from the root unless a task says otherwise.
- Migrations are **authored** from `apps/api/`; nothing is run by hand on deploy —
  the API self-applies on boot.
- Adding an entity means editing **three** registries
  (`packages/agent/src/entities/index.ts`,
  `packages/agent/src/database/_entities-inventory.ts`,
  `packages/agent/src/database/_entity-names.ts`) — a drift spec fails otherwise.
- i18n leaf keys are camelCase and must **never** contain a literal `.`; a dot in a
  leaf key reds several e2e shards at once.
- Add new tasks at the bottom; never renumber.
- Commit style: `feat(decisions): …`, `test(decisions): …`, `chore(i18n): …`.

---

# PHASE 1 — The queue and the unblock

## P1.A — Constants and pure logic

- [ ] **T1. Create the decisions module's constants and value types.**
    - Create `packages/agent/src/decisions/constants.ts` exporting:
      `DECISION_MAX_ASKS = 10`, `DECISION_QUEUE_PAGE_SIZE = 25`,
      `DECISION_QUEUE_MAX_LIMIT = 100`, `DECISION_ARCHIVE_ALL_MAX = 200`,
      `DECISION_UNDO_WINDOW_MS = 10 * 60_000`,
      `DECISION_RATIONALE_MAX_CHARS = 1000`,
      `DECISION_UNSCORED_RANK = 0.5`,
      `DECISION_DORMANT_AFTER_DAYS = 30`,
      `DECISION_QUEUE_REFRESH_MS = 30_000`,
      `DEFAULT_DECISION_HEALTHY_MAX_PER_DAY = 5`,
      `DEFAULT_DECISION_QUIET_WINDOW_DAYS = 14`,
      `DECISION_REPEAT_THRESHOLD = 3`,
      `DECISION_REPEAT_WINDOW_DAYS = 14`.
    - Create `packages/agent/src/decisions/types.ts` with `DecisionSource`,
      `DecisionAskKind`, `DecisionAskStatus`, `DecisionStatus`, `DecisionDto`,
      `DecisionAskDto`, `DecisionResolutionOutcome`, `DecisionQueueFilter`, and the
      mappers `toDecisionAskDto` / `toDecisionDto` exactly as
      [`plan.md`](./plan.md) §4.1 specifies. No NestJS or TypeORM imports.
    - **Done when**: `pnpm --filter @ever-works/agent type-check` is clean and every
      exported constant carries a one-line comment saying which spec FR it encodes.

- [ ] **T2. Write the pure ask/answer rules.**
    - Create `packages/agent/src/decisions/decision-ask.ts` exporting:
        - `ASK_KIND_TO_QUESTION_KINDS: Record<DecisionAskKind, readonly HitlQuestionKind[]>`
          — the mapping table in [`plan.md`](./plan.md) §2.3.
        - `isQuestionKindAllowed(askKind, questionKind): boolean`
        - `requiresRationale(question: HitlQuestion, answer: HitlAnswer): boolean` —
          true for a rejected approval, a `confirm` answered `false`, and a `choice`
          whose `optionId !== question.defaultOptionId` when a default exists.
        - `validateRationale(value: string | null | undefined, required: boolean):
          { ok: true; value: string | null } | { ok: false; code: 'missing' | 'too-long' }`
        - `capAsks<T>(asks: readonly T[]): { kept: T[]; dropped: number }` — keeps
          the first `DECISION_MAX_ASKS`.
        - `composeAnswerMessage(asks: DecisionAskDto[]): string` — the single message
          delivered to the agent, one block per answered ask (`prompt`, the human-
          readable answer via `describeHitlQuestion` plus the answer value, and the
          rationale when present).
        - `rankDecisions(a, b)` — blocking desc, confidence desc with `null` treated
          as `DECISION_UNSCORED_RANK`, `createdAt` asc.
        - `isDormant(decision, now)` — open, no live linked work, older than
          `DECISION_DORMANT_AFTER_DAYS`.
      Pure functions only: no TypeORM, no NestJS, no repository.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-ask.spec.ts` —
      the full mapping table; `requiresRationale` at every branch including a choice
      with no default; the rationale validator at 0, 1, 1000 and 1001 characters;
      `capAsks` at 9, 10, 11 and 14; `composeAnswerMessage` ordering and its
      omission of unanswered asks; `rankDecisions` proving an unscored decision
      sorts above `0.4` and below `0.6`.
    - **Done when**: the spec covers every branch and passes.

## P1.B — Schema

- [ ] **T3. Add the `DecisionAsk` entity.**
    - Create `packages/agent/src/entities/decision-ask.entity.ts` with the columns,
      types, defaults and three indexes from [`plan.md`](./plan.md) §3.1. Use
      `PortableDateColumn` from `packages/agent/src/entities/_types.ts` for every
      date. `decisionId` is a raw `uuid` column with **no** `@ManyToOne` — document
      why (polymorphic + the entities-cycle rule) in the class docstring, mirroring
      `agent-action-proposal.entity.ts`.
    - **Done when**: the file builds and every column has a doc comment naming its
      writer.

- [ ] **T4. Add the additive columns to the two backing entities.**
    - Modify `packages/agent/src/entities/agent-escalation.entity.ts`: add
      `missionId`, `archivedAt`, `archivedByUserId`, `archivedReason`,
      `firstViewedAt`; add `@Index('idx_agent_escalation_mission_status',
      ['missionId', 'status'])`.
    - Modify `packages/agent/src/entities/agent-action-proposal.entity.ts`: the same
      five columns; add `@Index('idx_agent_action_proposals_mission_status',
      ['missionId', 'status'])`; append `'archived'` to
      `AgentActionProposalStatus` and to `AGENT_ACTION_PROPOSAL_STATUSES`.
    - Modify `packages/contracts/src/agents/escalation.types.ts`: append
      `'archived'` to `AgentEscalationStatus` and to `AGENT_ESCALATION_STATUSES`;
      update the type's docstring, which currently says an escalation has "exactly
      two states".
    - **Done when**: `pnpm --filter @ever-works/contracts build` and
      `pnpm --filter @ever-works/agent build` are clean, and no existing read path
      that filters `status='open'` needed a change.

- [ ] **T5. Register the new entity in all three registries.**
    - `packages/agent/src/entities/index.ts` — `export * from './decision-ask.entity';`
    - `packages/agent/src/database/_entities-inventory.ts` — concrete import (never
      the barrel) + add `DecisionAsk` to `ENTITIES`.
    - `packages/agent/src/database/_entity-names.ts` — add `'DecisionAsk'` in
      alphabetical position.
    - **Test**: `packages/agent/src/database/database.module.spec.ts` and
      `database.config.spec.ts` must pass unchanged — they assert the three lists do
      not drift.
    - **Done when**: `cd packages/agent && npx jest --testPathPattern='database'`
      is green.

- [ ] **T6. Author the P1 migration.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateDecisionAsks`
    - Land it at `apps/api/src/migrations/<timestamp>-CreateDecisionAsks.ts` and
      hand-edit it to add, after the generated DDL:
        1. `UPDATE agent_escalations SET "missionId" = t."missionId" FROM tasks t WHERE t.id = agent_escalations."taskId" AND agent_escalations."taskId" IS NOT NULL`
        2. the equivalent two-hop backfill for `agent_action_proposals` via
           `agent_runs.taskId`
        3. a **chunked** (500 rows) insert of one derived `decision_asks` row per
           currently-open escalation and pending proposal, using the same derivation
           rules T8 implements.
    - Hand-check: 1 `CREATE TABLE`, 3 `CREATE INDEX` on it, 5 `ADD COLUMN` × 2
      tables, 2 `CREATE INDEX`. **No** `DROP`, no `ALTER … TYPE`, no `NOT NULL`
      without a default. `down` drops only what `up` added, in reverse.
    - **Done when**: `pnpm typeorm migration:run -d typeorm.config.ts` applies on a
      fresh database *and* on a seeded one, a re-generate produces an empty diff,
      and the backfill leaves zero open decisions with zero asks.

## P1.C — Repository and domain services

- [ ] **T7. Add `DecisionAskRepository`.**
    - Create `packages/agent/src/database/repositories/decision-ask.repository.ts`
      with `listForDecision`, `listForDecisions` (batched, for the queue read),
      `countsByDecision` (grouped `required`/`answered`), `findOwned`,
      `insertMany` (idempotent on `dedupKey`), `answer` (CAS on `status='open'`),
      `withdraw` (CAS on `status='answered'`), `supersedeOpen`. Every method takes
      `userId` and composes `ownershipWhere` from
      `packages/agent/src/database/ownership-scope.ts`.
    - **Test**: `packages/agent/src/database/repositories/decision-ask.repository.scope.spec.ts`
      — modelled on `agent-escalation.repository.scope.spec.ts`; assert every public
      method applies the owner filter and that a foreign id reads as absent.
    - **Done when**: the scope spec passes and no method can be called without a
      `userId`.

- [ ] **T8. Add the ask materialiser.**
    - Create `packages/agent/src/decisions/decision-ask-materialiser.ts` exporting
      `deriveAsksForEscalation(row)` and `deriveAsksForProposal(row)`:
        - escalation, reason code in
          `budget-stop | guardrail-refusal | merge-refused` →
          one `kind: 'approval'` ask with `question.kind = 'approval'`,
          `prompt` = `decisionNeeded` (capped 1000), `action` = `summary`;
        - every other reason code → one `kind: 'decision'` ask with
          `question.kind = 'text'`, `prompt` = `decisionNeeded`,
          `context` = `summary`; falls back to `"A decision is needed."` when
          `decisionNeeded` is empty or unparseable;
        - proposal → one `kind: 'approval'` ask with `question.kind = 'approval'`,
          `prompt` / `action` = `title`, `risks` = `riskFlags`.
      Each derived ask gets `dedupKey = \`${decisionType}:${decisionId}:derived\``.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-ask-materialiser.spec.ts`
      — one case per reason code and per action type, plus the empty/garbage
      `decisionNeeded` fallback.
    - **Done when**: every one of the ten reason codes and five action types has a
      case.

- [ ] **T9. Write asks at record-creation time.**
    - Modify `packages/agent/src/agents/agent-escalation.service.ts`: after a
      successful `repository.record(...)`, derive and insert the ask(s) through an
      `@Optional()`-injected `DecisionAskService`, and resolve + stamp `missionId`
      from the Task when `taskId` is set. Best-effort like the existing Inbox
      mirror — a failure warns and never fails the escalation.
    - Modify `packages/agent/src/agent-approvals/agent-approvals.service.ts`:
      the same, after `createProposal`, resolving `missionId` through
      `runId → agent_runs.taskId → tasks.missionId`.
    - **Test**: extend `packages/agent/src/agents/__tests__/agent-escalation.service.spec.ts`
      and `packages/agent/src/agent-approvals/__tests__/` — a recorded escalation
      and a created proposal each produce exactly one ask; a duplicate `dedupKey`
      produces no second ask; an ask-write failure leaves the record intact.
    - **Done when**: both suites pass and neither service gained a required
      constructor argument (positional-arity rule).

- [ ] **T10. Add `DecisionQueueService`.**
    - Create `packages/agent/src/decisions/decision-queue.service.ts` with
      `list(userId, filter, scope)` and `getOne(userId, decisionId, scope)`.
      `list` runs exactly the four queries in [`plan.md`](./plan.md) §2.1: the two
      record scans, the grouped ask counts, and one grouped blocking-signal query
      over `agent_runs.awaitingInput` + `tasks.status = 'blocked'`. It then maps
      through `toDecisionDto` and sorts with `rankDecisions`. `limit` is clamped to
      `DECISION_QUEUE_MAX_LIMIT`.
    - `getOne` stamps `firstViewedAt` on the backing record the first time a human
      reads it, and writes a `DECISION_VIEWED` activity entry.
    - Add `parseDecisionId(value): { source, id } | null` in `decision-ask.ts`,
      accepting only `escalation:<uuid>` and `approval:<uuid>`.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-queue.service.spec.ts`
      — the ranking truth table; archived and resolved excluded from `open`; limit
      clamping at 0, 1, 100, 101; `parseDecisionId` rejecting `garbage`,
      `escalation:not-a-uuid`, `unknown:<uuid>` and an empty string; the
      `firstViewedAt` stamp firing once and only once.
    - **Done when**: the queue read issues four queries for a 25-row page (assert
      the call count on the mocked repositories).

- [ ] **T11. Add `DecisionResolutionService` — the heart of the epic.**
    - Create `packages/agent/src/decisions/decision-resolution.service.ts` with
      `answerAsk({ userId, decisionId, askId, answer, rationale, scope })` and
      `resolve({ userId, decisionId, source, note, scope })`.
    - `answerAsk`: validate the answer against the ask's question with
      `validateHitlAnswer`; apply `requiresRationale` + `validateRationale`;
      CAS-write the answer; then, if no *required* ask remains open, call
      `resolve`.
    - `resolve` performs, in order, exactly the six steps in
      [`plan.md`](./plan.md) §2.2, and returns `DecisionResolutionOutcome`.
      Delivery precedence: `RunSteeringService.isLive(run)` → `steer`;
      `isResumable(run) && run.taskId` → `resume`; otherwise
      `delivery: 'none'` with a machine reason. A thrown `resume` is caught and
      reported as `delivery: 'failed'` — **it must never roll back the answer**.
      Task unblocking goes through `TaskTransitionService.recheckUnblockFor`.
    - Every collaborator except `DecisionAskRepository` is `@Optional()` and
      appended last, per this package's positional-arity convention.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-resolution.service.spec.ts`
      — the delivery matrix (live/parked/neither/throwing); resolution gated on the
      last *required* ask while an optional ask stays open; an invalid answer shape
      rejected without a write; a missing required rationale rejected without a
      write; a second answer to the same ask returning a conflict with the recorded
      answer and author; `taskUnblocked: false` with `remainingBlockers: 1`; and an
      explicit case proving a `resume` throw leaves the answer and the closed
      decision in place.
    - **Done when**: every row of the matrix has a test and the suite passes.

- [ ] **T12. Point the four pre-existing resolution doors at the new service.**
    - Modify `packages/agent/src/inbox/inbox.service.ts`: replace the
      `routeEscalationReply` + `tryResumeLinkedRun` pair and the
      `routeApprovalReply` call with `DecisionResolutionService.resolve(...)`,
      injected `@Optional()`. Keep the existing claim/CAS/reopen-on-throw structure
      byte for byte.
    - Modify `packages/agent/src/agents/agent-escalation.service.ts` `resolve()` and
      `packages/agent/src/agent-approvals/agent-approvals.service.ts` `decide()` /
      `approveAll()` so that a resolution reached through them also supersedes any
      remaining open asks and runs the same delivery — through the same service,
      not a copy.
    - **Test**: extend `packages/agent/src/inbox/__tests__/` — an Inbox escalation
      reply still resolves and still resumes, and now also supersedes remaining
      asks. Add cases to the escalation and approval service specs for the
      supersede-plus-deliver behaviour.
    - **Done when**: there is exactly **one** implementation of "close the record,
      deliver the answer, unblock the Task" in the repository — grep for
      `tryResumeLinkedRun` returns nothing.

- [ ] **T13. Wire the agent-side module.**
    - Create `packages/agent/src/decisions/decisions.module.ts` registering
      `TypeOrmModule.forFeature([DecisionAsk, AgentEscalation, AgentActionProposal,
      AgentRun, Task])`, providing and exporting `DecisionAskRepository`,
      `DecisionAskService`, `DecisionQueueService`, `DecisionResolutionService`.
    - Create `packages/agent/src/decisions/index.ts` re-exporting the module,
      services, constants, types and pure helpers.
    - Add `"./decisions"` to the `exports` map in
      `packages/agent/package.json`, following the shape of the existing
      `"./agent-approvals"` entry.
    - **Done when**: `import { DecisionQueueService } from '@ever-works/agent/decisions'`
      resolves from `apps/api` after `pnpm build`.

## P1.D — API

- [ ] **T14. Add the decisions controller and DTOs.**
    - Create `apps/api/src/decisions/dto/decisions.dto.ts` with
      `ListDecisionsQueryDto` (`status`, `agentId`, `missionId`, `kind`, `q`,
      `limit` `@Min(1) @Max(100)`, `offset` `@Min(0)`) and
      `AnswerAskBodyDto` (`answer` validated as an object,
      `rationale?` `@MaxLength(1000)`), all `class-validator`-decorated.
    - Create `apps/api/src/decisions/decision-id.pipe.ts` — a `PipeTransform`
      rejecting anything that is not `escalation:<uuid>` / `approval:<uuid>` with a
      `BadRequestException`.
    - Create `apps/api/src/decisions/decisions.controller.ts` with the three P1
      routes from [`plan.md`](./plan.md) §4.1, `@ApiTags('decisions')`,
      `@Throttle` 60/min on reads and 30/min on the write, `@CurrentUser()` plus the
      optional `ScopeContextService` from `apps/api/src/scope/`, and 404-never-403
      for a foreign id.
    - Create `apps/api/src/decisions/decisions.module.ts` importing the agent-side
      `DecisionsModule`; register it in `apps/api/src/api.module.ts` beside
      `AgentApprovalsModule` (imported at line 53, listed at 195).
    - **Test**: `apps/api/src/decisions/decisions.controller.spec.ts` — the pipe
      rejecting three malformed ids; limit clamping; 404 for a foreign id; 409 on a
      double answer; the resolution outcome surfacing on the response.
    - **Done when**: `cd apps/api && pnpm test` is green and the routes appear in
      the OpenAPI document.

- [ ] **T15. Backfill controller specs for the two controllers that have none.**
    - Create `apps/api/src/escalations/escalations.controller.spec.ts` — list, get,
      resolve; owner scoping; the new supersede-plus-deliver behaviour on resolve.
    - Create `apps/api/src/agent-approvals/agent-approvals.controller.spec.ts` —
      approve, reject, approve-all; 409 on re-decide; the new
      supersede-plus-deliver behaviour.
    - **Done when**: both files exist, pass, and cover every route on their
      controller.

## P1.E — Web

- [ ] **T16. Add the route constants and the sidebar entry.**
    - Modify `apps/web/src/lib/constants.ts`: add to `ROUTES` (near
      `DASHBOARD_INBOX` at line 115) `DASHBOARD_DECISIONS: '/decisions'` and
      `DASHBOARD_DECISION: (id: string) => \`/decisions?id=${id}\``, with a comment
      explaining the composite id form.
    - Modify `apps/web/src/components/dashboard/DashboardSidebar.tsx`: one nav entry
      between `Dashboard` and `Inbox`, label key
      `dashboard.sidebar.navigation.decisions`, with an open-count badge fed the way
      the Inbox unread badge is.
    - **Done when**: the entry renders, is highlighted on `/decisions`, and shows no
      badge when the count is zero.

- [ ] **T17. Add the web API client and shared types.**
    - Create `apps/web/src/lib/api/decisions.shared.ts` — the pure `DecisionDto` /
      `DecisionAskDto` / `DecisionResolutionOutcome` mirrors plus
      `bandFor(snapshot)`, `progressLabel(answered, required)` and
      `confidenceLabel(value)`.
    - Create `apps/web/src/lib/api/decisions.ts` — `server-only`, `serverFetch` /
      `serverMutation` from `apps/web/src/lib/api/server-api.ts`, forwarding scope
      selectors through `apps/web/src/lib/api/bff-scope.ts` the way the sibling
      clients do. Mirror the DTO by hand and say so in a header comment, exactly as
      `apps/web/src/lib/api/agent-approvals.ts` does.
    - **Test**: `apps/web/src/lib/api/decisions.shared.unit.spec.ts` — the three
      helpers at their boundaries.
    - **Done when**: no runtime import of `@ever-works/agent` appears in either file.

- [ ] **T18. Add the server actions.**
    - Create `apps/web/src/app/actions/dashboard/decisions.ts` with
      `listDecisionsAction`, `getDecisionAction`, `answerAskAction`. Copy the
      `requireAuth` → `redirect(ROUTES.AUTH_LOGIN)` guard from
      `apps/web/src/app/actions/dashboard/agent-approvals.ts`, and revalidate both
      `'/[locale]/(dashboard)/decisions'` and `'/[locale]/(dashboard)/(home)'` after
      every write.
    - **Done when**: an unauthenticated call redirects before any request is issued.

- [ ] **T19. Build the queue shell.**
    - Create `apps/web/src/app/[locale]/(dashboard)/decisions/page.tsx` (RSC) and
      `decisions-client.tsx`, per [`plan.md`](./plan.md) §5.1. A failed **list**
      read must be handed to the client as an error, never as an empty array.
    - Create, under `apps/web/src/components/decisions/`: `DecisionsClient.tsx`,
      `DecisionQueueList.tsx`, `DecisionCard.tsx`, `DecisionDetail.tsx`,
      `DecisionAskList.tsx`, `DecisionAskItem.tsx`, `DecisionEmptyState.tsx`,
      `DecisionErrorState.tsx`, `DecisionKeyboardSheet.tsx`, `index.ts`.
    - Implement the two-pane layout, the counts, the tabs, the filters with URL
      sync, paging at 25, the position walker, the 30-second counts-only refresh
      gated on `document.visibilityState`, and the stacked layout below 768 px —
      all as drawn in [`spec.md`](./spec.md) §6.2, §6.6–§6.9 and §6.15.
    - **Done when**: every state in the spec's §6 renders from a story or a fixture,
      and the header never shows `0` while loading.

- [ ] **T20. Build the five ask controls.**
    - Create `apps/web/src/components/decisions/asks/AskChoice.tsx`,
      `AskMultiChoice.tsx`, `AskApproval.tsx`, `AskFact.tsx`, `AskAccess.tsx`,
      `AskAction.tsx`, plus `apps/web/src/components/decisions/AskRationaleField.tsx`.
    - Each is a labelled form control whose accessible name is the ask prompt; the
      rationale field is `aria-describedby`-linked to the control that made it
      required; submission announces its outcome through a polite live region owned
      by `DecisionsClient`.
    - **Test**: `apps/web/src/components/decisions/DecisionAskItem.unit.spec.tsx`
      and `asks/AskChoice.unit.spec.tsx` — the required-rationale gate, the
      recommended badge, the disabled submit while a required rationale is empty.
    - **Done when**: all five kinds render, validate client-side, and are operable
      by keyboard alone.

- [ ] **T21. Add the entry points on the surfaces that already exist.**
    - Modify `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx`:
      a footer link under the existing `ApprovalsQueue` block using
      `dashboard.approvals.seeAll`. **Do not modify `ApprovalsQueue.tsx` itself.**
    - Modify `apps/web/src/components/inbox/InboxClient.tsx`: an **Open in My
      Decisions** link on `escalation` and `approval` items.
    - Add the same link to the Task-detail escalation feed.
    - **Done when**: all three links carry the composite decision id and land on a
      pre-selected decision.

## P1.F — i18n, tests, docs

- [ ] **T22. Add the `dashboard.decisions` namespace.**
    - Add the full key tree from [`plan.md`](./plan.md) §8 to
      `apps/web/messages/en.json`, plus
      `dashboard.sidebar.navigation.decisions`, `dashboard.approvals.seeAll` and
      `metadata.pages.decisions`.
    - Mirror the **structure** into the 20 sibling locale files in
      `apps/web/messages/` (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl,
      pt, ru, th, tr, uk, vi, zh`). English values are acceptable placeholders.
    - **Verify**: no leaf key contains a literal `.`; every leaf name is camelCase;
      all 21 files have identical key sets.
    - **Done when**: a structural diff across the 21 files is empty and the
      hydration e2e spec is green.

- [ ] **T23. Add the P1 end-to-end specs.**
    - Create `apps/web/e2e/flow-decisions-queue.spec.ts` — both record types in one
      ranked list; the tabs; filters reflected in the URL; paging; the position
      walker; both empty states; the error state; a foreign id rendering not-found.
    - Create `apps/web/e2e/flow-decisions-typed-asks.spec.ts` — all five controls;
      the required reason on reject and on a non-recommended choice; a malformed
      answer refused.
    - Create `apps/web/e2e/flow-decisions-auto-unblock.spec.ts` — answering the last
      ask closes the decision, restarts the parked Run, unblocks the Task, and
      renders each of the five resolution lines from [`spec.md`](./spec.md) §6.5.
    - Create `apps/web/e2e/flow-decisions-validation-authz-matrix.spec.ts` — 404 for
      foreign ids (never 403); throttle responses; the double-answer conflict.
    - **Done when**: all four pass locally and in CI.

- [ ] **T24. P1 documentation.**
    - Add a short user-facing page under `docs/features/` describing My Decisions
      and the five kinds of ask, and list it in `apps/docs/sidebarsPlatform.ts` so
      it is not an orphan page.
    - Update the AW-03 row in
      `docs/specs/features/agent-workspace/TRACKER.md` to `P1 shipped`.
    - **Done when**: the docs site builds and the tracker names the shipped phase.

---

# PHASE 2 — Typed asks, undo, archive

## P2.A — The two new question kinds

- [ ] **T25. Extend the typed-question union.**
    - Modify `packages/contracts/src/hitl/hitl-question.types.ts`: append
      `'access'` and `'action'` to `HitlQuestionKind` and `HITL_QUESTION_KINDS`; add
      `HitlAccessQuestion` / `HitlAccessAnswer` and `HitlActionQuestion` /
      `HitlActionAnswer` exactly as [`plan.md`](./plan.md) §2.3 specifies; add their
      branches to `parseHitlQuestion`, `parseHitlAnswer`, `validateHitlAnswer` and
      `describeHitlQuestion`. Keep the parsers tolerant of unknown extra keys and
      strict on the fields they read.
    - **Test**: `packages/contracts/src/__tests__/hitl-question.access-action.spec.ts`
      — round-trip both kinds; reject an `access` question with an empty
      `capability`; reject an `access` answer against an `action` question; confirm
      an unknown kind still returns `null`.
    - **Done when**: `pnpm --filter @ever-works/contracts test` is green and no
      existing consumer needed a change.

## P2.B — Agent-side authoring

- [ ] **T26. Add `DecisionAskService.fileDecision`.**
    - Create `packages/agent/src/decisions/decision-ask.service.ts` (if T9 created a
      thin version, extend it) with `fileDecision({ userId, source, sourceId,
      asks })`: validates each ask's kind↔question pairing, applies `capAsks`,
      records the dropped count on the backing record, rejects an `access` question
      with an empty `capability`, and rejects any `connectionHint` matching the
      existing secret-scan patterns (Constitution VII).
    - **Test**: extend `packages/agent/src/decisions/__tests__/decision-ask.spec.ts`
      — 14 asks keep 10 and report 4; an illegal kind pairing is rejected; a
      secret-shaped hint is rejected.
    - **Done when**: the over-limit note is readable from the decision DTO.

- [ ] **T27. Add the agent chat tools.**
    - Create `packages/agent/src/decisions/decision-tools.ts` exporting
      `buildDecisionTools({ userId, service })` with `open_decision` (file a
      decision with 1–10 typed asks) and `list_my_decisions`. Type-only imports, in
      the shape of `packages/agent/src/agents/agent-escalation-tools.ts`.
    - Register it in `packages/agent/src/agents/agent-domain-tool-sources.ts`
      alongside `buildEscalationTools`, with the keyword slots listed in
      [`plan.md`](./plan.md) §7.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-tools.spec.ts` —
      the tools are owner-scoped (`userId` never comes from the model), an
      over-limit call reports the dropped count, and a malformed argument returns an
      error object rather than throwing.
    - **Done when**: the tools appear in an assembled tool set for an agent with
      the relevant keywords.

- [ ] **T28. Add access verification.**
    - In `DecisionResolutionService`, when an `access` ask is answered and its
      question carries a `toolPattern`, call the existing tool-grant check
      (`GET /api/tool-grants/check` behind the api-side service) before accepting
      the answer; on a denial, refuse the write and return the
      `access.stillDenied` code. With no `toolPattern`, or when the check is
      unavailable, accept and record `verified: false`.
    - **Test**: extend the resolution spec — denied, granted, no-pattern and
      check-unavailable.
    - **Done when**: the refusal path leaves the ask open and writes nothing.

## P2.C — Undo

- [ ] **T29. Add `DecisionUndoService`.**
    - Create `packages/agent/src/decisions/decision-undo.service.ts` with
      `undo({ userId, decisionId, askId, note, scope })`:
        - refuse when `Date.now() - answeredAt >= DECISION_UNDO_WINDOW_MS`
          (code `window`);
        - refuse when `resumedRunId` names a run whose status is no longer `queued`
          (code `acted`);
        - otherwise: CAS the ask to `withdrawn` keeping the previous answer, reopen
          the backing record, cancel a still-queued resumed run through the existing
          run canceller, compose the withdrawal note and deliver it — injected into
          a live run when one exists, otherwise recorded on the decision and posted
          to the Task's thread.
    - Add `canUndo(ask, run, now): { ok: true } | { ok: false; code: 'window' | 'acted' }`
      to `decision-ask.ts` as a pure function so the UI and the service share one
      rule.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-undo.service.spec.ts`
      — the two guards at 9 min 59 s and 10 min 01 s and at run status
      `queued`/`running`; the withdrawn answer retained; the reopened decision; the
      cancelled run.
    - **Done when**: both refusal codes are distinguishable by the caller.

## P2.D — Archive

- [ ] **T30. Add `DecisionArchiveService`.**
    - Create `packages/agent/src/decisions/decision-archive.service.ts` with
      `archive`, `restore` and `archiveAll`. `archiveAll` orders oldest-first, caps
      at `DECISION_ARCHIVE_ALL_MAX`, skips rows that are no longer open and reports
      `{ archived, skipped }` — mirroring `AgentApprovalsService.approveAll`'s
      existing skip-and-report semantics. Archiving never resolves, decides or
      delivers anything.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-archive.service.spec.ts`
      — the 200 cap over 412 candidates; the skip count; restore returning asks to
      their prior state; an explicit assertion that no delivery was attempted.
    - **Done when**: the suite passes and `archiveAll` issues one bulk update, not
      one per row.

- [ ] **T31. Add the P2 endpoints.**
    - Extend `apps/api/src/decisions/decisions.controller.ts` with
      `POST …/asks/:askId/undo`, `POST …/archive`, `POST …/restore` and
      `POST /api/decisions/archive-all` (throttled **5/min**), plus their DTOs in
      `apps/api/src/decisions/dto/decisions.dto.ts`.
    - **Test**: extend `apps/api/src/decisions/decisions.controller.spec.ts` — the
      archive-all cap and skip counts; both undo refusal codes; 409 when answering
      an archived decision.
    - **Done when**: `cd apps/api && pnpm test` is green.

## P2.E — The sweeper

- [ ] **T32. Add `DecisionSweeperService` and its job.**
    - Create `packages/agent/src/decisions/decision-sweeper.service.ts` with
      `sweep()`: find open decisions whose linked Run is `cancelled` and whose Task
      no longer exists, archive them with `archivedReason='source-gone'`, capped at
      500 rows per tick.
    - Create `packages/tasks/src/tasks/trigger/decision-queue-sweeper.task.ts` as a
      `schedules.task({ id: 'decision-queue-sweeper', cron: '*/30 * * * *', run })`
      booting a `NestApplicationContext(TriggerInternalModule)` and delegating to
      the service — the shape
      `packages/tasks/src/tasks/trigger/agent-run-sweeper.task.ts` uses. Export it
      from `packages/tasks/src/tasks/trigger/index.ts`.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-sweeper.spec.ts` —
      an orphan is archived, a decision with a live Task is not, and the 500 cap
      holds.
    - **Done when**: no file under `packages/agent/src/decisions/` imports a job
      SDK (Constitution IV).

## P2.F — Web and tests

- [ ] **T33. Build the undo and archive UI.**
    - Create `apps/web/src/components/decisions/DecisionUndoMenu.tsx` (the `⋯` menu
      with both disabled-undo explanations, driven by the shared `canUndo` rule) and
      `DecisionArchiveAllDialog.tsx` (the confirmation naming the count, the filter
      and the over-cap sentence), matching [`spec.md`](./spec.md) §6.4 and §6.11.
    - Add the **Archived** tab list with per-row **Restore** (§6.12).
    - Extend `apps/web/src/app/actions/dashboard/decisions.ts` with
      `undoAskAction`, `archiveDecisionAction`, `restoreDecisionAction`,
      `archiveAllDecisionsAction`.
    - **Done when**: both disabled-undo variants render their exact copy and the
      archive dialog cannot be confirmed without a count.

- [ ] **T34. Add the P2 end-to-end specs.**
    - Create `apps/web/e2e/flow-decisions-undo-withdrawal.spec.ts` and
      `apps/web/e2e/flow-decisions-archive-all.spec.ts` covering
      [`spec.md`](./spec.md) S6, S7, E6, E7, E14 and E18.
    - **Done when**: both pass locally and in CI.

- [ ] **T35. P2 i18n and documentation.**
    - Add the `undo`, `archive`, `access` and `overLimit` sub-trees to
      `apps/web/messages/en.json` if T22 stubbed them, and mirror across the 20
      sibling locales.
    - Update the user-facing doc page with the undo rules and the archive
      behaviour; update `TRACKER.md` to `P2 shipped`.
    - **Done when**: the structural diff across the 21 message files is empty.

---

# PHASE 3 — The health signal

- [ ] **T36. Add the snapshot entity and the band overrides.**
    - Create `packages/agent/src/entities/decision-health-snapshot.entity.ts` per
      [`plan.md`](./plan.md) §3.4, with `uq_decision_health_day` unique on
      `(userId, day)` and `idx_decision_health_user_day`.
    - Modify `packages/agent/src/entities/work-agent-preference.entity.ts`: add
      `decisionHealthyMaxPerDay` and `decisionQuietWindowDays`, both
      `@Column({ type: 'int', nullable: true })`, documented as
      "NULL = inherit the platform default; clamped at the service layer",
      mirroring the neighbouring `missionDefaultOutstandingCap` comment.
    - Register the new entity in all three registries (see T5).
    - **Done when**: the database drift specs pass.

- [ ] **T37. Author the P3 migration.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateDecisionHealthSnapshots`
    - Hand-check: 1 `CREATE TABLE`, 2 `CREATE INDEX`, 2 `ADD COLUMN` on
      `work_agent_preferences`. No drop, no type change. `down` reverses exactly.
    - **Done when**: it applies on a fresh and a seeded database and a re-generate
      is empty.

- [ ] **T38. Add `DecisionHealthService`.**
    - Create `packages/agent/src/decisions/decision-health.service.ts` with
      `snapshotFor(userId, day)`, `currentBand(userId)` and `tickAll(cursor)`.
      Bands exactly as [`spec.md`](./spec.md) FR-52; overrides clamped to 1–100 and
      3–90; `tickAll` capped at 2000 users per tick with a cursor and idempotent on
      `(userId, day)`.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-health.spec.ts` —
      every boundary (0-in-14-days, 1, 5, 6, 15, 16 per day, and 26 open), the
      clamps at 0/1/100/101 and 2/3/90/91, and running the tick twice for the same
      day producing one row.
    - **Done when**: every band boundary has a case.

- [ ] **T39. Add the repeat detector.**
    - Create `packages/agent/src/decisions/decision-repeat.ts` with
      `fingerprint(decision)` (raising agent + reason or action type + a normalised
      prompt fingerprint) and `clusterRepeats(decisions, now)` returning
      `Map<fingerprint, count>` over the trailing `DECISION_REPEAT_WINDOW_DAYS`,
      with `DECISION_REPEAT_THRESHOLD` as the reporting floor.
    - **Test**: `packages/agent/src/decisions/__tests__/decision-repeat.spec.ts` —
      2 occurrences report nothing, 3 report a cluster, a 15-day-old occurrence
      falls out of the window, and clustering changes no decision's state.
    - **Done when**: the detector is provably advisory-only (assert no write).

- [ ] **T40. Add the daily tick job.**
    - Create `packages/tasks/src/tasks/trigger/decision-health-tick.task.ts` —
      `schedules.task({ id: 'decision-health-tick', cron: '20 7 * * *', run })`,
      same shape as `digest-dispatcher.task.ts`; export it from
      `packages/tasks/src/tasks/trigger/index.ts`.
    - Add one line to the existing digest body in
      `packages/tasks/src/tasks/trigger/digest-dispatcher.task.ts` (or the digest
      service it calls) reading "N decisions waiting". **No new cron for the
      digest.**
    - **Done when**: the task registers and a failed health tick cannot take the
      digest down.

- [ ] **T41. Add the P3 endpoints.**
    - Extend `apps/api/src/decisions/decisions.controller.ts` with
      `GET /api/decisions/health` (204 when no snapshot exists) and
      `PATCH /api/decisions/health/band` (both fields optional, clamped).
    - **Test**: extend the controller spec — the 204 path and both clamps.
    - **Done when**: `cd apps/api && pnpm test` is green.

- [ ] **T42. Build the health banner and the repeat chip.**
    - Create `apps/web/src/components/decisions/DecisionHealthBanner.tsx` with the
      four bands, the top-agent link, and the `⋯` menu (**Adjust the band**,
      **Hide for 30 days**, the latter persisted per browser).
    - Add the `Asked N times` chip to `DecisionCard.tsx` and the
      write-to-instructions action to `DecisionDetail.tsx`, linking to the raising
      Agent's instructions route with the latest answer as a draft rule.
    - Extend `apps/web/src/app/actions/dashboard/decisions.ts` with
      `getDecisionHealthAction` and `updateDecisionBandAction`.
    - **Test**: `apps/web/src/components/decisions/DecisionHealthBanner.unit.spec.tsx`
      — all four bands and the hidden state when the snapshot is absent.
    - **Done when**: the page still renders when `/health` returns 204.

- [ ] **T43. Add the P3 end-to-end and accessibility specs.**
    - Create `apps/web/e2e/flow-decisions-health-band.spec.ts` — the four bands at
      their boundaries, the override dialog, and the hidden line with no snapshot.
    - Create `apps/web/e2e/flow-decisions-a11y.spec.ts` — the full keyboard map from
      [`spec.md`](./spec.md) §6.17, focus order, the polite live region, and axe over
      both panes.
    - **Done when**: both pass and axe reports no serious or critical violations.

- [ ] **T44. P3 i18n and documentation.**
    - Add the `health` and `repeat` sub-trees to `apps/web/messages/en.json` and
      mirror across the 20 sibling locales.
    - Update the user-facing doc page with the band table and the recurring-decision
      guidance; update the AW-03 row in `TRACKER.md` to `P3 shipped`.
    - **Done when**: the structural diff across the 21 message files is empty and
      the docs site builds.

---

## Definition of done (all phases)

- [ ] `pnpm lint`, `pnpm type-check` and `pnpm test` are green from the repository
      root.
- [ ] `cd apps/api && pnpm test` is green, including the three controller specs.
- [ ] All eight `apps/web/e2e/flow-decisions-*.spec.ts` files pass.
- [ ] Both migrations apply forward on a fresh and a seeded database, and a
      re-generate produces an empty diff.
- [ ] Every one of the 21 files in `apps/web/messages/` has an identical key set,
      every leaf key is camelCase, and no leaf key contains a literal `.`.
- [ ] `grep -r "tryResumeLinkedRun"` returns nothing: there is exactly one
      implementation of close-deliver-unblock in the repository.
- [ ] No file under `packages/agent/src/decisions/` imports a job-runtime vendor
      SDK; every dispatch goes through the existing DI symbols.
- [ ] No hardcoded plugin id appears anywhere in the new code.
- [ ] No answer text, rationale or ask prompt appears in an activity-log entry, a
      product-analytics event or an error report.
- [ ] Every acceptance criterion in [`spec.md`](./spec.md) §8 has a test that
      exercises it.
