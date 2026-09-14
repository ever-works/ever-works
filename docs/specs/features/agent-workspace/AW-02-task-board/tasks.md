# AW-02 — Task board · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries
> explicit file paths and a definition of done. Every task ships with its tests
> (Constitution VI). Work top to bottom; tasks marked `(parallel)` may run alongside
> the task immediately above them.

**Feature ID**: `aw-02-task-board`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- All paths are repo-relative to the monorepo root.
- Run everything with `pnpm` from the root unless a task says otherwise.
- **No task in this breakdown adds an entity, a table, a column or a migration.** If
  a task appears to need one, stop and re-read [`plan.md`](./plan.md) §3 — the signal
  it wants already exists. The single exception is deferred to T39 and gated on a
  product decision.
- Add new tasks at the bottom; never renumber.
- Commit style: `feat(tasks): …`, `test(tasks): …`, `chore(i18n): …`.

---

## The three standing constraints

Re-read these before every task. They are what makes this epic additive.

1. **`TasksKanbanView.tsx` keeps its export and its props.** Every existing caller —
   `TasksList`, `TasksScopedSection`, and through them `/tasks`,
   `/missions/[id]/tasks`, `/works/[id]/tasks`, `/ideas/[id]/tasks` — must keep
   compiling and keep working with no change on their side.
2. **`GET /api/tasks` does not change.** Its existing controller specs must pass
   untouched. Any diff in them means an additive promise was broken.
3. **Every new default that changes what a user sees has a one-action toggle back.**
   Board-as-landing-view, top-level-only, templates-out-of-columns.

---

# PHASE 1 — Make the board true

## P1.A — Pure domain logic (no I/O, no framework)

- [ ] **T1. Column tables and drop resolution.** - Create `packages/agent/src/tasks-domain/task-board-columns.ts` exporting: - `export type BoardLayout = 'status' | 'focus';` - `export interface BoardColumnDef { key: string; statuses: readonly TaskStatus[]; terminal: boolean; }` - `STATUS_COLUMNS: readonly BoardColumnDef[]` — seven entries, one status
      each, in the order `backlog, todo, in_progress, in_review, blocked, done,
cancelled`. - `FOCUS_COLUMNS: readonly BoardColumnDef[]` — `backlog` (`backlog`, `todo`),
      `in_flight` (`in_progress`), `needs_you` (`in_review`, `blocked`), `done`
      (`done`), plus a `cancelled` entry marked as toggle-only. - `columnsFor(layout, opts: { includeCancelled: boolean }): BoardColumnDef[]` - `columnForStatus(layout, status): string` - `resolveDrop(from: TaskStatus, column: BoardColumnDef, allowed: Record<TaskStatus, TaskStatus[]>): { kind: 'apply'; to: TaskStatus } | { kind: 'ask'; options: TaskStatus[] } | { kind: 'refuse' }` - **No imports** from TypeORM, NestJS, or any service. `TaskStatus` is imported
      as a type only. - Add a file-header comment stating the invariant: _every `TaskStatus` value
      appears in exactly one column of each layout; a column is never derived from
      anything but status._ - **Test**: `packages/agent/src/tasks-domain/__tests__/task-board-columns.spec.ts` - Both layouts cover all seven statuses exactly once (assert by set equality
      against `Object.values(TaskStatus)`, so adding a status to the enum without
      adding a column fails the suite). - `resolveDrop` over the full 7 × 5 matrix, asserting the verdict for every
      pair. - `in_progress → needs_you` is the **only** `ask` in the whole matrix. - Every drop out of `cancelled` is `refuse`. - **Done when**: `pnpm --filter @ever-works/agent test task-board-columns` is
      green and the file imports nothing outside `entities/task.entity`.

- [ ] **T2. The stall predicate.** _(parallel with T1)_
    - Create `packages/agent/src/tasks-domain/task-board-stall.ts` exporting:
        - `export const DEFAULT_STALL_AFTER_DAYS = 2;`
        - `clampStallAfterDays(value: number | null | undefined): number` — 1..30,
          default 2.
        - `stallCutoff(now: Date, days: number): Date`
        - `isStalled(input: { status; latestRunStatus; updatedAt; now; stallAfterDays }): boolean`
          exactly as [`plan.md`](./plan.md) §2.4.
    - Add the header comment stating what the predicate costs: it derives "no
      progress" from `updatedAt`, so an unrelated edit clears the flag. It
      **under-reports and never over-reports**, and that asymmetry is why no new
      column is stored.
    - **Test**: `.../__tests__/task-board-stall.spec.ts` — 47 h vs 49 h at the default
      threshold; `latestRunStatus` of `queued` and `running` (not stalled) vs each
      terminal value and `null` (stalled); every non-`in_progress` status (never
      stalled); the clamp at `0`, `1`, `30`, `31`, `null`, `undefined`, `NaN`.
    - **Done when**: green, and the file has no framework import.

