# AW-19 — Home, the morning screen

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> This document describes **what a user sees and can do**. No class names, no file
> paths, no code — those live in [`plan.md`](./plan.md).

**Feature ID**: `aw-19-home`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-19-home`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: M · **Blocking dependencies**: [AW-02](../AW-02-task-board/), [AW-03](../AW-03-decision-queue/), [AW-04](../AW-04-live-feed/)
**Extends**: the dashboard home route (existing) · **Adjacent epics**: [AW-01 Command palette](../AW-01-command-palette/), [AW-09 Runs & receipts](../AW-09-runs-receipts/), [AW-10 Schedules & calendar](../AW-10-schedules-calendar/), [AW-17 Costs & caps](../AW-17-costs-caps/), [AW-20 Onboarding](../AW-20-onboarding/)

> **Additive by default (program rule #1).** Nothing here deletes a block, a
> route, an endpoint or an i18n key. Every section that renders on Home today
> still renders after this epic — the inventory blocks (stats strip, Missions
> preview, Ideas, recent Works, Tasks, Agents) move *below* the new morning
> stack, and the two signal blocks that already exist (needs-attention, coming-up)
> are **widened in place** rather than replaced. One new entity is introduced
> (a per-user Home preference row) and is justified in §5.4.

> **Dependency posture.** Home is a *reader*. It composes signals that
> AW-02 / AW-03 / AW-04 own. It must therefore degrade cleanly when those epics
> have not landed: §4.11 pins exactly what each block reads today and what it
> switches to once its owning epic ships. Home never becomes the only place a
> signal exists.

---

## 0. TL;DR

```
   /  (Home)
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Good morning, Dana.                                       Fri 6 Sep     │
   │ 3 need you · 2 working now · 7 done today · 1 failed                    │
   │ ┌─────────────────────────────────────────────────────────────────────┐ │
   │ │ Hand something to your agents…                            [ Send ]  │ │  ← composer
   │ └─────────────────────────────────────────────────────────────────────┘ │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ NEEDS YOU                                              Open all (3) →   │
   │  ⚑ Approve · Publish the September notes     waiting 2h  [Yes][No]      │
   │  ? Question · Which category for these items?  waiting 20m    [Open]    │
   │  ! Escalation · Merge refused on T-241          waiting 1d     [Open]   │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ TODAY AT A GLANCE                                                       │
   │   3 need you    2 working now    7 done today    1 failed today         │
   ├──────────────────────────────────┬──────────────────────────────────────┤
   │ TODAY                            │ THIS WEEK                            │
   │  ✓ 06:15  Daily inbox sweep      │  $18.42  last 7 days · Acme          │
   │    09:00  Weekly report          │  61 runs · $0.30 avg per run         │
   │    14:00  Catalog price check    │  [████████░░] 78% account-wide cap   │
   │    +2 more →                     │  Manage spend →                      │
   ├──────────────────────────────────┴──────────────────────────────────────┤
   │ WORKING NOW (2)                                        See all runs →   │
   │  ● Research agent   Reading the September changelog…            14m     │
   │  ● Writer           Drafting the September summary…              3m     │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ RECENT ACTIVITY                                       Open the feed →   │
   │  07:02  Mission "Q3 catalog sweep" completed                            │
   │  06:58  Task T-240 moved to In review                                   │
   │  …                                                                      │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ ▸ Your workspace   (the existing stats strip + previews, unchanged)     │
   └─────────────────────────────────────────────────────────────────────────┘
