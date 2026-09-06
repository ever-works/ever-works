# AW-02 — Mission board · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries
> explicit file paths and a definition of done. Every task ships with its tests
> (Constitution VI). Work top to bottom; tasks marked `(parallel)` may run
> alongside the task immediately above them.

**Feature ID**: `aw-02-mission-board`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- All paths are repo-relative to the monorepo root.
- Run everything with `pnpm` from the root unless a task says otherwise.
- Migrations are **authored** from `apps/api/`; nothing is run by hand on deploy —
  the API self-applies on boot.
- Add new tasks at the bottom; never renumber.
- Commit style: `feat(missions): …`, `test(missions): …`, `chore(i18n): …`.

---

# PHASE 1 — The board

## P1.A — Schema and domain model

- [ ] **T1. Add the board columns to the Mission entity.**
    - Modify `packages/agent/src/entities/mission.entity.ts`:
        - Export string-union types beside the existing enums:
          `export type MissionOriginType = 'user' | 'schedule' | 'agent';`
          `export type MissionProgressKind = 'run_started' | 'run_completed' | 'run_failed' | 'tick' | 'task_transition' | 'decision_opened' | 'decision_resolved' | 'comment';`
        - Add columns exactly as specified in [`plan.md`](./plan.md) §3.1:
          `priority` `varchar(4)` default `'p3'`; `labels` `simple-json` nullable;
          `archivedAt` / `deletedAt` / `lastProgressAt` as `PortableDateColumn({ nullable: true })`;
          `lastProgressSummary` `varchar(280)` nullable; `lastProgressKind` `varchar(32)` nullable;
          `commentCount` `int` default `0`; `createdByType` `varchar(16)` default `'user'`;
          `createdById` `uuid` nullable.
        - Add `@Index('idx_missions_board_scan', ['userId', 'deletedAt', 'archivedAt', 'status'])`
          and `@Index('idx_missions_progress', ['userId', 'lastProgressAt'])` on the class.
        - Reuse `TaskPriority` from `packages/agent/src/entities/task.entity.ts` for the
          `priority` field's TS type — do **not** declare a second priority enum.
    - **Done when**: `pnpm --filter @ever-works/agent build` is clean and every new column
      carries a doc comment explaining what writes it.

- [ ] **T2. Add the staleness preference column.**
    - Modify `packages/agent/src/entities/work-agent-preference.entity.ts`: add
      `missionStaleAfterDays?: number | null` as `@Column({ type: 'int', nullable: true })`,
      documented as "NULL = inherit the platform default of 2; clamped 1–30 at the service
      layer", mirroring the neighbouring `missionDefaultOutstandingCap` comment.
    - **Done when**: the column exists with its comment and the package builds.

