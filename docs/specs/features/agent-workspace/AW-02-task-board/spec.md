# AW-02 — Mission board

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> This document describes **what a user sees and can do**. No class names, no file
> paths, no code — those live in [`plan.md`](./plan.md).

**Feature ID**: `aw-02-mission-board`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-02-mission-board`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: L · **Blocking dependencies**: none
**Extends**: Missions (existing) · **Adjacent epics**: [AW-03 My Decisions](../AW-03-decision-queue/), [AW-04 Live Feed](../AW-04-live-feed/), [AW-09 Runs & receipts](../AW-09-runs-receipts/), [AW-19 Home](../AW-19-home/)

> **Additive by default (program rule #1).** Nothing in this epic removes, renames
> or consolidates an existing surface. The Missions catalog list that ships today
> survives as a tab. Every existing Mission endpoint keeps its current behaviour.
> One new noun is introduced (Mission comment) and is justified in §5.3.

---

## 0. TL;DR

```
   /missions
   ┌───────────────────────────────────────────────────────────────────────┐
   │  Missions            3 need you · 7 done today          [+ New Mission]│
   │  ┌──────┬──────┬──────────┬───────┐                                    │
   │  │Board │ List │ Archived │ Trash │   ← tab strip (Board is default)   │
   │  └──────┴──────┴──────────┴───────┘                                    │
   ├──────────────┬──────────────┬──────────────┬──────────────────────────┤
   │ Backlog   12 │ In flight  4 │ Needs you  3 │ Done                  7  │
   │              │              │              │                          │
   │ [card]       │ [card]       │ [card]       │ [card]                   │
   │ [card]       │ [card] STALE │ [card]       │ [card]                   │
   │ …            │ …            │ …            │ …                        │
   └──────────────┴──────────────┴──────────────┴──────────────────────────┘