- [ ] **T3. Provenance ordering.** _(parallel with T1)_
    - Create `packages/agent/src/tasks-domain/task-board-provenance.ts` exporting:
        - `export type ProvenanceKind = 'trigger' | 'recurringTemplate' | 'scheduled' | 'mission' | 'idea' | 'work' | 'team' | 'goal' | 'agent' | 'raisedByAgent' | 'delegated' | 'creator';`
        - `PROVENANCE_PRECEDENCE: readonly ProvenanceKind[]` in spec FR-28's order.
        - `orderProvenance(entries: ProvenanceEntry[]): ProvenanceEntry[]` — sorted by
          precedence, with entries whose `name` is `null` **dropped** (spec FR-29).
    - **Test**: `.../__tests__/task-board-provenance.spec.ts` — all twelve present
      returns all twelve in precedence order; an unresolvable name is dropped, not
      rendered as an id; an empty input returns empty.
    - **Done when**: green.

- [ ] **T4. Export the new module surface.**
    - Modify `packages/agent/src/tasks-domain/index.ts`: re-export T1, T2 and T3.
    - **Done when**: `apps/api` and `apps/web` can both import them, and
      `pnpm --filter @ever-works/agent build` is clean.

## P1.B — Filter options (additive, no schema)

- [ ] **T5. Three optional fields on `ListTasksFilter`.**
    - Modify `packages/agent/src/database/repositories/task.repository.ts`:
        - Widen `parentTaskId?: string` to `parentTaskId?: string | 'none'`.
        - Add `isRecurring?: boolean`.
        - Add `orderBy?: 'updatedAt' | 'priorityThenUpdated' | 'stalledThenPriority'`.
        - Add `stallCutoff?: Date` (only read when `orderBy` is
          `'stalledThenPriority'`).
    - In `list()`:
        - `parentTaskId === 'none'` → `andWhere('task.parentTaskId IS NULL')`; a uuid
          keeps today's meaning; `undefined` adds no predicate.
        - `isRecurring` defined → `andWhere('task.isRecurring = :isRecurring', …)`;
          `undefined` adds no predicate.
        - Replace the single `qb.orderBy('task.updatedAt', 'DESC')` with a switch
          whose **`undefined` and `'updatedAt'` branches emit the identical clause**.
        - `'stalledThenPriority'` emits the three-key `ORDER BY` of
          [`plan.md`](./plan.md) §3.2.
    - Add the comment explaining why `task.priority ASC` is correct: the column is a
      `varchar(4)` holding `p0`–`p4`, so lexicographic order **is** priority order.
      Without that note it reads as an accident and someone will "fix" it.
    - **Test**: `.../__tests__/task-repository-board-filters.spec.ts` — assert the
      generated SQL for each option, and one regression case asserting that
      **omitting all four new fields produces the exact SQL the repository produces
      today**.
    - **Done when**: green, and every existing `task.repository` test passes
      untouched.

## P1.C — The board read model

- [ ] **T6. `TaskBoardService` — counts, cards and templates.**
    - Create `packages/agent/src/tasks-domain/task-board.service.ts`.
    - Injects the task repository and the ownership-scope helper from
      `packages/agent/src/database/ownership-scope.ts`.
    - `getBoard(userId, input: BoardInput, scope): Promise<BoardResult>` runs exactly
      the three queries of [`plan.md`](./plan.md) §2.1:
        - **Q1** grouped `COUNT(*) … GROUP BY status` under the shared predicate →
          the true per-status totals.
        - **Q2** per-column top-N rows via the repository's `list()` with
          `orderBy: 'stalledThenPriority'`, `includeRun: true`.
        - **Q3** recurring templates: `isRecurring: true` ordered by
          `nextOccurrenceAt`.
    - **The predicate for Q1 and Q2 is built once** by a private
      `buildBoardFilter(input)` and passed to both, so a count and its cards can
      never disagree. Assert this in the test.
    - Terminal columns (`done`, `cancelled`) get
      `updatedAt >= now - terminalWindowDays` applied to **both** Q1 and Q2.
    - Defaults: `layout: 'status'`, `columnLimit: 50` (clamped 1..100),
      `terminalWindowDays: 7` (clamped 1..90), sub-tasks excluded
      (`parentTaskId: 'none'`), templates excluded (`isRecurring: false`), hidden
      excluded.
    - `getColumn(userId, input, columnKey, offset, scope)` returns one column only.
    - **Test**: `.../__tests__/task-board.service.spec.ts`
        - `total` comes from Q1 and is **not** `cards.length` — seed 140 rows in one
          status with `columnLimit: 50` and assert `total === 140`,
          `cards.length === 50`.
        - Every toggle flips exactly one predicate.
        - The terminal window applies to the count as well as the cards.
        - `getColumn` returns the same rows Q2 would have returned at that offset.
    - **Done when**: green and the service has no enrichment code in it yet.