- [ ] **T3. Generate and hand-review the P1 migration.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddMissionBoardColumns`
    - Land the file in `apps/api/src/migrations/<timestamp>-AddMissionBoardColumns.ts`.
    - Hand-check: 10 `ADD COLUMN` on `missions`, 1 on `work_agent_preferences`,
      2 `CREATE INDEX`. **No** `DROP`, no `ALTER … TYPE`, no `NOT NULL` without a default.
      The `down` drops only what `up` added, in reverse.
    - **Done when**: `pnpm typeorm migration:run -d typeorm.config.ts` applies on a fresh
      database and again on a database that already has data, and the generated diff is
      empty afterwards.

- [ ] **T4. Extend the Mission DTO and mapper.**
    - Modify `packages/agent/src/missions/types.ts`: add the ten new fields to `MissionDto`
      and to `toMissionDto()`. This is the only place a Mission field reaches the wire.
    - **Test**: extend `packages/agent/src/missions/__tests__/missions.service.spec.ts` with a
      mapper case asserting every new field round-trips, including `labels: null → []`.
    - **Done when**: no caller of `toMissionDto` needs a change and the API returns the new
      fields.

## P1.B — Lane derivation (the heart of the feature)

- [ ] **T5. Write the pure lane function.**
    - Create `packages/agent/src/missions/mission-lane.ts` exporting:
        - `export type MissionLane = 'backlog' | 'in_flight' | 'needs_you' | 'done';`
        - `export const MISSION_LANE_ORDER: readonly MissionLane[]`
        - `export const DEFAULT_MISSION_STALE_AFTER_DAYS = 2;`
        - `export const IN_FLIGHT_RECENCY_MS = 24 * 60 * 60 * 1000;`
        - `deriveLane(input: { status; archivedAt; deletedAt; lastProgressAt; openDecisionCount; liveRunCount; now }): MissionLane | null`
          (`null` = not on the board), implementing spec FR-3's precedence exactly.
        - `isStale(input: { lane; lastProgressAt; now; staleAfterDays }): boolean`
        - `clampStaleAfterDays(value: number | null | undefined): number` — 1–30, default 2.
    - No imports from TypeORM, NestJS or any service. Pure functions only.
    - **Test**: `packages/agent/src/missions/__tests__/mission-lane.spec.ts` — a truth table
      over every precedence branch, `lastProgressAt = null`, the paused case, the 24-hour
      recency boundary at ±1 ms, the staleness boundary at 47 h / 49 h, and the clamp at
      0 / 1 / 30 / 31 / null.
    - **Done when**: the spec covers all six branches of FR-3 and passes.

- [ ] **T6. Export the new module surface.**
    - Modify `packages/agent/src/missions/index.ts`: `export * from './mission-lane';`
      (and, as later tasks land, the board / staleness / trash services).
    - **Done when**: `apps/api` can import `MissionLane` from `@ever-works/agent/missions`.

## P1.C — Board read model

- [ ] **T7. Add `MissionBoardService`.**
    - Create `packages/agent/src/missions/mission-board.service.ts`.
    - Constructor injects `Repository<Mission>`, `Repository<Task>`,
      `Repository<AgentEscalation>`, `Repository<AgentActionProposal>` and the
      work-agent preference repository (for the staleness threshold).
    - `getBoard(userId, filter, scope)` runs exactly the four queries in
      [`plan.md`](./plan.md) §2.1 — the Mission scan, two grouped decision counts, one
      grouped live-run count — then maps through `deriveLane`.
    - Ownership uses `ownershipWhere` from
      `packages/agent/src/database/ownership-scope.ts`. The Mission scan always adds
      `deletedAt IS NULL AND archivedAt IS NULL`.
    - Each of the three auxiliary queries is individually `try/catch`-guarded: a failure
      degrades that signal (decision counts → `degraded: 'decision-counts'` on the
      `Needs you` lane; live runs → treated as 0) and never fails the board.
    - Lane totals are computed unbounded; only the card arrays are capped by `laneLimit`.
    - `doneTodayCount` is computed from a validated IANA timezone, falling back to UTC.
    - **Test**: `packages/agent/src/missions/__tests__/mission-board.service.spec.ts` —
      filters compose, lane cap vs. true total, `doneTodayCount` across a timezone
      boundary, per-source degradation, foreign-user rows never appear.
    - **Done when**: a board for 500 Missions issues exactly 4 queries (assert with a
      query spy).

- [ ] **T8. Add archive / trash / restore and label + priority writes to `MissionsService`.**
    - Modify `packages/agent/src/missions/missions.service.ts`:
        - `archive`, `unarchive`, `trash`, `restore` — all idempotent, all owner-scoped
          through the existing `findOrThrow`, each writing an activity row via the
          existing private `recordActivity`.
        - `trash` also clears `archivedAt`; `restore` clears both markers.
        - `normalizeLabels(input)` — trim, lower-case, de-duplicate, reject > 8 or a value
          failing `/^[a-z0-9][a-z0-9._-]{0,31}$/`, throwing `BadRequestException`.
        - `create` / `update` accept `priority` and `labels`; `create` defaults `priority`
          to `p3` and stamps `createdByType = 'user'`, `createdById = userId`.
        - `listForUser` gains `include?: 'active' | 'archived' | 'trashed' | 'all'`,
          defaulting to `'active'` (excludes both markers).
    - **Test**: extend `packages/agent/src/missions/__tests__/missions.service.spec.ts` —
      idempotent repeats, label normalisation and every rejection case, the `include`
      filter's four values, and that archiving does not touch any Task or Run.
    - **Done when**: all four shelf verbs are idempotent and 404-no-leak on a foreign id.

- [ ] **T9. Wire the new services into the module.**
    - Modify `packages/agent/src/missions/missions.module.ts`: register
      `MissionBoardService` (and, from T13/T14, the staleness and trash services), add the
      `TypeOrmModule.forFeature` entries for `Task`, `AgentEscalation` and
      `AgentActionProposal`, and export what the API layer needs.
    - **Done when**: `pnpm --filter ever-works-api build` boots the DI graph without a
      missing-provider error.

## P1.D — Progress writers

- [ ] **T10. Add the progress-recording helper.**
    - Add `recordProgress(missionId, kind, summary)` to `MissionsService` (or a small
      `MissionProgressService` in `packages/agent/src/missions/mission-progress.service.ts`
      if the service is already too large). It issues one `UPDATE missions SET
      lastProgressAt = now(), lastProgressSummary = :summary, lastProgressKind = :kind`,
      truncating the summary to 280 characters and stripping control characters.
    - Wrapped in `try/catch` + `logger.warn` — a failure must never fail the caller.
    - **Test**: truncation at 279 / 280 / 281 characters; control-character stripping; a
      throwing repository does not propagate.

- [ ] **T11. Call the helper from the six existing event owners.**
    - `packages/agent/src/tasks-domain/task-run-denorm.service.ts` — when it writes
      `Task.latestRunStatus`, and the Task has a `missionId`, record `run_started` /
      `run_completed` / `run_failed`.
    - `packages/agent/src/tasks-domain/task-transition.service.ts` — record
      `task_transition` with the Task title and its new status.
    - `packages/agent/src/missions/mission-tick.service.ts` — record `tick` with the number
      of Ideas produced.
    - The escalation writer path in `packages/agent/src/agents/` — record
      `decision_opened` / `decision_resolved` for the escalation's Task's Mission.
    - The proposal writer path in `packages/agent/src/agents/` — same, for approvals.
    - (Comment posting is wired in Phase 2, T32.)
    - **Test**: extend each touched service's existing spec in
      `packages/agent/src/tasks-domain/__tests__/` and
      `packages/agent/src/missions/__tests__/` with one case asserting the progress write
      fires with the right `kind`, and one asserting a Task with no `missionId` writes
      nothing.
    - **Done when**: a user edit to a Mission's title still does **not** write progress
      (spec FR-27) — assert that explicitly.

## P1.E — API surface

- [ ] **T12. Add the board and shelf endpoints.**
    - Modify `apps/api/src/missions/missions.controller.ts`:
        - `@Get('board')` → `MissionBoardService.getBoard`, `@Throttle` 120/min.
        - `@Post(':id/archive')`, `@Post(':id/unarchive')`, `@Post(':id/trash')`,
          `@Post(':id/restore')` → the T8 methods, `@Throttle` 30/min, `@HttpCode(200)`.
        - `@Get()` passes the new `include` query through.
        - Every route gets `@ApiOperation` + `@ApiResponse` so the MCP whitelist derivation
          picks it up.
    - Modify `apps/api/src/missions/dto/mission.dto.ts`: add `MissionBoardQueryDto` exactly
      as specified in [`plan.md`](./plan.md) §4.1, and add optional `priority` + `labels`
      to `CreateMissionDto` and `UpdateMissionDto`.
    - `apps/api/src/missions/missions.module.ts`: no new module, only the provider wiring
      that T9 exported.
    - **Test**:
        - `apps/api/src/missions/missions.controller.board.spec.ts` — response shape, query
          validation (bad priority value, `laneLimit` 0 and 201, `doneWindowDays` 0 and 91,
          a hostile `tz` string), throttle metadata present.
        - `apps/api/src/missions/missions.controller.shelf.spec.ts` — happy path, idempotent
          repeat, and identical 404 bodies for a foreign id across all four verbs.
        - `apps/api/src/missions/missions.controller.scope.spec.ts` — Organization scoping
          on every new route.
        - Extend `apps/api/src/missions/dto/mission.dto.spec.ts` for `priority` and `labels`.
    - **Done when**: `curl` against a running API returns four lanes in board order for a
      seeded user and `404` for another user's Mission id.

- [ ] **T13. Add the staleness service.**
    - Create `packages/agent/src/missions/mission-staleness.service.ts` with
      `sweep(): Promise<{ scanned; flagged }>`: select Missions the lane function puts in
      `in_flight` with `lastProgressAt < now - effectiveThreshold`, and raise one
      notification each through `NotificationService` with
      `category: NotificationCategory.MISSION`, `type: WARNING`,
      `deduplicationKey: mission-stale:${missionId}:${Math.floor(lastProgressAt/1000)}`,
      and an `actionUrl` to the Mission.
    - Add `MISSION = 'mission'` to `NotificationCategory` in
      `packages/agent/src/entities/notification.types.ts` (no migration — `category` is
      `varchar(100)`).
    - Add `MISSION_STALE_FLAGGED` to `ActivityActionType` in
      `packages/agent/src/entities/activity-log.types.ts` (no migration — `actionType` is
      `varchar(50)`), and emit it on first flag.
    - **Test**: `packages/agent/src/missions/__tests__/mission-staleness.service.spec.ts` —
      47 h / 49 h boundaries at the default, the clamp, one notification per streak (a
      second sweep is a no-op), a new key after the Mission moves, no flag for Backlog /
      Needs you / Done / archived / trashed.

- [ ] **T14. Add the trash-retention service.**
    - Create `packages/agent/src/missions/mission-trash.service.ts` with
      `purgeDue(now, batchSize = 200)`: hard-delete Missions with
      `deletedAt < now - 30 days`, cascading `mission_comments` (once the P2 table exists —
      until then there is nothing to cascade), and emit `MISSION_PURGED` to the activity log
      with the Mission title and its `trashedAt`.
    - Add `MISSION_ARCHIVED`, `MISSION_UNARCHIVED`, `MISSION_TRASHED`, `MISSION_RESTORED`,
      `MISSION_PURGED` to `ActivityActionType`.
    - **Test**: `packages/agent/src/missions/__tests__/mission-trash.service.spec.ts` —
      the 30-day cutoff either side, batch cap respected, a re-run finds nothing, the
      activity row carries the title.

- [ ] **T15. Add the two background tasks.**
    - Create `packages/tasks/src/tasks/trigger/mission-staleness-sweep.task.ts`
      (`schedules.task({ id: 'mission-staleness-sweep', cron: '7 * * * *' })`) and
      `packages/tasks/src/tasks/trigger/mission-trash-purge.task.ts`
      (`cron: '23 4 * * *'`), both copying the `NestApplicationContext(TriggerInternalModule)`
      shape of `packages/tasks/src/tasks/trigger/mission-tick.task.ts` and returning a
      structured summary.
    - Register both in `packages/tasks/src/tasks/trigger/index.ts`.
    - **Done when**: `pnpm --filter @ever-works/tasks build` is clean and neither file
      imports anything from the agent package other than its service class.

## P1.F — Web

- [ ] **T16. Extend the web API client and server actions.**
    - Modify `apps/web/src/lib/api/missions.ts`: add `board(input)`, `archive(id)`,
      `unarchive(id)`, `trash(id)`, `restore(id)`, and the `include` param on `list`. Add
      the `MissionBoardDto` / `MissionBoardLaneDto` / `MissionBoardCardDto` /
      `MissionLane` / `MissionOriginType` types alongside the existing `Mission` type.
    - Modify `apps/web/src/app/actions/dashboard/missions.ts`: add
      `getMissionBoardAction`, `archiveMissionAction`, `unarchiveMissionAction`,
      `trashMissionAction`, `restoreMissionAction`, `setMissionPriorityAction`,
      `setMissionLabelsAction`, each matching the file's existing error-shaping style.
    - **Done when**: `pnpm --filter ever-works-web type-check` is clean.

- [ ] **T17. Turn `/missions` into a tabbed page.**
    - Modify `apps/web/src/app/[locale]/(dashboard)/missions/page.tsx`: read `?tab=`
      (`board` default, then `list`, `archived`, `trashed`), fetch the matching data with
      the existing `try/catch` discipline, and render the matching client component. Keep
      the current list path byte-for-byte behind `tab=list`.
    - Add the tab strip to a new
      `apps/web/src/components/missions/board/MissionsTabs.tsx`, persisting the choice to
      `localStorage['missions-tab']` and mirroring it into the URL.
    - **Done when**: `/missions` renders the board, `/missions?tab=list` renders exactly
      today's page, and a hard refresh on either keeps the tab.

- [ ] **T18. Build the board shell.**
    - Create under `apps/web/src/components/missions/board/`:
      `MissionBoard.tsx`, `MissionBoardHeader.tsx`, `MissionLane.tsx`,
      `MissionBoardSkeleton.tsx`, `MissionBoardEmpty.tsx`.
    - `MissionBoard` owns filter state, drag state and optimistic mutations; lanes are
      keyed by mission id so a refresh never remounts an unchanged card.
    - Lane headers carry the name, the true total, and the sort tooltip; each lane is a
      labelled region with a polite live count.
    - `MissionBoardEmpty` wraps `apps/web/src/components/common/EmptyState.tsx`.
    - **Test**: `MissionLane.unit.spec.tsx` — empty line per lane, `Show N more` appears
      only when `hasMore`, the header count shows the true total not the rendered count,
      the degraded decision-count copy renders.

- [ ] **T19. Build the card and its menu.**
    - Create `apps/web/src/components/missions/board/MissionBoardCard.tsx` and
      `MissionCardMenu.tsx`.
    - Card renders: priority chip, Stale flag (In flight only), Paused chip, title (2-line
      clamp, full title in the accessible name), live status line (In flight only, 140
      characters shown, `title` attribute for the full value), up to 3 labels + `+N`,
      origin chip, comment chip (`99+` above 99), relative last-move time with the absolute
      value in its tooltip.
    - Menu items and their handlers per spec §6.4; unavailable items are disabled with a
      reason in their tooltip.
    - **Test**: `MissionBoardCard.unit.spec.tsx` — a status line containing `<script>` and a
      markdown link renders as literal text; 5 labels render 3 + `+2`; 150 comments render
      `99+`; a Backlog card renders no status line; a card is a single link target.

- [ ] **T20. Build filters and the poll hook.**
    - Create `apps/web/src/components/missions/board/MissionBoardFilters.tsx` (search,
      priority, label, origin, `Clear filters` shown only while a filter is active, all
      URL-synced) and `apps/web/src/components/missions/board/useMissionBoardPoll.ts`
      (15 s while visible with anything in flight, 60 s while visible otherwise, stopped
      while `document.hidden`), modelled on
      `apps/web/src/lib/hooks/use-task-run-polling.ts`.
    - **Test**: `MissionBoardFilters.unit.spec.tsx` for URL round-tripping; a hook test for
      the three interval regimes and the visibility teardown.

- [ ] **T21. Build drag-and-drop moves.**
    - In `MissionBoard.tsx` / `MissionLane.tsx`, use the same native HTML5 handlers as
      `apps/web/src/components/tasks/TasksKanbanView.tsx`.
    - Backlog → In flight calls `runMissionNowAction`; In flight → Backlog calls
      `pauseMissionAction`; any → Done opens the existing completion dialog; the
      `Needs you` lane omits `onDragOver`/`onDrop` and shows the explanatory toast.
    - A refused or failed move reverts the card and surfaces the server message.
    - **Done when**: every drag has an equivalent card-menu item (spec FR-75).

- [ ] **T22. Build the quick-create dialog.**
    - Create `apps/web/src/components/missions/board/NewMissionDialog.tsx` on
      `apps/web/src/components/ui/dialog.tsx` (Headless UI). Fields, copy and layout per
      spec §6.10; opens on the `+ New Mission` button and on the `n` key.
    - On failure it restores the dialog with the entered values and an inline error.
    - Links to `ROUTES.DASHBOARD_MISSIONS_NEW` for the full form.
    - **Test**: `NewMissionDialog.unit.spec.tsx` — 9-character description is refused
      client-side, a 9th label is refused inline, a failed submit preserves the text.

- [ ] **T23. Build the Archived and Trash tabs.**
    - Create `apps/web/src/components/missions/board/MissionShelf.tsx` (a `variant` prop for
      `archived` | `trash`) and `MissionPurgeDialog.tsx` (type-the-title confirmation, which
      calls the existing `deleteMissionAction`).
    - Trash rows show `Deleted {date} · purged in {days} days`.
    - **Test**: `MissionShelf.unit.spec.tsx` — both empty states, the purge-date arithmetic,
      and that `Delete forever` stays disabled until the typed title matches exactly.

- [ ] **T24. Add the archived / trashed banner to the Mission detail page.**
    - Modify `apps/web/src/components/missions/MissionDetailClient.tsx`: render the banner
      from spec §6.14 above the existing sections when `archivedAt` or `deletedAt` is set,
      with a `Restore` action.
    - Export every new board component from
      `apps/web/src/components/missions/index.ts`.
    - **Test**: extend `MissionDetailClient.unit.spec.tsx` with both banner cases.

- [ ] **T25. Add the keyboard layer.**
    - Roving tabindex inside each lane, one tab stop per lane. Bindings per spec §6.16
      (`n`, `/`, arrows, `Home`/`End`, `Enter`, menu key, `1`–`5`, `e`, `Delete`, `r`,
      `Esc`). `e` and `Delete` are inert while any input, textarea, select or
      contenteditable has focus — reuse the guard shape in
      `apps/web/src/lib/hooks/use-keyboard-shortcuts.ts`, but keep these bindings local to
      the board rather than registering them globally.
    - **Done when**: the board is fully operable with the pointer unplugged.

## P1.G — i18n, tests, docs

- [ ] **T26. Add the P1 message keys.**
    - Modify `apps/web/messages/en.json`: add every key in [`plan.md`](./plan.md) §8 except
      the `dashboard.missionDetail.comments.*` block, under the existing
      `dashboard.missionsPage` namespace plus the two `dashboard.settings.workAgent.*` keys.
    - Mirror the same key tree into all 20 sibling locale files in `apps/web/messages/`
      (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh`),
      translated — not copied English.
    - **Hard rule**: leaf key names are camelCase and contain **no literal dot**. next-intl
      rejects dotted leaves at runtime and the hydration spec turns that into a
      multi-shard failure.
    - **Done when**: all 21 files have identical key trees (add a small script under
      `apps/web/scripts/` if one does not already exist) and `pnpm --filter ever-works-web build`
      is clean.

