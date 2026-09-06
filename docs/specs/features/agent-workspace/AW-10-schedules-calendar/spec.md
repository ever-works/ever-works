# AW-10 — Schedules, calendar and heartbeats

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `AW-10-schedules-calendar`
**Program:** [Agent Workspace](../README.md) · Wave 2 (the loop closes)
**Branch:** `feat/aw-10-schedules-calendar`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** L · **Depends on:** [AW-09](../AW-09-runs-receipts/spec.md) (Runs & receipts)
**Extends (existing Ever Works nouns):** Schedule · Trigger · Agent · Task · Mission · Work · Run · Organization

---

## 0. TL;DR

Ever Works already fires unattended work six different ways — recurring Tasks, Agent
heartbeats, Work schedules, Mission ticks, item source-validation, data-sync polling — plus
inbound Triggers, and it already has a read-only projection that unions all seven. What it does
not have is a place where an owner can **author** a standing instruction, **see the week
shaped like a week**, and **stop everything in one move when they are mid-restructure**.

This epic makes Schedules a first-class surface:

- A **standing definition** = instructions + a cadence + options (which model, a time limit,
  whether completing announces itself, whether each fire shows up on the Tasks board).
- **Heartbeats** stay the lighter, instruction-free form — a per-Agent periodic wake in which the
  Agent looks over what it is responsible for and decides for itself — and gain a pause that does
  not destroy the cadence, plus an **overlap warning** when an Agent's heartbeat and its Schedules
  are provably doing the same job.
- **One workspace-wide list** of every Schedule from every source, with run-now, pause, resume,
  edit, duplicate and reassign on the row.
- **A calendar** that reads the workspace's real state: paused Schedules show paused, a
  Schedule that has never fired still shows, and every past occurrence says whether a Run
  actually happened.
- **A NEVER RUNS flag** for a Schedule that cannot fire, with a previewed one-click repair —
  because a cadence that silently does nothing forever is the most expensive bug this platform
  can ship to a non-technical owner.
- **A disable-all circuit breaker**, per Agent and workspace-wide, that pauses without deleting
  and can be undone exactly once, within 15 minutes.

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  /schedules                                     [ List ] [ Calendar ]     │
   │                                                                          │
   │  ⚠ 3 schedules will never run    [ Review and fix ]                      │
   │  ┌────────────────────────────────────────────────────────────────────┐  │
   │  │ SCHEDULE            AGENT     CADENCE          NEXT      HEALTH     │  │
   │  │ Morning inbox scan  Inbox     Every day 07:00  in 4h     OK      ⋯  │  │
   │  │ Weekly site audit   Site      Every Friday     in 2d     OK      ⋯  │  │
   │  │ Month-end rollup    Finance   Day 30 of Feb    —         NEVER   ⋯  │  │
   │  │ Heartbeat           Research  Every 15 min     in 6m     OVERLAP ⋯  │  │
   │  └────────────────────────────────────────────────────────────────────┘  │
   │                                     ⋯ = run now · pause · edit ·          │
   │                                         duplicate · reassign             │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │  switch to Calendar
                                        ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ◀  Week of Mon 8 Sep  ▶   [Today]        Mon Tue Wed Thu Fri Sat Sun    │
   │  07:00  Morning inbox scan ✓ran  ✓ran  ✓ran  ✗failed  ·upcoming ·   ·    │
   │  09:00  Data sync          ✓ran  ✓ran  ⊘paused ⊘paused ⊘paused ·   ·    │
   │  17:00  Weekly site audit    ·     ·     ·      ·     ·upcoming ·   ·    │
   └──────────────────────────────────────────────────────────────────────────┘
