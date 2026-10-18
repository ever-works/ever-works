# FL-05 — Session status, attention & board: hooks, states, Needs you, Activity → Sessions

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code except where §2 cites what exists today. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-05-session-status-board`
**Program:** [Fleet](../README.md) · Wave 1 (the flagship, second half)
**Branch:** `feat/fl-05-session-status-board`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-04 (sessions, daemon, detail page) · **Related:** FL-01 ("needs a look" registry, hub Sessions tab, palette), FL-06 (git line on the card), FL-15 (Task link on the card), FL-20 (cost chip), AW-03 (My Decisions), AW-09 (Runs ledger — the Sessions view sits beside it), AW-13 (attention controls), AW-24 (safety rails)
**Extends (existing Ever Works nouns):** Session · Run · Agent · Node · Inbox · Decision (My Decisions) · Activity · Notification · Organization

---

## 0. TL;DR

FL-04 lets a session run on a computer and lets you look at its terminal. This epic answers the question you actually have when you are not looking: **"Is anything waiting for me?"** Every session carries one of four states — `working · needs you · done · idle` — and a separate outcome. The state comes **first from the agent CLI's own hooks** (a per-session overlay the node injects, never the person's global configuration), **second from structured evidence**, **third from a rules file that reads the terminal screen**, and **last from a proven process exit**; a silent session decays to `idle` after 30 minutes and is never reported `done` without evidence. When a session needs a person, one **attention key** identifies that edge on every surface — the session card, the Inbox item, the Decision in My Decisions, the "needs a look" row on the hub, the notification — so answering in one place clears it everywhere. The **Sessions board** (Needs you · Working · Done · Idle) lives in Activity next to Runs, and the same sessions are grouped by computer under Fleet → Sessions.

```
 /activity?view=sessions                              [ Board | List ]   Agent ▾  Computer ▾  Kind ▾
 ┌ NEEDS YOU (2) ──────────┐ ┌ WORKING (3) ───────────┐ ┌ DONE (4) ───────────────┐ ┌ IDLE (1) ──────┐
 │ ◉ Nina · "api tests"    │ │ ◉ Ops · "lint sweep"    │ │ ◉ Nina · "migration"     │ │ ● Shell · ~    │
 │ You: run the migration… │ │ You: fix the eslint…   │ │ Nina: All 42 tests pass  │ │ build-01       │
 │ ┌ Allow Bash(pnpm db:…)?│ │ Ops: Rewriting the…    │ │ and the PR is open.      │ │ idle 2 h       │
 │ │ [1 Allow] [2 Deny]    │ │ build-02 · fl/lint     │ │ build-01 · fl/migrate    │ └────────────────┘
 │ └───────────────────────│ │ working 4 min          │ │ done 12 min ago · $0.84  │
 │ build-01 · fl/api-tests │ └────────────────────────┘ │ PR #412 ✓                │
 │ waiting 3 min           │                            └──────────────────────────┘
 │ ─────────────────────── │
 │ ◉ Ops · "deploy prep"   │
 │ Which region? 1 eu-west…│
 └─────────────────────────┘