- [ ] **T27. Add the P1 end-to-end specs.**
    - Create in `apps/web/e2e/`:
      `flow-mission-board-ui-journey.spec.ts`,
      `flow-mission-board-quick-create.spec.ts`,
      `flow-mission-board-archive-trash.spec.ts`,
      `flow-mission-board-lane-moves.spec.ts`,
      `flow-mission-board-empty-and-error.spec.ts`,
      `flow-mission-board-keyboard.spec.ts`,
      `flow-mission-board-a11y.spec.ts`.
    - Scope each per [`plan.md`](./plan.md) §10.3. Prefer role- and text-based locators over
      `*ByRole` chains that are known to be load-sensitive in this suite.
    - **Done when**: all seven pass locally three times in a row and in CI.

- [ ] **T28. Document the board.**
    - Create `docs/features/mission-board.md` describing lanes, priority, staleness,
      archive/trash and steering in user language.
    - Cross-link from `docs/features/index.md` and add it to
      `apps/docs/sidebarsPlatform.ts` (the sidebar is manual — an unlisted file renders as
      an orphan page).
    - **Done when**: `pnpm --filter ever-works-docs build` reports no broken links.

- [ ] **T29. P1 green gate.**
    - Run `pnpm format`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`.
    - Update [`../TRACKER.md`](../TRACKER.md): AW-02 spec `Approved`, implementation
      `P1 shipped`.
    - **Done when**: `develop` is green with the board live and comments absent.

---

# PHASE 2 — The thread and steering

- [ ] **T30. Add the Mission comment entity.**
    - Create `packages/agent/src/entities/mission-comment.entity.ts` per
      [`plan.md`](./plan.md) §3.3 — `@Entity('mission_comments')`,
      `@ManyToOne(() => Mission, { onDelete: 'CASCADE' })`, indexes
      `idx_mission_comment_mission_created` and `idx_mission_comment_author`, Tier C
      `tenantId`/`organizationId`.
    - Export it from `packages/agent/src/entities/index.ts`.
    - **Done when**: the agent package builds and TypeORM picks the entity up.

- [ ] **T31. Generate and hand-review the P2 migration.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateMissionComments`
    - Verify it is one `CREATE TABLE` plus two indexes plus the FK; no other table is
      touched.
    - **Done when**: it applies cleanly on a database that already ran the P1 migration.