```

Three phases, each independently shippable:

- **P1 — The workspace list.** `/schedules` as its own surface, every source in one paged list,
  health badge, and row controls including a pause that preserves the cadence.
- **P2 — The standing definition and the calendar.** The Schedule editor with its guided
  instruction form and options, announce-on-completion, duplicate, reassign, heartbeat overlap
  warnings, and the week/month calendar with did-it-run markers.
- **P3 — Bulk safety.** Fix-all with a preview, the disable-all circuit breaker with undo, and
  multi-select pause/resume.

---

## 1. Overview

**Schedules** becomes a workspace surface with two views over one truth. The **List** view shows
every Schedule the workspace owns — recurring Tasks, Agent heartbeats, Work schedules, Mission
ticks, source-validation checks, data-sync polls and inbound Triggers — as one row each, with
the owning Agent, the cadence in plain English, the next fire as a live countdown, the last
outcome, a health badge, and a row menu that can run it now, pause it, resume it, edit it,
duplicate it or hand it to a different Agent. The **Calendar** view lays the same Schedules onto
a week or a month and marks every past occurrence with what actually happened, so
"did Friday's scan run?" is a glance rather than an investigation.

The seven sources do not all produce the same thing, and the surface never pretends otherwise. A
recurring Task fire spawns a **Task** that an Agent picks up and executes as a **Run**; a heartbeat
wakes an Agent and produces a Run; a **Mission** tick raises **Ideas**, and through them Works — the
tick itself spawns no Task and dispatches no Run. A Mission is therefore a *source* of work here —
a Task filed against it carries its id, but the cadence does not create one — and it appears as an
owner, a provenance chip and a filter, never as a unit of work itself.

Authoring a Schedule means writing a **standing definition**: instructions that will be executed
with nobody watching, a cadence, and options — the model to run it with, a time limit, whether
its completion announces itself, and whether each fire appears on the Tasks board. A guided form
walks a first-time author through the six things an unattended instruction needs: the cadence,
the inputs, the work, the output, the edge case, and the one thing it must never do.

**Heartbeats** are the lighter form: a per-Agent periodic wake with no instructions of its own,
where the Agent decides for itself whether anything it is responsible for needs attention. They
keep their own cadence,
gain a pause that preserves that cadence, and gain an advisory warning when they and the Agent's
Schedules are demonstrably overlapping.

Two safety surfaces sit on top. **NEVER RUNS** flags any Schedule that cannot fire — an
impossible calendar date, an end date already in the past, an exhausted occurrence cap, a past
one-shot, an unparseable cadence, an archived owner, or no Agent that could run it — and offers
a previewed repair, single or in bulk. **Disable all** is a circuit breaker: one action pauses
every Schedule on one Agent, or every Schedule in the workspace, without deleting anything, and
can be undone exactly once within 15 minutes.

---

## 2. Why now

### 2.1 The user's question

> *"What is my workspace going to do this week without me — and why did nothing happen on
> Friday?"*

An owner who has delegated recurring work needs both halves of that sentence answered on one
screen. The first half is a forecast; the second is an audit. Today Ever Works answers the first
half only partially and the second half not at all.

### 2.2 What they do today, and why it does not answer the question

| To answer… | Today they must… | What breaks |
| --- | --- | --- |
| "What is scheduled at all?" | Open Activity, switch to the Schedules tab via a query parameter. | The unified projection exists and is good, but it is buried inside another page, has no route of its own, and is un-paginated with a hard cap of 500 rows per source. |
| "What runs on Tuesday?" | Read a flat list sorted by next fire and do the date arithmetic in their head. | There is no time-shaped view of recurring work anywhere in the product. |
| "Set up 'every morning, read the notes and update the summary'." | Create a Task, open it, set a recurrence rule, assign an Agent, hope the assignment resolves. | Authoring is spread across three steps on two surfaces, and the crucial options an unattended instruction needs — which model, how long it may run, whether it tells anyone it finished — do not exist at all. |
| "Pause the 09:00 job for a week." | Delete its recurrence, then rebuild it later from memory. | There is no pause for a recurring Task. The only reversible stop is pausing the whole Agent, which also stops its assigned work. |
| "Stop everything, I am restructuring this Agent." | Pause the Agent, or clear each cadence one at a time. | Pausing the Agent is a bigger hammer than intended and stops in-flight Task work too. Clearing cadences is destructive and unrecoverable. |
| "Why did the month-end rollup never run?" | Nothing. | A cadence that names 30 February is accepted, stored, and silently does nothing forever. So is a recurrence whose end date has passed, and so is a recurring Task with no resolvable Agent — that last case raises one notification and then leaves the Task sitting in `todo` looking healthy. |
| "Did Friday's scan run?" | Cross-reference the Schedules tab (what should have happened) with Runs (what did). | Two surfaces, two time models, and nothing that renders the expected occurrence and the actual Run side by side. |
| "Which of these two things is doing the same job twice?" | Nothing. | An Agent with a 15-minute heartbeat *and* a 30-minute Schedule that reads the same inbox doubles the spend and produces duplicate output. Nothing detects it. |
| "Tell me when the weekly report is done — but not every hour." | Nothing. | Announcement is all-or-nothing at the notification-preferences level, not a property of the individual Schedule, which is the only place where the author knows whether the output is interesting. |

### 2.3 The five gaps this epic closes

1. **No home.** Recurring work is the part of the product that runs when the owner is asleep,
   and it lives behind a query parameter on another page.
2. **No authored options.** A standing instruction and an ad-hoc one are executed identically,
   yet they have completely different needs: unattended work wants a cheaper model, a hard time
   limit, and a decision about whether finishing is newsworthy.
3. **No reversible stop.** Pause is missing at the level people actually want it — one cadence,
   one Agent's cadences, or the whole workspace — so users either over-pause or delete.
4. **Silent unsatisfiability.** The platform accepts cadences that can never fire and owners that
   can never run, and then says nothing, forever. This is the single most damaging failure mode
   in an unattended-work product, because the absence of an error looks exactly like success.
5. **No time shape.** Cadence is a temporal fact presented as an alphabetical list.

### 2.4 Why this epic is additive only

Per [program rule 1](../README.md#5-rules-every-epic-spec-in-this-program-must-follow), nothing is
removed or renamed. The Schedules tab inside Activity keeps working and gains a link to the new
surface. Both existing Trigger management surfaces keep working. Every per-entity scheduling
control — the recurrence section on a Task, the heartbeat field on an Agent's settings, the Work
schedule page, the Mission cadence field — keeps working and is not moved. The new surface reads
and writes through the same paths those surfaces already use.

### 2.5 What this epic deliberately does *not* re-invent

AW-09 owns the Run ledger, the receipt, and the Upcoming panel with its countdowns. This epic
does not build a second run history and does not define a second notion of "what is about to
happen". Where this surface needs to say whether an occurrence produced a Run, it links to that
Run's receipt. Where AW-09's Upcoming panel needs the next fires, it reads the same projection
this epic extends.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — The Sunday-evening forecast.**
**Given** an owner with 14 Schedules across 5 Agents,
**when** they open Schedules and switch to the Calendar's Week view,
**then** they see every fire expected in the next seven days laid out by day and time, each chip
naming the Schedule and its Agent, with paused Schedules drawn greyed rather than hidden,
**and** the week's total expected fires is stated above the grid.

**S2 — Writing a standing instruction that ages well.**
**Given** an owner creating their first Schedule,
**when** they choose **New schedule**,
**then** the guided form is on by default and asks, in order, for the cadence, the inputs to
read, the work to do, the output to produce, the one edge case, and the one thing it must never
do; **and** the composed instruction is shown as plain text they can keep editing freely;
**and** the options panel offers a model, a time limit and an announce toggle, each showing what
it inherits when left alone.

**S3 — Running one now without disturbing the rhythm.**
**Given** a Schedule that next fires in 4 hours,
**when** the owner chooses **Run now** from its row menu,
**then** a Run is dispatched immediately, a toast confirms it with a link to the Run,
**and** the next scheduled fire is still in 4 hours — the out-of-band run is additive and never
moves the cadence, and the interface says so.

**S4 — Handing a Schedule to a different Agent.**
**Given** a Schedule owned by the Research Agent,
**when** the owner chooses **Reassign** and picks the Content Agent,
**then** the Schedule keeps its instructions, cadence, options and next fire, the row's Agent
column updates, and an activity entry records who moved it, from which Agent, to which.

**S5 — Catching the schedule that could never fire.**
**Given** a Schedule whose cadence names day 30 of February,
**when** the owner opens Schedules,
**then** a banner reads *"3 schedules will never run"*, the row carries a red **NEVER RUNS**
badge with the reason *"February never has a 30th day"*,
**and** choosing **Fix** shows the proposed change — `Day 30 of February` → `Day 28 of February` —
before anything is written.

**S6 — Fixing all of them at once.**
**Given** five Schedules flagged NEVER RUNS, three of them repairable without a decision,
**when** the owner chooses **Fix all**,
**then** a preview lists the three proposed before/after changes and the two that cannot be
repaired automatically with the reason why,
**and** **Apply 3 fixes** writes only those three, shows an **Undo** for 15 minutes, and leaves
the other two flagged.

**S7 — The circuit breaker.**
**Given** an owner about to redefine what the Inbox Agent is responsible for,
**when** they choose **Disable all** on that Agent,
**then** a dialog states exactly how many Schedules and whether the heartbeat is included, notes
how many Runs are currently in flight (which it will not cancel), and on confirm pauses all of
them without deleting anything,
**and** a banner offers **Undo** for 15 minutes; after that, re-enabling is done one Schedule at
a time, on purpose.

**S8 — Two things doing one job.**
**Given** an Agent with a 15-minute heartbeat and a 30-minute Schedule that reads the same
inbox,
**when** the owner opens either the Agent's heartbeat setting or that Schedule,
**then** an advisory warning names the other one, states the evidence (*"these fire in the same
minute 48 times in the next 7 days"* and *"their instructions overlap heavily"*), and offers to
open the other for editing,
**and** nothing is blocked — the owner may keep both.

**S9 — Answering "did Friday's scan run?"**
**Given** an owner who expected a Friday 17:00 fire,
**when** they open the Calendar and look at last Friday,
**then** the 17:00 chip shows one of: **ran** (with duration and cost, linking to the Run
receipt), **failed** (with the classified reason, linking to the receipt), **did not run** (with
the reason the platform knows — paused at the time, no Agent, workspace over its cap), or
**unknown** if the occurrence predates the workspace's Run retention.

**S10 — Pausing one cadence, not the Agent.**
**Given** an Agent that both answers assigned Tasks and runs a noisy hourly Schedule,
**when** the owner pauses just that Schedule,
**then** the Schedule stops firing, its cadence and instructions are preserved intact, the Agent
stays active, and the Agent's assigned Task work is unaffected.

### 3.2 Unhappy paths, races, denials and empty states

**U1 — A source is temporarily unreadable.**
**Given** the Mission query fails while the other six succeed,
**when** the list loads,
**then** the rows from the six healthy sources render, an inline notice reads *"Mission schedules
could not be loaded"* with **Retry**, and the totals above the list say they exclude that source.
The page never blanks because one source is sick.

**U2 — Run now while a Run for the same Schedule is already in flight.**
**Given** a Schedule whose previous fire is still running,
**when** the owner chooses **Run now**,
**then** the action is refused with *"This schedule is already running — opened at 09:04"* and a
link to the in-flight Run. No second Run is created.

**U3 — Run now with no Agent that can run it.**
**Given** a recurring Task Schedule with no assignee and no Agent,
**when** the owner chooses **Run now**,
**then** the action is refused with *"No agent is assigned to this schedule"* and an **Assign an
agent** control, and the row's health badge already read NEVER RUNS for the same reason.

**U4 — Two people fix the same Schedule at once.**
**Given** two members of the same Organization looking at the same NEVER RUNS banner,
**when** both apply a fix,
**then** the second apply detects that the Schedule no longer matches the previewed "before"
state, skips it, and reports *"1 schedule changed since you previewed — nothing was overwritten"*.
No repair is ever applied to a state it did not preview.

**U5 — Undo after the window has closed.**
**Given** a disable-all performed 20 minutes ago,
**when** the owner presses **Undo**,
**then** the action is refused with *"The undo window has closed. Re-enable schedules
individually."* and the list scrolls to the paused rows with a filter applied.

**U6 — Undo after someone else changed one of the paused Schedules.**
**Given** a disable-all batch of 12, one of which has since been edited and resumed by a
teammate,
**when** **Undo** is pressed inside the window,
**then** 11 are resumed, the twelfth is left exactly as the teammate left it, and the result
reads *"Resumed 11 of 12. 1 was changed after the pause and was left alone."*

**U7 — The workspace breaker on a workspace that is too large.**
**Given** a workspace with 640 enabled Schedules,
**when** the owner opens the workspace-wide **Disable all**,
**then** the action is refused before anything is written with *"Disable all covers up to 500
schedules at once. Filter to an agent, or pause in batches."*

**U8 — The calendar window is too wide.**
**Given** an owner who navigates to a four-month range,
**when** the calendar requests it,
**then** the request is refused with *"Calendar shows up to 92 days at a time"* and the range
snaps back to the last valid window, without losing the filters.

**U9 — Too many occurrences to draw.**
**Given** a month containing a per-5-minute Schedule,
**when** the month view expands occurrences,
**then** expansion stops at 500 occurrences for that Schedule and 2,000 for the view; the
affected rows render a *"showing the first 500 of this schedule's fires"* marker rather than a
truncated grid with no explanation.

**U10 — Schedule cap reached.**
**Given** an Agent that already owns 50 Schedules,
**when** the owner tries to create the 51st,
**then** creation is refused with *"This agent has the maximum of 50 schedules. Retire one, or
create it on another agent."* and the create form stays populated so nothing is lost.

**U11 — A cadence tighter than the floor.**
**Given** an author who enters a 2-minute cadence,
**when** they save,
**then** the save is refused with *"The tightest cadence is every 5 minutes"*; a cadence between
5 and 15 minutes saves but shows a persistent warning naming the expected daily fire count and
linking to costs.

**U12 — Permission denied.**
**Given** a viewer who may read the workspace but not edit the Content Agent,
**when** they open Schedules,
**then** rows they may not change render with their controls disabled and a tooltip *"You do not
have permission to change this agent's schedules"*; the row still shows cadence, next fire and
health, because reading is allowed.

**U13 — A Schedule for an entity the caller does not own.**
**Given** a crafted request naming another user's Schedule id,
**when** any read or control is attempted,
**then** the response is identical to one for a Schedule that does not exist. Nothing
distinguishes "not yours" from "not there".

**U14 — Nothing scheduled at all.**
**Given** a brand-new workspace,
**when** Schedules is opened,
**then** the empty state reads *"Nothing is scheduled yet"* with one sentence of explanation and
three routes in: create a schedule, give an agent a heartbeat, or set a work to update itself.

**U15 — Filters match nothing.**
**Given** filters set to Agent = Finance, Health = Never runs,
**when** no row matches,
**then** the list reads *"No schedules match these filters"* with **Clear filters**, and the
unfiltered total is stated so the user knows the list is not empty.

**U16 — Five failures in a row.**
**Given** a Schedule whose last five fires all failed,
**when** the fifth failure is recorded,
**then** the Schedule auto-pauses, its row shows **Paused after 5 failures** with the last error,
a notification is raised even if announcements are off for that Schedule, and **Resume** is one
click with the failure reason in front of the user.

**U17 — Announcements from a chatty Schedule.**
**Given** a Schedule that fires every 5 minutes with announcements on,
**when** it completes more than 20 times in a day,
**then** further announcements for that day are rolled into one hourly summary entry rather than
being dropped, and the Schedule's row shows *"Announcements rolled up"*.

**U18 — Reassigning to an archived Agent.**
**Given** an Agent that has been archived,
**when** it is chosen as the reassign target,
**then** it is not offered in the picker at all; if it is archived between opening the picker and
confirming, the confirm fails with *"That agent has been archived"* and the Schedule is unchanged.

**U19 — The background scan is not configured.**
**Given** a deployment with no job runtime configured,
**when** the health sweep would run,
**then** the surface says so plainly — *"Health was last checked 3 days ago"* with the timestamp
— rather than presenting stale health as current. Health is recomputed on every write regardless,
so an edited Schedule is always accurate.

**U20 — Pausing a Mission's cadence.**
**Given** a `Mission tick` row,
**when** the owner presses **Pause** on it,
**then** a confirmation states plainly that pausing this cadence pauses the whole Mission — it
stops raising new Ideas, and so stops producing new work — that the Ideas and Works it has already
raised are left alone, and offers to open the Mission instead. Nothing is paused until that is
acknowledged.

---

## 4. Functional requirements

Numbers here are normative. Every default, limit and threshold is a number.

### 4.1 The surface

- **FR-1** Schedules MUST be reachable at its own workspace route and MUST appear as its own
  entry in the primary navigation.
- **FR-2** The surface MUST offer exactly two views, **List** and **Calendar**, switchable
  without a page reload, with the choice remembered per user and reflected in a shareable link.
- **FR-3** The existing Schedules tab inside Activity MUST keep working unchanged and MUST gain a
  link to this surface. No existing scheduling control anywhere in the product is moved or removed.
- **FR-4** Both views MUST cover **all seven** existing schedule sources — recurring Tasks, Agent
  heartbeats, Work schedules, Mission ticks, source-validation checks, data-sync polls and inbound
  Triggers — with no source hidden by default.
- **FR-5** Every row MUST state which source it came from, so a user always knows which part of
  the product owns the thing they are looking at.

### 4.2 The list

- **FR-6** The list MUST be paginated with a page size of **50** rows and MUST support continuing
  beyond the first page. It MUST NOT be capped at a fixed maximum row count.
- **FR-7** Default sort MUST be next fire ascending with rows that have no computable next fire
  last, tie-broken by Schedule name ascending.
- **FR-8** The list MUST offer filters for Agent, source, status, health, and a free-text search
  over the Schedule's name and instructions. Filters MUST be reflected in the link.
- **FR-9** Each row MUST show: name, owning Agent (or "—" when the source has none), cadence in
  plain English, next fire as a live countdown, last fire with its outcome, health badge, and
  status.
- **FR-10** Countdowns MUST update at least once per second while visible; the list MUST re-read
  from the server at least every **60 seconds** and immediately when the browser tab regains focus.
- **FR-11** A cadence MUST always be displayed with the time zone it is evaluated in. In this
  epic every source is evaluated in **UTC**; the interface MUST show the UTC time and the same
  instant in the viewer's local zone.
- **FR-12** A row whose source cannot supply a next fire MUST render "—" and a one-line reason,
  never a guessed time.

### 4.3 Row controls

- **FR-13** Each row MUST declare which of six controls apply to it: **run now**, **pause**,
  **resume**, **edit**, **duplicate**, **reassign**. Controls that do not apply MUST be shown
  disabled with a one-line reason, not hidden.
- **FR-14** **Run now** MUST dispatch an out-of-band execution immediately and MUST NOT change
  the next scheduled fire. The interface MUST state this, and MUST link to what that fire actually
  produced — the Run for a source that produces one, and the owning entity for a source that does
  not. A Mission tick produces Ideas, and through them Works; it produces no Run, and the interface
  MUST NOT offer a Run link it cannot make.
- **FR-15** **Run now** MUST be limited to **10 invocations per minute per user** and MUST be
  refused with a stated reason when: an execution for the same Schedule is already in flight; no
  Agent can be resolved; the owning entity is archived; or the workspace's credit balance cannot
  cover it.
- **FR-16** **Run now** on a paused Schedule MUST be permitted and MUST NOT resume it.
- **FR-17** **Pause** MUST preserve the cadence, the instructions and every option exactly.
  Resuming MUST restore firing without the user re-entering anything.
- **FR-18** Pausing an Agent heartbeat MUST NOT pause the Agent and MUST NOT stop that Agent's
  assigned Task work.
- **FR-19** Pausing a Mission tick MUST require an explicit acknowledgement that this pauses the
  whole Mission, because that cadence is not separable from its Mission. The acknowledgement MUST
  state what pausing actually stops — the Mission stops raising new Ideas, and so stops producing
  new work — and MUST state that the Ideas and Works it has already raised are left exactly as
  they are.
- **FR-20** **Duplicate** MUST copy instructions, cadence and options; MUST NOT copy run history;
  MUST name the copy `<name> (copy)`; and MUST create it **paused**, so an accidental duplicate
  never doubles the work.
- **FR-21** **Reassign** MUST move the Schedule to another Agent in the same workspace, keeping
  instructions, cadence, options and next fire. Archived Agents MUST NOT be offered.
- **FR-22** Duplicate and reassign MUST be available for Schedules the user authored. For sources
  that have no authored form, both MUST be disabled with the reason.
- **FR-23** Every control MUST write an activity entry naming the actor, the Schedule, the
  control and the before/after value where one applies.

### 4.4 The standing definition

- **FR-24** A Schedule MUST carry: a **name** (1–200 characters), **instructions** (1–8,000
  characters), and a **cadence**. All three are required; a definition without a cadence is not a
  Schedule.
- **FR-25** Cadence MUST be authorable in three styles: *every day at HH:MM*, *every
  &lt;weekday&gt; at HH:MM*, and an advanced expression (a five-field cron expression or an
  RFC 5545 recurrence rule). The advanced field MUST validate on blur and show the next three
  computed fire times before saving.
- **FR-26** The minimum cadence interval MUST be **5 minutes**. A cadence tighter than that MUST
  be refused. A cadence between 5 and 15 minutes MUST save with a persistent warning stating the
  expected fires per day.
- **FR-27** Options MUST include: **model** (default: inherit the Agent's, then the account
  default), **time limit** in seconds (**60**–**14,400**, default: inherit the Agent's limit,
  then the deployment default of **1,800**), **announce on completion** (boolean), and **show each
  fire on the Tasks board** (boolean, default on).
- **FR-28** The effective time limit MUST resolve Schedule → Agent → deployment default, and the
  editor MUST show which level supplied the value in force.
- **FR-29** **Announce on completion** MUST default to **on** when the cadence fires **7 or fewer
  times per week** and **off** otherwise.
- **FR-30** A guided instruction form MUST be offered, collecting the cadence restatement, the
  inputs to read, the work, the output, one edge case, and one prohibition ("never …"). It MUST
  be on by default for a user's first **3** Schedules and dismissible at any time. The composed
  text MUST remain freely editable; the form MUST never be the only way to author.
- **FR-31** A workspace MUST support at most **500** Schedules and an Agent at most **50**.
  Exceeding either MUST be refused before any write, with the current count stated.
- **FR-32** Editing a Schedule MUST recompute its next fire and its health immediately, and the
  new next fire MUST be shown in the save confirmation.

### 4.5 Heartbeats

- **FR-33** A heartbeat MUST remain a per-Agent cadence with **no instructions of its own**; what
  it does is defined by the Agent's own instructions, not by the heartbeat.
- **FR-34** A heartbeat MUST be pausable and resumable without losing its cadence, independently
  of the Agent's own status.
- **FR-35** The minimum heartbeat interval MUST be **5 minutes**. A heartbeat tighter than
  **15 minutes** on an Agent that also owns at least one enabled Schedule MUST show a warning.
- **FR-36** The platform MUST detect and warn about two kinds of overlap between an Agent's
  heartbeat and its Schedules:
  - **coincidence** — the two fire within the same minute **2 or more times in the next 7 days**;
  - **duty overlap** — the significant-term overlap between the Schedule's instructions and the
    Agent's heartbeat instructions is **0.35 or higher** on a normalised comparison.
- **FR-37** Overlap warnings MUST be advisory only. They MUST never block a save. They MUST be
  dismissible per pair for **30 days** and MUST reappear if either side is edited.
- **FR-38** The overlap warning MUST name the specific counterpart, state the evidence in
  numbers, and link to it.

### 4.6 Health and NEVER RUNS

- **FR-39** Every Schedule MUST carry a health verdict, either **OK** or **NEVER RUNS** with
  exactly one reason from this closed set:

  | Reason | Meaning |
  | --- | --- |
  | `impossible-date` | The cadence names a calendar date that cannot occur. |
  | `ended` | The recurrence end date is in the past. |
  | `exhausted` | The maximum number of occurrences has been reached. |
  | `past-one-shot` | A one-time instant is in the past and was never claimed. |
  | `unparseable` | The cadence cannot be parsed. |
  | `no-agent` | No Agent can be resolved to execute it. |
  | `owner-archived` | The owning Agent or Work is archived, or the owning Agent, Mission or Work no longer exists. A Mission the owner *completed* is **Ended**, not this. |

- **FR-40** NEVER RUNS MUST mean **unsatisfiable**, not **infrequent**. A cadence that fires once
  a year, or on 29 February, MUST NOT be flagged. Absence of a fire inside any look-ahead window
  is never, on its own, evidence of unsatisfiability.
- **FR-41** A **paused** Schedule MUST NOT be flagged NEVER RUNS. Paused is a state the user
  chose; NEVER RUNS is a defect. For the same reason, a Mission tick whose Mission the owner has
  marked **completed** MUST render **Ended**, not NEVER RUNS — finishing an initiative is a choice,
  not a fault in its cadence.
- **FR-42** A Schedule that exists, is valid and has simply never fired yet MUST render as OK
  with a "never run yet" note. It MUST remain visible in both views.
- **FR-43** Health MUST be recomputed on every write to a Schedule and by a background sweep at
  least once every **24 hours**. The surface MUST show when health was last computed and MUST say
  so plainly when that is more than **48 hours** ago.
- **FR-44** When at least one Schedule is flagged, a banner MUST appear above both views stating
  the count and offering review. The banner MUST be dismissible for the session and MUST return
  on the next visit while any Schedule is still flagged.
- **FR-45** Each reason MUST declare a repair class: **automatic** (a deterministic change with
  no decision), **choice** (needs input), or **none**.

  | Reason | Class | Automatic repair |
  | --- | --- | --- |
  | `impossible-date` | automatic | Clamp the day of month to the last day that exists in every month named by the cadence (February → 28). |
  | `ended` | automatic | Clear the end date. |
  | `exhausted` | automatic | Clear the maximum-occurrence cap. |
  | `past-one-shot` | automatic | Move to the next occurrence of the same time of day, at least **5 minutes** in the future. |
  | `no-agent` | choice | Pick an Agent. |
  | `owner-archived` | choice | Restore the owner, or delete the Schedule. |
  | `unparseable` | none | Edit the cadence. |

- **FR-46** A repair MUST NEVER be written without first showing the exact before and after. This
  applies to a single **Fix** and to **Fix all** equally.
- **FR-47** **Fix all** MUST apply only automatic repairs, MUST cap one application at **200**
  Schedules, and MUST list every skipped Schedule with its reason.
- **FR-48** A repair MUST be refused for any Schedule whose current state no longer matches the
  previewed before-state, and the count of such skips MUST be reported.
- **FR-49** An applied repair batch MUST be undoable in full for **15 minutes**, restoring the
  exact previous values, and MUST record an activity entry on apply and on undo.

### 4.7 The circuit breaker

- **FR-50** **Disable all** MUST be available at two scopes: **one Agent** (every Schedule that
  Agent owns, plus its heartbeat) and **the whole workspace** (every enabled Schedule from every
  source, including inbound Triggers).
- **FR-51** The breaker MUST pause and MUST NEVER delete. Instructions, cadences and options
  survive untouched.
- **FR-52** The confirmation MUST state the exact number of Schedules affected, whether the
  heartbeat is included, and how many Runs are currently in flight. It MUST state that in-flight
  Runs are **not** cancelled and MUST link to them.
- **FR-53** The workspace-scope breaker MUST require the user to type **PAUSE** to confirm. The
  Agent-scope breaker MUST require a single confirm.
- **FR-54** One breaker action MUST cover at most **500** Schedules; a larger scope MUST be
  refused before any write, with guidance to narrow the scope.
- **FR-55** The breaker MUST record exactly which Schedules it transitioned, and MUST offer
  **Undo** for **15 minutes** that resumes exactly and only that set.
- **FR-56** Undo MUST skip any Schedule whose state changed after the pause and MUST report how
  many it skipped and why.
- **FR-57** After the undo window closes, re-enabling MUST be per Schedule. There MUST be no
  "enable all" counterpart, because the set of responsibilities a user re-enables into is not the
  set they paused.
- **FR-58** While any breaker batch is within its undo window, a banner MUST be visible on the
  Schedules surface stating what was paused and offering undo.

### 4.8 The calendar

- **FR-59** The Calendar MUST offer **Week** (default) and **Month** views, step back and forward,
  and jump to today.
- **FR-60** The Calendar MUST read the workspace's real state: a paused Schedule renders its
  occurrences greyed and labelled paused rather than being hidden; a Schedule that has never
  fired still appears; a Schedule flagged NEVER RUNS appears in the banner above the grid, since
  it has no occurrences to draw.
- **FR-61** Every **past** occurrence MUST be marked with one of: **ran**, **failed**, **did not
  run**, or **unknown**. "Ran" and "failed" MUST link to the Run receipt where the source produces
  a Run, and to the owning entity where it does not. "Did not run" MUST state the reason where the
  platform knows it.
- **FR-62** An occurrence is matched to a Run when a Run for that Schedule started within
  **±10 minutes** of the expected fire time. Outside that window it is reported as "did not run",
  and the interface MUST NOT claim a match it cannot make.
  **Not every source produces a Run.** A Mission tick raises Ideas, and through them Works; it
  spawns no Task and dispatches no Run. For a source whose fire produces no Run, the occurrence
  MUST be resolved from that source's own record that the fire happened, within the same ±10 minute
  window, and MUST read **unknown** where the platform holds no such record. Marking such an
  occurrence "did not run" because no Run exists is forbidden: the absence of a Run is not evidence
  about a source that never creates one.
- **FR-63** "Unknown" MUST be used for occurrences older than the workspace's Run retention,
  rather than asserting the occurrence did not run.
- **FR-64** The requested range MUST be at most **92** days; a wider request MUST be refused and
  the range snapped back without losing filters.
- **FR-65** Occurrence expansion MUST be capped at **500** per Schedule and **2,000** per request;
  a capped Schedule MUST say so on its row.
- **FR-66** The Calendar MUST share the List's filter state, so switching views never loses the
  user's narrowing.
- **FR-67** Choosing an occurrence MUST open the Schedule; choosing the outcome marker on a past
  occurrence MUST open that Run's receipt, or, for a source that produces no Run, the owning entity
  the fire acted on.

### 4.9 Announcements and failure handling

- **FR-68** When **announce on completion** is on, a completed fire of that Schedule MUST produce
  one workspace activity entry and one in-app notification naming the Schedule, the Agent, the
  outcome, the duration, the cost, and linking to the Run receipt. Announce is an option of the
  standing definition, so §4.9 applies to the sources that carry one; it introduces no announcement
  on a source that has no authored options.
- **FR-69** A **failed** fire MUST announce regardless of the announce setting once **2
  consecutive fires** have failed. A Schedule that fails silently forever is not an acceptable
  outcome of turning announcements off.
- **FR-70** Announcements for one Schedule MUST be capped at **20 per day**; beyond that they MUST
  be rolled up into one hourly summary rather than dropped, and the row MUST show that roll-up is
  active.
- **FR-71** After **5 consecutive failed fires** a Schedule MUST auto-pause, MUST raise a
  notification regardless of its announce setting, and MUST show the last error and a one-click
  **Resume** on its row.
- **FR-72** Resuming after an auto-pause MUST reset the consecutive-failure count to zero.

### 4.10 Scope, permissions, performance and honesty

- **FR-73** Every read MUST be scoped to the acting user and, when an Organization is active, to
  that Organization. There MUST be no request parameter by which a caller can name a different
  user, Organization or tenant.
- **FR-74** A Schedule the caller may not read MUST produce the same response as one that does
  not exist.
- **FR-75** Every control MUST require the same permission as changing the Schedule's owning
  entity does today. This surface MUST introduce no new permission and no new way to bypass one.
- **FR-76** Rows the caller may read but not change MUST render fully with disabled controls and
  a stated reason.
- **FR-77** No value marked secret MUST be rendered anywhere on this surface, including inside
  instructions, error text and announcements.
- **FR-78** A page of 50 rows MUST return in under **800 ms** at the 95th percentile; a month of
  calendar occurrences in under **1,200 ms** at the 95th percentile; a single health verdict in
  under **200 ms**.
- **FR-79** The list, the calendar, the health banner and the breaker banner MUST load
  independently; any one failing MUST NOT prevent the others from rendering.
- **FR-80** No number on this surface may be derived from an assumption. Where a source cannot
  supply a value, the surface MUST say it is not available rather than showing a plausible guess.
- **FR-81** This epic MUST NOT introduce a second definition of any concept named in the program
  vocabulary. It reads and writes Schedules, Triggers, Agents, Tasks, Missions, Works and Runs as
  they already exist.

---

## 5. Key entities

| Concept | New or existing | What it is here |
| --- | --- | --- |
| **Schedule** | **Existing** (extended) | The unified recurring definition. Today it is a read-only projection over seven sources. This epic keeps that projection as the canonical shape and adds to each row: the owning Agent, a health verdict, a control descriptor, a paused-at instant, the consecutive-failure count, and the resolved options. |
| **Standing definition** | **Existing form, extended** | The authored kind of Schedule: instructions + cadence + options, owned by an Agent. In Ever Works this is a recurring Task bound to an Agent — the same object the Tasks surface already shows — extended with a pause that preserves the cadence, a model, a time limit, an announce flag, and a board-visibility flag. **No new noun is introduced**: it is a Schedule, and its Task remains a Task. |
| **Heartbeat** | **Existing** (extended) | A per-Agent, instruction-free periodic wake. Gains an independent pause that preserves the cadence, and overlap detection against that Agent's Schedules. |
| **Schedule health** | **New — projection only, no new table** | The verdict OK / NEVER RUNS plus one reason and one repair class, computed from the cadence, the bounds, and the owner's reachability. Declared new because "a schedule that cannot fire" has no representation today. |
| **Occurrence** | **New — projection only, no new table** | One expansion of a Schedule's cadence onto a calendar instant, past or future, together with what the platform knows actually happened at it: a matched Run for the sources that produce one, and the source's own record of the fire for those that do not. It has no id, cannot be opened on its own, and is never a Run. Presenting projections and records as the same object would make every id on this surface unreliable. |
| **Schedule bulk action** | **New — a small record** | The durable receipt of one bulk operation: a disable-all batch or a fix batch. It stores exactly which Schedules were transitioned and their previous values, so undo restores precisely that set and touches nothing a teammate changed afterwards. Justified as new because an exact undo cannot be reconstructed from the current state, and reusing the activity log for functional state would make an audit record load-bearing. |
| **Run** | **Existing** | One execution. A recurring Task fire and a heartbeat fire each produce one; a Mission tick does not (§5.2). This epic creates no run history of its own and links to AW-09's receipt. |
| **Trigger** | **Existing** | The event-driven sibling. Appears in both views with a fixed "on event" cadence and no next fire, and is included in the workspace breaker because it also starts unattended work. |
| **Task** | **Existing** | The unit of delegated work. A recurring Task template *is* the standing definition; each fire spawns a Task instance that an Agent picks up. Read and written through the Tasks paths only. |
| **Mission** | **Existing** | A standing initiative that keeps raising **Ideas**, and through them Works. It owns **one** of the seven cadences here: that cadence is the Schedule row, and the Mission is the row's source, owner, provenance and filter — never itself a unit of work. Its statuses are its own (`active` · `paused` · `completed` · `failed`) and this surface neither renames nor extends them; the lifecycle in §5.1 belongs to the Schedule. Read and written through the Missions paths only. |
| **Agent / Work** | **Existing** | Owners, link targets and filter dimensions. Read and written through their existing paths only. |

### 5.1 Schedule lifecycle

```
                    author
                      │
                      ▼
                ┌───────────┐  cadence unsatisfiable / owner unreachable
                │  ACTIVE   │────────────────────────────────┐
                └───────────┘                                │
                   │   ▲                                     ▼
      pause / ─────┘   └───── resume / undo         ┌──────────────────┐
      disable all                                   │ ACTIVE + FLAGGED │
                   │                                │   "NEVER RUNS"   │
                   ▼                                └──────────────────┘
             ┌───────────┐                                   │
             │  PAUSED   │                        fix (previewed, undoable)
             └───────────┘                                   │
                   │                                         ▼
   5 consecutive   │                                    back to ACTIVE
   failed fires    │
        │          │            end date reached / occurrence cap hit
        ▼          ▼                          │
   ┌──────────────────────┐                   ▼
   │ PAUSED (auto) + last │            ┌────────────┐
   │ error, needs resume  │            │   ENDED    │  terminal, still listed
   └──────────────────────┘            └────────────┘

   Rendering rules:
     ACTIVE           → next fire + countdown; occurrences drawn solid
     ACTIVE + FLAGGED → "—" for next fire; red badge + reason; banner counts it
     PAUSED           → cadence preserved and shown; occurrences drawn greyed
     PAUSED (auto)    → as PAUSED, plus the failure streak and the last error
     ENDED            → no future occurrences; past ones still rendered