- [ ] **T7. Wire the service into DI.**
    - Modify `packages/agent/src/tasks-domain/tasks.module.ts` — provide and export
      `TaskBoardService`.
    - **Done when**: `apps/api/src/tasks/tasks.module.ts` resolves it, and
      `tasks.module.di-contract.spec.ts` is extended with the new provider and passes.

## P1.D — API surface

- [ ] **T8. `GET /api/tasks/board`.** - Modify `apps/api/src/tasks/tasks.controller.ts`. Place the route **above**
      `@Get(':id')` — the existing file already warns that a later static segment is
      shadowed by the param route, and `run-batch` carries that comment; follow it. - Declare **every** query parameter with an explicit `@ApiQuery({ required:
false })`. The file's own comment explains why: without the CLI plugin, a bare
      `@Query('x') x?: string` is emitted as required and the MCP tool schema then
      forces every filter. - Parameters and defaults exactly as [`plan.md`](./plan.md) §4.1. Reuse the
      controller's existing `parsePriorityList` helper; do not write a second parser. - Throttle: match the existing list route. - Ownership: `@CurrentUser()` + `this.scopeContext.getScope()`, same as every
      neighbour. - **Test**: `apps/api/src/tasks/tasks.controller.board.spec.ts` — defaults;
      `layout=focus` returns four columns; `columnLimit` clamps at 1 and 100;
      `terminalWindowDays` clamps at 1 and 90; each `include*` flag flips one
      predicate; malformed values fall back to the default rather than 500ing. - **Done when**: green **and** `tasks.controller.scope.spec.ts` and
      `tasks.controller.board-visibility.spec.ts` still pass unmodified.

- [ ] **T9. `GET /api/tasks/board/column`.**
    - Same file, same placement rule. Adds `status` (one column key, validated
      against `columnsFor()`) and `offset`.
    - Returns `{ key, statuses, total, cards }`.
    - **Test**: extend `tasks.controller.board.spec.ts` — an unknown column key is a
      400, not a 500; the offset pages within that column only.
    - **Done when**: green.

- [ ] **T10. Board scope isolation spec.**
    - Create `apps/api/src/tasks/tasks.controller.board-scope.spec.ts`, modelled on
      the existing `tasks.controller.scope.spec.ts`.
    - Assert: another user's Task appears in **no column and in no count**; a Task in
      another Organization scope likewise; `board/column` for a foreign scope returns
      the same empty shape rather than leaking a total.
    - **Done when**: green. This spec is the guard on spec FR-65 and FR-66 and must
      not be skipped to a later phase.

- [ ] **T11. Extend the existing board-visibility spec.**
    - Modify `apps/api/src/tasks/tasks.controller.board-visibility.spec.ts`: add cases
      proving `hiddenFromBoard` rows are absent from the **board read's** columns and
      its **counts**, and present under `includeHidden=true` — the file already
      covers the list route; this extends it to the board route rather than starting
      a parallel file.
    - **Done when**: green.

- [ ] **T12. Typed web client.**
    - Modify `apps/web/src/lib/api/tasks.ts`: add `tasksAPI.board(input)` and
      `tasksAPI.boardColumn(input)` plus the `BoardResult` / `BoardColumn` /
      `BoardCard` types. Do not change the existing `Task` type — the `board` block is
      an additive optional field on it.
    - **Done when**: `pnpm --filter @ever-works/web type-check` is clean.

- [ ] **T13. Server actions.**
    - Modify `apps/web/src/app/actions/tasks.ts`: append `getTaskBoardAction`,
      `getTaskBoardColumnAction`, `setTasksViewAction`. Change nothing that is already
      there.
    - **Done when**: the existing actions' specs pass untouched.