```

Missions already exist, already run on a cadence, already spawn Ideas, Works and
Tasks, and already carry a budget. What they do not have is a place that answers
**"what are my agents doing right now, and which of it is waiting on me?"** in one
screen. Today `/missions` is a 24-per-page catalog grid sorted by last-update,
with a status dropdown. It answers "which Missions exist", not "what is moving".

This epic turns `/missions` into a four-lane board over the same Missions, adds
the small amount of state a board needs to be legible (priority, labels, a live
status line, a staleness flag, a comment count, provenance), gives Missions an
archive and a trash with restore, and makes the Mission's comment thread the
place a human redirects a running agent without cancelling and re-creating work.

Three phases, each independently shippable:

- **P1 — The board.** Lanes, cards, counters, filters, quick-create, Archived and
  Trash tabs with restore, staleness flag.
- **P2 — The thread.** Mission comments, comment counts on cards, and mid-flight
  steering: a comment that addresses a working Agent reaches the live Run.
- **P3 — The whole queue.** Missions filed by a Schedule or by an Agent land in the
  same lanes with an origin chip; staleness notifications; bulk archive.

---

## 1. Overview

A user opens **Missions** and sees every unit of delegated work laid out in four
lanes — **Backlog**, **In flight**, **Needs you**, **Done** — with a card per
Mission carrying its priority, its labels, its comment count, and, while it is
being worked, a one-line live status of what the Agent last reported. A Mission
that has been in flight for two days without moving is flagged. A header line
keeps two scores: how many Missions are waiting on the user, and how many
finished today. The user can create a Mission in one dialog without leaving the
lane view, archive what is stale, move what is finished to a trash that keeps it
recoverable for 30 days, and — from a Mission's own comment thread — redirect an
Agent that is mid-flight, without cancelling the Run or re-creating the Mission.
Missions filed by a human, raised by a Schedule, or proposed by an Agent all land
in the same four lanes and compete under the same priority.

---

## 2. Why now

### 2.1 The question this answers

> *"What are my agents doing right now, and what needs me?"*

That question is asked several times a day by exactly the person Ever Works is
built for: an owner who has delegated work and now has to decide whether to
trust it. It is the single most-asked question of an agent platform, and today it
has no single answer surface.

### 2.2 What a user does today instead

| To find out… | Today they must… |
| --- | --- |
| Which Missions exist | Open `/missions` — a 24-per-page grid, newest-updated first |
| Whether a Mission is actually moving | Open the Mission, read its live-runs panel, or open `/activity` and correlate by time |
| Whether anything is blocked on them | Open the Home page's approval block, or `/tasks?status=blocked`, or a Task's escalation feed — three different places, none of which is Mission-shaped |
| Which Mission matters most | Nothing to read — Missions have no priority at all |
| Whether a Mission has silently wedged | Nothing. There is no "nothing has happened here in a while" signal anywhere in the product |
| To stop looking at a finished Mission | Complete it (it stays in the grid) or hard-delete it (irreversible, and the only removal we have) |
| To redirect a running Agent | Cancel or wait for the Run, then edit the Mission, then run it again — losing the in-flight work |

### 2.3 The four concrete gaps

1. **No priority on a Mission.** Missions carry status, type, cadence, cap and
   guardrails — but no ordering signal. Tasks have a five-step priority; Missions
   have none, so there is nothing for a human *or* an Agent to sort by.
2. **No "is it moving?" signal.** A Mission's freshness today is `updatedAt`,
   which changes when a user edits the title. Nothing records *when the work last
   progressed*, so nothing can tell a stalled Mission from a slow one.
3. **No reversible removal.** Deleting a Mission is permanent and immediate.
   Users therefore do not clear the list, so the list is never a useful view of
   current work.
4. **No steering channel on a Mission.** Tasks have a comment thread that can
   reach a live Run. Missions — the coarser, longer-lived unit the user actually
   delegates — have no thread at all. The user's only lever is stop/start.

### 2.4 Why a board and not a better list

A list orders by one axis. The question above has two: *state* (is it queued,
moving, blocked, finished) and *urgency* (which one first). Lanes carry state
positionally, so a glance is enough — and "Needs you" as a lane, rather than a
filter, makes the user's own latency visible instead of ambient. The two header
counters make the exchange explicit: what the user owes the Agents, and what the
Agents produced for the user today.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — Morning glance.**
**Given** a user with 26 Missions, 4 of which have a Run executing and 3 of which
have an open decision,
**when** they open `/missions`,
**then** the Board tab renders four lanes, the header reads `3 need you · 7 done
today`, the In-flight lane shows 4 cards each with a one-line live status of what
the Agent last reported, and the Needs-you lane shows 3 cards each with an
"Open decision" affordance.

**S2 — Quick-create.**
**Given** a user on the Board tab,
**when** they press `n` (or click **+ New Mission**), type a description of at
least 10 characters, set priority **Urgent**, add the label `seo`, and submit,
**then** the dialog closes, a card appears at the top of the Backlog lane within
one refresh, the card shows the `Urgent` chip and the `seo` label, and the
Backlog lane count increases by one.

**S3 — Priority is real.**
**Given** two Missions in Backlog, one `Urgent` and one `Normal`,
**when** the user views the Backlog lane,
**then** the `Urgent` card sorts above the `Normal` card, and when the lane is
re-sorted the ordering key is documented on the lane header tooltip as
"Priority, then oldest first".

**S4 — A Mission starts moving.**
**Given** a Mission in Backlog whose first Run is dispatched,
**when** the board next refreshes,
**then** the card moves to the In-flight lane, gains a live status line, and the
lane counts on both lanes update without a full page reload.

**S5 — A Mission blocks on the user.**
**Given** an in-flight Mission whose Agent raises an escalation,
**when** the board next refreshes,
**then** the card moves to the Needs-you lane, the header "need you" count
increases, the card shows how many decisions are open, and the card's primary
action reads **Open decision** and links to that decision.

**S6 — Steering mid-flight.**
**Given** a Mission in flight with a live Run,
**when** the user opens the Mission, posts a comment in its thread that addresses
the working Agent, and submits,
**then** the comment is appended to the thread, the thread shows
**"Delivered to the running Agent"** under the comment, the Run is **not**
restarted, and the comment count on the Mission's card increases by one.

**S7 — Staleness.**
**Given** an in-flight Mission whose last progress was 50 hours ago and a
workspace staleness threshold of 2 days,
**when** the board renders,
**then** the card carries a **Stale** flag reading "No progress for 2 days", the
flag's tooltip names the exact last-progress timestamp, and the card sorts to the
top of the In-flight lane.

**S8 — Archive and restore.**
**Given** a completed Mission the user no longer wants on the board,
**when** they choose **Archive** from the card menu,
**then** the card leaves the Done lane immediately, a toast reads
"Mission archived · Undo", the Mission appears under the **Archived** tab, and
choosing **Restore** there returns it to whichever lane its state puts it in.

**S9 — Trash and permanent delete.**
**Given** a Mission the user wants gone,
**when** they choose **Move to Trash**,
**then** the Mission leaves the board and every default list, appears under
**Trash** with the copy "Deleted 6 Sep · purged in 30 days", can be restored from
there, and can be permanently deleted from there behind a typed confirmation.

**S10 — Everything lands in one queue.**
**Given** a Schedule that files a Mission and an Agent that proposes one,
**when** the user opens the board,
**then** both appear in the Backlog lane alongside human-created Missions, each
carrying an origin chip (**Schedule** / the Agent's name), and no lane, filter or
count excludes them by default.

### 3.2 Edge cases, failures and races

**S11 — Board read fails.**
**Given** the board request errors,
**when** the page renders,
**then** the four lane frames still render with an inline error panel reading
"Couldn't load the board." plus a **Try again** button and a link to the List
tab; the page does not blank, does not 500, and does not present an empty board
as "you have no Missions".

**S12 — A lane is over its cap.**
**Given** a Backlog lane holding 140 Missions and a per-lane cap of 50,
**when** the lane renders,
**then** it shows the first 50 cards, a footer reads
"Showing 50 of 140 · Show 50 more", and the lane header count shows the true
total (140), never the truncated one.

**S13 — Empty board vs empty lane.**
**Given** a user with zero Missions,
**when** the board renders,
**then** the four lane frames are replaced by a single empty state
("No Missions yet." + **New Mission** + a link to the unified creator).
**Given** a user with Missions but none in flight,
**when** the board renders,
**then** the In-flight lane keeps its frame and shows the per-lane empty line
"Nothing in flight." — the board never collapses a lane.

**S14 — Drop into a lane that cannot be set.**
**Given** a user dragging a Backlog card,
**when** they drag it over the **Needs you** lane,
**then** the lane refuses the drop, shows a "not a drop target" cursor, and on
release a toast reads "Needs you is set by the work, not by hand." — the card
returns to its lane with no state change.

**S15 — Drag to Done requires a verdict.**
**Given** a user dragging an in-flight card onto **Done**,
**when** they release,
**then** the existing Complete dialog opens with its outcome picker; cancelling
the dialog returns the card to In flight unchanged; confirming completes the
Mission and moves the card.

**S16 — Concurrent move.**
**Given** two browser tabs on the board and a card archived in tab A,
**when** tab B attempts to archive the same Mission,
**then** tab B's request is accepted as a no-op (the Mission is already
archived), the card disappears from tab B on its next refresh, and no error is
shown.

**S17 — Someone else's Mission.**
**Given** a Mission id belonging to another user or another Organization,
**when** the current user requests it, archives it, trashes it, restores it or
comments on it,
**then** every one of those responses is a 404 with the same body — the API never
distinguishes "does not exist" from "not yours".

**S18 — Steering with no live Run.**
**Given** a Mission with no non-terminal Run,
**when** the user posts a comment addressing an Agent,
**then** the comment is still stored and shown, the thread annotates it
**"No Run in flight — queued for the next one"**, and a new Run is dispatched
through the normal gated path rather than silently dropping the instruction.

**S19 — Steering refused by the dispatch gate.**
**Given** a workspace whose background job runtime is not configured,
**when** the user posts a steering comment,
**then** the comment is stored, the thread shows
**"Couldn't reach the Agent — background jobs are not configured"** with a link
to the job-runtime settings, and the failure is never rendered as success.

**S20 — Comment storm.**
**Given** a user posting comments rapidly,
**when** they exceed 20 comments per minute on one Mission,
**then** the 21st is refused with "You're commenting too fast. Try again in a
moment." and no partial Run dispatch occurs.

**S21 — Restoring into a lane that changed.**
**Given** an archived Mission that was in Backlog when archived and whose Agent
has since raised an escalation,
**when** the user restores it,
**then** it lands in **Needs you**, not Backlog — lanes are always derived from
current state, never from where the card was when it left.

**S22 — Trash retention boundary.**
**Given** a Mission trashed 30 days and 1 hour ago,
**when** the retention sweep runs,
**then** the Mission and its comments are permanently deleted, an activity entry
records the purge, and the Trash tab no longer lists it. A Mission trashed 29
days ago is untouched.

**S23 — Label limits.**
**Given** a Mission with 8 labels,
**when** the user adds a 9th,
**then** the input refuses it inline with "Up to 8 labels per Mission." and the
save is not attempted.

**S24 — Long live status.**
**Given** an Agent reporting a 4,000-character status,
**when** the card renders,
**then** the card shows the first 140 characters on one line with an ellipsis,
the full stored value is capped at 280 characters, the text is rendered as plain
text (never as markup or a link), and the untruncated line is available on hover
and to screen readers.

**S25 — Staleness threshold changed.**
**Given** a workspace that raises its staleness threshold from 2 to 7 days,
**when** the board next renders,
**then** cards between 2 and 7 days without progress lose the Stale flag
immediately, and no notification is re-sent for a Mission that was already
flagged.

---

## 4. Functional requirements

### 4.1 Lanes and the board read

- **FR-1** The system MUST place every visible Mission in exactly one of four
  lanes: `Backlog`, `In flight`, `Needs you`, `Done`.
- **FR-2** The lane MUST be derived from current state at read time and MUST NOT
  be stored on the Mission, so that a lane can never disagree with the work.
- **FR-3** The system MUST apply this precedence, first match wins:
  1. Not visible on the board at all — the Mission is in Trash.
  2. Not visible on the board at all — the Mission is Archived.
  3. `Done` — the Mission's lifecycle status is `completed` or `failed`.
  4. `Needs you` — the Mission has ≥ 1 open decision attributable to it.
  5. `In flight` — the Mission has ≥ 1 non-terminal Run attributable to it, **or**
     its last recorded progress is within the last 24 hours.
  6. `Backlog` — everything else.
- **FR-4** A decision is attributable to a Mission when it is an open Escalation
  or a pending Approval raised by work that belongs to that Mission.
- **FR-5** A Run is attributable to a Mission when it was dispatched for a Task
  that belongs to that Mission.
- **FR-6** A Mission whose lifecycle status is `paused` MUST appear in `Backlog`
  (or `Needs you`, per precedence) with a visible **Paused** chip, and MUST NOT
  be presented as if an Agent will pick it up.
- **FR-7** Each lane MUST render at most 50 cards per request by default; the
  caller MAY request up to 200. The lane header count MUST always report the true
  unbounded total for that lane, not the number rendered.
- **FR-8** The `Done` lane MUST default to Missions completed or failed within the
  last 7 days; the window MUST be adjustable from 1 to 90 days.
- **FR-9** Cards within a lane MUST sort by: stale first (In flight only), then
  priority ascending (`p0` first), then oldest last-progress first. The sort key
  MUST be stated in the lane header's tooltip.
- **FR-10** The board MUST refresh itself every 15 seconds while the browser tab
  is visible and at least one card is in `In flight`, every 60 seconds while
  visible with nothing in flight, and MUST stop polling entirely while the tab is
  hidden.
- **FR-11** A board refresh MUST NOT reset scroll position, lose an open card
  menu, or discard unsaved dialog input.

### 4.2 The card

- **FR-12** A card MUST show: the Mission title, its priority chip, up to 3
  labels (with `+N` for the remainder), its origin chip, and its comment count
  when that count is ≥ 1.
- **FR-13** A card in `In flight` MUST additionally show a **live status line**:
  one line of plain text describing what most recently happened, truncated to 140
  displayed characters.
- **FR-14** The live status line MUST be rendered as plain text. The system MUST
  NOT render markup, links or images supplied by an Agent inside a card.
- **FR-15** A card in `Needs you` MUST show the count of open decisions and a
  primary action labelled **Open decision**.
- **FR-16** A card in `Done` MUST show the recorded outcome when one exists and
  the completion date.
- **FR-17** A comment count of 100 or more MUST display as `99+`.
- **FR-18** Every card MUST link to its Mission detail page, and the whole card
  MUST be a single link target for pointer and keyboard alike.

### 4.3 Priority and labels

- **FR-19** A Mission MUST carry a priority on the same five-step scale Tasks
  already use: `p0` Urgent, `p1` High, `p2` Medium, `p3` Normal, `p4` Low.
- **FR-20** A Mission created without an explicit priority MUST default to `p3`
  (Normal).
- **FR-21** Priority MUST be settable at create time, from the Mission detail
  page, and from the card menu, and every change MUST be reflected on the board
  within one refresh.
- **FR-22** A Mission MUST accept up to 8 labels. Each label MUST be 1–32
  characters, lower-cased on save, and MUST match `[a-z0-9][a-z0-9._-]*`.
- **FR-23** Labels are free-form. The system MUST NOT require a label to exist
  before it is used and MUST NOT delete a label because nothing uses it.
- **FR-24** Labels on a Mission are distinct from Work taxonomy tags and MUST NOT
  be shown, filtered or stored as the same thing.

### 4.4 Progress, staleness

- **FR-25** The system MUST record, per Mission, the time of its most recent
  progress and a ≤ 280-character summary of it.
- **FR-26** Progress MUST be recorded when any of the following happens for that
  Mission: a Run is dispatched, a Run reaches a terminal state, a scheduled tick
  produces Ideas, a Task belonging to it changes status, a decision on it is
  opened or resolved, or a comment is posted on it.
- **FR-27** A user editing a Mission's title, description or cadence MUST NOT
  count as progress.
- **FR-28** A Mission in `In flight` whose last progress is older than the
  workspace staleness threshold MUST be flagged **Stale** on its card.
- **FR-29** The default staleness threshold MUST be **2 days**, settable per
  workspace between **1 and 30 days**.
- **FR-30** Missions in `Backlog`, `Needs you`, `Done`, Archived or Trash MUST
  NOT be flagged stale.
- **FR-31** The system MUST send at most **one** staleness notification per
  Mission per stale streak; a Mission that moves and goes stale again MUST be
  eligible for one more.
- **FR-32** A staleness notification MUST link directly to the Mission.

### 4.5 Origin — one queue

- **FR-33** Every Mission MUST record its origin: `user`, `schedule`, or `agent`,
  plus the identifier of the originator where one exists.
- **FR-34** Missions created before this feature ships MUST be treated as origin
  `user` and MUST NOT be re-attributed by guesswork.
- **FR-35** The board MUST NOT exclude any origin by default, and the header
  counters MUST count all origins alike.
- **FR-36** The board MUST offer an origin filter with all three values; the
  filter MUST be off by default.
- **FR-37** A Trigger MAY be configured to file a Mission instead of a Task; when
  it does, the resulting Mission MUST land on the board with origin `schedule`.
- **FR-38** An Agent MAY propose a Mission; the proposal MUST pass through the
  existing approval and guardrail rails before a Mission exists, and the created
  Mission MUST carry origin `agent` and name the Agent.

### 4.6 Header counters and filters

- **FR-39** The board header MUST show exactly two counters: **N need you** and
  **N done today**, in that order.
- **FR-40** "need you" MUST equal the number of Missions in the `Needs you` lane.
- **FR-41** "done today" MUST count Missions completed or failed since local
  midnight in the viewer's timezone, and MUST reset at local midnight.
- **FR-42** The board MUST offer filters for text search (title and description),
  priority, label, and origin, all combinable, all reflected in the URL so a
  filtered board is shareable.
- **FR-43** Applying a filter MUST filter every lane and MUST update every lane
  count to the filtered total.
- **FR-44** Clearing all filters MUST be reachable in one action labelled
  **Clear filters**, shown only while at least one filter is active.

### 4.7 Quick-create

- **FR-45** The board MUST offer a create dialog reachable by button and by the
  `n` key that collects: description (required, 10–10,000 characters), title
  (optional, ≤ 200 characters, derived from the description when omitted),
  priority (default Normal), and labels.
- **FR-46** The dialog MUST NOT require cadence, cap, guardrails, template or
  Work selection; a Mission created there is a one-shot Mission and everything
  else keeps its existing default.
- **FR-47** Submitting MUST close the dialog optimistically, show the new card in
  `Backlog`, and — on failure — restore the dialog with the entered values and an
  inline error rather than discarding the user's text.
- **FR-48** The dialog MUST link to the full creation form for anyone who wants
  cadence and guardrails, without losing what they have typed.

### 4.8 Archive and Trash

- **FR-49** A Mission MUST be archivable from any lane and restorable from the
  **Archived** tab.
- **FR-50** A Mission MUST be movable to Trash from any lane and from the
  Archived tab, and restorable from the **Trash** tab.
- **FR-51** Archiving and trashing MUST be reversible with a single **Undo** in
  the confirming toast for at least 10 seconds.
- **FR-52** Restoring MUST re-derive the lane from current state (FR-2), never
  from the lane the Mission occupied when it left.
- **FR-53** Archived and trashed Missions MUST be excluded from the board, from
  the List tab, and from the default Mission list results.
- **FR-54** Archived and trashed Missions MUST remain fully readable at their own
  detail URL, with a banner naming their state and offering **Restore**.
- **FR-55** Archiving or trashing a Mission MUST NOT stop, cancel or alter any
  Run, Task, Idea or Work belonging to it.
- **FR-56** A Mission in Trash MUST be permanently deleted **30 days** after it
  was trashed.
- **FR-57** Permanent deletion MUST also be available on demand from the Trash
  tab, behind a confirmation in which the user types the Mission's title.
- **FR-58** Permanent deletion MUST record an entry in the activity history
  naming what was deleted and when.
- **FR-59** The Trash tab MUST state each Mission's purge date in plain language.

### 4.9 Comments and steering

- **FR-60** A Mission MUST have a comment thread, ordered oldest-first, paginated
  at 50 messages per page.
- **FR-61** A comment body MUST be at most 16 KB of UTF-8 and MUST be stored and
  rendered as plain text with mentions resolved to chips.
- **FR-62** A comment author MUST be able to edit their own comment within **5
  minutes** of posting; after that the comment is immutable.
- **FR-63** Posting a comment MUST increment the Mission's comment count and MUST
  count as progress (FR-26).
- **FR-64** A comment that mentions an Agent which currently has a non-terminal
  Run attributable to this Mission MUST be delivered into that Run rather than
  starting a new one.
- **FR-65** When such a comment is delivered into a live Run, the thread MUST say
  so under the comment, and the Run MUST NOT be restarted.
- **FR-66** When no live Run exists, the system MUST dispatch a new Run through
  the same gated path a manual run uses, and MUST say so under the comment.
- **FR-67** When dispatch is refused (no job runtime, budget exhausted, guardrail
  refusal), the comment MUST still be stored and the thread MUST show the refusal
  reason and a link to the setting that would fix it.
- **FR-68** Comment posting MUST be limited to **20 per minute per Mission** per
  user.
- **FR-69** The Mission detail page MUST offer a one-click insert of a
  change-of-direction template into the comment box, which the user then edits
  before sending. The template MUST ask the Agent to state what still applies,
  what is dropped, what previous work is invalidated, and to estimate the rework
  rather than silently starting over.
- **FR-70** Deleting a Mission permanently MUST delete its comments.

### 4.10 Moving a card

- **FR-71** Dragging a card from `Backlog` to `In flight` MUST run the Mission
  now, using the existing run path and its existing caps.
- **FR-72** Dragging a card from `In flight` to `Backlog` MUST pause the Mission.
- **FR-73** Dragging a card to `Done` MUST open the existing completion dialog
  with its outcome picker; cancelling MUST leave the Mission unchanged.
- **FR-74** `Needs you` MUST NOT be a drop target, and an attempted drop MUST
  explain why.
- **FR-75** Every drag action MUST have a keyboard-reachable equivalent in the
  card menu.
- **FR-76** A refused or failed move MUST return the card to its original lane
  and surface the server's reason.

### 4.11 Permissions, scope and limits

- **FR-77** Every board read and every board mutation MUST be scoped to the
  calling user and, when an Organization scope is active, to that Organization.
- **FR-78** A request for a Mission the caller does not own MUST return 404 for
  read, archive, trash, restore, delete and comment alike, with an identical body
  in every case.
- **FR-79** Board reads MUST be limited to **120 requests per minute** per user.
- **FR-80** Board mutations (archive, trash, restore, priority, labels) MUST be
  limited to **30 requests per minute** per user, matching the existing Mission
  write limit.
- **FR-81** The board MUST NOT expose any Mission field that the Mission detail
  page does not already expose to the same caller.

### 4.12 Accessibility and internationalisation

- **FR-82** Every lane MUST be a labelled region announcing its name and its live
  count; count changes MUST be announced politely, not assertively.
- **FR-83** Every card MUST be reachable and operable by keyboard alone: arrow
  keys move focus within and between lanes, `Enter` opens the Mission, and the
  card menu is reachable without a pointer.
- **FR-84** The Stale flag, priority chip and origin chip MUST each carry a text
  alternative; colour MUST NOT be the only carrier of any of them.
- **FR-85** Every user-visible string MUST come from the message catalogue, with
  no literal dot inside a leaf key name.
- **FR-86** All dates on the board MUST render in the viewer's locale and
  timezone, and relative times ("2 days ago") MUST carry the absolute time in
  their tooltip and accessible name.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended, not replaced

| Concept | What it is today | What this epic adds |
| --- | --- | --- |
| **Mission** | A long-running unit of delegated work with a lifecycle (`active`, `paused`, `completed`, `failed`), a type (one-shot / scheduled), a cadence, an outstanding-Ideas cap, guardrail overrides, attachments, Work and Goal links, and a budget | Priority, labels, archive marker, trash marker, last-progress time + summary, comment count, origin |
| **Task** | A step inside a Mission; already has priority, labels, a board, a comment thread, and a live Run | Nothing. Tasks are the source of a Mission's In-flight and Needs-you signal |
| **Run** | One Agent execution, already linked to a Task | Nothing. Runs remain the unit of execution; the board reads them |
| **Approval / Escalation** | The two shapes of "a human must decide", surfaced as My Decisions | Nothing. The board reads them to derive `Needs you` and links out to them |
| **Schedule / Trigger** | Recurring definitions and inbound firing | P3: a Trigger may target a Mission instead of a Task |
| **Agent** | The worker | P3: may propose a Mission, through existing approval rails |
| **Notification** | Existing in-product notifications | A staleness notification kind |

### 5.2 Mission — states and transitions

The **lifecycle status** (existing) and the **board lane** (new, derived) are two
different things. The lifecycle status is what the user and the runtime set. The
lane is what the board computes.

```
  LIFECYCLE STATUS (existing, stored, unchanged by this epic)

      create
        │
        ▼
    ┌────────┐  pause   ┌────────┐
    │ ACTIVE │─────────►│ PAUSED │
    │        │◄─────────│        │
    └───┬────┘  resume  └───┬────┘
        │                   │
        │ complete          │ complete
        ▼                   ▼
    ┌───────────┐      ┌────────┐
    │ COMPLETED │      │ FAILED │◄── runtime, on a fatal error
    └───────────┘      └───┬────┘
                           │ resume (recovery)
                           ▼
                       ACTIVE


  BOARD PRESENCE (new, stored as two nullable markers)

    on board ──archive──► ARCHIVED ──restore──► on board
        │                     │
        │                     │ trash
        │ trash               ▼
        └───────────────► TRASHED ──restore──► on board
                              │
                              │ 30 days, or explicit "Delete forever"
                              ▼
                          PURGED (row and comments gone)


  BOARD LANE (new, derived at read time, never stored)

    trashed? ──yes──► not on the board
        │no
    archived? ──yes─► not on the board
        │no
    status completed|failed? ──yes──► DONE
        │no
    open decisions > 0? ──yes──────► NEEDS YOU
        │no
    live run, or progress < 24h? ──► IN FLIGHT
        │no
        └──────────────────────────► BACKLOG