```

Home is the first screen after login and the most-visited route in the product.
Today it answers *"how big is my workspace?"* — twelve total-count tiles, a list
of Works, a list of Ideas. It does not answer the question the owner actually
opens it with: **"what happened while I was away, what needs me, and what is
coming?"**

This epic turns Home into a **morning screen**: one sentence in a composer hands
out work; a decision block shows exactly what is blocked on the human and lets
the easy ones be answered in place; four time-bounded counters replace guessing;
today's cadence and this week's spend sit side by side; a live block names who is
working and on what; and a short activity tail links into the feed. Everything
that is on Home today survives, collapsed under one heading below the fold.

Three phases, each independently shippable:

- **P1 — The morning read.** One composed summary behind the whole stack; the six
  read blocks; the composer creating a Task from one sentence; the existing
  blocks relocated below.
- **P2 — Answer without leaving.** Inline answering in the decision block, the
  Home preference row (hide / reorder blocks), the composer's expand-to-full-form.
- **P3 — Keeping it live.** 60-second background refresh with a "new since you
  opened this" pill, per-block retry, staleness chips, keyboard affordances.

---

## 1. Overview

A user signs in and lands on **Home**. A greeting names them and the date; one
line under it scores the night — how many things need them, how many agents are
working, how much finished, how much failed. A single text field invites one
sentence, and one sentence is enough: typing *"summarise every item added this
week and flag the duplicates"* and pressing Enter creates a Task, which lands in
the Task board's Backlog lane and starts being picked up.

Below the composer, a **Needs you** block lists everything blocked on a human
decision — an approval an agent is waiting on, a question it asked, an escalation
it raised — oldest first, each row saying how long it has been waiting. Items
that came with a small set of choices can be answered from Home in one click; the
rest link out. Answering unblocks the work that was waiting.

Then four **today** counters, a **Today** panel showing what already ran and what
is still due before midnight in the user's own timezone, a **This week** panel
with the last seven days of spend and how far the current billing period has
eaten into its cap, a **Working now** panel naming each running agent and the one
line it last reported, and a **Recent activity** tail linking into the feed.

Everything the current Home shows is still there, gathered under a collapsible
**Your workspace** heading at the bottom. A user who preferred the old screen
loses nothing; a user who opens Home to find out what happened now gets an
answer in one screen without scrolling into a second one.

---

## 2. Why now

### 2.1 The question this answers

> *"What happened, what needs me, and what is coming?"*

This is the first question of every working day for the person Ever Works is
built for: an owner who delegated work overnight and now has to decide whether
anything went wrong, whether anything is stuck on them, and what is about to
run. It is asked once at 07:00 and three or four more times before lunch.

### 2.2 What a user does today instead

| To find out… | Today they must… |
| --- | --- |
| Whether anything is blocked on me | Read the approvals block on Home (agent action proposals only), then open Inbox for questions and escalations — two surfaces, neither of which is complete on its own |
| What my agents finished overnight | Open the activity page and scroll, correlating timestamps by eye; there is no "today" boundary anywhere |
| Whether anything failed | Read the needs-attention block, which covers errored Agents, failed generations, blocked Tasks and budget overage — but not failed Runs, which is the most common failure |
| Who is working right now | Open the runs list and filter it to `running`; Home shows a *total* Agents count and an *active* Agents count, neither of which is "executing right now" |
| What is scheduled today | Read the coming-up block, which knows only two of the seven kinds of schedule the platform actually runs and shows the next three regardless of whether they are today or next month |
| What I have spent this week | Open settings, then Usage & Credits, then the Costs tab, then change the window to 7 days — four navigations from Home |
| Hand out a new piece of work | Open the "+ New" page, pick the right one out of eleven chips (Task, Mission, Idea, Agent and the Work kinds), fill a form, submit |

### 2.3 The five concrete gaps

1. **No delegation from Home.** The fastest path from "I want this done" to "an
   agent has it" is a multi-step form on another route. The most common act on an
   agent platform is the one with the most friction.
2. **The decision surface is split and incomplete.** Approvals render on Home;
   questions and escalations only render in Inbox. Neither surface says how long
   something has been waiting, so a decision can sit for three days without
   anything on screen getting louder.
3. **Nothing on Home is time-bounded.** Twelve tiles all say *total*. "Total
   Missions: 26" is the same number today, tomorrow and next month; it cannot
   answer "did anything happen last night?"
4. **The two signal blocks under-report.** The coming-up block silently drops
   five of the seven schedule kinds because it has no label for them, and it is
   not scoped to today. The needs-attention block has two signal kinds declared
   that nothing ever produces.
5. **Spend is four clicks away and never on the morning path.** The one tile that
   mentions money shows a month-to-date total with no cap context, no run count
   and no trend, and its only affordance is a deep link into settings.

### 2.4 Why one composed read instead of more blocks

Home currently issues roughly eighteen independent server fetches, each
individually guarded so a failure degrades to an empty block. That is the right
failure posture and the wrong performance posture: eighteen round trips fan out
on every navigation to the most-visited route in the product, and because an
empty block and a failed block look identical, a broken signal is invisible.

This epic replaces the *morning stack's* fan-out with **one composed read** that
returns every block in a single response, with a per-block status so a failed
block can say so instead of pretending to be empty. The inventory blocks below
the fold keep their existing fetches unchanged.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — The morning glance.**
**Given** a user whose agents ran overnight: 7 Runs completed, 1 failed, 2 still
executing, 3 open decisions and 5 schedules due today,
**when** they open Home at 07:04 local time,
**then** the greeting reads `Good morning, Dana.` with today's date, the score
line reads `3 need you · 2 working now · 7 done today · 1 failed`, the Needs-you
block lists 3 rows oldest first with a waiting duration on each, the Today panel
shows the schedules that already fired with a tick and the ones still due with
their local time, the This-week panel shows the 7-day spend total, and the
Working-now panel names both running agents with the line each last reported —
all of it rendered from a single server read that completes in under 800 ms at
the 95th percentile.

**S2 — One sentence becomes a Task.**
**Given** a user on Home,
**when** they type `summarise every item added this week and flag the duplicates`
into the composer and press `Enter`,
**then** the field clears, a chip appears immediately under the composer reading
`Task created — summarise every item added this week…` with a link, a Task is
created with that sentence as its description and a title derived from it, the
Task lands in the Task board's Backlog lane, and the chip stays visible
for 60 seconds so the user can click through without hunting for it.

**S3 — Answering a decision without leaving Home.**
**Given** an approval waiting for the user with two choices, `Approve` and
`Reject`,
**when** they click `Approve` in the Needs-you block,
**then** the row switches to a disabled `Answering…` state, the answer is
delivered, the row is removed with the block's count decrementing from 3 to 2, a
toast reports what happened to the waiting work — `Sent. The agent picked it up.`
when the running Run absorbed the answer, or `Sent. A run resumed to answer it.`
when a parked Run had to be restarted — and the score line's "need you" counter
updates in the same paint.

**S4 — Seeing what is due before midnight.**
**Given** a user in `Europe/Kyiv` at 14:30 local with a daily sweep that ran at
06:15, a weekly report due at 09:00 tomorrow, and a catalog check due at 18:00
today,
**when** they read the Today panel,
**then** it shows exactly two rows — the 06:15 sweep marked as already run and
the 18:00 catalog check as still due — and does **not** show tomorrow's 09:00 report,
because "today" is the user's own calendar day and not a rolling window.

**S5 — Spend with the cap in view.**
**Given** the active Organization *Acme*, in which $18.42 of usage landed in the
last 7 days across 61 Runs, and an account with an account-wide monthly cap of
$50 of which $39.10 has been spent so far this billing period across all of the
user's Organizations,
**when** they read the This-week panel,
**then** the headline reads `$18.42` with the sublabel `last 7 days in Acme`, the
second line reads `61 runs · $0.30 avg per run`, a neutral bar (78% is below the
80% amber threshold) reads `78% of your account-wide cap this billing period`,
and `Manage spend →` links to the costs surface with the 7-day window already
selected.

**S6 — Following a live run.**
**Given** two Runs executing, one started 14 minutes ago and one 3 minutes ago,
**when** they read the Working-now panel,
**then** the longer-running one is listed first, each row names its Agent, shows
the one-line activity the Run last reported, and shows elapsed time; clicking a
row opens that Run's detail.

**S7 — Picking up the thread from the activity tail.**
**Given** 40 things happened since midnight,
**when** they read the Recent-activity block,
**then** the 8 most recent are listed newest-first with a local `HH:mm` time and
a one-line summary, each linking to the entity it happened to, and
`Open the feed →` opens the full feed.

**S8 — Hiding a block they never use.**
**Given** a user who does not use schedules,
**when** they open the Home block menu and toggle `Today` off,
**then** the Today panel disappears, the choice persists across sessions and
devices, the remaining blocks reflow to close the gap, and the block menu shows
`Today` with an "off" state so it can be turned back on.

### 3.2 Edge cases, failures and races

**S9 — A brand-new account.**
**Given** a user who has just signed up and has no Agents, no Missions and no
Runs,
**when** they open Home,
**then** the score line is suppressed entirely (not rendered as
`0 need you · 0 working now · 0 done today · 0 failed`), the composer renders
with the placeholder `Hand something to your agents…` and a one-line hint
`Describe a job in a sentence. An agent will pick it up.`, every read block
collapses into a single empty-state card reading `Nothing yet. Once your agents
start working, this is where the morning report lands.`, and the onboarding entry
point is the only call to action on the screen.

**S10 — One block fails, the rest render.**
**Given** the schedule aggregation times out at 1500 ms while every other block
answers,
**when** Home renders,
**then** the Today panel shows `Couldn't load today's schedule.` with a `Retry`
button, every other block renders its real data, the page does not show a global
error, the failure is recorded, and pressing `Retry` re-reads **only** that
block.

**S11 — Every block fails.**
**Given** the summary read itself fails (network, 500, or the whole budget
exhausted),
**when** Home renders,
**then** the morning stack is replaced by one card reading `We couldn't load your
morning report.` with `Try again`, the composer remains usable (it does not
depend on the summary), and the inventory section below the fold still renders
from its own fetches.

**S12 — A decision is answered somewhere else first.**
**Given** the user answers the same approval from Inbox in another tab, and then
clicks `Approve` on the stale row still rendered on Home,
**when** the answer is delivered,
**then** the platform reports that the item was already decided, the row is
removed without an error toast, an informational toast reads `Already answered
elsewhere.`, and the block's count is recomputed from a fresh read rather than
decremented locally.

**S13 — The composer submission fails.**
**Given** the create call fails (offline, 500, or the create throttle of 60 per
minute is exceeded),
**when** the user pressed Enter,
**then** the typed sentence is **not** lost — it stays in the field, the field
regains focus, an inline message under it reads `Couldn't create that Task.`
with a `Try again` button, and on a throttle response specifically the message
reads `You're creating these faster than we can file them. Try again in a
minute.`

**S14 — Empty input, whitespace, and overlong input.**
**Given** the composer,
**when** the trimmed value is shorter than 3 characters, **then** `Send` is
disabled and `Enter` does nothing; **when** the value exceeds 2000 characters,
**then** a counter appears at `1800` characters showing `1800/2000`, further
typing is accepted up to 2000 and refused beyond it, and `Send` stays enabled up
to the cap.

**S15 — A run that is waiting on the user appears in only one place.**
**Given** a Run whose status is `running` but which has raised a question and is
waiting for input,
**when** Home renders,
**then** it appears in the Needs-you block and **not** in the Working-now panel,
because "working" means acting, and a run waiting for a human is not acting.

**S16 — A decision has been waiting too long.**
**Given** an open decision created 4 days ago,
**when** Home renders,
**then** its row sorts to the top of the Needs-you block, its waiting chip reads
`waiting 4d` in the danger tone, and the block header gains a suffix reading
`1 waiting over 3 days`.

**S17 — More decisions than the block shows.**
**Given** 14 open decisions,
**when** Home renders,
**then** the block shows the 5 oldest, the header reads `Open all (14) →`, and
the score line's counter reads `14` — the preview cap never changes the count.

**S18 — Timezone is unknown.**
**Given** a browser that reports no timezone, or reports one the platform does
not recognise,
**when** Home renders,
**then** every "today" boundary falls back to UTC, and each time-bounded block
carries a one-line footnote reading `Times shown in UTC.` so a wrong-looking
count is explainable rather than mysterious.