```

Three phases, each independently shippable:

| Phase  | Ships                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The **status pipeline**: a loopback hook endpoint on the node (ephemeral port, token, endpoint file, spool), per-session hook injection for Claude Code and Codex, process-exit evidence, the state machine and outcome, 30-minute idle decay, the state glyph everywhere, and the completed **session card** (R-22)         |
| **P2** | **Attention**: keys, reasons, acknowledgement; the Decision + Inbox item (R-12); the approval card and the question card that replace the composer; answering from any door; the per-agent **rules file** for prompts no hook reports; notifications through the existing channel plugins with wording, dedupe and the session-boundary rule; the `session-needs-you` producer |
| **P3** | The **Sessions board and list** in Activity, **Fleet → Sessions** grouped by computer, and the palette's "needs you first" ordering                                                                                                                                                   |

---

## 1. Overview

A **session state** is one of four words a non-technical owner can act on. **Working** means the agent is doing something and nothing is required of you. **Needs you** means it stopped to ask — for permission to run a tool, for an answer to a question, or because it is blocked or failed — and the card tells you what and lets you answer in one click. **Done** means it finished a turn and is waiting for your next instruction, with an outcome (success, failure, cancelled, interrupted, or unconfirmed when the evidence ran out). **Idle** means nothing has happened for 30 minutes and nobody has claimed it is finished. A fifth word, **ended**, says the process is gone, with a reason.

Status is **hooks first, evidence second, scraping last** (README D4). For Claude Code and Codex the node supplies managed hooks **per session** — a generated settings overlay for Claude Code, a notify override or a private home overlay for Codex — that post the CLI's own events (a prompt was submitted, a tool wants permission, a question is being asked, the turn stopped, the session ended) to a loopback endpoint on the node. The node never edits the person's global CLI configuration (CONTRACTS R-6). For prompts no hook reports — a Codex approval, an older CLI, a shell — a data-driven rules file per agent reads the terminal's own screen; each rule says why it exists. A process exit is proven by the daemon, never inferred from silence.

Every edge into **needs you** mints an **attention key** — one identity shared by the card badge, the computer-page row, the Inbox item, the Decision in My Decisions, the "needs a look" row and the notification — so that answering in any of those places clears all of them, and a key you already acknowledged never re-flags for the same edge (CONTRACTS §5.2). Questions and permission requests become a Decision; blocked and failed sessions become an Inbox notice; a finished session becomes an unread marker and, when you are not looking at it, a notification worded from its state and outcome, deduplicated per subject, and never sent for the "done" that merely marks a session's start or resume.

The **Sessions board** is the owner's view of every session across the fleet: four columns, most-recently-moved first, tint only where attention or completion earned it, with a list mode grouped by Agent and by day or week exactly as Runs are. **Fleet → Sessions** is the operator's view of the same sessions grouped by computer, with the machine's consents beside them. Neither is a sidebar tree (README D1).

---

## 2. Why now

### 2.1 The user's question

> _"Is Nina waiting on me? Which of the five things running right now actually needs a decision — and can I answer it from here without opening a terminal?"_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                       | Today they must…                                                                                                                | What breaks                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Is the agent stuck on a question?"                              | Watch the Run's status and the `awaitingInput` flag.                                                                             | A fleet Run can only ask by **writing a file and exiting** (`apps/node/src/core/executors/agent-task-question.ts:15-25`); the question reaches the Inbox after the run has stopped. An interactive session (FL-04) asks on its screen and nothing reads that screen. `AgentRun` has five statuses and no "needs you" (`packages/agent/src/entities/agent-run.entity.ts:52`). |
| "Did it finish, or just go quiet?"                               | Read the terminal.                                                                                                              | There is no evidence model: a Run is `completed` when its process reports, and nothing distinguishes "the CLI is waiting for my next prompt" from "nothing has happened for an hour". The platform-raised `attentionReason` covers lifecycle problems (`queued-too-long`, `stale-parked`) only (`agent-run.entity.ts:361-374`). |
| "Tell me when it needs me."                                      | Nothing for sessions.                                                                                                           | Notification events exist for `inbox_question`, `agent_run_finished` and `agent_run_escalated` (`packages/agent/src/notifications/core-event-catalogue.ts:121-181`) — all Run- or Inbox-shaped. No event names a session, a tool permission, or an outcome. |
| "Answer it without a terminal."                                  | Reply in the Inbox — for a parked fleet Run only.                                                                               | The Inbox reply restarts a parked Run on the same branch (`packages/agent/src/inbox/inbox.service.ts:151-161`, `393-416`); it cannot type into a live process. The HITL question shapes exist (`packages/contracts/src/hitl/hitl-question.types.ts:32-105`) and are unused by anything interactive.                            |
| "Show me everything that is running and what needs me."          | Open Activity → Runs, filter `attention=1`; or `/agents/activity`, whose list is already labelled "sessions" but has one row per **Run** (`AgentSessionsClient`, polling every 10 s — EXISTING-SUBSTRATE §3.3). | The Runs ledger is a calendar of executions with receipts (`apps/web/src/app/[locale]/(dashboard)/activity/activity-views.ts:9-20`); there is no board, no state columns (the only boards are Tasks and Works — EXISTING-SUBSTRATE §3.5), and a `FleetSession` is not a Run. `ACTIVITY_VIEWS` is `log · runs · feed · schedules`. The existing Run-based list at `/agents/activity` stays exactly as it is; this epic adds a view beside it and renames nothing. |
| "What is the agent's own status?"                                | Nothing.                                                                                                                        | Fleet Claude Code runs carry a strict MCP configuration and a permission mode (`apps/node/src/core/executors/model-cli.ts:563,638-672`) but **no hooks**: no settings overlay is generated anywhere in `apps/node`, and the node has no loopback endpoint except the MCP bridge (`apps/node/src/core/executors/mcp-bridge.ts:7-32`), which proxies tool calls, not status. |
| "Which machine needs a look?"                                    | Read the hub's "needs a look" list (FL-01).                                                                                      | Its producers are health, runners, schedules and cloud (CONTRACTS R-23); nothing produces a "waiting for you" row for a session.                                                                                                                                                                                                  |

### 2.3 The gaps this epic closes

1. **No status model for an interactive agent.** Four states and an outcome, with an evidence order, replace "the process reported or it did not".
2. **No way for a CLI to tell the platform anything mid-run.** The loopback hook endpoint is the channel; the per-session overlay is how a CLI learns about it without the node touching the person's configuration.
3. **No single identity for "needs you".** The attention key is what lets five surfaces agree and one answer clear them all.
4. **No board.** Runs have a calendar; sessions need columns.

### 2.4 Why this epic is additive only

Nothing is removed or renamed (README rule 1). `AgentRun.status`, `awaitingInput` and `attentionReason` keep their meanings; the Runs view, the Inbox, My Decisions and the notification catalogue gain members. The fleet Run's question file keeps working for headless Task runs. The Inbox's existing `fleet-run` source stays; a new `fleet-session` source sits beside it.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Status without looking.**
  **Given** Nina's Claude Code session on `build-01` is running a long test suite,
  **when** the owner is on the Fleet hub,
  **then** the session's card reads `◉ working 4 min` with a spinner glyph, moved there the moment Nina's CLI reported the prompt was submitted, not when output happened to arrive.

- **S2 — Needs you, from a hook.**
  **Given** Nina's CLI asks for permission to run `pnpm db:migrate`,
  **when** the CLI fires its permission hook,
  **then** within 2 s the session is `needs you (permission)` on every surface: the card moves to the **Needs you** column with a warm tint and an amber box reading _"Allow Bash(pnpm db:migrate)?"_ with **1 Allow** / **2 Deny**; the hub's "needs a look" list gains _"Nina (Agent) waiting for you on build-01 · Allow Bash(pnpm db:migrate)?"_ with **Answer**; My Decisions gains the same item; a notification reads _"Nina needs you on build-01 — Allow Bash(pnpm db:migrate)?"_.

- **S3 — Answer from the card.**
  **Given** S2,
  **when** the owner presses **1** on the card (or clicks **Allow**),
  **then** the answer is sent into the session as the CLI expects it, the attention clears within 2 s everywhere (card, Inbox, Decision, needs-a-look, notification dismissed), the session returns to `working`, and one audit row records who answered what.

- **S4 — Answer from My Decisions.**
  **Given** S2,
  **when** the owner opens My Decisions and chooses **Deny** there,
  **then** the same answer reaches the session, the card's box disappears, and the Decision is marked answered with the answerer; opening the session detail shows the CLI received the denial.

- **S5 — A question with options and free text.**
  **Given** Nina's CLI asks _"Which region? 1 eu-west 2 us-east 3 other"_ through its question tool,
  **when** the session enters `needs you (question)`,
  **then** the question card replaces the composer on the detail page and appears in the board card: numbered options, a free-text field for "other", **Esc** does nothing destructive; choosing an option or typing an answer and pressing Enter sends it and clears the attention.

- **S6 — Done, with an outcome.**
  **Given** Nina's turn completes and her CLI fires its stop hook,
  **then** the session is `done · success`, the card moves to **Done** with a green tint, shows Nina's last line (_"All 42 tests pass and the PR is open."_), the elapsed reads _"done 12 min ago"_, and — because the owner is not viewing it — a notification reads _"Nina finished on build-01 — api tests"_.

- **S7 — The next prompt.**
  **Given** S6,
  **when** the owner types _"now update the changelog"_ in the composer,
  **then** the session returns to `working` the moment the CLI's prompt hook fires, the card moves back, and no "finished" is re-sent for the earlier turn.

- **S8 — Idle, honestly.**
  **Given** a session has had no hook event, no output and no exit for 30 minutes,
  **then** it is `idle` with a grey glyph, the card is untinted in the **Idle** column, and nothing calls it done.

- **S9 — A prompt no hook reports.**
  **Given** an owner Codex session shows an approval prompt on its screen and Codex's notify channel reports nothing until the turn ends,
  **when** the node's rules for Codex match the prompt on the terminal grid,
  **then** the session is `needs you (permission)` with the box _"Codex asks to run `rm -rf dist`"_, the card carries a small _"from the screen"_ note, and answering sends the keys Codex expects.

- **S10 — The board.**
  **Given** eleven sessions across three computers,
  **when** the owner opens Activity → Sessions,
  **then** four columns show them, most recently moved first within each column, only Needs you and Done cards tinted, counts in the column headers, and the toggle to **List** groups the same sessions by Agent and by day with the Runs view's grouping controls.

- **S11 — By computer.**
  **When** the owner opens Fleet → Sessions,
  **then** the same sessions are grouped under `build-01`, `build-02`, `design-mac`, each group showing the computer's consents (`work · manage`) and online state, and the per-computer Sessions tab is this view filtered to one machine.

- **S12 — Palette.**
  **When** the owner opens the command palette with an empty query,
  **then** the first section is **Needs you** — sessions waiting, newest first, with digit shortcuts — followed by recent sessions ordered done → idle.

- **S13 — An Agent asks what another session is asking.**
  **Given** Ops has `fleet_sessions_question`,
  **when** Ops calls it on Nina's session,
  **then** Ops receives the prompt and the options as text; Ops cannot answer a **permission** prompt (people only) and may answer a **question** only when Ops's owner switched on "may answer other sessions" for Ops (CONTRACTS R-32) and its grants allow `fleet_sessions_answer`.

### 3.2 Unhappy paths, races, denials and empty states

- **U1 — The node restarted; the hooks still work.**
  **Given** Claude Code was started with a settings overlay pointing at the node's loopback endpoint and the node process restarts (the daemon and the CLI survive),
  **when** the next hook fires,
  **then** it reads the endpoint file the node rewrote at start, posts to the new port with the new token, and the event arrives; nothing is lost.

- **U2 — The endpoint is down for a moment.**
  **Given** a hook fires while the node is restarting,
  **then** the hook script writes the event to the node's spool and exits 0 within 2 s so the CLI never waits; the node drains the spool when its endpoint is up and applies the events in order.

- **U3 — A hook arrives for an unknown session.**
  **Then** the node drops it, counts it, and never guesses a session.

- **U4 — Wrong token.**
  **Then** the node answers before reading the body, drops the event, counts it in health; a burst of 20 bad tokens in a minute is surfaced on the computer page as _"Something on build-01 is posting to the hook endpoint with a bad token"_.

- **U5 — Duplicate or late events.**
  **Given** a spool replay delivers an event already applied,
  **then** it is ignored by sequence; a `needs you` that arrives after the answer was already typed in the terminal is superseded by the later `working` evidence and never re-raises.

- **U6 — Answer races the terminal.**
  **Given** the owner types `1` into the terminal and a second later clicks **Allow** on the card,
  **then** the second answer is refused `invalid` — _"Already answered in the terminal"_ — and nothing is typed twice.

- **U7 — Answer while the link is down.**
  **Then** the card keeps the prompt, the button shows _"build-01 is unreachable — the answer will not be sent"_, the request is refused `unreachable`, and the owner may retry.

- **U8 — Kill switch.**
  **Given** the fleet stop is on,
  **then** sessions keep their state, attention stays visible, every answer is refused `kill_switch` with the stop reason, and the card's buttons are disabled with the banner.

- **U9 — Not allowed to answer.**
  **Given** `build-01`'s `sessions` audience is `owner` and Ops is an Organization member,
  **then** Ops sees no card and no Decision for it; a direct answer is refused `permission_denied` with the hint _"ask the owner of build-01 to allow org members: sessions"_.

- **U10 — An older CLI without the permission hook.**
  **Given** a Claude Code version that lacks a hook this epic relies on,
  **then** the overlay omits that hook, the session detail shows _"Status from the screen for permission prompts — update Claude Code on build-01 for exact status"_, and the rules file covers the gap.

- **U11 — Codex owner session with the person's own notify.**
  **Given** the person's Codex configuration already names a notify command,
  **then** the node's per-session override replaces it for this session only and the detail says so — _"Your own Codex notify command is not run in this session"_ (CONTRACTS R-6).

- **U12 — Done at a session boundary.**
  **Given** a session resumes and its CLI fires a stop hook within 5 s of its start hook with no prompt in between,
  **then** the session shows `done` but **no notification** is sent and no unread marker is set — a boundary is not news.

- **U13 — The same subject twice.**
  **Given** a stop hook and an exit arrive 1 s apart for the same session,
  **then** at most one notification is sent for that subject within 5 s.

- **U14 — Blocked or failed.**
  **Given** a session exits non-zero while `working`,
  **then** it is `done · failure` then `ended (exit)`, the card shows _"exited with code 1"_, an Inbox **notice** (not a Decision) is filed, and the notification reads _"Nina failed on build-01 — exit code 1"_.

- **U15 — Interrupted.**
  **Given** the owner presses Ctrl-C in the terminal and the CLI stops,
  **then** the outcome is `interrupted`, the glyph is muted, and no notification is sent — a person's stop is not news.

- **U16 — Lost without evidence.**
  **Given** the daemon loses the process without an exit code (machine reboot),
  **then** the outcome is `unconfirmed`, the glyph is a dashed ring, the card never says "finished", and the "needs a look" row reads _"build-01 restarted — 2 sessions ended without a result"_.

- **U17 — Attention budget exhausted (AW-13).**
  **Given** the owner's email budget for the day is spent,
  **then** the in-app record is still written, the email is held as AW-13 already does, and the card still shows the prompt.

- **U18 — Viewing acknowledges.**
  **Given** the owner opens the session detail while it needs them,
  **then** the unread marker clears (viewing earns delivery but no unread), the attention itself stays until answered, and the in-app toast for that session is suppressed while the detail is open.

- **U19 — Empty board.**
  **Given** no sessions exist,
  **then** the board shows _"No sessions yet. Start one on a computer and it shows up here with what it needs from you."_ and **New session ▾**.

- **U20 — A shell session.**
  **Given** a plain shell,
  **then** it is `working` while output flows, `idle` after 30 minutes, `ended` on exit — never `needs you`, never `done`, and it never notifies.

---

## 4. Functional requirements

### 4.1 P1 — The hook endpoint on the node

- **FR-1** The node MUST run a loopback-only hook endpoint on `127.0.0.1` with an ephemeral port and a random token minted at every node start; it MUST NOT listen on any other interface.
- **FR-2** The node MUST write the endpoint's port and token to an **endpoint file** in its own configuration directory, readable only by the enrolling user, atomically replaced at every start; every hook script MUST read that file on each invocation so a CLI that outlives a node restart keeps reporting.
- **FR-3** The endpoint MUST check the token before reading a request body, MUST answer `204` to every well-formed authenticated request within 50 ms, and MUST never return anything a CLI would treat as a decision.
- **FR-4** A hook script MUST exit `0` within 2 s whether or not the endpoint answered, and on failure MUST append the event to a per-session **spool** (≤ 5 MB per file, ≤ 7 days) that the node drains in order when its endpoint is up.
- **FR-5** Every hook event MUST carry the session's id (from the environment the daemon set), the provider, the event name, a monotonic sequence and the CLI's payload; events for unknown sessions MUST be dropped and counted.
- **FR-6** Bad-token requests MUST be counted and surfaced on the computer page after 20 in one minute.

### 4.2 P1 — Per-session hook injection

- **FR-7** For a Claude Code session the node MUST generate a per-session settings overlay that registers hooks for session start, prompt submitted, permission request, the question tool's pre-use, stop, session end and notification, and MUST pass it to the CLI as an additional settings file; the person's global settings MUST NOT be written.
- **FR-8** For a Codex owner session the node MUST pass a per-session notify override on the command line; for a Codex Agent session it MUST place the notify configuration in the session's private home overlay; the person's Codex configuration MUST NOT be written.
- **FR-9** The overlay MUST be written to a per-session scratch directory readable only by the user and MUST be removed when the session ends.
- **FR-10** The overlay MUST omit hooks the installed CLI version does not support, and the session MUST then say that status for those events comes from the screen.
- **FR-11** The node MUST record what it injected for a session — the session's `hooks { provider, injected, events[] }` (CONTRACTS §4.2) — and every surface MUST label the status source from it: _from the CLI's hooks_ when every relied-on event is present, _partly from the screen_ when some are missing, _from the screen_ when none was injected.

### 4.3 P1 — States, outcome, evidence

- **FR-12** A session MUST be in exactly one of `starting · working · needs_you · done · idle · ended`, with `outcome` set once on leaving `working`/`needs_you` for `done`/`ended` (CONTRACTS §5.1).
- **FR-13** Evidence MUST be applied in the order hook event > structured event > terminal rule > process exit, and a lower-precedence source MUST NOT override a higher-precedence state newer than 10 s.
- **FR-14** A session MUST NOT move to `done` on silence; `working` or `done` MUST decay to `idle` after **30 minutes** without evidence, and any evidence MUST return it to the state the evidence names.
- **FR-15** A process exit while `working` MUST set `outcome` from the exit evidence — `success` on exit 0 with a stop hook or a clean exit, `failure` on non-zero, `unconfirmed` when the daemon lost the process without a code — and then `ended (exit)`.
- **FR-16** A stop hook MUST set `done · success`; a prompt-submitted hook MUST set `working`; a permission or question hook MUST set `needs_you` with the matching reason; a session-end hook MUST set `ended`.
- **FR-17** Ctrl-C or an interrupt reported by the CLI MUST set outcome `interrupted`; a platform-side end MUST set `cancelled`.
- **FR-18** Each state change MUST record when it happened (`stateChangedAt`, CONTRACTS §4.2) and the evidence that caused it (`lastEvidence { source, at, detail }`), so columns order most-recently-moved first and every surface can say why a state was set.
- **FR-19** A shell session MUST only ever be `working`, `idle` or `ended`.

### 4.4 P1 — The session card (R-22, CONTRACTS §4.8)

- **FR-20** The card MUST show, in this order: header — agent or shell icon (who) · title · state glyph (what state); body — the last user line and the last agent line (2-line clamp, redacted) or the attention prompt in an amber box; footer — the CONTRACTS §4.8 slots in their order: `computer` · `gitLine` (FL-06) · `prPill` (FL-06) · `taskChip` (FL-15) · `elapsed` (since finish when done, else since start) · `cost` (FL-20, when known) · `cleanUp` (FL-06). An empty slot renders nothing; no epic adds a slot outside this list.
- **FR-21** Tint MUST be warm for `needs_you`, green for `done · success`, and neutral for everything else; an unread card MUST show a bold title, not a badge.
- **FR-22** The glyph vocabulary MUST be: working — spinner ring; needs you (permission/question) — question bubble; blocked/failed — red dot; done — green check; interrupted — muted dot; unconfirmed — dashed ring; idle — grey dot; shell — none.
- **FR-23** The card MUST carry **Open**, **Rename**, **End** and, when applicable, **Answer** and **Open the Run**, and MUST say which status source it uses when it is not hooks.

### 4.5 P2 — Attention

- **FR-24** Entering `needs_you` MUST mint `attention.key = "fleet-session:<sessionId>:<reason>:<promptId|turnId>"` with reason `question · permission · blocked · failed`, the prompt, its options and `raisedAt`; `finished` MUST mint a key for unread and notification only.
- **FR-25** The key MUST be the identity for the card badge, the computer-page row, the Inbox item, the Decision, the "needs a look" row and the notification; delivery MUST deduplicate on it.
- **FR-26** `acknowledgedAt < raisedAt` MUST mean unread; opening the session detail MUST acknowledge (clearing unread, not the attention); a key acknowledged once MUST never re-flag for the same edge.
- **FR-27** Reasons `question` and `permission` MUST create (or update, by key) **one** Inbox item of kind question or approval that **is** the Decision shown in My Decisions, carrying the computer, the session title, the provider and the options; reasons `blocked` and `failed` MUST create an Inbox notice only (CONTRACTS R-12).
- **FR-27a** A session's Decision MUST expire when the session ends, and after 24 hours unanswered MUST be marked stale — never answered automatically (CONTRACTS R-12).
- **FR-28** Answering from the card, the detail, the Inbox, My Decisions, an Agent tool or the CLI MUST send one `session.answer { key, answer }` to the node, which MUST type the answer in the form the CLI expects (option number and Enter; Allow/Deny keys; free text and Enter), and MUST clear the attention everywhere within 2 s.
- **FR-29** A second answer for an already-cleared key MUST be refused `invalid` with _"Already answered"_; an answer while the node is unreachable MUST be refused `unreachable` and MUST leave the prompt in place.
- **FR-30** Permission prompts MUST be answerable by people only; an Agent tool answering a permission prompt MUST be refused `permission_denied` with that hint. An Agent MAY answer another session's **question** only when its owner switched on "may answer other sessions" for that Agent (CONTRACTS R-32); otherwise it MUST be refused `permission_denied` naming the setting.
- **FR-31** The approval card MUST offer exactly the options the CLI showed — read from the hook payload or the rule's key map (CONTRACTS §5.2) — with the first option primary and **Esc** as the CLI's deny option on the detail page; the question card MUST offer numbered options, free text, and MUST treat **Esc** as "keep the prompt"; both MUST replace the composer while pending and MUST restore it when cleared.
- **FR-32** The `session-needs-you` producer MUST register with the hub's "needs a look" registry and MUST emit one row per session in `needs_you` (severity `warn`, action **Answer**) and one row per Node whose sessions ended `unconfirmed` in the last hour (severity `info`, action **Open**; emitted under the `session-needs-you` kind until CONTRACTS §4.6 names a kind for it — §8b).

### 4.6 P2 — The rules file

- **FR-33** For each agent provider the node MUST ship a data-driven rules file with anchors and rules over three regions — the live screen, the lower-cased tail and the terminal title — each rule naming its state and reason and carrying a `why`.
- **FR-34** Rules MUST be evaluated at most every 2 s, only while a session has had no hook evidence in the last 10 s, and MUST be able to raise `needs_you (permission|question|blocked)`, `working` and `idle (weak)` — never `done`.
- **FR-35** A rule-raised attention MUST carry an answer key map (which keys to type per option) so answering from a card works for prompts no hook reports.
- **FR-36** Rules MUST be validated against a schema at node start and MUST be written against captured terminal transcripts kept as test fixtures.

### 4.7 P2 — Notifications

- **FR-37** Three notification events MUST exist — session needs you, session finished, session failed — delivered through the existing notification service and channel plugins, respecting AW-13 budgets and quiet hours.
- **FR-38** Wording MUST derive from state and outcome: _"<Who> needs you on <computer> — <prompt>"_, _"<Who> finished on <computer> — <title>"_, _"<Who> failed on <computer> — <reason>"_; `interrupted` and `cancelled` MUST NOT notify.
- **FR-39** Deliveries MUST deduplicate per subject (session + reason) within **5 s**, MUST NOT be sent for a session-boundary done (a stop inside the session's `boundaryUntil` window — 5 s after a start or resume with no prompt in between, CONTRACTS §4.2), and MUST suppress the in-app toast while the recipient has that session's detail open.
- **FR-40** Shell sessions MUST never notify.

### 4.8 P3 — Board, lists, palette

- **FR-41** Activity MUST gain a **Sessions** view at `/activity?view=sessions` beside Runs, with a **Board** (Needs you · Working · Done · Idle; most-recently-moved first; counts in headers) and a **List** grouped by Agent and by day or week with the Runs view's grouping controls.
- **FR-42** `done` sessions MUST stay on the board for 24 hours after finishing and in the list thereafter; `ended` sessions MUST appear in the list only, with their reason.
- **FR-43** The board MUST update within 5 s of a state change without a reload and MUST animate a card's move between columns.
- **FR-44** Filters MUST cover Agent, computer, kind and state, and MUST live in the address bar so a link reproduces the view.
- **FR-45** Fleet → Sessions MUST show the same sessions grouped by computer, each group carrying the computer's online state and consents; the per-computer Sessions tab MUST be that view filtered to one Node.
- **FR-46** The palette's empty-query view MUST open with a **Needs you** section (sessions waiting, newest first, digit shortcuts), then recent sessions ordered done → idle.
- **FR-47** Every board card, list row and palette entry MUST open the session detail.

### 4.9 Permissions, safety, audit, cost

- **FR-48** Answering MUST be checked against the Node's `sessions` family audience; listing the board MUST show only sessions on Nodes whose `sessions` audience includes the viewer.
- **FR-49** Every answer MUST write one audit row (`node.session.answer`) naming the key, the reason, the option chosen (never free text) and the requester; the Decision MUST record the answerer.
- **FR-50** While the kill switch is on, answers MUST be refused `kill_switch`, attention MUST stay visible, and the buttons MUST be disabled with the banner.
- **FR-51** The status pipeline MUST spend no model tokens and MUST say so on the detail; the cost chip on the card MUST show the Run's cost for Agent sessions and the usage scan's figure for owner sessions when known.

### 4.10 Accessibility and keyboard

- **FR-52** Cards MUST be focusable with the state announced in words; **1–9** MUST answer a numbered option on a focused card; **A**/**D** MUST Allow/Deny on a focused approval card; `n` MUST switch Activity to Sessions.
- **FR-53** Tint and glyph MUST never be the only carrier of state; every card and row MUST name it in text.

---

## 5. UX

All copy is the exact user-visible string (keys under `fleet.sessions.*`).

### 5.1 Card — needs you (permission)

```
┌ ◉ Nina · "api tests"                                   ? needs you ─┐
│ You: run the migration tests and fix what fails                      │
│ ┌ Allow Bash(pnpm db:migrate)?                                    ┐  │
│ │ [ 1  Allow ]  [ 2  Deny ]                                        │  │
│ └──────────────────────────────────────────────────────────────────┘  │
│ build-01 · fl/api-tests · waiting 3 min                              │
└──────────────────────────────────────────────────────────────────────┘
```

Question variant: the box reads the question and `1 eu-west · 2 us-east · 3 other…` with a text field. From the screen: a muted _"from the screen"_ under the box.

### 5.2 Card — done

```
┌ ◉ Nina · "migration"                                   ✓ done ──────┐
│ You: run the migration tests and fix what fails                      │
│ Nina: All 42 tests pass and the PR is open.                          │
│ build-01 · fl/migrate · done 12 min ago · $0.84 · PR #412 ✓          │
└──────────────────────────────────────────────────────────────────────┘
```

Failure: `✖ failed` glyph, _"exited with code 1"_ as the agent line, no tint. Unconfirmed: `◌ no result` dashed ring, _"build-01 restarted before this finished"_. Interrupted: `● stopped` muted.

### 5.3 Detail — approval card replacing the composer

```
│ ( terminal )                                                                               │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ? Nina asks: Allow Bash(pnpm db:migrate)?                                                  │
│   The command runs in ~/code/api on build-01.                                              │
│                                                  [ 1  Allow ]  [ 2  Deny ]   Esc = Deny    │
```

Question card: numbered options as buttons, a text field _"or type an answer"_, `Enter` sends, `Esc` keeps the prompt. Kill switch: buttons disabled, _"Paused by the fleet stop — answers are not sent"_. Unreachable: _"build-01 is unreachable — the answer will not be sent"_ `[ Retry ]`.

### 5.4 Board (see §0)

Column header `NEEDS YOU (2)`; empty column reads _"Nothing needs you"_ / _"Nothing working"_ / _"Nothing finished today"_ / _"Nothing idle"_. Toolbar: `[ Board | List ]`, filters, and the Runs-style `Day | Week` only in List. Toggle key `n`.

### 5.5 List

```
 TODAY · Nina (3)
  ◉ "api tests"      needs you · permission    build-01 · fl/api-tests     waiting 3 min     [Answer]
  ◉ "migration"      done · success            build-01 · fl/migrate       12 min ago · $0.84
  ○ "lint sweep"     ended · exit 0            build-02 · fl/lint          1 h ago
 TODAY · You (1)
  ● "~"              idle                      build-01                     2 h
