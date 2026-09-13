# AW-02 — Task board

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> This document describes **what a user sees and can do**. No class names, no file
> paths, no code — those live in [`plan.md`](./plan.md).

**Feature ID**: `aw-02-task-board`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-02-task-board`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: M · **Blocking dependencies**: none
**Extends**: the existing `/tasks` surface and its Kanban view · **Adjacent epics**: [AW-03 My Decisions](../AW-03-decision-queue/), [AW-04 Live Feed](../AW-04-live-feed/), [AW-09 Runs & receipts](../AW-09-runs-receipts/), [AW-10 Schedules](../AW-10-schedules-calendar/), [AW-19 Home](../AW-19-home/)

> **Additive by default (program rule #1).** Nothing here removes, renames or
> consolidates an existing surface. The Cards and Table views on `/tasks` keep
> working unchanged; every existing Task filter, endpoint and response field keeps
> its behaviour; the Missions pages — `/missions`, `/missions/[id]`,
> `/missions/[id]/tasks` — are untouched. Every new API parameter is optional and
> defaults to today's behaviour.

> **This epic introduces no new entity, no new table and no new column.** Every
> signal it needs already exists in the platform. §5.4 justifies each candidate
> noun that was considered and rejected.

---

## 0. TL;DR

```
   /tasks?view=board
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  Tasks                        4 waiting on you · 7 done today   [+ New Task]│
   │  ┌───────┬──────────┐              ┌──────────────────────────────────────┐ │
   │  │ Tasks │ Triggers │              │ Cards │ Table │ ▣ Board │ ← view      │ │
   │  └───────┴──────────┘              └──────────────────────────────────────┘ │
   │  ⟳ 4 recurring Tasks · next fires in 2h                              [Show] │
   ├──────────┬──────────┬─────────────┬────────────┬─────────┬──────┬──────────┤
   │Backlog 12│ To do  31│In progress 4│In review  2│Blocked 1│Done 9│Cancelled3│
   │          │          │             │            │         │      │          │
   │ [card]   │ [card]   │ [card]      │ [card]     │ [card]  │[card]│ [card]   │
   │ [card]   │ [card]   │ [card]STALLED│ [card]    │         │[card]│          │
   └──────────┴──────────┴─────────────┴────────────┴─────────┴──────┴──────────┘
```

**A board already ships.** `/tasks` has a working drag-and-drop Kanban view with one
column per `TaskStatus`, cards carrying branch, run, gate and pull-request chips,
a per-card **Run**, a per-column **Run all**, and drag-to-transition wired through
the same gated transition path the detail page uses. This epic does not build a
board. It fixes the four things that stop the shipped board from answering the
question the program exists to answer.

1. **It is a view of one page, not of the work.** The page fetches the first 50
   Tasks ordered by last-update and buckets them client-side. Every column count is
   a count of _what happened to be fetched_. With 300 Tasks the board is wrong and
   says nothing about being wrong.
2. **Priority is decorative.** Nothing anywhere sorts by it. A `p0` and a `p3` are
   interleaved by last-update.
3. **A card has no provenance and no shape.** A Task raised by a Mission, fired by
   a Trigger, cloned from a recurring template, delegated by an Agent or typed by a
   person all render identically — and recurring _templates_ and _sub-tasks_ render
   as ordinary, draggable cards alongside the real work.
4. **Nothing says "this needs me" and nothing says "this is stuck."** Open
   escalations are reachable one Task at a time; there is no stall signal anywhere
   in the product.

Three phases, each independently shippable and each with **no schema change**:

- **P1 — Make the board true.** A server-side board read with real per-column
  totals and priority ordering, the board as an addressable, shareable, remembered
  view, and every string through the message catalogue.
- **P2 — Make the card legible.** Provenance chips, sub-task roll-up, the recurring
  template strip, the decision chip and the "waiting on you" counter, comment count
  and reply-from-the-card.
- **P3 — Make it say when it is stuck.** The stalled flag and its notification, the
  four-group Focus layout, and saved board views.

---

## 1. Overview

A user opens **Tasks**, and the board is what they land on. Every Task they own sits
in the column of its real status — `Backlog`, `To do`, `In progress`, `In review`,
`Blocked`, `Done`, `Cancelled` — with the true count of that column in its header,
not the count of one fetched page, and with `p0` work at the top of each column
rather than scattered by last-edit.

Each card says where its work came from: _raised by the Mission "Keep pricing
current"_, _fired by the "Stripe webhook" Trigger_, _the 14th run of a weekly
recurring Task_, _delegated by the Editor Agent_, or _filed by you_. Recurring
templates are not cards at all — they sit in a strip above the board that says when
the next one fires. Sub-tasks are not cards either; their parent carries a `▣ 3/5`
roll-up, and one toggle brings them back if the user wants the flat view they have
today.

A header line keeps two scores: how many Tasks are waiting on a decision from the
user, and how many finished today. A Task with an open escalation carries a
**Decision** chip and an **Open decision** action wherever it sits. A Task that has
been claimed as in-progress for days with nothing running is flagged **Stalled**.

Everything the board already does keeps working: drag a card and it transitions
through the same gated path; press `r` on a focused card and it runs; **Run all** at
the top of a column dispatches up to 20; the run, branch, gate and pull-request
chips keep their behaviour; the Cards and Table views are untouched and still one
click away.

---

## 2. Why now

### 2.1 The question this answers

> _"What are my agents doing right now, and what needs me?"_

That question is asked several times a day by exactly the person Ever Works is built
for: an owner who has delegated work and now has to decide whether to trust it. The
board is where it should be answered. Today it is answered wrongly, quietly.

### 2.2 What is already built — and must not be rebuilt

Read this before sizing anything below. The following all ship today and this epic
extends, rather than replaces, every one of them:

| Already shipped                                                                                                                                   | Where the user meets it                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A drag-and-drop Kanban view with one column per `TaskStatus`                                                                                      | `/tasks`, and every scoped Task list — `/missions/[id]/tasks`, `/works/[id]/tasks`, `/ideas/[id]/tasks` |
| Card chips for the Task's branch, its latest run, its acceptance-gate verdict and its pull request with a CI dot                                  | Every card                                                                                              |
| Drag-to-transition through the real transition lattice, with the illegal targets refused before the drop                                          | Every card                                                                                              |
| A per-card **Run** with an agent picker, an `r` keyboard shortcut, and a per-column **Run all** capped at 20                                      | Every card and column header                                                                            |
| A diff sheet showing the changes on a Task's branch                                                                                               | The `± N files` affordance on a card                                                                    |
| Live run polling that refreshes run and CI state without a page reload                                                                            | Automatic while any card has a queued or running run                                                    |
| A per-Task comment thread with `@agent` and `[[kb]]` mentions, a 5-minute edit window, and delivery **into a live run** rather than restarting it | `/tasks/[id]`                                                                                           |
| Watchers, assignees, reviewers, approvers, blockers, relations, attachments, escalations and a per-Task activity feed                             | `/tasks/[id]`                                                                                           |
| Recurrence (RRULE **xor** cron) and one-shot scheduling, both dispatching through the same gated run path a board **Run** click uses              | `/tasks/[id]`                                                                                           |
| Filters for status, priority, label, free text, and every owner — Mission, Idea, Work, Team, Agent, Goal, parent Task                             | The `/tasks` filter bar and the list API                                                                |
| A `hiddenFromBoard` marker so trigger-spawned work can be kept off the human board without being deleted                                          | Set by a Trigger; respected by every default list                                                       |

The correct reading of this epic is the one [EXISTING-SUBSTRATE.md](../EXISTING-SUBSTRATE.md)
§4 asks for: **most of it is binding a finished backend to a screen, and finishing
a last mile that was never finished.**

### 2.3 The five concrete gaps

1. **The board renders one page and counts it as the whole.** The Tasks page
   fetches a single 50-row page ordered by last-update, with no status filter, and
   the board buckets those rows into seven columns. Each column header shows the
   length of its bucket. A user with 300 Tasks sees seven wrong numbers and no
   indication that anything is missing. There is no per-column read and no
   per-column pagination.
2. **Nothing sorts by priority.** The list is ordered by last-update and only by
   last-update. The five-step priority scale is stored, filterable and rendered as
   a chip — and it changes nothing about what the user sees first.
3. **The board is not addressable.** Which view is showing lives in component state
   only. It is not in the URL, it is not remembered between visits, and it is not
   the default — the user lands on Cards and must re-choose the board every time.
   A filtered board cannot be linked to a colleague or bookmarked.
4. **Every string on the board is hardcoded English** — the column names, `Move →`,
   `Run all`, `empty`, `Show N more`, the diff tooltip — while the message
   catalogue already carries `Backlog · To do · In progress · In review · Blocked ·