**S19 — Organization scope switches.**
**Given** a user who switches the active Organization from the workspace switcher,
**when** Home re-renders,
**then** every block reflects only the newly-active scope, no counter carries a
number from the previous scope, and the block preference (which blocks are
hidden) is per-user and therefore unchanged by the switch. The one figure that
does not change is the This-week cap bar, because the spend cap is an
account-wide setting; it is labelled account-wide in both scopes (FR-39a).

**S20 — Background job runtime is not configured.**
**Given** an installation with no configured job runtime, so nothing will ever be
dispatched,
**when** the user creates a Task from the composer,
**then** the Task is still created (creation does not need the runtime), the
existing degraded-runtime banner is already on screen above the content, and the
composer's success chip carries the suffix `— nothing will run until a job
runtime is configured` linking to that setting.

**S21 — A second tab is open.**
**Given** Home open in two tabs,
**when** the background refresh fires in the hidden tab,
**then** it does not fire — refresh is suspended while the document is hidden and
performs one immediate read when it becomes visible again.

---

## 4. Functional requirements

Every threshold below is normative. "The summary" means the single composed read
that backs the morning stack.

### 4.1 The screen and its order

- **FR-1.** Home renders, in this order: greeting + score line, composer,
  Needs-you, Today-at-a-glance, a two-column row of Today and This-week, Working
  now, Recent activity, then a collapsible `Your workspace` section containing
  everything Home renders today.
- **FR-2.** The `Your workspace` section is collapsed by default for an account
  older than 7 days and expanded by default for an account 7 days old or newer.
  The user's explicit expand/collapse choice overrides the default and persists
  (§5.4).
- **FR-3.** Below 1024 px viewport width the two-column row stacks; below 768 px
  every block is full width and the score line wraps to at most two lines.
- **FR-4.** The greeting varies by the user's local hour: `Good morning`
  (05:00–11:59), `Good afternoon` (12:00–17:59), `Good evening` (18:00–04:59),
  followed by the user's display name. The date is rendered in the user's locale.
- **FR-5.** The score line renders only when at least one of its four counters is
  non-zero. Zero-valued counters within a rendered score line are omitted rather
  than shown as `0`.

### 4.2 The composer

- **FR-6.** The composer is a single auto-growing text field, 1 row at rest,
  growing to at most 6 rows, with the placeholder `Hand something to your
  agents…`.
- **FR-7.** `Enter` submits. `Shift+Enter` inserts a newline. `Ctrl/Cmd+Enter`
  also submits. `Escape` blurs the field without clearing it.
- **FR-8.** Submission requires a trimmed length of at least **3** characters.
  The hard maximum is **2000** characters; a live counter appears at **1800**.
- **FR-9.** A successful submission creates one **Task** with:
  `status = backlog` (the create default, so it lands in the board's first lane),
  the platform's default priority, and no owner scope — it is filed against no
  Work, Mission, Idea, Team, Agent or Goal. `description` = the submitted text
  verbatim; `title` = the first sentence of the text truncated at the last word
  boundary at or before **80** characters, with a single trailing `…` when
  truncated. When the first sentence is shorter than 3 characters the whole text
  is used.
- **FR-10.** The field is cleared and disabled while the create is in flight, and
  re-enabled on either outcome. A submission may not be issued while another is
  in flight.
- **FR-11.** Up to **3** success chips are kept under the composer, newest first,
  each for **60** seconds, each linking to the created Task.
- **FR-12.** On failure the typed text is preserved, focus returns to the field,
  and an inline error with a `Try again` action is shown. A throttle response
  produces a distinct message (§6.9).
- **FR-13.** The composer's unsent text is preserved per browser and restored
  when Home is opened again, and is cleared on a successful submission. It is
  never sent anywhere until the user submits.
- **FR-14.** The composer functions when the summary read failed (§S11) — it has
  no dependency on it.
- **FR-15.** An `Expand` affordance opens the full Task creation form with the
  typed text carried into it (P2).

### 4.3 Needs you

- **FR-16.** The block lists open items that are blocked on a human decision:
  agent **questions**, **approvals**, and **escalations**. Informational notices
  are excluded.
- **FR-17.** Rows are ordered by age, oldest first. An item open for **72 hours**
  or more sorts above every younger item regardless of its own age ordering
  within that group.
- **FR-18.** The block previews at most **5** rows and always shows the exact
  total in its header link, e.g. `Open all (14) →`.
- **FR-19.** Each row shows: a kind chip (`Approve` / `Question` / `Escalation`),
  the responsible Agent's name when known, the item's title truncated to **120**
  characters, and a waiting chip.
- **FR-20.** The waiting chip reads `waiting {n}m` under 1 hour, `waiting {n}h`
  under 24 hours, and `waiting {n}d` at or above 24 hours. It is neutral under
  24 h, amber from 24 h, and danger from 72 h.
- **FR-21.** When the item carries between **1** and **3** choices, those choices
  render as inline buttons on the row and answering is possible without leaving
  Home. With **0** choices or more than **3**, the row shows `Open` only.
- **FR-22.** Answering a row optimistically removes it, then reconciles against a
  fresh count. An item that was already decided elsewhere is removed with an
  informational toast, never an error.
- **FR-23.** When one or more items have been waiting 72 hours or more, the block
  header carries the suffix `{n} waiting over 3 days`.
- **FR-24.** The block's empty state reads `Nothing needs you right now.` with a
  second line `Your agents will raise anything they can't decide themselves.`
- **FR-25.** Failures the platform raised on its own — an errored Agent, a failed
  generation, a blocked Task, an exceeded budget — render **below** the decision
  rows in the same block, under the sub-heading `Also broken`, capped at **6**
  rows. They are signals, not decisions, so they are never counted in the
  "need you" counter.

### 4.4 Today at a glance

- **FR-26.** Four counters render, each a link: `need you`, `working now`,
  `done today`, `failed today`.