- [ ] **T32. Add `MissionCommentService`.**
    - Create `packages/agent/src/missions/mission-comment.service.ts`, modelled closely on
      `packages/agent/src/tasks-domain/task-chat.service.ts`:
      `MAX_COMMENT_BYTES = 16 * 1024`, `EDIT_WINDOW_MS = 5 * 60_000`, the same `MENTION_RE`,
      the same optional-injection posture for `RUN_STEERING_PORT`,
      `AGENT_CHAT_REPLY_DISPATCHER` and `RunDispatchGateService`.
    - `post()` persists the row, bumps `missions.commentCount`, calls
      `recordProgress(..., 'comment', ...)`, then resolves the newest non-terminal
      `AgentRun` among the Mission's Tasks and follows the decision tree in
      [`plan.md`](./plan.md) §2.3, writing `deliveryOutcome` / `deliveryDetail` /
      `deliveredRunId` back onto the row.
    - `list()` paginates 50 per page, oldest first. `edit()` enforces the 5-minute window.
    - Emit `MISSION_COMMENT_POSTED` to the activity log with the outcome but **never** the
      body.
    - **Test**: `packages/agent/src/missions/__tests__/mission-comment.service.spec.ts` —
      the 16 KB cap, the edit window either side, mention parsing, all four delivery
      outcomes including a refusal from the dispatch gate, the `commentCount` and
      `lastProgressAt` side effects, and that an unbound steering port degrades rather than
      throwing.