Done · Cancelled` and `Urgent · High · Medium · Normal · Low`, already
   translated across the platform's locales. This breaks program rule #8 and wastes
   translation that is already paid for.
5. **A card carries no provenance, and the wrong rows are cards.** Nothing on a card
   says a Mission raised it, a Trigger fired it, a recurrence produced it or an
   Agent delegated it. Meanwhile a recurring _template_ — a row that never moves and
   whose whole job is to clone instances — renders as a draggable card, and a
   workflow template instantiated as a parent plus five sub-tasks renders as six
   cards for one piece of work.

And one gap that is upstream of the board but shows up here first:

6. **Nothing in the product says "this has stopped moving."** A Task sitting in
   `in_progress` for three days with no run in flight looks exactly like one that
   started ten minutes ago.

### 2.4 Why extend the board rather than replace it

The shipped board is a real, non-trivial implementation of the hard parts: the
transition lattice mirrored client-side, drop-target refusal, optimistic move with
rollback on failure, run-state polling that merges only run fields so it cannot
clobber an in-flight drag, and batch dispatch with a hard cap. None of that is worth
rewriting. What it is missing is a **read model** — a server that answers "give me
this board" instead of a client that guesses from a page of rows — and the last mile
of legibility on the card. This epic supplies both and leaves the interaction model
where it is.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — Morning glance.**
**Given** a user with 300 Tasks, 4 of which have a run executing and 3 of which have
an open escalation,
**when** they open `/tasks`,
**then** the board is the view they land on, each of the seven column headers shows
that column's true total across all 300 Tasks, the first cards in each column are
its `p0` work, the header reads `3 waiting on you · 7 done today`, and the three
Tasks with escalations each carry a **Decision** chip with an **Open decision**
action, in whichever column their status puts them.

**S2 — Priority is real.**
**Given** a `To do` column holding one `p0` Task edited a month ago and forty `p3`
Tasks edited today,
**when** the board renders,
**then** the `p0` card is first in the column, and the column header's tooltip states
the ordering as "Urgent first, then oldest first".

**S3 — The board is a link.**
**Given** a user filtered to `label=pricing` on the board,
**when** they copy the address bar and send it to a colleague with access,
**then** the colleague opens the same board, in the board view, with the same filter
applied and every column count reflecting the filter.

**S4 — Provenance on the card.**
**Given** four Tasks in `To do` — one raised by the Mission "Keep pricing current",
one created by the "Stripe webhook" Trigger, one cloned this morning from the
"Weekly link sweep" recurring template, and one typed by the user,
**when** the board renders,
**then** each card carries a chip naming its origin — `Mission · Keep pricing
current`, `Trigger · Stripe webhook`, `⟳ Weekly link sweep`, `You` — each chip links
to the thing it names, and clicking a Mission chip filters the board to that
Mission's Tasks.

**S5 — Sub-tasks roll up.**
**Given** a Task instantiated from a workflow template as a parent plus five
sub-tasks, two of which are done,
**when** the board renders with its default settings,
**then** exactly one card appears — the parent — carrying `▣ 2/5`, the five
sub-tasks do not appear as their own cards, and the roll-up links to the parent's
sub-task checklist.
**And when** the user turns on **Show sub-tasks**,
**then** all six cards appear, each in the column of its own status, exactly as they
do today.

**S6 — A recurring template is not a card.**
**Given** a recurring template that fires weekly and has produced 14 instances,
**when** the board renders,
**then** the template is not in any column; the strip above the board reads
`⟳ 4 recurring Tasks · next fires in 2h` and expands to name each template, its
cadence in plain language, and when it next fires; and the most recent instance is
an ordinary card in its own column carrying the chip `⟳ Weekly link sweep`.

**S7 — Something needs the user.**
**Given** a Task in `in_progress` whose Agent raises an escalation,
**when** the board next refreshes,
**then** the card gains a **Decision** chip reading `1 decision`, the header
"waiting on you" count increases by one, the card does **not** change column — its
status is still `in_progress` — and the chip's action opens that decision.

**S8 — Something is stuck.**
**Given** a Task that has been `in_progress` for three days with no run in flight and
a workspace stall threshold of 2 days,
**when** the board renders,
**then** the card carries a **Stalled** flag reading "No run for 3 days", the flag's
tooltip names the exact last-change timestamp, the card sorts above the rest of its
column, and the user receives at most one notification about it.

**S9 — Everything the board already does still works.**
**Given** a user on the board,
**when** they drag a card from `To do` to `In progress`, press `r` on a focused card,
click **Run all** on a column, or open the `±` diff sheet,
**then** each behaves exactly as it does today — the same gated transition, the same
agent picker when a dragged card has no agent, the same 20-Task batch cap, the same
capped diff.

**S10 — The other views are untouched.**
**Given** a user who prefers the table,
**when** they switch to **Table**,
**then** the table renders as it does today, the choice is remembered and reflected
in the URL, and returning later lands them on the table rather than the board.

**S11 — A Mission as a filter, not as a card.**
**Given** a user who wants to see only what the Mission "Keep pricing current"
raised,
**when** they pick that Mission in the board's owner filter (or click a Mission chip
on a card),
**then** the board shows only Tasks whose Mission is that one, every column count
reflects the filter, the filter is in the URL — and no Mission appears as a card in
any column, because a Mission is a source of work, not a unit of it.

### 3.2 Edge cases, failures and races

**S12 — Board read fails.**
**Given** the board request errors,
**when** the page renders,
**then** the column frames still render with an inline error panel reading "Couldn't
load the board." plus a **Try again** button and a link to the Table view; the page
does not blank, does not 500, and does not present an empty board as "you have no
Tasks".

**S13 — A column is over its cap.**
**Given** a `To do` column holding 140 Tasks and a per-column cap of 50,
**when** the column renders,
**then** it shows the first 50 cards, a footer reads "Showing 50 of 140 · Show 50
more", each **Show more** fetches the next page **for that column only**, and the
column header count always shows 140.

**S14 — Empty board vs empty column.**
**Given** a user with zero Tasks,
**when** the board renders,
**then** the seven column frames are replaced by a single empty state ("No Tasks
yet." + **New Task** + a link to the template browser).
**Given** a user with Tasks but none in progress,
**when** the board renders,
**then** the `In progress` column keeps its frame and shows its one-line empty copy
— the board never collapses a column.

**S15 — An illegal drop.**
**Given** a user dragging a card out of `Cancelled`,
**when** they drag it over any column,
**then** no column accepts the drop, because the transition lattice permits nothing
out of `cancelled`; on release a toast explains that a cancelled Task cannot be
reopened, and the card returns unchanged. This is today's behaviour, made
explainable rather than silent.

**S16 — A drop into a grouped column with two legal targets.**
**Given** the Focus layout, whose `Needs you` column groups `In review` and
`Blocked`,
**when** the user drags a card from `In progress` onto it — where both `in_review`
and `blocked` are legal,
**then** the board asks which, in a two-item picker, and applies the chosen
transition; cancelling the picker returns the card unchanged. The board never
guesses a status on the user's behalf.

**S17 — Concurrent move.**
**Given** two browser tabs on the board and a card moved to `Done` in tab A,
**when** tab B drags the same card to `In review`,
**then** the server refuses the now-illegal transition, tab B returns the card to its
displayed column, surfaces the server's reason, and the next refresh shows the card
in `Done`.

**S18 — Someone else's Task.**
**Given** a Task belonging to another user or another Organization,
**when** the current user requests it through any board read or mutation,
**then** the response is a 404 with the same body in every case — the API never
distinguishes "does not exist" from "not yours". This is the existing posture and
the board does not weaken it.

**S19 — Hidden work stays hidden.**
**Given** a Trigger configured with `showOnBoard` off, whose fires produce Tasks,
**when** the board renders,
**then** those Tasks appear in no column and in no column count, they remain fully
reachable at their own detail page and in the Trigger's fire log, and a **Show
trigger-hidden Tasks** toggle reveals them with a `Hidden` chip. The board never
deletes; it hides what the Trigger asked to hide.

**S20 — Agent-supplied text on a card.**
**Given** an Agent that names a branch or writes a title containing markup,
**when** the card renders,
**then** the text renders as literal plain text, is never interpreted as markup, is
never auto-linked, and is truncated for display with the full value available on
hover and to screen readers.

**S21 — A provenance source the user cannot see.**
**Given** a Task whose Mission has since been deleted,
**when** the card renders,
**then** the Mission chip is omitted rather than rendered as a broken link or a raw
identifier, and the card still renders everything else.

**S22 — A stall threshold change.**
**Given** a workspace that raises its stall threshold from 2 days to 7,
**when** the board next renders,
**then** cards between 2 and 7 days lose the Stalled flag immediately, and no
notification is re-sent for a Task that was already flagged.

**S23 — A recurring template with no upcoming fire.**
**Given** a recurring template whose end date has passed or whose maximum occurrence
count is exhausted,
**when** the strip renders,
**then** the template is listed as `Ended` with its last fire date rather than being
silently dropped, and it is not counted in "next fires in".

**S24 — A sub-task whose parent the user filtered away.**
**Given** **Show sub-tasks** off and a filter that matches a sub-task but not its
parent,
**when** the board renders,
**then** the sub-task is shown as its own card carrying a `Sub-task of {parent}`
chip — a filter must never hide a matching Task behind a roll-up on a card that is
not being shown.

**S25 — A very long column read.**
**Given** a workspace whose `Done` column holds 20,000 Tasks,
**when** the board renders,
**then** the `Done` column defaults to Tasks completed within a bounded recent
window, the header states the window, and the window is adjustable — the board never
attempts to count or render an unbounded terminal column.

---

## 4. Functional requirements

### 4.1 Columns and the board read

- **FR-1** Every column on the board MUST correspond to one or more real
  `TaskStatus` values, and a card MUST appear in the column its stored status maps
  to. A column MUST NOT be derived from anything other than status.
- **FR-2** The default layout, **Status**, MUST provide exactly seven columns, one
  per status, in this order and with this mapping:

    | Column      | `TaskStatus`  |
    | ----------- | ------------- |
    | Backlog     | `backlog`     |
    | To do       | `todo`        |
    | In progress | `in_progress` |
    | In review   | `in_review`   |
    | Blocked     | `blocked`     |
    | Done        | `done`        |
    | Cancelled   | `cancelled`   |

    This is the layout that ships today and it MUST remain available and MUST remain
    the default until a workspace chooses otherwise.

- **FR-3** The board MUST additionally offer a **Focus** layout of four columns
  grouping the same seven statuses, for the user who wants the coarse read:

    | Column    | `TaskStatus` values it groups |
    | --------- | ----------------------------- |
    | Backlog   | `backlog`, `todo`             |
    | In flight | `in_progress`                 |
    | Needs you | `in_review`, `blocked`        |
    | Done      | `done`                        |

- **FR-4** `cancelled` MUST NOT be dropped by the Focus layout. It MUST be reachable
  as a collapsed **Cancelled** column shown by a **Show cancelled** toggle, and
  cancelled Tasks MUST remain visible without any toggle in the Status layout, in
  the Cards and Table views, and in every list result that asks for them. No status
  is ever unreachable from the board.
- **FR-5** A drop onto a Focus column MUST resolve to exactly one status. When the
  transition lattice permits exactly one of the column's statuses from the card's
  current status, that status MUST be applied. When it permits more than one, the
  board MUST ask which (S16). When it permits none, the column MUST refuse the drop.
- **FR-6** Every transition the board performs MUST go through the same gated
  transition path the Task detail page uses. The board MUST NOT define its own
  legality rules server-side, and its client-side affordance MUST mirror, never
  replace, the server's lattice.
- **FR-7** Each column header MUST show the **true total** of Tasks matching that
  column and the active filters, independent of how many cards are rendered.
- **FR-8** Each column MUST render at most 50 cards initially and MUST page
  independently: fetching more of one column MUST NOT re-fetch or re-order any other.
- **FR-9** Cards within a column MUST sort by: stalled first, then priority
  ascending (`p0` first), then oldest last-update first. The sort key MUST be stated
  in the column header's tooltip.
- **FR-10** The `Done` and `Cancelled` columns MUST default to a bounded recent
  window of 7 days, adjustable from 1 to 90 days, with the active window stated in
  the column header.
- **FR-11** Tasks marked hidden-from-board by a Trigger MUST be excluded from every
  column and every column count by default, MUST be revealable by an explicit
  toggle, and MUST carry a `Hidden` chip when revealed.
- **FR-12** The board MUST refresh itself while the browser tab is visible and at
  least one card carries a queued or running run, and MUST stop polling while the
  tab is hidden. A refresh MUST NOT reset scroll position, close an open card menu,
  discard an in-flight drag, or lose an unsaved dialog input.
- **FR-13** A failure of any one enrichment — provenance, decision counts, sub-task
  roll-ups, comment counts — MUST degrade that element to absent and MUST NOT fail
  the board.

### 4.2 The view, the filters and the address

- **FR-14** The board MUST be one of the views on the existing `/tasks` surface,
  alongside the Cards and Table views, which MUST keep their current behaviour.
- **FR-15** The active view MUST be reflected in the URL and MUST be restorable from
  it, so any view of `/tasks` is linkable and bookmarkable.
- **FR-16** The active view MUST be remembered per browser between visits. The board
  MUST be the default for a user who has never chosen.
- **FR-17** Every board filter MUST be reflected in the URL, and opening that URL
  MUST reproduce the same board.
- **FR-18** The board MUST offer filters for: free text, priority, label, and each
  existing owner — Mission, Idea, Work, Team, Agent, Goal. All MUST be combinable.
- **FR-19** Applying a filter MUST filter every column and MUST update every column
  count to the filtered total.
- **FR-20** Clicking a label chip or a provenance chip on a card MUST apply the
  corresponding filter.
- **FR-21** Clearing all filters MUST be reachable in one action, shown only while at
  least one filter is active.
- **FR-22** The `/tasks` page's existing server-rendered filter form MUST keep
  working and MUST stay in sync with the board's filters — one set of filters, two
  ways to set them.
- **FR-23** Every scoped Task list that renders the same component today —
  `/missions/[id]/tasks`, `/works/[id]/tasks`, `/ideas/[id]/tasks` — MUST keep
  working, with its scope pre-applied and locked as a filter.

### 4.3 The card

- **FR-24** A card MUST show: the Task's slug, its title, its priority chip, and its
  labels up to 3 with `+N` for the remainder. This is today's card and it is
  preserved.
- **FR-25** A card MUST keep every chip it carries today when the underlying state is
  present: the branch chip, the pull-request pill with its CI dot, the run chip, the
  acceptance-gate chip, the `± N files` diff affordance, the **Run** control and the
  **Move →** menu.
- **FR-26** A card MUST show up to two **provenance chips** — one _origin_ (how this
  Task came to exist) and one _owner_ (what it belongs to) — with any remainder
  behind a `+N` that expands in the card menu.
- **FR-27** Provenance MUST be derived exclusively from state that already exists.
  No new column may be added to a Task to carry it. The derivations are:

    | Chip                     | Derived from                                             |
    | ------------------------ | -------------------------------------------------------- |
    | `Mission · {name}`       | the Task's Mission owner                                 |
    | `Idea · {title}`         | the Task's Idea owner                                    |
    | `Work · {name}`          | the Task's Work owner                                    |
    | `Team · {name}`          | the Task's Team owner                                    |
    | `Goal · {name}`          | the Task's Goal owner                                    |
    | `Agent · {name}`         | the Task's Agent owner — the Agent it is worked by       |
    | `⟳ {template title}`     | the Task points at the recurring template that cloned it |
    | `🕑 Scheduled {when}`    | the Task carries a one-shot scheduled time               |
    | `Trigger · {name}`       | an inbound-trigger fire recorded this Task as its result |
    | `Raised by {agent name}` | the Task was created by an Agent rather than a person    |
    | `Delegated · depth {n}`  | the Task carries a sub-agent delegation depth above zero |
    | `You` / `{person}`       | the Task was created by a person                         |

- **FR-28** Chip precedence when more than two apply MUST be: Trigger, then
  recurring template, then Mission, then Idea, then Work, then Team, then Goal, then
  Agent, then creator. The two shown MUST be the two highest-precedence that apply.
- **FR-29** A provenance chip whose target no longer exists or is not visible to the
  caller MUST be omitted, never rendered as a raw identifier or a broken link.
- **FR-30** A card MUST show a **Decision** chip with the count of open decisions
  attributable to that Task, and a primary **Open decision** action, whenever that
  count is at least one — in whichever column the Task's status places it.
- **FR-31** A card MUST show a comment-count chip whenever the Task's thread holds at
  least one message, displayed as `99+` above 99, linking to the thread.
- **FR-32** A parent Task MUST show a sub-task roll-up of the form `▣ {done}/{total}`
  whenever it has at least one sub-task, linking to its sub-task checklist.
- **FR-33** All text a card renders that originated with an Agent MUST be rendered as
  plain text — never as markup, never auto-linked — truncated for display with the
  full value in the accessible name.
- **FR-34** Every card MUST link to its Task detail page and MUST be operable by
  keyboard alone, preserving the existing `r`-to-run shortcut.

### 4.4 Priority

- **FR-35** The board MUST use the platform's existing Task priority scale and its
  existing labels, unchanged: `p0` Urgent · `p1` High · `p2` Medium · `p3` Normal
  (the stored default) · `p4` Low.
- **FR-36** The board MUST NOT introduce a second priority vocabulary, a different
  number of steps, or its own labels. The labels above already exist in the message
  catalogue and MUST be reused.
- **FR-37** Priority MUST order cards within a column (FR-9) and MUST be settable
  from the card menu without leaving the board, taking effect within one refresh.
- **FR-38** The board MUST offer priority as a multi-select filter.

### 4.5 Sub-tasks

- **FR-39** By default the board MUST show **top-level Tasks only** — Tasks with no
  parent Task.
- **FR-40** A **Show sub-tasks** toggle MUST flatten sub-tasks into the columns as
  their own cards, each in the column of its own status. This is today's behaviour
  and MUST remain reachable in one action.
- **FR-41** With sub-tasks hidden, a parent MUST carry the roll-up of FR-32, counting
  its direct sub-tasks only.
- **FR-42** A sub-task that matches the active filters while its parent does not MUST
  be shown as its own card carrying a `Sub-task of {parent}` chip, regardless of the
  toggle (S24).
- **FR-43** The board MUST NOT introduce nesting, indentation or expandable cards.
  The sub-task detail view is the parent Task's existing checklist.

### 4.6 Recurrence

- **FR-44** A recurring **template** — a Task row whose recurrence is switched on —
  MUST NOT appear as a card in any column by default. A template is a schedule, not
  a unit of work: it never transitions, and dragging it would move a row the
  dispatcher owns.
- **FR-45** Templates MUST instead be summarised in a **recurring strip** above the
  board, collapsed by default, reading the number of templates and when the next one
  fires. Expanding it MUST list each template with its cadence in plain language, its
  next fire time, and a link to its detail page.
- **FR-46** A template whose recurrence has ended or exhausted its occurrence count
  MUST be listed in the strip as ended, with its last fire, rather than omitted.
- **FR-47** A **Show templates** toggle MUST put template rows back into the columns
  — today's behaviour — where they MUST carry a `⟳ Template` chip and MUST NOT be
  draggable.
- **FR-48** An **instance** — a Task cloned from a template — MUST be an ordinary
  card, MUST be fully draggable, and MUST carry a `⟳ {template title}` provenance
  chip linking to its template.
- **FR-49** A one-shot **scheduled** Task — one carrying a future scheduled time — is
  a card, not a template, and MUST carry a `🕑 Scheduled {when}` chip until it fires.
- **FR-50** The recurring strip MUST link to the platform's existing schedules view
  rather than re-implementing a schedule list.

### 4.7 Attention — decisions and stalls

- **FR-51** The board header MUST show exactly two counters: **N waiting on you** and
  **N done today**, in that order.
- **FR-52** "waiting on you" MUST count Tasks with at least one open decision
  attributable to them, across every column and under the active filters.
- **FR-53** A decision is attributable to a Task when it is an open escalation raised
  on that Task, or a pending approval raised by a run dispatched for that Task.
- **FR-54** "done today" MUST count Tasks that reached `done` since local midnight in
  the viewer's timezone, and MUST reset at local midnight.
- **FR-55** Clicking "waiting on you" MUST filter the board to exactly those Tasks.
- **FR-56** The board MUST NOT render, rank or resolve a decision. It counts them,
  flags them and links out to them; the queue itself is [AW-03](../AW-03-decision-queue/).
- **FR-57** A Task MUST be flagged **Stalled** when all of the following hold: its
  status is `in_progress`; it has no run in a non-terminal state; and it has not
  changed for longer than the workspace stall threshold.
- **FR-58** The default stall threshold MUST be **2 days**, settable per workspace
  between **1 and 30 days**.
- **FR-59** A Task in any status other than `in_progress` MUST NOT be flagged
  stalled.
- **FR-60** The system MUST send at most **one** stall notification per Task per
  stalled streak; a Task that moves and stalls again MUST be eligible for one more.
  The notification MUST link directly to the Task.
- **FR-61** The stall signal MUST be derived from state the platform already stores.
  Deriving it from last-update time is permitted and is understood to under-report
  rather than over-report: an edit to a Task resets its last-update time and
  therefore clears the flag. The system MUST NOT report a Task as stalled when it is
  not.

### 4.8 Comments from the card

- **FR-62** The comment-count chip (FR-31) MUST open the Task's existing thread. The
  board MUST NOT introduce a second thread, a second comment noun, or a second set
  of comment rules.
- **FR-63** A reply composed from the board MUST behave identically to one composed
  on the Task detail page — same body limit, same edit window, same mention parsing,
  same delivery **into a live run** when the mentioned Agent already has one, same
  refusal message when dispatch is refused.
- **FR-64** The board MUST NOT change, relax or duplicate the existing rate limit on
  posting to a Task's thread.

### 4.9 Permissions, scope and limits

- **FR-65** Every board read and every board mutation MUST be scoped to the calling
  user and, when an Organization scope is active, to that Organization, using the
  platform's existing ownership filter.
- **FR-66** A request for a Task the caller does not own MUST return 404 with an
  identical body for every operation.
- **FR-67** The board read MUST be rate-limited no more permissively than the
  existing Task list endpoint, and board mutations MUST reuse the existing per-route
  limits on transition, run and batch-run. No new limit may be more permissive than
  the one it sits beside.
- **FR-68** The board MUST NOT expose any Task field that the Task detail page does
  not already expose to the same caller.
- **FR-69** Provenance resolution MUST be owner-scoped: the board MUST NOT reveal the
  name of a Mission, Work, Team, Goal or Agent the caller cannot otherwise see.

### 4.10 Accessibility and internationalisation

- **FR-70** Every column MUST be a labelled region announcing its name and its live
  count; count changes MUST be announced politely, not assertively.
- **FR-71** Every card MUST be reachable and operable by keyboard alone: focus moves
  within and between columns, `Enter` opens the Task, `r` runs it, and the card menu
  is reachable without a pointer. Every drag action MUST have a card-menu equivalent.
- **FR-72** The Stalled flag, the Decision chip, the priority chip and every
  provenance chip MUST each carry a text alternative; colour MUST NOT be the only
  carrier of any of them.
- **FR-73** Every user-visible string on the board MUST come from the message
  catalogue. No string may be hardcoded, including the ones hardcoded today.
- **FR-74** Every leaf key name added to the catalogue MUST be camelCase and MUST NOT
  contain a literal dot, and every parent key on the path MUST exist, so that a
  missing key can never collapse a subtree.
- **FR-75** All dates on the board MUST render in the viewer's locale and timezone,
  and relative times MUST carry the absolute time in their tooltip and accessible
  name.

---

## 5. Key entities

### 5.1 Already in Ever Works — used as-is

| Concept                            | What it is today                                                                                                                                                                                                                                                                                                                                                                                                                            | What this epic does with it                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task**                           | A trackable work item assigned to people or Agents. Status (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`), priority (`p0`–`p4`), labels, slug, six independent nullable owners (Mission, Idea, Work, Team, Agent, Goal), a parent Task, recurrence, one-shot scheduling, branch and pull-request state, a latest-run denormalisation, acceptance gates, a hidden-from-board marker, and eleven side tables | **Nothing is added.** The board is a read over what is there                                                                                                  |
| **Mission**                        | A long-running initiative that continuously drives Idea generation and, via Ideas, Work creation. Statuses `active`, `paused`, `completed`, `failed`; type one-shot or scheduled; no priority; ticks on a cron                                                                                                                                                                                                                              | Appears on the board only as a **filter** and as a **provenance chip on a card**. Never as a card. Never given a priority, a comment thread or a board column |
| **Run**                            | One Agent execution, already linked to a Task and already denormalised onto it                                                                                                                                                                                                                                                                                                                                                              | Read for the run chip and for the stall signal. Unchanged                                                                                                     |
| **Escalation / Approval**          | The two shapes of "a human must decide", already readable per Task                                                                                                                                                                                                                                                                                                                                                                          | Counted for the Decision chip and the header counter. The board links out; [AW-03](../AW-03-decision-queue/) owns the queue                                   |
| **Task chat message**              | The per-Task comment thread, with mentions, a 5-minute edit window, and delivery into a live run through the existing steering seam                                                                                                                                                                                                                                                                                                         | Surfaced as a card chip and a reply affordance. **No new comment noun**                                                                                       |
| **Task watcher**                   | An explicit subscription to a Task's transitions                                                                                                                                                                                                                                                                                                                                                                                            | Not surfaced by this epic. See §5.4                                                                                                                           |
| **Inbound trigger / trigger fire** | Signed webhook delivery that creates Tasks, with a fire log recording which Task each fire produced                                                                                                                                                                                                                                                                                                                                         | The fire log is read backwards to attribute a `Trigger` chip. Unchanged                                                                                       |
| **Notification**                   | Existing in-product notifications, with a Task category and a per-user deduplication key                                                                                                                                                                                                                                                                                                                                                    | Gains one stall kind. The category and the dedupe mechanism already exist                                                                                     |
| **Activity log**                   | Already records Task created, updated, transitioned, commented, completed and recurrence-fired                                                                                                                                                                                                                                                                                                                                              | Read only. The board writes no new activity type of its own beyond what the existing transition and run paths already write                                   |