- **FR-27.** `need you` is the exact count from §4.3's decision set. `working
  now` counts Runs currently executing and **not** waiting on a human.
  `done today` counts Runs that finished successfully since the start of the
  user's local day. `failed today` counts Runs that ended in failure in the same
  window.
- **FR-28.** `failed today` renders in the danger tone when greater than zero and
  in the neutral tone at zero.
- **FR-29.** Counters are exact up to **999**; at or above 1000 they render
  `999+`.

### 4.5 Today (the day's cadence)

- **FR-30.** The panel covers the user's local calendar day, from 00:00 to 23:59
  in their timezone.
- **FR-31.** It reads **every** schedule kind the platform aggregates — recurring
  Tasks, Agent heartbeats, Work schedules, Mission ticks, source-validation
  checks, data-sync polls and inbound triggers — not a subset. Each kind has its
  own label; no kind is dropped for lack of one.
- **FR-32.** Rows already fired today render first, dimmed, with a tick and the
  local time they ran, capped at **3** with no overflow link. Rows still due
  render next, ascending by time, capped at **6** with a `+{n} more →` link.
- **FR-33.** A row shows: local `HH:mm`, the owning entity's name truncated to
  **60** characters, the kind label, and — for a schedule that is paused or in
  error — its status chip. Paused and errored schedules are shown, not hidden.
- **FR-34.** A schedule whose next fire cannot be computed is excluded from the
  "still due" list and does not count toward the overflow number.
- **FR-35.** Empty state, when nothing ran and nothing is due:
  `Nothing scheduled today.` with the action `Set something up →`. When
  something ran but nothing remains: `Nothing else scheduled today.`
- **FR-36.** `+{n} more →` opens the full schedules surface.

### 4.6 This week (spend)

- **FR-37.** The headline is total AI spend over a **rolling 7-day** window **in
  the active scope** — the active Organization's usage when one is active, the
  user's personal usage otherwise (FR-69) — formatted in the account's currency,
  with the sublabel `last 7 days in {scope}`, where `{scope}` is the Organization's
  name or `Personal`. The window is explicitly 7 days and is never described as
  "this week" in copy.
- **FR-38.** The second line reads `{runs} runs · {avg} avg per run`, where
  `runs` counts the active scope's Runs in the same window and `avg` is the
  scoped 7-day total divided by that count, rounded to the currency's minor unit,
  and reads `—` when the run count is zero. Spend and runs from another
  Organization are never mixed into either number.
- **FR-39.** When the account has a spend cap for the current billing period, a
  bar shows the account's period-to-date spend as a percentage of that cap,
  labelled `{n}% of your account-wide cap this billing period`. The bar is neutral
  below **80%**, amber from **80%**, and danger from **100%**.
- **FR-39a.** The spend cap is an account-wide setting and is enforced against the
  account's spend in every Organization, so the cap bar and the FR-40 line cannot
  be scoped to one Organization. They MUST always carry the words `account-wide`,
  MUST be visually separated from the scoped headline, and MUST NOT be presented
  as a share of the headline figure. No other number in the panel may be
  account-wide.
- **FR-40.** At or above 100% the panel adds one line: `New runs are blocked.`
  when the account blocks on overage, or `Overage is allowed.` when it does not.
- **FR-41.** With no cap set the bar is replaced by the line
  `No spend cap set.` and the action `Set a cap →`.
- **FR-42.** `Manage spend →` opens the costs surface with the 7-day window
  pre-selected. That surface reports account-wide spend, so the link's accessible
  description reads `Opens account-wide spend`.
- **FR-43.** The panel is hidden entirely for a user whose account has never
  recorded any spend, in any scope, so a brand-new account is not shown a $0.00
  meter. An account with spend elsewhere that opens an Organization with none
  sees `$0.00` for that Organization, not a hidden panel.

### 4.7 Working now

- **FR-44.** Lists Runs currently executing, excluding any Run waiting on human
  input (those belong to §4.3).
- **FR-45.** Ordered longest-running first. Capped at **5** rows with a
  `See all runs →` link showing the exact total when it exceeds 5.
- **FR-46.** A row shows: the Agent's name, the one-line activity the Run last
  reported truncated to **100** characters, and elapsed time formatted `{n}m`
  under 1 hour and `{h}h {m}m` at or above.
- **FR-47.** A Run with no reported activity line shows `Working…` rather than an
  empty cell.
- **FR-48.** A Run executing for **30** minutes or more carries a neutral
  `long run` chip; at **120** minutes or more the chip becomes amber and reads
  `still going`.
- **FR-49.** Empty state: `Nobody is working right now.` with the action
  `Hand out some work ↑` which focuses the composer.

### 4.8 Recent activity

- **FR-50.** Lists the **8** most recent activity entries for the active scope,
  newest first.
- **FR-51.** Each entry shows local `HH:mm` (or `d MMM` when older than the
  current local day), a one-line summary truncated to **120** characters, and
  links to the entity it concerns when one is resolvable.
- **FR-52.** `Open the feed →` opens the activity feed.
- **FR-53.** Empty state: `Nothing has happened yet.`

### 4.9 Freshness

- **FR-54.** While the document is visible, the summary re-reads every **60**
  seconds. While hidden, no refresh is issued; one immediate read is issued on
  becoming visible.
- **FR-55.** When a refresh increases the decision count, a pill appears above
  the Needs-you block reading `{n} new since you opened this`; clicking it
  scrolls the block into view and dismisses the pill. The pill also dismisses
  when the count returns to or below its value at page open.
- **FR-56.** A refresh never moves scroll position, never steals focus, and never
  discards text in the composer.
- **FR-57.** A manual refresh control is available and is also bound to the `r`
  key (§6.13).
- **FR-58.** The server may serve a summary computed at most **10** seconds ago
  for the same user and scope; every response states the moment it was computed,
  and the UI shows `updated {n}s ago` next to the manual refresh control once
  that value exceeds 90 seconds.

### 4.10 Performance, limits and failure

- **FR-59.** The summary is a **single** request. Its 95th-percentile server time
  is **800 ms**; its hard ceiling is **3000 ms**.
- **FR-60.** Each block within the summary has an independent **1500 ms** budget.
  A block that exceeds it returns a failed status and an error message key, never
  partial or fabricated data.
- **FR-61.** A block reporting failure renders its own error card with `Retry`;
  retrying re-reads that block alone.
- **FR-62.** An empty block and a failed block must be visually distinguishable.
  Empty says what would appear here; failed says it could not be loaded.
- **FR-63.** Home renders its shell, greeting and composer before the summary
  resolves; each block renders a skeleton with the shape of its populated state.
- **FR-64.** Home issues no more than **one** summary request per navigation and
  per refresh tick, regardless of how many blocks are visible.

### 4.11 Degradation against sibling epics

- **FR-65.** Before AW-03 ships, `Open all (n) →` opens the Inbox. After AW-03
  ships it opens **My Decisions**. The block itself does not change shape.
- **FR-66.** Before AW-04 ships, `Open the feed →` opens the activity page. After
  AW-04 ships it opens the Live Feed.
- **FR-67.** Before AW-02 ships, the composer's success chip links to the Task
  detail page. After AW-02 ships it links to the Task board with that Task
  focused.
- **FR-68.** Home never becomes the only surface for any signal it shows. Every
  block links to the surface that owns its data.

### 4.12 Permissions, scope and safety

- **FR-69.** Every read is scoped to the acting user, and additionally to the
  active Organization when one is active. There is no parameter by which a caller
  can name another user or another Organization.
- **FR-70.** A resource the caller does not own is indistinguishable from one
  that does not exist: both answer "not found". No block leaks the existence of
  anything outside the caller's scope.
- **FR-71.** Answering a decision from Home is subject to exactly the same rules,
  throttles and audit as answering it from its own surface. Home adds no new
  authority.
- **FR-72.** The composer creates work under the same throttle the Task create
  path already enforces; Home does not raise it.
- **FR-73.** Nothing in the summary contains a secret, a credential, or a raw
  error body from an external service. Failure messages are message keys, not
  provider text.
- **FR-74.** Titles, activity lines and summaries rendered on Home are
  agent-authored text and are rendered as plain text, never as markup.

### 4.13 Accessibility and internationalisation

- **FR-75.** Every block is a landmark region with an accessible name matching its
  visible heading.
- **FR-76.** The score line is announced once on load as a single polite live
  region; refresh updates do not re-announce it unless a counter changed.
- **FR-77.** The Needs-you count and the "new since you opened this" pill are
  polite live regions. Nothing on Home uses an assertive live region.
- **FR-78.** Every interactive element is reachable and operable by keyboard, has
  a visible focus ring, and meets a contrast ratio of at least 4.5:1 in both
  themes.
- **FR-79.** Every user-visible string is translatable. Counts use plural-aware
  messages. Times and dates are formatted in the user's locale and timezone.
- **FR-80.** Colour is never the only carrier of meaning: every tone-carrying chip
  also carries text (`waiting 4d`, `failed`, `paused`).

---

## 5. Key entities

### 5.1 Already in Ever Works — read, not changed

| Concept | What Home reads from it | Changed by this epic? |
| --- | --- | --- |
| **Task** | Created by the composer; blocked Tasks feed the "Also broken" list | No — creation uses the existing path |
| **Mission** | A standing initiative, never a unit of work here: a scheduled Mission's tick is one of the seven kinds in the Today panel, and the existing Missions preview keeps its own read below the fold | No |
| **Agent** | Names in the decision rows and the working-now rows; errored Agents feed "Also broken" | No |
| **Run** | Working-now rows; the `done today` / `failed today` / `working now` counters | No — one additive index only (see plan) |
| **Approval / Escalation / Question** | The decision set behind "Needs you" | No |
| **Schedule** (the aggregated read model) | The Today panel | Widened to label all seven kinds |
| **Activity** | The recent-activity tail | No |
| **Spend / budget** | The This-week panel | No |
| **Organization / Workspace scope** | Scopes every read | No |

### 5.2 States and transitions Home depends on

**A decision item** moves `open → answered`, and may also become `archived`.
Home shows only `open`. Answering from Home performs the same transition the
item's own surface performs, and the effect on the waiting work is one of:

```
        ┌──────────────────────────────────────────────────────────┐
        │  open                                                    │
        │    │ answered on Home / on its own surface               │
        │    ▼                                                     │
        │  answered ──┬─► the running Run absorbs the answer       │
        │             ├─► a parked Run resumes to consume it       │
        │             ├─► an approval is approved / rejected       │
        │             ├─► an escalation is resolved with the note  │
        │             └─► already decided elsewhere → no-op        │
        └──────────────────────────────────────────────────────────┘