```

### 5.6 Fleet → Sessions (by computer)

```
 build-01   ● online · work · manage · 3 sessions                               [New session ▾]
   ◉ Nina · "api tests" …   ◉ Nina · "migration" …   ● Shell · "~" …
 build-02   ● online · work · 1 session
   ◉ Ops · "lint sweep" …
 design-mac ● online · manage only · 0 sessions        Agents need work switched on here
 win-lab    ○ offline · last seen 2 h ago · 1 session ended (node-restart)
```

### 5.7 Needs a look row (hub)

`● Nina (Agent) waiting for you on build-01 · "Allow Bash(pnpm db:migrate)?"  [Answer]` · `● build-01 restarted — 2 sessions ended without a result  [Open]`

### 5.8 Inbox / My Decisions item

Kind badge **Approval** (or **Question**), chip **From a session**, title _"Nina asks on build-01: Allow Bash(pnpm db:migrate)?"_, provenance line _"build-01 · api tests · Claude Code"_, options as the Inbox renders options today, answered line _"Allowed by you 09:52"_.

### 5.9 Notifications

_"Nina needs you on build-01 — Allow Bash(pnpm db:migrate)?"_ · _"Nina finished on build-01 — api tests"_ · _"Nina failed on build-01 — exit code 1"_ · _"Ops finished on build-02 — lint sweep"_. Action: **Open session**.

### 5.10 Status source note (detail header)

_"Status from Claude Code's hooks"_ · _"Status from the screen for permission prompts — update Claude Code on build-01 for exact status"_ · _"Status from the screen — Codex reports only when a turn ends"_ · _"Your own Codex notify command is not run in this session"_ · _"Shell — no agent status"_.

### 5.11 Hook endpoint problems (computer page)

_"Something on build-01 is posting to the hook endpoint with a bad token (23 in the last minute)"_ · _"12 hook events are spooled on build-01 and will be applied when the node is up"_.

### 5.12 Palette (empty query)

```
 NEEDS YOU
  1  Nina · api tests · Allow Bash(pnpm db:migrate)?        build-01
  2  Ops · deploy prep · Which region?                      build-02
 RECENT SESSIONS
     Nina · migration · done                                 build-01
     Shell · ~ · idle                                        build-01