### 5.2 Task — status, and what the board does with it

The **stored status** and the **board column** are almost the same thing, and that is
deliberate. A column is a status (Status layout) or a named group of statuses (Focus
layout), and nothing else. A board whose columns are derived from anything but status
can disagree with the work, and the moment it does the user stops trusting it.

```
  TASK STATUS (existing, stored, unchanged by this epic)

     backlog ──► todo ──► in_progress ──► in_review ──► done
        │         │  ▲         │  ▲  ▲        │  │        │
        │         │  │         │  │  └────────┘  │        │
        │         ▼  │         ▼  │              │        │
        │      blocked─┘    blocked              │        │
        │         │            │                 │        │
        └─────────┴────────────┴─────────────────┴────► cancelled
                                                          (terminal)
                                              done ──► in_progress (reopen)

  Entering `blocked` stashes the previous status; leaving it restores.
  `cancelled` permits no outgoing transition.


  BOARD COLUMN (a presentation of status, never a second state)

    Status layout (default, 7 columns)      Focus layout (4 columns + toggle)

      backlog      → Backlog                  backlog, todo    → Backlog
      todo         → To do                    in_progress      → In flight
      in_progress  → In progress              in_review,       → Needs you
      in_review    → In review                  blocked
      blocked      → Blocked                   done             → Done
      done         → Done                      cancelled        → Cancelled
      cancelled    → Cancelled                                    (toggle)


  CARD FLAGS (derived at read time, never stored, never a column)

    open decisions ≥ 1                     → Decision chip + "waiting on you"
    in_progress, no live run, no change    → Stalled flag
      for longer than the threshold
```

