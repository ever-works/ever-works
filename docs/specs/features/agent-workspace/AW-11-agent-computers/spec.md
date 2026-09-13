# AW-11 — Agent computers: watch, take over, teach

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `AW-11-agent-computers`
**Program:** [Agent Workspace](../README.md) · Wave 1 (the flagship)
**Branch:** `feat/aw-11-agent-computers`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** XL · **Blocked by:** — · **Related:** AW-08 (Skills shelf), AW-09 (Runs & receipts), AW-15 (Connections & scopes), AW-24 (Safety rails)
**Extends (existing Ever Works nouns):** Node · Fleet · Agent · Run · Task · Mission · Skill · Approval · Activity Log · Organization

---

## 0. TL;DR

Ever Works can already put an Agent to work on a machine the user owns. A **Node** enrols,
heartbeats, leases jobs, provisions a git worktree, drives a real browser, and reports a verdict.
What the owner cannot do is **look at it**. There is no screen, no live view, no way to reach in
and finish a step by hand, and no way to show an Agent how a job is done rather than describing
it in prose.

This epic adds one surface — **the Agent's computer** — reachable as a peer of "Message" on the
Agent page, and three acts on it:

| Act | What it is | Why it earns its place |
| --- | --- | --- |
| **Watch** | A live picture of the Agent's browser window, or its shell, on the Node it is bound to. Read-only. The Agent keeps working. | Autonomy is extended only as far as it can be observed. |
| **Take over** | The owner's mouse and keyboard drive that machine. The Agent's own input is paused. Every take-over is a permissioned, time-boxed, audited act with a recording attached to the Run. | The last 5% of a job is often a click only a human can make. Today that means abandoning the run. |
| **Teach** | The owner takes over, does the job once while it is recorded, and the Agent turns the recording into a **draft Skill** that lands in chat for approval. Passwords and one-time codes are never captured. | Demonstration replaces prompt engineering. The artefact is a reusable Skill, not a video. |

```
   AGENT PAGE
   [ Message Ops ]  [ 🖥 Watch computer ]  [ Nudge ]  [ Pause ]  [ Configure ]
                            │
                            ▼
   THE COMPUTER SURFACE ─────────────────────────────────────────────────────
     Ops · studio-imac · 09:41 local · Screen · Sharp        ● LIVE
     ┌──────────────────────────────────────────────────────────────────┐
     │                                                                  │
     │        ( live picture of Ops' own browser on studio-imac )       │
     │                                                                  │
     │   ┌ BRIEF · Reconcile September invoices ─────────────┐          │
     │   └───────────────────────────────────────────────────┘          │
     │                                     EVER WORKS · LIVE VIEW       │
     └──────────────────────────────────────────────────────────────────┘
     Watching — Ops keeps working.    [Screen|Terminal] [Sharp▾] [↻] [Take over]
                            │
             take over ─────┼───── teach
                            ▼
   RECORDED DEMONSTRATION → DRAFT SKILL → lands in chat → My Decisions → adopted
```

Three phases, each independently shippable:

- **P1 — Watch.** The surface, the screen channel, the Node picker, the identity strip, the
  working brief, the quality control, refresh, per-Agent isolation, and the audit trail.
- **P2 — Take over and teach.** Input forwarding, the control arbiter, the demonstration
  recorder with secret redaction, synthesis into a draft Skill, and the approval that adopts it.
- **P3 — Re-watch and the terminal channel.** Session recordings bound to a Run and replayable
  from its receipt, "make a Skill from this run", and the terminal channel served from the Node
  itself.

---

## 1. Overview

**The Agent's computer** is a single page per Agent that shows, live, what that Agent is doing on
the machine it runs on: its own browser window on the **screen** channel, or its own shell on the
**terminal** channel. The page opens in **watching** mode — read-only, with the Agent working
uninterrupted — and states that fact in prose on screen at all times. A header strip names the
Agent, the Node, the Node's local clock, the channel and the stream quality, so a screenshot of
this page is never ambiguous about whose machine it is or when. An overlay carries the Agent's
current working brief — the Task and Mission behind the pixels — so the picture is legible rather
than merely live. A quality control trades sharpness against latency; a refresh recovers a stalled
stream without leaving the page.

