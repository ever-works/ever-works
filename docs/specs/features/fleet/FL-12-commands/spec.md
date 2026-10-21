# FL-12 — Commands on computers

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-12-commands`
**Program:** [Fleet](../README.md) · Wave 1
**Branch:** `feat/fl-12-commands`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** S · **Blocked by:** FL-02 (node link, `--manage`) · **Related:** FL-01 (hub shell, role derivation), FL-13 (a Command with a cadence is a Schedule), FL-19 (tool and CLI surface), FL-20 (cost)
**Extends (existing Ever Works nouns):** Fleet · Node (UI: "Computer") · Command (new, README D5) · Fleet audit · Organization · Agent

---

## 0. TL;DR

The owner can type one command, pick the computers it should run on, and watch the output of
every machine fill in live — from the Fleet hub, from an Agent tool, or from the CLI. A
**Command** is immediate (no queue: an offline computer answers "unreachable"), runs in the
machine owner's login shell from their home directory with no stdin, is bounded by a timeout, and
leaves one audit row per machine. Nothing is a sandbox and the surface says so before every run.

```
 FLEET HUB › Commands                                                       [FLEET_COMMANDS_ENABLED]
 ──────────────────────────────────────────────────────────────────────────────────────────────
 ┌ Run a command ─────────────────────────────────────────────────────────────────────────────┐
 │ $ git -C ~/code/api status --short                                                         │
 │ On:  [✓] build-01   [✓] build-02   [ ] design-mac (management is off — start with --manage) │
 │      [ ] win-lab (offline, last seen 2 h ago)   Timeout [10 min ▾]   Folder [home ▾]        │
 │ ⚠ These are real machines, not a sandbox. The command runs as you, in your login shell.     │
 │                                                                              [ Run on 2 ]   │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌ build-01 ────────────────────────── ✓ 0.8 s ┐ ┌ build-02 ──────────────────── Exit 128 · 1.2 s ┐
 │  M src/billing/invoice.ts                    │ │ fatal: not a git repository: ~/code/api        │
 │ ?? src/billing/__tests__/invoice.spec.ts     │ │                                                │
 │                            [Expand] [Copy]   │ │                            [Expand] [Copy]     │
 └──────────────────────────────────────────────┘ └────────────────────────────────────────────────┘
 1 of 2 failed · 1.2 s                                                 [Open full output] [Clear]
 RECENT   git -C ~/code/api status --short · pnpm -v · df -h · uptime · …   (last 8)
```

| Phase  | Ships                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The Command and its runs; the hub Commands tab with live output cards; audit; errors; kill switch; CLI `fleet commands run` |
| **P2** | Agent tool `fleet_commands_run`; "Run a command…" from a computer page; full output as an operation; cancel                 |
| **P3** | Folder picker from Checkouts (FL-14) and a Command re-run from history; a Command with a cadence hands over to FL-13        |

---

## 1. Overview

Today a machine can run work for an Agent, but the owner cannot ask it a question. "Is the disk
full on both build boxes?", "What version of the runtime is on each machine?", "Pull the latest on
every checkout" — each is a shell command and a glance at its output, and each means walking to
the machine or opening a remote shell by hand. This epic adds **Commands**: one line, N
computers, N output cards. Every run is explicit (a dialog names the machines, the shell, the
user and the timeout), permissioned (the Node's `commands` family), confirmed (a `confirm` class
dialog on every run), audited (`node.command.run` per machine) and stoppable (the kill switch and
"drain all" end it). The output is kept on the machine (10 MiB per run, last 30 runs) with the
first and last 64 KiB stored by the platform so a card can be read later without the machine.

A Command is **immediate**. There is no queue and no retry: a computer that is offline, or whose
link is down, fails that machine's run as `unreachable` on the spot and says when it was last
seen. A Command **with a cadence** is a Schedule and belongs to FL-13; this epic only reserves the
columns and never shows a cadence control.

---

## 2. Why now

### 2.1 The user's question

> _"Run this on all three build machines and show me what each one said."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                 | Today they must…                                                                                              | What breaks                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "What is on that machine right now?"       | Open the Agent's Computer tab and switch to the terminal channel — one machine, one shell, typed by hand.     | The node shell exists only as a live view of a single machine (`apps/node/src/core/screen/terminal-channel.ts:5-21`), is read-only while watching, and leaves no record of what was asked or answered.                                                                               |
| "Run it on all of them."                   | Repeat the above per machine, or SSH from a laptop.                                                           | The node has four job kinds — `acceptance-checks`, `agent-task`, `browser-check`, `computer-session` (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-120`) — none of which is "a command the owner typed". The platform holds no machine credential and must not (README D2). |
| "Who ran what on my machine?"              | Nothing.                                                                                                      | The audit ledger exists and is the single writer for every fleet action (`packages/agent/src/fleet/fleet-audit.service.ts:64-72`) but has no command action (`packages/contracts/src/fleet/fleet-panic.types.ts:60-114`).                                                            |
| "Let the Agent check the machines for me." | The Agent has one read-only tool, `list_fleet_nodes` (`packages/agent/src/fleet/agent-fleet-tools.ts:39-77`). | It can list machines and nothing more; the CLI has no fleet command group at all (`apps/cli/src/main.ts:22-26`).                                                                                                                                                                     |