- [ ] **T33. Add the comment endpoints.**
    - Create `apps/api/src/missions/mission-comments.controller.ts`
      (`@Controller('api/me/missions/:id/comments')`, `@ApiTags('missions')`), registered in
      `apps/api/src/missions/missions.module.ts` — mirroring how
      `apps/api/src/tasks/task-chat.controller.ts` sits beside `tasks.controller.ts`.
    - `GET` (120/min), `POST` (20/min, `PostMissionCommentDto`), `PATCH :commentId`
      (20/min). No delete endpoint.
    - **Test**: `apps/api/src/missions/mission-comments.controller.spec.ts` — post/list/edit
      happy paths, a 16 KB + 1 body rejected, `409` after the edit window, `404`-no-leak on
      a foreign Mission and on a comment id from another Mission, and the throttle metadata.

- [ ] **T34. Build the comment thread UI.**
    - Create `apps/web/src/components/missions/MissionCommentThread.tsx` per spec §6.13:
      the thread, the delivery annotation under each comment, the 5-minute `Edit`
      affordance, `(edited)`, `Load older comments`, `Ctrl`/`Cmd`+`Enter` to send, and the
      `Insert a change of direction` button that populates the box with the editable
      template.
    - Mount it from `apps/web/src/components/missions/MissionDetailClient.tsx`; export it
      from the barrel.
    - Add `listMissionCommentsAction`, `postMissionCommentAction`,
      `editMissionCommentAction` to `apps/web/src/app/actions/dashboard/missions.ts` and the
      matching client methods to `apps/web/src/lib/api/missions.ts`.
    - **Test**: `MissionCommentThread.unit.spec.tsx` — each of the four annotations renders
      its copy, the Edit link disappears after 5 minutes, the template inserts editable text
      rather than sending, and a comment body containing markup renders as literal text.

