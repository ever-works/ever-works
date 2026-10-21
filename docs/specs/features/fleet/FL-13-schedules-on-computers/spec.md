# FL-13 — Schedules on computers

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-13-schedules-on-computers`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-13-schedules-on-computers`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-04 (Agent sessions), FL-12 (Commands) · **Related:** FL-01 (hub, computer page, "needs a look"), FL-02 (node link), FL-03 (health), FL-14 (checkouts as folders), FL-19 (tools, CLI), FL-20 (cost), AW-10 (Schedules workspace)
**Extends (existing Ever Works nouns):** Schedule (unified Schedules read model, AW-10) · Command (FL-12) · Task (recurring) · Agent · Run · Session · Node (UI: "Computer") · Needs a look · Inbox · Fleet audit

---

## 0. TL;DR

A **Schedule on a computer** is one of two existing things told _where_ to run: a **Command with
a cadence** (a command line, a computer, a time) or a **recurring Task pinned to a computer** (an
Agent, a prompt, a folder, a time — each fire is an Agent session on that machine). Both appear in
the one Schedules view the product already has, as a new source, `node_schedule`, beside the seven
sources that exist today; both also appear on the computer's own Schedules tab. Command schedules
are **cached on the machine** and run by the node itself on its own clock, so a laptop whose node
is installed as a service runs them whether or not the platform is reachable, and reports the
runs when it is. Times are the computer's own; the view shows both the computer's and yours.

```
 COMPUTER › build-01 › Schedules                                            [FLEET_COMMANDS_ENABLED]
 ──────────────────────────────────────────────────────────────────────────────────────────────────
 build-01 keeps time in Europe/Paris · you are in America/New_York          [+ New schedule] [Pause all]
 ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ● Nightly tests          pnpm test                 weekdays 02:00 (20:00 yours)  last ✓ 6 h ago  ⋯ │
 │ ● Pull all checkouts     git pull --ff-only …      every 30 min                 last ✓ 12 min   ⋯ │
 │ ◐ Triage new issues      Nina · "Triage issues…"   daily 08:30 (02:30 yours)    running 4 min   ⋯ │
 │ ⏸ Rebuild docs           pnpm docs:build           daily 03:00                  paused by you   ⋯ │
 │ ⚠ Disk report            df -h | mail …            hourly               NEVER RUNS · needs --manage │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⋯ = Run now · Pause/Resume · Edit · Duplicate · Move to another computer · Delete
 Runs of "Nightly tests" (newest first, last 30 kept on build-01)
   ✓ Tue 02:00 · 14 m 02 s · exit 0        ✗ Mon 02:00 · 3 m 11 s · exit 1  [output]     ⊘ Sun 02:00 skipped — overlap
```

| Phase  | Ships                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Command schedules: `node_schedule` source, dialog, node-side cache and timer loop, overlap/cap/history, Run now/Pause/Resume/Delete, computer Schedules tab, Activity → Schedules rows, audit, "needs a look" producer, CLI |
| **P2** | Agent-session schedules (recurring Task pinned to a computer), unattended-credential note, cost attribution, NEVER RUNS reasons and repairs, circuit breaker scope "this computer", Agent tools                             |
| **P3** | Per-OS native-scheduler fallback for nodes not installed as a service; missed-run grace and failure-threshold editors only if CONTRACTS §6 makes them per schedule (§8b)                                                    |

---

## 1. Overview

Ever Works already has one place for everything that will happen on a timer — Activity →
Schedules — with health verdicts, a circuit breaker and row controls, over seven sources. None of
those sources can name a machine. This epic adds the eighth, `node_schedule`, and gives it two
backings that already exist as nouns: a **Command** (FL-12) that carries a **cadence**, and a
**recurring Task** whose Agent is pinned to a computer. Nothing new is stored for the view itself
(R-2): the view reads Commands and Tasks.

What is genuinely new is _where the clock ticks_. For a Command schedule the definition is synced
to the computer and the node runs it from its own timer, inside the node service, with the
machine owner's login shell, one run at a time, capped at six hours, keeping the last thirty runs'
full output on the machine and sending the first and last 64 KiB back when the link is up. A
machine that was asleep at fire time runs a missed fire once if it wakes within the grace window,
otherwise records it as skipped. For an Agent-session schedule the platform's recurring-Task
dispatcher fires as it does today, and the resulting Run executes as an **Agent session** on the
pinned computer (FL-04) — visible on that computer's Sessions tab while it runs — using the
sign-in or API key the machine owner configured on that machine; the platform stores no credential
(README D6) and tells the user so in exactly those words.