## P1.E — Web: extract, then improve

- [ ] **T14. Extract the card, the column and the shell — behaviour identical.**
    - Create `apps/web/src/components/tasks/board/`:
        - `TaskBoardCard.tsx` — lift `TaskKanbanCard` **verbatim**, including the
          `r` handler's four guards (modifier, repeat, text input, open diff sheet),
          the drag handlers, `RunWithAgentMenu`, `TaskBranchChip`, `TaskPrPill`,
          `TaskRunChip`, `GateChip`, `TaskDiffSheet`, and the per-card error line.
        - `TaskBoardColumn.tsx` — lift `TaskKanbanColumn` verbatim, including
          `RUN_ALL_MAX = 20`, the `runAllEligible` rule, and the batch summary.
        - `TaskBoard.tsx` — lift the `TasksKanbanView` body verbatim, including
          `useTaskRunPolling` and its merge rules, the optimistic move with rollback,
          and the post-drop agent-picker logic.
    - `TasksKanbanView.tsx` becomes a thin adapter rendering `TaskBoard` from a plain
      `Task[]`, keeping its export name and prop shape (standing constraint 1).
    - **This task changes no behaviour.** Commit it on its own so the diff of T15
      onward is readable.
    - **Test**: the existing e2e specs that exercise the board must pass with no edit.
    - **Done when**: green with a zero-behaviour-change diff.

- [ ] **T15. True totals and independent per-column paging.**
    - `TaskBoardColumn` takes `total` from the server rather than `tasks.length`, and
      its **Show more** calls `getTaskBoardColumnAction` and appends to that column's
      array only.
    - Delete the client-side `MAX_VISIBLE` slice; the server's `columnLimit` owns it.
    - **Test (e2e)**: seed 120 Tasks across seven statuses; assert each header total
      matches the seed and that the largest column renders 50 cards; assert **Show 50
      more** leaves the other columns' rendered counts and scroll positions unchanged.
    - **Done when**: green.

- [ ] **T16. The board is an address.**
    - Modify `apps/web/src/components/tasks/TasksList.tsx`: move `view` out of
      `useState` into the URL (`?view=`), falling back to a `tasks.view` cookie, then
      to `'board'`. Write the cookie through `setTasksViewAction` on change.
    - Modify `apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx`: add a
      `resolveTasksView()` helper; for `view=board` call `tasksAPI.board(...)`, for
      `cards` and `table` keep calling `tasksAPI.list(...)` **unchanged**.
    - Keep the page's existing server-rendered filter `<form>` working and in sync
      with the board's filters (spec FR-22).
    - **Test (e2e)**: no preference → board; `?view=table` → table; the choice
      survives a reload; a filtered board URL reproduces the same board and counts.
    - **Test (Vitest)**: view resolution — URL beats cookie beats default.
    - **Done when**: green, and the Cards and Table views render exactly as before.

- [ ] **T17. Empty, error and loading states.**
    - Per-column empty copy (spec §6.9), the whole-board empty state (§6.8), the
      inline error panel with **Try again** and the Table link (§6.11), and RSC
      skeleton frames (§6.7).
    - A single column's failed read shows the panel in that column only.
    - **Test (e2e)**: zero Tasks → the empty board, not seven empty columns; a forced
      read failure → the panel with the column frames intact and the page not blank.
    - **Done when**: green.

- [ ] **T18. Explain the refusals the board already performs.**
    - The board already refuses illegal drops silently. Add the toast: dragging out of
      `cancelled` explains that a cancelled Task cannot be reopened (spec S15).
    - Surface the server's reason on a refused transition rather than the generic
      `Transition failed` string.
    - **Test (Vitest)**: a rejected transition renders the server's message.
    - **Done when**: green.

## P1.F — i18n (a P1 gate, not a P3 nicety)