**Priority** is an ordering attribute, not a state, and it is the platform's existing
one: `p0` Urgent · `p1` High · `p2` Medium · `p3` Normal (stored default) · `p4` Low.

> **A correction to the program vocabulary table.** [README §1.1](../README.md) lists
> the Task priority scale as `p0 · p1 · p2 · p3`. The entity and the message
> catalogue both carry **five** steps, `p0`–`p4`, with `p4` labelled Low and already
> translated. Five is the truth; §9 asks for README §1.1 to be corrected in the same
> PR that lands this epic.

### 5.3 What "needs you" means here, and what it does not

The program's operating loop needs one place that answers _what is waiting on me_.
This epic supplies the **signal** and the **count**; it does not supply the queue.

- A Task in `in_review` or `blocked` is work that has **stopped and needs a person**.
  That is a status, and in the Focus layout it is a column.
- A Task with an **open decision** is work that is running and has hit something only
  a human can answer. That is not a status — it can happen in any column — so it is a
  **chip and a counter**, never a column. Making it a column would put the board in
  the position of disagreeing with the Task's own status.
- The **decision itself** — its content, its ranking, its resolution — belongs to
  [AW-03](../AW-03-decision-queue/). The board counts and links; it does not render.

### 5.4 Explicitly not new entities

This epic adds **no entity, no table and no column**. Each candidate was considered
and rejected on the same test: does Ever Works already have this?