```

**Paused is not a defect and NEVER RUNS is not a state the user chose.** The two are drawn
differently, counted separately, and never collapsed into one "inactive" bucket. **ENDED** also
covers a Mission tick whose Mission the owner has marked completed — an initiative that has
finished is ended, not broken (FR-41).

This lifecycle belongs to the **Schedule**, not to the entity that owns it. Pausing a Mission tick
moves the Mission itself to paused, which is why FR-19 asks for it out loud; nothing here gives a
Mission a status of its own on this surface.

### 5.2 What a fire produces

A standing definition and a heartbeat both end in a Run. This is the path the whole surface is
shaped around:

```
  cadence matches ──▶ claim (exactly once) ──▶ Task instance ──▶ Run ──▶ Run receipt (AW-09)
   (recurring Task)             │           (a heartbeat wakes   │
   (agent heartbeat)            │            the Agent instead)  │
                                │                                ├─ completed ─▶ announce (if on)
                                │                                ├─ failed ────▶ announce (2nd in
                                │                                │                a row)
                                │                                └─ failed x5 ─▶ auto-pause+notify
                                │
                                └─ no agent resolvable ──▶ health becomes NEVER RUNS
                                                            (today: one notification, then silence)
```

**A Mission tick does not follow that path**, and the surface must not pretend it does:

```
  cadence matches ──▶ Mission tick ──▶ Ideas raised ──▶ (Ideas build) ──▶ Works
                           │
                           └─ recorded as a Mission tick entry, not as a Run