```

**Priority** is an ordering attribute, not a state: `p0` Urgent · `p1` High ·
`p2` Medium · `p3` Normal (default) · `p4` Low. It uses the same five steps and
the same labels Tasks already use, so a user learns one scale for the whole
product.

**Staleness** is derived, never set: a Mission is stale when it is in `In flight`
and its last progress is older than the workspace threshold. It has no stored
flag, so it cannot go out of date.

### 5.3 New concept — Mission comment

**Definition.** A message on a Mission's thread, authored by a person or by an
Agent, which is both a durable record of *why* the work changed direction and the
channel through which a person redirects an Agent that is mid-flight.

**Why this is a new noun and not a reuse.** The three candidates were all wrong:

- *Activity history* is append-only, machine-authored, and has no author-reply or
  edit affordance — it records what happened, it cannot carry an instruction.
- *The Task comment thread* is the right shape but the wrong scope. A Mission
  spans many Tasks; steering "the Mission" through one arbitrary Task's thread
  would put the reason for a change of direction on a step rather than on the
  work, and would break the moment that Task finished.
- *Chat* is a conversation surface, not an object-scoped record. A chat thread is
  not attached to the Mission and does not survive as its provenance.

Mission comment therefore mirrors the Task comment thread's shape and limits
exactly — same 16 KB body cap, same 5-minute edit window, same mention syntax,
same delivery-into-a-live-Run behaviour — so there is one behaviour to learn, at
two scopes. It is added to the program's vocabulary table in the same change.

**States.** A comment is `posted`, becomes `edited` within the 5-minute window,
and is thereafter immutable. It carries a **delivery outcome** describing what
happened to the instruction it contained: `not-addressed` (no Agent mentioned),
`delivered` (reached a live Run), `dispatched` (started a new Run), or `refused`
(with a reason).

### 5.4 Explicitly not new entities

- **No `MissionProgressEvent`.** The live status line is a projection of signals
  that already exist (Runs, Task transitions, ticks, decisions) denormalised onto
  the Mission for one-query board reads. The full trail is the Live Feed's job
  (AW-04) and the Run receipt's job (AW-09).
- **No `MissionWatcher`.** Watching is a notification concern and belongs to
  AW-13. Until then the Mission owner is the audience.
- **No `Label` table.** Labels are free-form strings on the Mission, exactly as
  they are on a Task.
- **No board or swimlane entity.** There is one board per user per Organization
  scope; it is a view, not a thing that can be created.

---

## 6. UX

### 6.1 Where it lives

`/missions` gains a tab strip. The Missions catalog that ships today becomes the
**List** tab, unchanged. **Board** is the default tab; the choice is remembered
per browser and is deep-linkable as `?tab=board|list|archived|trash`.

### 6.2 Board tab — populated

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Missions                                                                       │
│ Everything your Agents are working on, in one queue.                           │
│                                                                                │
│  ● 3 need you   ·   ✓ 7 done today                       [ + New Mission ]     │
│                                                                                │
│ ┌──────┬──────┬──────────┬───────┐   ┌──────────────────────────────────────┐ │
│ │Board │ List │ Archived │ Trash │   │ 🔍 Search   Priority▾ Label▾ Origin▾ │ │
│ └══════┴──────┴──────────┴───────┘   └──────────────────────────────────────┘ │
├────────────────────┬────────────────────┬───────────────┬─────────────────────┤
│ ○ Backlog       12 │ ◐ In flight      4 │ ● Needs you 3 │ ✓ Done            7 │
├────────────────────┼────────────────────┼───────────────┼─────────────────────┤
│ ┌────────────────┐ │ ┌────────────────┐ │ ┌───────────┐ │ ┌─────────────────┐ │
│ │ Urgent  ⏱      │ │ │ High    ⚠ Stale│ │ │ Urgent    │ │ │ Normal          │ │
│ │ Refresh the    │ │ │ Weekly link    │ │ │ Publish   │ │ │ Migrate the     │ │
│ │ pricing pages  │ │ │ health sweep   │ │ │ the Q3    │ │ │ old item feed   │ │
│ │                │ │ │ ▸ Drafting sec-│ │ │ changelog │ │ │                 │ │
│ │ seo  pricing   │ │ │   tion 3 of 5  │ │ │           │ │ │ ✓ Succeeded     │ │
│ │ 👤 You    💬 4 │ │ │ 🗓 Schedule 💬2│ │ │ 2 open    │ │ │ Completed 5 Sep │ │
│ └────────────────┘ │ └────────────────┘ │ │ decisions │ │ └─────────────────┘ │
│ ┌────────────────┐ │ ┌────────────────┐ │ │[Open      │ │ ┌─────────────────┐ │
│ │ Normal  Paused │ │ │ Normal         │ │ │ decision] │ │ │ Low             │ │
│ │ Audit outbound │ │ │ Keep the docs  │ │ └───────────┘ │ │ Retire the beta │ │
│ │ links monthly  │ │ │ site current   │ │ ┌───────────┐ │ │ landing page    │ │
│ │                │ │ │ ▸ Waiting on a │ │ │ High      │ │ │                 │ │
│ │ 🗓 Schedule    │ │ │   page fetch   │ │ │ …         │ │ │ ⚠ Failed        │ │
│ └────────────────┘ │ │ 🤖 Editor 💬 1 │ │ └───────────┘ │ └─────────────────┘ │
│ … 10 more          │ └────────────────┘ │               │ Last 7 days ▾       │
└────────────────────┴────────────────────┴───────────────┴─────────────────────┘
```