- [ ] **T35. Light up comment counts on cards.**
    - `MissionBoardCard` already reads `commentCount` (T19); confirm it now renders for
      Missions with a thread and assert it in the card unit spec.

- [ ] **T36. Add the P2 message keys.**
    - Add the `dashboard.missionDetail.comments.*` block from [`plan.md`](./plan.md) §8 to
      `apps/web/messages/en.json` and all 20 sibling locales. Same camelCase / no-dot rule.

- [ ] **T37. Add the steering end-to-end spec.**
    - Create `apps/web/e2e/flow-mission-comment-steering.spec.ts` covering: delivered into a
      live Run, queued with no live Run, refused with the job runtime unconfigured (assert
      the settings link), edit at 4 minutes succeeds, at 6 minutes the affordance is gone,
      and the 21st comment in a minute is refused without dispatching a Run.

- [ ] **T38. P2 green gate.**
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - Update [`../TRACKER.md`](../TRACKER.md) to `P2 shipped`.
    - Add **Mission comment** to the vocabulary table in [`../README.md`](../README.md) §1
      in this same PR (program rule #2).

---

# PHASE 3 — The whole queue

- [ ] **T39. Add `targetKind` to inbound Triggers.**
    - Modify `packages/agent/src/entities/inbound-trigger.entity.ts`: add
      `targetKind` `varchar(16)` default `'task'`, documented as immutable after create
      like the neighbouring `mode` and `sourceType`.
    - Generate `apps/api/src/migrations/<timestamp>-AddInboundTriggerTargetKind.ts` from
      `apps/api/` and hand-review it as one `ADD COLUMN` with a default.

- [ ] **T40. Branch the Trigger fire path on `targetKind`.**
    - In the inbound-trigger fire service under `packages/agent/src/` (the one
      `apps/api/src/triggers/inbound-triggers.controller.ts` delegates to): when
      `targetKind === 'mission'`, create a Mission with `createdByType = 'schedule'` and
      `createdById = trigger.id`, reusing the existing `taskTitleTemplate` /
      `taskDescriptionTemplate` placeholder expansion and the existing dedupe ledger.
    - Reject a `targetKind` change on `PATCH /api/inbound-triggers/:id` with a 400, the
      same way `mode` is protected today.
    - **Test**: a fire with `targetKind: 'mission'` creates exactly one Mission with origin
      `schedule`; a duplicate delivery id creates none; a `PATCH` attempting to change
      `targetKind` is refused.

- [ ] **T41. Let an Agent propose a Mission.**
    - Add a `mission.create` member to `AgentActionProposalActionType` in
      `packages/agent/src/entities/agent-action-proposal.entity.ts` (and its contracts type)
      with a payload of `{ title?, description, priority?, labels? }`.
    - The approval handler in `apps/api/src/agent-approvals/` creates the Mission on approve
      with `createdByType = 'agent'`, `createdById = proposal.agentId`.
    - An unapproved proposal creates **no** Mission and does **not** appear on the board
      (spec §9 open question — confirm the recommendation before building).
    - **Test**: approve → one Mission with origin `agent` and the Agent's name resolved on
      the card; reject → no Mission; the risk scorer runs on the proposal like any other.

- [ ] **T42. Make origin real in the UI.**
    - `MissionBoardCard` resolves the origin chip's display name: `You` for `user`,
      `Schedule` for `schedule`, the Agent's name for `agent` (resolved server-side in the
      board DTO so the client stays dumb).
    - `MissionBoardFilters` origin filter becomes meaningful; assert lane counts update.