```

A Mission is a **source** of work, not a unit of it. Its tick spawns no Task and dispatches no Run —
a Task that carries this Mission's id was filed against it, not created by the cadence — so a
Mission-tick occurrence is resolved from that tick record (FR-62), its row offers no Run receipt,
and pausing it is a decision about the whole initiative (FR-19) rather than about one job.

---

## 6. UX

All copy below is the exact user-visible English string. Every one is an i18n key
(see [plan.md §8](./plan.md#8-i18n)).

### 6.1 List view, loaded

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Schedules                                                    [ List ] [ Calendar ]   │
│ Everything that runs without you                                                     │
│                                                                                      │
│ ⚠  3 schedules will never run.                     [ Review and fix ]   [ Dismiss ]  │
│                                                                                      │
│ [ Agent ▾ ] [ Source ▾ ] [ Status ▾ ] [ Health ▾ ]  [ Search schedules…    ]  [ ✕ ]  │
│                                        14 schedules · 11 active · 3 paused           │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ SCHEDULE             AGENT     CADENCE              NEXT     LAST      HEALTH    │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │ Morning inbox scan   Inbox     Every day at 07:00   in 4h 12m  ✓ 06:59  OK    ⋯  │ │
│ │  ↳ recurring task              UTC (09:00 local)                                 │ │
│ │ Heartbeat            Research  Every 15 minutes     in 6m      ✓ 08:45  OVERLAP ⋯│ │
│ │  ↳ agent heartbeat                                                               │ │
│ │ Weekly site audit    Site      Every Friday at 17:00 in 2d      ✓ Fri     OK   ⋯ │ │
│ │  ↳ recurring task                                                                │ │
│ │ Month-end rollup     Finance   Day 30 of February   —           never    NEVER ⋯ │ │
│ │  ↳ recurring task              February never has a 30th day        RUNS         │ │
│ │ Docs data sync       —         Every 30 minutes     in 21m     ✓ 08:39  OK    ⋯  │ │
│ │  ↳ data sync                                                                     │ │
│ │ Weekly idea scan     —         Every Wed at 06:00   in 3d      ✓ Wed    OK    ⋯  │ │
│ │  ↳ mission tick                raises ideas, not runs                            │ │
│ │ Support intake       Inbox     On event             —          ✓ 08:12  OK    ⋯  │ │
│ │  ↳ inbound trigger                                                               │ │
│ │ Nightly regeneration  —        Every day at 02:00   PAUSED     ✓ Tue     OK   ⋯  │ │
│ │  ↳ work schedule               paused 8 Sep by you                               │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                        Showing 1–50 of 14        [ Load more ]       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Row menu (`⋯`), in order, with disabled entries kept in place:

```
        ┌───────────────────────────────────────────────┐
        │  Run now                                      │
        │  Pause                                        │
        │  Edit                                         │
        │  Duplicate                                    │
        │  Reassign to another agent…                   │
        │  ───────────────────────────────────────────  │
        │  Open the task                                │
        │  See past runs                                │
        └───────────────────────────────────────────────┘

  disabled example (a data-sync row):
        │  Duplicate        Data sync is configured on the work   │

  the same menu on a mission-tick row — the owner entry names what it opens,
  and there are no runs to see because a tick produces ideas, not runs:
        │  Open the mission                             │
        │  See the ideas it raised                      │
