# AW-04 — Live Feed & "while you were away"

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> **No class names, no file paths, no code in this document.** Implementation lives in
> [plan.md](./plan.md); the ordered work lives in [tasks.md](./tasks.md).

**Epic ID:** `AW-04-live-feed`
**Program:** [Agent Workspace](../README.md) — Wave 1 (the spine)
**Branch:** `feat/aw-04-live-feed`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** M · **Blocking dependencies:** none
**Extends:** Activity Log, the domain event bus, Agents, Notifications
**Downstream:** [AW-13 Attention controls](../AW-13-attention-controls/) and
[AW-19 Home](../AW-19-home/) both consume this epic's surfaces.

> **Additive rule (program §5.1, NN #20).** This epic adds a new surface and reads records that
> already exist. It removes nothing, renames nothing, and creates **no second activity store**.
> Everything the Live Feed shows is an Activity record that Ever Works already writes today.

---

## 1. Overview

The Live Feed is a single, always-current, human-readable stream of everything the user's agents
did — one narrated line per thing that happened, newest first, arriving without a page refresh.
It answers "what is my team doing right now?" while the user is watching, and "what did I miss?"
the moment they come back. When the user returns after being away, the feed opens with a
**while-you-were-away** summary above a **New** divider, so the first screen tells them how much
happened, who did it, what needs a decision, and what failed — before they read a single line.
The user can narrow the stream to specific agents or kinds of activity, and can keep scrolling
backwards through older activity indefinitely. The feed never asks the user to configure it, never
requires a refresh, and never invents a record: it is a reading surface over the Activity Log,
made legible.

## 2. Why now

**The user's question.** An owner who has delegated work to four agents asks, several times a day:
_"What is happening right now, and what happened while I was in that meeting?"_

**What they do today.** They open `/activity`, which is a forensic audit table: 162 distinct
action types rendered as raw, undifferentiated rows, refreshed by a 5-second poll that silently
re-renders the whole list under them. It answers _"is there an audit record of X?"_ very well. It
does not answer either half of the user's actual question:

| The user needs                                     | Activity Log today                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A line they can read without decoding              | Rows show a raw action token (`agent_run_triggered`) and an untranslated grey badge for every action type outside the original ~15-member set |
| To know **who** did it                             | There is no actor column. The acting agent is buried inside a details blob for some action types and absent for others                        |
| To be told **what changed since they last looked** | Nothing tracks what the user has already seen. Every visit shows the same undifferentiated list                                               |
| A summary on return                                | Nothing exists. The daily Digest is the closest thing, and it is off by default, arrives once a day by notification, and is not a screen      |
| Updates that arrive                                | A 5-second poll that replaces the list wholesale; a row that lands while the user is mid-scroll shifts the page under their cursor            |
| To watch one agent                                 | There is no per-agent filter; the type-filter dropdown offers ~15 of 162 action types and none of the agent ones                              |
| To keep scrolling backwards                        | Offset pagination with a page-number control, which drifts and duplicates rows as new activity lands at the head                              |

**The consequence.** The most interesting things the platform does — an agent picking up a
mission, finishing a run, hitting a wall and escalating — are recorded but not _legible_. Users
compensate by opening four different pages (agents, missions, tasks, activity) and by asking the
agent in chat what it did. Trust in autonomous work is built by watching it work; today there is
nowhere to watch.

**Two concrete emission gaps this epic must also close.** A run starting and a run finishing are
the two most important things an agent does, and neither reliably reaches the Activity Log today:
only heartbeat-triggered runs emit start/complete/fail records, and manually or task-triggered
runs emit only a "triggered" record with no terminal counterpart. A feed of "everything agents do"
that omits _finished_ is not credible. Closing those gaps in the existing subsystem — rather than
building a second stream that reads run records directly — is a requirement of this epic.

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Ambient watching.**
  **Given** the user is signed in with three active agents and the Live Feed open in a browser tab,
  **when** one of those agents finishes a run,
  **then** a new line appears at the top of the feed within 5 seconds without a page reload, reading
  as a sentence that names the agent, what it did, and what it did it to, with a relative timestamp.

- **S2 — Coming back after a meeting.**
  **Given** the user last looked at the feed 90 minutes ago and 34 things have happened since,
  **when** they open the Live Feed,
  **then** a summary card at the top states how long they were away, the total count, the breakdown
  by kind, the agents involved, how many decisions are waiting and how many things failed; and a
  sticky **New — 34** divider sits above the first entry they have not seen.

- **S3 — Reading the unseen block and clearing it.**
  **Given** the New divider is showing with 34 unseen entries,
  **when** the user scrolls through them and then presses **Mark all seen**,
  **then** the divider disappears, the sidebar's unseen badge clears, and the summary card
  collapses — and none of this changes on a page reload.

- **S4 — Watching one agent.**
  **Given** the feed is showing activity from all agents,
  **when** the user selects one agent's chip in the filter bar,
  **then** the feed immediately re-renders to that agent's entries only, live updates continue but
  only for that agent, the URL reflects the selection so the view can be shared or bookmarked, and
  the selection is still in place the next time the user opens the feed.

- **S5 — Reading backwards.**
  **Given** the user is at the bottom of the first page of 30 entries,
  **when** they keep scrolling,
  **then** the next 30 older entries load automatically and append, with no page-number control, no
  duplicated entries, and no jump in scroll position — repeatable until the 90-day floor is reached.

- **S6 — Not being interrupted mid-read.**
  **Given** the user has scrolled 40 entries down and new activity is arriving,
  **when** three new entries land,
  **then** the list does **not** shift; a **3 new** pill appears pinned at the top of the list, and
  clicking it (or pressing `t`) scrolls to the top and releases the queued entries.

- **S7 — Jumping from a line to the thing it is about.**
  **Given** an entry reads that an agent finished a run for a task,
  **when** the user presses `Enter` on it (or clicks it),
  **then** they land on that run's receipt, and when a run receipt is not available for that kind of
  entry they land on the owning mission, task, agent or document instead — never on a dead end.

- **S8 — Only what broke.**
  **Given** the user suspects something went wrong overnight,
  **when** they switch on **Only what failed**,
  **then** the feed shows only entries whose outcome was a failure or a refusal, the count in the
  filter bar states how many there are in the loaded window, and the away summary card, if present,
  is unaffected.

### 3.2 Edge cases, failures and races

- **S9 — The live connection dies.**
  **Given** the feed is streaming and the user's network drops for 40 seconds,
  **when** the connection fails,
  **then** the feed shows a quiet inline notice reading **Live updates paused — reconnecting**, keeps
  the already-loaded entries on screen, retries with backoff, and after three failed attempts falls
  back to refreshing every 10 seconds while showing **Live updates unavailable — refreshing every 10s**.
  When the connection recovers the notice disappears and any entries missed in the gap are filled in
  without duplicates.

- **S10 — Too many open tabs.**
  **Given** the user already has three tabs holding live connections,
  **when** they open a fourth,
  **then** the fourth tab does not fail silently: it shows **Live updates are open in another tab**
  and refreshes every 10 seconds instead, and it takes over the live connection automatically if one
  of the other tabs is closed.

- **S11 — Nothing has ever happened.**
  **Given** a brand-new workspace with no agents and no activity,
  **when** the user opens the Live Feed,
  **then** they see an empty state that explains what will appear here and offers two actions —
  **Create an agent** and **Start a mission** — rather than a blank page or a spinner.

- **S12 — The filter matches nothing.**
  **Given** the user has selected an agent that has done nothing in the last 90 days,
  **when** the feed loads,
  **then** it shows **No activity from the agents you picked** with a **Clear filters** action, and
  the live connection stays open so an entry appearing later still arrives.

- **S13 — The feed itself fails to load.**
  **Given** the backing service is unavailable,
  **when** the user opens the Live Feed,
  **then** they see **We couldn't load the feed** with a **Try again** button and a link to the
  Activity log, and no partially rendered list.

- **S14 — Away for a very long time.**
  **Given** the user has not opened the feed for 3 weeks and 40,000 things have happened,
  **when** they open it,
  **then** the away summary covers the **last 7 days only**, says so in one line
  (**Showing the last 7 days — you were away for 21 days**), and states that the counts are based on
  the most recent 1,000 entries when the window is larger than that.

- **S15 — Reaching the end of history.**
  **Given** the user keeps scrolling backwards past 90 days,
  **when** they reach the floor,
  **then** the feed stops with a terminal card reading **That's the last 90 days** and a link to the
  Activity log for older records, instead of an infinite spinner.

- **S16 — Two tabs marking seen at once.**
  **Given** the user has the feed open in two tabs and marks all seen in one,
  **when** the other tab next receives an update,
  **then** its divider and badge clear too, and the seen marker never moves backwards — an older
  request arriving late cannot un-see entries the user has already cleared.

- **S17 — An entry the feed has no words for.**
  **Given** a subsystem writes an activity record whose action type has no bespoke narration,
  **when** it reaches the feed,
  **then** it is still shown, using a generic line built from the actor and a humanised action label —
  it is never hidden, and it is never rendered as a raw underscored token.

- **S18 — A record from another organization.**
  **Given** the user has two organizations and is currently scoped to one,
  **when** activity happens in the other one,
  **then** it does not appear in the feed, does not increment the unseen badge, and does not appear
  in the away summary.

- **S19 — An agent is renamed or deleted.**
  **Given** an entry attributed to an agent that has since been renamed or deleted,
  **when** the user reads the feed,
  **then** the entry still shows the agent name that was current **when it happened**, and the link
  to a deleted agent is rendered as plain text rather than a broken link.

- **S20 — A record containing a secret-shaped value.**
  **Given** a subsystem records an action whose details include a credential-shaped string,
  **when** the entry is narrated,
  **then** the narration uses only the fields explicitly allowed for that action type, and no value
  outside that allow-list can reach the screen.

## 4. Functional requirements

Numbers are binding defaults. Where a value is tunable, the requirement states the default and the
bound.

### 4.1 The stream

- **FR-1** The system MUST present a Live Feed as its own destination in the dashboard navigation,
  ordered immediately above the existing Activity entry.
- **FR-2** The Live Feed MUST show activity records belonging to the signed-in user, restricted to
  the currently active organization scope, newest first.
- **FR-3** The Live Feed MUST NOT create, mirror, or maintain a second store of activity. Every
  entry it shows MUST be an existing activity record.
- **FR-4** A new activity record MUST become visible in an open Live Feed within **2 seconds at the
  median and 5 seconds at the 95th percentile** of being written, without a page reload.
- **FR-5** The live connection MUST send a keep-alive signal every **15 seconds** and MUST be closed
  and re-established by the client at least every **10 minutes**.
- **FR-6** On connection loss the client MUST retry with exponential backoff starting at **1 second**,
  doubling to a maximum of **30 seconds**, with **±20% jitter**.
- **FR-7** After **3 consecutive** failed connection attempts the client MUST fall back to refreshing
  every **10 seconds** and MUST display that it is doing so.
- **FR-8** The system MUST allow at most **3 concurrent live connections per user**. A fourth request
  MUST be refused with a retry-after of **30 seconds**, and the refused client MUST degrade to the
  10-second refresh described in FR-7 rather than showing an error.
- **FR-9** Reconnecting MUST NOT duplicate entries already on screen, and MUST fill any entries
  written during the disconnection.
- **FR-10** Opening a live connection MUST be rate-limited to **12 attempts per minute per user**.

### 4.2 Entries and narration

- **FR-11** Every entry MUST render as a single narrated line of at most **140 characters** naming
  the actor, what happened, and the thing it happened to, plus a relative timestamp
  (`just now`, `4m ago`, `2h ago`, `Yesterday 18:04`, then an absolute date beyond 7 days).
- **FR-12** Every entry MUST carry an actor, resolved in this order: the acting agent; else the
  signed-in user; else the external source that produced it; else the platform itself.
- **FR-13** The actor name shown MUST be the name captured **at the time the record was written**, so
  a later rename or deletion does not rewrite history.
- **FR-14** At least **48 action types** MUST have bespoke narration at first release, covering the
  agent, run, mission, task, goal, skill, approval, inbox, knowledge and delivery clusters.
- **FR-15** An action type without bespoke narration MUST still be shown, using a generic line built
  from the actor and a humanised action label. The system MUST NOT render a raw underscored token and
  MUST NOT hide the entry.
- **FR-16** Narration MUST read only fields explicitly allowed for that action type. Every value
  interpolated into a line MUST have angle brackets stripped and MUST be truncated to **120
  characters** with a trailing ellipsis.
- **FR-17** Every entry MUST classify into exactly one of **5 feed kinds**: `work`, `decision`,
  `delivery`, `problem`, `system`.
- **FR-18** An entry whose outcome was a failure, a refusal, or a tripped limit MUST classify as
  `problem` regardless of which cluster its action type belongs to.
- **FR-19** Activating an entry MUST navigate to the most specific thing it is about — a run receipt
  where one exists, otherwise the owning mission, task, agent, document or connection. An entry MUST
  NOT be activatable if it has no destination; it MUST render as plain text instead.
- **FR-20** Each entry MUST show a small actor avatar or initial, the actor name, the narrated line,
  a kind indicator, and the relative timestamp — in that order.

### 4.3 Reading position, unseen state and the divider

- **FR-21** The system MUST remember, per user, the point up to which that user has seen the feed.
- **FR-22** On opening the feed, a **New** divider MUST be placed above the newest entry the user has
  not seen, labelled with the unseen count, and MUST remain anchored at that position for the whole
  visit even as the seen marker advances.
- **FR-23** The seen marker MUST advance automatically only when **all three** hold: the browser tab
  is visible, the user has had the feed focused for at least **3 seconds**, and the newest loaded
  entry is inside the viewport. It MUST advance at most once every **2 seconds**.
- **FR-24** A **Mark all seen** action MUST clear the divider, the unseen count and the navigation
  badge immediately, and the result MUST survive a reload.
- **FR-25** The seen marker MUST be monotonic. A request to move it to an older point MUST succeed
  with no effect.
- **FR-26** The navigation entry for the Live Feed MUST show an unseen count badge, displaying the
  exact number up to **99** and `99+` beyond that, refreshed at most every **30 seconds**.
- **FR-27** The unseen count MUST respect the active organization scope and MUST NOT count activity
  the user cannot see.

### 4.4 While you were away

- **FR-28** On opening the feed, the system MUST show a while-you-were-away summary when **both**:
  the gap since the seen marker is at least **30 minutes**, and there is at least **1** unseen entry.
- **FR-29** The summary window MUST be the smaller of the actual absence and **7 days**. When the
  absence exceeded the window, the card MUST say so in one line.
- **FR-30** The summary MUST be computed from at most the most recent **1,000** entries in the window.
  When it is truncated, the card MUST say that the counts are based on the most recent 1,000 entries.
- **FR-31** The summary MUST state: the absence duration, the total count, the count per feed kind,
  the top **5** agents by entry count plus an "and N others" remainder, the number of decisions
  waiting, and the number of failures.
- **FR-32** Every number on the summary card MUST be a control that filters the feed to exactly that
  subset.
- **FR-33** The summary MUST be computed within a **3-second** budget. On timeout the card MUST render
  a compact "couldn't summarise" state with a **Retry** action and MUST NOT block the feed itself.
- **FR-34** Dismissing the summary MUST persist. It MUST reappear only after the next absence of at
  least 30 minutes.
- **FR-35** The system MUST NOT show a summary card when the window contains zero entries.
- **FR-36** A written narrative paragraph over the counts is **off by default**. When enabled it MUST
  be generated outside the interactive request, MUST be capped at **1,200 characters**, MUST degrade
  to counts-only with a visible reason on failure, and MUST display the model and token cost that
  produced it.

### 4.5 Filtering

- **FR-37** The feed MUST offer per-agent filtering. The filter bar MUST show up to **12** agent
  chips ordered by recent activity, with the remainder behind a searchable overflow control.
- **FR-38** At most **20** agents MAY be selected at once. Selecting more MUST be refused with an
  inline message rather than silently truncated.
- **FR-39** The feed MUST offer filtering by feed kind, as **5** toggle chips.
- **FR-40** The feed MUST offer an **Only what failed** toggle, equivalent to selecting the `problem`
  kind plus any failed-outcome entry.
- **FR-41** Filter state MUST be reflected in the URL so a filtered view can be shared, and MUST be
  restored on the user's next visit when no URL state is present.
- **FR-42** Changing filters MUST reset paging to the first page and MUST re-scope the live connection
  so that only matching entries arrive.
- **FR-43** Filters MUST NOT change the seen marker, the unseen count, or the away summary.

### 4.6 Paging backwards

- **FR-44** The feed MUST load **30** entries per page by default and MUST NOT accept a page size
  above **50**.
- **FR-45** Older entries MUST load automatically when the end of the list comes within **400 pixels**
  of the viewport, and MUST also be loadable by an explicit **Load older** control for keyboard and
  assistive-technology users.
- **FR-46** Paging MUST use a stable cursor such that entries arriving at the head of the feed cannot
  cause an older entry to be skipped or repeated.
- **FR-47** An invalid or unreadable cursor MUST be rejected with a clear error and the feed MUST
  recover by reloading the first page.
- **FR-48** Automatic loading MUST stop after **20** pages in one visit or at **90 days** of history,
  whichever comes first, and MUST then show a terminal card linking to the Activity log.

### 4.7 Not interrupting the reader

- **FR-49** When the list is scrolled more than **200 pixels** from the top, newly arriving entries
  MUST be queued rather than inserted, and a pill MUST show the queued count.
- **FR-50** The queue MUST hold at most **200** entries; beyond that the oldest queued entries are
  discarded and the pill MUST read `99+`.
- **FR-51** Activating the pill MUST scroll to the top and release the queue in one step.
- **FR-52** When the list is at the top, entries MUST be inserted directly with no queue and no pill.

### 4.8 Emission gaps this epic closes

- **FR-53** A run reaching a terminal state MUST write an activity record, for **all 5** trigger kinds
  — scheduled, manual, task-driven, chat-driven and event-driven — not only for scheduled ones.
- **FR-54** A run failing MUST write an activity record distinct from a run succeeding.
- **FR-55** Records written by background workers MUST carry the owning user and organization of the
  entity they were processing, so they appear in the right feed.
- **FR-56** Records written by retryable background work MUST be idempotent: a retry MUST NOT produce
  a second feed entry for the same occurrence.
- **FR-57** The feed MUST NOT write an activity record for its own use. Opening the feed, marking
  entries seen and changing filters MUST NOT appear in the feed.

### 4.9 Permissions, privacy and limits

- **FR-58** The feed MUST expose only records belonging to the requesting user. There MUST be no
  parameter by which one user can read another user's feed.
- **FR-59** A request for a record outside the caller's scope MUST be indistinguishable from a request
  for a record that does not exist.
- **FR-60** Reading a page of the feed MUST be rate-limited to **120 requests per minute per user**;
  marking seen to **60 per minute**; the away summary to **20 per minute**; the actor list to **60 per
  minute**.
- **FR-61** The feed MUST NOT be exposed on any unauthenticated surface in this epic.
- **FR-62** All user-visible strings MUST be translatable; none may be hard-coded.

## 5. Key entities

| Concept                            | New?                                | Description                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Activity record**                | Existing                            | The single row already written whenever something user-visible happens. The feed reads these and writes none. This epic adds an actor to it.                                   |
| **Actor**                          | New attribute on an existing record | Who did the thing: an agent, the user, an external source, or the platform. Carries a display name captured at write time so history does not change when an agent is renamed. |
| **Feed kind**                      | New attribute (derived)             | One of five buckets — `work`, `decision`, `delivery`, `problem`, `system` — computed from the action type and the outcome. Derived, never stored per row.                      |
| **Feed entry**                     | Not an entity                       | One activity record rendered as a narrated line. Explicitly **not** a record of its own; the feed introduces no second store.                                                  |
| **Feed read state**                | **New entity**                      | Exactly one per user: the point up to which they have seen the feed, when they last opened it, and whether they dismissed the current away summary. Justified below.           |
| **Away summary**                   | Not an entity                       | A computed payload describing an absence. Never stored; recomputed on each open.                                                                                               |
| **Agent**                          | Existing                            | The primary actor and the primary filter dimension. Its name, avatar and status are read for the feed's actor chips.                                                           |
| **Run**                            | Existing                            | One agent execution. Feed entries about runs link to the run's receipt, which [AW-09](../AW-09-runs-receipts/) owns.                                                           |
| **Approval / Escalation**          | Existing                            | The `decision` kind's source. Feed entries about them link to My Decisions, which [AW-03](../AW-03-decision-queue/) owns.                                                      |
| **Organization / Workspace scope** | Existing                            | Bounds every read. Activity in a non-active organization is invisible to the feed.                                                                                             |

### 5.1 Why one new entity is justified

Seen-state is **per viewer**, not per record. It cannot live on the activity record, because a
record is written once and read many times; it cannot live in browser storage, because the promise
of the feature is that the divider and the away summary are the same on a phone and a laptop; and
it cannot be derived from anything that exists, because nothing today records that a human looked
at something. One row per user, holding a marker and two timestamps, is the smallest possible shape
that satisfies the behaviour. It introduces no new vocabulary: it is state _about_ the Live Feed,
not a new noun in the product.

### 5.2 States and transitions

**Feed read state** — one row per user, created lazily on first feed open.

```
        (no row)
           │  first open of the Live Feed
           ▼
    ┌──────────────┐   activity written after the marker
    │   CAUGHT UP  │ ─────────────────────────────────────►┐
    │ unseen = 0   │                                       │
    └──────────────┘                                       ▼
           ▲                                        ┌──────────────┐
           │  Mark all seen                         │   BEHIND     │
           │  ── or ──                              │  unseen > 0  │
           │  auto-advance (tab visible,            │  badge shown │
           │   focused ≥ 3s, top row in view)       └──────────────┘
           └───────────────────────────────────────────────┘

    Away-summary sub-state, orthogonal:
       PENDING   → gap ≥ 30 min and unseen ≥ 1 on open   → card shown
       DISMISSED → user dismissed it                     → card hidden
       PENDING   ← the next absence ≥ 30 min re-arms it
```

The marker only ever moves forward (FR-25). There is no "unread" per entry — the feed has one
watermark, not a per-row read flag, which is what makes two tabs and two devices agree without a
reconciliation step.

**Feed entry** — derived, no persisted lifecycle. An entry is `queued` (arrived while the reader is
scrolled down), `live` (just inserted, briefly highlighted for 1.5 seconds), `unseen` (above the
divider), or `seen`. All four are presentation states in one session; none is stored.

## 6. UX

### 6.1 Navigation

```
 ┌────────────────────┐
 │  ● Home            │
 │  ▸ Missions        │
 │  ▸ My Decisions  2 │
 │  ▸ Live Feed    12 │  ← new entry; badge = unseen count (exact ≤ 99, then "99+")
 │  ▸ Activity        │  ← unchanged
 │  ▸ Agents          │
 │  …                 │
 └────────────────────┘
```

The badge is a count, not a dot, and it disappears the moment the user is caught up.

### 6.2 The feed — default state

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Live Feed                                          ● Live      [Mark all seen]│
│  Everything your agents are doing, as it happens.                              │
├───────────────────────────────────────────────────────────────────────────────┤
│  WHILE YOU WERE AWAY                                                    [ × ]  │
│  You were away for 1h 32m. 34 things happened.                                 │
│                                                                                │
│   24 work  ·  3 decisions waiting  ·  4 delivered  ·  2 failed  ·  1 system    │
│   Ivy 14  ·  Wren 11  ·  Vega 7  ·  and 2 others                               │
│                                                                                │
│   [ Show the 2 failures ]   [ Show the 3 decisions ]                           │
├───────────────────────────────────────────────────────────────────────────────┤
│  Agents:  ( All )  (Ivy)  (Wren)  (Vega)  (Kepler)  (+4 more)                  │
│  Kinds:   [work] [decision] [delivery] [problem] [system]     [ ] Only failed  │
├───────────────────────────────────────────────────────────────────────────────┤
│                        ───────────  New · 34  ───────────                      │
│                                                                                │
│  (I)  Ivy   finished "Refresh the analytics-tools listings"        4m ago  →   │
│       work                                                                     │
│  (W)  Wren  needs a decision on a duplicate listing submission     9m ago  →   │
│       decision                                                                 │
│  (V)  Vega  failed the source-validation sweep — token expired    14m ago  →   │
│       problem                                                                  │
│  (I)  Ivy   published "Q4 category taxonomy" to the knowledge base 22m ago →   │
│       delivery                                                                 │
│  (W)  Wren  started a run for "Weekly source validation"          31m ago  →   │
│       work                                                                     │
│  …                                                                             │
│                                                                                │
│                          [ Load older ]                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

Agent names above are illustrative. `(I)` / `(W)` / `(V)` are the agent avatars already configured
on each agent.

### 6.3 New entries arriving while the reader is scrolled down

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                    ╭──────────────────────────╮                                │
│                    │   ↑  3 new               │  ← pinned pill, click or `t`   │
│                    ╰──────────────────────────╯                                │
│  (I)  Ivy   commented on "Taxonomy cleanup: duplicate tags"       2h ago  →   │
│  (K)  Kepler ingested 38 events from the repository connector     2h ago  →   │
│  …                                                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Loading state (first paint)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Live Feed                                       ◌ Connecting…                 │
├───────────────────────────────────────────────────────────────────────────────┤
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒        │
│  ▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                 │
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒            │
│  (6 skeleton rows; no spinner, no layout shift when the real rows land)        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Empty states

**Nothing has ever happened (S11):**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                                                                │
│                              ( 📡 )                                            │
│                     Nothing has happened yet                                   │
│      When your agents pick up work, finish a run, publish a document or         │
│      need a decision from you, it shows up here — live.                        │
│                                                                                │
│               [ Create an agent ]     [ Start a mission ]                      │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Filters match nothing (S12):**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                     No activity from the agents you picked                     │
│      Nothing matched in the last 90 days. New activity will still appear        │
│      here as it happens.                                                       │
│                            [ Clear filters ]                                   │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.6 Error and degraded states

**Feed failed to load (S13):**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          We couldn't load the feed                             │
│      Nothing was lost — every entry is still in your Activity log.             │
│              [ Try again ]        [ Open the Activity log ]                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Reconnecting (S9), inline under the header, non-blocking:**

```
│  ⟳  Live updates paused — reconnecting…                                        │
```

**Degraded to refreshing (S9, after 3 failures):**

```
│  ⏱  Live updates unavailable — refreshing every 10s          [ Try live again ]│
```

**Live connection held by another tab (S10):**

```
│  ⧉  Live updates are open in another tab — refreshing every 10s                │
```

### 6.7 Over-limit and boundary states

**Too many agents selected (FR-38):**

```
│  Agents:  (Ivy)(Wren)(Vega)(Kepler)(Rune)…(20 selected)                        │
│  ⚠ You can watch up to 20 agents at once. Deselect one to add another.         │
```

**End of history (S15):**

```
│                    ───────  That's the last 90 days  ───────                   │
│              Older records live in your Activity log.                          │
│                        [ Open the Activity log ]                               │
```

**Away summary truncated (S14):**

```
│  WHILE YOU WERE AWAY                                                    [ × ]  │
│  Showing the last 7 days — you were away for 21 days.                          │
│  Counts are based on the most recent 1,000 entries.                            │
│   612 work · 18 decisions waiting · 96 delivered · 44 failed · 230 system      │
```

**Away summary could not be computed (FR-33):**

```
│  WHILE YOU WERE AWAY                                                    [ × ]  │
│  We couldn't summarise your time away.                     [ Retry ]           │
│  The feed below is complete and up to date.                                    │
```

### 6.8 Agent overflow picker

```
┌──────────────────────────────────┐
│  Watch agents            [ Esc ] │
│  ┌────────────────────────────┐  │
│  │ 🔎 Search agents           │  │
│  └────────────────────────────┘  │
│  [x] Ivy          ● working  14  │
│  [x] Wren         ● working  11  │
│  [ ] Vega         ○ idle      7  │
│  [ ] Kepler       ⏸ paused    3  │
│  [ ] Rune         ○ idle      0  │
│                                  │
│  4 of 20 selected                │
│  [ Clear all ]        [ Done ]   │
└──────────────────────────────────┘
```

### 6.9 Exact user-visible copy

| Where                | Copy                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page title           | `Live Feed`                                                                                                                                                                                  |
| Page subtitle        | `Everything your agents are doing, as it happens.`                                                                                                                                           |
| Navigation label     | `Live Feed`                                                                                                                                                                                  |
| Live indicator       | `Live`                                                                                                                                                                                       |
| Connecting indicator | `Connecting…`                                                                                                                                                                                |
| Mark-all action      | `Mark all seen`                                                                                                                                                                              |
| Divider              | `New · {count}`                                                                                                                                                                              |
| New-entries pill     | `↑ {count} new`                                                                                                                                                                              |
| Away card heading    | `While you were away`                                                                                                                                                                        |
| Away card lead       | `You were away for {duration}. {count} things happened.`                                                                                                                                     |
| Away card truncation | `Showing the last 7 days — you were away for {duration}.`                                                                                                                                    |
| Away card scan cap   | `Counts are based on the most recent 1,000 entries.`                                                                                                                                         |
| Away card kinds      | `{work} work · {decision} decisions waiting · {delivery} delivered · {problem} failed · {system} system`                                                                                     |
| Away card actors     | `{list} · and {count} others`                                                                                                                                                                |
| Away card actions    | `Show the {count} failures` / `Show the {count} decisions`                                                                                                                                   |
| Away card failed     | `We couldn't summarise your time away.` / `The feed below is complete and up to date.` / `Retry`                                                                                             |
| Filter bar labels    | `Agents:` / `Kinds:` / `Only failed`                                                                                                                                                         |
| Agent overflow       | `Watch agents` / `Search agents` / `{selected} of 20 selected` / `Clear all` / `Done`                                                                                                        |
| Agent limit          | `You can watch up to 20 agents at once. Deselect one to add another.`                                                                                                                        |
| Load control         | `Load older`                                                                                                                                                                                 |
| End of history       | `That's the last 90 days` / `Older records live in your Activity log.` / `Open the Activity log`                                                                                             |
| Empty — never        | `Nothing has happened yet` / `When your agents pick up work, finish a run, publish a document or need a decision from you, it shows up here — live.` / `Create an agent` / `Start a mission` |
| Empty — filtered     | `No activity from the agents you picked` / `Nothing matched in the last 90 days. New activity will still appear here as it happens.` / `Clear filters`                                       |
| Load error           | `We couldn't load the feed` / `Nothing was lost — every entry is still in your Activity log.` / `Try again` / `Open the Activity log`                                                        |
| Reconnecting         | `Live updates paused — reconnecting…`                                                                                                                                                        |
| Degraded             | `Live updates unavailable — refreshing every 10s` / `Try live again`                                                                                                                         |
| Other tab            | `Live updates are open in another tab — refreshing every 10s`                                                                                                                                |
| Generic narration    | `{actor} · {action}`                                                                                                                                                                         |
| Relative time        | `just now` / `{n}m ago` / `{n}h ago` / `Yesterday {time}` / `{date}`                                                                                                                         |

### 6.10 Keyboard

All keys are single-press and active only when no text input has focus.

| Key            | Action                                         |
| -------------- | ---------------------------------------------- |
| `j`            | Move selection to the next (older) entry       |
| `k`            | Move selection to the previous (newer) entry   |
| `Enter` or `o` | Open the selected entry's destination          |
| `Esc`          | Clear the selection; close the agent picker    |
| `t`            | Jump to the top and release any queued entries |
| `m`            | Mark all seen                                  |
| `a`            | Open the agent picker                          |
| `1`–`5`        | Toggle the corresponding kind chip             |
| `x`            | Toggle **Only failed**                         |
| `Shift`+`L`    | Load the next older page                       |

Accessibility requirements that are part of this spec, not decoration:

- The list is a live region announcing only the count of new entries, never their content, so a
  screen reader is not flooded while the user is reading.
- The divider is announced as a separator with its label.
- Every entry is reachable by `Tab` in document order, and **Load older** is a real button so
  keyboard and assistive-technology users are never dependent on scroll-triggered loading.
- The kind indicator is never colour-only; it carries a text label.
- The live/degraded indicator has a text equivalent, not only an icon.

## 7. Out of scope

- **Search over the feed.** Free-text search stays on the Activity log. The feed filters by agent,
  kind and failure only.
- **Export.** CSV export stays on the Activity log.
- **Changing anything from the feed.** No pausing an agent, answering a decision, retrying a run, or
  editing anything from a feed entry. The feed navigates; the destination acts.
- **A second store or a projection table.** Explicitly forbidden by this epic's own framing.
- **Cross-user or team feeds.** A shared, read-only feed is [AW-18](../AW-18-shared-dashboards/).
- **Notification routing.** Which events also reach email, chat channels or a phone is
  [AW-13](../AW-13-attention-controls/). This epic writes no notifications.
- **The run receipt.** The contents of a run's detail panel are [AW-09](../AW-09-runs-receipts/).
  This epic only links to it.
- **The decision queue.** Answering an approval is [AW-03](../AW-03-decision-queue/).
- **The morning screen.** [AW-19](../AW-19-home/) embeds a compact feed; this epic supplies it but
  does not build Home.
- **Retention or deletion of activity records.** Not changed here.
- **Renaming or restyling the existing Activity log page.** It is untouched.
- **Per-entry read flags.** One watermark per user, deliberately — not a per-row unread state.

## 8. Acceptance criteria

- [ ] A **Live Feed** entry exists in the dashboard navigation directly above **Activity**, and the
      existing Activity page is byte-for-byte unchanged in behaviour.
- [ ] With the feed open, writing an activity record causes a new line to appear within 5 seconds
      with no page reload.
- [ ] Every one of the 5 feed kinds renders with a distinct, text-labelled indicator.
- [ ] At least 48 action types render a bespoke narrated line; a deliberately unknown action type
      renders the generic line and is not hidden.
- [ ] An entry attributed to an agent that is subsequently renamed still shows the original name.
- [ ] A run finishing writes exactly one activity record for each of the 5 trigger kinds
      (scheduled, manual, task-driven, chat-driven, event-driven), and a retried worker does not
      produce a second one.
- [ ] Returning after 90 minutes with unseen activity shows the away summary and a `New · N` divider
      positioned above the first unseen entry.
- [ ] The divider stays anchored while reading and only clears on **Mark all seen** or on the next
      visit after the marker advanced.
- [ ] **Mark all seen** clears the divider and the navigation badge, and the state survives a reload
      and is reflected in a second open tab.
- [ ] A late-arriving request cannot move the seen marker backwards.
- [ ] Selecting an agent chip filters the feed, updates the URL, survives a reload, and re-scopes the
      live connection so non-matching entries do not arrive.
- [ ] Selecting a 21st agent is refused with the inline message and no silent truncation.
- [ ] Scrolling to the bottom loads exactly 30 more entries, appends them, and never repeats or skips
      an entry even while new activity is arriving at the head.
- [ ] Scrolling past 20 pages or 90 days shows the terminal card and stops loading.
- [ ] Scrolling 200+ pixels down and then receiving new activity shows a `↑ N new` pill and does not
      shift the list; pressing `t` scrolls to top and releases the queue.
- [ ] Killing the live connection shows **Live updates paused — reconnecting…**, then the 10-second
      refresh notice after 3 failures, and reconnecting fills the gap without duplicates.
- [ ] Opening a fourth tab shows the other-tab notice and refreshes on a timer instead of erroring.
- [ ] A workspace with no activity shows the never-empty state with both call-to-action buttons.
- [ ] A filter matching nothing shows the filtered-empty state with **Clear filters**.
- [ ] Forcing the backing service to fail shows the load-error state with both actions and no
      partial list.
- [ ] Switching organization scope changes the feed contents, the unseen badge and the away summary
      consistently, and no record from the other organization is reachable.
- [ ] Requesting another user's feed is impossible: no request shape exists that returns their rows,
      and an out-of-scope record id returns the same response as a non-existent one.
- [ ] Opening the feed, marking seen and changing filters produce no activity records of their own.
- [ ] Every visible string resolves from a translation key; a missing-key scan finds none.
- [ ] Every keyboard shortcut in §6.10 works, and the full flow is completable without a mouse.
- [ ] An automated accessibility check on the feed page reports no serious or critical violations.
- [ ] Every functional requirement above has at least one passing automated test.

## 9. Open questions

- `[NEEDS CLARIFICATION: Ordering under clock skew.]` The seen marker is a point in time. Two API
  instances with a small clock difference, or a worker that backdates a record it is catching up on,
  can insert a record slightly _before_ the marker after the marker has advanced — that record would
  never be counted as unseen. Accepting a few seconds of exposure is the cheap answer; a
  monotonically increasing sequence number on activity records is the correct one but is a wider
  change to a hot audit table. Which do we take?
- `[NEEDS CLARIFICATION: How far back is "history"?]` This spec sets a 90-day floor for scrolling and
  a 7-day cap for the away summary. Are those the right numbers for the plans we sell, and does the
  Activity log itself have a retention policy that would make 90 days a lie?
- `[NEEDS CLARIFICATION: Should the feed be scoped to a Work as well as an agent?]` Users who run
  several directories may want "everything about this directory". The per-Work activity feed already
  exists as a separate surface; do we add a Work filter here or leave that split as it is?
- `[NEEDS CLARIFICATION: The written narrative.]` FR-36 leaves the AI paragraph off by default and
  outside the request. Do we ship it at all in this epic, or defer it entirely to the Digest, which
  already writes one?
- `[NEEDS CLARIFICATION: The compact feed for Home.]` AW-19 needs a short feed block. Does it show
  the same entries with the same narration and a smaller page size, or a curated subset (decisions
  and failures only)? The answer changes what this epic must expose.
- `[NEEDS CLARIFICATION: Grouping repetitive entries.]` A connector ingesting 200 events in a minute
  produces 200 lines. Do we collapse runs of the same actor + action type into one expandable line,
  and if so at what threshold?
- `[NEEDS CLARIFICATION: Do entries expire from "unseen"?]` If a user is away for two months, is
  their unseen count 40,000, or do we cap the badge and the divider at the 7-day window the summary
  uses?

## 10. References

- Program overview and vocabulary: [../README.md](../README.md)
- Status tracker: [../TRACKER.md](../TRACKER.md)
- Implementation plan: [plan.md](./plan.md) · Task list: [tasks.md](./tasks.md)
- Constitution: [../../../../../.specify/memory/constitution.md](../../../../../.specify/memory/constitution.md)
- Adjacent existing specs: [activity-log](../../activity-log/), [notifications](../../notifications/),
  [event-subscriptions](../../event-subscriptions/), [schedules](../../schedules/)
- Consuming epics: [AW-13](../AW-13-attention-controls/), [AW-19](../AW-19-home/)
- Linked-to epics: [AW-03](../AW-03-decision-queue/), [AW-09](../AW-09-runs-receipts/),
  [AW-18](../AW-18-shared-dashboards/)