Lane header glyphs are decorative; each lane's accessible name is its label plus
its count ("Backlog, 12 Missions").

### 6.3 Card anatomy

```
┌──────────────────────────────────────────────┐
│  [Urgent]  [⚠ Stale]                    [⋯]  │  priority · flags · menu
│  Weekly link health sweep                    │  title (2 lines max, then …)
│  ▸ Drafting section 3 of 5                   │  live status (In flight only)
│  [seo] [content] [+2]                        │  up to 3 labels, then +N
│  🗓 Schedule            💬 12      2d ago    │  origin · comments · last move
└──────────────────────────────────────────────┘
```

| Element | Rule |
| --- | --- |
| Priority chip | Always present. Text label, not colour alone |
| Stale flag | In flight only, over threshold only. Tooltip: "Last progress 4 Sep, 09:12" |
| Paused chip | Whenever the lifecycle status is paused |
| Title | Up to 2 lines, then ellipsis; full title in the accessible name |
| Live status | In flight only; 140 characters shown, plain text, prefixed `▸` |
| Labels | Up to 3, then `+N`; clicking one filters the board by it |
| Origin | `👤 You` / `🗓 Schedule` / `🤖 <agent name>` |
| Comments | Shown only when ≥ 1; `99+` above 99 |
| Last move | Relative; absolute in the tooltip |