### 2.3 Why this epic is additive only

Nothing is removed or renamed. `FleetJob` stays the unit of leased, durable work; a Command is an
**ephemeral link request** (CONTRACTS §12) with its own two tables, so the lease protocol, the
runner pill and the job history are untouched. The existing terminal channel keeps its role as a
live view. "Command" is the program's canonical noun (README §1): never "run", "job" or "task".

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Run on two computers.**
  **Given** `build-01` and `build-02` are online with management switched on,
  **when** the owner types `df -h` on the Commands tab, keeps both preselected, and clicks
  **Run on 2**, confirming the dialog,
  **then** two output cards appear within 500 ms, each fills with lines as they arrive, each ends
  with a green tick and a duration or a red `Exit N`, a summary line reads _"All done · 0.9 s"_ or
  _"1 of 2 failed · 1.2 s"_, and the command is first in **Recent**.

- **S2 — A machine cannot take it.**
  **Given** `design-mac` is online without `--manage` and `win-lab` is offline,
  **when** the owner opens the Commands tab,
  **then** both are listed unticked and greyed, with the reason beside the name — _"management is
  off — start the node with --manage"_ and _"offline · last seen 2 h ago"_ — and neither can be
  ticked.

- **S3 — Read it later.**
  **Given** a Command ran yesterday and `build-02` is now offline,
  **when** the owner opens that Command from **Recent**,
  **then** each card shows the stored head and tail of its output, says _"first 64 KiB and last 64
  KiB shown"_ when the output was truncated, and **Open full output** is disabled on the offline
  machine with _"the full output is on build-02, which is offline"_.

- **S4 — An Organization member runs it.**
  **Given** the owner of `build-01` has set the `commands` family to **org-admins**,
  **when** an Organization admin runs a Command on it,
  **then** it runs as the **machine owner's** login on the machine, the audit row names the admin
  as the actor and the owner as the owner scope, and an Organization member who is not an admin
  sees `build-01` greyed with _"the owner of build-01 allows only org admins to run commands"_.

- **S5 — An Agent runs a Command (P2).**
  **Given** Agent `Nina` holds the `fleet_commands_run` tool and the trust ladder puts _Run
  commands on a computer_ at **Ask** for her,
  **when** she calls it for `build-01`,
  **then** a decision appears in My Decisions naming the computer, the command and the shell;
  approving it runs the Command with `requestedBy: agent:<Nina>` in the audit row and the output
  is returned to her as the tool result (head and tail, with the exit code).

- **S6 — From the CLI (P1).**
  **Given** the owner is signed in to the CLI,
  **when** they run `ever-works fleet commands run --on build-01,build-02 -- uptime`,
  **then** each machine's output streams to the terminal prefixed by its name, the process exits
  `1` if any machine failed, `124` if any timed out, and `--json` emits one object per machine
  with the same shape the web uses.