```

**A Run** is `queued → running → completed | failed | cancelled`, and while
`running` may additionally be *waiting on input*. Home's rule (FR-44, S15):

```
   running AND NOT waiting-on-input   →  Working now
   running AND waiting-on-input       →  Needs you
   completed today                    →  "done today"
   failed today                       →  "failed today"
   queued / cancelled                 →  neither
```

**A schedule row** is `active | paused | disabled | error | ended`. Home's Today
panel shows `active`, `paused` and `error` (paused and errored are exactly what a
morning screen must not hide); `disabled` and `ended` are excluded.

### 5.3 New read model — the **Home summary** (not a table)

One composed, read-only projection assembled per request from the entities in
§5.1. It carries, per block: a status (`ok` / `failed`), the block's rows or
counters, an exact total where the block previews a subset, and the moment it was
computed. It is **not** persisted, **not** a user-facing noun, and introduces no
vocabulary — the UI shows blocks, not "summaries".

### 5.4 New entity — **Home preference** (justified)

Home needs one small piece of durable per-user state that has nowhere to live
today: **which blocks a user has turned off, in what order they appear, and
whether the `Your workspace` section is expanded.**

Why it must persist server-side rather than per-browser:

1. Home is the landing route. A block a user has deliberately dismissed
   reappearing on their laptop after they hid it on their desktop is the kind of
   small betrayal that makes a screen feel untrustworthy.
2. The choice is a statement about the *account's* way of working (an owner with
   no schedules never wants the Today panel), not about one browser.
3. Browser storage is already used for the composer draft (FR-13), which is
   genuinely per-device. Mixing durable preference into the same store would make
   "clear site data" silently reset a deliberate choice.

Shape, conceptually: one row per user, holding the set of hidden block ids, an
explicit block order, and the `Your workspace` expansion state. Everything about
it is optional — an account with no row behaves exactly as the defaults in §4.1
and §4.2 describe, so the row is created only on first change.

It is a **preference**, not a new domain noun: it never appears in the product's
vocabulary, is never referenced by another entity, and deleting it loses nothing
but a layout choice.

### 5.5 Explicitly not new entities

- **No "briefing" or "digest" entity.** The morning read is computed, never
  stored. The scheduled roll-up that *is* stored and delivered already exists and
  is a different feature.
- **No "counter" or "metric" table.** Every counter is a scoped query over rows
  that already exist.
- **No new decision noun.** Home reads the existing decision set; AW-03 owns its
  shape.
- **No new schedule noun.** Home reads the existing aggregation.

---

## 6. UX

### 6.1 Where it lives

Home is the existing dashboard root route inside the existing shell (sidebar,
header, chat panel, footer, degraded-runtime banner). This epic adds no route, no
sidebar entry and no modal.

### 6.2 Populated — desktop, ≥1280 px

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Good morning, Dana.                                        Friday, 6 September│
│  3 need you · 2 working now · 7 done today · 1 failed            ↻ updated 4s  │
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────┐  ┌────────┐  │
│  │ Hand something to your agents…                               │  │  Send  │  │
│  └──────────────────────────────────────────────────────────────┘  └────────┘  │
│   Describe a job in a sentence. An agent will pick it up.            Expand ↗  │
│   ✓ Task created — "summarise every item added this week…"  Open →             │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ NEEDS YOU  · 1 waiting over 3 days                          Open all (3) → │ │
│ ├────────────────────────────────────────────────────────────────────────────┤ │
│ │ ! Escalation  Writer   Merge refused on T-241        waiting 4d  [ Open ]  │ │
│ │ ⚑ Approve     Ops      Publish the September notes  waiting 2h  [Yes][No]  │ │
│ │ ? Question    Research Which category for these?  waiting 20m [ Open ]     │ │
│ ├────────────────────────────────────────────────────────────────────────────┤ │
│ │ ALSO BROKEN                                                                │ │
│ │ ● Agent "Scraper" errored — auto-paused after failures                 →   │ │
│ │ ● Task "Reconcile the September import" blocked                        →   │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ TODAY AT A GLANCE                                                          │ │
│ │    3          2             7              1                               │ │
│ │  need you   working now   done today    failed today                       │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│ ┌─────────────────────────────────────┐ ┌────────────────────────────────────┐ │
│ │ TODAY                    +2 more →  │ │ THIS WEEK           Manage spend → │ │
│ ├─────────────────────────────────────┤ ├────────────────────────────────────┤ │
│ │ ✓ 06:15  Daily sweep       heartbeat│ │  $18.42                            │ │
│ │ ✓ 07:00  Catalog sync      data sync│ │  last 7 days in Acme               │ │
│ │ ─────────────────────────────────── │ │  61 runs · $0.30 avg per run       │ │
│ │   14:00  Catalog check     recurring│ │                                    │ │
│ │   18:00  Nightly report     schedule│ │  ████████████░░░░  78%             │ │
│ │   22:00  Mission tick   ⏸ paused    │ │  of your account-wide cap          │ │
│ └─────────────────────────────────────┘ └────────────────────────────────────┘ │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ WORKING NOW (2)                                            See all runs →  │ │
│ ├────────────────────────────────────────────────────────────────────────────┤ │
│ │ ● Research   Reading the September changelog…        14m   long run        │ │
│ │ ● Writer     Drafting the September summary…          3m                   │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ RECENT ACTIVITY                                           Open the feed →  │ │
│ ├────────────────────────────────────────────────────────────────────────────┤ │
│ │ 07:02  Mission "Q3 catalog sweep" completed                            →   │ │
│ │ 06:58  Task T-240 moved to In review                                   →   │ │
│ │ 06:41  Run finished for Agent "Research"                               →   │ │
│ │ …                                                                          │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  ▸ Your workspace                                                     ⋯ Blocks │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Loading

The shell, greeting and composer paint immediately. Each block paints a skeleton
shaped like its populated state — never a spinner, never a collapsed zero-height
region, so nothing jumps when data lands.

```
┌────────────────────────────────────────────────────────────────────┐
│  Good morning, Dana.                            Friday, 6 September│
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                  │
│  ┌──────────────────────────────────────────────┐  ┌────────┐      │
│  │ Hand something to your agents…               │  │  Send  │      │
│  └──────────────────────────────────────────────┘  └────────┘      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ NEEDS YOU                                                      │ │
│ │ ▒▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒▒▒  │ │
│ │ ▒▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒▒▒  │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────┐ ┌───────────────────────────────────┐   │
│ │ TODAY                  │ │ THIS WEEK                         │   │
│ │ ▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒   │ │ ▒▒▒▒▒▒▒▒                          │   │
│ │ ▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒   │ │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                  │   │
│ └────────────────────────┘ └───────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 6.4 Empty — a brand-new account

```
┌────────────────────────────────────────────────────────────────────┐
│  Good morning, Dana.                            Friday, 6 September│
│                                                                    │
│  ┌──────────────────────────────────────────────┐  ┌────────┐      │
│  │ Hand something to your agents…               │  │  Send  │      │
│  └──────────────────────────────────────────────┘  └────────┘      │
│   Describe a job in a sentence. An agent will pick it up.          │
│                                                                    │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │                            ☀                                   │ │
│ │              Nothing yet.                                      │ │
│ │   Once your agents start working, this is where the            │ │
│ │   morning report lands — what needs you, what ran,             │ │
│ │   and what it cost.                                            │ │
│ │                                                                │ │
│ │                 [ Set up your first agent ]                    │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ▾ Your workspace                                                  │
│    (expanded by default for accounts younger than 7 days)          │
└────────────────────────────────────────────────────────────────────┘
```

### 6.5 Empty — an established account with a quiet morning

Each block renders its own empty line rather than collapsing:

```
┌────────────────────────────────────────────────────────────────────┐
│ NEEDS YOU                                                          │
│   Nothing needs you right now.                                     │
│   Your agents will raise anything they can't decide themselves.    │
├──────────────────────────────┬─────────────────────────────────────┤
│ TODAY                        │ THIS WEEK          Manage spend →   │
│   Nothing scheduled today.   │   $0.00                             │
│   Set something up →         │   last 7 days in Acme               │
├──────────────────────────────┴─────────────────────────────────────┤
│ WORKING NOW                                                        │
│   Nobody is working right now.        Hand out some work ↑         │
├────────────────────────────────────────────────────────────────────┤
│ RECENT ACTIVITY                                  Open the feed →   │
│   Nothing has happened yet.                                        │
└────────────────────────────────────────────────────────────────────┘
```

### 6.6 One block failed

```
┌────────────────────────────────────────────────────────────────────┐
│ TODAY                                                              │
│   ⚠  Couldn't load today's schedule.                               │
│      [ Retry ]                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 6.7 The whole summary failed

```
┌────────────────────────────────────────────────────────────────────┐
│  Good morning, Dana.                            Friday, 6 September│
│  ┌──────────────────────────────────────────────┐  ┌────────┐      │
│  │ Hand something to your agents…               │  │  Send  │      │
│  └──────────────────────────────────────────────┘  └────────┘      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │  ⚠  We couldn't load your morning report.                      │ │
│ │     Everything is still running — this screen just             │ │
│ │     can't see it right now.                                    │ │
│ │                        [ Try again ]                           │ │
│ └────────────────────────────────────────────────────────────────┘ │
│  ▾ Your workspace                     (renders from its own reads) │
└────────────────────────────────────────────────────────────────────┘
```

### 6.8 Over the preview cap

```
┌────────────────────────────────────────────────────────────────────┐
│ NEEDS YOU  · 4 waiting over 3 days                Open all (14) →  │
│ … 5 rows …                                                         │
│                        9 more waiting                              │
└────────────────────────────────────────────────────────────────────┘
```

### 6.9 Composer states

```
Resting
┌──────────────────────────────────────────────┐  ┌────────┐
│ Hand something to your agents…               │  │  Send  │   (disabled)
└──────────────────────────────────────────────┘  └────────┘
 Describe a job in a sentence. An agent will pick it up.

Typing (approaching the cap)
┌──────────────────────────────────────────────┐  ┌────────┐
│ summarise every item added this week…        │  │  Send  │
└──────────────────────────────────────────────┘  └────────┘
                                        1834 / 2000        Expand ↗

Sending
┌──────────────────────────────────────────────┐  ┌────────┐
│ summarise every item added this week…        │  │ ●●●    │   (disabled)
└──────────────────────────────────────────────┘  └────────┘

Sent
┌──────────────────────────────────────────────┐  ┌────────┐
│ Hand something to your agents…               │  │  Send  │
└──────────────────────────────────────────────┘  └────────┘
 ✓ Task created — "summarise every item added this week…"   Open →

Failed
┌──────────────────────────────────────────────┐  ┌────────┐
│ summarise every item added this week…        │  │  Send  │
└──────────────────────────────────────────────┘  └────────┘
 ⚠ Couldn't create that Task.   [ Try again ]

Throttled
 ⚠ You're creating these faster than we can file them. Try again in a minute.

No job runtime configured
 ✓ Task created — "summarise every item added this week…"   Open →
   Nothing will run until a job runtime is configured.  Configure →
```

### 6.10 Answering a decision inline

```
Before
│ ⚑ Approve   Ops   Publish the September release notes   waiting 2h  [Yes][No] │

During
│ ⚑ Approve   Ops   Publish the September release notes   Answering…            │

After (row removed, toast)
   ┌──────────────────────────────────────────────┐
   │ ✓ Sent. The agent picked it up.              │
   └──────────────────────────────────────────────┘

Already decided elsewhere
   ┌──────────────────────────────────────────────┐
   │ ℹ Already answered elsewhere.                │
   └──────────────────────────────────────────────┘
```

### 6.11 The block menu (P2)

```
                                                          ⋯ Blocks
                                    ┌──────────────────────────────┐
                                    │ Show on Home                 │
                                    │  ☑ Needs you                 │
                                    │  ☑ Today at a glance         │
                                    │  ☐ Today                     │
                                    │  ☑ This week                 │
                                    │  ☑ Working now               │
                                    │  ☑ Recent activity           │
                                    │ ──────────────────────────── │
                                    │  Reset to defaults           │
                                    └──────────────────────────────┘
```

The composer and the greeting cannot be hidden — they are the screen's purpose.

### 6.12 Narrow viewports

```
< 768 px
┌───────────────────────────┐
│ Good morning, Dana.       │
│ Friday, 6 September       │
│ 3 need you · 2 working    │
│ 7 done today · 1 failed   │
│ ┌───────────────────────┐ │
│ │ Hand something to…    │ │
│ └───────────────────────┘ │
│              [   Send   ] │
│ NEEDS YOU        (3) →    │
│ …                         │
│ TODAY AT A GLANCE         │
│  3  need you              │
│  2  working now           │
│  7  done today            │
│  1  failed today          │
│ TODAY                     │
│ …                         │
│ THIS WEEK                 │
│ …                         │
└───────────────────────────┘
```

The four glance counters become a 2×2 grid below 768 px and a single column below
420 px. Inline decision choices stack under the row title below 768 px so a
choice button is never narrower than 44 px.

### 6.13 Keyboard affordances

| Key | Where | Does |
| --- | --- | --- |
| `n` | anywhere on Home, when focus is not in a text field | Focuses the composer |
| `Enter` | composer | Submits |
| `Shift+Enter` | composer | Newline |
| `Ctrl/Cmd+Enter` | composer | Submits |
| `Escape` | composer | Blurs without clearing |
| `r` | anywhere on Home, when focus is not in a text field | Refreshes the summary |
| `Tab` / `Shift+Tab` | anywhere | Moves through blocks in visual order; each block is one tab stop group |
| `Enter` / `Space` | a focused decision choice | Answers |
| `Enter` | a focused block header link | Opens the owning surface |

`n` and `r` must not collide with the shortcuts the shell already registers; they
are registered through the same mechanism so the help panel lists them.

### 6.14 Exact user-visible copy

| Where | Copy |
| --- | --- |
| Greeting (morning / afternoon / evening) | `Good morning, {name}.` · `Good afternoon, {name}.` · `Good evening, {name}.` |
| Score line | `{n} need you · {n} working now · {n} done today · {n} failed` |
| Freshness | `updated {n}s ago` · `updated {n}m ago` |
| Composer placeholder | `Hand something to your agents…` |
| Composer hint | `Describe a job in a sentence. An agent will pick it up.` |
| Composer send | `Send` |
| Composer expand | `Expand` |
| Composer counter | `{used} / 2000` |
| Composer success | `Task created — "{title}"` · link `Open` |
| Composer failure | `Couldn't create that Task.` · action `Try again` |
| Composer throttled | `You're creating these faster than we can file them. Try again in a minute.` |
| Composer runtime note | `Nothing will run until a job runtime is configured.` · link `Configure` |
| Needs-you heading | `Needs you` |
| Needs-you overdue suffix | `{n} waiting over 3 days` |
| Needs-you link | `Open all ({n})` |
| Needs-you overflow footer | `{n} more waiting` |
| Kind chips | `Approve` · `Question` · `Escalation` |
| Waiting chip | `waiting {n}m` · `waiting {n}h` · `waiting {n}d` |
| Row action | `Open` |
| Answering state | `Answering…` |
| Answer success (steered) | `Sent. The agent picked it up.` |
| Answer success (resumed) | `Sent. A run resumed to answer it.` |
| Answer success (approval) | `Approved.` · `Rejected.` |
| Answer success (escalation) | `Resolved.` |
| Answer already decided | `Already answered elsewhere.` |
| Answer failure | `Couldn't send that answer.` · action `Try again` |
| Needs-you empty | `Nothing needs you right now.` / `Your agents will raise anything they can't decide themselves.` |
| Also-broken heading | `Also broken` |
| Glance heading | `Today at a glance` |
| Glance labels | `need you` · `working now` · `done today` · `failed today` |
| Today heading | `Today` |
| Today kind labels | `recurring task` · `heartbeat` · `work schedule` · `mission tick` · `source check` · `data sync` · `trigger` |
| Today ran marker | `ran at {time}` |
| Today overflow | `+{n} more` |
| Today empty | `Nothing scheduled today.` · action `Set something up` |
| Today nothing left | `Nothing else scheduled today.` |
| Today paused chip | `paused` · `error` |
| This-week heading | `This week` |
| This-week sublabel | `last 7 days in {scope}` (Organization name, or `Personal`) |
| This-week second line | `{n} runs · {amount} avg per run` |
| This-week cap bar | `{n}% of your account-wide cap this billing period` |
| This-week cap note | `The cap applies across all your Organizations.` |
| This-week link description | `Opens account-wide spend` |
| This-week blocked | `New runs are blocked.` |
| This-week overage | `Overage is allowed.` |
| This-week no cap | `No spend cap set.` · action `Set a cap` |
| This-week link | `Manage spend` |
| Working-now heading | `Working now ({n})` |
| Working-now fallback line | `Working…` |
| Working-now chips | `long run` · `still going` |
| Working-now link | `See all runs` |
| Working-now empty | `Nobody is working right now.` · action `Hand out some work` |
| Recent-activity heading | `Recent activity` |
| Recent-activity link | `Open the feed` |
| Recent-activity empty | `Nothing has happened yet.` |
| Block error | `Couldn't load {block}.` · action `Retry` |
| Whole-summary error | `We couldn't load your morning report.` / `Everything is still running — this screen just can't see it right now.` · action `Try again` |
| New-since pill | `{n} new since you opened this` |
| Timezone footnote | `Times shown in UTC.` |
| Workspace section | `Your workspace` |
| Block menu | `Blocks` / `Show on Home` / `Reset to defaults` |
| First-run empty | `Nothing yet.` / `Once your agents start working, this is where the morning report lands — what needs you, what ran, what it cost.` · action `Set up your first agent` |

