# AW-09 — Runs and receipts

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `AW-09-runs-receipts`
**Program:** [Agent Workspace](../README.md) · Wave 1 (the spine)
**Branch:** `feat/aw-09-runs-receipts`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** L · **Blocks:** AW-10 (Schedules & calendar), AW-17 (Costs & caps)
**Extends (existing Ever Works nouns):** Run · Agent · Mission · Task · Skill · Schedule · Organization

---

## 0. TL;DR

Ever Works already records every agent execution as a **Run**. What it does not have is a
place where an owner can sit down on Monday morning, pick a day, and read what their agents
did — and what it cost. This epic adds **Runs**: one chronological, calendar-navigated,
filterable ledger of every Run in the workspace, and one **receipt** per Run that itemises
the summary, the Skills the agent loaded, the tokens it burned (input / output / cache), the
tools it called, the money it spent, the exact failure if it failed, and a one-click way to
fix the most common failure — a run that hit the duration ceiling.

```
        ┌───────────────────────────────────────────────────────────────────┐
        │  /runs                                                            │
        │  ┌────────────┐  ◀  Mon 8 Sep  ▶   [Today]      ┌──────────────┐  │
        │  │Day│Week│Mth│                                 │  THIS DAY    │  │
        │  └────────────┘                                 │  41 runs     │  │
        │  ┌─────────────────────────────────────────┐    │  93.1% ok    │  │
        │  │ 09:00  Ops agent   Scheduled   1m 12s   │    │  3 errors    │  │
        │  │ 09:04  Ops agent   Task        4m 55s   │    │  $1.84       │  │
        │  │ 09:12  Research    Manual      0m 31s ✗ │    │              │  │
        │  └─────────────────────────────────────────┘    │  UPCOMING    │  │
        │                    │ open a row                 │  in 6m  Ops  │  │
        │                    ▼                            │  in 1h  Res. │  │
        │  ┌─────────────────────────────────────────┐    └──────────────┘  │
        │  │ RECEIPT — what it did, what it cost     │                      │
        │  │ summary · skills · tokens · tools ·     │                      │
        │  │ cost · error + "Raise the time limit"   │                      │
        │  └─────────────────────────────────────────┘                      │
        └───────────────────────────────────────────────────────────────────┘
```

Three phases, each independently shippable:

- **P1 — The ledger.** The `/runs` page: calendar navigation, filters, the window rail, and a
  receipt panel built from data Ever Works already stores.
- **P2 — The cost breakdown.** Token split (input / output / cache), the Skills a Run loaded,
  per-model attribution, credits, and CSV export. Needs one additive migration.
- **P3 — Upcoming and remediation.** The upcoming-fires panel with countdowns, failure
  classification, the repeat-failure banner, and the "Raise the time limit" shortcut. Needs one
  additive migration.

---

## 1. Overview

**Runs** is a single workspace-wide ledger in which every agent execution appears as one row —
scheduled heartbeats, task work, chat replies, manual runs and (once agent email lands)
inbound-mail triage — showing when it ran, which Agent ran it, what triggered it, how long it
took, which model it used, what it cost, and whether it succeeded. The list is navigated like a
calendar (Day / Week / Month, step back and forward, jump to today, pick a date from a
mini-calendar) and filtered by Agent, trigger, outcome, Mission and model. Opening any row
reveals its **receipt**: the agent's own summary of the run, the Skills it loaded, the tools it
called with their redacted request and response previews, its token usage split into input,
output and cached reads, its cost in money and credits, a jump to the Mission or Task the run
belongs to, and — for failures — the exact error plus, when the cause was the run's time limit,
a one-click way to raise that limit for the Agent that owns it. A rail beside the list carries
the window's headline numbers (runs, success rate, error count, duration, spend) and, in the
same rail, the next scheduled fires with live countdowns, so the past and the immediate future
of the workspace are legible on one screen.

---

## 2. Why now

### 2.1 The user's question

> *"What did my agents actually do yesterday, and why did that cost me eleven dollars?"*

An owner who has delegated real work to agents needs to answer that question in under a minute,
without being an engineer, and without opening five pages. Autonomy is only extended as far as
it can be audited: an owner who cannot see what an agent did will not let it do more. Runs is
the surface where that trust is earned or lost.

### 2.2 What they do today, and why it does not answer the question

Ever Works has all the raw material and none of the assembly:

| To answer… | Today they must… | What breaks |
| --- | --- | --- |
| "What ran yesterday?" | Open **Sessions** under Agents, scroll a flat reverse-chronological list of the most recent 100 runs, and count backwards to find yesterday. | There is no date navigation of any kind. A busy workspace pushes yesterday off the page by lunchtime. |
| "What did *this* agent do this week?" | Open each Agent's **Activity** tab one at a time. | Per-Agent only. No cross-Agent view of a time window exists. |
| "Which runs failed?" | Filter Sessions by status = failed. | Works, but the filter set is status / Work / Agent / trigger only — no date range, no Mission, no model, no free-text search over the summary. |
| "What did it cost?" | Leave Runs entirely, open **Settings → Usage & Credits → Costs**, choose a rolling 7/30/90-day window, and read *Top runs by cost*. | Cost lives on a different page under a different window model. Going from "that Tuesday was expensive" to "*this* run made it expensive" is a cross-referencing exercise across two surfaces with incompatible time controls. |
| "How many tokens did that run read from cache?" | Nothing. | The metering path records prompt and completion tokens into a log row's free-form metadata and records **no cached-read tokens at all**. The Costs page's per-Agent panel documents this omission in its own API description rather than fabricating a number. |
| "Which Skills did the agent actually load for that run?" | Nothing. | Skill resolution happens per run, is dropped when it exceeds the Agent's context budget, and is written only as a transient log line. The most common real cause of odd agent behaviour — "it did not load the playbook you thought it would" — is invisible after the fact. |
| "It timed out. Now what?" | Guess. Ask an operator to change an environment variable. | The run duration ceiling is a single instance-wide setting (30 minutes by default). There is no per-Agent override, so the owner of a legitimately long-running agent has no self-service fix. |
| "What is about to run?" | Open Activity → Schedules and read next-run times. | A separate page and a separate mental model from "what already ran". |

### 2.3 The three gaps this epic closes

1. **No time-shaped navigation.** Runs are a chronological fact and are currently presented as
   an undated stack. Calendar navigation is the mental model every user already has.
2. **Forensics and money are on different screens.** A run's cost is settled onto the run itself,
   yet the only place a user can see cost is an aggregate dashboard three clicks away in Settings.
   One receipt per execution collapses that.
3. **Failures are shown but not fixable.** A failed run states its error and stops. For the one
   failure class the platform can diagnose unambiguously — the run exceeded its time limit — the
   fix should be a button on the error, not a support conversation.