### 3.2 Edge cases and failures

- **U1 — Timeout.** A command that passes its timeout (default 10 min, maximum 60 min) is
  terminated on the machine, the card ends with _"Timed out after 10:00"_, the run status is
  `timeout`, and the stored tail holds what was printed before the end.
- **U2 — The link drops mid-run.** The card shows _"Connection to build-01 lost — the command may
  still be running there"_; when the link returns within 2 minutes the node reports the exit and
  the tail; after that the run is marked `failed` with reason `link-lost` and the full output stays
  on the machine for **Open full output**.
- **U3 — Kill switch.** When the fleet kill switch is on, **Run** is disabled with the kill-switch
  banner and reason; a run attempted anyway is refused with `kill_switch`. Commands in flight are
  stopped on the machine within 10 seconds, each card reading _"Stopped by the fleet kill switch"_,
  each run ends `failed` with reason `kill-switch`, and an audit row `node.command.cancel` is
  written with that reason.
- **U4 — Permission denied server-side.** A caller outside the `commands` audience who calls the
  API directly is refused with `permission_denied` and the hint _"ask the owner of build-01 to allow
  org admins: commands"_; the UI never shows a tickable machine the server would refuse.
- **U5 — Over the limit.** A timeout above 3 600 s (CONTRACTS §10), a command longer than 8 KiB,
  more than 50 machines, or a 9th concurrent Command for one owner (the last three proposed in §8b)
  is refused with `limit_exceeded` naming the limit.
- **U6 — Output flood.** A command printing faster than the machine can send is capped at 10 MiB
  per run on the machine; the card says _"Output capped at 10 MiB"_ and the exit code is still
  reported.
- **U7 — Shell could not start.** When the login shell cannot be spawned, that machine's run is
  `failed` with reason `shell-failed`, the error `operation_failed` and the first line of the error
  as the hint.
- **U8 — Consent missing on one machine of many.** A multi-machine run is accepted; the machine
  without `--manage` fails its own run immediately as `consent_missing` with the hint, the other
  machines run normally, and the summary counts the refused machine as a failure.
- **U9 — Drain all.** "Drain all" ends in-flight Commands like it ends Runs today; each run ends
  `failed` with reason `drain` and its card reads _"Stopped — the fleet is draining"_.
- **U10 — The node restarts.** A node restart mid-run ends that machine's run `failed` with reason
  `node-restart`; the stored tail is whatever arrived.

---

## 4. Functional requirements

### 4.1 The Command (P1)

- **FR-1** A Command MUST carry one command line (≤ 8 KiB), a set of 1–50 target computers (both
  bounds proposed for CONTRACTS §10, see §8b), an optional folder (default: the machine owner's
  home), and a timeout (default 600 s, clamp 1–3 600 s, CONTRACTS §10).
- **FR-2** The system MUST run a Command in the machine owner's **login shell** as that user —
  PowerShell on Windows, the account's login shell elsewhere — with no stdin attached.
- **FR-3** A Command MUST be delivered only over the node link and MUST fail `unreachable` for a
  computer that is offline or whose link is down; it MUST NOT be queued or retried.
- **FR-4** A Command MUST produce one run per target computer, each with a start time, an end
  time, an exit code or a reason, a status from `running · done · failed · timeout` (CONTRACTS
  §4.4; the two `skipped-*` statuses belong to Schedules, FL-13) and, for `failed`, a reason from
  `link-lost · node-restart · kill-switch · drain · shell-failed`.
- **FR-5** Output MUST stream to the viewer as it arrives, MUST be capped at 10 MiB per run on
  the machine, and the platform MUST store the first and last 64 KiB of each run with a truncation
  marker.
- **FR-6** The machine MUST keep the full output of its last 30 runs so **Open full output** can
  fetch it while the machine is online.
- **FR-7** A Command whose timeout elapses MUST be terminated on the machine within 5 seconds and
  recorded as `timeout`.
- **FR-8** A Command MUST NOT carry a cadence in this epic; the cadence, name and enabled fields
  exist only so FL-13 can add Schedules without a second table.