- [ ] **T19. Move every hardcoded board string into the catalogue.** - Modify `apps/web/messages/en.json`: add the `dashboard.tasksPage.board` parent
      and the leaves listed in [`plan.md`](./plan.md) §8. - **Reuse, do not re-declare**: the seven column names must read from the existing
      `dashboard.tasksPage.status.*` leaves and the five priority labels from the
      existing `dashboard.tasksPage.priority.*` leaves. Copying those strings into
      `board.*` is a review-blocking mistake — they are already translated across
      every locale. - Replace in `TasksKanbanView.tsx` / the new `board/*` files and in
      `TasksList.tsx`: `Backlog`, `Todo`, `In Progress`, `In Review`, `Blocked`,
      `Done`, `Cancelled`, `Cards`, `Table`, `Kanban`, `All`, `Move →`, `Run all`,
      `Run N Task(s) in X`, `empty`, `Show N more`, `Preview the changes on this
Task's branch`, `n/m started`, `Transition failed`. - Every leaf name camelCase, **no literal dot**, and the `board` parent added in
      the same change so no subtree can collapse. - **Done when**: `grep` for each of those literals in
      `apps/web/src/components/tasks/` returns nothing, and the board renders in
      English through the catalogue.

- [ ] **T20. Locale structure.**
    - Run the catalogue's existing locale-sync script, then the translation pass.
    - **Test (Vitest)**: extend the hydration spec so a missing parent key fails
      here rather than reddening every e2e shard.
    - **Done when**: every locale file is structurally identical to `en.json` and the
      hydration spec is green.

## P1.G — Ordering

- [ ] **T21. Priority ordering on the board.**
    - `TaskBoardService` passes `orderBy: 'stalledThenPriority'` with a `stallCutoff`
      from `DEFAULT_STALL_AFTER_DAYS` (the flag itself lands in P3; the ordering key
      is already correct and costs nothing now).
    - Column header tooltip: `board.sortTooltip`.
    - **Test (e2e)**: a `p0` Task seeded with an old `updatedAt` renders first in its
      column.
    - **Done when**: green.

---

# PHASE 2 — Make the card legible

## P2.A — The enrichment layer

- [ ] **T22. Batched, independently-guarded enrichment.**
    - Extend `packages/agent/src/tasks-domain/task-board.service.ts` with a private
      `enrich(cards)` running the six reads of [`plan.md`](./plan.md) §2.1 (E1–E6).
    - **Each read is one query over the whole page of cards** — `WHERE taskId IN (…)`
      with up to `7 × columnLimit` ids — never one query per card.
    - Each read is individually `try/catch`-wrapped; a failure sets the corresponding
      field to absent and appends its name to `degraded[]`.
    - Owner-name lookups are scope-filtered, so an unresolvable or invisible name
      comes back `null` and is dropped by `orderProvenance` (T3).
    - **Test**: extend `task-board.service.spec.ts` — assert **one call per source**
      with an `IN` list (not N calls); assert each source's failure degrades only
      itself and names itself in `degraded[]`; assert a scope-invisible owner yields
      no chip rather than an id.
    - **Done when**: green.

- [ ] **T23. The `board` block on the wire.**
    - Add the additive `board` block of [`plan.md`](./plan.md) §4.1 to each card in
      the board response. `provenance` arrives **already ordered and already
      filtered**, so the client renders the first two and menus the rest without
      knowing the precedence rules.
    - **Test**: extend `tasks.controller.board.spec.ts` — the block is present on
      every card; `provenance` respects FR-28; the existing `Task` shape is
      unchanged.
    - **Done when**: green.

## P2.B — The card

- [ ] **T24. Provenance chips.**
    - Create `apps/web/src/components/tasks/board/TaskProvenanceChips.tsx`. Renders
      the first two entries; the rest go to the card menu's bottom block (spec §6.4).
    - Each chip links to the thing it names **and** applies the corresponding board
      filter on click.
    - **Test (Vitest)**: two chips rendered, third menued; an entry with a null name
      never reaches the component (it was dropped server-side) and the component
      tolerates it anyway.
    - **Test (e2e)**: a Mission-owned, a trigger-fired, a recurrence-cloned and a
      hand-filed Task each show the expected chip; clicking the Mission chip filters
      the board and updates every count; **assert no Mission renders as a card in any
      column**.
    - **Done when**: green.

- [ ] **T25. Sub-task roll-up and the top-level default.** _(parallel with T24)_
    - Card shows `▣ done/total` when the Task has sub-tasks, linking to the parent's
      existing sub-task checklist.
    - **Show sub-tasks** toggle flips `includeSubtasks`, restoring today's flat
      behaviour exactly.
    - A sub-task matching the active filters whose parent does not match renders as
      its own card with a `Sub-task of {parent}` chip (spec FR-42, S24) — implement
      this as a second, filter-scoped query in the service, not as a client fix-up.
    - **Test (e2e)**: a parent with five sub-tasks, two done, renders one card with
      `2/5`; the toggle restores six cards; the FR-42 case renders the extra card.
    - **Done when**: green.