- **No Task comment noun.** The platform already has a per-Task thread with mentions,
  an edit window, and — the hard part — delivery into a live run through an existing
  steering seam rather than restarting it. Everything a board comment would need is
  built. The board surfaces it; it does not re-declare it.
- **No board watcher.** A Task watcher entity already exists and already drives
  transition notifications. It is currently unreachable from any UI, which is a real
  gap — but it is a _notification_ gap, and notification surfaces belong to
  [AW-13](../AW-13-attention-controls/). This epic does not claim it, and explicitly
  records it as an unbound backend so it is not rediscovered as missing.
- **No last-progress column.** A twelfth denormalised column on Task to carry "when
  did this last really move" is tempting and wrong. The Task already carries a
  latest-run status and a last-update time, and the platform already records every
  transition, comment and run in the activity log. The stall signal is derived from
  those (FR-57, FR-61), and it deliberately under-reports rather than adding storage
  that can drift. If a precise progress timestamp is ever needed, it belongs on the
  run or in the activity trail, not on the Task.
- **No comment-count column.** The count is a grouped read over the existing thread
  table. Denormalising it means a writer on every post path and a repair job when it
  drifts, for a chip.
- **No board, swimlane or saved-view entity.** A board is a view of Tasks under a
  filter. The filter lives in the URL, and P3's saved views are named URLs stored
  with the user's existing preferences.
- **No Task origin column.** Every origin the card shows is already recoverable:
  from the Task's owners, from its recurrence pointer, from its scheduled time, from
  its creator type, from its delegation depth, or from the trigger fire log that
  already records which Task each fire produced.
- **No Mission priority, Mission comment, Mission watcher or Mission staleness.** A
  Mission is not a unit of work and does not belong on this board as a card. If any
  of those are ever wanted, they belong on Task, where they already exist.

---

## 6. UX

### 6.1 Where it lives

`/tasks` — the surface that exists today, under the tab strip that already carries
**Tasks** and **Triggers**. The view switcher that already carries **Cards** and
**Table** gains nothing new: **Board** is already there. What changes is that the
switcher's state lives in the URL and is remembered, and that Board is the default.

The same component renders on every scoped Task list that mounts it today —
`/missions/[id]/tasks`, `/works/[id]/tasks`, `/ideas/[id]/tasks` — with the scope
pre-applied and locked.