---

## 7. Out of scope

1. **Owning the decision queue.** Home previews decisions; AW-03 owns their
   shape, filters, bulk actions and the dedicated surface.
2. **Owning the feed.** Home shows an 8-row tail; AW-04 owns the feed, its
   grouping and the "while you were away" summary.
3. **Owning the Task board.** The composer files a Task; AW-02 owns lanes,
   cards, staleness and steering.
4. **Owning cost analysis.** Home shows one 7-day number and one cap bar; AW-17
   owns caps, credits, per-agent and per-model breakdowns.
5. **Owning the calendar.** Home shows today; AW-10 owns the calendar, heartbeats
   and never-runs.
6. **Routing the composer's sentence to a specific Agent.** The composer creates a
   Task with no assignee; which Agent picks it up is the Task board's and the
   assignment path's concern, not Home's.
7. **Rich composition.** No attachments, no `@` mentions, no `#` references and no
   markdown in the composer in this epic.
8. **A push transport.** Freshness is polling on a 60-second cadence. Replacing
   polling with a push channel is a platform-wide change, not a Home change.
9. **Multi-user or shared Home.** Home is the acting user's own screen; shared
   read-only dashboards are AW-18.
10. **Reordering blocks by drag.** P2 stores an order; the only editor in this
    epic is show/hide plus reset. Drag ordering is a follow-up.
11. **Removing or rewriting the existing Home blocks.** They move; they do not
    change.
12. **A "good morning" email or notification.** The scheduled roll-up that is
    delivered outside the product already exists and is a different feature.

---

## 8. Acceptance criteria

A reviewer can run this list against a build.

### Layout and shell

- [ ] Home renders the blocks in the order given in FR-1.
- [ ] The `Your workspace` section contains every block Home renders today, and
      each of those blocks still works (links, actions, empty states).
- [ ] `Your workspace` is collapsed by default on an account older than 7 days and
      expanded on a newer one; toggling it persists across a sign-out and back in.
- [ ] At 1023 px the Today / This-week row stacks; at 767 px every block is full
      width and the glance counters form a 2×2 grid.
- [ ] The greeting changes across the 05:00 / 12:00 / 18:00 local boundaries.
- [ ] With all four counters at zero, the score line is absent — not four zeros.

### Composer

- [ ] Typing 2 characters leaves `Send` disabled; 3 enables it.
- [ ] `Enter` submits; `Shift+Enter` inserts a newline; `Ctrl/Cmd+Enter` submits.
- [ ] A 250-character sentence produces a Task whose title is at most 80
      characters, ends at a word boundary, and carries a single trailing `…`.
- [ ] The full typed text is the Task's description, byte for byte.
- [ ] The created Task lands in the board's Backlog lane and carries no Work,
      Mission, Idea, Team, Agent or Goal owner.
- [ ] A success chip appears within 100 ms of the response and disappears after
      60 seconds; at most 3 are ever visible.
- [ ] Forcing the create to fail leaves the text in the field, restores focus and
      shows the inline error with `Try again`.
- [ ] Exceeding the create throttle shows the throttle-specific message.
- [ ] Typing, navigating away and returning restores the unsent text; submitting
      clears it.
- [ ] With the summary read forced to fail, the composer still creates a Task.
- [ ] At 1800 characters a counter appears; at 2000 further input is refused.

### Needs you

- [ ] With 1 question, 1 approval and 1 escalation open, all three appear, and an
      informational notice does not.
- [ ] With 14 open items, 5 render, the header reads `Open all (14) →`, the
      footer reads `9 more waiting`, and the score line reads `14`.
- [ ] Rows are oldest first; an item open 4 days sorts above one open 2 days even
      when the newer one was created by a different mechanism.
- [ ] An item open 23 h 59 m shows a neutral chip; at 24 h it is amber; at 72 h it
      is danger and the header suffix appears.
- [ ] An item with 2 choices renders 2 inline buttons; one with 5 choices renders
      `Open` only.
- [ ] Clicking a choice removes the row, decrements the count, and toasts the
      routed outcome.
- [ ] Answering the same item elsewhere first produces the informational
      "already answered" toast and no error.
- [ ] Errored Agents, failed generations, blocked Tasks and exceeded budgets
      appear under `Also broken`, capped at 6, and are not counted in `need you`.
- [ ] Every rendered title is plain text: an item titled with markup renders the
      markup as characters.

### Today at a glance

- [ ] The four counters match the blocks they summarise on the same paint.
- [ ] A Run that is running but waiting on input is counted in `need you`, not
      `working now`, and does not appear in the Working-now block.
- [ ] A Run that completed at 23:59 yesterday local is not counted in
      `done today`; one that completed at 00:01 today is.
- [ ] `failed today` is danger-toned above zero and neutral at zero.
- [ ] A count of 1200 renders `999+`.

### Today

- [ ] All seven schedule kinds render with their own label; none is dropped.
- [ ] A schedule due tomorrow does not appear; one due at 23:55 today does.
- [ ] A schedule that fired at 06:15 today renders dimmed, above the due list,
      with `ran at 06:15`.
- [ ] Paused and errored schedules render with their status chip.
- [ ] A schedule with no computable next fire is absent and is not counted in the
      overflow number.
- [ ] With 9 still due, 6 render and the link reads `+3 more →`.
- [ ] With nothing at all, the empty state and its `Set something up →` action
      render.

### This week

- [ ] The headline equals the sum of the active scope's usage over the same 7-day
      window, to the cent; with all of an account's usage in one Organization it
      equals the costs surface's 7-day total.
- [ ] With usage in two Organizations, each Organization's headline, run count and
      average count only that Organization's usage and Runs, while the cap bar
      shows the same percentage in both and reads `account-wide`.
- [ ] The average line reads `—` when the 7-day run count is zero.
- [ ] With a cap and 78% used, the bar is neutral; at 80% amber; at 100% danger
      with the blocked-or-overage line.