- [ ] **T26. Decision chip and the two header counters.** _(parallel with T24)_
    - Chip with the open-decision count and an **Open decision** action, rendered in
      whatever column the Task's status puts it in.
    - Header: `N waiting on you` (clicking filters the board to exactly those) and
      `N done today`, counted since the viewer's local midnight.
    - **The day boundary is an explicit input**, exactly as [`plan.md`](./plan.md)
      §4.1.1:
        - Create `packages/agent/src/tasks-domain/task-board-day.ts` (pure, no
          framework import) with `resolveBoardTimeZone(raw)` and
          `localDayWindow(now, timeZone): { since; resetsAt }`, and re-export both from
          `packages/agent/src/tasks-domain/index.ts`.
        - `GET /api/tasks/board` accepts an optional `timeZone` (IANA name, declared
          with `@ApiQuery({ required: false })`). `TaskBoardService` counts
          `status = 'done' AND completedAt >= since` under the shared board predicate
          and returns `doneToday`, `timeZone`, `doneTodaySince` and
          `doneTodayResetsAt` in `counters` — all `null` when the zone is absent or
          invalid, and the count query is then not issued.
        - `apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx` forwards the
          `tasks.timeZone` cookie; `apps/web/src/app/actions/tasks.ts` appends
          `setTasksTimeZoneAction(timeZone)` returning `{ changed }`; `TaskBoard`
          detects the browser zone on mount, calls the action, refreshes once only on
          `changed: true`, and schedules one refresh at `doneTodayResetsAt` (plus a
          re-check when the tab becomes visible again).
    - The board **counts and links**; it renders no decision content
      ([AW-03](../AW-03-decision-queue/) owns that).
    - **Test**: `packages/agent/src/tasks-domain/__tests__/task-board-day.spec.ts` —
      every case in [`plan.md`](./plan.md) §10.1: UTC; `Asia/Tokyo` and
      `America/Los_Angeles` where the local and UTC dates differ; the 23-hour
      `America/New_York` day; `America/Santiago` where the change skips local
      midnight; one millisecond either side of a local midnight; invalid and absent
      zones.
    - **Test**: extend `task-board.service.spec.ts` — `completedAt` one millisecond
      before `since` is excluded and exactly at `since` is included; no zone → `null`
      counters and no count query. Extend `tasks.controller.board.spec.ts` — `timeZone`
      passes through; an unknown zone is a 200 with `doneToday: null`, not a 400.
    - **Test (Vitest)**: `TaskBoard` refreshes once on `changed: true`, never on
      `changed: false`, once at `doneTodayResetsAt`, and once on becoming visible after
      it; `doneToday: null` renders the placeholder, never `0`.
    - **Test (e2e)**: a Task with an open escalation shows the chip while staying in
      `In progress`; the counter matches; clicking it filters. With a non-UTC
      `timezoneId`, a Task completed at that zone's local midnight is counted and one
      completed a millisecond earlier is not; a first visit shows the placeholder, then
      the count after one refresh.
    - **Done when**: green.

- [ ] **T27. Comment count and reply.** _(parallel with T24)_
    - Chip when the thread has ≥ 1 message, `99+` above 99, opening the existing
      thread. A reply composed from the board posts through the **existing**
      `POST /api/tasks/:id/chat`.
    - Introduce **no** new comment endpoint, service, entity or rate limit. If a task
      here seems to need one, re-read [`spec.md`](./spec.md) §5.4.
    - **Test (e2e)**: posting from the board increments the chip and — when the
      mentioned Agent has a live run — is delivered into that run rather than
      starting a second, exactly as the detail page already behaves.
    - **Done when**: green.

- [ ] **T28. Untrusted text.** _(parallel with T24)_
    - Every Agent-authored string a card renders — title, branch name, label — is
      plain text, never markup, never auto-linked, truncated for display with the full
      value in the accessible name.
    - **Test (Vitest)**: a title containing markup renders as literal text.
    - **Done when**: green.

## P2.C — Recurrence

- [ ] **T29. Templates out of the columns.**
    - The board's default filter already excludes them (T6). Add the `⟳ Template`
      chip and the drag-disable for the **Show templates** path.
    - **Test (e2e)**: a template is in no column by default; the toggle puts it back,
      chipped and not draggable.
    - **Done when**: green.