Everything the Schedules view already does applies unchanged: NEVER RUNS with a previewed repair,
Disable all with undo, Run now / Pause / Resume, filters and health counts. This epic adds the
reasons a machine can introduce (consent missing, computer removed, node too old), a third breaker
scope (one computer), a run-history drawer, and a "needs a look" producer for schedules that fail.

---

## 2. Why now

### 2.1 The user's question

> _"Run the tests there every night and tell me only if they fail."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                               | Today they must…                                                                          | What breaks                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Schedule something on that machine."    | Edit the machine's crontab, launchd or Task Scheduler by hand.                            | The unified Schedules read model has exactly seven sources (`packages/agent/src/schedules/schedule-view.types.ts:17-24`; `schedules.service.ts:85-93`) and no field names a computer; the schedules spec declares a new source type out of scope (`docs/specs/features/schedules/spec.md:355`).                          |
| "Have Nina do it there every morning."   | Make a recurring Task and hope the Agent's affinity sends it to the right machine.        | A recurring Task fires through the Task recurrence dispatcher (`packages/agent/src/entities/task.entity.ts:24-25`) and lands on a machine only indirectly, via Agent affinity (`packages/agent/src/fleet/fleet-agent-node-affinity.service.ts:22-25`), which is Organization-scoped and never shown on the schedule row. |
| "Did it run while my laptop was closed?" | Nothing — the platform's cron fires; if the machine is offline the job waits or ages out. | No definition lives on a machine; the node has no scheduler or schedule cache (EXISTING-SUBSTRATE §4: `rg -n -w 'cron\|crontab\|RRULE\|cronExpression' apps/node/src` → no match); every run depends on the platform being reachable at fire time.                                                                       |
| "Why did it stop running?"               | Read the Agent's error count, or notice the machine is off.                               | NEVER RUNS knows seven reasons (`schedule-view.types.ts:116-123`), none about a machine; "needs a look" has a `schedule-failed` kind reserved (CONTRACTS §4.6) with no producer.                                                                                                                                         |

### 2.3 Why this epic is additive only

The Schedules read model gains one union member and the row controls gain one source; no existing
source changes shape. Commands gain a cadence they were built to carry (FL-12 FR-8). Recurring
Tasks keep their source type and gain a computer chip. The circuit breaker gains a scope. Nothing
is removed; "Schedule" stays the only noun — never "cron job" or "automation" (README §1).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Nightly tests on one computer.**
  **Given** `build-01` is online with `--manage` and the owner is on its Schedules tab,
  **when** they click **New schedule**, name it _Nightly tests_, choose **A command** `pnpm test`,
  folder `~/code/api`, **When** _weekdays at 02:00_, and save,
  **then** the row appears with _"weekdays 02:00 (20:00 yours)"_, the dialog's confirm named the
  shell and user, the definition is on `build-01` within 5 seconds (_"synced to build-01"_ chip),
  an audit row `node.schedule.create` exists, and the same row appears in Activity → Schedules
  with the source chip **Computer** and the computer's name.

- **S2 — It runs with the platform away.**
  **Given** the schedule from S1 and the platform unreachable from `build-01` at 02:00,
  **when** 02:00 passes on the machine,
  **then** the node runs `pnpm test` from its own timer, keeps the full output on the machine, and
  when the link returns the run appears in the history with its real start time, duration, exit
  code and the stored head and tail.

- **S3 — Every morning, an Agent.**
  **Given** Agent `Nina` is pinned to `build-01` and the owner is on its Schedules tab,
  **when** they choose **An Agent session**, pick Nina, type the prompt _"Triage the new issues in
  acme/api and label them"_, choose the checkout `~/code/api`, **When** _daily at 08:30_, and save,
  **then** a recurring Task owned by Nina is created, the row reads _"Nina · daily 08:30"_ with a
  **build-01** chip, the dialog body carried the unattended-credential sentence verbatim (FR-26),
  and at 08:30 a Run starts as an Agent session on `build-01`, visible on its Sessions tab and on
  the Activity → Sessions board while it runs.