- [ ] **T43. Add the staleness threshold setting.**
    - Add the `missionStaleAfterDays` control to the work-agent settings page under
      `apps/web/src/app/[locale]/(dashboard)/settings/work-agent/`, with the copy from
      [`plan.md`](./plan.md) §8 and client-side clamping to 1–30.
    - Wire it through the existing work-agent preference update action and API route.
    - **Test**: raising the threshold clears the Stale flag on the next board read and sends
      no new notification for an already-flagged Mission (spec S25).

- [ ] **T44. Add bulk archive.**
    - `POST /api/me/missions/bulk/archive` (`{ ids: string[] }`, `@ArrayMaxSize(100)`,
      10/min) on `apps/api/src/missions/missions.controller.ts`, backed by a batched
      `MissionsService.archiveMany` that skips ids the caller does not own rather than
      failing the batch.
    - Web: an `Archive all Done older than 30 days` action in the Done lane header, behind a
      confirmation naming the count.
    - **Test**: a batch containing one foreign id archives the rest and reports the skip;
      101 ids is rejected.

- [ ] **T45. Add the P3 message keys and specs.**
    - The origin, settings and bulk-archive copy into all 21 message files.
    - `apps/web/e2e/flow-mission-board-origins.spec.ts` — a Schedule-filed Mission and an
      Agent-filed Mission both appear in Backlog with their chips, and the origin filter
      narrows the board and its counts.

- [ ] **T46. P3 green gate and close-out.**
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - Set `spec.md` status to `Implemented`; set `plan.md` and `tasks.md` to `Done`.
    - Update [`../TRACKER.md`](../TRACKER.md) to `P3 shipped`.
    - File the four follow-ups from [`plan.md`](./plan.md) §13 as separate issues — in
      particular the shared board primitive and the Constitution §V migration-path drift.

---

## Definition of done

- Every checkbox above is ticked.
- All three migrations applied cleanly on a database with pre-existing data, and the
  entity-to-schema diff is empty afterwards.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check` green.
- Agent-package Jest, API Jest and the touched Playwright shards green in CI.
- All 21 message files carry identical key trees; no leaf key contains a literal dot.
- `pnpm --filter ever-works-docs build` reports no broken links.
- Every constitution gate in [`spec.md`](./spec.md) §11 confirmed satisfied, and the
  provider-name grep over the diff is empty (Constitution II review gate).
- **Mission comment** is present in the vocabulary table in [`../README.md`](../README.md) §1.
</content>