- [ ] With no cap, `No spend cap set.` and `Set a cap →` render instead of a bar.
- [ ] `Manage spend →` lands on the costs surface with the 7-day window selected.
- [ ] An account with no recorded spend does not render the panel at all.

### Working now

- [ ] Two running Runs render, longest first, with agent name, activity line and
      elapsed time.
- [ ] A Run with no activity line shows `Working…`.
- [ ] A Run at 31 minutes carries `long run`; at 121 minutes it carries
      `still going` in amber.
- [ ] With 7 running, 5 render and `See all runs →` shows the exact total.
- [ ] With none, the empty state renders and its action focuses the composer.

### Recent activity

- [ ] Exactly 8 rows render when at least 8 exist, newest first.
- [ ] Rows from today show `HH:mm`; older rows show `d MMM`.
- [ ] Each row links to the entity it concerns when one is resolvable, and is
      non-interactive when none is.

### Freshness and failure

- [ ] With the tab visible the summary re-reads once per 60 s; hiding the tab
      stops it; showing it re-reads immediately.
- [ ] A refresh that raises the decision count shows the pill; clicking it scrolls
      to the block and dismisses it.
- [ ] A refresh mid-typing does not clear the composer or move focus or scroll.
- [ ] Forcing one block to exceed 1500 ms renders that block's error card with
      `Retry`, leaves the others populated, and `Retry` re-reads only that block.
- [ ] Forcing the whole read to fail renders the whole-summary error, keeps the
      composer working, and leaves the `Your workspace` section populated.
- [ ] Home issues exactly one summary request per navigation and one per tick.
- [ ] Empty and failed states are visually and textually distinct for every block.

### Scope, security and a11y

- [ ] Switching the active Organization changes every scoped number on the screen
      and leaves no stale value; the only unchanged figure is the cap bar labelled
      `account-wide`.
- [ ] No request Home issues accepts a user id or an organization id parameter.
- [ ] An id belonging to another account answers "not found" identically to an id
      that does not exist.
- [ ] No response behind Home contains a credential, a token or a raw external
      error body.
- [ ] Every block is a named landmark; a screen reader announces the score line
      once on load.
- [ ] The whole screen is operable by keyboard alone, including answering a
      decision.
- [ ] Every chip that carries a tone also carries text.
- [ ] Every string on the screen resolves from a translation key; switching locale
      leaves no English behind, and no key contains a literal `.` in its leaf name.
- [ ] With the browser timezone unavailable, counts use UTC and the footnote
      renders.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: is "this week" a rolling 7 days or the calendar week?]**
  This spec pins a rolling 7-day window because that is the window the costs
  surface already supports, and it labels it `last 7 days` so the copy is honest.
  If Product wants a Monday-to-now calendar week, the costs surface must first
  accept a window that is not one of its three fixed lengths.
- **[NEEDS CLARIFICATION: where does the user's timezone come from long-term?]**
  This spec takes it from the browser and validates it server-side, falling back
  to the account's notification timezone and then to UTC. A first-class account
  timezone would be better for every time-bounded surface (this one, the digest,
  quiet hours) and is worth its own small epic.
- **[NEEDS CLARIFICATION: should "done today" count Runs or Tasks?]**
  This spec counts Runs, because a Run is the unit that finishes. An owner may
  read "done" as "Tasks moved to Done". If so, the counter should show both, which
  costs a column of width the glance row does not have.
- **[NEEDS CLARIFICATION: should the composer be able to address an Agent?]**
  Out of scope here. If a later epic adds `@name` addressing, Home should adopt
  it rather than inventing its own syntax.
- **[NEEDS CLARIFICATION: does the "Also broken" list belong in Needs you?]**
  It is currently a sub-list so the morning screen has one place to look. It could
  equally be its own block. The counter treatment (never counted as "need you") is
  the part that matters and should survive either choice.
- **[NEEDS CLARIFICATION: what happens to the existing mock activity component?]**
  A component named for recent activity exists in the codebase, is not rendered
  anywhere, contains hard-coded sample rows and hard-coded English. This epic
  neither renders nor deletes it. Deleting it needs an explicit decision.
- **[NEEDS CLARIFICATION: should hidden blocks be per-Organization?]**
  This spec makes the preference per-user, so it survives an Organization switch.
  An owner running two very different Organizations may want per-scope layouts.
- **[NEEDS CLARIFICATION: does the 60-second cadence need to adapt?]**
  A workspace with nothing running does not need a read a minute. Backing off to
  5 minutes after 10 consecutive unchanged reads would cut load substantially; it
  is deliberately left out of P3 until we have real numbers.

---

## 10. Non-functional requirements

- **NFR-1.** Summary p95 ≤ 800 ms server time, hard ceiling 3000 ms, per-block
  budget 1500 ms.
- **NFR-2.** Home issues one summary request per navigation and per refresh tick;
  the total request count for the morning stack is 1, not 18.
- **NFR-3.** The summary response is cacheable per user and scope for 10 seconds
  and must never be cached by a shared cache or a browser disk cache.
- **NFR-4.** Every query behind the summary is bounded: no unbounded scan, no
  query without a row limit, and no per-row follow-up query.
- **NFR-5.** Home's added client bundle weight is ≤ 40 KB gzipped over today's.
- **NFR-6.** Cumulative layout shift attributable to blocks resolving is ≤ 0.1;
  skeletons match populated heights within 8 px.
- **NFR-7.** A failing block never fails the page, and a failing page never fails
  the shell.
- **NFR-8.** Every failure is recorded with the block that failed and the reason;
  a silently empty block is a defect, not a degradation.

---

## 11. Constitution gates

| Gate | Status | Note |
| --- | --- | --- |
| I — Plugin-first | ✅ | No external integration. Home reads platform data only. |
| II — Capability-driven | ✅ | No plugin id appears anywhere in this epic. |
| III — Source-of-truth repos | ✅ | No content is read from or written to a repository. |
| IV — Job runtime | ✅ | Home dispatches no background work. The composer creates a Task through the existing path; whatever that path dispatches is unchanged. |
| V — Forward-only migrations | ✅ | One additive preference table and one additive index, both forward-only, both shipping with the change that needs them. |
| VI — Tests first-class | ✅ | Unit tests for every threshold in §4, controller tests for the new read, an end-to-end test per user scenario in §3.1 and for §3.2's failure paths. |
| VII — Secrets | ✅ | Nothing Home reads is a secret; failure copy is keyed, never provider text (FR-73). |
| VIII — Plugin counts | ✅ | No plugin list changes. |
| IX — Behaviour-first spec | ✅ | This document names no class, path or library. |
| X — Backwards compatibility | ✅ | No existing endpoint, response shape or i18n key changes meaning. One new read is added; existing reads keep working. |

---

## 12. Cross-references

- Program overview and rules — [`../README.md`](../README.md)
- Task board (the lane the composer's Task lands in) — [`../AW-02-task-board/spec.md`](../AW-02-task-board/spec.md)
- My Decisions (owns the decision queue Home previews) — [`../AW-03-decision-queue/`](../AW-03-decision-queue/)
- Live Feed (owns the feed Home tails) — [`../AW-04-live-feed/`](../AW-04-live-feed/)
- Runs & receipts (owns the Runs Home counts) — [`../AW-09-runs-receipts/`](../AW-09-runs-receipts/)
- Schedules & calendar (owns the cadence Home shows for today) — [`../AW-10-schedules-calendar/`](../AW-10-schedules-calendar/)
- Costs & caps (owns the meters Home summarises) — [`../AW-17-costs-caps/`](../AW-17-costs-caps/)
- Command palette (registers Home's keys in the shared shortcut surface) — [`../AW-01-command-palette/spec.md`](../AW-01-command-palette/spec.md)
- Existing schedules aggregation this epic widens — [`../../schedules/spec.md`](../../schedules/spec.md)
- Implementation plan — [`./plan.md`](./plan.md)
- Task breakdown — [`./tasks.md`](./tasks.md)
