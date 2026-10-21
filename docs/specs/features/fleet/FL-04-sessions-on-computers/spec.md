# FL-04 — Sessions on computers: daemon, start dialog, attach, terminal, recording

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code except where §2 cites what exists today. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-04-sessions-on-computers`
**Program:** [Fleet](../README.md) · Wave 1 (the flagship)
**Branch:** `feat/fl-04-sessions-on-computers`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** XL · **Blocked by:** FL-02 (node link, `--manage`) · **Related:** FL-01 (hub, computer page shell, module registry), FL-05 (status, attention, board — owns the session card), FL-06 (git line, actions), FL-14 (checkouts, new worktree), FL-19 (tool parity), FL-20 (cost), AW-11 (Agent computers — its P3 terminal recording closes here)
**Extends (existing Ever Works nouns):** Node · Fleet · Agent · Run · Task · Checkout · Inbox · Activity · Organization

---

## 0. TL;DR

Today a Node can run an Agent **headlessly** — one Task, one `claude -p`, one result — and an owner can **watch** a read-only shell on it. What nobody can do is **start Claude Code, Codex or a plain shell on a computer they own and leave it running**: close the laptop, come back from lunch, open the same session from a phone, type into it, hand it to a colleague to watch, and have it still be there after the node upgraded itself. This epic adds that. A **session daemon** on the Node owns every terminal process and its screen, so a session outlives the node process, the link, and every browser tab; the platform keeps one `FleetSession` row per session so it can be listed, attached, renamed, ended and recorded from anywhere. Two kinds, two isolation models (README D14): an **owner session** runs as the person, in their own login, with their own CLI configuration; an **Agent session** runs under the isolation Task runs already enforce and owns exactly one Run.

```
 /fleet/sessions/9f2c  ──────────────────────────────────────────────────────────────────────────
 ← build-01 · Sessions     ◐ Nina · claude · "api tests"        working 12 min      [Rename] [⋯]
 Agent session · acme/api · ~/code/api  (worktree fl/api-tests)   started 09:41 by you    [End]
 ┌ git line slot (FL-06) ─────────────────────────────────────────────────────────────────────┐
 ┌ attention slot (FL-05) ────────────────────────────────────────────────────────────────────┐
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ $ pnpm test                                                                              │
 │  PASS  src/billing/invoice.spec.ts                                                       │
 │  RUNS  src/billing/refund.spec.ts                                                        │
 │ ⏺ Running the remaining suites…                                                          │
 │                                                                                          │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
 You are driving · 2 watching (Ops, Dana) · 120×40 · recording ●   [Watch only] [Re-watch] [?]
 ┌ Send to Nina ───────────────────────────────────────────────────────────────────┐ [Send ↵]
```

Three phases, each independently shippable:

| Phase  | Ships                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The session daemon; **owner sessions** (shell, Claude Code, Codex) under `--manage`; the start dialog (computer → kind → agent/shell → folder); attach as viewer or driver through the one Terminal pane; rename / end from every surface; the computer page **Sessions** tab and the `/fleet/sessions/[id]` detail; limits; link loss and node restart handling; kill switch and drain; audit |
| **P2** | **Agent sessions** under `--work`: the `agent-session` job kind, one Run per session (trigger `session`), the Task-run isolation reused unchanged, first message, restart, the "new worktree" option when Checkouts (FL-14) is present, Agent tools, `ever-works fleet session attach`                                                                                                         |
| **P3** | **Terminal recording** into the existing transcript store keyed by session, the record toggle, **re-watch** on the session detail, retention — closing AW-11 P3's terminal half                                                                                                                                                                                                                |

---

## 1. Overview

A **Session** is a persistent interactive process on a Node — an agent CLI or a shell — that keeps running when nobody is watching. It is started from the Fleet hub, a computer page, an Agent page, the Agent tools or the CLI; it is seen on the computer page's Sessions tab, on the Sessions board and list (FL-05), on the Agent's page, and on its own detail page; it is attached to through the same Terminal pane that already renders cloud Runs and the Computer tab's shell (CONTRACTS R-21); it is renamed, restarted and ended from every surface that shows it, in one click, with the same confirmation (README rule 17).

The thing that makes a session persistent is the **session daemon**: a separate long-lived process the node starts and supervises on the machine. It owns every session's terminal process, keeps a headless picture of each terminal so a late viewer gets the screen replayed rather than a blank pane, remembers titles and metadata across node restarts and upgrades, and never exits while a session exists. The node talks to it over a local socket protected by a token; nothing else on the machine can.

An **owner session** is a person using their own machine through Ever Works: it runs as them, in their login shell, with their CLI configuration, MCP servers and memory — exactly as if they sat at the keyboard — and only a per-session hook overlay is added (FL-05). An **Agent session** is an Agent driving an interactive CLI on a Node: it runs under the isolation Task runs already enforce on the node (relocated CLI configuration and home directories, a strict MCP configuration, a scrubbed environment, the Agent's own browser profile), never inherits the machine owner's MCP servers or plugins, and owns exactly one Run that carries its cost and its card. The start dialog makes the kind explicit; every surface labels each session with it.

Every state-changing act on a session is permissioned by the Node's control policy, confirmed where it destroys something, audited, and stoppable by the kill switch and the panic controls (README D7, CONTRACTS R-24). The node refuses an owner session without `--manage` and an Agent session without `--work`, naming the missing consent (CONTRACTS R-5).

---

## 2. Why now

### 2.1 The user's question

> _"Start Claude Code on build-01 in the api checkout, let it run the migration while I'm out, and let me look in from my phone."_

And later:

> _"Show Ops what Nina is doing on that machine — read-only — and let me type one thing into it when it gets stuck."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                       | Today they must…                                                        | What breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run Claude Code on my machine."                 | Assign a Task to an Agent whose affinity pins it to the Node.           | The node runs the CLI **headless and non-interactive** — `-p` with a JSON or stream-JSON output format (`apps/node/src/core/executors/model-cli.ts:634-641`). There is no interactive session, nothing to type into, and the run ends when the CLI prints its result. The owner's own account, plugins and MCP servers are deliberately kept out (`apps/node/src/core/executors/agent-task.ts:1382-1392`), which is right for a Task run and wrong for "me, on my machine". |
| "Open a shell on that computer."                 | Open the Agent's Computer tab and switch to the terminal channel.       | That shell is **read-only by construction** — its inbound leg yields nothing (`apps/node/src/core/screen/terminal-channel.ts:17-19`, `:100-103`) — and it lives only as long as the live view: the executor stops it when the view ends (`apps/node/src/core/executors/computer-session.ts:42-47`). Nothing persists.                                                                                                                                                       |
| "Let it keep running while I close the browser." | Nothing.                                                                | A `computer-session` ends 15 s after its last viewer leaves (`apps/api/src/computer/computer-ws.service.ts:46-48`). A cloud Run's Terminal tab is a job-runtime worker's PTY keyed to the Run (`docs/features/agent-terminals.md:148`), not a process on the owner's machine. No process on a Node survives its viewer.                                                                                                                                                     |
| "Come back to the same screen later."            | Nothing.                                                                | Only the relay's in-memory scrollback exists, and it dies with the API replica (`docs/features/agent-terminals.md:163`). No node-side terminal grid exists; a reconnecting viewer gets whatever frames arrive next.                                                                                                                                                                                                                                                         |
| "Survive the node upgrading itself."             | Nothing (EXISTING-SUBSTRATE §1.14 "No persistent interactive session"). | Every process the node runs is a child of the node process; the job executors drain and stop on shutdown (`apps/node/src/core/executors/computer-session.ts:44-47`). No separate supervisor exists on the machine.                                                                                                                                                                                                                                                          |
| "List the sessions on my computers."             | Nothing (EXISTING-SUBSTRATE §2.13, §3.5).                               | The only session-shaped rows are `computer_sessions` (an owner **watching** a Node) and `agent_runs`. Neither is "a process on a Node". `FleetJobKind` is a closed four-value union with no interactive-agent kind (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`).                                                                                                                                                                                            |
| "Keep a record of what the terminal showed."     | Nothing for a Node.                                                     | Terminal transcripts exist, but keyed by Run (`packages/agent/src/entities/terminal-transcript-chunk.entity.ts:38-50`), written only by the cloud worker's relay (`apps/api/src/terminal/terminal-internal.controller.ts:92-150`). AW-11 declared recording and nothing records: `computer_sessions.recorded` has a column and no writer (`packages/agent/src/entities/computer-session.entity.ts:92-98`).                                                                  |
| "Type into it from my own terminal."             | Nothing (EXISTING-SUBSTRATE §8.2).                                      | `apps/cli` has `auth`, `work`, `plugins` and `kb` commands (`apps/cli/src/main.ts:23-26`) and no fleet surface.                                                                                                                                                                                                                                                                                                                                                             |