### 2.4 Why this epic is additive only

Per [program rule 1](../README.md#5-rules-every-epic-spec-in-this-program-must-follow), nothing
is removed or renamed. The Sessions list, the per-Agent Activity tab, the session detail page
and the Costs dashboard all keep working exactly as they do today. Runs is a new surface over
the same Run records, and the existing surfaces gain links into it.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — The Monday review.**
**Given** an owner whose agents ran 41 times last week,
**when** they open Runs, press `w` for the Week view and press `←` once to step back a week,
**then** the list shows every Run that started inside that week ordered newest first, and the
rail reports the week's run count, success rate, error count, total agent time and total spend
for exactly that window — no other window's numbers ever bleed in.

**S2 — Finding the expensive run.**
**Given** the owner sees `$11.40` in the rail for a single day,
**when** they sort or filter by cost and open the most expensive row,
**then** the receipt shows the model used, the input / output / cached-read token split, the
credits debited, and a per-tool breakdown, so they can see that one research-heavy run consumed
most of the day's spend.

**S3 — Reading a receipt.**
**Given** a completed Run,
**when** the owner opens it,
**then** they see the agent's own summary, the ordered list of Skills the agent loaded for that
run, the timeline of assistant turns and tool calls with redacted argument and result previews,
the files the run touched, and a link that takes them to the Mission or Task the run belongs to.

**S4 — Diagnosing a repeated failure.**
**Given** the same scheduled Agent has failed 3 times inside the selected window,
**when** the owner opens Runs for that window,
**then** a banner above the list reads *"3 runs from the same schedule failed in this window —
the schedule is more likely at fault than any single run"* with a control that jumps straight
to that schedule's definition.

**S5 — Raising a time limit.**
**Given** a Run that failed because it exceeded its time limit,
**when** the owner opens the receipt,
**then** the error block names the limit that was exceeded and offers **"Raise the time limit"**;
choosing it opens a confirmation showing the current effective limit and the proposed new one,
and confirming applies the new limit to the Agent that owns the run and shows a confirmation
toast. Runs already recorded are not re-run.

**S6 — Seeing what is about to happen.**
**Given** the workspace has scheduled Agents and recurring Tasks,
**when** the owner looks at the rail,
**then** the **Upcoming** section lists the next scheduled fires within the next 7 days, each
with a live countdown that ticks every second, and choosing one jumps to the schedule it comes
from.

**S7 — Hunting one agent's chat replies.**
**Given** a workspace with 12 Agents,
**when** the owner filters by Agent = "Ops" and Trigger = "Chat reply" for the current month,
**then** only those runs are listed, the rail's numbers recompute for the filtered set, the
filters are reflected in the page URL, and reloading the page restores the same view.

**S8 — Jumping in from somewhere else.**
**Given** a Mission detail page showing a Run chip,
**when** the owner follows it,
**then** Runs opens with the window containing that run selected, the row focused, and its
receipt already open.

### 3.2 Unhappy paths, races, denials and empty states

**S9 — Nothing ran that day.**
**Given** a day with no runs,
**when** the owner navigates to it,
**then** the list shows *"Nothing ran on this day"* with the two adjacent days that do have runs
offered as one-tap jumps, and the rail shows zeros rather than blank space. The window is not
silently changed for them.

**S10 — Brand-new workspace.**
**Given** a workspace whose agents have never run,
**when** the owner opens Runs,
**then** they see *"No runs yet"*, one sentence explaining that runs appear here the moment an
agent starts working, and links to create an Agent and to set a heartbeat. No calendar chrome
is hidden — the date controls still work so the page never looks broken.

**S11 — A run that is still going.**
**Given** a Run that is `running`,
**when** the owner views the current window,
**then** the row shows a live elapsed timer and the agent's current activity line instead of a
duration, no outcome badge is asserted, and the row updates at least every 5 seconds while the
window includes now. When the run finishes, the row settles to its final state without the list
jumping or losing the user's scroll position.

**S12 — The receipt of a run that is still going.**
**Given** an open receipt for a `running` Run,
**when** new timeline entries are captured,
**then** they append at the bottom and the cost and token figures are labelled
*"so far"* — never presented as final. The Skills block is available as soon as the run has
assembled its prompt.

**S13 — Capture cap reached.**
**Given** a Run that produced more captured entries than the per-run capture cap,
**when** the owner opens its receipt,
**then** the timeline ends with an explicit marker — *"Older entries were omitted — this run
reached its capture limit of 200 entries"* — rather than silently showing a partial history.

**S14 — Cost detail aged out.**
**Given** a Run older than the 12-month usage-detail retention window,
**when** the owner opens its receipt,
**then** the settled total cost is still shown (it is stamped on the run itself), and the
per-model and per-tool breakdown is replaced by *"Itemised usage for this run is older than 12
months and is no longer retained. The settled total is unchanged."*

**S15 — Cost never attributed.**
**Given** a Run whose cost was never settled (it was cancelled before settlement, or every
provider call used the owner's own API key),
**when** the owner opens its receipt,
**then** the cost line reads *"Not attributable"* or *"Your own provider key — no platform
charge"* respectively. It never reads `$0.00`, because zero and unknown are different answers.

**S16 — Another person's run.**
**Given** a Run id belonging to a different account or a different Organization scope,
**when** it is requested directly by URL,
**then** the page renders *"This run does not exist, or you do not have access to it"* — the
same response for a missing id and a forbidden id, so the surface never confirms that a run
exists.

**S17 — Read-only teammate.**
**Given** a teammate with read access to the workspace,
**when** they open a failed run's receipt,
**then** they can read everything the owner can read, and the **"Raise the time limit"** control
is present but disabled with the tooltip *"You need permission to change this Agent's settings."*

**S18 — The ledger request fails.**
**Given** the runs list request errors,
**when** the page loads,
**then** the calendar chrome, filters and rail skeletons still render, the list area shows
*"We could not load runs for this window"* with a **Retry** control, and the previously loaded
window is not wiped from the screen. A failing rail does not blank the list, and a failing list
does not blank the rail.

**S19 — Raising a limit that someone else already raised.**
**Given** two people open the same failed receipt and both choose **"Raise the time limit"**,
**when** the second confirmation is submitted after the first has applied,
**then** the second is told *"This Agent's time limit is already 60 minutes — no change made"*
and nothing is overwritten. The control re-reads the current effective limit before it proposes
a new one.

**S20 — Raising a limit that is already at the ceiling.**
**Given** an Agent already at the 4-hour maximum,
**when** the owner opens a timed-out run's receipt,
**then** the shortcut is replaced by *"This Agent is already at the maximum time limit of 4
hours. This run is doing too much for one execution — split the work into smaller Tasks."*

**S21 — Filters that select nothing.**
**Given** filters that match no runs in the window,
**when** they are applied,
**then** the list shows *"No runs match these filters in this window"* with a **Clear filters**
control and a **Search the last 90 days** control that widens the window instead of the filters.

**S22 — Export too large.**
**Given** a selected window and filter set that resolves to more than 50,000 rows,
**when** the owner chooses **Export CSV**,
**then** the export is refused before it starts with *"That is more than 50,000 runs. Narrow the
window or the filters and try again."* — never a truncated file presented as complete.

**S23 — A run with no Mission.**
**Given** a heartbeat Run that belongs to no Mission or Task,
**when** its receipt is opened,
**then** the related-work block reads *"This run was not part of a Mission"* and links to the
Agent instead. The section is never rendered as an empty box.

**S24 — Clock and timezone.**
**Given** an owner whose profile timezone is `Asia/Tokyo`,
**when** they select "Today",
**then** the window boundaries are that day in Tokyo, every timestamp renders in Tokyo, and the
timezone in force is stated once beneath the date control so a number is never ambiguous.

---

## 4. Functional requirements

### 4.1 The ledger

- **FR-1** The system MUST provide a workspace-level Runs surface listing every Run the acting
  user owns, within a selected time window, ordered by start time descending, with runs that
  have not started yet ordered by creation time in the same position.
- **FR-2** Each row MUST show, at minimum: start time, Agent name, trigger, duration, model,
  outcome and cost. A value the platform does not have MUST render as an explicit "—" with a
  tooltip explaining why, never as a zero.
- **FR-3** The window MUST support exactly three granularities: **Day**, **Week** and **Month**.
  Week starts on Monday. There is no custom range picker in this epic.
- **FR-4** The default granularity MUST be **Day** and the default window MUST be today, in the
  acting user's profile timezone, falling back to UTC when the profile carries none.
- **FR-5** The chosen granularity MUST persist per user across visits; the chosen window MUST NOT
  (returning to Runs always lands on today).
- **FR-6** The window MUST be reachable up to **12 months** before today and up to **7 days**
  after today. Requests outside that range MUST be clamped, with a one-line notice saying so.
- **FR-7** Rows MUST be fetched in pages of **50** by default, configurable by request up to a
  maximum of **200**, using cursor pagination that is stable while new runs arrive.
- **FR-8** While the selected window includes the present moment **and** at least one listed run
  is not in a terminal state, the list MUST refresh at least every **5 seconds**; otherwise it
  MUST NOT poll.
- **FR-9** A refresh MUST NOT change the user's scroll position, close an open receipt, or
  discard an in-progress filter edit.

### 4.2 Navigation and keyboard

- **FR-10** The window MUST be steppable one granularity unit backward and forward with on-screen
  **Previous** and **Next** controls.
- **FR-11** When no text input has focus, the following single keys MUST act on the page:
  `←` previous window · `→` next window · `t` today · `d` Day · `w` Week · `m` Month ·
  `j` focus next row · `k` focus previous row · `Enter` or `o` open the focused row's receipt ·
  `Esc` close the receipt, then clear row focus · `/` focus the search box · `f` open filters ·
  `?` show the shortcut sheet.
- **FR-12** A mini-calendar MUST allow jumping to any date within the range defined in FR-6, and
  MUST visually mark days that contain at least one run and days that contain at least one
  failure, using two distinguishable indicators that do not rely on colour alone.
- **FR-13** Every navigation state (granularity, window anchor date, filters, open receipt id)
  MUST be encoded in the page URL so a view is shareable and survives reload.
- **FR-14** All interactive controls MUST be reachable by keyboard in a logical order, and the
  receipt panel MUST trap focus while open and restore focus to the originating row on close.

### 4.3 Filters and search

- **FR-15** The list MUST be filterable by: Agent (multi-select), trigger (multi-select),
  outcome (multi-select), Mission, Work, and model. Filters combine with AND across dimensions
  and OR within a dimension.
- **FR-16** The list MUST support free-text search over the run summary and the run's error
  message, requiring a minimum of **2** characters and accepting a maximum of **200**.
- **FR-17** Applied filters MUST recompute the rail's aggregates for the same filtered set. The
  rail MUST never show unfiltered numbers beside a filtered list.
- **FR-18** The filter bar MUST show the count of active filters and offer a single **Clear
  filters** action.
- **FR-19** A filter value that no longer exists (an archived Agent, a deleted Mission) MUST
  still resolve historical rows and MUST label the value as archived rather than dropping it.

### 4.4 The rail

- **FR-20** The rail MUST show, scoped to the selected window and the active filters: total runs,
  success rate as a percentage to one decimal place, error count, total agent time, total spend
  in the account currency, and total tokens.
- **FR-21** Success rate MUST be defined as completed runs divided by all terminal runs
  (completed + failed + cancelled) in the window, and MUST be suppressed with "—" when the window
  contains fewer than **1** terminal run.
- **FR-22** Each rail metric MUST be a filter shortcut: choosing the error count MUST apply
  outcome = failed to the current window rather than navigating away.
- **FR-23** The rail MUST state its scope in words — *"this day"*, *"this week"*, *"this month"*
  — so a number is never mistaken for an all-time total.

### 4.5 The receipt

- **FR-24** Opening any row MUST reveal a receipt for that Run without leaving the page, and the
  same receipt MUST be reachable as a standalone page by direct URL.
- **FR-25** The receipt MUST contain these blocks, in this order: **Outcome header** (agent,
  trigger, start, duration, outcome), **Summary**, **Error** (failures only), **Cost**,
  **Skills used**, **Timeline**, **Files touched**, **Related work**.
- **FR-26** The **Summary** block MUST show the agent's own end-of-run summary, or
  *"No summary was recorded for this run"* when none exists.
- **FR-27** The **Skills used** block MUST list every Skill resolved for the run in the priority
  order the agent loaded them, and MUST separately list Skills that were resolved but **dropped**
  because the run exceeded the Agent's Skill context budget, and Skills **suppressed** because the
  Agent's tool grants refused every tool the Skill declares. Each entry links to the Skill.
- **FR-28** The **Cost** block MUST show: total cost in the account currency, credits debited,
  the model or models used, and token counts split into **input**, **output**, **cached read**
  and **cached write**. Where the platform genuinely has no cache figure for a provider, the
  cache rows MUST read *"Not reported by this provider"* rather than `0`.
- **FR-29** The **Cost** block MUST show a per-model breakdown when a run used more than one
  model, and a per-capability breakdown separating model spend from search, extraction,
  screenshot and email spend.
- **FR-30** The **Timeline** block MUST show assistant turns, user turns and tool invocations in
  order, each tool invocation carrying its name, duration, error flag, and redacted request and
  response previews, and MUST page older entries on demand.
- **FR-31** Request and response previews MUST be redacted of credential-shaped values and capped
  at **4,096** characters per preview; message text MUST be capped at **8,192** characters. When a
  value is truncated the receipt MUST say so.
- **FR-32** When a run reached the per-run capture limit of **200** entries, the timeline MUST end
  with an explicit "older entries omitted" marker.
- **FR-33** The **Related work** block MUST link to the Mission and the Task the run belongs to
  when they exist, to the Work when one is set, and to the Agent always.
- **FR-34** A run produced by a schedule MUST offer a control that jumps directly to that
  schedule's definition.
- **FR-35** Cost, token and credit figures for a run that is not yet terminal MUST be labelled
  *"so far"*.
- **FR-36** For runs older than **12 months**, the itemised cost breakdown MUST be replaced with a
  retention notice while the settled total remains visible.

### 4.6 Failures and remediation

- **FR-37** Every failed run MUST show a classified failure reason drawn from a closed set:
  `timeout`, `provider-error`, `tool-error`, `budget-stop`, `credits-exhausted`,
  `guardrail-refusal`, `cancelled-by-user`, `swept-stale`, `unknown` — plus the exact underlying
  error message, redacted.
- **FR-38** When and only when the classified reason is `timeout`, the receipt MUST offer a
  **"Raise the time limit"** control.
- **FR-39** The **"Raise the time limit"** control MUST show the current effective limit for the
  Agent, propose the next value from the ladder **30 min → 60 min → 2 h → 4 h**, and require an
  explicit confirmation before writing.
- **FR-40** The maximum settable per-Agent time limit MUST be **4 hours (14,400 seconds)**. At the
  ceiling the control MUST be replaced by guidance to split the work.
- **FR-41** Raising the limit MUST apply to the Agent that owns the run and MUST take effect for
  that Agent's subsequent runs only. It MUST NOT re-run, retry or modify any existing run.
- **FR-42** An Agent with no explicit limit MUST inherit the deployment's default of **30 minutes
  (1,800 seconds)**, and the receipt MUST say which of the two is in force.
- **FR-43** When **2 or more** failed runs in the selected window share the same schedule source,
  the page MUST show one grouped banner naming the schedule and the failure count, with a jump to
  the schedule definition. The banner MUST be dismissible for the session.
- **FR-44** Raising an Agent's time limit MUST be recorded in the activity log as an Agent
  settings change, attributed to the acting user.

### 4.7 Upcoming fires

- **FR-45** The page MUST show the next scheduled fires across the workspace, covering a horizon
  of **7 days** and capped at **50** entries, ordered by next-fire time ascending.
- **FR-46** Each upcoming entry MUST show the owning entity's name, a human-readable cadence, and
  a countdown that updates at least once per second while the panel is visible.
- **FR-47** The upcoming list MUST refresh from the server at least every **60 seconds** and
  immediately when the browser tab regains focus.
- **FR-48** A schedule that is paused, disabled or ended MUST NOT appear in Upcoming.
- **FR-49** Choosing an upcoming entry MUST navigate to the schedule's definition, not to Runs.
- **FR-50** When nothing is scheduled, the panel MUST read *"Nothing scheduled in the next 7
  days"* and link to where a schedule is created.

### 4.8 Export, scope and permissions

- **FR-51** The current window and filter set MUST be exportable as CSV, streamed rather than
  buffered, containing one row per Run with the columns shown in the list plus token and credit
  totals.
- **FR-52** Export MUST be refused, before any work starts, when the resolved set exceeds
  **50,000** rows or the window exceeds **92** days.
- **FR-53** Every read MUST be scoped to the acting user, and additionally to the active
  Organization when one is selected. There MUST be no request parameter by which a caller can
  name a different user, Organization or tenant.
- **FR-54** A run that the caller may not read MUST produce the same response as a run that does
  not exist.
- **FR-55** The **"Raise the time limit"** control MUST require the same permission as editing
  that Agent's settings, and MUST render disabled with an explanation when the viewer lacks it.
- **FR-56** The receipt MUST NOT display any value marked secret, and MUST NOT display raw
  provider credentials even when an upstream error message echoes one.

### 4.9 Performance and honesty

- **FR-57** A window of up to 50 rows MUST return in under **800 ms** at the 95th percentile; the
  rail aggregates MUST return in under **400 ms** at the 95th percentile.
- **FR-58** The rail, the list and the upcoming panel MUST load independently: any one failing
  MUST NOT prevent the other two from rendering.
- **FR-59** No number on this surface may be derived from an assumption. Where the platform has
  not measured a quantity, the surface MUST say it was not measured.
- **FR-60** Runs MUST NOT introduce a second definition of any concept named in the program
  vocabulary. It reads Runs, Agents, Missions, Tasks, Skills and Schedules as they already exist.

---

## 5. Key entities

| Concept | New or existing | What it is here |
| --- | --- | --- |
| **Run** | **Existing** (extended) | One agent execution. Already carries trigger, status, start/finish, duration, summary, error, total tokens, cost, quality-gate state, workspace metadata and attention flags. This epic adds durable per-run telemetry: the token split, the models used, the Skills loaded, the classified failure reason, the time limit that was in force, and a tool-call count. |
| **Run receipt** | **New — projection only, no new table** | The itemised, after-the-fact account of one Run, assembled at read time from the Run, its captured log entries, and its usage events. Named as a new noun in the [program README](../README.md#0-why-this-program-exists); it is a *view*, never a stored record. |
| **Usage event** | **Existing** (extended) | One metered provider call, already attributed to user, Work, Agent, Task and Run, and already carrying capability, plugin, model, units and cost. This epic adds first-class input / output / cached-read / cached-write token columns, which today exist only as free-form metadata (and, for cache, not at all). |
| **Run log entry** | **Existing** | The captured, redacted, size-capped timeline rows a run writes as it works. Read unchanged. |
| **Agent** | **Existing** (extended) | Gains an optional per-Agent maximum run duration. `null` means "inherit the deployment default". |
| **Schedule** | **Existing** | The unified projection over recurring Tasks, Agent heartbeats, Work schedules, Mission ticks, source-validation and data-sync. Read unchanged; supplies both the Upcoming panel and the "jump to definition" target. |
| **Upcoming fire** | **New — projection only, no new table** | One future occurrence of an existing Schedule, with a countdown. Derived at read time; it is not a Run and never becomes one. |
| **Credit ledger entry** | **Existing** | The credit movement a settled Run produces, already correlated to the Run. Read to populate the receipt's credits line. |
| **Mission / Task / Work / Skill** | **Existing** | Link targets and filter dimensions. Read unchanged. |

### 5.1 Run lifecycle as this surface renders it

```
   created
      │
      ▼
  ┌─────────┐  concurrency slot free   ┌─────────┐
  │ queued  │ ───────────────────────▶ │ running │
  └─────────┘                          └─────────┘
      │                                     │
      │ cancelled before start              ├──▶ completed   ✓ counts toward success rate
      │                                     ├──▶ failed      ✗ counts toward error count
      ▼                                     └──▶ cancelled   ⊘ terminal, not an error
  cancelled

  Rendering rules:
    queued     → "Waiting" + the queue reason; no duration asserted
    running    → live elapsed timer + current activity line; cost labelled "so far"
    completed  → duration, outcome badge, settled cost
    failed     → duration, classified reason, exact error, remediation when reason = timeout
    cancelled  → duration, "Cancelled by you" or "Cancelled by the platform"
```

An **Upcoming fire** is deliberately *not* a state of Run. It has no id, cannot be opened, and
disappears the moment the schedule fires and a real `queued` Run appears in the list. Presenting
projections and records as the same object would make every id on this page unreliable.

### 5.2 Failure classification

| Classified reason | Assigned when | Remediation offered |
| --- | --- | --- |
| `timeout` | The execution exceeded the effective run time limit, or the stale-run sweeper reaped it after the duration ceiling plus its safety margin. | **Raise the time limit** |
| `provider-error` | A model or provider call failed. | Link to the Agent's model settings |
| `tool-error` | A tool invocation failed and the run could not recover. | Link to the failing tool's Connection |
| `budget-stop` | A Work or Agent spend cap refused the run. | Link to the cap |
| `credits-exhausted` | The credit balance could not cover the run. | Link to credits |
| `guardrail-refusal` | A guardrail or policy refused the action. | Link to the Agent's guardrails |
| `cancelled-by-user` | A person cancelled or interrupted it. | None |
| `swept-stale` | The run stopped reporting and was reaped. | None; explains itself |
| `unknown` | Everything else. | None — the exact error is shown verbatim |

---

## 6. UX

All copy below is the exact user-visible English string. Every one is an i18n key
(see [plan.md §8](./plan.md#8-i18n)).

### 6.1 Runs — Day view, loaded

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│  Runs                                                                                 │
│  Every agent execution, what it did and what it cost.                                 │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────┐   ◀   Monday, 8 September 2026   ▶    [ Today ]    ⌄ Jump to date│
│ │ Day │ Week │Month│   Times shown in Asia/Tokyo                                       │
│ └──────────────────┘                                                                  │
│ ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 🔍 Search summaries and errors      [ Agent ⌄ ] [ Trigger ⌄ ] [ Outcome ⌄ ] ⋯ (2) │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┬─────────────────────────┤
│ ⚠ 3 runs from the same schedule failed in this window —     │  THIS DAY               │
│   the schedule is more likely at fault than any single run. │  ─────────────────────  │
│   [ Open the schedule ]                              [ ✕ ]  │  Runs            41     │
├─────────────────────────────────────────────────────────────┤  Succeeded    93.1 %    │
│ TIME    AGENT      TRIGGER    DURATION  MODEL     COST   ✓  │  Errors           3  ▸  │
│ ─────────────────────────────────────────────────────────── │  Agent time  2h 11m     │
│ 09:00   Ops        Scheduled   1m 12s   sonnet   $0.04  ✓ ⚙ │  Spend        $1.84     │
│ 09:04   Ops        Task        4m 55s   sonnet   $0.31  ✓   │  Tokens        412k     │
│ 09:12   Research   Manual      0m 31s   —        —      ✗   │                         │
│ 09:20   Ops        Chat reply  0m 08s   haiku    $0.00  ✓   │  UPCOMING               │
│ 09:31   Research   Scheduled   ⏱ 4m 02s  sonnet  $0.12 ▶ ⚙ │  ─────────────────────  │
│         └ Reading the pricing page…                         │  in 6m   Ops            │
│ 10:00   Ops        Scheduled   1m 04s   sonnet   $0.04  ✓ ⚙ │          Every hour     │
│                                                             │  in 1h 12m  Research    │
│                    Showing 41 of 41 · [ Export CSV ]        │          Every day 11:00│
└─────────────────────────────────────────────────────────────┴─────────────────────────┘
   ◀ ▶ move the window · t today · d/w/m switch view · j/k rows · Enter open · ? shortcuts
```

Copy: title **"Runs"**; subtitle **"Every agent execution, what it did and what it cost."**;
timezone line **"Times shown in {timezone}"**; footer **"Showing {shown} of {total}"**;
rail heading **"THIS DAY"** / **"THIS WEEK"** / **"THIS MONTH"**; rail labels **"Runs"**,
**"Succeeded"**, **"Errors"**, **"Agent time"**, **"Spend"**, **"Tokens"**; **"UPCOMING"**;
**"Export CSV"**; **"Jump to date"**; **"Today"**.
Row glyph legend: `✓` succeeded, `✗` failed, `▶` running, `⊘` cancelled, `⏱` elapsed so far,
`⚙` jump to the schedule that produced this run.

### 6.2 Week view with the mini-calendar open

```
┌──────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────┐  ◀  1 – 7 September 2026  ▶   [ Today ]  ⌄      │
│ │ Day │▌Week▐│Month│                                                 │
│ └──────────────────┘        ┌──────────────────────────────────────┐ │
│                             │  ◀   September 2026   ▶              │ │
│                             │  Mo Tu We Th Fr Sa Su                │ │
│                             │      1  2  3  4  5  6  7             │ │
│                             │      •  •  ×  •  •                   │ │
│                             │   8  9 10 11 12 13 14                │ │
│                             │   ×  •  •  ·  ·                      │ │
│                             │  • has runs   × has failures         │ │
│                             │  Reaches back to September 2025      │ │
│                             └──────────────────────────────────────┘ │
```

Copy: **"• has runs"**, **"× has failures"**, **"Reaches back to {month} {year}"**.
The day markers are a filled dot and a cross — two shapes, so the distinction never depends on
colour.

### 6.3 Loading

```
┌───────────────────────────────────────────────────────────┬────────────────┐
│ ┌──────────────────┐  ◀  Monday, 8 September 2026  ▶      │  THIS DAY      │
│ │ Day │ Week │Month│                                      │  ▨▨▨      ▨▨   │
│ └──────────────────┘                                      │  ▨▨▨▨   ▨▨▨▨   │
│ ▨▨▨▨▨▨▨  ▨▨▨▨▨▨   ▨▨▨▨▨▨    ▨▨▨▨▨   ▨▨▨▨    ▨▨▨▨  ▨       │  ▨▨▨▨▨   ▨▨    │
│ ▨▨▨▨▨▨▨  ▨▨▨▨▨▨   ▨▨▨▨▨▨    ▨▨▨▨▨   ▨▨▨▨    ▨▨▨▨  ▨       │                │
│ ▨▨▨▨▨▨▨  ▨▨▨▨▨▨   ▨▨▨▨▨▨    ▨▨▨▨▨   ▨▨▨▨    ▨▨▨▨  ▨       │  Loading…      │
│                  Loading runs for this day…               │                │
└───────────────────────────────────────────────────────────┴────────────────┘
```

Copy: **"Loading runs for this day…"** / **"…for this week…"** / **"…for this month…"**.
The calendar controls are live during loading — a user may step away from a slow window.

### 6.4 Empty — nothing on this day

```
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                             ○                                         │
│                    Nothing ran on this day                            │
│         Your agents were idle between 00:00 and 23:59.                │
│                                                                       │
│      [ ◀ Sunday, 7 Sep — 12 runs ]        [ Tuesday, 9 Sep — 8 runs ▶ ]│
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Copy: **"Nothing ran on this day"**; **"Your agents were idle between {start} and {end}."**;
jump chips **"{weekday}, {date} — {count} runs"**.

### 6.5 Empty — no runs have ever happened

```
┌───────────────────────────────────────────────────────────────────────┐
│                            ⌛                                          │
│                        No runs yet                                    │
│   A run appears here the moment an agent starts working — whether     │
│   you asked it to, a schedule woke it, or a Task was assigned to it.  │
│                                                                       │
│           [ Create an Agent ]     [ Set up a schedule ]               │
└───────────────────────────────────────────────────────────────────────┘
```

Copy: **"No runs yet"**; body as shown; **"Create an Agent"**; **"Set up a schedule"**.

### 6.6 Empty — filters match nothing

```
┌───────────────────────────────────────────────────────────────────────┐
│                No runs match these filters in this window             │
│      Agent: Research · Outcome: Failed · 8 September 2026             │
│                                                                       │
│     [ Clear filters ]        [ Search the last 90 days instead ]      │
└───────────────────────────────────────────────────────────────────────┘
```

Copy: **"No runs match these filters in this window"**; **"Clear filters"**;
**"Search the last 90 days instead"**.

### 6.7 Error — the window could not load

```
┌───────────────────────────────────────────────────────────────────────┐
│  ⚠  We could not load runs for this window.                           │
│     Your filters and the selected date are unchanged.                 │
│                                     [ Retry ]   [ Report a problem ]  │
└───────────────────────────────────────────────────────────────────────┘
```

Copy: **"We could not load runs for this window."**; **"Your filters and the selected date are
unchanged."**; **"Retry"**; **"Report a problem"**.

### 6.8 Receipt — a completed run

```
┌────────────────────────────────────────────────────────────── ✕ (Esc) ─┐
│  ✓ Completed · Ops · Scheduled · 8 Sep 09:04 · 4m 55s                  │
│  ─────────────────────────────────────────────────────────────────────  │
│  SUMMARY                                                               │
│  Reviewed 14 open pull requests, left review notes on 3 and merged 1.  │
│                                                                        │
│  COST                                     $0.31 · 12 credits           │
│  ─────────────────────────────────────────────────────────────────────  │
│  Model            claude-sonnet-4-5            $0.29                   │
│  Search           2 calls                      $0.02                   │
│  ─────────────────────────────────────────────────────────────────────  │
│  Input tokens                                  74,210                  │
│  Output tokens                                  6,884                  │
│  Cached read                                   61,002   (82 % of input)│
│  Cached write                     Not reported by this provider        │
│                                                                        │
│  SKILLS USED                                                           │
│  1. pr-review-checklist                       loaded                   │
│  2. house-style                               loaded                   │
│  3. release-notes                             dropped — over the        │
│                                               Agent's 4,000-token       │
│                                               Skill budget              │
│                                                                        │
│  TIMELINE                                              41 entries      │
│  09:04:02  Agent   "Fetching the open pull requests…"                  │
│  09:04:03  Tool    listPullRequests            0.4s                    │
│            Arguments  { "state": "open", "limit": 50 }                 │
│            Result     { "count": 14, … }                Truncated ▸    │
│  09:06:41  Tool    postReviewComment           1.2s     error          │
│            Result     403 Forbidden — the token cannot review this repo│
│  09:08:57  Agent   "Merged the release branch."                        │
│                                       [ Load older entries ]           │
│                                                                        │
│  FILES TOUCHED                                             6 files     │
│  docs/CHANGELOG.md · package.json · …                                  │
│                                                                        │
│  RELATED WORK                                                          │
│  Mission  Ship the September release            ▸                      │
│  Task     Review open pull requests             ▸                      │
│  Agent    Ops                                   ▸                      │
└────────────────────────────────────────────────────────────────────────┘
```

Copy: section headings **"SUMMARY"**, **"COST"**, **"SKILLS USED"**, **"TIMELINE"**,
**"FILES TOUCHED"**, **"RELATED WORK"**; **"Input tokens"**, **"Output tokens"**,
**"Cached read"**, **"Cached write"**; **"Not reported by this provider"**;
**"{percent} % of input"**; **"loaded"**, **"dropped — over the Agent's {limit}-token Skill
budget"**, **"suppressed — this Agent is not granted the tools this Skill needs"**;
**"{count} entries"**; **"Load older entries"**; **"Truncated"**;
**"Arguments"**, **"Result"**, **"error"**; **"{count} files"**.

### 6.9 Receipt — a failed run whose cause was the time limit

```
┌────────────────────────────────────────────────────────────── ✕ (Esc) ─┐
│  ✗ Failed · Research · Scheduled · 8 Sep 09:12 · 30m 00s               │
│  ─────────────────────────────────────────────────────────────────────  │
│  WHAT WENT WRONG                                                       │
│  This run hit its time limit.                                          │
│  It ran for 30 minutes, which is the limit currently in force for the  │
│  Research agent (inherited from the workspace default).                │
│                                                                        │
│  Exact error                                                           │
│  Run exceeded maxDuration of 1800s and was stopped.                    │
│                                                                        │
│              [ Raise the time limit ]      [ Open the Agent ]          │
│  ─────────────────────────────────────────────────────────────────────  │
│  COST (so far)                             $0.94 · 38 credits          │
│  …                                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

Copy: **"WHAT WENT WRONG"**; **"This run hit its time limit."**; **"It ran for {duration}, which
is the limit currently in force for the {agent} agent ({source})."** where `{source}` is
**"inherited from the workspace default"** or **"set on this Agent"**; **"Exact error"**;
**"Raise the time limit"**; **"Open the Agent"**; **"COST (so far)"**.

### 6.10 The "Raise the time limit" confirmation

```
┌────────────────────────────────────────────────────────┐
│  Raise the time limit for Research?                    │
│                                                        │
│  Now      30 minutes  (workspace default)              │
│  After    60 minutes  (set on this Agent)              │
│                                                        │
│  This applies to future runs of this Agent only. It    │
│  does not re-run anything and does not change any      │
│  other Agent.                                          │
│                                                        │
│                     [ Cancel ]   [ Raise to 60 minutes]│
└────────────────────────────────────────────────────────┘
```

Copy: **"Raise the time limit for {agent}?"**; **"Now"**; **"After"**; **"workspace default"**;
**"set on this Agent"**; body as shown; **"Cancel"**; **"Raise to {value}"**.
Success toast: **"{agent} can now run for up to {value}."**
No-op toast: **"{agent}'s time limit is already {value} — no change made."**
Ceiling state replaces the button with: **"This Agent is already at the maximum time limit of 4
hours. This run is doing too much for one execution — split the work into smaller Tasks."**
Denied state: button disabled, tooltip **"You need permission to change this Agent's settings."**

### 6.11 Cost detail aged out

```
│  COST                                        $0.31 · 12 credits        │
│  ─────────────────────────────────────────────────────────────────────  │
│  ⓘ Itemised usage for this run is older than 12 months and is no       │
│    longer retained. The settled total above is unchanged.              │
```

Copy: **"Itemised usage for this run is older than 12 months and is no longer retained. The
settled total above is unchanged."**

### 6.12 Over-limit export

```
┌────────────────────────────────────────────────────────┐
│  That is more than 50,000 runs.                        │
│  Narrow the window or the filters and try again.       │
│                                            [ Got it ]  │
└────────────────────────────────────────────────────────┘
```

Copy: **"That is more than 50,000 runs."**; **"Narrow the window or the filters and try
again."**; **"Got it"**. The 92-day variant reads **"Exports cover at most 92 days. Choose a
shorter window."**

### 6.13 Upcoming — empty

```
│  UPCOMING                                 │
│  ───────────────────────────────────────  │
│  Nothing scheduled in the next 7 days.    │
│  [ Set up a schedule ]                    │
```

Copy: **"Nothing scheduled in the next 7 days."**; **"Set up a schedule"**.

### 6.14 Keyboard shortcut sheet (`?`)

```
┌──────────────────────────────────────────────┐
│  Keyboard shortcuts                          │
│  ◀ / ▶        Previous / next window         │
│  t            Today                          │
│  d  w  m      Day / Week / Month             │
│  j  k         Next / previous run            │
│  Enter or o   Open the receipt               │
│  Esc          Close the receipt              │
│  /            Search                         │
│  f            Filters                        │
│  ?            This list                      │
└──────────────────────────────────────────────┘
```

### 6.15 Accessibility notes

- The list is a table with a caption naming the window and filters, so a screen reader announces
  *"Runs, Monday 8 September 2026, filtered by Agent: Ops, 41 rows"*.
- Outcome is conveyed by an icon **and** a text label, never by colour alone; the mini-calendar
  uses two distinct shapes for "has runs" and "has failures".
- Live-updating regions (elapsed timers, countdowns) are polite live regions and are paused when
  the tab is hidden.
- The receipt is a dialog with a labelled heading, focus trapped while open and returned to the
  originating row on close.
- Every shortcut has an equivalent on-screen control; nothing is keyboard-only.

---

## 7. Out of scope

- **Retiring or redirecting any existing surface.** The Sessions list, the per-Agent Activity
  tab, the session detail page, the terminal view and the Costs dashboard all stay exactly as
  they are. They gain links into Runs; they lose nothing.
- **Editing, retrying or re-running from Runs.** Cancel, steer, interrupt and resume already
  exist on the session surfaces and stay there. Runs is a reader plus one narrowly scoped
  remediation (the time limit).
- **Notifications on failure.** Alerting, digests and the attention budget belong to AW-13.
  Runs is a pull surface in this epic.
- **Managing schedules.** Creating, editing, pausing or deleting a Schedule belongs to AW-10.
  Runs only *reads* schedules for the Upcoming panel and the jump-to-definition control.
- **Spend caps and budgets.** Setting caps, credits top-up and the meters belong to AW-17. Runs
  displays what was spent and links to those surfaces.
- **Full raw tool payloads.** The receipt shows the redacted, size-capped previews the platform
  already captures. Storing complete request and response bodies is a separate decision with its
  own privacy and storage consequences — see §9.
- **Cross-user or admin-wide run views.** The existing platform-admin usage surface remains the
  only cross-account view.
- **A second "activity type" taxonomy.** Runs filters on the trigger the platform already
  records. It does not invent a parallel classification of what a run "was about".
- **Retention or deletion of Run records.** Runs neither prunes nor exposes deletion of runs.
- **Real-time push.** Live updates use the same polling model the rest of the dashboard uses.
  A push transport is a platform-wide decision, not this epic's.

---

## 8. Acceptance criteria

A reviewer can run this list against the merged change.

**Ledger**
- [ ] `/runs` exists in the dashboard navigation and lists runs for a selected window.
- [ ] Day / Week / Month all render, and the week starts on Monday.
- [ ] Default landing is Day / today in the profile timezone; the timezone is stated on screen.
- [ ] Granularity persists across visits; the window does not.
- [ ] Stepping back 13 months is clamped to 12 with a visible notice.
- [ ] Pagination returns 50 rows by default; a request for 500 is capped at 200.
- [ ] With a running run in view, the list refreshes within 5 s; with all runs terminal, no
      polling requests are issued.
- [ ] A refresh does not move the scroll position or close an open receipt.

**Navigation**
- [ ] `←`, `→`, `t`, `d`, `w`, `m`, `j`, `k`, `Enter`, `o`, `Esc`, `/`, `f`, `?` all behave per
      FR-11, and none of them fire while a text input has focus.
- [ ] The mini-calendar marks days with runs and days with failures using two different shapes.
- [ ] Copying the URL and opening it in a new session reproduces granularity, window, filters and
      the open receipt.

**Filters and rail**
- [ ] Filtering by Agent, trigger, outcome, Mission, Work and model each narrows the list.
- [ ] A one-character search is rejected; a 2-character search matches summaries and errors.
- [ ] The rail's numbers change when a filter is applied.
- [ ] Success rate is suppressed as "—" in a window with no terminal runs.
- [ ] Choosing the rail's error count applies outcome = failed without navigating away.
- [ ] An archived Agent still resolves its historical rows and is labelled archived.

**Receipt**
- [ ] Every block in FR-25 renders, in that order.
- [ ] A run with no summary shows the "no summary" copy, not an empty block.
- [ ] Skills used lists loaded, dropped and suppressed Skills distinctly, each linking to the Skill.
- [ ] Input / output / cached-read tokens render; a provider that reports no cache shows the
      "not reported" copy and never `0`.
- [ ] A multi-model run shows a per-model breakdown.
- [ ] Tool previews are redacted, capped at 4,096 characters, and marked when truncated.
- [ ] A run that hit the 200-entry capture cap shows the omission marker.
- [ ] A run with no Mission shows the "not part of a Mission" copy.
- [ ] A run older than 12 months shows the retention notice and still shows the settled total.
- [ ] A non-terminal run's cost and tokens are labelled "so far".

**Failures**
- [ ] Every failed run shows a classified reason from the closed set plus the exact error.
- [ ] "Raise the time limit" appears only for `timeout`.
- [ ] The confirmation shows the current effective limit and its source, and the proposed value.
- [ ] Confirming raises the limit for that Agent only, and an activity-log entry records it.
- [ ] A second confirmation after the first has applied reports "no change made".
- [ ] At 4 hours the shortcut is replaced by the split-the-work guidance.
- [ ] A viewer without Agent-edit permission sees the control disabled with the explanation.
- [ ] Two or more failures sharing a schedule in the window produce one grouped, dismissible banner.

**Upcoming**
- [ ] The panel lists the next fires within 7 days, capped at 50, ordered soonest first.
- [ ] Countdowns tick at least once per second and stop when the tab is hidden.
- [ ] Paused, disabled and ended schedules never appear.
- [ ] Choosing an entry lands on the schedule definition.
- [ ] With nothing scheduled, the empty copy renders with a create link.

**Export, scope, security**
- [ ] CSV export streams and matches the on-screen window and filters.
- [ ] A >50,000-row or >92-day export is refused before any bytes are produced.
- [ ] No request parameter can name another user, Organization or tenant.
- [ ] A foreign run id and a nonexistent run id produce identical responses.
- [ ] No secret-shaped value appears anywhere in a receipt, including inside an error message.

**Resilience and performance**
- [ ] The rail failing does not blank the list; the list failing does not blank the rail; the
      upcoming panel failing does not blank either.
- [ ] The list request meets the 800 ms P95 budget and the rail request the 400 ms budget at
      50 rows over a 30-day window with 10,000 runs.
- [ ] Every functional requirement above has at least one automated test.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: Should the receipt be able to show complete, unredacted tool request and
  response bodies behind an explicit per-Agent opt-in? Today only redacted 4,096-character
  previews are captured, which is sometimes too little to debug a tool. Storing full bodies means
  storing whatever a connected system returned — customer records included — so this needs a
  privacy decision and a retention rule before it is built, not after.]`
- `[NEEDS CLARIFICATION: Should Runs have its own retention policy? Run records are currently kept
  indefinitely while itemised usage detail is pruned at 12 months, so a 3-year-old run shows a
  total with no breakdown. Options: prune runs on the same 12-month clock, keep runs forever and
  document the asymmetry, or make retention a workspace setting.]`
- `[NEEDS CLARIFICATION: Should the per-Agent time limit ladder be 30 min / 60 min / 2 h / 4 h, and
  is 4 hours the right ceiling? Task-assigned executions already run under a 60-minute ceiling
  today while heartbeats run under 30 — should raising the limit be expressed per Agent, or per
  trigger kind within an Agent?]`
- `[NEEDS CLARIFICATION: Which run kinds should the trigger filter expose once agent email lands
  (AW-05)? Inbound-mail triage has no trigger value today. Adding one is trivial, but naming it
  before AW-05 fixes its semantics risks a label we then have to live with.]`
- `[NEEDS CLARIFICATION: Should a delegated sub-agent run appear as its own row, nested under its
  parent, or both? Sub-agent delegation exists and produces real runs; a flat list makes a
  three-deep delegation look like three unrelated executions.]`
- `[NEEDS CLARIFICATION: Should the Upcoming panel offer "skip this fire" or "run it now"? Both
  are one call away from existing endpoints, but they are schedule *controls* and AW-10 owns
  schedule controls. Confirm the split with Product.]`
- `[NEEDS CLARIFICATION: When a viewer's timezone differs from the timezone a schedule is
  expressed in, should the Upcoming countdown show both? A schedule that fires "every day at
  09:00" in one timezone is confusing to a viewer in another.]`
- `[NEEDS CLARIFICATION: Should the grouped repeat-failure banner threshold of 2 be workspace-
  configurable? Two is deliberate — a second failure from one schedule is evidence about the
  schedule — but a very high-frequency heartbeat may trip it constantly.]`

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No new external integration. Token and cache figures are read from the
      existing provider abstraction, never from a named provider.
- [x] **II — Capability-driven.** No plugin id appears outside a plugin package. Model and
      capability labels on the receipt come from recorded usage data, not from a hardcoded list.
- [x] **III — Source-of-truth repos.** Untouched. Runs reads execution telemetry, which has always
      been platform data, never work content.
- [x] **IV — Job runtime.** No new background job is introduced. The one background behaviour this
      epic extends — classifying reaped stale runs as timeouts — happens inside the existing
      scheduled sweeper, which already runs through the configured job-runtime provider.
- [x] **V — Forward-only migrations.** Two additive migrations, all columns nullable, no backfill
      required, no destructive step. Detailed in [plan.md §3](./plan.md#3-data-model).
- [x] **VI — Tests.** Unit tests for the window/aggregate/classification logic, controller specs
      for every new endpoint, and end-to-end coverage of the ledger, the receipt and the
      remediation flow.
- [x] **VII — Secrets.** The receipt renders only already-redacted previews and re-applies
      redaction to error text at render time. No new secret-bearing field is introduced.
- [x] **VIII — Plugin counts.** No plugin added or removed; the canonical list is untouched.
- [x] **IX — Behaviour-first.** This document contains no class name, file path or code.
- [x] **X — Backwards compatibility.** All schema and contract changes are additive. Every existing
      endpoint keeps its current shape; new fields are optional.

---

## 11. References

- Program: [Agent Workspace README](../README.md) · [TRACKER](../TRACKER.md)
- Implementation plan: [plan.md](./plan.md) · Tasks: [tasks.md](./tasks.md)
- Depends on this epic: AW-10 (Schedules & calendar), AW-17 (Costs & caps)
- Adjacent existing specs: [`schedules/`](../../schedules/) (the schedule projection this epic
  reads), [`agents/`](../../agents/) (Runs, sessions, steering),
  [`billing/`](../../billing/) (cost settlement and credits),
  [`activity-log/`](../../activity-log/) (the audit trail Runs deliberately does not duplicate)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