- **S4 — Run now.**
  **Given** a Command schedule,
  **when** the owner clicks **Run now** and confirms,
  **then** a run starts within 2 seconds, the row reads _"running"_ with a live elapsed counter,
  the next scheduled fire is unchanged, and an audit row `node.schedule.run` is written.

- **S5 — Pause and resume.**
  **Given** an active schedule,
  **when** the owner pauses it,
  **then** the node stops firing it within 5 seconds, the row reads _"paused by you · 2 min ago"_
  with its cadence preserved, resume restores the next fire computed from now, and both acts are
  audited.

- **S6 — The history explains itself.**
  **Given** a schedule with runs,
  **when** the owner opens its history,
  **then** the last 30 runs are listed newest first with outcome glyph, scheduled time, actual
  start, duration and exit status; a skipped run says why (_"skipped — the previous run was still
  going"_, _"skipped — build-01 was asleep past the grace window"_); an Agent-session run links to
  its Run receipt and its session; **output** opens the stored head and tail with **Open full
  output** when the machine is online.

- **S7 — Told only when it fails.**
  **Given** _Nightly tests_ fails on two consecutive fires,
  **when** the owner opens the Fleet hub,
  **then** **Needs a look** carries _"Nightly tests failed twice on build-01"_ with **Open** and an
  Inbox item exists; a passing run clears both.

- **S8 — From the CLI.**
  **Given** the owner is signed in to the CLI,
  **when** they run `ever-works fleet schedules create --on build-01 --name "Pull all" --every 30m --command "git pull --ff-only"`,
  **then** the schedule is created, printed as a row, and `--json` returns the same shape the web
  uses; `fleet schedules list --on build-01`, `run <id>`, `pause <id>`, `resume <id>`, `runs <id>`
  and `delete <id>` all exist.

### 3.2 Edge cases and failures

- **U1 — Computer offline at save.** The schedule saves; the row carries _"will sync when build-01
  is back"_; the node receives it on the next link open; nothing fires until then.
- **U2 — Consent missing.** A schedule on a computer without `--manage` saves but is flagged
  **NEVER RUNS · needs --manage** with the exact command to run; the repair class is _none_ (only
  the machine owner can act) and the hub lists it under Needs a look as `consent-missing`.
- **U3 — Overlap.** A fire arriving while the previous run is still going is recorded as
  `skipped-overlap` and never runs twice in parallel.
- **U4 — Six hours.** A run reaching 6 h is terminated on the machine and recorded `timeout` with
  its tail; the schedule stays active.
- **U5 — Asleep at fire time.** A fire missed while the machine slept runs once if the machine
  wakes within 60 minutes of it (CONTRACTS §6), otherwise it is recorded `skipped-offline`; two
  missed fires never produce two catch-up runs.
- **U6 — Failure streak.** Five consecutive failures (CONTRACTS §6) pause the schedule with reason
  _"paused after 5 failures in a row"_, an Inbox item, and a Needs-a-look item; resume is one
  click and clears the streak.
- **U7 — Kill switch.** New schedules cannot be created, Run now is refused with `kill_switch`,
  the node stops its timer loop within 10 seconds and terminates in-flight runs (`failed`, reason
  `kill-switch`); clearing the switch resumes the loop without re-running missed fires older than
  the grace window.
- **U8 — Permission denied.** An Organization member outside the computer's `schedules` audience
  sees the tab read-only with _"the owner of build-01 allows only the owner to manage schedules"_
  and is refused server-side with `permission_denied`.
- **U9 — Agent not pinned.** Choosing an Agent that is not pinned to this computer shows _"Nina is
  not pinned to build-01 — pin her on her Capabilities tab, or choose a pinned Agent"_ with a
  link; the dialog never pins an Agent as a side effect.
- **U10 — Agent-session schedule, machine offline at fire.** The Run waits in the queue for the
  grace window; past it the Run and its Task instance are cancelled with the reason _"build-01 was
  offline past the grace window"_, and the history shows the fire as skipped — offline.
- **U11 — Node too old.** A node that does not understand `schedule.sync` leaves the schedule
  flagged **NEVER RUNS · update the node on build-01**.
- **U12 — Link drops mid-run.** The node finishes the run on its own and reconciles it on
  reconnect; the row shows _"running — last heard 3 min ago"_ meanwhile.
- **U13 — Delete with history.** Deleting a schedule confirms with its name and run count, stops
  it on the machine, keeps its run history readable for 30 days under the computer's Schedules
  tab (_"deleted"_ section), and removes the machine's cached definition.
- **U14 — Circuit breaker.** _Pause all_ on the computer page pauses every schedule on that
  computer (both kinds), states the count and in-flight runs, offers Undo for 15 minutes, and
  never deletes.
- **U15 — Time zone changes.** When the computer reports a new time zone, rows re-render both
  times and a one-line note says _"build-01 moved to Europe/London"_; fire times stay the
  computer's wall-clock times.
- **U16 — Computer removed.** Removing a computer flags its schedules **NEVER RUNS · computer
  removed** with the repair _Move to another computer_ (class _choice_).

---

## 4. Functional requirements

### 4.1 The source (P1)

- **FR-1** The Schedules view MUST offer a source `node_schedule` whose rows are Commands that
  carry a cadence; its row id MUST be `node_schedule:<commandId>`.
- **FR-2** A recurring Task whose Agent is pinned to a computer MUST keep its `recurring_task`
  source and MUST carry a computer chip naming that computer.
- **FR-3** Every `node_schedule` row MUST show the cadence in the computer's time zone and the
  viewer's, the next fire, the last run's outcome and when it ran, the normalised status, health
  and controls — the same thirteen required fields every other source shows.
- **FR-4** The flat list, the paged workspace list, the health summary and the per-source counts
  MUST include `node_schedule` rows without changing the shape of any other row.

### 4.2 The definition (P1 commands, P2 Agent sessions)

- **FR-5** A schedule MUST have a name (1–80 characters), one computer, one of two bodies — a
  command line (≤ 8 KiB) or an Agent with a prompt (≤ 4 KiB) (the three bounds proposed for
  CONTRACTS §10, §8b) — a folder (default: the machine owner's home for commands; a checkout for
  Agent sessions), and a cadence. A computer MUST hold at most 50 schedules (CONTRACTS §10); a
  51st MUST be refused `limit_exceeded`.
- **FR-6** The cadence MUST be one of: every N minutes (1–59), hourly, daily at HH:MM, weekdays at
  HH:MM, specific weekdays at HH:MM, or a 5-field cron expression; it MUST be interpreted in the
  computer's time zone.
- **FR-7** A Command schedule MUST run in the machine owner's login shell as that user with no
  stdin, exactly as a one-off Command does.
- **FR-8** An Agent-session schedule MUST be stored as a recurring Task assigned to the Agent, and
  each fire MUST execute as an Agent session on the pinned computer.
- **FR-9** Saving a schedule MUST require the `schedules` family audience on the computer and the
  `manage` consent for a Command schedule or the `work` consent for an Agent-session schedule; a
  missing consent MUST still save the definition and MUST flag it NEVER RUNS with the consent
  named.
- **FR-10** A schedule MUST be editable in every field except its kind (command ↔ Agent session),
  and MUST be movable to another computer.

### 4.3 Running on the machine (P1)

- **FR-11** Command-schedule definitions MUST be synced to the computer over the node link on
  every change and on every link open; the computer MUST hold the platform's set exactly.
- **FR-12** The node MUST fire Command schedules from its own timer loop inside the node service,
  without the platform being reachable and without depending on cron, launchd or Task Scheduler.
- **FR-13** At most one run per schedule MAY be in flight; an overlapping fire MUST be recorded
  `skipped-overlap`.
- **FR-14** A run MUST be terminated at **6 hours** and recorded `timeout`.
- **FR-15** The node MUST keep the full output of the last **30** runs per schedule and MUST report
  each run's first and last 64 KiB, exit code, start and end to the platform when the link is up,
  reconciling any run that completed while the link was down.
- **FR-16** A fire missed while the node was not running MUST run once if the node starts within
  the 60-minute grace window (CONTRACTS §6) and MUST otherwise be recorded `skipped-offline`;
  several missed fires MUST produce at most one catch-up run.
- **FR-17** When the kill switch is on the node MUST stop firing within 10 seconds and MUST end
  in-flight runs as `failed` with reason `kill-switch`; when it clears, the loop MUST resume without replaying fires older than the grace
  window.

### 4.4 Controls, history, safety (P1 / P2)

- **FR-18** Every row MUST offer **Run now**, **Pause**, **Resume**, **Edit**, **Duplicate**,
  **Move to another computer** and **Delete**, each disabled with a reason when it does not apply.
- **FR-19** **Run now** MUST start within 2 seconds on an online computer, MUST be refused `busy`
  while a run is in flight, and MUST NOT change the next scheduled fire.
- **FR-20** The history MUST list the last 30 runs newest first with scheduled time, actual start,
  duration, exit status or skip reason, and MUST link an Agent-session run to its Run and session.
- **FR-21** NEVER RUNS MUST gain the reasons `consent-missing` (repair _none_, hint names the
  command), `node-removed` (repair _choice_: move), `node-unsupported` (repair _none_, hint names
  the update); existing reasons MUST keep their classes.
- **FR-22** The circuit breaker MUST gain a scope **one computer** that pauses every schedule on
  it, with the same confirmation, 500 cap, undo window and audit as the existing scopes.
- **FR-23** Five consecutive failed runs (CONTRACTS §6) MUST pause the schedule with reason
  `failure-streak`, write an Inbox item, and raise a Needs-a-look item; a successful run MUST
  reset the streak.
- **FR-24** The Needs-a-look producer `schedule-failed` MUST raise one item per schedule after two
  consecutive failures or one `skipped-offline` beyond the grace window, severity `warn`, with an
  action that opens the schedule, and MUST clear on the next successful run.

### 4.5 Permission, confirmation, audit (P1)

- **FR-25** Create, Run now, Move and Delete MUST use the `confirm` class naming the computer,
  the body, the shell or Agent, and — for a Command — _"These are real machines, not a sandbox."_;
  Pause and Resume MUST be `plain`.
- **FR-26** The Agent-session dialog MUST carry, in its body, the sentence: _"Runs happen on
  {computer} using the Claude Code or Codex sign-in — or the API key — that is set up on that
  computer. Ever Works keeps no copy of it. If that sign-in expires, the next run fails and this
  schedule appears under Needs a look until someone signs in on {computer} again."_
- **FR-27** Every change MUST write one audit row — `node.schedule.create|update|delete|run|pause|resume` —
  with `family: schedules`, `target: <commandId or taskId>`, `requestedBy` and the confirmation
  class; every run the node executes MUST write `node.command.run` with `requestedBy:
schedule:<commandId>` when reconciled.
- **FR-28** Every refusal MUST carry a CONTRACTS §8 code and hint: `unreachable` (Run now),
  `consent_missing`, `permission_denied`, `invalid` (cadence), `busy`, `kill_switch`,
  `unsupported_on_node`, `confirmation_required`, `limit_exceeded` (the 51st schedule).

### 4.6 Cost (P2)

- **FR-29** A Command schedule MUST state that it spends no model tokens or credits.
- **FR-30** An Agent-session schedule MUST show, on its row and in its history, the cost of each
  Run and the last 30 days' total, attributed through the session's provider session id (R-13);
  unknown models MUST show tokens only.

### 4.7 Agent, MCP, CLI (P1 CLI, P2 tools)

- **FR-31** The CLI MUST offer `ever-works fleet schedules create|list|get|run|pause|resume|update|delete|runs`
  with `--json`, exit `0/1/2`.
- **FR-32** Agent tools `fleet_schedules_create|update|delete|run` MUST be annotated destructive
  with `confirmationClass: confirm`, `fleet_schedules_pause|resume` MUST be `destructive: false`
  with `confirmationClass: plain` (FR-25), all gated by the Agent's grants and ladder and the
  computer's `schedules` audience; `fleet_schedules_list|get|runs` MUST be read-only.

---

## 5. UX

### 5.1 Computer page › Schedules tab — loaded

Shown in §0. Header line names both time zones. Rows: glyph (● active, ◐ running, ⏸ paused, ⚠
never runs), name, body summary, cadence (computer time, viewer time in parentheses when they
differ), last outcome, `⋯`. Selecting a row expands its history inline.

### 5.2 New schedule dialog

```
┌ New schedule on build-01 ───────────────────────────────────────────────────────┐
│ Name       [ Nightly tests                                     ]                │
│ Computer   [ build-01 ▾ ]   keeps time in Europe/Paris                          │
│ Runs       (•) A command   ( ) An Agent session                                 │
│            [ pnpm test                                          ]               │
│            Folder [ ~/code/api ▾ ]  (home · a checkout · a path)                │
│ When       [ Weekdays ▾ ] at [ 02:00 ]  → next: Mon 02:00 Paris (Sun 20:00 yours) │
│ Runs as the machine owner in their login shell. No input is possible.           │
│ ⚠ These are real machines, not a sandbox.                                       │
│                                                          [ Cancel ] [ Create ]  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Agent-session variant replaces the command field with **Agent** (only Agents pinned to this
computer; others listed disabled with the U9 reason), **Prompt**, **Folder** (checkouts on this
computer, FL-14), and shows the FR-26 sentence in the body plus _"Each run appears in Runs with its
cost like any other run."_ **When** offers: every N minutes · hourly · daily · weekdays · specific
days (Mon–Sun chips) · cron (advanced). The next three fires are previewed in both zones.

### 5.3 States

- **Empty:** _"Nothing is scheduled on build-01"_ with **New schedule** and a one-line example.
- **Loading:** three skeleton rows.
- **Unavailable with reason:** no `--manage` → tab shows the rows read-only with the banner _"Schedules need management switched on — run `ever-works-node start --manage` on build-01"_; `apps/desktop-node` kind → _"not available on this kind of node yet"_ (R-10); flag off → tab hidden.
- **Error:** inline row error with code and hint; a failed sync shows a retry.
- **Kill switch:** FL-01's banner; controls disabled.

### 5.4 Activity → Schedules

Source chips gain **Computer**; rows carry the computer name; the filter bar gains **Computer**
(`?node=<id>`); the create menu gains **On a computer…** (opens §5.2 with the computer picker
first). Health banner counts include the new reasons. The breaker dialog offers the new scope when
opened from a computer page.

### 5.5 Hub

The hub Commands tab (FL-12) gains **Schedule this…** on the composer, opening §5.2 pre-filled.
The hub Overview's Needs a look renders `schedule-failed` items (R-23).

### 5.6 Keyboard and palette

`N` new schedule on the tab; `R` run now on the focused row; `P` pause/resume; `Enter` expands
history; `Del` delete (opens confirm). Palette: _"New schedule on…"_, _"Schedules on <computer>"_.

### 5.7 Exact copy that carries meaning

`Synced to {computer}` · `Will sync when {computer} is back` · `Skipped — the previous run was
still going` · `Skipped — {computer} was asleep past the grace window` · `Paused after {n}
failures in a row` · `{name} failed twice on {computer}` · `NEVER RUNS · needs --manage` · `NEVER
RUNS · computer removed` · `NEVER RUNS · update the node on {computer}` · `{computer} keeps time in
{zone} · you are in {zone}` · the FR-26 sentence.

---

## 6. Non-functional requirements

- **Performance:** a timer fire starts its process within 1 s of the scheduled second on the
  machine; sync of a changed definition reaches an online node within 5 s; the Schedules list adds
  ≤ 50 ms p95 for the new source.
- **Reliability:** a node restart loses no definition (they are on disk) and no completed run
  (history is on disk); reconciliation is idempotent by run id.
- **Security & privacy:** no stdin; owner shell only; output redacted before storage; the platform
  holds no model credential; definitions on disk are owner-only files.
- **Observability:** audit per change and per run; metrics for fires, skips, timeouts, failure
  streaks, sync lag; activity-log events `schedule_created|paused|resumed|deleted`.
- **Compatibility:** older nodes refuse `schedule.sync` → `unsupported_on_node`; older clients
  ignore the extra union member (string).

---

## 7. Key entities & concepts

| Entity / concept               | New?                                           | Description                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schedule** (`node_schedule`) | Extended                                       | The unified read model gains one source; a row is a Command with a cadence.                                                                                                                 |
| **Command** (with cadence)     | FL-12                                          | Gains a cadence, a name and an enabled state (CONTRACTS §4.4), plus the pause reason, sync generation and soft delete proposed in §8b; its times are the computer's (`FleetNode.timeZone`). |
| **Command run**                | FL-12                                          | Uses the skip statuses `skipped-overlap`, `skipped-offline` (CONTRACTS §4.4) and gains the scheduled fire time proposed in §8b.                                                             |
| **Recurring Task**             | Existing                                       | Pinned to a computer through its Agent's affinity; gains a computer chip in the view.                                                                                                       |
| **Agent session**              | FL-04                                          | What one fire of an Agent-session schedule becomes on the machine.                                                                                                                          |
| **Needs a look** item          | FL-01/03                                       | `schedule-failed` producer.                                                                                                                                                                 |
| **Node-side definition cache** | **NEW** (machine-local, not a platform entity) | The machine's copy of its Command schedules and their run history.                                                                                                                          |

---

## 8. Out of scope

- A calendar for node schedules beyond what AW-10's calendar already renders for every source.
- Dependency graphs, retries with backoff, or chaining schedules.
- Running a schedule as another user or with elevation.
- Node-side execution of Agent-session schedules while the platform is unreachable (they need the
  platform to create the Run; CONTRACTS R-29).

## 8b. Open questions

- **Resolved** by CONTRACTS §4.1 / §1.1 and §13: the heartbeat carries `timeZone` (IANA) and
  `FleetNode.timeZone` is added in FL-13's slot 01, `1796130100000-AddFleetNodeTimeZone`.
- **Resolved** by CONTRACTS R-29: scheduled Agent work is a recurring Task pinned through Agent
  node affinity; there is no per-Task node column, and the dialog refuses unpinned Agents (U9).
- `[NEEDS CLARIFICATION: Agent-session schedules on a personal (non-Organization) scope cannot be
pinned because affinity requires an Organization. Accept, or allow owner-scope affinity? Default
until answered: accept — only Organization-scoped Agents with a node affinity are offered; a
personal-scope Agent is listed disabled with "pinning needs an Organization".]`
- `[NEEDS CLARIFICATION: Should a Command schedule keep running while the kill switch is on but
the platform is unreachable (the node cannot learn the switch flipped)? Default until answered:
the node keeps the last kill-switch state it was told, keeps firing while it has heard nothing
new, and stops within 10 s of the next `link.pause` it receives on reconnect.]`
- **Resolved** by CONTRACTS §10: at most 50 schedules per computer (FR-5).
- **Resolved** by CONTRACTS rev 5: schedule-state columns `pausedAt`, `pausedReason`, `syncGeneration`, `syncedGeneration`, `deletedAt` and `runs.scheduledFor` in FL-13 slot 00, cadence columns in FL-12's table (§4.4); `schedule.sync { generation }` (§3.3); name/command/prompt bounds (§10); 30 writes per minute (§10.1); `/nodes/:id/schedules/agent-session` (§11.2). Grace and failure threshold stay fixed (§6).

---

## 9. Acceptance criteria

- [ ] **ACC-FL13-01** (FR-1, FR-3, FR-4) A Command with a cadence appears in `GET /api/schedules`, the paged list and health counts as `node_schedule:<id>` with all thirteen fields; no other row changed.
- [ ] **ACC-FL13-02** (FR-2) A recurring Task of a pinned Agent carries the computer chip and keeps `recurring_task`.
- [ ] **ACC-FL13-03** (FR-5, FR-6, S1) Each of the six cadence forms saves and previews the next three fires in both zones.
- [ ] **ACC-FL13-04** (FR-11, FR-12, S2) With the API stopped, a `weekdays 02:00` schedule fires on the node's clock; on reconnect the run is reconciled with the real start time.
- [ ] **ACC-FL13-05** (FR-13, U3) A 10-minute command on a 5-minute cadence yields alternating `done` and `skipped-overlap`.
- [ ] **ACC-FL13-06** (FR-14, U4) A `sleep 7h` is ended at 6 h as `timeout` with its tail.
- [ ] **ACC-FL13-07** (FR-15) After 31 runs the node holds 30 output files; every reconciled run has head and tail ≤ 64 KiB.
- [ ] **ACC-FL13-08** (FR-16, U5) A node stopped across two fires and restarted within the grace runs exactly once; restarted after it records `skipped-offline`.
- [ ] **ACC-FL13-09** (FR-17, U7) Kill switch on: the loop stops within 10 s and an in-flight run ends `failed` with reason `kill-switch`; clearing resumes without replaying old fires.
- [ ] **ACC-FL13-10** (FR-18, FR-19, S4, S5) Run now, Pause, Resume, Edit, Duplicate, Move, Delete behave as specified; Run now during a run is `busy`.
- [ ] **ACC-FL13-11** (FR-20, S6) History lists 30 runs with the required columns and the skip reasons verbatim.
- [ ] **ACC-FL13-12** (FR-21, U2, U11, U16) The three new NEVER RUNS reasons render with their repair class and hint; existing reasons unchanged.
- [ ] **ACC-FL13-13** (FR-22, U14) Pause all on a computer pauses only that computer's schedules, offers undo for 15 min, never deletes.
- [ ] **ACC-FL13-14** (FR-23, FR-24, S7, U6) Two failures raise the Needs-a-look item and Inbox item; five pause the schedule; a success clears both.
- [ ] **ACC-FL13-15** (FR-25, FR-26, S3) The confirm dialogs carry the sandbox sentence; the Agent-session dialog carries the credential sentence verbatim.
- [ ] **ACC-FL13-16** (FR-27) Every change writes its audit row; reconciled runs carry `requestedBy: schedule:<commandId>`.
- [ ] **ACC-FL13-17** (FR-5, FR-28, U1, U8, U9) Each refusal code and hint is produced by a test, including `limit_exceeded` for a 51st schedule on one computer; saving on an offline computer succeeds and shows the sync-pending chip.
- [ ] **ACC-FL13-18** (FR-8, FR-30, S3) An Agent-session fire creates a Task instance and a Run executed as an Agent session on the pinned computer, and the row shows the Run's cost.
- [ ] **ACC-FL13-19** (FR-31, S8) The CLI verbs exist with `--json` and exit codes.
- [ ] **ACC-FL13-20** (FR-32) Agent tools are refused outside the audience and run with `requestedBy: agent:<id>`.
- [ ] **ACC-FL13-21** Every string is an i18n key under `fleet.schedules.*`; the unattended-credential sentence is one key.
- [ ] **ACC-FL13-22** (FR-7) A Command schedule runs in the machine owner's login shell from the chosen folder with stdin closed, exactly as a one-off Command (FL-12 ACC-FL12-02).
- [ ] **ACC-FL13-23** (FR-9) Saving needs the `schedules` audience; on a computer without the needed consent the definition saves and shows NEVER RUNS with the consent named.
- [ ] **ACC-FL13-24** (FR-10) Every field but the kind is editable; Move re-syncs the definition to the new computer and removes it from the old one.
- [ ] **ACC-FL13-25** (FR-29) A Command schedule's row and dialog state that it spends no model tokens or credits.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration; the OS scheduler fallback (P3) is a node module. Not applicable.
- [x] **II — Capability-driven.** No provider named.
- [x] **III — Source-of-truth repos.** Definitions are metadata; outputs are bounded artefacts.
- [x] **IV — Job runtime.** Agent-session fires ride the existing recurring-Task dispatcher task; Command schedules run on the machine by contract (CONTRACTS §6), not in the API process.
- [x] **V — Forward-only migrations.** Two additive migrations in FL-13's slots, `1796130000000-AddFleetCommandCadence` and `1796130100000-AddFleetNodeTimeZone`.
- [x] **VI — Tests.** Named per package in the plan and tasks.
- [x] **VII — Secrets.** The platform stores no model credential (D6); outputs and audit are redacted.
- [x] **VIII — Plugin counts.** Not applicable.
- [x] **IX — Behaviour-first.** No code here.
- [x] **X — Backwards compatibility.** Union members added; no row shape changed.

---

## 11. References

- Program: [Fleet README](../README.md) D6, D12, §1 · [CONTRACTS](../CONTRACTS.md) R-2, R-11, R-13, R-23, R-24, R-29, R-39, R-40; §1.1; §2; §3.2 link controls; §3.3 `schedule`; §4.1; §4.4; §4.6; §6; §7; §8; §10; §13 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) E
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related: [FL-12 Commands](../FL-12-commands/spec.md), [FL-04 Sessions](../FL-04-sessions-on-computers/), [AW-10 Schedules workspace](../../agent-workspace/AW-10-schedules-calendar/spec.md) §4.6–4.7, [Schedules read model spec](../../schedules/spec.md)
- Constitution: `.specify/memory/constitution.md`