### 6.2 Board — populated (Status layout)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Tasks                                                                           │
│ Everything you and your Agents are working on.                                  │
│                                                                                 │
│  ● 3 waiting on you   ·   ✓ 7 done today       [Browse templates] [+ New Task]  │
│                                                                                 │
│ ┌───────┬──────────┐   ┌──────────────────────────────────────────────────────┐ │
│ │ Tasks │ Triggers │   │ 🔍 Search  Priority▾ Label▾ Mission▾ Work▾ Agent▾    │ │
│ └═══════┴──────────┘   └──────────────────────────────────────────────────────┘ │
│                        ┌───────┬───────┬─────────┐  ┌──────────┬────────┐       │
│                        │ Cards │ Table │ ▣ Board │  │ Status ▾ │ ⚙ View │       │
│                        └───────┴───────┴═════════┘  └──────────┴────────┘       │
│ ⟳ 4 recurring Tasks · next fires in 2h                                   [Show] │
├───────────┬──────────┬─────────────┬───────────┬─────────┬────────┬────────────┤
│○Backlog 12│○ To do 31│◐In progress4│👁In review2│⊘Blocked1│✓ Done 9│✕Cancelled 3│
├───────────┼──────────┼─────────────┼───────────┼─────────┼────────┼────────────┤
│┌─────────┐│┌────────┐│┌───────────┐│┌─────────┐│         │        │            │
││T-104 p0 ││T-88  p0 ││T-91     p1 ││T-77   p2││         │        │            │
││Refresh  ││Rewrite ││Weekly link ││Publish  ││         │        │            │
││pricing  ││the FAQ ││health sweep││the Q3   ││         │        │            │
││▣ 2/5    ││        ││⚠ Stalled   ││changelog││         │        │            │
││Mission ·││Trigger·││⟳ Weekly    ││● 1 dec. ││         │        │            │
││ Pricing ││ Stripe ││ Agent·Edit ││[Open    ││         │        │            │
││💬 3     ││        ││± 12 files  ││ decision]│         │        │            │
││Move→  ▶r││Move→ ▶r││Move→    ▶r ││Move→  ▶r││         │        │            │
│└─────────┘│└────────┘│└───────────┘│└─────────┘│         │        │            │
│ … 11 more │ … 30 more│             │           │  empty  │        │ Last 7d ▾  │
└───────────┴──────────┴─────────────┴───────────┴─────────┴────────┴────────────┘
```

Column header glyphs are decorative; each column's accessible name is its label plus
its count ("To do, 31 Tasks").

### 6.3 Card anatomy

```
┌────────────────────────────────────────────────┐
│  T-91                            [p1]     [⋯]  │  slug · priority · menu
│  Weekly link health sweep                      │  title (2 lines max, then …)
│  ⚠ Stalled                                     │  flags
│  [⟳ Weekly link sweep] [Agent · Editor]        │  provenance, max 2, then +N
│  [branch] [PR #412 ●] [run] [gate]             │  existing chips, unchanged
│  ± 12 files                                    │  existing diff affordance
│  ▣ 2/5      💬 3      [seo] [content] [+2]     │  sub-tasks · comments · labels
│  Move →                       [▶ Run]   2d ago │  existing footer, unchanged
└────────────────────────────────────────────────┘
```

| Element                                                             | Rule                                                                             | New? |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| Slug, title, priority chip, labels, `Move →`, `▶ Run`, updated date | As today                                                                         | —    |
| Branch chip, PR pill with CI dot, run chip, gate chip, `± N files`  | As today                                                                         | —    |
| Stalled flag                                                        | `In progress` only, over threshold only. Tooltip: "No run since 3 Sep, 09:12"    | new  |
| Decision chip                                                       | Whenever open decisions ≥ 1, in any column. Carries the **Open decision** action | new  |
| Provenance chips                                                    | Up to 2 by the precedence of FR-28; the rest under `+N` in the menu              | new  |
| Sub-task roll-up                                                    | `▣ done/total` when the Task has sub-tasks                                       | new  |
| Comment count                                                       | Shown when ≥ 1; `99+` above 99                                                   | new  |
| `⟳ Template` chip                                                   | Only when **Show templates** is on. Card is not draggable                        | new  |
| `Hidden` chip                                                       | Only when **Show trigger-hidden Tasks** is on                                    | new  |

### 6.4 Card menu

```
                        ┌─────────────────────────────┐
                        │  Open Task                  │
                        │  Open thread                │
                        ├─────────────────────────────┤
                        │  Priority              ▸    │
                        │  Move to               ▸    │
                        ├─────────────────────────────┤
                        │  Run now                    │
                        │  Open decision (1)          │
                        ├─────────────────────────────┤
                        │  Raised by Mission · Pricing│
                        │  Belongs to Work · Docs     │
                        │  Filed by you · 2 Sep       │
                        └─────────────────────────────┘
```

The bottom block is the `+N` expansion of FR-26 — the provenance the card could not
fit — and each row links to the thing it names. Items that cannot apply are disabled
with the reason in their tooltip.

### 6.5 The recurring strip

Collapsed, above the columns:

```
│ ⟳ 4 recurring Tasks · next fires in 2h                                   [Show] │
```

Expanded:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ⟳ Recurring Tasks                                            [Hide]  [Schedules]│
│  Weekly link health sweep      Every Monday at 09:00      next in 2h            │
│  Monthly pricing audit         1st of the month, 06:00    next in 12 days       │
│  Daily inbox triage            Every day at 07:30         next in 19h           │
│  Old blog backfill             Every Friday               ended 22 Aug          │
│  These produce Tasks. They are not Tasks you move.        [Show as cards]       │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Schedules** links to the platform's existing schedules view, which already unifies
recurring Tasks with the platform's other cadences.

### 6.6 Focus layout

```
├──────────────────────┬────────────────────┬─────────────────┬────────────────────┤
│ ○ Backlog         43 │ ◐ In flight      4 │ ● Needs you   3 │ ✓ Done           9 │
│   backlog · to do    │   in progress      │  in review ·    │   done             │
│                      │                    │  blocked        │  Last 7 days ▾     │
```

Each Focus column names the statuses it groups, directly under its label, so the
mapping is never a guess. **Show cancelled** appends a fifth column.

The two-target drop picker (S16):

```
        ┌──────────────────────────────────┐
        │ Move "Weekly link sweep" to…     │
        │   ( In review )   ( Blocked )    │
        │                       [ Cancel ] │
        └──────────────────────────────────┘
```

### 6.7 Loading

```
├───────────┬──────────┬─────────────┬───────────┬─────────┬────────┬────────────┤
│ ○Backlog ▁│○ To do  ▁│◐In progress▁│👁In review▁│⊘Blocked▁│✓ Done ▁│✕Cancelled ▁│
├───────────┼──────────┼─────────────┼───────────┼─────────┼────────┼────────────┤
│ ▁▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁▁ │         │        │            │
│ ▁▁▁▁▁▁    │ ▁▁▁▁▁▁   │ ▁▁▁▁▁▁      │           │         │        │            │
```

Column frames with skeleton cards. The header counters render as `— waiting on you ·
— done today` until the data lands. Never a spinner over the whole page; the tab
strip, the view switcher and **+ New Task** stay usable.

### 6.8 Empty board

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                                     ▣                                           │
│                              No Tasks yet.                                      │
│    A Task is a piece of work you hand to an Agent or take on yourself. File     │
│    one and it lands in Backlog, ready to run.                                   │
│                                                                                 │
│                  [ + New Task ]      Browse templates                           │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 6.9 Empty column

Per-column empty copy, one line each:

| Column      | Copy                                         |
| ----------- | -------------------------------------------- |
| Backlog     | `Nothing in the backlog.`                    |
| To do       | `Nothing queued.`                            |
| In progress | `Nothing running.`                           |
| In review   | `Nothing to review.`                         |
| Blocked     | `Nothing blocked. 🎉`                        |
| Done        | `Nothing finished in the last {days} days.`  |
| Cancelled   | `Nothing cancelled in the last {days} days.` |

### 6.10 Over the column cap

```
│ ┌────────────────┐ │
│ │ …50th card…    │ │
│ └────────────────┘ │
│ Showing 50 of 140  │
│   [Show 50 more]   │
```

**Show 50 more** fetches the next page of that column only. The header keeps showing
140 throughout.

### 6.11 Error

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ⚠  Couldn't load the board.                                                     │
│    Your Tasks are safe — this is a display problem.                             │
│    [ Try again ]      Open the Table view instead                               │
└────────────────────────────────────────────────────────────────────────────────┘
```

Rendered inside the board area, below the still-visible tab strip, view switcher and
header. If one column's read fails and the others succeed, only that column shows the
panel.

### 6.12 The stalled flag and its notification

On the card:

```
│  ⚠ Stalled                                     │
│    tooltip: In progress since 3 Sep. No run    │
│             for 3 days.                        │
```

The notification, once per stalled streak:

```
   {title} hasn't moved in {days} days
   It's been in progress since {date} with nothing running. Open it to see
   where it stopped.
```

### 6.13 Narrow viewports

The board already scrolls horizontally with a minimum width. Below 640 px it collapses
to a single-column accordion with a column picker at the top; the default open column
is the first non-empty of `In progress`, `In review`, `To do`.

```
┌──────────────────────────────┐
│ (Backlog 12) (To do 31)      │
│ (•In progress 4) (Done 9)    │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ T-91                  p1 │ │
│ │ Weekly link health sweep │ │
│ │ ⚠ Stalled                │ │
│ │ ⟳ Weekly link sweep      │ │
│ └──────────────────────────┘ │
```

### 6.14 Keyboard affordances

| Key                       | Where                   | Action                                        | New?     |
| ------------------------- | ----------------------- | --------------------------------------------- | -------- |
| `r`                       | Card focused            | Run the Task                                  | existing |
| `n`                       | Board, no field focused | New Task                                      | new      |
| `/`                       | Board, no field focused | Focus the search box                          | new      |
| `←` `→`                   | Card focused            | Move focus to the adjacent column, same index | new      |
| `↑` `↓`                   | Card focused            | Move focus within the column                  | new      |
| `Home` `End`              | Card focused            | First / last card in the column               | new      |
| `Enter`                   | Card focused            | Open the Task                                 | new      |
| `Shift`+`F10` or menu key | Card focused            | Open the card menu                            | new      |
| `1`…`5`                   | Card menu → Priority    | Set Urgent…Low                                | new      |
| `Esc`                     | Anywhere                | Close the topmost dialog, menu or popover     | new      |

The board uses one tab stop per column with roving focus inside it, so tabbing across
seven columns is seven stops, not 350. Shortcuts are ignored while a text input has
focus and while the diff sheet is open — the existing `r` handler already does both
and is the model.

### 6.15 Exact user-visible copy

Every string below is a catalogue key. Ones marked **†** replace a string hardcoded in
the board today; ones marked **‡** already exist in the catalogue and are reused, not
re-declared.

| Where                   | String                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page subtitle           | `Everything you and your Agents are working on.`                                                                                                                                                                              |
| Header counters         | `{count} waiting on you` · `{count} done today`                                                                                                                                                                               |
| View switcher           | `Cards` **†** · `Table` **†** · `Board` **†**                                                                                                                                                                                 |
| Layout switcher         | `Status` · `Focus`                                                                                                                                                                                                            |
| Status column names     | `Backlog` · `To do` · `In progress` · `In review` · `Blocked` · `Done` · `Cancelled` **‡**                                                                                                                                    |
| Focus column names      | `Backlog` · `In flight` · `Needs you` · `Done`                                                                                                                                                                                |
| Focus column subtitles  | `backlog · to do` · `in progress` · `in review · blocked` · `done`                                                                                                                                                            |
| Priority labels         | `Urgent` · `High` · `Medium` · `Normal` · `Low` **‡**                                                                                                                                                                         |
| Sort tooltip            | `Urgent first, then oldest first.`                                                                                                                                                                                            |
| Column window           | `Last {days} days`                                                                                                                                                                                                            |
| Card move menu          | `Move →` **†**                                                                                                                                                                                                                |
| Column batch run        | `Run all` **†** · `Run {count} Tasks in {column}` **†**                                                                                                                                                                       |
| Column overflow         | `Showing {shown} of {total}` · `Show {n} more` **†**                                                                                                                                                                          |
| Column empty            | `Nothing running.` etc. — see §6.9 **†** (today: `empty`)                                                                                                                                                                     |
| Diff affordance tooltip | `Preview the changes on this Task's branch` **†**                                                                                                                                                                             |
| Stalled flag            | `Stalled` — tooltip `In progress since {date}. No run for {days} days.`                                                                                                                                                       |
| Decision chip           | `{count} decisions` / `1 decision` · action `Open decision`                                                                                                                                                                   |
| Sub-task roll-up        | `{done}/{total} sub-tasks`                                                                                                                                                                                                    |
| Comment count           | `{count} comments` / `1 comment`                                                                                                                                                                                              |
| Provenance chips        | `Mission · {name}` · `Idea · {title}` · `Work · {name}` · `Team · {name}` · `Goal · {name}` · `Agent · {name}` · `Trigger · {name}` · `Scheduled {when}` · `Raised by {agentName}` · `Delegated · depth {n}` · `Filed by you` |
| Recurring instance chip | `⟳ {templateTitle}`                                                                                                                                                                                                           |
| Recurring strip         | `{count} recurring Tasks · next fires {when}` · `Show` · `Hide`                                                                                                                                                               |
| Recurring strip lead    | `These produce Tasks. They are not Tasks you move.`                                                                                                                                                                           |
| Recurring strip ended   | `ended {date}`                                                                                                                                                                                                                |
| Template chip           | `Template` — tooltip `A recurring template. It creates Tasks; it isn't one you move.`                                                                                                                                         |
| Toggles                 | `Show sub-tasks` · `Show templates` · `Show cancelled` · `Show trigger-hidden Tasks`                                                                                                                                          |
| Hidden chip             | `Hidden` — tooltip `A Trigger keeps this off the board.`                                                                                                                                                                      |
| Sub-task-of chip        | `Sub-task of {parentTitle}`                                                                                                                                                                                                   |
| Board error             | `Couldn't load the board.` / `Your Tasks are safe — this is a display problem.` / `Try again` / `Open the Table view instead`                                                                                                 |
| Empty board             | `No Tasks yet.` / `A Task is a piece of work you hand to an Agent or take on yourself. File one and it lands in Backlog, ready to run.`                                                                                       |
| Cancelled drop refusal  | `A cancelled Task can't be reopened.`                                                                                                                                                                                         |
| Two-target drop picker  | `Move "{title}" to…`                                                                                                                                                                                                          |
| Clear filters           | `Clear filters`                                                                                                                                                                                                               |
| Stall notification      | `{title} hasn't moved in {days} days` / `It's been in progress since {date} with nothing running. Open it to see where it stopped.`                                                                                           |

---

## 7. Out of scope

- **The decision queue itself.** The board counts decisions, flags them and links to
  them. Rendering, ranking and resolving them is [AW-03](../AW-03-decision-queue/).
- **The activity trail.** The board shows state, not history. Narration is
  [AW-04](../AW-04-live-feed/); per-execution receipts are [AW-09](../AW-09-runs-receipts/).
- **The schedules surface.** The recurring strip summarises and links out. The
  calendar, the heartbeats and the never-run detection are [AW-10](../AW-10-schedules-calendar/).
- **Watchers.** The entity exists and is unreachable from any UI. Binding it is a
  notification concern and belongs to [AW-13](../AW-13-attention-controls/); this
  epic records the gap and does not claim it.
- **Cost on the card.** A per-Task spend rollup already exists at the Task's own
  endpoint. Putting a live figure on every card is a per-card fan-out and belongs
  with the cost meters in [AW-17](../AW-17-costs-caps/).
- **Anything about Missions as work.** No Mission priority, no Mission comment
  thread, no Mission watcher, no Mission staleness, no Mission on a board column. A
  Mission is a source of Tasks and appears here only as a filter and a chip.
- **Manual ordering inside a column.** Cards sort by rule (FR-9). Drag-to-reorder
  would create an ordering the runtime ignores.
- **Work-in-progress limits per column.** No column caps how much may sit in it.
- **Swimlanes.** One board, one set of columns, filters for everything else.
- **Archive and trash for Tasks.** Tasks already have `cancelled` as their
  reversible-by-status exit and a delete endpoint for the permanent one. A second
  removal concept would be a duplicate noun.
- **Extracting a shared board primitive.** Three Kanban views exist in the product
  and share no primitive. Unifying them is a refactor with its own blast radius and
  is recorded as a follow-up, not done here.
- **Renaming, retiring or changing the Cards view, the Table view, the `/tasks/new`
  form, the templates browser, the Triggers tab, or any Missions page.**

---

## 8. Acceptance criteria

**Columns and reads**

- [ ] Opening `/tasks` with no stored preference lands on the board.
- [ ] With 300 Tasks spread across statuses, every column header shows that status's
      true total, verified against a direct count.
- [ ] Fetching more of one column leaves every other column's rendered cards and
      scroll position untouched.
- [ ] The `Done` column defaults to a 7-day window, states it, and the window is
      adjustable between 1 and 90 days.
- [ ] Every column in the Status layout maps to exactly one `TaskStatus`, and all
      seven statuses have a column.
- [ ] In the Focus layout, `cancelled` is reachable via **Show cancelled**, and every
      cancelled Task is still visible without any toggle in the Status layout and in
      the Cards and Table views.
- [ ] A drop onto a Focus column with two legal targets opens the picker and applies
      only what the user chose.
- [ ] A drop the server refuses returns the card to its column and shows the server's
      reason.

**Ordering and priority**

- [ ] A `p0` Task last edited a month ago sorts above a `p3` edited today, in the same
      column.
- [ ] A stalled Task sorts above every non-stalled Task in its column.
- [ ] The board uses `p0`–`p4` with the labels Urgent, High, Medium, Normal, Low, and
      declares no priority vocabulary of its own.

**Addressability**

- [ ] Switching to Table puts the choice in the URL; reloading that URL lands on
      Table.
- [ ] A filtered board's URL, opened by another user with access, reproduces the same
      filter and the same counts for their own Tasks.
- [ ] Clicking a label chip filters the board by that label and updates every count.
- [ ] Clicking a Mission provenance chip filters the board to that Mission's Tasks,
      and no Mission renders as a card.
- [ ] The page's existing server-rendered filter form and the board's filters stay in
      sync.

**The card**

- [ ] Every chip the card carries today — branch, PR with CI dot, run, gate, diff —
      still renders under the same conditions.
- [ ] A Task raised by a Mission, one produced by a Trigger fire, one cloned from a
      recurring template and one filed by a person each show a distinct provenance
      chip naming the right thing.
- [ ] A Task with three applicable provenance sources shows the two highest by the
      declared precedence and the rest in its menu.
- [ ] A Task whose Mission was deleted renders without a Mission chip and without an
      error.
- [ ] A Task with an open escalation shows a Decision chip and an **Open decision**
      action while staying in the column of its own status.
- [ ] A Task with 150 thread messages shows `99+`.
- [ ] An Agent-supplied title containing markup renders as literal text.

**Sub-tasks**

- [ ] A parent with five sub-tasks, two done, renders as one card carrying `2/5`, and
      its sub-tasks are not separate cards.
- [ ] **Show sub-tasks** restores today's flat behaviour exactly.
- [ ] A sub-task matching an active filter whose parent does not match renders as its
      own card with a `Sub-task of` chip.

**Recurrence**

- [ ] A recurring template appears in the strip and in no column.
- [ ] The strip states the next fire time and the cadence in plain language.
- [ ] An ended template is listed as ended rather than omitted.
- [ ] **Show templates** puts template rows back in the columns, chipped as templates
      and not draggable.
- [ ] An instance is an ordinary, draggable card carrying its template's name.
- [ ] A one-shot scheduled Task shows a scheduled chip and is not treated as a
      template.

**Attention**

- [ ] "waiting on you" equals the number of Tasks with at least one open decision,
      under the active filters, and clicking it filters the board to exactly those.
- [ ] "done today" counts Tasks that reached `done` since the viewer's local midnight
      and resets at local midnight.
- [ ] A Task `in_progress` for 49 hours with no live run is flagged at the default
      threshold; one at 47 hours is not; one at 49 hours with a running run is not.
- [ ] A Task in `blocked` for a week is not flagged stalled.
- [ ] Exactly one stall notification is sent per stalled streak, and it links to the
      Task.

**Hidden and scoped work**

- [ ] Trigger-hidden Tasks appear in no column and no count until the toggle is on,
      and are chipped when revealed.
- [ ] `/missions/[id]/tasks`, `/works/[id]/tasks` and `/ideas/[id]/tasks` render the
      board with their scope locked, and their existing behaviour is unchanged.

**Isolation and limits**

- [ ] Every board read and mutation for another user's Task returns 404 with an
      identical body.
- [ ] Provenance never names a Mission, Work, Team, Goal or Agent the caller cannot
      otherwise see.
- [ ] Board reads and mutations are throttled no more permissively than the endpoints
      they sit beside.

**Failure and empty states**

- [ ] A failed board read renders the error panel with the column frames intact.
- [ ] A failed decision-count read drops the Decision chips and leaves the rest of the
      board working.
- [ ] A user with zero Tasks sees the empty board, not seven empty columns.

**Cross-cutting**

- [ ] No string on the board is hardcoded; the seven status names and the five
      priority labels resolve from the keys that already exist rather than from new
      duplicates.
- [ ] Every added leaf key is camelCase, contains no literal dot, and has an existing
      parent, verified by the catalogue's locale-structure check across all locales.
- [ ] The board passes an automated accessibility scan with no serious or critical
      violations.
- [ ] No migration ships with this epic, and the entity files are unchanged.
- [ ] All functional requirements have a passing unit, controller or end-to-end test.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: the program vocabulary table says p0–p3.]`
  [README §1.1](../README.md) lists Task priority as four steps. The entity and the
  message catalogue both carry five, `p0`–`p4`, with `p4` already labelled Low and
  already translated. This spec follows the code. **Recommendation:** correct README
  §1.1 to `p0 · p1 · p2 · p3 · p4` in the PR that lands this epic.
- `[NEEDS CLARIFICATION: which layout is the default.]` This spec keeps the shipped
  seven-column Status layout as the default and offers Focus as an option, on the
  grounds that the shipped behaviour should not change under a user without their
  asking. The program README's four-column reading argues for Focus as the default.
  **Recommendation:** ship Status as the default in P1 and revisit after the first
  usage read, rather than deciding it here.
- `[NEEDS CLARIFICATION: whether "waiting on you" should also count in_review and
blocked.]` As specified, the counter counts open decisions only, and `in_review` /
  `blocked` are visible as columns. An owner may reasonably read "waiting on you" as
  all three. **Recommendation:** decisions only — the counter should mean "something
  is asking you a question", which a blocked Task is not.
- `[NEEDS CLARIFICATION: where the stall threshold is configured.]` The proposal is
  one workspace-level number alongside the existing Task and Mission defaults.
  Should it instead be per Work, so a long-running research Work can say "flag me
  after 14 days"?
- `[NEEDS CLARIFICATION: the accuracy of the derived stall signal.]` FR-61 derives
  "no progress" from last-update time, which an edit resets. This under-reports and
  never over-reports. Is that acceptable for v1, or is a precise progress timestamp
  wanted immediately — in which case it belongs on the run or the activity trail, not
  as a new Task column?
- `[NEEDS CLARIFICATION: the Done column's default window.]` Seven days is proposed,
  to match the other terminal windows in the product. A one-day window would instead
  make the "done today" counter and the Done column agree with each other.
- `[NEEDS CLARIFICATION: sub-task roll-up depth.]` FR-41 counts direct sub-tasks only.
  Delegation can nest deeper. Should the roll-up count the whole subtree, at the cost
  of a recursive read on every board load?
- `[NEEDS CLARIFICATION: board scope under an Organization.]` The board is user-owned
  and Organization-scoped like every other Task read. Confirm there is no near-term
  requirement for an Organization-wide board showing every member's Tasks before
  [AW-18](../AW-18-shared-dashboards/) lands.
- `[NEEDS CLARIFICATION: saved views.]` P3 proposes named URLs stored with the user's
  existing preferences. Confirm that is enough, or whether saved views need to be
  shareable objects — which would be a new noun and would need its own justification.

---

## 10. Non-functional requirements

- **Performance.** The board read must serve P95 under 400 ms for a workspace with
  5,000 Tasks, 200 open decisions and 50 recurring templates, in a bounded number of
  queries that does not grow with the number of cards. Provenance, decision counts,
  sub-task roll-ups and comment counts must each be one batched read across the whole
  page of cards, never one read per card. The page must render its column frames
  before the board data arrives.
- **Correctness.** A column is a pure function of stored status and the active
  filters. Two clients reading the same instant place a Task in the same column. The
  board never displays a count it did not compute from the same predicate that
  produced the cards.
- **Reliability.** Every enrichment degrades independently (FR-13). A failure in the
  decision-count query drops the Decision chips and the header counter to
  "unavailable"; it never fails the board.
- **Security and privacy.** Every read and write is owner- and scope-filtered.
  Provenance resolution is scope-filtered, so the board cannot be used to enumerate
  names of objects the caller cannot see. Agent-authored text on a card is untrusted:
  plain text only, never interpreted as markup, never auto-linked.
- **Observability.** Board opens by layout, column composition, stall flags raised,
  decision chips shown, per-column paging, filter use and every transition performed
  from the board are recorded (see [`plan.md`](./plan.md) §9).
- **Compatibility.** No existing Task endpoint changes its response shape
  incompatibly. Every new request parameter is optional and its absence reproduces
  today's behaviour exactly. The Cards and Table views, every scoped Task list, and
  every Missions page are unchanged.

---

## 11. Constitution gates

- [x] **I — Plugin-first.** No external integration is introduced. Nothing here talks
      to a third-party service.
- [x] **II — Capability-driven.** No plugin id appears anywhere in this feature. Agent
      execution is reached through the existing dispatch and transition seams the
      board already uses, not a named provider.
- [x] **III — Source-of-truth repos.** The board reads platform metadata only. No Work
      content moves into the database, and no Task content moves out of it.
- [x] **IV — Job-runtime provider.** The one recurring job this epic adds — the stall
      sweep — goes through the configured job-runtime provider, in the same shape as
      the recurrence and pull-request-status dispatchers that already run. Every run
      the board dispatches continues to go through the existing gated path.
- [x] **V — Forward-only migrations.** **No schema change ships with this epic**, so
      no migration is required. Should a stored progress timestamp later be adopted
      (§9), it ships as a forward-only additive migration in the API's migrations
      directory, in the same PR as the column.
- [x] **VI — Tests first-class.** Column mapping, drop-target resolution, provenance
      precedence, the stall predicate and the sub-task roll-up get unit tests; the
      board read endpoint and each new query parameter get controller specs; the
      board, its filters, its provenance and its recurring strip get end-to-end
      coverage.
- [x] **VII — Secrets.** No secret is introduced, read or logged. The board never
      surfaces a trigger secret; it surfaces only a trigger's name.
- [x] **VIII — Plugin counts.** No plugin is added; the canonical plugin doc is
      untouched.
- [x] **IX — Behaviour-first spec.** This document names no class, file or library.
- [x] **X — Backwards compatibility.** Every new request and response field is
      additive and optional. Every new default that changes what a user sees — the
      board as the landing view, top-level Tasks only, templates out of the columns —
      has an explicit toggle that restores today's behaviour in one action.

---

## 12. Cross-references

- Implementation plan: [plan.md](./plan.md)
- Task breakdown: [tasks.md](./tasks.md)
- Program overview and the `Task` vs `Mission` distinction: [../README.md](../README.md) §1, §1.1
- What is already built and unbound: [../EXISTING-SUBSTRATE.md](../EXISTING-SUBSTRATE.md)
- My Decisions (the queue this board counts and links into): [../AW-03-decision-queue/](../AW-03-decision-queue/)
- Live Feed (the history this board deliberately does not show): [../AW-04-live-feed/](../AW-04-live-feed/)
- Runs and receipts (what a run chip links to): [../AW-09-runs-receipts/](../AW-09-runs-receipts/)
- Schedules and calendar (where the recurring strip hands off): [../AW-10-schedules-calendar/](../AW-10-schedules-calendar/)
- Attention controls (where watchers and notification routing belong): [../AW-13-attention-controls/](../AW-13-attention-controls/)
- Home (which embeds a board summary): [../AW-19-home/](../AW-19-home/)
- Task tracking as it exists today: [../../task-tracking/](../../task-tracking/)
- Missions, Ideas and Works — the source side: [../../missions-ideas-works/](../../missions-ideas-works/)
- Schedules: [../../schedules/spec.md](../../schedules/spec.md)