```

### 5.13 Empty states

Board: _"No sessions yet. Start one on a computer and it shows up here with what it needs from you."_ `[ New session ▾ ]`. Fleet → Sessions with no computers: FL-01's enrol empty state.

### 5.14 Accessibility

Each card is a focusable article labelled _"<who>, <title>, <state in words>, on <computer>"_; the attention box is `role="group"` with the prompt as its label; the column move is announced through a polite live region; digit shortcuts are listed in the `?` sheet.

---

## 6. Non-functional requirements

- **Performance.** Hook event to platform state ≤ 2 s (p95) with the link up; answer to keystroke on the node ≤ 1 s (p95); board first paint ≤ 1.5 s for 200 sessions; rules evaluation ≤ 20 ms per session per tick on the node.
- **Reliability.** No hook event is lost across a node restart (endpoint file + spool); events are idempotent by sequence; a lost link never changes a state.
- **Security & privacy.** The endpoint is loopback-only with a per-start token; hook payloads are redacted on the node before they leave it; prompts shown on cards are redacted; free-text answers are never written to audit or notifications; the node never writes a person's global CLI configuration.
- **Observability.** Audit rows for answers; counters for hook events by source and outcome, spool depth, bad tokens, rule hits by rule id, notifications sent/deduped/suppressed.
- **Compatibility.** Additive: new Inbox source type, new notification events, new Activity view, the five FL-05 columns of CONTRACTS §4.2; nothing existing changes meaning.

---

## 7. Key entities & concepts

| Entity / concept                 | New?     | Description                                                                                                                                                                                                              |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session** (`FleetSession`)     | FL-04    | Gains `attention` (key, reason, prompt, options, raised, acknowledged) and when its state last changed.                                                                                                                  |
| **Session state / outcome**      | **NEW** concepts | Four live states plus `ended`; outcome set once (CONTRACTS §5.1).                                                                                                                                                 |
| **Attention key**                | **NEW** concept | The one identity of a "needs you" edge (CONTRACTS §5.2).                                                                                                                                                           |
| **Decision** (My Decisions)      | Existing | An Inbox item of kind question or approval; a session's question/permission is one. Gains the `fleet-session` source.                                                                                                   |
| **Inbox item**                   | Existing | Gains the `fleet-session` source; notices for blocked/failed.                                                                                                                                                            |
| **Notification event**           | Existing | Gains session needs-you / finished / failed.                                                                                                                                                                             |
| **"Needs a look" item**          | FL-01    | Gains the `session-needs-you` producer (CONTRACTS §4.6).                                                                                                                                                                 |
| **Hook endpoint / endpoint file / spool** | **NEW** (machine-side) | The node's loopback status channel. Not platform entities.                                                                                                                                              |
| **Rules file**                   | **NEW** (machine-side) | Per-provider screen rules with a `why` each.                                                                                                                                                                 |
| **Run**                          | Existing | An Agent session's Run mirrors the session's outcome.                                                                                                                                                                    |

**Action families, consents, permissions, confirmations, errors (rule 7):**

| Act                              | Consent                 | Family / audience default | Confirmation | Audit                  | Errors                                                                                   | Agent tool                                                                 |
| -------------------------------- | ----------------------- | ------------------------- | ------------ | ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Answer a question                | `manage` (owner) / `work` (Agent session) | `sessions` / owner | `plain` (the answer is the act) | `node.session.answer`  | `not_found`, `invalid` (unknown option / already answered), `unreachable`, `kill_switch`, `permission_denied` (incl. R-32 setting off) | `fleet_sessions_answer` · destructive: false · `confirm` (FL-19 catalogue §9.1) |
| Answer a permission request      | same                    | `sessions` / owner        | `plain`      | `node.session.answer`  | same; Agents: `permission_denied` always                                                 | — (people only)                                                            |
| Read what a session asks         | any                     | `sessions` / owner        | `plain`      | — (read)               | `not_found`, `permission_denied`                                                         | `fleet_sessions_question` · readOnly                                        |
| Acknowledge (view)               | any                     | `sessions` / owner        | `plain`      | — (read)               | —                                                                                        | —                                                                          |
| Hook ingestion (node-local)      | the session's own       | — (never leaves the machine unauthenticated) | — | —                 | dropped and counted                                                                      | —                                                                          |

Kill switch (R-24): answers refused `kill_switch`; state and attention stay visible. Drain: ends sessions per FL-04; open attention closes with reason `cancelled`.

---

## 8. Out of scope

- **Starting, attaching, renaming, ending, recording** — FL-04.
- **The git line, PR pill and actions menu on the card** — FL-06 (slot reserved).
- **The Task link on the card** — FL-15 (slot reserved).
- **The cost chip's figure** — FL-20 (slot reserved).
- **Structured (SDK / app-server) session transports.** The evidence order reserves the "structured event" tier; no structured transport ships here — hooks and the rules file cover Claude Code and Codex in their terminals.
- **Hook support for CLIs other than Claude Code and Codex.** Other providers arrive as plain terminals; the rules file format is ready for them.
- **A "chat view" over the terminal** — refused in the capability map.
- **Mobile push.** Notifications ride the existing channels; no new delivery surface.
- **Changing AW-13 budgets or quiet hours** — reused as they are.

## 8b. Open questions

- **Resolved** by CONTRACTS §4.2 / §13: FL-05's slot `1796050000000-AddFleetSessionAttention` adds
  `attention`, `stateChangedAt`, `hooks`, `lastEvidence` and `boundaryUntil` (FR-11, FR-18, FR-39).
- **Resolved** by CONTRACTS R-6: for an owner Codex session the per-session `notify` override
  replaces the person's own notify command for that session only, and the UI says so (U11); the
  person's `CODEX_HOME` is kept; a `CODEX_HOME` overlay is used only for Agent sessions.
- **Resolved** by CONTRACTS R-32: an Agent may answer another session's question only when its
  owner switched on "may answer other sessions" on that Agent; permission prompts are human-only in
  every case (FR-30).
- **Resolved** by CONTRACTS §5.1: `done` cards stay on the board for 24 h, then the list; a
  per-user window is out of scope.
- `[NEEDS CLARIFICATION: Rules-file updates between node releases are the owner's call (CONTRACTS is silent). Default until answered: rules ship inside the node package only — no out-of-band fetch, so nothing behaviour-changing is pulled at runtime; a stale rule is fixed by a node release.]`
- **Resolved** by CONTRACTS §5.2: a permission Decision exposes exactly the options the CLI showed
  (FR-31), read from the hook payload or the rule's key map.
- **Resolved** by CONTRACTS §4.6 (rev 3): kind `session-unconfirmed` (severity `info`) for sessions that ended without a result when their computer restarted.

---

## 9. Acceptance criteria

**Endpoint and injection (P1)**

- [ ] `ACC-FL05-01` (FR-1, FR-3) The hook endpoint binds `127.0.0.1` only; a bad-token request is answered before its body is read.
- [ ] `ACC-FL05-02` (FR-2) After the node restarts with a new port and token, a hook fired by a still-running CLI reaches the node.
- [ ] `ACC-FL05-03` (FR-4) A hook fired while the node is down returns in ≤ 2 s and its event is applied, in order, after the node is up.
- [ ] `ACC-FL05-04` (FR-7, FR-8) An owner Claude Code session receives the overlay through an additional settings file and the person's global settings file is byte-identical before and after; a Codex owner session's configuration file is likewise untouched.
- [ ] `ACC-FL05-05` (FR-10, FR-11) With a CLI lacking a hook, the overlay omits it and the detail says status for that event comes from the screen.

**States (P1)**

- [ ] `ACC-FL05-06` (FR-13, FR-16) A prompt-submitted hook → `working`; a permission hook → `needs_you (permission)`; a stop hook → `done · success`; a session-end hook → `ended`, each within 2 s.
- [ ] `ACC-FL05-07` (FR-14) 30 minutes of silence → `idle`; one output byte → `working`; nothing ever becomes `done` by silence.
- [ ] `ACC-FL05-08` (FR-15) Exit 0 after a stop → `success`; exit 1 → `failure`; a lost process → `unconfirmed`; each then `ended (exit)`.
- [ ] `ACC-FL05-09` (FR-17) Ctrl-C → `interrupted`; End from the platform → `cancelled`.
- [ ] `ACC-FL05-10` (FR-19) A shell session is never `needs_you` or `done`.
- [ ] `ACC-FL05-11` (FR-20–FR-23) The card renders the anatomy with the glyph vocabulary, tints only needs-you and done, and bolds unread titles.

**Attention (P2)**

- [ ] `ACC-FL05-12` (FR-24, FR-25) One key appears on the card, the row, the Inbox item, the Decision, the needs-a-look row and the notification for the same edge.
- [ ] `ACC-FL05-13` (FR-26) Opening the detail clears unread but not the attention; the same edge never re-flags after acknowledgement.
- [ ] `ACC-FL05-14` (FR-27, FR-27a) A permission creates one Decision of kind approval; a question one of kind question; a failure one notice; ending the session expires its Decision, and one left 24 h unanswered reads stale and is never auto-answered.
- [ ] `ACC-FL05-15` (FR-28) Answering from the card, the detail, the Inbox, My Decisions and the CLI each types the expected keys into the session and clears everywhere within 2 s.
- [ ] `ACC-FL05-16` (FR-29) A second answer is refused `invalid`; an answer with the link down is refused `unreachable` and the prompt stays.
- [ ] `ACC-FL05-17` (FR-30) `fleet_sessions_answer` on a permission prompt is refused `permission_denied` with the hint; on another session's question it is refused unless the Agent's "may answer other sessions" setting is on.
- [ ] `ACC-FL05-18` (FR-31) The approval card's first option is primary and Esc denies; the question card accepts a number or free text and Esc keeps the prompt; the composer returns when cleared.
- [ ] `ACC-FL05-19` (FR-32) A session in `needs_you` produces one needs-a-look row with **Answer**; a Node with unconfirmed endings produces one row.
- [ ] `ACC-FL05-20` (FR-33–FR-36) The Codex approval prompt in the fixture transcript raises `needs_you (permission)` with a key map; no rule can raise `done`; an invalid rules file fails node start validation with the rule id.

**Notifications (P2)**

- [ ] `ACC-FL05-21` (FR-37, FR-38) The three events exist in the catalogue and render the stated wording through a channel plugin.
- [ ] `ACC-FL05-22` (FR-39) A stop and an exit 1 s apart send one notification; a boundary done sends none; the toast is suppressed while the detail is open.
- [ ] `ACC-FL05-23` (FR-40, U15) A shell never notifies; an interrupted session never notifies.

**Board (P3)**

- [ ] `ACC-FL05-24` (FR-41) `/activity?view=sessions` shows four columns with counts, most-recently-moved first, and a List grouped by Agent and day/week.
- [ ] `ACC-FL05-25` (FR-42, FR-43) A done card leaves the board after 24 h; a state change moves a card within 5 s without reload.
- [ ] `ACC-FL05-26` (FR-44) A filtered board URL reproduces the view.
- [ ] `ACC-FL05-27` (FR-45) Fleet → Sessions groups by computer with consents; the computer tab is the filtered view.
- [ ] `ACC-FL05-28` (FR-46) The palette's first section lists waiting sessions with digit shortcuts, then done → idle.

**Safety and cross-cutting**

- [ ] `ACC-FL05-29` (FR-48, U9) An org member outside the audience sees no card, no Decision, and is refused `permission_denied`.
- [ ] `ACC-FL05-30` (FR-49) Every answer writes one audit row with the option id and never free text.
- [ ] `ACC-FL05-31` (FR-50) With the kill switch on, answers are refused `kill_switch` and the buttons are disabled with the banner.
- [ ] `ACC-FL05-32` (FR-51) The detail states the pipeline spends no tokens; the cost chip shows the Run's cost for an Agent session.
- [ ] `ACC-FL05-33` (FR-52, FR-53) Digit and A/D shortcuts work on a focused card; `n` switches the view; every state is named in text.
- [ ] `ACC-FL05-34` Every user-visible string is an i18n key under `fleet.sessions.*`; the banned-terms grep prints nothing.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration; notifications ride the existing channel plugins through the facade.
- [x] **II — Capability-driven resolution.** Channels are resolved by the notification facade; no channel id is hard-coded.
- [x] **III — Source-of-truth repos.** No content enters the database beyond redacted prompt previews and option ids.
- [x] **IV — Job runtime.** The idle-decay sweep and the "done leaves the board" housekeeping are scheduled tasks through the configured provider.
- [x] **V — Forward-only migrations.** One additive migration from the FL-05 slot (the five CONTRACTS §4.2 columns).
- [x] **VI — Tests.** Unit, controller, node and Playwright coverage named per phase in the plan, including transcript fixtures for the rules.
- [x] **VII — Secrets.** Hook payloads and prompts are redacted on the node; free-text answers never reach audit or notifications; the endpoint token never leaves the machine.
- [x] **VIII — Plugin counts.** No plugin is added.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint except in §2's substrate citations.
- [x] **X — Backwards compatibility.** Additive unions (Inbox source, notification events, Activity view), five nullable columns, optional fields; the existing Run-based list at `/agents/activity` is untouched.

---

## 11. References

- Program: [Fleet README](../README.md) (D4, D7, §2 "where sessions are seen") · [CONTRACTS](../CONTRACTS.md) (R-6, R-12, R-22, R-23, R-24, R-32; §3.3, §4.2, §4.6, §4.8, §5, §7, §8, §10, §11, §13) · [CAPABILITY-MAP §B](../CAPABILITY-MAP.md) · [TRACKER](../TRACKER.md)
- Implementation plan: [`./plan.md`](./plan.md) · Task breakdown: [`./tasks.md`](./tasks.md)
- Sibling epics: [FL-04 Sessions on computers](../FL-04-sessions-on-computers/spec.md) · [FL-01 Fleet hub](../FL-01-fleet-hub/spec.md) · [FL-06](../FL-06-session-git-actions/) · [FL-15](../FL-15-tasks-and-github/) · [FL-20](../FL-20-usage-and-cost/)
- Agent Workspace: [AW-03 My Decisions](../../agent-workspace/AW-03-decision-queue/spec.md) · [AW-09 Runs & receipts](../../agent-workspace/AW-09-runs-receipts/spec.md) · [AW-13 Attention controls](../../agent-workspace/AW-13-attention-controls/spec.md)
- Existing docs: `docs/features/inbox.md`, `docs/features/approvals-and-escalations.md`, `docs/features/activity.md`, `docs/features/fleet.md` (the question file)
- Constitution: `.specify/memory/constitution.md`