```

Copy:

- Title: **"Schedules"** · Subtitle: **"Everything that runs without you"**
- View switch: **"List"** / **"Calendar"**
- Columns: **"Schedule"**, **"Agent"**, **"Cadence"**, **"Next"**, **"Last"**, **"Health"**
- Health badges: **"OK"**, **"NEVER RUNS"**, **"OVERLAP"**
- Status chips: **"Active"**, **"Paused"**, **"Paused after 5 failures"**, **"Ended"**
- Summary line: **"{total} schedules · {active} active · {paused} paused"**
- Run-now toast: **"Running now. This does not change the next scheduled fire."**
- Run-now toast on a mission tick: **"Running one tick now. A tick raises ideas rather than a run —
  open the mission to see what it raised."**
- Pause toast: **"Paused. The cadence and instructions are kept."**
- Row-menu owner entry, per source: **"Open the task"**, **"Open the agent"**, **"Open the
  mission"**, **"Open the work"** · **"See past runs"** / **"See the ideas it raised"**
- Timezone note under a cadence: **"UTC ({local} local)"**

Keyboard: `↑`/`↓` move the focused row · `Enter` opens the Schedule · `R` run now · `P` pause or
resume · `E` edit · `D` duplicate · `/` focuses search · `V` switches view · `?` opens the
shortcut sheet · `Esc` clears the search or closes the menu.

### 6.2 List — loading

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Schedules                                                    [ List ] [ Calendar ]   │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒         │ │
│ │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒         │ │
│ │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒         │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                             Loading schedules…                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Six skeleton rows. The health banner does not render until health is known — it never flashes a
false "0 problems".

### 6.3 List — empty (nothing scheduled)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                      │
│                              Nothing is scheduled yet                                │
│                                                                                      │
│        Schedules are the work that happens without you — a morning scan, a            │
│        weekly report, a nightly refresh. Start with one of these.                     │
│                                                                                      │
│        [ Create a schedule ]   [ Give an agent a heartbeat ]   [ Set a work to        │
│                                                                  update itself ]     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 List — empty (filters match nothing)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [ Agent: Finance ▾ ] [ Health: Never runs ▾ ]                          [ Clear ✕ ]   │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │                     No schedules match these filters                             │ │
│ │            You have 14 schedules in total.      [ Clear filters ]                │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 List — a source failed to load

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠  Mission schedules could not be loaded. Everything else is shown.   [ Retry ]      │
│    Totals below exclude mission ticks.                                               │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Morning inbox scan   Inbox     Every day at 07:00   in 4h 12m  ✓ 06:59  OK    ⋯  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

And the whole-surface failure:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                          Schedules could not be loaded                               │
│              This is a problem on our side, not with your schedules.                 │
│              Nothing has been paused or changed.        [ Retry ]                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.6 Calendar — Week view

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Schedules                                                    [ List ] [ Calendar ]   │
│ ◀   Week of Mon 8 Sep – Sun 14 Sep   ▶      [ Today ]   [ Week ▾ ]                   │
│ [ Agent ▾ ] [ Source ▾ ] [ Status ▾ ]                    28 fires expected this week │
│                                                                                      │
│         Mon 8    Tue 9    Wed 10   Thu 11   Fri 12   Sat 13   Sun 14                 │
│ 02:00   ⊘ paused ⊘ paused ⊘ paused ⊘ paused ⊘ paused ⊘ paused ⊘ paused              │
│         Nightly regeneration                                                         │
│ 07:00   ✓ ran    ✓ ran    ✓ ran    ✗ failed  · 4h 12m  ·        ·                    │
│         Morning inbox scan                                                           │
│ 09:00   ✓ ran    ✓ ran    ✓ ran    ✓ ran     · 6h 12m  ·        ·                    │
│         Docs data sync (every 30 min — showing hourly)                               │
│ 17:00     ·        ·        ·        ·       · in 2d   ·        ·                    │
│         Weekly site audit                                                            │
│                                                                                      │
│ Legend:  ✓ ran   ✗ failed   ⊘ paused   ○ did not run   ? unknown   · upcoming        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Chip hover / focus, past:

```
     ┌──────────────────────────────────────────────┐
     │ Morning inbox scan · Inbox agent             │
     │ Expected Thu 11 Sep 07:00 UTC                │
     │ Failed after 4m 02s · $0.11                  │
     │ Reason: the run hit its time limit           │
     │ [ Open the receipt ]                         │
     └──────────────────────────────────────────────┘