### 6.4 Card menu

```
                        ┌─────────────────────────────┐
                        │  Open Mission               │
                        │  Chat about it              │
                        ├─────────────────────────────┤
                        │  Priority              ▸    │
                        │  Labels…                    │
                        ├─────────────────────────────┤
                        │  Run now                    │
                        │  Pause                      │
                        │  Complete…                  │
                        ├─────────────────────────────┤
                        │  Archive                    │
                        │  Move to Trash              │
                        └─────────────────────────────┘
```

Items that cannot apply are disabled with a reason in their tooltip — "Run now
is unavailable: this Mission is completed."

### 6.5 Loading

```
├────────────────────┬────────────────────┬───────────────┬─────────────────────┤
│ ○ Backlog       ▁▁ │ ◐ In flight     ▁▁ │ ● Needs you ▁▁│ ✓ Done           ▁▁ │
├────────────────────┼────────────────────┼───────────────┼─────────────────────┤
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁▁▁▁▁▁ │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│ ▁▁▁▁▁▁▁▁▁▁▁▁       │ ▁▁▁▁▁▁▁▁▁▁▁▁       │ ▁▁▁▁▁▁▁▁     │ ▁▁▁▁▁▁▁▁▁▁▁▁        │
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │                    │               │                     │
└────────────────────┴────────────────────┴───────────────┴─────────────────────┘
```