- [ ] **T30. The recurring strip.**
    - Create `apps/web/src/components/tasks/board/TaskRecurringStrip.tsx` — collapsed
      and expanded forms of spec §6.5.
    - Cadence text comes from the **existing** describers in
      `packages/agent/src/schedules/cadence.ts`. Do not re-derive human-readable cron
      or RRULE text; there is already an implementation and a second one will drift.
    - Ended templates are listed as ended with their last fire (spec FR-46, S23), not
      omitted.
    - **Schedules** links to the platform's existing schedules view.
    - **Test (e2e)**: the strip names each template, its cadence and its next fire; an
      ended template is listed as ended; the strip's failure hides the strip without
      putting templates back into the columns.
    - **Done when**: green.

- [ ] **T31. Instance and scheduled chips.** _(parallel with T30)_
    - An instance carries `⟳ {template title}` linking to its template; a one-shot
      scheduled Task carries `🕑 Scheduled {when}` until it fires. Both are ordinary,
      draggable cards.
    - **Test (e2e)**: an instance is draggable and chipped; a scheduled Task is not
      treated as a template.
    - **Done when**: green.

- [ ] **T32. Hidden-work toggle.** _(parallel with T30)_
    - **Show trigger-hidden Tasks** reveals `hiddenFromBoard` rows with a `Hidden`
      chip. Off by default; absent from every column and every count while off.
    - **Test**: covered by T11 server-side; add the e2e for the toggle.
    - **Done when**: green.

---

# PHASE 3 — Make it say when it is stuck

- [ ] **T33. The stalled flag on the card.**
    - Add `board.stalled` to the response (the predicate is already in the ordering
      from T21) and the flag with its tooltip to `TaskBoardFlags`.
    - The client recomputes with the **same** `isStalled()` from T2 so the flag and
      the ordering cannot drift.
    - **Test (e2e)**: 49 h with no live run is flagged; 47 h is not; 49 h with a
      running run is not; a `blocked` Task at any age is not.
    - **Done when**: green.

- [ ] **T34. The stall sweep job.**
    - Create `packages/tasks/src/tasks/trigger/task-stall-sweep.task.ts` following the
      shape of the existing `task-recurrence-dispatcher` and `task-pr-status-sync`
      tasks: `schedules.task({ id, cron: '17 */6 * * *', run })` spinning a transient
      `TriggerInternalModule` Nest context and closing it.
    - Register it in `packages/tasks/src/tasks/trigger/index.ts`.
    - Cap rows per sweep, in the same way the mission tick caps itself.
    - **Done when**: the task is registered and a local invocation produces
      notifications for seeded stalled Tasks and none for fresh ones.

- [ ] **T35. The `task_stalled` notification kind.**
    - Modify `packages/agent/src/tasks-domain/task-notification.service.ts`: add
      `task_stalled` to the existing kind→severity map (warning). **No migration** —
      `NotificationCategory.TASK` already exists and the column is a free `varchar`.
    - `deduplicationKey = ${taskId}:stalled:${startedAt ?? updatedAt}` — this is what
      makes "once per stalled streak" true with no new state, because the key changes
      only when the Task moves.
    - Add `notifications.taskStalled.title` / `.body` to `en.json` and run the locale-sync script.
    - **Test**: two sweeps over the same stalled Task produce **one** notification; a
      Task that moves and stalls again produces a second.
    - **Done when**: green.

- [ ] **T36. The Focus layout.**
    - Layout switcher; four columns plus the **Show cancelled** toggle; each column
      names the statuses it groups directly under its label (spec §6.6).
    - Drops resolve through `resolveDrop` (T1). The two-target picker of spec S16.
    - **Test (e2e)**: dragging `in_progress` onto `Needs you` opens the picker;
      choosing `Blocked` moves the card; cancelling changes nothing; `cancelled` is
      reachable via the toggle and is still visible without any toggle in the Status
      layout and in the Cards and Table views.
    - **Done when**: green.

- [ ] **T37. Keyboard navigation.**
    - Roving focus: one tab stop per column, `←` `→` `↑` `↓` `Home` `End` within and
      between columns, `Enter` opens, `Shift`+`F10` opens the card menu, `n` and `/`
      on the board, `Esc` closes the topmost overlay.
    - **The existing `r` handler is the model** — it already ignores modifiers, key
      repeat, text inputs and the open diff sheet. Every new shortcut must apply the
      same four guards.
    - **Test (e2e)**: the board is fully operable with no pointer; every drag action
      has a card-menu equivalent.
    - **Done when**: green.