```

Chip hover / focus, future:

```
     ┌──────────────────────────────────────────────┐
     │ Weekly site audit · Site agent               │
     │ Fires Fri 12 Sep 17:00 UTC (19:00 local)     │
     │ in 2d 8h 41m                                 │
     │ [ Open the schedule ]  [ Run now ]           │
     └──────────────────────────────────────────────┘
```

Chip, did not run:

```
     ┌──────────────────────────────────────────────┐
     │ Nightly regeneration                         │
     │ Expected Wed 10 Sep 02:00 UTC                │
     │ Did not run — paused at the time             │
     └──────────────────────────────────────────────┘
```

Chip, a source that produces no Run. A Mission tick raises Ideas rather than dispatching a Run, so
its chips are read from the tick's own record: they show **ran** or **unknown** and open the
Mission, never a receipt, and never **did not run** inferred from a Run that was never going to
exist (FR-62):

```
     ┌──────────────────────────────────────────────┐
     │ Weekly idea scan · mission tick              │
     │ Expected Wed 10 Sep 06:00 UTC                │
     │ Ran — raised 3 ideas                         │
     │ [ Open the mission ]                         │
     └──────────────────────────────────────────────┘
```

### 6.7 Calendar — Month view with the health banner

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◀   September 2026   ▶     [ Today ]   [ Month ▾ ]                                   │
│                                                                                      │
│ ⚠  3 schedules will never run and are not drawn below.   [ Review and fix ]          │
│                                                                                      │
│  Mon      Tue      Wed      Thu      Fri      Sat      Sun                           │
│ ┌──────┬────────┬────────┬────────┬────────┬────────┬────────┐                       │
│ │  1   │   2    │   3    │   4    │   5    │   6    │   7    │                       │
│ │ 4 ✓  │  4 ✓   │  4 ✓   │  4 ✓   │  5 ✓   │  2 ✓   │  2 ✓   │                       │
│ ├──────┼────────┼────────┼────────┼────────┼────────┼────────┤                       │
│ │  8   │   9    │  10    │  11    │  12    │  13    │  14    │                       │
│ │ 4 ✓  │  4 ✓   │ 3✓ 1⊘  │ 3✓ 1✗  │  5 ·   │  2 ·   │  2 ·   │                       │
│ └──────┴────────┴────────┴────────┴────────┴────────┴────────┘                       │
│  Select a day to see its fires.                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.8 Calendar — over-limit states

```
   Range too wide:
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Calendar shows up to 92 days at a time.                                 │
   │  Showing 8 Sep – 8 Dec instead. Your filters were kept.                  │
   └──────────────────────────────────────────────────────────────────────────┘

   Too many occurrences:
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Docs data sync fires more often than this view can draw.                │
   │  Showing the first 500 of its fires in this range.                       │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 6.9 Calendar — empty

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◀   Week of Mon 8 Sep – Sun 14 Sep   ▶      [ Today ]                                │
│                                                                                      │
│                     Nothing fires in this week                                       │
│         Your next scheduled fire is Mon 22 Sep at 07:00 UTC.  [ Jump there ]         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.10 The Schedule editor

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ New schedule                                                                     [✕] │
│                                                                                      │
│ Name        [ Morning inbox scan                                              ]      │
│ Agent       [ Inbox agent                                                   ▾ ]      │
│                                                                                      │
│ Instructions                                    [ ✓ Use the guided form ]            │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Every weekday at 07:00:                                                          │ │
│ │ Read      [ the shared inbox and yesterday's notes                            ]  │ │
│ │ Do        [ triage every unread message into answer, delegate or ignore       ]  │ │
│ │ Output    [ update the triage note; open a task for anything needing a person ]  │ │
│ │ If        [ a message mentions a contract  ] then [ escalate, do not reply    ]  │ │
│ │ Never     [ send an external email without approval                           ]  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│  This will be saved as plain instructions you can keep editing.  [ Edit as text ]    │
│                                                                                      │
│ Cadence     ( ) Every day at   [07:00]                                               │
│             (•) Every          [ Weekday ▾ ] at [07:00]                              │
│             ( ) Advanced       [ 0 7 * * 1-5                                  ]      │
│             Times are UTC. Next three fires: Mon 8 Sep 07:00 · Tue 9 Sep 07:00 ·     │
│             Wed 10 Sep 07:00   (09:00 your local time)                               │
│                                                                                      │
│ Options                                                                              │
│   Model         [ Inherit from Inbox agent (currently gpt-class, fast)          ▾ ]  │
│   Time limit    [ 900 ] seconds        Inherited: 1800 from the agent                │
│   Announce      [✓] Tell me when it finishes                                         │
│   Show on board [✓] Add each fire to the tasks board                                 │
│                                                                                      │
│                                        [ Cancel ]   [ Create schedule ]              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy:

- **"Use the guided form"** · **"Edit as text"**
- Guided labels: **"Read"**, **"Do"**, **"Output"**, **"If"**, **"then"**, **"Never"**
- Helper under instructions: **"Schedules run without you, so write them like a policy: what to
  read, what to do, what to produce, and the one thing never to do."**
- Cadence helper: **"Times are UTC. Next three fires: {a} · {b} · {c} ({local} your local time)"**
- Time-limit helper: **"Between 60 and 14400 seconds. Inherited: {value} from {source}."**
- Announce helper: **"On by default for schedules that fire once a day or less."**
- Refusals:
  - **"The tightest cadence is every 5 minutes."**
  - **"That cadence fires {n} times a day. Check the cost before you save."**
  - **"This agent has the maximum of 50 schedules. Retire one, or create it on another agent."**
  - **"Your workspace has the maximum of 500 schedules."**
  - **"That cadence cannot be read. Check the expression."**
- Save confirmation: **"Saved. Next fire: {when} ({countdown})."**

Keyboard: `Tab` walks the guided fields in order · `Ctrl`/`Cmd`+`Enter` saves · `Esc` closes with
a confirm if anything changed.

### 6.11 The overlap warning

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠  This overlaps the Research agent's heartbeat                                      │
│                                                                                      │
│    They fire in the same minute 48 times in the next 7 days, and their               │
│    instructions overlap heavily.                                                     │
│                                                                                      │
│    Most agents want a heartbeat or specific schedules — rarely both doing the         │
│    same job. You can keep both; this is only a warning.                              │
│                                                                                      │
│    [ Open the heartbeat ]   [ Keep both ]   [ Do not warn me for 30 days ]           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

And the tight-heartbeat variant:

```
   ⚠  A 5-minute heartbeat on an agent that also has 4 schedules will wake it
      288 times a day. Consider 30 minutes.        [ Change to 30 minutes ]  [ Keep ]
```

### 6.12 NEVER RUNS — review and fix

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Schedules that will never run                                                    [✕] │
│ 5 schedules cannot fire as written. 3 can be fixed automatically.                    │
│                                                                                      │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [✓] Month-end rollup        February never has a 30th day                        │ │
│ │       before  Day 30 of February at 18:00                                        │ │
│ │       after   Day 28 of February at 18:00                                        │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │ [✓] Q2 pricing sweep        Its end date passed on 30 Jun 2026                   │ │
│ │       before  Every Monday at 08:00, ends 30 Jun 2026                            │ │
│ │       after   Every Monday at 08:00, no end date                                 │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │ [✓] Launch reminder         Its one-time slot was 3 Aug 2026 14:00               │ │
│ │       before  Once at 3 Aug 2026 14:00                                           │ │
│ │       after   Once at 9 Sep 2026 14:00                                           │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │  ✕  Supplier watch          No agent is assigned                                 │ │
│ │       Needs a decision.                [ Assign an agent ]                       │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │  ✕  Legacy import           Its cadence cannot be read: "*/0 * * * *"            │ │
│ │       Needs editing.                   [ Edit the cadence ]                      │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  Nothing is changed until you apply.        [ Cancel ]   [ Apply 3 fixes ]           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

After apply:

```
   ✓  Fixed 3 schedules. 2 still need you.        [ Undo ]  (available for 15 minutes)
```

Race outcome:

```
   ✓  Fixed 2 schedules. 1 changed since you previewed and was left alone.
```

Over-limit:

```
   Fix all handles up to 200 schedules at a time. 214 are flagged —
   the first 200 are shown.                       [ Apply 200 fixes ]
```

Copy: banner **"{n} schedules will never run."** · **"Review and fix"** · dialog title
**"Schedules that will never run"** · **"Nothing is changed until you apply."** ·
**"Apply {n} fixes"** · **"Needs a decision."** · **"Needs editing."**

### 6.13 The circuit breaker — one Agent

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Pause everything on the Inbox agent?                                             [✕] │
│                                                                                      │
│   This pauses 6 schedules and the agent's heartbeat.                                 │
│   Nothing is deleted — cadences, instructions and options are kept.                  │
│                                                                                      │
│   2 runs are in flight right now. They will finish; this does not cancel them.       │
│   [ See the runs in flight ]                                                         │
│                                                                                      │
│   Use this when you are restructuring what an agent is responsible for, then          │
│   re-enable the ones you still want.                                                 │
│                                                                                      │
│                                        [ Cancel ]   [ Pause 6 schedules ]            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**The one row-level pause that also asks first** is a mission tick, because its cadence is not
separable from its Mission (FR-19):

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Pause the whole "Weekly idea scan" mission?                                      [✕] │
│                                                                                      │
│   This cadence belongs to the mission, so pausing it pauses the mission itself.      │
│   The mission stops raising new ideas, and so stops producing new work.              │
│                                                                                      │
│   The ideas and works it has already raised are left exactly as they are.            │
│                                                                                      │
│                   [ Cancel ]   [ Open the mission ]   [ Pause the mission ]          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.14 The circuit breaker — the whole workspace

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Pause every schedule in this workspace?                                          [✕] │
│                                                                                      │
│   This pauses 47 schedules across 6 agents, including 3 inbound triggers and         │
│   5 heartbeats. Nothing is deleted.                                                  │
│                                                                                      │
│   9 runs are in flight. They will finish; this does not cancel them.                 │
│                                                                                      │
│   Type PAUSE to confirm.   [                    ]                                    │
│                                                                                      │
│                                        [ Cancel ]   [ Pause everything ]  (disabled) │
└──────────────────────────────────────────────────────────────────────────────────────┘

   Refused because the scope is too large:
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Disable all covers up to 500 schedules at once. You have 640.           │
   │  Filter to an agent, or pause in batches.        [ Filter by agent ]     │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 6.15 The breaker undo banner

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⏸  You paused 47 schedules 3 minutes ago.        [ Undo ]  (12 minutes left)         │
└──────────────────────────────────────────────────────────────────────────────────────┘

   after the window:
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  The undo window has closed. Re-enable schedules individually.           │
   │                                    [ Show the paused schedules ]         │
   └──────────────────────────────────────────────────────────────────────────┘

   partial undo:
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Resumed 46 of 47. 1 was changed after the pause and was left alone.     │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 6.16 Reassign

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Reassign "Morning inbox scan"                                                    [✕] │
│                                                                                      │
│   Currently runs as   Inbox agent                                                    │
│   Move it to          [ Search agents…                                          ▾ ]  │
│                       ○ Research agent                                               │
│                       ○ Content agent   ⚠ no model configured — it will use the      │
│                                            account default                           │
│                                                                                      │
│   The cadence, instructions and options move with it. The next fire does not change. │
│                                                                                      │
│                                        [ Cancel ]   [ Reassign ]                     │
└──────────────────────────────────────────────────────────────────────────────────────┘

   toast: "Moved to the Research agent. Next fire is unchanged: in 4h 12m."
   failure: "That agent has been archived."
```

### 6.17 Duplicate

```
   toast: "Duplicated as 'Morning inbox scan (copy)'. It starts paused so it does not
           double the work — open it, change what you need, then resume."
           [ Open the copy ]
```

### 6.18 Run now — refusals

```
   "This schedule is already running — started at 09:04."          [ Open the run ]
   "No agent is assigned to this schedule."                        [ Assign an agent ]
   "The owning agent is archived."                                 [ Open the agent ]
   "Your credit balance cannot cover another run right now."       [ See credits ]
   "You have run schedules 10 times in the last minute. Try again shortly."
```

### 6.19 Auto-pause after repeated failure

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⏸  Paused after 5 failures                                                           │
│    Morning inbox scan failed 5 times in a row. Last error:                            │
│    "the run hit its time limit after 900s"                                            │
│    [ Open the last receipt ]   [ Raise the time limit ]   [ Resume ]                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.20 Health is stale

```
   ⓘ  Health was last checked 3 days ago. Background checks are not running in
      this deployment; schedules you edit are still checked immediately.
```

### 6.21 Keyboard shortcut sheet (`?`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Schedules — keyboard                                                 [✕] │
│                                                                          │
│  ↑ ↓        Move between schedules                                       │
│  Enter      Open the focused schedule                                    │
│  R          Run the focused schedule now                                 │
│  P          Pause or resume the focused schedule                         │
│  E          Edit the focused schedule                                    │
│  D          Duplicate the focused schedule                               │
│  V          Switch between list and calendar                             │
│  ← →        Previous / next period (calendar)                            │
│  T          Jump to today (calendar)                                     │
│  /          Search schedules                                             │
│  Esc        Clear the search, or close what is open                      │
│  ?          This sheet                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.22 Accessibility notes

- Health is never conveyed by colour alone: **OK**, **NEVER RUNS** and **OVERLAP** are words as
  well as colours, and calendar chips carry a text marker (`✓ ran`, `✗ failed`, `⊘ paused`,
  `○ did not run`, `? unknown`) in their accessible name.
- The calendar grid is a table with row and column headers; each chip's accessible name reads
  "{schedule}, {expected time}, {outcome}".
- Countdowns are announced politely at most once a minute, not once a second, so a screen reader
  is not flooded.
- The health banner and the breaker banner are status regions, not alerts, except the breaker
  confirmation dialog, which takes focus and traps it.
- The confirm-by-typing field is a labelled text input, never a click-to-hold or a drag.
- Every destructive-looking control states its reversibility in its own accessible description.

---

## 7. Out of scope

1. **A second run history.** Runs, receipts, failure classification and the Upcoming panel are
   AW-09. This surface links into them and defines none of them again.
2. **Per-Schedule time zones and DST handling.** Every source in the platform evaluates its
   cadence in UTC today. This epic makes that visible and honest rather than silently
   reinterpreting it. Per-Schedule zones are an open question (§9.1).
3. **Changing how any existing dispatcher decides what is due**, other than adding the two new
   pause predicates. Claiming, concurrency, retry and agent resolution are untouched.
4. **New schedule sources.** No eighth source type is added, and plugin-contributed schedule
   sources remain out of scope.
5. **Cancelling in-flight Runs from this surface.** The breaker states what is in flight and
   links to it; cancelling stays where it already is.
6. **Cost caps and credit policy.** AW-17. This surface shows cost on a fire and refuses a
   run-now when credits cannot cover it; it sets no caps.
7. **Notification routing and the attention budget.** AW-13. This surface decides *whether* a
   Schedule announces; it does not decide which channel that reaches.
8. **Semantic overlap detection.** The overlap warning is deterministic term comparison and fire
   coincidence. No model is asked whether two instructions "mean the same thing".
9. **Retiring either existing Trigger management surface.** Both keep working; consolidating them
   is a separate decision.
10. **Sharing or exporting the calendar** to an external calendar application.
11. **Backfilling missed fires** after downtime. A missed fire stays missed and is marked "did not
    run"; catch-up semantics are an open question (§9.4).

---

## 8. Acceptance criteria

A reviewer can run this list end to end.

**Surface and list**

- [ ] Schedules has its own route and its own primary-navigation entry.
- [ ] The Activity page's Schedules tab still works and links to the new surface.
- [ ] All seven sources appear in the list, each labelled with its source.
- [ ] The list pages at 50 rows and can load beyond the first page; no fixed cap truncates it.
- [ ] Default sort is next fire ascending with unknown-next rows last.
- [ ] Filters for agent, source, status, health and text all work and survive a page reload via
      the link.
- [ ] Countdowns tick at least once a second; the list re-reads at least every 60 seconds and on
      tab focus.
- [ ] Every cadence displays UTC and the viewer's local equivalent.

**Controls**

- [ ] Every row declares six controls; inapplicable ones are disabled with a reason, not hidden.
- [ ] Run now dispatches immediately and leaves the next fire unchanged; the toast says so.
- [ ] Run now is refused with the correct message for: already running, no agent, archived owner,
      insufficient credits, and more than 10 in a minute.
- [ ] Pausing a Schedule preserves its cadence, instructions and options; resuming needs no
      re-entry.
- [ ] Pausing a heartbeat leaves the Agent active and its assigned Task work unaffected.
- [ ] Pausing a Mission tick requires an explicit acknowledgement that the whole Mission is paused,
      stating that it stops raising new Ideas and that Ideas and Works already raised are left alone.
- [ ] Run now links to the Run where the source produces one, and to the owning entity where it
      does not — a Mission tick offers no Run link.
- [ ] Duplicate creates a paused copy named "… (copy)" with no run history.
- [ ] Reassign moves instructions, cadence, options and next fire; archived Agents are not
      offered; reassigning to one archived mid-flow fails cleanly.
- [ ] Every control writes an activity entry with actor, control and before/after.

**Authoring**

- [ ] A Schedule cannot be saved without a name, instructions and a cadence.
- [ ] All three cadence styles save, and the advanced field shows the next three fires before save.
- [ ] A cadence under 5 minutes is refused; 5–15 minutes saves with a warning naming the daily
      fire count.
- [ ] Time limit accepts 60–14,400 and shows which level supplied the inherited value.
- [ ] Announce defaults on at ≤7 fires per week and off above it.
- [ ] The guided form appears by default for a user's first three Schedules and can be dismissed;
      free-text authoring is always available.
- [ ] The 50-per-Agent and 500-per-workspace caps refuse before any write and keep the form
      populated.

**Heartbeats and overlap**

- [ ] A heartbeat pauses and resumes without losing its cadence.
- [ ] A heartbeat under 5 minutes is refused; under 15 minutes with ≥1 Schedule warns.
- [ ] Coincidence overlap warns at ≥2 same-minute fires in 7 days, with the number shown.
- [ ] Duty overlap warns at ≥0.35 term overlap, with the counterpart named.
- [ ] Overlap warnings never block, dismiss for 30 days, and return when either side is edited.

**Health**

- [ ] Each of the seven reasons is produced by a matching fixture and by nothing else.
- [ ] A yearly cadence and a 29-February cadence are **not** flagged.
- [ ] A paused Schedule is not flagged.
- [ ] A Mission tick whose Mission the owner completed renders **Ended**, not NEVER RUNS.
- [ ] A valid Schedule that has never fired shows OK with a "never run yet" note and stays visible.
- [ ] Health recomputes on write and by a daily sweep; staleness beyond 48 hours is stated.
- [ ] The banner counts flagged Schedules, dismisses for the session, and returns next visit.
- [ ] Single Fix and Fix all both preview before/after and write nothing until applied.
- [ ] Fix all applies only automatic repairs, caps at 200, and lists every skip with its reason.
- [ ] A Schedule changed since preview is skipped and counted.
- [ ] An applied batch undoes in full for 15 minutes and writes activity entries both ways.

**Circuit breaker**

- [ ] Agent scope pauses that Agent's Schedules and heartbeat; workspace scope covers all sources
      including inbound Triggers.
- [ ] Nothing is deleted; every cadence survives.
- [ ] The confirmation states the exact count, heartbeat inclusion and in-flight Run count, and
      says in-flight Runs are not cancelled.
- [ ] Workspace scope requires typing PAUSE; the confirm stays disabled until it matches.
- [ ] A scope over 500 is refused before any write.
- [ ] Undo within 15 minutes restores exactly the paused set; changed rows are skipped and
      reported.
- [ ] After the window, re-enable is per Schedule and no "enable all" exists.
- [ ] The undo banner is visible on the surface for the whole window.

**Calendar**

- [ ] Week and Month views, step back/forward and Today all work; filters are shared with the List.
- [ ] Paused Schedules are drawn greyed, not hidden; never-fired Schedules appear; flagged ones
      appear in the banner.
- [ ] Every past occurrence is marked ran / failed / did not run / unknown; ran and failed link to
      the receipt.
- [ ] A Run within ±10 minutes matches; outside it, "did not run" is shown, never a guessed match.
- [ ] A Mission-tick occurrence is resolved from its own tick record and reads "unknown" when none
      is held; it is never marked "did not run" because no Run exists.
- [ ] Occurrences older than Run retention read "unknown", not "did not run".
- [ ] A range over 92 days is refused and snapped back with filters intact.
- [ ] Expansion caps at 500 per Schedule and 2,000 per request, with an explanation on the row.

**Announcements and failures**

- [ ] An announcing Schedule produces one activity entry and one notification per completion,
      with duration, cost and a receipt link.
- [ ] A non-announcing Schedule still announces after two consecutive failures.
- [ ] Above 20 announcements a day, further ones roll into an hourly summary and the row says so.
- [ ] Five consecutive failures auto-pause, notify regardless of the setting, and surface the last
      error with a one-click resume.
- [ ] Resuming resets the failure count to zero.

**Scope, permissions, resilience**

- [ ] No request parameter can name another user, Organization or tenant.
- [ ] A foreign Schedule id is indistinguishable from a missing one on every endpoint.
- [ ] A viewer without edit permission sees full rows with disabled controls and a reason.
- [ ] Nothing marked secret renders anywhere, including in instructions and announcements.
- [ ] One failing source degrades to a notice; the rest of the list renders.
- [ ] The list, calendar, health banner and breaker banner load independently.
- [ ] 50 rows return under 800 ms p95; a month of occurrences under 1,200 ms p95.

**Accessibility and i18n**

- [ ] Health and occurrence outcomes are conveyed by text as well as colour.
- [ ] The calendar is navigable and announced as a table with headers.
- [ ] Countdowns are announced at most once a minute.
- [ ] Every visible string resolves from a message key; no literal English in the components.
- [ ] Keyboard shortcuts match §6.21 and the sheet opens with `?`.

---

## 9. Open questions

1. **[NEEDS CLARIFICATION: per-Schedule time zones.]** Every source evaluates cadence in UTC
   today, and one existing time-zone field is documented as a display hint only. Do we (a) keep
   UTC evaluation and only ever display local equivalents, which is what this spec assumes, or
   (b) introduce real per-Schedule zone evaluation with DST rules, which changes fire times for
   existing Schedules on the day it ships? Recommendation: (a) now, (b) as its own epic with a
   migration that pins every existing Schedule to UTC explicitly.
2. **[NEEDS CLARIFICATION: does a heartbeat that finds nothing produce a Run?]** This determines
   whether an idle heartbeat costs money and floods the Run ledger. The answer changes the
   Calendar's "ran" marker for heartbeats and the honest cost story. Needs a decision with AW-09
   and AW-17 before P2's calendar markers ship.
3. **[NEEDS CLARIFICATION: does the breaker cover inbound Triggers by default?]** This spec says
   yes for workspace scope, because a Trigger also starts unattended work. Counter-argument: a
   Trigger is an integration contract, and pausing one may make an external system look broken.
   Should the dialog offer a checkbox rather than deciding?
4. **[NEEDS CLARIFICATION: catch-up after downtime.]** If the platform is down over a fire, the
   occurrence is currently missed forever and this spec marks it "did not run". Should a Schedule
   carry a catch-up policy (skip / run once on recovery / run every missed occurrence)?
5. **[NEEDS CLARIFICATION: who may use the workspace-wide breaker?]** Today permission is
   per-owning-entity. A workspace-wide pause is a different magnitude. Should it require an
   Organization-level role rather than the union of per-entity permissions?
6. **[NEEDS CLARIFICATION: overlap thresholds.]** 2 coincident fires in 7 days and 0.35 term
   overlap are chosen to be noticeable without nagging. They need one round of tuning against real
   workspaces before P2 ships.
7. **[NEEDS CLARIFICATION: the "did not run" reason vocabulary.]** The platform reliably knows
   "paused at the time" and "no agent". It knows "over the concurrency cap" only indirectly. Which
   reasons do we commit to stating, and which collapse into an unexplained "did not run"?
8. **[NEEDS CLARIFICATION: duplicate across Agents.]** Duplicate currently keeps the same Agent
   and starts paused. Should the duplicate dialog also offer a target Agent, making
   duplicate-and-reassign one step for fanning one standing definition across a team?

---

## 10. Constitution gates

| Gate | Verdict | Why |
| --- | --- | --- |
| I — Plugin-first | **Pass** | No external integration is added. Model selection resolves through the existing capability facade. |
| II — Capability-driven resolution | **Pass** | The per-Schedule model option stores a provider/model choice resolved through the facade; no plugin id is hardcoded outside a plugin. |
| III — Source-of-truth repositories | **Pass** | Schedules are platform metadata, which the constitution explicitly places in the database. No Work content moves. |
| IV — Job runtime | **Pass** | The health sweep is registered as a cron task on the configured job-runtime provider; every dispatch goes through the existing dispatcher indirection. |
| V — Forward-only migrations | **Pass** | Three additive migrations, one per phase; no column is renamed or dropped. |
| VI — Tests first | **Pass** | Unit, controller and end-to-end coverage is named per phase in the plan. |
| VII — Secrets | **Pass** | Instructions are scanned like existing agent instruction fields; nothing marked secret renders. |
| VIII — Plugin counts | **N/A** | No plugin list changes. |
| IX — Behaviour-first spec | **Pass** | This document names no class, path or code. |
| X — Backwards compatibility | **Pass** | The existing schedules read endpoint keeps its shape and gains only additive fields; the paged form is a new endpoint. |

---

## 11. References

- Program overview and vocabulary: [../README.md](../README.md)
- Runs, receipts and Upcoming: [../AW-09-runs-receipts/spec.md](../AW-09-runs-receipts/spec.md)
- The existing Schedules read model: [../../schedules/spec.md](../../schedules/spec.md)
- Recurring Tasks: [../../task-tracking/](../../task-tracking/)
- Agent heartbeats: [../../agents/](../../agents/)
- Work schedules: [../../scheduled-updates/](../../scheduled-updates/)
- Missions: [../../missions-ideas-works/](../../missions-ideas-works/)
- Implementation plan: [plan.md](./plan.md) · Task list: [tasks.md](./tasks.md)