Four lane frames with three skeleton cards each. The header counters render as
`— need you · — done today` until the data lands. Never a spinner over the whole
page; the tab strip and **+ New Mission** stay usable.

### 6.6 Empty board

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                    🗂                                          │
│                            No Missions yet.                                    │
│    A Mission is a piece of work you hand to your Agents. Describe what you     │
│    want kept done, and it lands in Backlog for an Agent to pick up.            │
│                                                                                │
│                 [ + New Mission ]    Open the unified creator                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.7 Empty lane

```
│ ◐ In flight      0 │
├────────────────────┤
│                    │
│  Nothing in flight.│
│                    │
```

Per-lane empty copy, one line each:

| Lane | Copy |
| --- | --- |
| Backlog | `Nothing queued.` |
| In flight | `Nothing in flight.` |
| Needs you | `Nothing needs you. 🎉` |
| Done | `Nothing finished in the last 7 days.` |

### 6.8 Over the lane cap

```
│ ┌────────────────┐ │
│ │ …50th card…    │ │
│ └────────────────┘ │
│ Showing 50 of 140  │
│   [Show 50 more]   │
```

### 6.9 Error

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ⚠  Couldn't load the board.                                                    │
│    Your Missions are safe — this is a display problem.                          │
│    [ Try again ]      Open the List tab instead                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

Rendered inside the board area, below the still-visible tab strip and header. If
one lane's data fails and the others succeed, only that lane shows the panel; the
other three render normally.

### 6.10 Quick-create dialog

```
┌─────────────────────────────────────────────────────────┐
│  New Mission                                        [✕] │
├─────────────────────────────────────────────────────────┤
│  What should your Agents keep doing?                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Check every pricing page each Monday and file     │  │
│  │ an opportunity whenever a number on it goes       │  │
│  │ stale.                                            │  │
│  └───────────────────────────────────────────────────┘  │
│  At least 10 characters.                        96/10000│
│                                                          │
│  Title (optional)                                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Leave blank and we'll write one from the above    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  Priority   ( Urgent ) ( High ) (•Normal ) ( Low )       │
│  Labels     [seo ✕] [+ Add label]                        │
│                                                          │
│  Need a cadence, a cap or guardrails? Use the full form. │
├─────────────────────────────────────────────────────────┤
│                          [ Cancel ]  [ Create Mission ]  │
└─────────────────────────────────────────────────────────┘
```

Error state inside the dialog, with the user's text preserved:

```
│  ⚠ Couldn't create the Mission. Please try again.        │
```

### 6.11 Archived tab

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Archived                                            🔍 Search   Priority▾    │
│  Archived Missions stay out of the board but keep everything they produced.    │
├───────────────────────────────────────────────────────────────────────────────┤
│  Normal   Q2 pricing refresh                     Archived 2 Sep    [Restore] ⋯ │
│  Low      Old blog backfill                      Archived 28 Aug   [Restore] ⋯ │
├───────────────────────────────────────────────────────────────────────────────┤
│                                Nothing archived.                               │
│         Archive a Mission from its card menu when it is no longer live.        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.12 Trash tab

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Trash                                                                         │
│  Missions here are deleted for good 30 days after you trash them.              │
├───────────────────────────────────────────────────────────────────────────────┤
│  Normal   Duplicate pricing checks     Deleted 6 Sep · purged in 30 days       │
│                                                    [Restore] [Delete forever]  │
│  Low      Test mission                 Deleted 20 Aug · purged in 13 days      │
│                                                    [Restore] [Delete forever]  │
├───────────────────────────────────────────────────────────────────────────────┤
│                                 Trash is empty.                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Delete forever** confirmation:

```
┌─────────────────────────────────────────────────────────┐
│  Delete "Duplicate pricing checks" forever?             │
│                                                          │
│  This removes the Mission and its comments permanently.  │
│  Ideas, Works and Tasks it created are not deleted.      │
│  This cannot be undone.                                  │
│                                                          │
│  Type the Mission title to confirm                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│                     [ Cancel ]  [ Delete forever ]       │
└─────────────────────────────────────────────────────────┘
```

### 6.13 Mission comment thread and steering

On the Mission detail page, below the existing sections:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Comments                                                            12        │
├───────────────────────────────────────────────────────────────────────────────┤
│  👤 You · 4 Sep, 09:12                                                         │
│  Focus on the pricing pages first, the blog can wait.                          │
│  ↳ Delivered to the running Agent                                              │
│                                                                                │
│  🤖 Editor · 4 Sep, 09:13                                                      │
│  Understood. Dropping the blog sweep. Section 3 of 5 already drafted stays;    │
│  sections 4–5 are re-scoped. Redo estimate: ~6 minutes.                        │
│                                                                                │
│  👤 You · 5 Sep, 16:40                                                         │
│  Where did the keyword list come from?                                         │
│  ↳ No Run in flight — queued for the next one                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────────┐│
│  │ Reply to steer the Agent…                                                 ││
│  └───────────────────────────────────────────────────────────────────────────┘│
│  [ Insert a change of direction ]                              [ Send ]        │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Insert a change of direction** puts this editable text into the box (it is a
starting point, not a submitted message):

```
Change of direction: <what changed>.
Keep <what still applies>. Drop <what no longer applies>.
If this invalidates work you have already done, say so and estimate the
rework before you redo it — do not silently start over.
```

Delivery annotations under a comment, one of:

| Outcome | Copy |
| --- | --- |
| Delivered into a live Run | `↳ Delivered to the running Agent` |
| New Run dispatched | `↳ No Run in flight — queued for the next one` |
| Dispatch refused | `↳ Couldn't reach the Agent — <reason>` + a link to the setting |
| No Agent addressed | *(nothing)* |

Edit affordance: an **Edit** link on the author's own comment, visible for 5
minutes, replaced afterwards by nothing. An edited comment is marked `(edited)`.

### 6.14 Banner on an archived or trashed Mission's detail page

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ 🗄 This Mission is archived. It is hidden from the board.        [ Restore ]   │
└───────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────────┐
│ 🗑 This Mission is in Trash and will be deleted on 6 Oct.        [ Restore ]   │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.15 Narrow viewports

Below 1024 px the four lanes become a horizontally scrolling strip with the lane
headers pinned. Below 640 px the board collapses to a single-lane accordion with
the lane picker at the top; **Needs you** is the default open lane whenever it is
non-empty, otherwise **In flight**.

```
┌──────────────────────────────┐
│ ( Backlog 12 ) (In flight 4) │
│ (•Needs you 3) ( Done 7 )    │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ Urgent                   │ │
│ │ Publish the Q3 changelog │ │
│ │ 2 open decisions         │ │
│ │ [ Open decision ]        │ │
│ └──────────────────────────┘ │
```

### 6.16 Keyboard affordances