From watching, the owner can **take over**: their pointer and keyboard drive the machine, the
Agent's own input is suspended, and the page says so unmistakably. Take-over is a permissioned act
(only people the Node's control policy allows), a time-boxed one (it releases itself when idle),
an exclusive one (one controller at a time, with a request-and-hand-over flow), and an audited one
(who took control, when, on which Node, for how long, and what the machine looked like while they
had it).

From take-over, the owner can **teach a task**: name what they are about to show, press record, do
the job once in the Agent's own browser, and press finish. The system captures the *steps* — the
pages visited, the controls clicked, the values typed — and never captures passwords, one-time
codes, or the contents of any field the browser marks as a credential. The Agent then studies the
recording and replies in the owner's conversation with it, carrying a **draft Skill**: a title, a
description, and numbered instructions with named placeholders where secrets and per-run inputs
belong. Approving the draft creates the Skill and binds it to that Agent. Rejecting it discards
the draft and keeps the recording for a retry.

Because Ever Works' Fleet is many machines rather than one, the surface is **Agent → which Node →
watch**: a picker lists every Node the Agent could run on, with its health, and says plainly why a
Node cannot be watched when it cannot. Each Agent gets its **own profile on each Node** — its own
browser profile, its own cookies and logins, its own file root — so one Agent can never see
another's signed-in accounts, and the owner can reset one Agent's logins without touching another's.

---

## 2. Why now

### 2.1 The user's question

> *"What is it actually doing on my machine right now — and can I just do this one step myself?"*

And, ten minutes later:

> *"That took me forty seconds. Why can't it just watch me do it once?"*

### 2.2 What they do today, and why it does not answer the question

| To answer… | Today they must… | What breaks |
| --- | --- | --- |
| "What is my Agent doing on that machine?" | Read a Node's status row: online/offline, last heartbeat, disk free, capability tags, and the last 25 job rows. | None of that is *what it is doing*. There is no live view of a Node of any kind — no screen, no browser view, no screenshot, no Node log ever reaching the platform. The Node's own logs stay in a tray window on the machine. |
| "Show me the shell." | Open the Agent's Terminal tab. | That terminal streams a shell hosted in the platform's job worker, keyed to a Run — **not** a shell on the enrolled machine. Every enrolled Node advertises a `terminal` capability that no job kind ever exercises. The user believes they are looking at their PC; they are not. |
| "It got stuck on a login wall — let me click it." | Cancel the run, do the work by hand on the machine, restart the run and hope the state carries. | There is no way to hand control to a human mid-run and hand it back. A run that needs one human click is a failed run. |
| "Teach it how we do this." | Write instructions into the Agent's files or author a Skill by hand, guessing at selectors and page names. | Skills are authored as prose in a Markdown textarea. The most reliable source of truth — a person doing the job — cannot be turned into a Skill at all. |
| "Which Agent is signed into which account on that machine?" | Nothing. | The Node provisions a git worktree per Task, but there is no per-Agent browser profile or per-Agent file root. Two Agents on one Node share whatever browser state exists. The connection scopes granted in the control plane and the logged-in sessions on the machine are not the same boundary. |
| "Who reached into my machine, and when?" | Nothing for this, though the Fleet already keeps an audit trail for credential and panic actions. | There is no take-over to audit yet — but when there is, it must land in the same ledger on day one, not as a follow-up. |

### 2.3 The four gaps this epic closes

1. **The Fleet is blind.** Everything needed to run work on a user's machine exists and is
   hardened; the one thing missing is a picture. That is a *surfacing* job on a subsystem that
   already has enrolment, credentials, capability detection, leasing, affinity, cost ceilings, a
   kill switch and an audit ledger.
2. **The terminal points at the wrong machine.** A capability tag advertised by every Node with
   no executor behind it is a promise the product does not keep. Serving the terminal channel
   from the Node closes it.
3. **A human cannot finish a step.** Autonomy without a hand-back is brittle. Take-over turns a
   whole class of dead runs into completed ones.
4. **Skills cannot be learned from doing.** Every reusable capability in the product today must
   be written. The cheapest, most accurate authoring channel — demonstrate it once — does not
   exist.

### 2.4 Why this epic is additive only

Per [program rule 1](../README.md#5-rules-every-epic-spec-in-this-program-must-follow), nothing is
removed or renamed. The Fleet settings page, the Node drawer, the enrolment flow, the existing
Agent Terminal tab and its transcript replay all keep working exactly as they do. `FleetNode` stays
the entity; **"computer" is UI copy only**, as the program vocabulary permits for this surface.
The screen channel is a new channel beside the existing terminal one, not a replacement for it.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Watch, one click from the Agent.**
  **Given** an Agent bound to an online Node that advertises a screen capability,
  **when** the owner opens the Agent page and clicks **Watch computer** in the action row,
  **then** the computer surface opens, shows a connecting state within 500 ms, and renders its
  first live frame within 6 seconds; the header strip reads `<Agent> · <Node> · <Node local
  time> · Screen · Sharp` with a `● LIVE` badge, and the status line reads
  *"Watching — <Agent> keeps working."*

- **S2 — The picture is legible.**
  **Given** the Node is executing a Task for that Agent,
  **when** the surface is open,
  **then** a brief overlay in the lower third of the stage reads `BRIEF · <Task title>` with the
  Mission name beneath it, and clicking it opens that Task.

- **S3 — Watching does not disturb the work.**
  **Given** a Run is in flight on the Node,
  **when** the owner opens, watches for ten minutes, and closes the surface,
  **then** the Run's own duration, verdict and cost are unchanged, no step is paused, and no
  Approval is raised. The session appears in the Activity Log as a watch, and nowhere else.

- **S4 — Take over and finish a step.**
  **Given** the owner is watching and the Node's control policy permits them,
  **when** they click **Take over** (or press `T`),
  **then** within 2 seconds the mode changes to **In control**, the stage border turns amber, the
  status line reads *"You have control — <Agent>'s input is paused"*, the stage takes pointer and
  keyboard focus, and the Agent's own synthetic input to that surface is suppressed until control
  is released. An audit row is written naming the person, the Node, the Agent and the time.

- **S5 — Hand control back.**
  **Given** the owner has control,
  **when** they click **Give back control** (or press `Escape` twice),
  **then** the mode returns to watching within 2 seconds, the Agent's input resumes, the status
  line reads *"Watching — <Agent> keeps working"*, and a second audit row closes the control span
  with its duration.

- **S6 — Teach a task end to end.**
  **Given** the owner has control of the Agent's browser,
  **when** they open **Teach a task**, type *"File a supplier invoice in the finance portal"* into
  **What are you about to show?** and press **Start recording**,
  **then** the Agent's own browser comes to the front on the Node (launching if needed), a red
  recording strip appears reading *"Recording your demonstration — passwords and one-time codes
  are never captured"*, and a live step counter increments as they work. When they press
  **Finish**, the strip closes, the surface says *"<Agent> is studying your demonstration"*, and
  within 3 minutes a message arrives in their conversation with that Agent carrying a draft
  Skill: a title, a one-line description, numbered instructions, and a list of the inputs and
  secrets the Skill will ask for. The same draft appears in **My Decisions** as an
  approval.

- **S7 — Adopt the Skill.**
  **Given** a draft Skill is pending,
  **when** the owner clicks **Approve**,
  **then** a Skill is created, bound to that Agent, and appears on the Agent's Skills tab within
  5 seconds; the chat message updates to *"Added to <Agent>'s skills"*; the decision, the
  approver and the timestamp are recorded.

- **S8 — Choose a different machine.**
  **Given** the Agent is bound to a Node that is offline and a second Node is online,
  **when** the owner opens the Node picker in the header strip,
  **then** every Node the owner has is listed with its status dot, name, platform, last heartbeat
  and a one-line reason when it cannot be watched; selecting a watchable Node opens a session on
  it without changing the Agent's affinity binding, and a note explains that watching a Node is
  not the same as pinning work to it, with a link to where the binding is changed.

- **S9 — Switch to the terminal channel.**
  **Given** the Node advertises a terminal capability,
  **when** the owner clicks **Terminal** in the channel switch,
  **then** the stage is replaced by a terminal pane streaming the shell **on that Node**, the
  identity strip's channel field reads `Terminal`, and the read-only badge is present while in
  watching mode. Taking over makes the terminal typable.

- **S10 — Re-watch from the receipt.**
  **Given** a Run had a controlled or teaching session on the Agent's computer,
  **when** the owner opens that Run's receipt and clicks **Watch the recording**,
  **then** a player opens showing the recorded frames with a scrubber, the control spans marked on
  the timeline, and the same identity watermark composited into the frames.

- **S11 — Per-Agent isolation is visible and resettable.**
  **Given** two Agents share a Node,
  **when** the owner opens **Own logins and files** on the computer surface,
  **then** the panel names this Agent's profile on this Node, when it was created, how many sites
  it currently holds a signed-in session for, how much disk it uses, and offers **Reset this
  Agent's logins and files** behind a typed confirmation; resetting one Agent's profile leaves
  every other Agent's profile on that Node untouched.

- **S12 — Teach from a run that already happened.**
  **Given** a completed Run whose session was recorded,
  **when** the owner clicks **Make a Skill from this run** on the receipt,
  **then** the same draft-Skill flow runs against the stored steps without a new demonstration.

### 3.2 Unhappy paths, races, denials and empty states

- **U1 — No Nodes at all.**
  **Given** the owner has enrolled no Node,
  **when** they open the computer surface,
  **then** an empty state explains that an Agent needs a computer to work on, shows the two-step
  enrolment path, and offers **Add a computer**. No spinner, no error tone.

- **U2 — The Node is offline.**
  **Given** the selected Node has not heartbeated within the offline threshold,
  **when** the owner opens the surface,
  **then** the stage shows *"This computer is offline"* with the last heartbeat in relative time
  and an absolute tooltip, a **Try again** button, and no session is opened. Opening is refused
  server-side too, not merely hidden.

- **U3 — The Node cannot show a screen.**
  **Given** the Node is online but advertises neither a display nor a launchable browser,
  **when** the owner selects it,
  **then** the surface refuses with the specific missing piece named — *"No browser found on this
  computer"* or *"This computer has no display session"* — and offers the terminal channel if the
  Node can serve it.

- **U4 — The Node is not attended.**
  **Given** the Node is online and capable but is not running in attended mode,
  **when** the owner tries to watch,
  **then** the surface explains that live viewing must be switched on for that machine, names the
  exact command to run there, and does not silently hang waiting for a session that will never be
  leased. If nothing claims the session within 40 seconds it is abandoned with that same
  explanation.

- **U5 — Someone else already has control.**
  **Given** another permitted person holds control of the same Node,
  **when** the owner clicks **Take over**,
  **then** they stay in watching mode and see *"<Name> has had control since 09:12"* with
  **Request control**; the request appears to the current controller as an in-page prompt with
  **Hand over** / **Keep control**; it auto-declines after 60 seconds and the requester is told
  so. Control never transfers silently.

- **U6 — Control is denied by policy.**
  **Given** the Node's control policy is owner-only and the viewer is an Organization member,
  **when** they open the surface,
  **then** they may watch, the **Take over** button is present but disabled, and its tooltip reads
  *"Only the owner of this computer can take control."* The server refuses the same act with the
  same reason if called directly.

- **U7 — The controller's connection dies.**
  **Given** a controller's browser closes or its socket drops mid-control,
  **when** 30 seconds pass with no input and no heartbeat from that client,
  **then** control is released automatically, the Agent's input resumes, the audit row is closed
  with reason `disconnected`, and any other viewer sees *"Control was released automatically"*.

- **U8 — Control goes idle.**
  **Given** a controller has held control for 10 minutes with no pointer or key input,
  **then** a 30-second countdown appears — *"Giving control back in 0:30"* — with **Keep control**;
  ignoring it releases control and resumes the Agent.

- **U9 — The stream stalls.**
  **Given** frames stop arriving,
  **then** at 6 seconds the strip reads *"Stream stalled — last frame 6s ago"* over a dimmed last
  frame (never a black rectangle), at 20 seconds a refresh is attempted automatically once, and at
  45 seconds the session ends with *"The stream stopped. The computer may be busy or asleep."* and
  a **Reconnect** button. The Agent's work is untouched by any of this.

- **U10 — Too many sessions.**
  **Given** two live sessions already exist on the Node, or five across the Organization,
  **when** a third is requested,
  **then** the request is refused with *"This computer already has 2 live views. Close one to open
  another."* and the existing sessions are listed with who holds them and since when.

- **U11 — The Fleet stop switch is on.**
  **Given** an operator has thrown the Fleet stop switch,
  **when** anyone opens the surface,
  **then** no session opens, live sessions end within 5 seconds with reason `stopped`, and the
  page carries the same stop banner the rest of the Fleet surfaces show, including its reason.

- **U12 — Teaching without control.**
  **Given** the owner is watching, not controlling,
  **when** they click **Teach a task**,
  **then** the dialog opens with **Start recording** disabled and a guard line at the top:
  *"Take control of the computer first — a recording of <Agent> working is not a demonstration."*
  with a **Take control** button that satisfies the guard in place.

- **U13 — Teaching on a Node with no browser.**
  **Given** the Node can capture a display but has no launchable browser,
  **when** the owner opens **Teach a task**,
  **then** it refuses before any recording begins: *"Teaching needs <Agent>'s own browser, and
  this computer has none."*

- **U14 — A password is typed during a demonstration.**
  **Given** the owner types into a password field, a one-time-code field, or a field the page
  marks as a credential,
  **then** the step is recorded as *"Sign in — 🔒 secret, not captured"*, the value is never sent
  off the machine, the step counter still increments, and the resulting draft Skill lists that
  secret as a required input by its label rather than its value.

- **U15 — The demonstration runs long.**
  **Given** a demonstration reaches 200 steps or 15 minutes,
  **then** recording stops at that boundary, the strip reads *"Recording stopped — that is as long
  as a demonstration can be"*, and the owner is offered **Use what I have** or **Discard**.

- **U16 — Synthesis fails.**
  **Given** the Agent cannot turn the recording into a Skill after three attempts,
  **then** the chat message says so plainly — *"I could not turn that into a Skill. The recording
  is saved; you can ask me to try again."* — the demonstration is kept for 30 days, and no
  half-formed Skill is created.

- **U17 — The draft is rejected.**
  **Given** a draft Skill is pending,
  **when** the owner rejects it,
  **then** no Skill is created, the decision is recorded, the chat message updates to *"Discarded
  — the demonstration is kept for 30 days if you want another draft."*

- **U18 — Two draft Skills collide.**
  **Given** an approved draft's title would collide with an existing Skill in the same scope,
  **then** adoption still succeeds with a numbered suffix on the identifier, and the owner is told
  which name was used. Nothing is overwritten.

- **U19 — Recording storage is unavailable.**
  **Given** the storage backend is unreachable when a controlled session starts,
  **then** the session still opens, the strip reads *"Not being recorded — storage is
  unavailable"*, the audit row records that the session was unrecorded, and the Run receipt later
  says so rather than showing an empty player.

- **U20 — A viewer loses permission mid-session.**
  **Given** an Organization member is watching and their membership is revoked,
  **then** their session is closed within 30 seconds with *"You no longer have access to this
  computer"*, and any control they held is released first.

- **U21 — The Node reboots mid-session.**
  **Given** the Node process restarts,
  **then** the session ends with reason `node-restarted`, and the surface offers **Reconnect**,
  which opens a fresh session rather than resuming a dead one.

- **U22 — Profile reset while a Run is live.**
  **Given** a Run is in flight for that Agent on that Node,
  **when** the owner asks to reset the Agent's logins and files,
  **then** the request is refused with *"<Agent> is working on this computer right now. Pause it or
  wait for the run to finish."* — a reset never lands under a live run.

---

## 4. Functional requirements

Every default, limit, threshold and cadence below is a number, not an adjective. Where a value is
operator-configurable the default and the clamp are both given.

### 4.1 Entry point and shape

- **FR-1** The Agent page MUST carry **Watch computer** in its primary action row, as a peer of
  **Message**, not inside a settings sub-page.
- **FR-2** The computer surface MUST also be reachable as a tab on the Agent detail page and by a
  direct link, and MUST accept a Node identifier and a channel in that link so a session can be
  shared or bookmarked.
- **FR-3** The surface MUST render in exactly two modes — **watching** and **in control** — and
  MUST state the current mode in prose on screen at all times, never only by colour or icon.
- **FR-4** The surface MUST offer exactly two channels — **screen** and **terminal** — with at
  most one active at a time, and MUST show which channels the selected Node can serve.
- **FR-4a** A session MUST ask of its Node only what the channels it requests need: the screen
  channel needs a Node that can show a screen, the terminal channel needs a Node that can serve a
  shell, and every session — whatever its channels — needs live viewing switched on for that
  machine (attended mode, U4). A Node with no display session and no browser MUST still be able to
  serve a terminal-only session; only a request that includes the screen channel is refused for
  lacking a display or a browser.
- **FR-5** Opening the surface MUST NOT pause, cancel, steer or otherwise alter any Run.

### 4.2 The session

- **FR-6** Opening a session MUST return within 500 ms with a session identifier and a connecting
  state; the first frame MUST arrive within 6 seconds at the 95th percentile when the Node is
  online, attended and idle.
- **FR-7** An attended Node MUST poll for interactive sessions every 2000 ms (clamp 500–10000 ms),
  independently of its heartbeat cadence, and MUST back off to 15000 ms after 10 consecutive empty
  polls with no session in the previous 10 minutes, returning to the fast cadence on the next
  heartbeat that reports a pending session.
- **FR-8** A session that no Node claims within 40 seconds MUST be abandoned with a reason the
  user can act on, and MUST NOT leave a queued job behind.
- **FR-9** At most **2** live sessions MAY exist per Node and **5** per Organization (both
  operator-configurable, clamp 1–10 and 1–50). Exceeding either MUST refuse with a message naming
  the existing sessions and their holders.
- **FR-10** A session MUST end automatically after **4 hours** (clamp 15 minutes – 12 hours), after
  **30 minutes** with no attached viewer, or **15 seconds** after its last viewer detaches while in
  watching mode.
- **FR-11** Every session MUST record its open reason, close reason, Node, Agent, opening user,
  channel, and — when the Node was executing one — the Run it was bound to.
- **FR-12** A session MUST bind to the Run the Node is executing for that Agent at the moment the
  first frame is produced, and MUST NOT re-bind if the Run changes mid-session; a Run change MUST
  instead update the working brief and start a new binding record.

### 4.3 The picture

- **FR-13** The stage MUST render frames of the Agent's own browser window on the selected Node,
  scaled to fit, never upscaled beyond 100%, and never cropped.
- **FR-14** Three named quality settings MUST be offered, each with fixed parameters:
  **Sharp** — 1280 px wide, ≤ 8 frames per second, keyframe at least every 5 seconds;
  **Smooth** — 960 px wide, ≤ 15 frames per second, keyframe at least every 5 seconds;
  **Steady** — 800 px wide, ≤ 2 frames per second, keyframe at least every 2 seconds.
- **FR-15** The default MUST be **Sharp**, and the chosen setting MUST persist per user per Node.
- **FR-16** The system MUST drop one quality tier automatically when the Node's publish backlog
  exceeds 3 frames for 5 continuous seconds or the acknowledgement round trip exceeds 1500 ms for
  5 continuous seconds, MUST say so in the strip — *"Lowered to Steady — the connection is slow"* —
  and MUST return to the user's chosen tier after 30 continuous seconds within limits.
- **FR-17** A single frame MUST NOT exceed 512 KiB and a single publish MUST NOT exceed 8 frames
  or 512 KiB in total.
- **FR-18** Glass-to-glass latency MUST be ≤ 900 ms at the 95th percentile at **Sharp** over a link
  with ≤ 50 ms round-trip time.
- **FR-19** **Refresh** MUST force a full keyframe; three consecutive failed keyframes MUST restart
  the capture without ending the session, and MUST tell the user it did.
- **FR-20** The stage MUST never show a blank rectangle for a stalled stream: it MUST dim the last
  frame and state the age of that frame.
- **FR-21** Frames MUST NOT be retained by the platform except as part of a recording governed by
  §4.8.

### 4.4 The identity strip and the brief

- **FR-22** The strip MUST show, always: the Agent's name, the Node's name, the Node's **local**
  wall-clock time (not the viewer's), the active channel, the active quality, and a live indicator.
- **FR-23** The Node's local time MUST update at least once per second while the session is live
  and MUST be marked stale if the Node has not reported for more than 10 seconds.
- **FR-24** A watermark reading `EVER WORKS · LIVE VIEW · <agent> · <node>` MUST be visible over
  the stage at all times so a screenshot of the page identifies itself, and MUST be composited into
  recorded frames.
- **FR-25** When the Node is executing a Task for the Agent, a brief overlay MUST show
  `BRIEF · <Task title>` and the Mission name, and MUST link to that Task.
- **FR-26** When no Task is in flight, the overlay MUST read *"Idle — no task in flight"* rather
  than disappearing, so the absence of work is itself legible.
- **FR-27** The status line MUST read *"Watching — <Agent> keeps working."* in watching mode and
  *"You have control — <Agent>'s input is paused."* in control mode.

### 4.5 Take-over

- **FR-28** Take-over MUST be an explicit act: a button, and the keyboard shortcut `T`. It MUST
  NOT be triggered by clicking the stage.
- **FR-29** Exactly one controller MAY hold a Node at a time, across all sessions on it.
- **FR-30** A Node MUST carry a control policy with three values — **owner only** (default),
  **organization admins**, **organization members** — and control MUST be refused server-side to
  anyone outside it, with the policy named in the refusal.
- **FR-31** While a controller holds control, the Agent's own synthetic input to the captured
  surface MUST be suppressed, and the Agent MUST be told it is paused rather than silently failing.
- **FR-32** Control MUST release automatically after **10 minutes** with no input (clamp 1–60
  minutes), with a visible 30-second countdown and a **Keep control** escape.
- **FR-33** A single control grant MUST NOT exceed **60 minutes** (clamp 5–240) and MUST be
  extendable exactly once per grant.
- **FR-34** Control MUST release **30 seconds** after the controlling client stops acknowledging.
- **FR-35** A second permitted person MUST be able to **request control**; the request MUST be
  shown to the current controller, MUST auto-decline after **60 seconds**, and MUST never transfer
  control without an explicit hand-over.
- **FR-36** Input round-trip time MUST be ≤ 250 ms at the 95th percentile over a link with
  ≤ 50 ms round-trip time.
- **FR-37** Forwarded input MUST be limited to pointer movement, pointer buttons, wheel, key
  presses, and text; the surface MUST NOT forward clipboard contents, file drops, or arbitrary
  operating-system shortcuts, and MUST say which shortcuts it will not forward.
- **FR-38** Every control grant and release MUST write an audit row within 2 seconds containing
  the actor, the Node, the Agent, the session, the start, the end and the release reason.

### 4.6 Per-Agent isolation

- **FR-39** Each Agent MUST have its own profile on each Node it runs on: its own browser profile
  directory, its own cookies and signed-in sessions, and its own file root.
- **FR-40** An Agent MUST NOT be able to read another Agent's profile on the same Node, and the
  surface MUST state that guarantee in the isolation panel.
- **FR-41** The isolation panel MUST show, per Agent per Node: when the profile was created, when
  it was last used, how many sites currently hold a signed-in session in it, and how much disk it
  occupies.
- **FR-42** **Reset this Agent's logins and files** MUST require typing the Agent's name to
  confirm, MUST delete only that Agent's profile on that Node, and MUST be refused while a Run for
  that Agent is live on that Node.
- **FR-43** A profile reset MUST write an audit row and MUST be reported in the Activity Log.

### 4.7 The terminal channel

- **FR-44** The terminal channel MUST stream a shell running **on the selected Node**, not on the
  platform's job worker, and the surface MUST say which machine the shell is on.
- **FR-45** In watching mode the terminal MUST be read-only and MUST carry a read-only badge; in
  control mode it MUST accept keystrokes and resize.
- **FR-46** The terminal channel MUST reuse the existing terminal frame protocol so a pane can
  render either source without a second renderer.
- **FR-47** The existing Agent Terminal tab MUST continue to work unchanged; the Node-hosted
  terminal is an additional source, selected by the Node picker, never a silent substitution.
- **FR-48** A Node that advertises a terminal capability but cannot serve a shell MUST report that
  refusal to the user rather than leaving the pane blank, and MUST stop advertising the capability
  it cannot honour on its next heartbeat.

### 4.8 Recording and re-watch

- **FR-49** A session MUST be recorded whenever it enters control mode or a demonstration starts;
  a watching-only session MUST be recorded only when the Node's owner has opted in for that Node
  (default off).
- **FR-50** A recording MUST capture at most **1 frame per second**, MUST NOT exceed **200 MB** or
  **4 hours** per session, and MUST stop at whichever limit comes first, saying so.
- **FR-51** Recordings MUST be retained for **14 days** by default (clamp 1–90, per Node) and MUST
  be deleted by a scheduled sweep, not on read.
- **FR-52** A recording MUST be replayable from its session and, when the session was bound to a
  Run, from that Run's receipt, with a scrubber and control spans marked on the timeline.
- **FR-53** When recording could not start, the session MUST still open and MUST state that it is
  not being recorded; the audit row and the receipt MUST both reflect that.

### 4.9 Teach a task

- **FR-54** **Teach a task** MUST be available on the computer surface and MUST require control of
  the session before recording may start, explaining why when it is not held.
- **FR-55** The teach dialog MUST require an intent — **What are you about to show?** — of 3 to 120
  characters, and MUST state, in the dialog body and not in a footnote, that passwords and one-time
  codes are never captured.
- **FR-56** On start, the Agent's own browser on that Node MUST be brought to the front, launching
  it if it is not running, and the recording MUST capture only that browser.
- **FR-57** A demonstration MUST capture, per step: the kind of act (navigate, click, type, press,
  scroll, select, upload, wait), the page address with query values redacted, the accessible name
  and role of the target control, a stable selector for it, and — for typing — the typed value
  when it is not a secret, truncated at 200 characters.
- **FR-58** A demonstration MUST NEVER capture the value of a password field, a field whose
  autofill hint marks it as a current password, a new password or a one-time code, a field whose
  accessible name, label, placeholder or name matches a credential pattern, or the contents of the
  clipboard. Such steps MUST be recorded as a named secret requirement with `redacted` set.
- **FR-59** Every captured string MUST pass the platform's secret scanner on the Node before it
  leaves the machine; a step that trips the scanner MUST have its value replaced by a placeholder,
  and the step MUST say so.
- **FR-60** A demonstration MUST stop at **200 steps** or **15 minutes**, whichever comes first,
  and MUST offer **Use what I have** or **Discard**.
- **FR-61** At most **60** step screenshots MUST be kept per demonstration, each at most 200 KB.
- **FR-62** On finish, the system MUST synthesise a draft Skill and MUST deliver it in the owner's
  conversation with that Agent **and** as an approval in **My Decisions**, within 3 minutes at the
  95th percentile.
- **FR-63** A draft Skill MUST contain a title (≤ 80 characters), a one-line description
  (≤ 200 characters), numbered instructions, an explicit list of required inputs, and an explicit
  list of required secrets named by their label — never their value.
- **FR-64** Synthesis MUST be retried at most **3** times with 30-second, 2-minute and 10-minute
  backoff, and MUST report failure in the same conversation rather than silently dropping.
- **FR-65** Approving a draft MUST create a Skill owned by that Agent and bind it to that Agent,
  and MUST resolve an identifier collision by suffixing rather than overwriting, telling the user
  the name it used.
- **FR-66** Rejecting a draft MUST create no Skill, MUST record the decision, and MUST keep the
  demonstration for **30 days**.
- **FR-67** A demonstration whose draft is never decided MUST expire its approval after **30 days**
  and MUST say so in the conversation.
- **FR-68** **Make a Skill from this run** MUST offer the same synthesis over a recorded session's
  stored steps without requiring a new demonstration, and MUST be offered only when steps exist.

### 4.10 Node selection and health

- **FR-69** The Node picker MUST list every Node the viewer may see, ordered: the Agent's bound
  Node first, then online Nodes by most recent heartbeat, then the rest.
- **FR-70** Every Node row MUST carry a status dot, name, platform, last heartbeat in relative
  time, and — when it cannot be watched — a one-line reason drawn from a closed set: offline,
  paused, disabled, draining, no display, no browser, no terminal, not attended, cluster node.
  *No display* and *no browser* make only the screen channel unavailable, and *no terminal* only
  the terminal channel; a Node is unwatchable only when it can serve **neither** channel, and a
  Node that can serve one channel is listed as watchable on that channel with the other channel's
  reason shown beside it (FR-4a).
- **FR-71** Selecting a Node to watch MUST NOT change the Agent's affinity binding, and the picker
  MUST say so and link to where the binding is changed.
- **FR-72** Cluster-derived Nodes MUST be listed as unwatchable with that reason, never hidden.

### 4.11 Permissions, safety and audit

- **FR-73** Only the Node's owner MAY watch by default; Organization members MAY watch only when
  the Node's control policy is set to admins or members, and MUST still be refused control unless
  the policy allows it.
- **FR-74** Every session open, session close, control grant, control release, take-over refusal,
  demonstration start, demonstration finish and profile reset MUST write an audit row within 2
  seconds, into the same Fleet audit ledger that already records credential and panic actions.
- **FR-75** Audit rows MUST never contain frame bytes, typed values, selectors carrying values, or
  any secret; redaction MUST be applied before the row is written.
- **FR-76** When the Fleet stop switch is on, no session MAY open and every live session MUST end
  within 5 seconds with that reason.
- **FR-77** A Node that is paused, disabled or draining MUST refuse new sessions, naming its state.
- **FR-78** Session opens MUST be rate-limited to 10 per minute per user, control requests to 20
  per minute per user, and refreshes to 30 per minute per session.
- **FR-79** Losing access mid-session (membership revoked, Agent archived, Node deleted) MUST close
  the viewer's session within 30 seconds, releasing any control first.

### 4.12 Cost and honesty

- **FR-80** The surface MUST state that watching and controlling spend no model tokens and no
  credits, and MUST show the bandwidth a session has used since it opened.
- **FR-81** Teaching a task MUST show, before **Start recording**, that synthesising the draft
  Skill will use the Agent's model, and the resulting Run MUST appear in Runs with its cost like
  any other Run.
- **FR-82** The surface MUST NOT claim a Node is showing a full desktop when it is showing the
  Agent's browser; the identity strip MUST name what is being captured.

### 4.13 Accessibility and keyboard

- **FR-83** Every control on the surface MUST be reachable and operable by keyboard alone, and the
  stage MUST be a labelled, focusable region that announces its mode on focus.
- **FR-84** The shortcuts MUST be: `T` take over, `Escape Escape` give back control, `R` refresh,
  `Q` cycle quality, `C` switch channel, `N` open the Node picker, `L` open teach, `?` show the
  shortcut sheet. While in control, only `Escape Escape` MUST be intercepted; every other key MUST
  be forwarded.
- **FR-85** Mode changes MUST be announced to assistive technology through a live region.
- **FR-86** The stage MUST NOT be the only way to learn the mode: the status line, the strip and
  the announcement MUST all carry it.

---

## 5. Key entities

| Entity / concept | New? | Description |
| --- | --- | --- |
| **Agent** | Existing | The person-shaped worker whose computer is being watched. |
| **Node** (member of the **Fleet**) | Existing | The machine. Gains a control policy, a watch-recording opt-in and a recording retention window. |
| **Run** | Existing | One Agent execution. A Computer session binds to the Run in flight when there is one; the Run gains a marker saying a recording exists. |
| **Task** / **Mission** | Existing | The source of the working brief overlay. |
| **Skill** / **Skill binding** | Existing | The artefact a demonstration becomes, and how it reaches the Agent. |
| **Approval** (surfaced as **My Decisions**) | Existing | Where a draft Skill waits for a human. Gains one new action kind for adopting a Skill. |
| **Activity Log** / **Fleet audit** | Existing | Where every watch, take-over and reset is recorded. |
| **Computer session** | **NEW** | One episode of watching or controlling a Node from the product. Carries the Agent, the Node, the opener, the channel, the mode, the control spans, the bound Run and the close reason. |
| **Node profile (per-Agent)** | **NEW** | An Agent's own browser profile and file root on one Node. Carries its creation time, last use, signed-in-site count, disk usage and last reset. |
| **Demonstration** | **NEW** | One recorded teaching episode: its intent, its ordered steps, its redactions, its synthesis state and the draft Skill it produced. |

### 5.1 Why three new nouns are justified

Program rule 2 forbids duplicate concepts. Each of these is genuinely absent today:

- A **Computer session** is not a Run (a Run is the Agent's execution; a session is a human's
  observation of a machine, and can exist with no Run in flight, or two sessions on one Run). It
  is not a terminal session either — that one is keyed by Run, lives only in memory, and dies with
  the process, whereas this must be durable enough to audit and replay. Without it there is
  nowhere to hang "who watched what, when, and with what control".
- A **Node profile** is not a workspace (a workspace is a per-Task git worktree, created and
  reaped per job). Isolation of logins is per-Agent and long-lived; a per-Task object cannot carry
  it, and without a durable record the product cannot honestly claim "own logins and files".
- A **Demonstration** is not a Skill and not a Run. It has its own lifecycle before any Skill
  exists, its own retention and redaction rules, and must survive a rejected draft so the owner can
  ask for another. Folding it into the Skill would create half-formed Skills; folding it into a Run
  would make an un-adopted demonstration invisible.

### 5.2 Computer session lifecycle

```
   requested ──claimed by node──► live ──take over──► controlled ──release──► live
       │                            │                     │                    │
       │ no claim in 40 s           │ stall 45 s          │ idle 10 min ───────┘
       ▼                            ▼                     │ disconnect 30 s
   abandoned                     stalled                  │ ceiling 60 min
       │                            │                     ▼
       └──────────────┬─────────────┴──────────────► ended
                      │
      also ends on: viewer gone 15 s · no viewer 30 min · session ceiling 4 h ·
                    stop switch · node restart · access revoked · node paused
```

Close reasons form a closed set: `closed-by-user`, `no-viewer`, `session-ceiling`, `stalled`,
`node-restarted`, `node-unavailable`, `stopped`, `access-revoked`, `abandoned`, `error`.

### 5.3 Demonstration lifecycle

```
   recording ──finish──► captured ──dispatch──► synthesising ──ok──► drafted
       │                     │                       │                  │
       │ discard             │ 200 steps / 15 min    │ 3 failures       ├─ approve ─► adopted
       ▼                     ▼ (still captured)      ▼                  └─ reject ──► discarded
   discarded                                    synthesis-failed              │
                                                                    expires after 30 days
```

### 5.4 Control spans

A session carries an ordered list of control spans. Each span names the person, the start, the end
and the release reason (`given-back`, `idle`, `disconnected`, `ceiling`, `handed-over`, `revoked`,
`session-ended`). A recording's scrubber marks each span; a Run receipt counts them.

---

## 6. UX

All copy below is the exact user-visible string. Every surface is shown in each of its states.

### 6.1 Entry — the Agent page action row

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◉ Ops                                                          ● Active     │
│  Operations agent · reports to Fin                                           │
│                                                                              │
│  [ Message Ops ]  [ 🖥 Watch computer ]  [ 👋 Nudge ]  [ Pause ]  [ Configure ]│
└──────────────────────────────────────────────────────────────────────────────┘
```

`Watch computer` sits second, immediately after `Message Ops`. When the owner has no Node, the
button is present and enabled — it opens the empty state in §6.7, which is the enrolment path.

### 6.2 The computer surface — watching, loaded

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ← Ops    🖥 Ops' computer                                     [ 🎓 Teach a task ] │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Ops · studio-imac ▾ · 09:41:07 local · Screen · Sharp                   ● LIVE   │
├──────────────────────────────────────────────────────────────────────────────────┤
│┌────────────────────────────────────────────────────────────────────────────────┐│
││                                                                                ││
││              ( live picture of Ops' own browser on studio-imac )               ││
││                                                                                ││
││                          ┌──────────────────────────┐                          ││
││                          │      [ Take over ]       │                          ││
││                          │  Watching. Take over to  │                          ││
││                          │  use your mouse and      │                          ││
││                          │  keyboard.               │                          ││
││                          └──────────────────────────┘                          ││
││                                                                                ││
││  ┌ BRIEF · Reconcile September invoices ───────────────────────────┐            ││
││  │ Mission: Month-end close                                        │            ││
││  └─────────────────────────────────────────────────────────────────┘            ││
││                                        EVER WORKS · LIVE VIEW · Ops @ studio-imac││
│└────────────────────────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────────────┤
│ Watching — Ops keeps working.                                                    │
│ [ Screen | Terminal ]   [ Sharp ▾ ]   [ ↻ Refresh ]   [ Take over ]  [ ⋯ ]        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The `⋯` menu holds: **Own logins and files**, **Copy link to this view**, **Bandwidth used: 12.4 MB**,
**End session**.

### 6.3 In control

```
├══════════════════════════════════════════════════════════════════════════════════┤  ← amber border
│ Ops · studio-imac ▾ · 09:43:22 local · Screen · Sharp        ● LIVE  ✋ YOU       │
├──────────────────────────────────────────────────────────────────────────────────┤
│┌────────────────────────────────────────────────────────────────────────────────┐│
││                                                                                ││
││          ( your pointer and keyboard are driving this machine )                ││
││                                                                                ││
││                                        EVER WORKS · LIVE VIEW · Ops @ studio-imac││
│└────────────────────────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────────────┤
│ You have control — Ops' input is paused.  Control ends in 57:04.                 │
│ [ Screen | Terminal ]  [ Sharp ▾ ]  [ ↻ ]  [ Give back control ]  [ 🎓 Teach ]   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Tooltip on the timer: *"A single stretch of control lasts at most an hour. You can extend it once."*

### 6.4 Idle release warning

```
┌───────────────────────────────────────────────────────┐
│  Giving control back in 0:30                          │
│  Ops has been waiting since 09:53.                    │
│                        [ Keep control ]  [ Give back ]│
└───────────────────────────────────────────────────────┘
```

### 6.5 Node picker open

```
┌ studio-imac ▾ ────────────────────────────────────────────────────────┐
│ WATCHING A COMPUTER DOES NOT CHANGE WHERE OPS' WORK RUNS.             │
│ Ops is pinned to studio-imac. Change that on Ops' Capabilities tab.   │
├───────────────────────────────────────────────────────────────────────┤
│ ● studio-imac      macOS · 4s ago            Pinned to Ops       ✓    │
│ ● build-box-01     Ubuntu · 11s ago          Screen, Terminal          │
│ ◐ dev-laptop       Windows · 2m ago          Draining — not available │
│ ○ old-mini         macOS · 3d ago            Offline                  │
│ ○ ci-runner-7      Ubuntu · 8s ago           No browser found         │
│ ○ office-nuc       Ubuntu · 6s ago           Live view is switched off│
│ ○ prod-worker-3    Kubernetes                Cluster node — read only │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.6 Loading / connecting

```
┌────────────────────────────────────────────────────────────────┐
│ Ops · studio-imac · —:—:— · Screen · Sharp          ○ CONNECTING│
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                  ◜ ◝  Waking up the view…                      │
│              Asking studio-imac for a picture.                 │
│                                                                │
│                        [ Cancel ]                              │
└────────────────────────────────────────────────────────────────┘
```

After 20 seconds the sub-line becomes *"studio-imac has not answered yet. It may be busy."*
After 40 seconds it becomes §6.10.

### 6.7 Empty — no computers at all

```
┌─────────────────────────────────────────────────────────────────────┐
│                          🖥                                          │
│              Ops does not have a computer yet                       │
│                                                                     │
│  Agents work on machines you own. Add one and you can watch it,     │
│  take over when a step needs you, and teach it how you do things.   │
│                                                                     │
│                 [ Add a computer ]   [ How this works ]             │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.8 Offline

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ○                                          │
│                 studio-imac is offline                              │
│      Last heard from 3 days ago (2 Sep 2026, 18:04).                │
│                                                                     │
│      Start the Ever Works node app on that machine to bring         │
│      it back.                                                       │
│                                                                     │
│           [ Try again ]  [ Pick another computer ]                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.9 Cannot show a screen

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ⛔                                          │
│              No browser found on ci-runner-7                        │
│  Ops needs its own browser on a machine before you can watch it     │
│  work. Install Chrome, Edge or Chromium there, or point the node    │
│  at one you already have.                                           │
│                                                                     │
│   [ Watch the terminal instead ]  [ Pick another computer ]         │
└─────────────────────────────────────────────────────────────────────┘
```

The display variant reads: *"office-nuc has no display session"* with the same shape.

### 6.10 Not attended / nobody claimed the session

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ⏳                                          │
│         Live view is switched off on office-nuc                     │
│  Run this on that machine to turn it on:                            │
│                                                                     │
│      ever-works-node start --attend                          [copy] │
│                                                                     │
│           [ Try again ]  [ Pick another computer ]                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.11 Stream stalled

```
│┌────────────────────────────────────────────────────────────────────────────────┐│
││  ( last frame, dimmed to 40% )                                                 ││
││                    ⚠ Stream stalled — last frame 12s ago                       ││
││                          [ ↻ Refresh now ]                                     ││
│└────────────────────────────────────────────────────────────────────────────────┘│
│ Watching — Ops keeps working. The picture is stale; the work is not.             │
```

At 45 seconds:

```
│                    The stream stopped.                                           │
│           The computer may be busy or asleep.                                    │
│                    [ Reconnect ]                                                 │
```

### 6.12 Auto-degraded quality

```
│ Ops · studio-imac · 09:44:10 local · Screen · Steady ⚠                   ● LIVE   │
   …
│ Lowered to Steady — the connection is slow. It will go back to Sharp on its own. │
```

### 6.13 Someone else has control

```
┌───────────────────────────────────────────────────────────────┐
│  Dana has had control since 09:12.                            │
│  You can watch. Ask for control and Dana will be prompted.    │
│                         [ Request control ]  [ Keep watching ]│
└───────────────────────────────────────────────────────────────┘
```

Shown to the current controller:

```
┌───────────────────────────────────────────────────────────────┐
│  Priya is asking for control of studio-imac.                  │
│  Declines on its own in 0:47.                                 │
│                          [ Hand over ]  [ Keep control ]      │
└───────────────────────────────────────────────────────────────┘
```

Shown to the requester on auto-decline: *"Dana did not answer. You still have watching access."*

### 6.14 Control denied by policy

```
[ Take over ]  ← disabled
Tooltip: "Only the owner of this computer can take control."
```

### 6.15 Over-limit

```
┌───────────────────────────────────────────────────────────────┐
│  studio-imac already has 2 live views                         │
│    • Dana — watching since 09:02                              │
│    • Priya — in control since 09:12                           │
│  Close one to open another.                                   │
│                                     [ Pick another computer ] │
└───────────────────────────────────────────────────────────────┘
```

### 6.16 Fleet stopped

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⛔ All computers are stopped — "Investigating a runaway job" · since 08:55 │
│    Live views are closed while the stop is in force.                      │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6.17 Teach a task — the dialog

```
┌──────────────────────────────────────────────────────────────────────┐
│  Teach Ops a task                                               [×]  │
├──────────────────────────────────────────────────────────────────────┤
│  Do the task once while Ops watches. When you press Start, Ops' own  │
│  browser comes to the front on studio-imac — demonstrate in that     │
│  browser, because that is what gets recorded.                        │
│                                                                      │
│  Clicks and typed values are captured. Passwords and one-time codes  │
│  never are.                                                          │
│                                                                      │
│  When you finish, Ops studies the recording and replies in your      │
│  conversation with a draft skill for you to approve.                 │
│                                                                      │
│  WHAT ARE YOU ABOUT TO SHOW?                                         │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ File a supplier invoice in the finance portal                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│  3–120 characters. 45 used.                                          │
│                                                                      │
│  Synthesising the draft uses Ops' model and appears in Runs like     │
│  any other run.                                                      │
│                                                                      │
│                                  [ Cancel ]  [ Start recording ]     │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.18 Teach — the guard when not in control

```
┌──────────────────────────────────────────────────────────────────────┐
│  Teach Ops a task                                               [×]  │
├──────────────────────────────────────────────────────────────────────┤
│  ⚠ Take control of the computer first — a recording of Ops working   │
│    is not a demonstration.                                           │
│                                              [ Take control ]        │
│  … (rest of the dialog, dimmed)                                      │
│                                  [ Cancel ]  [ Start recording ] ✕   │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.19 Recording strip

```
├──────────────────────────────────────────────────────────────────────────────────┤
│ ⏺ RECORDING  “File a supplier invoice in the finance portal”   Step 14 of 200    │
│    Passwords and one-time codes are never captured.   [ Pause ] [ Discard ] [ Finish ] │
└──────────────────────────────────────────────────────────────────────────────────┘
```

On a secret step the strip flashes once and reads, for 3 seconds:
*"🔒 Secret skipped — Ops will ask you for this when it runs."*

At the cap:
*"Recording stopped — that is as long as a demonstration can be."* `[ Use what I have ] [ Discard ]`

### 6.20 After finish

```
│  Ops is studying your demonstration…                                             │
│  14 steps · 2 secrets noted · usually under a minute                             │
```

### 6.21 The draft in chat

```
┌─ Ops ────────────────────────────────────────────────────────── 09:58 ─┐
│ I watched you file a supplier invoice. Here is what I learned.         │
│                                                                        │
│ ┌ DRAFT SKILL ────────────────────────────────────────────────────────┐│
│ │ File a supplier invoice in the finance portal                       ││
│ │ Files a received supplier invoice against the right cost centre and ││
│ │ marks it awaiting approval.                                         ││
│ │                                                                     ││
│ │ 1. Open the finance portal and sign in.                             ││
│ │ 2. Go to Payables → New invoice.                                    ││
│ │ 3. Enter the supplier name, invoice number and amount.              ││
│ │ 4. Attach the invoice PDF.                                          ││
│ │ 5. Choose the cost centre that matches the purchase order.          ││
│ │ 6. Save as “Awaiting approval”.                                     ││
│ │                                                                     ││
│ │ I will need from you each time:  supplier · invoice number ·        ││
│ │ amount · the PDF · the cost centre                                  ││
│ │ I will need once:  the finance portal sign-in  🔒                    ││
│ │                                                                     ││
│ │ 14 steps recorded · 2 secrets noted, never captured                 ││
│ │             [ Approve and add to Ops ]  [ Edit first ]  [ Discard ] ││
│ └─────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────┘
```

After approval the card collapses to: *"Added to Ops' skills as “File a supplier invoice in the
finance portal”."* with a link.
After rejection: *"Discarded — the demonstration is kept for 30 days if you want another draft."*
On synthesis failure: *"I could not turn that into a skill. The recording is saved; ask me to try
again."* `[ Try again ]`

### 6.22 The demonstration review (opened from the card's **Edit first**)

```
┌ Demonstration · File a supplier invoice in the finance portal ───────────┐
│ Recorded 6 Sep 2026, 09:56 · studio-imac · 14 steps · 1m 51s             │
├──────────────────────────────────────────────────────────────────────────┤
│  1  ↗ Open   finance.example.internal/login                       [thumb]│
│  2  ⌨ Type   Email          →  ops@example.com                           │
│  3  ⌨ Type   Password       →  🔒 secret, not captured                    │
│  4  ⏎ Press  Sign in                                                     │
│  5  ↗ Open   /payables/new                                        [thumb]│
│  6  ⌨ Type   Supplier       →  “Northwind Supplies”                      │
│ ⋮                                                                        │
│ 14  🖱 Click  Save as awaiting approval                            [thumb]│
├──────────────────────────────────────────────────────────────────────────┤
│  Remove a step to keep it out of the skill.        [ Re-draft the skill ] │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.23 Own logins and files

```
┌ Own logins and files ────────────────────────────────────────────────────┐
│ Ops has its own browser profile on studio-imac. No other agent can read  │
│ its cookies, sessions or files.                                          │
│                                                                          │
│   Created            2 Aug 2026                                          │
│   Last used          4 minutes ago                                       │
│   Signed in to       6 sites                                             │
│   Disk used          412 MB                                              │
│   Last reset         never                                               │
│                                                                          │
│   [ Reset this agent's logins and files ]                                │
└──────────────────────────────────────────────────────────────────────────┘
```

Confirmation:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Reset Ops' logins and files on studio-imac?                             │
│  Ops will be signed out of 6 sites and its downloads there are deleted.  │
│  No other agent on this computer is touched. This cannot be undone.      │
│                                                                          │
│  Type the agent's name to confirm:  ┌───────────────┐                    │
│                                     │ Ops           │                    │
│                                     └───────────────┘                    │
│                                        [ Cancel ]  [ Reset ]             │
└──────────────────────────────────────────────────────────────────────────┘
```

Refusal while a Run is live: *"Ops is working on this computer right now. Pause it or wait for the
run to finish."*

### 6.24 Recording playback from a Run receipt

```
┌ Run · 6 Sep 2026 09:42 · Ops · Reconcile September invoices ─────────────┐
│ …                                                                        │
│ COMPUTER                                                                 │
│   studio-imac · screen · recorded 4m 12s · 1 take-over by Priya          │
│   [ ▶ Watch the recording ]                                              │
└──────────────────────────────────────────────────────────────────────────┘

┌ Recording · Ops @ studio-imac · 6 Sep 2026 09:42 ────────────────────────┐
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │  ( recorded frame, watermarked )                                     │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ ▶  ├────────▓▓▓▓▓▓▓▓▓─────────────────────────────┤  01:12 / 04:12   1× │
│                └ Priya in control 00:48 – 01:37                          │
│                                          [ Make a skill from this run ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

When there is nothing to play: *"This run was not recorded."* with the reason when one is known
(*"storage was unavailable"*, *"watching sessions are not recorded on this computer"*).

### 6.25 Terminal channel

```
│ Ops · build-box-01 ▾ · 09:41:07 local · Terminal · —              ● LIVE  read-only │
│┌────────────────────────────────────────────────────────────────────────────────┐│
││ ops@build-box-01:~/work/invoice-sync$ pnpm test                                 ││
││ …                                                                              ││
│└────────────────────────────────────────────────────────────────────────────────┘│
│ Watching — this shell is on build-box-01. Take over to type.                      │
```

### 6.26 Keyboard shortcut sheet (`?`)

```
┌ Keyboard ───────────────────────────────────────────────┐
│  T          Take over                                   │
│  Esc Esc    Give back control                           │
│  R          Refresh the picture                         │
│  Q          Cycle quality: Sharp → Smooth → Steady      │
│  C          Switch channel: screen ↔ terminal           │
│  N          Choose a computer                           │
│  L          Teach a task                                │
│  ?          This sheet                                  │
│                                                         │
│  While you have control every other key goes to the     │
│  computer. Esc Esc always comes back to you.            │
└─────────────────────────────────────────────────────────┘
```

### 6.27 Accessibility notes

- The stage is a labelled region: *"Live view of Ops' computer studio-imac. Watching."* Its label
  changes with the mode and is announced through a polite live region.
- The `● LIVE` indicator is never colour-only: it carries the word `LIVE` and a title attribute.
- The amber control border is accompanied by the `✋ YOU` badge and the status sentence.
- The recording strip is `role="status"`; the secret-skipped flash is `role="alert"`.
- Every Node row in the picker names its state in words, not only by dot colour.
- The scrubber is a slider with keyboard step (1 s) and page step (10 s).

---

## 7. Out of scope

- **Full desktop capture.** This epic captures the Agent's own browser window (and its shell on
  the terminal channel). Capturing an entire operating-system desktop is a later provider behind
  the same seam; the surface must never imply it is showing one when it is not.
- **Audio.** No sound is captured, streamed or recorded.
- **File transfer.** No drag-and-drop upload into the machine, no download out of it, no clipboard
  bridge. Control forwards input events only.
- **Recording a watching-only session by default.** Opt-in per Node.
- **Editing a recording.** Trimming, annotating and exporting clips are not in this epic; the
  player scrubs and nothing more.
- **Multi-viewer cursors.** Other viewers' pointers are not drawn.
- **Replaying a demonstration as an automation.** A demonstration produces a Skill for the Agent to
  read and act on. It is not a macro player and does not replay recorded coordinates.
- **Teaching a non-browser application.** Demonstrations capture browser steps only.
- **Cross-replica live sessions.** A session is served by the API replica that holds it; making
  live fan-out work across replicas is tracked with the existing terminal fan-out seam and is not
  solved here.
- **Changing where work runs.** The Node picker chooses what to watch. Pinning an Agent to a Node
  stays on the Agent's Capabilities tab.
- **Mobile control.** The surface is responsive and watchable on a small screen; taking control is
  offered on pointer-and-keyboard devices only.
- **Guest links.** No unauthenticated share link to a live view.

---

## 8. Acceptance criteria

**Watching**

- [ ] `Watch computer` appears in the Agent action row as the second control and opens the surface.
- [ ] With an online, attended, screen-capable Node, the first frame renders within 6 s (p95).
- [ ] The identity strip shows Agent, Node, the Node's local clock ticking, channel and quality.
- [ ] The watermark is visible on screen and appears in a screenshot of the page.
- [ ] The status line reads exactly *"Watching — <Agent> keeps working."*
- [ ] The brief overlay shows the live Task and Mission and links to the Task; with no Task it
      reads *"Idle — no task in flight"*.
- [ ] Watching for 10 minutes changes no Run's duration, verdict or cost.
- [ ] Switching quality changes the declared frame size and rate and persists per user per Node.
- [ ] A forced backlog degrades to Steady, says so, and recovers after 30 s.
- [ ] Refresh produces a keyframe; three failures restart capture without ending the session.
- [ ] Stalls surface at 6 s, auto-refresh once at 20 s, end at 45 s with a Reconnect button.

**Node selection**

- [ ] The picker lists every visible Node with status, platform, last heartbeat and, when
      unwatchable, one of the closed-set reasons.
- [ ] Selecting a Node does not change the Agent's affinity binding, and the picker says so.
- [ ] Cluster Nodes appear as read-only rather than being hidden.

**Take-over**

- [ ] `T` and the button both enter control; clicking the stage does not.
- [ ] Entering control suppresses the Agent's input and says so on screen.
- [ ] Only one controller exists per Node; a second gets the request-control flow.
- [ ] A control request auto-declines after 60 s and tells the requester.
- [ ] Control releases after 10 min idle with a 30 s countdown, at the 60 min ceiling, and 30 s
      after the controlling client stops acknowledging.
- [ ] A viewer outside the Node's control policy sees a disabled button and is refused server-side
      with the policy named.
- [ ] Grant and release each write an audit row within 2 s carrying actor, Node, Agent, session and
      reason, with no frame bytes or typed values.

**Isolation**

- [ ] Two Agents on one Node hold separate browser profiles; signing one in does not sign the other
      in.
- [ ] The isolation panel reports creation, last use, signed-in-site count and disk usage.
- [ ] Reset requires typing the Agent name, deletes only that Agent's profile, writes an audit row,
      and is refused while a Run is live for that Agent on that Node.

**Teach**

- [ ] Teach is disabled without control and shows the guard sentence verbatim.
- [ ] The dialog requires 3–120 characters and states the secret rule in the body.
- [ ] Starting brings the Agent's browser to the front, launching it when needed.
- [ ] A password, a new-password, a one-time-code field and a field labelled *API key* are all
      recorded as redacted secret steps with no value leaving the machine.
- [ ] A value that trips the secret scanner is replaced by a placeholder and the step says so.
- [ ] Recording stops at 200 steps or 15 minutes and offers Use what I have / Discard.
- [ ] A draft Skill arrives in the conversation and in My Decisions within 3 minutes (p95),
      carrying title, description, numbered steps, required inputs and required secrets by label.
- [ ] Approving creates the Skill, binds it to the Agent, and it appears on the Skills tab within
      5 s; a name collision is suffixed and reported, never overwritten.
- [ ] Rejecting creates no Skill and keeps the demonstration for 30 days.
- [ ] Three synthesis failures produce a plain failure message and no partial Skill.
- [ ] An undecided draft expires after 30 days and says so.

**Recording and re-watch**

- [ ] Control and teaching sessions are recorded; watching sessions are not unless the Node opts in.
- [ ] A recording stops at 1 fps / 200 MB / 4 h and states which limit it hit.
- [ ] The Run receipt offers *Watch the recording* and the player marks control spans.
- [ ] *Make a Skill from this run* runs synthesis over stored steps with no new demonstration.
- [ ] When storage is unavailable the session still opens, says it is not recorded, and the receipt
      repeats that.
- [ ] Recordings older than the retention window are gone after the sweep runs.

**Terminal channel**

- [ ] The terminal channel streams a shell on the selected Node and names that machine.
- [ ] An attended Node with no display session and no browser opens a terminal-only session: that
      Node leases it and the shell streams, while a screen request to the same Node is refused
      with the missing piece named.
- [ ] It is read-only while watching and typable while in control.
- [ ] The existing Agent Terminal tab behaves exactly as before.

**Safety**

- [ ] The Fleet stop switch prevents opens and ends live sessions within 5 s.
- [ ] Paused, disabled and draining Nodes refuse sessions, naming their state.
- [ ] Revoking a viewer's access closes their session within 30 s, releasing control first.
- [ ] Session opens, control requests and refreshes are rate-limited at the stated ceilings.

**Cross-cutting**

- [ ] Every functional requirement has a passing test (unit, controller spec or end-to-end).
- [ ] Every user-visible string is an i18n key; no literal copy in a component.
- [ ] The whole surface is operable by keyboard alone and passes the accessibility sweep.
- [ ] No frame bytes, typed values or secrets appear in any log, audit row or error message.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: Should watching a Node be visible to the Agent — i.e. should the Agent's
  own context ever say "your owner is watching"? Argument for: honesty and better behaviour under
  observation. Argument against: it changes the Agent's behaviour, which defeats the point of
  watching. Default assumed in this spec: the Agent is told only when its input is paused by a
  take-over, never merely by being watched.]`
- `[NEEDS CLARIFICATION: Default control policy for Organization-owned Nodes. This spec defaults
  every Node to owner-only. Should a Node enrolled inside an Organization default to
  organization-admins instead, so a team is not blocked by one person's absence?]`
- `[NEEDS CLARIFICATION: Retention default for recordings. 14 days is proposed. Does the plan tier
  matter here the way it does for terminal transcripts, and if so what are the per-tier windows?]`
- `[NEEDS CLARIFICATION: Should a demonstration be allowed to span more than one browser tab or
  window? The step model supports it; the redaction guarantees are easier to reason about if it
  does not. Proposed: allow it, and name every distinct origin visited in the draft Skill.]`
- `[NEEDS CLARIFICATION: When a draft Skill is approved, should it be bound to the Agent only, or
  offered at Organization scope so siblings inherit it? Proposed: Agent scope on adoption, with a
  one-click "share with the team" afterwards, so nothing is broadened without a second decision.]`
- `[NEEDS CLARIFICATION: Bandwidth accounting. Should a live session's bytes count toward any
  metered allowance, or remain unmetered as this spec assumes?]`
- `[NEEDS CLARIFICATION: Does the take-over surface need a break-glass for an operator who is not
  the Node's owner (support scenario), and if so what consent does the owner give first?]`

---

## 10. Constitution gates

- [x] **I — Plugin-first.** Cloud-hosted screen capture ships as a plugin behind a new capability,
      resolved through a facade. Node-hosted capture follows the existing precedent for driving a
      local browser from the Node itself, where no plugin runtime exists; the plan states this
      explicitly.
- [x] **II — Capability-driven resolution.** No caller names a capture provider; the facade
      resolves it from the settings cascade.
- [x] **III — Source-of-truth repos.** No work content moves into the database. Recording bytes go
      to the configured storage provider; only metadata is stored.
- [x] **IV — Job runtime.** Synthesis, session reaping and recording retention run as jobs through
      the configured job-runtime provider via dispatcher symbols.
- [x] **V — Forward-only migrations.** Three additive migrations, one per phase.
- [x] **VI — Tests.** Unit, controller-spec and end-to-end coverage named per phase in the plan.
- [x] **VII — Secrets.** Secret redaction is enforced on the machine before capture leaves it, and
      again before any audit row is written. No frame bytes or typed values are ever logged.
- [x] **VIII — Plugin counts.** The new plugin is added to the canonical plugin document only.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint.
- [x] **X — Backwards compatibility.** Every contract change is an additive union member or an
      optional field; the existing terminal surface is untouched.

---

## 11. References

- Program: [Agent Workspace](../README.md) · [Tracker](../TRACKER.md)
- Implementation plan: [`./plan.md`](./plan.md) · Task breakdown: [`./tasks.md`](./tasks.md)
- Related epics: [AW-09 Runs & receipts](../AW-09-runs-receipts/spec.md),
  [AW-15 Connections & scopes](../AW-15-connections-scopes/spec.md); AW-08 Skills shelf and
  AW-24 Safety rails are not yet spec'd — this epic assumes only what Skills and the approval
  queue already do today.
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