- [ ] **T38. Saved views.**
    - Named URLs stored with the user's existing preferences. No new entity (spec
      §5.4).
    - **Done when**: a saved view restores layout, filters and toggles, and is
      shareable as a plain link.

- [ ] **T39. (Gated) A configurable stall threshold.**
    - **Do not start this without a product decision on [`spec.md`](./spec.md) §9.**
      P1–P3 use `DEFAULT_STALL_AFTER_DAYS = 2`.
    - If adopted: one nullable `int` column on
      `packages/agent/src/entities/work-agent-preference.entity.ts`, documented like
      its neighbour `missionDefaultOutstandingCap` ("NULL = inherit the platform
      default of 2; clamped 1–30 at the service layer"), plus **one additive
      forward-only migration** in `apps/api/src/migrations/` in the same PR, stamped
      `1791020000000` (AW-02 slot 00, [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)).
    - Hand-check the generated migration: one `ADD COLUMN`, no `DROP`, no
      `ALTER … TYPE`, no `NOT NULL` without a default; `down` reverses only what `up`
      added.
    - **This is the only migration this epic may ever produce.**
    - **Done when**: the migration applies on a fresh database and on one with data,
      and the generated diff is empty afterwards.

---

## Documentation and hygiene

- [ ] **T40. Correct the program vocabulary table.**
    - Modify `docs/specs/features/agent-workspace/README.md` §1.1: the Task priority
      row reads `p0 · p1 · p2 · p3`. The entity and the message catalogue both carry
      **five** steps, `p0`–`p4`, with `p4` labelled Low. Change it to
      `p0 · p1 · p2 · p3 · p4`.
    - Also in §3: this epic is sized `M`, not `L` — the working board in
      `TasksKanbanView.tsx` removes the largest chunk.
    - **Done when**: both edits land in the same PR as P1.

- [ ] **T41. Fix the stale doc comments this epic touched.** _(parallel with T40)_
    - `apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx` — its header says
      "Kanban + per-target tabs land in Phase 14"; Kanban shipped.
    - **Done when**: the comment describes what the file does.

- [ ] **T42. Update the program tracker.**
    - Modify `docs/specs/features/agent-workspace/TRACKER.md`: AW-02's spec and
      implementation status per phase.
    - **Done when**: the tracker reflects reality at each phase's merge.

---

## Definition of done

**Phase 1**

- Column header totals are true totals under the active filters, verified against a
  direct count on a 120-Task fixture.
- Columns page independently.
- `?view=` and every filter are in the URL; the choice is remembered; the board is
  the default.
- Cards sort `p0` first within a column.
- **No string on the board is hardcoded**, and the seven status names and five
  priority labels resolve from the keys that already existed.
- The Cards view, the Table view, `GET /api/tasks` and its specs, and every scoped
  Task list are unchanged.
- No entity, table, column or migration was added.

**Phase 2**

- Provenance chips name the right source for a Mission-raised, trigger-fired,
  recurrence-cloned, agent-delegated and hand-filed Task, and **no Mission appears as
  a card**.
- Sub-tasks roll up by default and flatten on one toggle.
- Recurring templates are in the strip and not in the columns, and one toggle puts
  them back.
- The Decision chip and the two header counters are correct, and the board renders no
  decision content of its own.
- The comment chip opens the **existing** thread; no second comment noun exists
  anywhere in the diff.
- Every enrichment degrades independently and names itself in `degraded[]`.

**Phase 3**

- The stalled flag matches the predicate at both boundaries and never fires outside
  `in_progress`.
- Exactly one notification per stalled streak.
- The Focus layout maps all seven statuses, asks rather than guesses on an ambiguous
  drop, and leaves `cancelled` reachable.
- The board is fully operable by keyboard.

**All phases**

- `pnpm lint`, `pnpm type-check`, the Jest suites in `packages/agent` and
  `apps/api`, the Vitest suites in `apps/web`, the locale-sync check, and the
  Playwright specs are green.
- The Constitution gate table in [`spec.md`](./spec.md) §11 and
  [`plan.md`](./plan.md) §12 is still accurate. Gate V is conditional on T39:
    - **T39 not adopted** — the epic ships no entity change and no migration; gate V
      holds as written.
    - **T39 adopted** — the epic ships exactly one entity column and its one additive,
      forward-only migration (`1791020000000`) in the same PR; gate V is satisfied by that
      migration, and the "no migration" wording in §11/§12 is updated in the same PR.