### 4.2 Permission, consent, confirmation, audit (P1)

- **FR-9** Running a Command MUST require the `manage` consent on the target computer and MUST be
  refused with `consent_missing` and the hint _"start the node with --manage on <computer>"_ when
  it is absent.
- **FR-10** Running a Command MUST be allowed only to callers inside the computer's `commands`
  family audience (default: the owner), refused server-side with `permission_denied`.
- **FR-11** Every run MUST be preceded by a `confirm` class dialog that names the command, the
  computers, the shell and the user, and states _"These are real machines, not a sandbox."_
- **FR-12** Every run MUST write one `node.command.run` audit row per computer within 2 seconds,
  with `family: commands`, `target: <commandId>`, `requestedBy` (`user:<id>` or `agent:<id>`),
  `confirmationClass: confirm` and the outcome; a cancel MUST write `node.command.cancel`.
- **FR-13** Audit rows and stored output MUST pass the platform's secret redaction before they are
  written; the command line itself MUST be redacted before storage when it trips the scanner.
- **FR-14** When the kill switch is on, new Commands MUST be refused with `kill_switch` and
  in-flight Commands MUST be stopped on the machine within 10 seconds.

### 4.3 The hub surface (P1)

- **FR-15** The Commands tab MUST preselect every online computer with `manage` on, and MUST list
  every other computer unticked with the reason it cannot be chosen.
- **FR-16** The tab MUST show one output card per computer, filling live, and a summary line with
  the count of failures and the longest duration.
- **FR-17** The tab MUST keep the last **8** one-off Commands as **Recent**, each re-openable with
  its stored cards and re-runnable with one click (re-run opens the confirm dialog).
- **FR-18** A card MUST offer **Expand**, **Copy**, and **Open full output** (disabled with the
  reason when the machine is offline).

### 4.4 Agent, MCP and CLI (P1 CLI, P2 Agent)

- **FR-19** The CLI MUST offer `ever-works fleet commands run --on <a,b> [--timeout <s>] [--cwd <dir>] [--json] -- <cmd>` exiting `0` when every machine succeeded, `1` when any failed, `2` on
  usage error and `124` when any timed out.
- **FR-20** The Agent tool `fleet_commands_run` MUST be annotated destructive with
  `confirmationClass: confirm`, MUST be callable only when the Agent's grants and trust ladder
  allow it and the computer's `commands` audience includes the Agent's owner, and MUST return the
  same `{ error: { code, hint } }` shape on refusal.
- **FR-21** Every tool and CLI refusal MUST carry the error code and hint from CONTRACTS §8.

### 4.5 Cost and honesty

- **FR-22** The Commands tab MUST state that running a Command spends no model tokens and no
  credits; an Agent-initiated Command's cost is the Agent's Run cost, shown on that Run.

---

## 5. UX

### 5.1 Hub › Commands — loaded

Shown in §0. The composer is a single-line input with history (`↑`), the machine list is a
checkbox row with reasons, the timeout is a menu (1 · 5 · 10 · 30 · 60 min), the folder defaults
to _home_ and accepts a path. **Run on N** opens the confirm dialog:

```
┌ Run on 2 computers? ──────────────────────────────────────────────────────┐
│ $ df -h                                                                   │
│ build-01 · Linux · bash as the machine owner, from ~                      │
│ build-02 · Linux · bash as the machine owner, from ~                      │
│ Timeout 10 min · no input is possible (prompts fail — pass -y)            │
│ ⚠ These are real machines, not a sandbox.                                 │
│                                            [ Cancel ]  [ Run on 2 ]       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.2 States

- **Empty (no computers):** _"No computers yet"_ with **Add computer** (FL-01 enrol hand-off).
- **Nothing runnable:** every machine greyed, the composer disabled, a line _"No computer can
  take a command right now"_ with each reason listed.
- **Loading recent:** eight skeleton chips.
- **Unavailable with reason:** kill-switch banner (FL-01's, with reason); `FLEET_COMMANDS_ENABLED`
  off hides the tab entirely.
- **Error:** a card-level error names the code and hint (_"unreachable — last seen 12 min ago"_).

### 5.3 Computer page (P2)

The computer page `⋯` menu gains **Run a command…**, which opens the hub Commands tab with that
computer the only preselected one. There is no Commands tab on the computer page (CONTRACTS §11.1
fixes the tab list); the computer's Overview shows _"Last command: `uptime` · ✓ · 3 min ago"_.

### 5.4 Keyboard and palette

`⌘/Ctrl+Enter` runs; `Esc` closes the dialog; `↑`/`↓` walk history; `E` expands the focused card;
`C` copies. Palette entries: _"Run a command on…"_ (opens the tab) and one entry per Recent command.

### 5.5 Agent and CLI surfaces

The Agent sees the tool's description, its destructive annotation and the confirm requirement;
the decision card in My Decisions is the §5.1 dialog rendered for a human. The CLI prints
`build-01 ▸ <line>` per line and a final summary identical to the web's.

---

## 6. Non-functional requirements

- **Performance:** first output byte within 1 s of confirming on a LAN; cards update at ≤ 20
  frames/s; the API answers the run request in ≤ 300 ms (202 with the Command id).
- **Reliability:** a link drop never loses the exit code when the link returns within 2 minutes.
- **Security & privacy:** no stdin; the command runs as the machine owner, never as root; output
  and the command line pass secret redaction before storage; no output in logs or audit rows.
- **Observability:** audit rows per machine; metrics `fleet.commands.run` (status), duration
  histogram, truncation counter.
- **Compatibility:** nodes built before this epic refuse the `command` channel with
  `unsupported_on_node`; the UI shows _"update the node on build-01 to run commands"_.

---

## 7. Key entities & concepts

| Entity / concept    | New?     | Description                                                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| **Command**         | **NEW**  | One command line sent to one or more computers, with its folder, timeout, state and — for FL-13 — cadence. |
| **Command run**     | **NEW**  | One computer's execution of a Command: timing, exit, status, stored head and tail, truncation marker.      |
| **Node / Computer** | Existing | The target. Its `commands` family audience and its `manage` consent decide who may run.                    |
| **Fleet audit**     | Existing | Gains `node.command.run` and `node.command.cancel`.                                                        |
| **Operation**       | FL-02    | "Open full output" fetches the machine-held output as an operation.                                        |

---

## 8. Out of scope

- A cadence, name, pause or history view for recurring Commands — FL-13.
- Running as another user, `sudo`, or any elevation (README §3 refusal).
- Interactive commands (stdin), pipes into the command, file upload with the command (FL-11).
- Running inside an Agent's isolated profile — Commands are owner-level by definition.
- A Commands tab on the computer page (the hub tab is the surface; CONTRACTS §11.1).

## 8b. Open questions

- `[NEEDS CLARIFICATION: Should the owner be able to choose the Agent's isolated environment as the shell context for a Command ("run as Nina would")? Default until answered: no — Commands are owner-level and run in the machine owner's login shell.]`
- `[NEEDS CLARIFICATION: Recent is per owner today. Should Organization admins see the owner's Recent on a shared computer, or only their own? Default until answered: each caller sees only the Commands they ran.]`
- **Resolved** by CONTRACTS §4.4: `fleet_command_runs.failedReason` is the enum `link-lost · node-restart · kill-switch · drain · shell-failed`; the status enum is not widened.
- **Resolved** by CONTRACTS rev 5: `failedReason` `cancelled-by-user` (§4.4); `command.output|truncated|timeout` (§3.3); `/commands/:id/cancel` and `/commands/:id/runs/:runId/output` (§11.2); limits 8 KiB / 50 computers / 8 concurrent (§10); 10 runs per minute (§10.1).

---

## 9. Acceptance criteria

- [ ] **ACC-FL12-01** (FR-1, FR-15) The Commands tab preselects online managed computers and greys the rest with a reason.
- [ ] **ACC-FL12-02** (FR-2) A run on Linux uses the owner's login shell from home; on Windows it uses PowerShell; stdin is closed (a `read` returns EOF).
- [ ] **ACC-FL12-03** (FR-3) A Command to an offline computer fails `unreachable` immediately with the last-seen hint; nothing is queued.
- [ ] **ACC-FL12-04** (FR-4, FR-16) One card per computer fills live and ends with ✓ and duration or `Exit N`.
- [ ] **ACC-FL12-05** (FR-5, FR-6, U6) A 20 MiB output is capped at 10 MiB on the machine, the platform stores 64 KiB head and tail, and Open full output fetches the capped file.
- [ ] **ACC-FL12-06** (FR-7, U1) A `sleep 700` with the default timeout ends `timeout` at 600 s with the tail intact.
- [ ] **ACC-FL12-07** (FR-9) A computer without `--manage` refuses with `consent_missing` and the exact hint.
- [ ] **ACC-FL12-08** (FR-10, S4) An org member outside the audience is refused server-side with `permission_denied`; the UI never offers that machine.
- [ ] **ACC-FL12-09** (FR-11) The confirm dialog contains the sandbox sentence verbatim and names shell and user.
- [ ] **ACC-FL12-10** (FR-12, FR-13) One audit row per computer with the required fields; a command containing a token-shaped string is stored redacted.
- [ ] **ACC-FL12-11** (FR-14, U3) Kill switch on: new runs refused `kill_switch`; an in-flight `sleep 60` is stopped within 10 s, ends `failed` with reason `kill-switch`, and writes `node.command.cancel`.
- [ ] **ACC-FL12-12** (FR-17) Recent holds exactly the last 8 Commands and re-run opens the dialog.
- [ ] **ACC-FL12-13** (FR-19, S6) The CLI exits 0/1/2/124 as specified and `--json` matches the web shape.
- [ ] **ACC-FL12-14** (FR-20, S5) The Agent tool is refused for an Agent outside the audience, and runs with `requestedBy: agent:<id>` when allowed.
- [ ] **ACC-FL12-15** (FR-22) The tab states that Commands spend no tokens or credits.
- [ ] **ACC-FL12-16** Every user-visible string is an i18n key under `fleet.commands.*` / `fleet.errors.*`.
- [ ] **ACC-FL12-17** (FR-8) No cadence, name or enabled control is shown or accepted on a one-off Command; a request carrying `cadence` is left to FL-13's validation.
- [ ] **ACC-FL12-18** (FR-18) Each card offers Expand, Copy and Open full output; Open full output is disabled with the offline reason when the machine is offline.
- [ ] **ACC-FL12-19** (FR-21) Every tool and CLI refusal carries the CONTRACTS §8 code and the same hint as the web.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration; the shell is the machine's own. Not applicable.
- [x] **II — Capability-driven.** No provider is named; the node module advertises `managed`.
- [x] **III — Source-of-truth repos.** No work content is stored; only output head/tail and audit.
- [x] **IV — Job runtime.** Commands are ephemeral link requests by design (CONTRACTS §12); no long-running work is added to the API process.
- [x] **V — Forward-only migrations.** Two additive migrations in the reserved slots.
- [x] **VI — Tests.** Unit, controller, node and Playwright coverage named in tasks.
- [x] **VII — Secrets.** Output, command line and audit details pass redaction; nothing is logged.
- [x] **VIII — Plugin counts.** No plugin. Not applicable.
- [x] **IX — Behaviour-first.** No code or paths in this document.
- [x] **X — Backwards compatibility.** New tables, new audit values, new tool; nothing changed.

---

## 11. References

- Program: [Fleet README](../README.md) · [CONTRACTS](../CONTRACTS.md) §0 R-11, R-24, R-33, R-39, R-40; §1; §2; §3.2 link controls; §3.3 `command`; §4.4; §7; §8; §9; §10; §11 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) D "Run a command on N machines"
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related epics: [FL-02 Node link](../FL-02-node-link/), [FL-13 Schedules on computers](../FL-13-schedules-on-computers/), [FL-19 Agent, MCP & CLI](../FL-19-agent-mcp-cli/)
- Constitution: `.specify/memory/constitution.md`