| Key | Where | Action |
| --- | --- | --- |
| `n` | Board tab, no field focused | Open the New Mission dialog |
| `/` | Board tab, no field focused | Focus the board search box |
| `←` `→` | Card focused | Move focus to the adjacent lane, same index |
| `↑` `↓` | Card focused | Move focus within the lane |
| `Home` `End` | Card focused | First / last card in the lane |
| `Enter` | Card focused | Open the Mission |
| `Shift`+`F10` or menu key | Card focused | Open the card menu |
| `1`…`5` | Card menu → Priority | Set Urgent…Low |
| `e` | Card focused | Archive, with an Undo toast |
| `Delete` | Card focused | Move to Trash, with a confirm |
| `r` | Archived / Trash row focused | Restore |
| `Esc` | Anywhere | Close the topmost dialog, menu or filter popover |
| `Ctrl`/`Cmd`+`Enter` | Comment box | Send the comment |

The board uses a single tab stop per lane with roving focus inside it, so tabbing
across the board is four stops, not 200. `Delete` and `e` are ignored while any
text input has focus.

### 6.17 Exact user-visible copy

| Where | String |
| --- | --- |
| Page subtitle | `Everything your Agents are working on, in one queue.` |
| Header counters | `{count} need you` · `{count} done today` |
| Tabs | `Board` · `List` · `Archived` · `Trash` |
| Lane names | `Backlog` · `In flight` · `Needs you` · `Done` |
| Lane tooltips | `Queued — an Agent will pick it up.` · `Being worked right now.` · `Waiting on a decision from you.` · `Finished in the last {days} days.` |
| Sort tooltip | `Sorted by priority, then oldest first.` |
| Create button | `+ New Mission` |
| Priority labels | `Urgent` · `High` · `Medium` · `Normal` · `Low` |
| Origin labels | `You` · `Schedule` · `{agentName}` |
| Stale flag | `Stale` — tooltip `No progress for {days} days. Last progress {timestamp}.` |
| Paused chip | `Paused` |
| Needs-you action | `Open decision` |
| Decision count | `{count} open decisions` / `1 open decision` |
| Lane overflow | `Showing {shown} of {total}` · `Show {n} more` |
| Board error | `Couldn't load the board.` / `Your Missions are safe — this is a display problem.` / `Try again` / `Open the List tab instead` |
| Empty board | `No Missions yet.` / `A Mission is a piece of work you hand to your Agents. Describe what you want kept done, and it lands in Backlog for an Agent to pick up.` |
| Archive toast | `Mission archived` · `Undo` |
| Trash toast | `Moved to Trash` · `Undo` |
| Restore toast | `Mission restored` |
| Archived tab lead | `Archived Missions stay out of the board but keep everything they produced.` |
| Trash tab lead | `Missions here are deleted for good 30 days after you trash them.` |
| Trash row | `Deleted {date} · purged in {n} days` |
| Delete-forever title | `Delete "{title}" forever?` |
| Delete-forever body | `This removes the Mission and its comments permanently. Ideas, Works and Tasks it created are not deleted. This cannot be undone.` |
| Delete-forever confirm | `Type the Mission title to confirm` |
| Not-a-drop-target | `Needs you is set by the work, not by hand.` |
| Comments heading | `Comments` |
| Comment placeholder | `Reply to steer the Agent…` |
| Steering template button | `Insert a change of direction` |
| Delivered | `Delivered to the running Agent` |
| Queued | `No Run in flight — queued for the next one` |
| Refused | `Couldn't reach the Agent — {reason}` |
| Comment rate limit | `You're commenting too fast. Try again in a moment.` |
| Label limit | `Up to 8 labels per Mission.` |
| Label format | `Labels use lower-case letters, numbers, dots, dashes and underscores.` |
| Archived banner | `This Mission is archived. It is hidden from the board.` |
| Trashed banner | `This Mission is in Trash and will be deleted on {date}.` |
| Stale notification | `{title} hasn't moved in {days} days` / `It's been in flight since {date} with no progress. Open it to see where it stopped.` |

---

## 7. Out of scope

- **The decision queue itself.** The board links to decisions; it does not render,
  rank or resolve them. That is AW-03.
- **The activity trail.** The board shows one live status line, not a history.
  Full narration is AW-04; per-execution receipts are AW-09.
- **Cost on the card.** A Mission already has a budget summary on its detail page.
  Putting a live spend figure on every card is a per-card fan-out and belongs with
  the cost meters in AW-17.
- **Assigning a Mission to a specific Agent from the board.** Missions already
  have an Agents tab. Routing and assignment are AW-23's problem.
- **Manual ordering inside a lane.** Cards sort by rule (FR-9). Drag-to-reorder
  within a lane is not offered; it would create an ordering the runtime ignores.
- **Work-in-progress limits per lane.** No lane caps the number of Missions in it.
- **Sub-Missions, dependencies between Missions, due dates, estimates.** Missions
  are flat and priority is the only scheduling input this epic adds.
- **A chat rail docked beside the lanes.** The dashboard already has a chat panel
  in its shell; AW-12 owns chat surfaces.
- **Shared or read-only boards for teammates.** That is AW-18.
- **Auto-archiving old Done Missions.** Archiving stays a deliberate act in this
  epic; a bulk action ships in P3, an automatic rule does not ship at all.
- **Changing the existing hard-delete endpoint's behaviour.** It keeps deleting
  permanently for any caller that uses it directly.
- **Renaming, merging or retiring the Missions List tab, the unified creator, or
  the Mission detail page.**

---

## 8. Acceptance criteria

**Lanes and reads**

- [ ] Opening `/missions` shows the Board tab by default, with four lanes in the
      order Backlog · In flight · Needs you · Done.
- [ ] A Mission with an open decision appears in Needs you even while a Run is
      executing (precedence, FR-3).
- [ ] A paused Mission appears in Backlog with a Paused chip.
- [ ] A completed Mission appears in Done with its outcome and completion date.
- [ ] Lane header counts report the unbounded total even when the lane is capped.
- [ ] The board polls at 15 s with work in flight, 60 s otherwise, and 0 while the
      tab is hidden.

**Card**

- [ ] An in-flight card shows a live status line; a Backlog card does not.
- [ ] An Agent-supplied status containing markup renders as literal text.
- [ ] A card with 5 labels shows 3 and `+2`.
- [ ] A card with 150 comments shows `99+`.
- [ ] Every card is reachable and openable by keyboard alone.

**Priority and labels**

- [ ] A Mission created without a priority is Normal.
- [ ] Setting priority from the card menu reorders the lane on the next refresh.
- [ ] Adding a 9th label is refused inline.
- [ ] `SEO` typed as a label is stored and displayed as `seo`.

**Staleness**

- [ ] An in-flight Mission with no progress for 49 hours is flagged at the default
      threshold; one with 47 hours is not.
- [ ] Editing a Mission's title does not clear the stale flag.
- [ ] A dispatched Run does clear it.
- [ ] Exactly one staleness notification is sent per stale streak.

**Origin**

- [ ] Missions that existed before the migration report origin `You`.
- [ ] A Trigger configured to file a Mission produces a Backlog card with the
      Schedule origin chip.
- [ ] Filtering by origin `Agent` shows only Agent-originated Missions and every
      lane count updates.

**Archive and Trash**

- [ ] Archiving removes the card and the Mission stops appearing in default list
      results, while its detail page still loads with a banner.
- [ ] Undo in the toast restores it within the window.
- [ ] Restoring a Mission that gained a decision while archived lands it in
      Needs you.
- [ ] A trashed Mission shows its purge date, and the retention sweep deletes it
      and its comments after 30 days.
- [ ] Delete forever requires the typed title and writes an activity entry.
- [ ] Archiving does not stop any Run, Task or Work belonging to the Mission.