### 2.3 The gaps this epic closes

1. **There is no process on a Node that outlives its viewer.** Everything the node runs is a child of the node process or of a live view. The session daemon is the missing primitive.
2. **There is no interactive agent on a Node.** The Task-run path is headless by design and must stay so; an interactive kind beside it reuses its isolation and adds a terminal.
3. **The owner cannot use their own machine through the product.** Owner sessions — in the person's own login, with their own CLI configuration — are the sanctioned path for attended work (README D6).
4. **Nothing records a Node's terminal.** The transcript store, its redaction and its retention exist for cloud Runs; keying them by session closes AW-11 P3's terminal half (README D13).

### 2.4 Why this epic is additive only

Nothing is removed or renamed (README rule 1, Non-negotiable #20). The Task-run path (`agent-task`), the Computer tab and its read-only terminal channel, the cloud Run's Terminal tab, the `computer-session` job kind and every existing route keep working exactly as they do. The Terminal pane gains a **source**, not a replacement (R-21). `FleetSession` is one of the three nouns README D5 justifies; `AgentRun.fleetCliSession` keeps holding the provider's own session id for resume (it changes on `/clear`, so it cannot be the key).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Start an owner shell.**
  **Given** `build-01` is online with `--manage` and advertises `sessions`,
  **when** the owner opens its computer page, clicks **New session ▾ → Shell**, keeps the suggested folder (`~`), and confirms,
  **then** within 3 s a session appears on the Sessions tab as `● Shell · ~ · you · just now`, its detail page opens with the prompt visible, and keystrokes typed in the pane reach the shell on `build-01` as the owner's own user.

- **S2 — Start an owner Claude Code session.**
  **Given** `build-01` advertises `claude-code` and `sessions`,
  **when** the owner chooses **New session ▾ → Claude Code**, picks `~/code/api` from **Recent folders**, types _"run the migration tests and fix what fails"_ as the first message, and confirms,
  **then** Claude Code starts **in the owner's own login** with the owner's own configuration, the first message is delivered as its first prompt, and the session is listed as `◐ Claude · api · ~/code/api · working`.

- **S3 — Close the browser; nothing stops.**
  **Given** the owner is attached to S2,
  **when** they close the tab, lose the network for ten minutes, and open the session detail from another device,
  **then** the process never stopped, the pane shows the current screen within 2 s of attaching (replayed, not black), and the last 2 000 lines of scrollback are available to scroll.

- **S4 — Watch, then drive.**
  **Given** Ops (an Organization member) opens the detail of a session on a Node whose `sessions` audience is `org-members`,
  **when** the page opens,
  **then** Ops attaches as a **viewer**: the pane carries a _read-only_ badge, keystrokes never leave the browser, and the footer reads _"Watching · Dana is driving"_. When Ops clicks **Take the keyboard** and the policy allows it, the footer reads _"You are driving"_ within 1 s, Dana sees _"Ops is driving"_ and keeps watching; the daemon sizes the terminal to the newest driver's pane.

- **S5 — Start an Agent session.**
  **Given** Nina is bound to `build-01`, which is online with `--work` and advertises `claude-code` and `sessions`,
  **when** the owner opens **New session ▾** on `build-01`, chooses **Agent · Nina**, keeps **Claude Code**, chooses **a new worktree** of the `acme/api` checkout (offered because Checkouts is present), types the first message and confirms,
  **then** a Run is created with trigger kind `session`, an `agent-session` job is leased by `build-01`, Claude Code starts under the **Task-run isolation** — relocated configuration home, strict MCP configuration, scrubbed environment, Nina's own browser profile — never inheriting the owner's MCP servers or plugins, and the session card shows `Nina · claude · fl/api-tests`.

- **S6 — The Run and the session are one thing.**
  **Given** S5 is running,
  **when** the owner opens the Run's receipt in Activity → Runs,
  **then** it links to the session detail; ending the session from either side ends both; the Run's status follows the session's outcome.

- **S7 — Rename and end from anywhere.**
  **Given** a session is listed on the Sessions tab, the board (FL-05), the Agent page and its detail,
  **when** the owner renames it on one surface,
  **then** every surface shows the new title within 5 s and the title survives a node restart. **When** the owner clicks **End** on any surface, **then** the same confirmation appears — _"End 'api tests' on build-01? The process is stopped; its screen is kept."_ — and the session reads `ended (user)` everywhere within 5 s.

- **S8 — Restart an ended session.**
  **Given** a session ended (exit, user, node restart),
  **when** the owner clicks **Restart**,
  **then** a new session starts with the same kind, agent, folder and title, its card links back to the one it replaced, and the ended one keeps its last screen.

- **S9 — Attach from your own terminal.**
  **Given** the CLI is signed in,
  **when** the owner runs `ever-works fleet session attach 9f2c`,
  **then** the terminal shows the replayed screen, keystrokes drive the session (or watch, with `--watch`), the window size follows the local terminal, and `Ctrl-]` then `d` detaches without ending anything.

- **S10 — Re-watch.**
  **Given** a recorded session has ended,
  **when** the owner opens its detail and clicks **Re-watch**,
  **then** a player replays the stored terminal output with a scrubber, a speed control, and the moments a driver changed marked on the timeline; nothing on the Node is touched.

- **S11 — The Agent starts its own session.**
  **Given** Nina's permissions allow `fleet_sessions_start` and `build-01`'s `sessions` audience includes Nina's owner,
  **when** Nina calls the tool with `nodeId`, `provider: 'shell'` and a folder,
  **then** an **Agent session** starts (never an owner session), is labelled as started by Nina, and appears on every surface with the Agent icon.

### 3.2 Unhappy paths, races, denials and empty states

- **U1 — No `--manage`.**
  **Given** `design-mac` is online but was started without `--manage`,
  **when** the owner opens its Sessions tab,
  **then** the tab shows _"Owner sessions need management switched on for this computer"_ with the exact command `ever-works-node start --manage` and a copy button; **New session** offers only Agent sessions if `--work` is on, and nothing otherwise. The server refuses a direct start with `consent_missing` and the same hint.

- **U2 — No `--work`.**
  **Given** `design-mac` has `--manage` but not `--work`,
  **when** the owner picks **Agent** in the start dialog,
  **then** the kind is disabled with _"Agents need work switched on for this computer — `ever-works-node start --work`"_; a direct start is refused with `consent_missing`.

- **U3 — The daemon is not running.**
  **Given** `--manage` is on but the node does not advertise `sessions`,
  **when** the owner opens the Sessions tab,
  **then** it reads _"The session daemon is not running on build-01"_ with the node's own diagnosis (_"could not bind the local socket"_, _"terminal support is missing — install build tools or use the pipe floor"_) and a **Retry** that asks the node to start it; a start is refused `unsupported_on_node` with that hint.

- **U4 — The computer is offline.**
  **Given** `win-lab` last heartbeated 2 h ago,
  **when** the owner opens its Sessions tab,
  **then** sessions it had are listed as `ended (node-restart)` or `unknown — last seen 2 h ago` (never silently dropped), with their last screens; **New session** is disabled with _"win-lab is offline"_; a start is refused `unreachable` with the hint _"last seen 2 h ago"_.

- **U5 — The link drops mid-session.**
  **Given** the owner is driving and the node's link drops,
  **when** 3 s pass without frames,
  **then** the pane dims with _"Reconnecting to build-01…"_, keystrokes are held (not sent, not lost: the composer shows them), and when the link returns within the reconnect window the daemon replays the screen, held input is offered as _"Send what you typed while offline?"_ (never auto-sent), and the session never left `working`. The process on the machine never noticed.

- **U6 — Permission denied.**
  **Given** `build-01`'s `sessions` audience is `owner` and Ops is an Organization member,
  **when** Ops opens the computer page,
  **then** the Sessions tab lists nothing and reads _"Only the owner of build-01 can see its sessions"_; a direct list or attach is refused `permission_denied` with the hint _"ask the owner of build-01 to allow org members: sessions"_.

- **U7 — Owner session limit.**
  **Given** `build-01` already has 8 owner sessions,
  **when** a ninth is requested,
  **then** it is refused `limit_exceeded` — _"build-01 already has 8 sessions. End one to start another."_ — listing them with their starters.

- **U8 — Viewer limit.**
  **Given** a session already has 5 live viewers,
  **when** a sixth attaches,
  **then** the attach is refused `limit_exceeded` naming the five.

- **U9 — Agent session limit.**
  **Given** `build-01`'s `--concurrency` is 2 and two Agent sessions are live,
  **when** a third Agent session is requested,
  **then** the start is accepted and **queued** like any job, the card reads _"Waiting for a free slot on build-01"_, and the owner may cancel it from the card.

- **U10 — Two drivers.**
  **Given** Dana is driving,
  **when** Ops clicks **Take the keyboard**,
  **then** Ops gets it if the policy allows — there is no exclusive lock on a terminal — and both footers update; the audit records both driver spans. _(A terminal is a shared keyboard; the exclusive-control rules belong to the Desktop, FL-07.)_

- **U11 — The kill switch is on.**
  **Given** the fleet kill switch is thrown,
  **when** anyone opens a session,
  **then** the pane shows the stop banner the rest of Fleet shows, **input is blocked** on the daemon (the process is left running), no session starts, and the footer reads _"Paused by the fleet stop — Investigating a runaway job"_. Clearing the switch resumes input with no reconnect.

- **U12 — Drain all.**
  **Given** the owner presses **Drain all** under Settings → Fleet,
  **then** every owner session shows a 60 s warning in its pane and on its card — _"This session ends in 0:60 (fleet drain)"_ — and is ended with reason `drain`; Agent sessions end as their Runs are cancelled today.

- **U13 — Node restart.**
  **Given** `build-01` reboots (the daemon dies with it),
  **when** the node comes back and finds no live daemon,
  **then** every session the platform lists for `build-01` becomes `ended (node-restart)` within one heartbeat, its last persisted screen is kept and shown, and the card offers **Restart**. **When** only the node process restarted (an upgrade) and the daemon is alive, **then** the sessions are re-listed unchanged and no viewer is told anything.

- **U14 — Process exits.**
  **Given** a shell session's process exits 0,
  **then** the session reads `ended (exit)` with the last screen; a non-zero exit shows _"exited with code 1"_ in the pane and the state the status pipeline derives (FL-05). Nothing is removed.

- **U15 — Daemon storage is full.**
  **Given** the daemon cannot persist a session's metadata,
  **then** the session still starts, the card carries _"Title may not survive a restart — disk is full on build-01"_, and the node's health reports it.

- **U16 — Slow viewer.**
  **Given** a viewer's connection cannot keep up with output,
  **then** that viewer is **dropped** with _"You fell behind — reattach to catch up"_ and no other viewer or the process is stalled.

- **U17 — Starting in a folder that does not exist.**
  **Given** the owner types a folder path that is missing on the Node,
  **then** the start is refused `invalid` with _"~/code/apu does not exist on build-01"_ and the dialog keeps every other choice.

- **U18 — A Windows computer.**
  **Given** `win-lab` has `--manage`,
  **when** the owner starts a shell,
  **then** the session runs PowerShell 7 if present, else Windows PowerShell, with a real console; the daemon runs as the enrolling user.

- **U19 — Recording storage is unavailable.**
  **Given** recording is on and the transcript store refuses writes,
  **then** the session continues, the footer reads _"Not recording — storage is unavailable"_, and the detail later says so instead of showing an empty player.

- **U20 — Org access revoked mid-attach.**
  **Given** Ops is attached and their membership is revoked,
  **then** their socket closes within 30 s with _"You no longer have access to this computer"_; the session is untouched.

---

## 4. Functional requirements

Every default, limit and cadence is a number. Limits are CONTRACTS §10 values; none is re-derived here.

### 4.1 P1 — The session daemon

- **FR-1** The node MUST start and supervise a **separate long-lived daemon process** on the machine that owns every session's terminal process; the node process MUST NOT be the parent of any session process.
- **FR-2** The daemon MUST keep running while at least one session exists, across node restarts and node upgrades, and MUST exit on its own only when no session exists and no node has connected for 5 minutes.
- **FR-3** The daemon MUST accept connections only over a local socket (Unix domain socket on macOS and Linux, named pipe on Windows) owned by the enrolling user and protected by a token the node reads from a file only that user can read.
- **FR-4** The daemon MUST keep a headless terminal picture per session with **10 000 lines** of scrollback and MUST replay the current screen plus the last **2 000 lines** to every new attach, so an attach never shows a blank pane while the process is alive.
- **FR-5** The daemon MUST answer terminal queries (cursor position, colours) itself when no viewer is attached, so a program waiting for a reply never hangs.
- **FR-6** The daemon MUST size a session's terminal to the **newest driver's** pane and MUST ignore viewer sizes.
- **FR-7** The daemon MUST drop a viewer whose output cannot be delivered within 5 s rather than stalling the process or other viewers.
- **FR-8** The daemon MUST persist each session's title, kind, provider, folder, start time and starter on the machine, and MUST persist the last screen of a session at most 30 s after it changed and at exit, so a session that ends while nothing is attached still has a final screen.
- **FR-9** The daemon MUST report `EXIT` with the process exit code when a session's process ends, and MUST keep the ended session's screen available until the node confirms the platform has it.
- **FR-10** The node MUST advertise the `sessions` capability tag only while the daemon is running and answers a health request, and MUST withdraw it on the next heartbeat otherwise.
- **FR-11** When the node starts and finds **no live daemon**, it MUST report every session the platform still lists for it as `ended` with reason `node-restart`, carrying the last persisted screen; when it finds a live daemon it MUST re-list the daemon's sessions and report them unchanged.

### 4.2 P1 — Owner sessions

- **FR-12** An owner session MUST run as the enrolling user, in that user's login shell, with that user's own CLI configuration, MCP servers and memory, and the node MUST add nothing but the per-session hook overlay (FL-05) and the terminal environment variables.
- **FR-13** The node MUST refuse an owner session when `--manage` is off, with `consent_missing` and the hint naming the command.
- **FR-14** A session's provider MUST be one of `shell`, `claude-code`, `codex`; the start dialog MUST mark which agent CLIs the Node advertises and MUST refuse a provider the Node does not advertise with `unsupported_on_node`.
- **FR-15** A session MUST start in the folder the user chose; the dialog MUST offer the Node's checkouts (when Checkouts is present), the folders of the Node's last 10 sessions, and a typed path; a missing folder MUST be refused `invalid` naming the path.
- **FR-16** At most **8** owner sessions MAY exist per Node; a ninth MUST be refused `limit_exceeded` listing the existing ones.
- **FR-17** A first message, when given for an agent provider, MUST be delivered as the CLI's first prompt and MUST be stored redacted as the session's preview.
- **FR-18** Ending a session MUST stop its process (terminate, then kill after 5 s), keep its last screen, set `endedReason` to the cause, and MUST be the same act from every surface with the same confirmation text.
- **FR-19** Renaming a session MUST update every surface within 5 s and MUST survive a node restart.
- **FR-20** Restarting an ended session MUST start a new session with the same kind, provider, folder and title, link the two, and leave the ended one intact.

### 4.3 P1 — Attach, viewer and driver

- **FR-21** Attaching MUST ride the node link's `session` channel family and the viewer attach path (CONTRACTS §3.3–3.4); a viewer MUST never connect to a Node.
- **FR-22** A viewer MUST receive output and resize notices and MUST NOT be able to send input; the pane MUST carry a read-only badge and the hook MUST refuse keystrokes client-side as the relay refuses them server-side.
- **FR-23** A driver MUST send input and resize; several drivers MAY exist at once; the footer MUST name who is driving.
- **FR-24** At most **5** live viewers MAY attach to one session; a sixth MUST be refused `limit_exceeded`.
- **FR-25** Attaching MUST show the replayed screen within 2 s of the socket opening when the link is up.
- **FR-26** A link drop MUST NOT end a session; the pane MUST show a reconnecting state within 3 s, hold typed input visibly, and offer — never auto-send — the held input after reconnect.
- **FR-27** The session detail page MUST render the terminal through the **one** Terminal pane the product already has, with a source that names the session; no second renderer MAY be introduced.
- **FR-28** The session detail MUST carry a header (icon · title · state glyph · computer · kind · provider · folder · starter · elapsed), a slot for the git line (FL-06), a slot for attention (FL-05), the terminal, a footer (role · watchers · size · recording), and — for agent providers — a composer that sends a line of text as input followed by Enter.

### 4.4 P1 — Surfaces

- **FR-29** The computer page MUST have a **Sessions** tab, registered through the Fleet module registry, listing that Node's sessions with the shared session card in its compact layout (anatomy owned by FL-05, CONTRACTS R-22), grouped `live · ended`, most recently active first.
- **FR-30** The computer page header's **New session ▾** MUST open the start dialog with the computer preselected.
- **FR-31** The Agent page MUST list the Agent's sessions beside its Runs with the same card and the same actions.
- **FR-32** Every surface that shows a session MUST offer **Open**, **Rename**, **End** (and **Restart** when ended) in its row menu.
- **FR-33** Every tab, dialog and card MUST state the missing consent, the offline state or the missing daemon in words, with the exact command to run, never a generic error.

### 4.5 P1 — Safety, permissions, audit

- **FR-34** Starting, listing, attaching, renaming and ending MUST be checked against the Node's `sessions` family audience; listing and attaching as a viewer MUST be refused to anyone outside it with `permission_denied`.
- **FR-35** Every start, restart, attach, driver span, rename, end and recording toggle MUST write one fleet audit row within 2 s with the action names in §7, the session id as target, the requester, and the confirmation class; a driver span MUST be one row (start and end), never one row per keystroke.
- **FR-36** Audit rows MUST never contain terminal bytes, typed input, the first message, or any secret.
- **FR-37** While the kill switch is on, every session request MUST be refused `kill_switch`, every daemon session's input MUST be blocked with the process left running, and every pane MUST show the stop banner with its reason.
- **FR-38** **Drain all** MUST end owner sessions after a visible 60 s warning with reason `drain` and MUST end Agent sessions as it cancels Runs today.
- **FR-39** A Node that is paused, disabled or draining MUST refuse new sessions, naming its state.
- **FR-40** Losing access mid-attach (membership revoked, Node removed) MUST close the viewer's socket within 30 s.
- **FR-41** Session starts MUST be rate-limited to 10 per minute per user and attaches to 30 per minute per user.

### 4.6 P2 — Agent sessions

- **FR-42** An Agent session MUST create exactly one Run with trigger kind `session`, referencing the session; the Run MUST carry the cost, receipts and the Sessions board card, and ending either MUST end both (CONTRACTS R-1).
- **FR-43** An Agent session MUST be delivered as a durable `agent-session` job leased by the Node's work lane and counted against its `--concurrency` exactly like `agent-task` (CONTRACTS R-28), so it survives platform restarts and queues when the slots are full; the card MUST say it is waiting.
- **FR-43a** An Agent session MUST honour the model usage limits that already exist for Task runs (EXISTING-SUBSTRATE §1.8, §2.6): a Node whose chosen CLI is throttled MUST NOT lease the session, which waits with the existing `model-usage-limit` reason, and the card MUST read _"Waiting for Claude Code's limit to reset at 03:00"_; no second throttle mechanism MAY be added.
- **FR-44** An Agent session MUST run under the Task-run isolation the node already enforces — relocated CLI configuration home, strict MCP configuration (the platform bridge or an empty configuration), the owner-configuration isolation Codex runs already have (shipped 2026-10-16, EXISTING-SUBSTRATE §1.7), scrubbed environment, the Agent's own browser profile — **reusing that code path unchanged**, and MUST differ only in launching the CLI interactively inside a daemon terminal.
- **FR-45** An Agent session MUST NOT inherit the machine owner's MCP servers, plugins, hooks or CLI configuration; the pane footer MUST say _"Isolated — Nina's own configuration on build-01"_.
- **FR-46** The node MUST refuse an Agent session when `--work` is off, with `consent_missing`.
- **FR-47** Agent sessions MUST run under the Node's permission mode default (`acceptEdits`); any raised mode MUST come from the Agent's trust setting (AW-24) and MUST be shown on the card.
- **FR-48** An Agent session's first message MUST be required (3–4 000 characters) and MUST be redacted before storage.
- **FR-49** When Checkouts (FL-14) is present, the start dialog MUST offer **a new worktree** of a chosen checkout as the folder; the worktree MUST be created through Checkouts before the session starts and MUST be the session's `checkoutId`.
- **FR-50** The Run's provider session id (`fleetCliSession`) MUST be set from the CLI's own session start evidence so resume keeps working; the `FleetSession` id MUST be the stable key.
- **FR-51** A session started by an Agent through a tool MUST always be an Agent session attributed to that Agent, never an owner session.

### 4.7 P2 — Agent tools and CLI

- **FR-52** The `sessions` tool family MUST offer `fleet_sessions_list` and `fleet_sessions_read` (read-only), `fleet_sessions_start`, `fleet_sessions_send`, `fleet_sessions_rename` (state-changing, `plain`) and `fleet_sessions_end` (state-changing, `confirm`), each returning the shared error envelope with a hint.
- **FR-53** `ever-works fleet session attach <id> [--watch]` MUST attach from the user's terminal with raw input, follow the local window size, detach on `Ctrl-]` `d`, exit `0` on detach, `1` on refusal, `2` on usage, and MUST support `--json` for `ever-works fleet session list`.

### 4.8 P3 — Recording and re-watch

- **FR-54** A session MUST be recordable into the existing terminal transcript store keyed by the session (CONTRACTS R-9); Agent sessions MUST record by default, owner sessions MUST start recording only when the Node's existing watch-recording opt-in is on or the user turns it on for that session.
- **FR-55** Recorded output MUST pass the same secret redaction the cloud terminal transcript applies before it is stored.
- **FR-56** Recordings MUST be retained **14 days** and deleted by the existing scheduled sweep, not on read.
- **FR-57** The session detail MUST offer **Re-watch** for a recorded session, playing the stored output with a scrubber, speed control and driver-change marks; the Run receipt of an Agent session MUST link to it.
- **FR-58** When recording cannot start or fails, the session MUST continue, the footer MUST say so, and the detail MUST later say why there is nothing to play.
- **FR-59** The AW-11 tracker MUST be updated in the same change to mark its P3 terminal recording as delivered here.

### 4.9 Cost and honesty

- **FR-60** The session detail MUST state what a session costs: an owner session uses the machine owner's own CLI login and Ever Works bills no tokens for it; its cost chip MUST show the figure the usage scan (FL-20) attributes when known and _"not tracked"_ otherwise. An Agent session's cost MUST be the Run's cost.
- **FR-61** Watching or driving a session MUST spend no model tokens; the footer MUST show the bandwidth a viewer has used since attaching.

### 4.10 Accessibility and keyboard

- **FR-62** Every control on the session surfaces MUST be reachable by keyboard; the pane MUST be a labelled focusable region announcing its role (_"Terminal of api tests on build-01. You are driving."_).
- **FR-63** Shortcuts on the detail page: `T` take the keyboard, `W` watch only, `R` re-watch, `E` end (opens the confirmation), `N` new session on this computer, `?` the sheet; while driving, only `Esc Esc` (release the keyboard) MUST be intercepted.

---

## 5. UX

All copy is the exact user-visible string (keys under `fleet.sessions.*`). Every surface is shown in each of its states.

### 5.1 Computer page — Sessions tab, loaded

```
┌ Overview │ Sessions ● │ Desktop │ Logs │ … ┐                               [New session ▾]
│
│  LIVE (2)
│   ◐ Nina · claude   "api tests"        fl/api-tests · ~/code/api    working 12 min   [Open] [⋯]
│   ● Shell           "~"                ~                           idle 1 h          [Open] [⋯]
│
│  ENDED (3)
│   ○ Claude          "migration"        ~/code/api                  ended (exit 0) · 2 h ago  [Restart] [⋯]
│   ○ Codex           "lint sweep"       ~/code/web                  ended (user) · yesterday  [Restart] [⋯]
│   ○ Shell           "~"                ~                           ended (node-restart) · 3 d [Restart] [⋯]
```

`⋯` holds **Open**, **Rename**, **Copy link**, **End** (or **Restart**), and for Agent sessions **Open the Run**.

### 5.2 Start dialog

```
┌ New session ───────────────────────────────────────────────────────────┐
│  COMPUTER      [ build-01 ▾ ]   ● online · Linux · claude, codex          │
│  WHO           ( ● ) You — runs as you, in your login                    │
│                ( ○ ) Agent  [ Nina ▾ ]  — isolated, owns a Run            │
│  WHAT          [ Claude Code ✓ ] [ Codex ✓ ] [ Shell ]                    │
│  WHERE         Recent:  ~/code/api  ·  ~/code/web  ·  ~                   │
│                Checkouts: acme/api (main) · acme/web (develop)             │
│                [ ~/code/api                                   ] [Browse…] │
│                ( ● ) in this folder    ( ○ ) in a new worktree of acme/api │
│  FIRST MESSAGE ┌──────────────────────────────────────────────────────┐  │
│                │ run the migration tests and fix what fails           │  │
│                └──────────────────────────────────────────────────────┘  │
│  This session uses your own Claude Code login on build-01. Ever Works     │
│  bills no tokens for it.                                                  │
│                                              [ Cancel ]  [ Start session ] │
└───────────────────────────────────────────────────────────────────────────┘
```

Agent chosen: the sentence becomes _"Nina runs isolated on build-01 — her own configuration, never yours. The Run appears in Activity → Runs with its cost."_ A CLI the Node does not advertise is shown greyed with _"not installed on build-01"_. **In a new worktree** is present only when Checkouts (FL-14) is installed; otherwise the row reads _"New worktrees arrive with Checkouts"_.

### 5.3 Session detail — driving

See §0. Footer variants: _"Watching · Dana is driving"_, _"You are driving · 2 watching (Ops, Dana)"_, _"Nobody is driving · 1 watching"_, _"Isolated — Nina's own configuration on build-01"_ (Agent sessions, header sub-line).

### 5.4 Reconnecting

```
│ ( last screen, dimmed to 40% )                                                            │
│                    ↻ Reconnecting to build-01…  (12 s)                                    │
│ You typed 2 lines while offline.                        [ Send them ] [ Discard ]          │
```

### 5.5 Ended

```
│ ( last screen )                                                                            │
│ ─────────────────────────────────────────────────────────────────────────────────────────  │
│ Ended 09:58 · exited with code 0                                     [ Restart ] [ Re-watch ] │
```

Variants of the line: _"Ended 09:58 · ended by you"_, _"Ended 09:58 · build-01 restarted — the screen above is the last one it kept"_, _"Ended 09:58 · fleet drain"_, _"Ended 09:58 · fleet stop"_, _"Ended 09:58 · the process was lost — exit code unknown"_.

### 5.6 Consent missing / daemon down / offline (tab states)

```
┌ Sessions ─────────────────────────────────────────────────────────────────┐
│  Owner sessions need management switched on for this computer.            │
│  Run this on design-mac:   ever-works-node start --manage        [copy]    │
│  Agent sessions are available (work is on).           [ New Agent session ] │
└───────────────────────────────────────────────────────────────────────────┘
```

Daemon down: _"The session daemon is not running on build-01 — could not bind the local socket."_ `[ Retry ]`. Offline: _"build-01 is offline — last seen 2 h ago. Sessions it had are listed below with their last screens."_

### 5.7 Limits

_"build-01 already has 8 sessions. End one to start another."_ with the eight listed (title · starter · since). _"This session already has 5 watchers."_ with the five named.

### 5.8 Kill switch and drain

Stop banner as the rest of Fleet, plus the footer _"Paused by the fleet stop — Investigating a runaway job"_. Drain: an amber strip _"This session ends in 0:60 (fleet drain)"_ counting down in the pane and on the card.

### 5.9 Confirmation (End)

```
┌ End "api tests" on build-01? ──────────────────────────────┐
│  The process is stopped. Its screen is kept and you can     │
│  restart it later.                                          │
│  Nina's Run ends with it.           ← Agent sessions only   │
│                                     [ Cancel ]  [ End ]     │
└─────────────────────────────────────────────────────────────┘
```

### 5.10 Re-watch player

```
┌ Re-watch · api tests · build-01 · 18 Oct 2026 09:41 ─────────────────────────┐
│ ( replayed terminal )                                                        │
│ ▶  ├───▓▓▓▓▓▓▓──────┤  02:10 / 18:32   1× ▾      ▲ Dana drove 01:02–01:48     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Nothing to play: _"This session was not recorded."_ / _"Recording stopped — storage was unavailable."_ / _"The recording was removed after 14 days."_

### 5.11 Palette entries

**Go to session…** (lists live sessions, computer and Agent in the subtitle), **New session on…** (lists online computers that advertise `sessions`). The "needs you first" ordering belongs to FL-05.

### 5.12 Empty state

```
│  No sessions on build-01 yet.                                                 │
│  Start a shell or an agent here and it keeps running when you close the tab.  │
│                                                   [ New session ▾ ]           │
```

### 5.13 Accessibility

The pane region label carries title, computer and role and is re-announced on role change; the read-only badge is text, not colour; every row names its state in words; the player's scrubber is a slider with a 1 s step and a 10 s page step.

---

## 6. Non-functional requirements

- **Performance.** Start to first prompt ≤ 3 s (p95) for a shell on an online Node; attach to replayed screen ≤ 2 s (p95); keystroke to echo ≤ 200 ms (p95) over a ≤ 50 ms link; a daemon with 8 sessions MUST stay under 150 MB resident.
- **Reliability.** A node upgrade (process restart) MUST lose no session; a link drop of up to the reconnect window MUST lose no output (the daemon's scrollback covers it); the daemon MUST survive a crash of any one session's process.
- **Security & privacy.** Terminal bytes are visible only to the audience the Node's policy allows; the daemon socket is owner-only; no credential is ever handed from the platform to the machine (README D6); recordings are redacted before storage; typed input is never logged.
- **Observability.** Audit rows per §7; analytics `fleet_session_started · attached · driver_changed · ended (reason) · daemon_restarted · replay_ms`; the node's health reports daemon state.
- **Compatibility.** Every contract change is an additive union member or an optional field; `FleetJobKind`, `AgentRunTriggerKind`, the heartbeat payload and the Terminal pane props gain members and lose none.

---

## 7. Key entities & concepts

| Entity / concept              | New?                   | Description                                                                                                                                                                                 |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node** (Computer in copy)   | Existing               | The machine. Gains the `sessions` capability tag and the `--manage` consent (FL-02).                                                                                                        |
| **Session** (`FleetSession`)  | **NEW**                | A persistent interactive process on a Node (CONTRACTS §4.2). Kind owner or agent; provider; folder; title; state; outcome; the daemon's id; the provider's own session id; recording state. |
| **Owner session**             | NEW kind               | A `FleetSession` with no Agent, run as the person in their login.                                                                                                                           |
| **Agent session**             | NEW kind               | A `FleetSession` with an Agent and exactly one Run, run under Task-run isolation.                                                                                                           |
| **Run**                       | Existing               | Gains trigger kind `session` and a reference to its session. Keeps `fleetCliSession` for resume.                                                                                            |
| **Session daemon**            | **NEW** (machine-side) | The node's supervised process owning terminals and screens. Not a platform entity.                                                                                                          |
| **Checkout**                  | FL-14                  | Where a session may start; a new worktree becomes the session's checkout.                                                                                                                   |
| **Terminal transcript chunk** | Existing               | Gains a session key so a session's recording lives beside Run transcripts (R-9).                                                                                                            |
| **Fleet audit**               | Existing               | Gains the `node.session.*` actions.                                                                                                                                                         |

**Action families, consents, permissions, confirmations, errors (rule 7):**

| Act                | Consent         | Family / audience default | Confirmation                                                                             | Audit                                   | Errors                                                                                                                   | Agent tool                                                   |
| ------------------ | --------------- | ------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Start (owner)      | `manage`        | `sessions` / owner        | `plain`                                                                                  | `node.session.start`                    | `consent_missing`, `unreachable`, `unsupported_on_node`, `limit_exceeded`, `invalid`, `kill_switch`, `permission_denied` | — (an Agent never starts an owner session)                   |
| Start (Agent)      | `work`          | `sessions` / owner        | `plain`                                                                                  | `node.session.start`                    | same + queued (not an error)                                                                                             | `fleet_sessions_start` · destructive: false                  |
| List / read screen | any             | `sessions` / owner        | `plain`                                                                                  | — (read)                                | `permission_denied`, `not_found`                                                                                         | `fleet_sessions_list`, `fleet_sessions_read` · readOnly      |
| Attach viewer      | any             | `sessions` / owner        | `plain`                                                                                  | `node.session.attach`                   | `limit_exceeded`, `unreachable`, `kill_switch`                                                                           | —                                                            |
| Drive / send input | `manage`/`work` | `sessions` / owner        | `plain`                                                                                  | `node.session.input` (one row per span) | `kill_switch`, `permission_denied`                                                                                       | `fleet_sessions_send` · destructive: false (FL-19 catalogue) |
| Rename             | any             | `sessions` / owner        | `plain`                                                                                  | `node.session.rename`                   | `not_found`, `invalid`                                                                                                   | `fleet_sessions_rename` · destructive: false                 |
| End                | any             | `sessions` / owner        | `confirm` — _"End '<title>' on <computer>? The process is stopped; its screen is kept."_ | `node.session.end`                      | `not_found`, `unreachable` (ends platform-side, node reconciles)                                                         | `fleet_sessions_end` · destructive: true                     |
| Restart            | as Start        | `sessions` / owner        | `plain`                                                                                  | `node.session.restart`                  | as Start                                                                                                                 | `fleet_sessions_start` with `restartOf`                      |
| Recording on/off   | any             | `sessions` / owner        | `plain`                                                                                  | `node.session.recording.start\|stop`    | `not_found`                                                                                                              | —                                                            |

Kill switch (R-24): every act above except read is refused `kill_switch`; daemon input blocked, processes left running. Drain: owner sessions end after a 60 s warning (`drain`); Agent sessions end with their Runs.

---

## 8. Out of scope

- **Status, attention, the board and hooks** — FL-05. This epic emits process evidence (start, exit, output activity) and leaves `working · needs_you · done · idle` derivation, the hook overlay content and the Sessions board to FL-05.
- **Git line, PR pill and the actions menu** — FL-06 (slots are reserved on the detail and the card).
- **Creating checkouts and worktrees** — FL-14; this epic calls it when present.
- **Desktop beside the terminal** — FL-07.
- **Cost attribution from transcripts** — FL-20; this epic shows the figure when it exists.
- **MCP and CLI parity beyond `attach` and `list`** — FL-19.
- **Splits and panes.** One terminal per detail page; several sessions are several pages.
- **Structured "chat view" over a PTY** — refused in the capability map.
- **Hibernating and resuming idle sessions** — deferred in the capability map.
- **The Computer tab's read-only terminal channel** keeps its own path; routing it through the daemon is a later clean-up, not this epic.
- **`apps/desktop-node`** parity arrives with FL-02's last phase; until then its computer page shows "not available on this kind of node yet" (R-10).

## 8b. Open questions

- **Resolved** by CONTRACTS R-9 / §13: FL-04 slot `1796040000000` adds a nullable `fleetSessionId` to
  `terminal_transcript_chunks` and relaxes `runId` to nullable with a check that one of the two is
  set; no third slot.
- `[NEEDS CLARIFICATION: Default recording for owner sessions, and whether an Organization may make it mandatory, is the owner's call (R-9 says where recordings live, not when owner sessions record). Default until answered: off, turned on by the Node's existing watch-recording opt-in or per session by the user; Agent sessions record by default; no Organization-level mandate.]`
- `[NEEDS CLARIFICATION: Several drivers at once (U10) is the owner's call — CONTRACTS §3.3 defines viewer and driver modes but no exclusivity for terminals. Default until answered: several drivers allowed, every driver span audited, no exclusive lock; the AW-11 arbiter stays the Desktop's (FL-07).]`
- **Resolved** by CONTRACTS §5.1 / §10: owner sessions have no hard cap; 30 min of silence moves a
  session to `idle`, never to `ended`; an Organization-level cap is out of scope.
- **Resolved** by CONTRACTS R-28: `agent-session` jobs are leased by the work lane and count
  against `--concurrency` exactly like `agent-task` (FR-43).
- `[NEEDS CLARIFICATION: Windows shell choice is the owner's call. Default until answered: PowerShell 7 (`pwsh`) when it is on PATH, else Windows PowerShell; no node setting.]`
- **Resolved** by CONTRACTS §3.2–3.3: node → platform facts ride channel 0 as `session.list`,
  `session.event`, `session.status` and `session.attention` (the last two filled by FL-05); FL-04
  sends `session.list` once after `link.ready` and `session.event { sessionId, event:
started|exited|title|activity|lost, exitCode?, title?, screen? }`.
- **Resolved** by CONTRACTS R-28 / §12: `agent-session` is leased by the work lane beside
  `agent-task`.
- **Resolved** by CONTRACTS §1.1 (rev 3): the heartbeat carries an optional `daemon { state: running · stopped · failed, reason?, sessions, hooks? }`; session start/attach rates are in §10.1.

---

## 9. Acceptance criteria

**Daemon (P1)**

- [ ] `ACC-FL04-01` (FR-1, FR-2) A session started on an online Node survives `ever-works-node` being stopped and started again; the daemon is still running and the session is re-listed unchanged.
- [ ] `ACC-FL04-02` (FR-4, FR-25) Attaching to a session with 5 000 lines of prior output shows the current screen within 2 s and allows scrolling 2 000 lines back.
- [ ] `ACC-FL04-03` (FR-5) A program that asks for the cursor position while nothing is attached receives an answer and does not hang.
- [ ] `ACC-FL04-04` (FR-6) The terminal resizes to the newest driver's size and ignores a viewer's.
- [ ] `ACC-FL04-05` (FR-7) A viewer that stops reading is dropped within 5 s and the process keeps producing output.
- [ ] `ACC-FL04-06` (FR-8, FR-11) After the machine reboots, every session is `ended (node-restart)` with its last screen shown.
- [ ] `ACC-FL04-07` (FR-10) `sessions` is advertised only while the daemon answers health.

**Owner sessions (P1)**

- [ ] `ACC-FL04-08` (FR-12) An owner Claude Code session sees the owner's own MCP servers and memory; an Agent session does not.
- [ ] `ACC-FL04-09` (FR-13, FR-46) A start without the consent is refused `consent_missing` with the exact command in the hint; the tab shows the same.
- [ ] `ACC-FL04-10` (FR-14) A provider the Node does not advertise is greyed in the dialog and refused `unsupported_on_node` directly.
- [ ] `ACC-FL04-11` (FR-16, FR-24) The ninth owner session and the sixth viewer are refused `limit_exceeded` naming the existing ones.
- [ ] `ACC-FL04-12` (FR-18, FR-32) End from the tab, the detail, the Agent page and the board shows the same confirmation and ends the session everywhere within 5 s.
- [ ] `ACC-FL04-13` (FR-19) A rename survives a node restart.
- [ ] `ACC-FL04-14` (FR-20) Restart creates a linked new session with the same kind, provider, folder and title.

**Attach (P1)**

- [ ] `ACC-FL04-15` (FR-22) A viewer's keystrokes are refused in the hook and, when forged, by the relay.
- [ ] `ACC-FL04-16` (FR-23) Two drivers both type; the footer names both; two audit spans exist.
- [ ] `ACC-FL04-17` (FR-26) Dropping the link for 20 s shows the reconnecting state, keeps the process running, and offers held input without auto-sending it.
- [ ] `ACC-FL04-18` (FR-27) The session detail, the Computer tab and the cloud Run's Terminal tab all render through the same pane component.

**Safety (P1)**

- [ ] `ACC-FL04-19` (FR-34) An Organization member outside the `sessions` audience sees no sessions and is refused `permission_denied` with the hint.
- [ ] `ACC-FL04-20` (FR-35, FR-36) Every act writes its audit row within 2 s and no row contains terminal bytes or input.
- [ ] `ACC-FL04-21` (FR-37) Throwing the kill switch blocks input on every session within 5 s, leaves processes running, and clearing it resumes input without a reconnect.
- [ ] `ACC-FL04-22` (FR-38) Drain all shows the 60 s countdown and ends owner sessions with `drain`.
- [ ] `ACC-FL04-23` (FR-40) Revoking a viewer's membership closes their socket within 30 s.

**Agent sessions (P2)**

- [ ] `ACC-FL04-24` (FR-42) Starting an Agent session creates one Run (trigger `session`) referencing the session; ending either ends both.
- [ ] `ACC-FL04-25` (FR-43, FR-43a) With `--concurrency 1` and one Agent session live, a second queues with the waiting card and starts when the first ends; with the chosen CLI throttled by a usage limit, the session waits with the `model-usage-limit` reason and the reset time on its card.
- [ ] `ACC-FL04-26` (FR-44, FR-45) An Agent session's CLI configuration home is the relocated one, its MCP configuration is the bridge's or empty, its environment is the scrubbed one, and the footer says it is isolated.
- [ ] `ACC-FL04-27` (FR-49) With Checkouts present, "in a new worktree" creates the worktree first and the session's checkout is set.
- [ ] `ACC-FL04-28` (FR-51) A session started through `fleet_sessions_start` is an Agent session attributed to the calling Agent.
- [ ] `ACC-FL04-29` (FR-53) `ever-works fleet session attach` replays the screen, drives, follows resize, and detaches on `Ctrl-]` `d` with exit 0.

**Recording (P3)**

- [ ] `ACC-FL04-30` (FR-54, FR-55) An Agent session records by default; an owner session records only when opted in; a line containing a secret-shaped value is stored redacted.
- [ ] `ACC-FL04-31` (FR-56) Chunks older than 14 days are gone after the sweep.
- [ ] `ACC-FL04-32` (FR-57) Re-watch plays the stored output with a scrubber and marks driver changes; the Run receipt links to it.
- [ ] `ACC-FL04-33` (FR-58) With storage refusing writes the session continues and the detail says why there is nothing to play.

**Cross-cutting**

- [ ] `ACC-FL04-34` (FR-60, FR-61) The detail states the cost rule for the session's kind and shows bandwidth used.
- [ ] `ACC-FL04-35` (FR-62, FR-63) Every control is keyboard-reachable; `?` opens the sheet; `Esc Esc` releases the keyboard.
- [ ] `ACC-FL04-36` Every user-visible string is an i18n key under `fleet.sessions.*`; the banned-terms grep prints nothing.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration is added. The daemon drives processes on the machine the way the node already drives a browser and a PTY in core (no node plugin runtime exists); the terminal host plugin (`terminal-stream`) stays the provider for the Computer tab's channel.
- [x] **II — Capability-driven resolution.** No provider id is hard-coded; the Agent session path resolves the model CLI exactly as Task runs do.
- [x] **III — Source-of-truth repos.** No work content enters the database; recordings are redacted terminal bytes with a retention, as cloud transcripts are.
- [x] **IV — Job runtime.** Agent sessions ride the fleet job queue (`agent-session`); platform-side sweeps are scheduled through the configured job-runtime provider.
- [x] **V — Forward-only migrations.** Two additive migrations from the FL-04 slots; the transcript-chunk key change is the one CONTRACTS R-9 fixes (a nullable column and a relaxed `runId` guarded by a check, no data rewritten).
- [x] **VI — Tests.** Unit, controller, node and Playwright coverage named per phase in the plan.
- [x] **VII — Secrets.** Nothing the platform holds reaches the machine; recordings are redacted on the node and again before storage; audit never carries input.
- [x] **VIII — Plugin counts.** No plugin is added; the canonical doc is untouched.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint except in §2's substrate citations.
- [x] **X — Backwards compatibility.** Every contract change is an additive member or optional field; the Terminal pane keeps its existing props.

---

## 11. References

- Program: [Fleet README](../README.md) · [CONTRACTS](../CONTRACTS.md) (R-1, R-5, R-6, R-9, R-19, R-21, R-22, R-24; §3, §4.2, §7, §8, §10, §11, §12, §13) · [CAPABILITY-MAP §B](../CAPABILITY-MAP.md) · [TRACKER](../TRACKER.md)
- Implementation plan: [`./plan.md`](./plan.md) · Task breakdown: [`./tasks.md`](./tasks.md)
- Sibling epics: [FL-02 Node link](../FL-02-node-link/) · [FL-05 Session status & board](../FL-05-session-status-board/) · [FL-06 Session git & actions](../FL-06-session-git-actions/) · [FL-14 Checkouts](../FL-14-checkouts/) · [FL-20 Usage & cost](../FL-20-usage-and-cost/)
- Agent Workspace: [AW-11 Agent computers](../../agent-workspace/AW-11-agent-computers/spec.md) (P3 terminal recording closed here) · [AW-09 Runs & receipts](../../agent-workspace/AW-09-runs-receipts/spec.md)
- Existing docs: `docs/features/fleet.md`, `docs/features/agent-terminals.md`
- Constitution: `.specify/memory/constitution.md`