**Comments and steering**

- [ ] A comment addressing an Agent with a live Run on that Mission is annotated
      "Delivered to the running Agent" and no second Run starts.
- [ ] The same comment with no live Run dispatches one and says so.
- [ ] With no job runtime configured, the comment is stored and the refusal is
      shown with a link to settings.
- [ ] Editing at 4 minutes succeeds; at 6 minutes the Edit affordance is gone and
      the API refuses.
- [ ] The 21st comment in a minute is refused without dispatching a Run.
- [ ] Posting a comment bumps the card's comment count and its last-progress time.

**Moves**

- [ ] Dragging Backlog → In flight runs the Mission now and respects its caps.
- [ ] Dragging In flight → Backlog pauses it.
- [ ] Dragging to Done opens the completion dialog; cancelling changes nothing.
- [ ] Needs you refuses drops and explains why.
- [ ] Every drag has an equivalent card-menu item.

**Isolation and limits**

- [ ] Read, archive, trash, restore, delete and comment on another user's Mission
      all return 404 with identical bodies.
- [ ] Board reads over 120/min and mutations over 30/min are throttled.

**Failure and empty states**

- [ ] A failed board read renders the error panel with the lane frames intact.
- [ ] A user with zero Missions sees the empty board, not four empty lanes.
- [ ] A user with Missions but none in flight sees the In-flight lane frame with
      its one-line empty copy.

**Cross-cutting**

- [ ] Every string on every new surface resolves from the message catalogue in
      English and falls back cleanly in the other locales.
- [ ] The board passes an automated accessibility scan with no serious or critical
      violations.
- [ ] All functional requirements have a passing unit, controller or end-to-end
      test.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: In-flight recency window.]` FR-3 places a Mission in
  `In flight` when it has a live Run **or** progress within the last 24 hours.
  The second clause exists so a Mission whose Run just finished does not snap back
  to Backlog before the user notices. Is 24 hours right, should it be shorter (say
  4 hours), or should the clause be dropped entirely so `In flight` means only
  "a Run is executing"?
- `[NEEDS CLARIFICATION: Where the staleness threshold is configured.]` The
  proposal is one workspace-level number alongside the existing Mission defaults.
  Should it instead be per Mission (so a monthly Mission can say "flag me after
  35 days"), or both with the Mission overriding the workspace?
- `[NEEDS CLARIFICATION: Failed Missions in Done.]` A failed Mission currently
  lands in `Done` with a Failed marker. Product may prefer a fifth lane, or may
  prefer failed Missions to sit in `Needs you` on the grounds that a failure is
  something only a human can resolve. Four lanes is the recommendation; confirm.
- `[NEEDS CLARIFICATION: Trash retention.]` 30 days is proposed to match common
  expectation. Confirm against any data-retention commitment, and confirm whether
  a workspace should be able to shorten it.
- `[NEEDS CLARIFICATION: Agent-originated Missions.]` P3 lets an Agent propose a
  Mission through the existing approval rails. Should a proposed-but-unapproved
  Mission be visible on the board (a fifth, "Proposed" state) or invisible until
  approved? Recommendation: invisible — the decision belongs in My Decisions, and
  the board should never show work nobody agreed to.
- `[NEEDS CLARIFICATION: Comment authorship by Agents.]` Agents will post into the
  thread when they answer. Do their replies count toward the card's comment count,
  or should the card count only human comments so the number reads as "how much
  conversation do I owe"? Recommendation: count both, and label the count
  "comments", not "unread".
- `[NEEDS CLARIFICATION: Board scope under an Organization.]` The board is
  user-owned and Organization-scoped like every other Mission read. Confirm there
  is no near-term requirement for an Organization-wide board showing every
  member's Missions before AW-18 lands.
- `[NEEDS CLARIFICATION: Progress from Ideas.]` A scheduled Mission tick that
  produces Ideas counts as progress (FR-26). Should an Idea being *accepted* or
  *built* also count, given those are downstream of the Mission but not performed
  by it?

---

## 10. Non-functional requirements

- **Performance.** The board read must serve P95 under 400 ms for a workspace with
  500 Missions, 5,000 Tasks and 200 open decisions, on a single round trip. The
  page must render its first lane frames before the board data arrives.
- **Correctness under concurrency.** Lane derivation is a pure function of stored
  state; two clients reading the same instant must place a Mission in the same
  lane. Archive, trash and restore are idempotent.
- **Reliability.** A failure in the decision-count query must degrade the
  `Needs you` lane to "count unavailable" rather than fail the whole board.
- **Security and privacy.** Every read and write is owner- and scope-filtered.
  Agent-authored text on a card is untrusted content: plain text only, never
  interpreted as markup, never auto-linked.
- **Observability.** Board opens, lane composition, staleness flags raised,
  archive / trash / restore / purge, comment posts and each steering outcome are
  recorded (see [`plan.md`](./plan.md) §9).
- **Compatibility.** No existing Mission endpoint changes its response shape
  incompatibly; new fields are additive and nullable.

---

## 11. Constitution gates

- [x] **I — Plugin-first.** No external integration is introduced. Nothing here
      talks to a third-party service.
- [x] **II — Capability-driven.** No plugin id appears anywhere in this feature.
      Agent execution is reached through the existing dispatch and steering
      seams, not a named provider.
- [x] **III — Source-of-truth repos.** Board metadata is platform metadata:
      priority, labels, board markers, comments. No Work content moves into the
      database.
- [x] **IV — Job-runtime provider.** The two recurring jobs this epic adds
      (staleness notification, trash retention) and every Run dispatched from a
      comment go through the configured job-runtime provider.
- [x] **V — Forward-only migrations.** Every new column and the comment table ship
      as additive forward-only migrations, one per phase.
- [x] **VI — Tests first-class.** Lane derivation, staleness and steering outcomes
      get unit tests; every new endpoint gets a controller spec; the board,
      archive/restore and steering flows get end-to-end coverage.
- [x] **VII — Secrets.** No secret is introduced, read or logged.
- [x] **VIII — Plugin counts.** No plugin is added; the canonical plugin doc is
      untouched.
- [x] **IX — Behaviour-first spec.** This document names no class, file or
      library.
- [x] **X — Backwards compatibility.** New request and response fields are
      additive and optional. The default Mission list gains an exclusion for
      archived and trashed rows, which cannot affect any existing consumer because
      no such row can exist before this feature's migration.

---

## 12. Cross-references

- Implementation plan: [plan.md](./plan.md)
- Task breakdown: [tasks.md](./tasks.md)
- Program overview and vocabulary: [../README.md](../README.md)
- My Decisions (the queue this board links into): [../AW-03-decision-queue/](../AW-03-decision-queue/)
- Live Feed (the trail this board summarises to one line): [../AW-04-live-feed/](../AW-04-live-feed/)
- Runs and receipts (what a live status line links to): [../AW-09-runs-receipts/](../AW-09-runs-receipts/)
- Home (which embeds a board summary): [../AW-19-home/](../AW-19-home/)
- Missions, Ideas and Works today: [../../missions-ideas-works/](../../missions-ideas-works/)
- Task tracking (the priority scale and comment thread reused here): [../../task-tracking/](../../task-tracking/)
- Schedules: [../../schedules/spec.md](../../schedules/spec.md)
</content>
</invoke>
