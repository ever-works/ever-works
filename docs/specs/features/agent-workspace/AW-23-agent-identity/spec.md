# Feature Specification: Agent notes, personality, identity and levels

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `AW-23-agent-identity`
**Program**: [Agent Workspace](../README.md) — Wave 3
**Branch**: `feat/aw-23-agent-identity`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Owner**: Product
**Size**: M · **Depends on**: AW-07 (memory & context files) · **Depended on by**: AW-24 (safety rails & the trust ladder)

> **Additive-only (program rule #1).** Nothing here removes, renames or consolidates an
> existing surface. The ten tabs on an agent stay. The five canonical agent files keep
> their names, their endpoints, their hashes and their editor. `AgentStatus` keeps every
> member it has. `POST /api/agents/:id/pause` and `/resume` keep their meaning and their
> shape — this epic only makes the pause bind on more of the platform than it does today
> and gives the pause a reason. Everything below is new surface bolted on top.

---

## 1. Overview

Every agent in Ever Works gets an **identity card**: one panel that answers, without a
click, who this agent is, what it is doing right now, how much autonomy it has earned,
what it has been told to remember, and — when it is not working — the plain-English
reason why, with the failing run one click away. The card carries three new things: a
**level** (Trainee → Assistant → Specialist → Lead) that states in one word how much rope
the agent has and writes the permission and approval defaults that back that claim; a
**Personality** file that shapes how the agent talks without touching what it may do, and
that takes effect from the agent's *next* run so a run in flight never changes voice
mid-sentence; and a **live status dot with a stated reason** — *Paused by you*, *Blocked
on a credential*, *Hit an error* — that is never a bare colour. Behind the card, **Pause
becomes a platform-enforced brake**: a paused agent stops picking up scheduled runs,
assigned tasks, chat replies, inbound email and delegated work, its queued work parks
instead of failing, and resuming replays it. Pausing is safe, reversible in one click,
and — for the first time — actually total.

## 2. Why now

### 2.1 The user's question

> *"Why is this one not doing anything?"*

and, right behind it:

> *"If I pause it, is it actually stopped?"*

### 2.2 What they do today instead

| The need | What Ever Works offers today | What the user actually does |
| --- | --- | --- |
| See at a glance whether an agent is alive | A six-value status chip on the agent card and hero, rendered from the raw enum value — the hero prints the untranslated string `paused` — with no reason, no timestamp and no next step. | Opens the Activity tab and reads run history to guess. |
| Know *why* an agent stopped | Nothing. `status = 'error'` is reached silently once `errorCount` passes `pauseAfterFailures` (default 3). The count is shown; the cause is not. | Opens the Sessions list, finds the newest failed run, reads the raw error. |
| Know an agent stopped because a credential died | Nothing at all. A revoked token surfaces as a generic run failure, three times, and then as a bare `error` chip. | Discovers it days later. |
| Stop an agent completely | `Pause` exists and is honoured by exactly one dispatch path — the heartbeat claim. Assigning a task to a paused agent runs it. So does an `@mention` chat reply. So does delegation from a parent agent. | Believes the agent is stopped. It is not. |
| Pause without losing queued work | Not a question that can be asked, because pause does not park anything. | — |
| Say how much autonomy an agent has | Eight boolean permissions, a nullable guardrails object and a merge-policy override, spread over two tabs. All eight permissions default to `false` and guardrails default to `null` ("queue everything"), so **every agent looks identical from the outside**. | Opens Settings and Capabilities and reads eleven controls. |
| Shape how an agent writes | The five canonical files mix identity, role, operating loop and tool notes. Voice ends up smeared across `SOUL.md` and `AGENTS.md`, where editing it risks editing the agent's job. | Edits `SOUL.md` and hopes. |
| Change voice safely mid-flight | Nothing. A file edit is picked up by whatever assembles the next prompt, with no statement of when it takes effect. | Waits and re-reads output to check. |
| See what an agent has been told to remember | The per-agent Notes file arrives with [AW-07](../AW-07-memory-context/spec.md), but it lives inside a file editor two clicks from anywhere a decision is made. | Opens the Instructions tab. |

Four gaps, all of them ours:

1. **Status is a colour, not an answer.** The platform knows why an agent stopped in every
   case — a person pressed pause, a run failed *n* times, a provider rejected a
   credential — and it persists none of it. The one place the reason exists is a raw error
   string on the newest failed run, which nothing links to from the agent.
2. **Pause is a suggestion.** It binds on the heartbeat dispatcher and nothing else.
   `POST /api/agents/:id/assign-task` checks that the agent exists, that the task exists,
   that a dispatcher is bound and that the concurrency valve admits — and never once looks
   at the agent's status. This is the single most damaging honesty gap on the agent
   surface: the product's most reassuring control does not do what its label says.
3. **Autonomy is invisible until you audit it.** The permission model is real and enforced,
   but it is eleven controls on two tabs with all-`false` defaults, so nothing about an
   agent tells you whether it is allowed to spend a cent or open a pull request. There is
   no vocabulary for "this one has earned more rope than that one".
4. **Voice has no home.** There is no file whose job is tone, so tone gets written into the
   files whose job is capability, and every voice edit is also a capability edit.

### 2.3 What this epic changes

```
   BEFORE                                    AFTER
   ------                                    -----

   /agents/[id]                              /agents/[id]
   +--------------------------------+        +---------------------------------------------+
   | (A) research-agent   [ paused ]|        | (A) research-agent   * Paused by you  Resume |
   |     Senior researcher          |        |     Senior researcher   [ Specialist ]      |
   |     tenant scope | gpt-x | slug|        |     Since 14:02 - "holding until Friday"    |
   +--------------------------------+        |---------------------------------------------|
   | heartbeat | idle | last | next |        | Working on  - nothing, paused                |
   +--------------------------------+        | Notes       - "Prefers UK spelling." Edit    |
   | capabilities free text         |        | Personality - "Dry, concrete, no filler" Edit|
   +--------------------------------+        | Level       - Specialist. Money and public   |
                                             |               actions still wait for you.    |
   pause = heartbeats only                   |               2 settings differ from default |
   +--------------------------------+        +---------------------------------------------+
   | heartbeat dispatcher .. blocked|
   | assign-task ........... RUNS   |        pause = every dispatch path
   | chat reply ............ RUNS   |        +---------------------------------------------+
   | delegated sub-agent ... RUNS   |        | heartbeat / assign-task / chat / email /     |
   | inbound email ......... RUNS   |        | delegation / run-now ....... all park or 409 |
   +--------------------------------+        | parked work drains on Resume                 |
                                             +---------------------------------------------+
```

Three independently shippable phases:

- **P1 — the brake and the reason.** A halt reason on every stopped agent, the status dot
  and its stated reason everywhere an agent is rendered, pause enforced at the single
  admission point every dispatch path already crosses, parked work that drains on resume.
- **P2 — levels.** A four-rung ladder, its defaults, its diff, its promotion signal.
- **P3 — personality and the finished card.** The Personality file, its next-run-only
  semantics, and the identity card assembled from all of it.

## 3. User scenarios

### 3.1 Primary

- **S1 — See why an agent is stopped, without leaving the page.**
  **Given** an agent whose last three runs failed,
  **when** the owner opens the agent,
  **then** the identity card shows a red dot, the headline **"Hit an error"**, the sub-line
  *"3 runs failed in a row — last one 12 minutes ago"*, and a **See the failing run** link
  that opens that exact run.

- **S2 — Pause actually stops everything.**
  **Given** an active agent with a heartbeat every 15 minutes, two tasks about to be
  assigned to it and an unanswered `@mention` in a task chat,
  **when** the owner presses **Pause**,
  **then** the card reads **"Paused by you"** with the time, the heartbeat stops firing,
  the two task assignments are accepted but **parked** with the reason *"Waiting — the
  agent is paused"*, the chat reply does not run, and nothing anywhere reports a failure.

- **S3 — Resume replays what was held.**
  **Given** the agent from S2, paused for two hours with three parked runs,
  **when** the owner presses **Resume**,
  **then** the status returns to **Idle** or **Working**, the reason line clears, the three
  parked runs are released oldest-first, and a toast reads *"Resumed — 3 held runs
  released."*

- **S4 — Say why you paused it.**
  **Given** an owner about to pause an agent,
  **when** they press **Pause** and type *"holding until the rebrand ships Friday"* into
  the optional note,
  **then** the card's reason line reads **"Paused by you"** with that note underneath, and
  the note appears in the activity feed entry for the pause.

- **S5 — A dead credential names itself.**
  **Given** an agent whose model provider account has been revoked,
  **when** its next run fails because the provider rejected the credential,
  **then** the agent halts immediately — not after three failures — the card reads
  **"Blocked on a credential"**, the sub-line names the connection that was rejected
  without printing any part of the credential, and two links are offered: **See the run**
  and **Fix the connection**.

- **S6 — Give an agent a level.**
  **Given** an agent with no level set,
  **when** the owner opens the level control and chooses **Specialist**,
  **then** a preview lists exactly what will change — *"Can assign tasks: no → yes. Can
  edit skills: no → yes. Can commit to a repository: no → yes. Approvals: everything
  queues → routine work runs, money and outside actions still queue."* — and nothing is
  written until they confirm.

- **S7 — See that an agent's settings drifted from its level.**
  **Given** a Specialist whose "can commit to a repository" permission was later switched
  off by hand,
  **when** the owner opens the card,
  **then** the level chip carries a quiet marker and the line reads *"2 settings differ
  from the Specialist defaults"* with a **Show the differences** link; nothing is changed
  automatically and the agent keeps working.

- **S8 — Learn that an agent has earned a promotion.**
  **Given** an Assistant that has completed 34 runs in the last 30 days with no rejected
  approval and one escalation,
  **when** the owner opens the card,
  **then** a single line reads *"Ready for Specialist — 34 runs, no rejected approvals in
  30 days"* with a **Review** link that opens the same previewed, confirmed level change
  as S6. Nothing is promoted automatically, ever.

- **S9 — Give an agent a voice.**
  **Given** an agent that writes in a register the owner dislikes,
  **when** they open **Personality** and write *"Short sentences. No adjectives you would
  not say out loud. Never open with 'Certainly'."* and save,
  **then** the editor confirms *"Saved — takes effect on the next run"*, the identity card
  shows the first line of the personality, and the agent's next run writes in that voice.

- **S10 — Voice does not change mid-run.**
  **Given** a run that started three minutes ago,
  **when** the owner saves a new Personality while that run is still going,
  **then** the editor says *"Saved — takes effect on the next run. 1 run in flight is
  still using the previous version."*, and the in-flight run finishes in the old voice.

### 3.2 Unhappy paths, races, empty states and denials

- **S11 — Run now on a paused agent is refused, clearly.**
  **Given** a paused agent,
  **when** the owner presses **Run now**,
  **then** nothing is dispatched and the message reads *"This agent is paused. Resume it
  first."* with a **Resume** button in the message. No run row is created.

- **S12 — Pause while a run is in flight.**
  **Given** an agent with one run 40 seconds in,
  **when** the owner presses **Pause**,
  **then** the pause takes effect immediately for everything *new*, the in-flight run is
  left to finish, the card reads **"Paused by you"** with the sub-line *"1 run still
  finishing"*, and a secondary **Stop it now** action is offered that requests the
  existing cooperative stop. Nothing is killed without a second, explicit action.

- **S13 — Two people pause and resume at the same time.**
  **Given** two members of the same workspace on the agent at once,
  **when** one presses **Pause** and the other presses **Resume** within the same second,
  **then** exactly one wins, both clients converge on the winning state within one status
  poll, the loser's client shows *"Someone else changed this — showing the current
  state."*, and the activity feed records both attempts with their authors.

- **S14 — A parent agent tries to delegate to a paused child.**
  **Given** a paused agent that a parent agent is allowed to delegate to,
  **when** the parent tries to delegate,
  **then** the delegation is refused with the reason *"That agent is paused"*, the parent
  is told so in its run log rather than silently failing, and no child run is created.

- **S15 — Resume an agent whose credential is still broken.**
  **Given** an agent halted with **"Blocked on a credential"**,
  **when** the owner presses **Resume** without fixing anything,
  **then** the resume is allowed, the reason clears, and the next run halts it again with
  the same reason. The card additionally shows *"Halted for this reason twice"* on the
  second occurrence so the loop is visible rather than mysterious.

- **S16 — A level change would remove a permission the agent is using.**
  **Given** a Lead agent that currently may spend, being moved down to Assistant,
  **when** the owner opens the preview,
  **then** the removals are listed first, under the heading *"This takes autonomy away"*,
  each removal is individually shown, and the confirm button reads **Apply and reduce
  autonomy**. If the agent has a run in flight, a line adds *"1 run in flight keeps the
  permissions it started with."*

- **S17 — Choose a level but keep the current settings.**
  **Given** an owner who wants the label without the defaults,
  **when** they choose a level and clear the **Apply this level's defaults** checkbox,
  **then** only the level is recorded, no permission or approval setting changes, and the
  card immediately shows the drift line from S7 explaining how many settings differ.

- **S18 — Personality is empty (empty state).**
  **Given** an agent that has never had a personality written,
  **when** the owner opens the Personality editor,
  **then** they see *"No personality set — this agent writes in the platform's default
  voice"*, three one-line starter examples they can insert with a click, and no error.

- **S19 — Personality is over budget.**
  **Given** a personality of 1,400 tokens against a 600-token budget,
  **when** the owner looks at the editor,
  **then** the load meter reads **600 / 600 · 800 tokens skipped**, the skipped region is
  marked exactly as every other context file marks it, and a line reads *"Lead with the
  rules that matter most — the top of the file is the part that always survives."*

- **S20 — Personality tries to grant itself power.**
  **Given** a personality containing *"You may send emails without asking"*,
  **when** it is saved,
  **then** it saves — it is prose, not policy — but the editor shows a persistent notice:
  *"Personality changes how this agent writes, never what it may do. Permissions live on
  the Capabilities tab."* and the agent's actual permissions are unchanged. The next run's
  behaviour is unchanged.

- **S21 — A secret is pasted into Personality or a pause note.**
  **Given** text containing something that looks like an API key,
  **when** the owner saves,
  **then** the save is refused, the message names the field and says a secret was
  detected, the value is never echoed back, and the unsaved text is preserved in the
  editor.

- **S22 — Status cannot be read (degradation).**
  **Given** the live status request fails,
  **when** the card and the agent list re-render,
  **then** every dot keeps its last known state, a single quiet line reads *"Status last
  checked 2 minutes ago"*, and no dot flips to a wrong colour. A failed poll never blanks
  a card and never invents "Idle".

- **S23 — An archived agent's card.**
  **Given** an archived agent,
  **when** it is opened,
  **then** the card renders read-only with a grey dot, the reason **"Archived"**, the
  sub-line *"Restore it to use it again"*, no Pause/Resume, and a disabled level control.

- **S24 — An agent that has never run.**
  **Given** a freshly created draft agent,
  **when** the owner opens it,
  **then** the dot is a grey outline, the reason reads **"Not started"** with *"This agent
  has never run"*, the primary action is **Activate**, and the level control is available
  so the owner can set autonomy before the first run rather than after.

- **S25 — Pause is pressed on an agent that is already paused.**
  **Given** a paused agent and a stale browser tab,
  **when** **Pause** is pressed again,
  **then** the request succeeds as a no-op, the note is *not* overwritten by an empty one,
  the original pause time and author are preserved, and no duplicate activity row is
  written.

- **S26 — Level defaults are applied while another edit is in flight.**
  **Given** an owner applying level defaults while a second tab is saving a permission
  change,
  **when** both land,
  **then** the level application is refused if the agent changed since the preview was
  computed, the message reads *"This agent changed since the preview — here is the new
  preview"*, and the fresh preview is shown rather than a blind overwrite.

## 4. Functional requirements

### 4.1 The identity card

- **FR-1** Every agent MUST have an identity card rendered at the top of its detail
  surface, above the existing tabs, without adding a tab or a route.
- **FR-2** The card MUST show, in this order: avatar, name, title, level chip, live status
  dot, stated reason, the primary lifecycle action for the current state (Activate /
  Pause / Resume / Restore), and then four rows — **Working on**, **Notes**,
  **Personality**, **Level**.
- **FR-3** **Working on** MUST show the current run's activity line when a run is in
  flight, the time it started, and a link to that run; otherwise it MUST show the next
  scheduled run time, or *"No schedule set"* when there is none.
- **FR-4** **Notes** MUST show the first **2** lines of the agent's Notes file (delivered
  by [AW-07](../AW-07-memory-context/spec.md)) with an **Edit** link, or *"No notes yet"*.
- **FR-5** **Personality** MUST show the first **2** lines of the agent's Personality file
  with an **Edit** link, or *"No personality set"*.
- **FR-6** **Level** MUST show the level name, its one-sentence meaning, and — when the
  agent's settings differ from that level's defaults — a count of differences with a link
  that lists them.
- **FR-7** A compact form of the card (avatar, name, dot, reason headline, level chip)
  MUST be available wherever an agent is listed, and MUST reuse the same reason
  derivation as the full card so the two can never disagree.
- **FR-8** The card MUST render completely from a single request; it MUST NOT require the
  client to fan out to more than one endpoint for its first paint.
- **FR-9** Every element of the card MUST have a defined empty state; none may render a
  spinner for longer than the first paint, and none may render `undefined`.

### 4.2 Live status and the stated reason

- **FR-10** Every agent MUST expose a **status reason** drawn from this closed set, derived
  server-side, never computed in the browser:
  `working`, `idle`, `waitingOnYou`, `pausedByYou`, `blockedOnCredential`,
  `stoppedByFailures`, `stoppedAtACap`, `stoppedByThePlatform`, `notStarted`, `archived`.
- **FR-11** Each reason MUST map to exactly one dot appearance: `working` green,
  `idle` grey, `waitingOnYou` amber, `pausedByYou` amber, `blockedOnCredential` amber,
  `stoppedByFailures` red, `stoppedAtACap` amber, `stoppedByThePlatform` amber,
  `notStarted` grey outline, `archived` grey.
- **FR-12** Every reason MUST carry a human sub-line. A dot without a sentence next to it
  is not a valid rendering of agent status anywhere in the product.
- **FR-13** `stoppedByFailures` MUST link to the newest failed run of that agent, reachable
  in **one** click from the card.
- **FR-14** `blockedOnCredential` MUST name the connection or provider that was rejected
  and MUST NOT include any part of the credential, in the UI, in logs, or in the API
  payload.
- **FR-15** `waitingOnYou` MUST be raised when the agent has at least one open escalation
  or at least one pending approval proposal, and MUST link to it.
- **FR-16** The reason MUST be **persisted** at the moment the agent stops — with its
  cause, its time, the person who caused it when there is one, and the run that caused it
  when there is one — not recomputed from logs afterwards.
- **FR-17** A stored halt reason MUST be cleared on resume, on activation from draft, and
  on unarchive, and at no other time.
- **FR-18** Live status MUST refresh at most every **10 seconds** while the surface is
  visible, MUST stop polling when the tab is hidden, and MUST resume within one interval
  when it becomes visible again.
- **FR-19** A list of agents MUST refresh their statuses in **one** request covering up to
  **100** agents, not one request per agent.
- **FR-20** A failed status refresh MUST keep the last known state, MUST surface *"Status
  last checked <relative time>"*, and MUST NOT change any dot.

### 4.3 Pause as a platform-enforced brake

- **FR-21** While an agent is paused, the platform MUST refuse or park work from **every**
  dispatch path: scheduled heartbeat runs, task assignment, chat replies to an
  `@mention`, inbound email handling, delegation from a parent agent, and manual
  **Run now**.
- **FR-22** Enforcement MUST happen at the platform's existing single run-admission point,
  so that any future dispatch path inherits it without a code change at the call site.
- **FR-23** Work that arrives for a paused agent through an asynchronous path (task
  assignment, chat, email, delegation) MUST be **parked**, not failed: the run row is
  created in a queued state carrying the reason *the agent is paused*.
- **FR-24** Work that arrives through a **synchronous, user-initiated** path (**Run now**)
  MUST be refused with a `409`-class response and the message *"This agent is paused.
  Resume it first."*, and MUST NOT create a run row.
- **FR-25** Resuming MUST release parked runs for that agent oldest-first, up to **50** per
  resume, and MUST report how many were released.
- **FR-26** Parked runs MUST NOT be counted as failures, MUST NOT increment the agent's
  error count, and MUST be exempt from the stale-run sweeper for as long as the agent is
  paused.
- **FR-27** A run already in flight when the pause lands MUST be allowed to finish. The
  card MUST say how many are still finishing and MUST offer a second, explicit **Stop it
  now** action that uses the existing cooperative stop.
- **FR-28** Pause MUST accept an optional note of at most **200** characters, stored,
  displayed on the card, and included in the activity entry.
- **FR-29** Pausing an already-paused agent MUST be a no-op that preserves the original
  note, time and author, and MUST NOT write a second activity entry.
- **FR-30** If the platform cannot determine whether an agent is paused, it MUST park the
  work rather than run it. The brake fails closed.
- **FR-31** An agent MUST be halted automatically, with the reason `blockedOnCredential`,
  after **one** run failure attributable to a rejected credential — not after the general
  failure threshold.
- **FR-32** An agent MUST continue to be halted automatically with the reason
  `stoppedByFailures` once consecutive failures reach its existing failure threshold
  (default **3**), which this epic does not change.
- **FR-33** When an agent is halted for the same reason a second consecutive time, the card
  MUST say so.

### 4.4 Levels

- **FR-34** An agent MUST have a level drawn from exactly four values, in this order:
  **Trainee**, **Assistant**, **Specialist**, **Lead**.
- **FR-35** A level MUST be optional. An agent with no level set MUST render as **"Level
  not set"** with a one-click control to set one. Existing agents MUST NOT be assigned a
  level automatically.
- **FR-36** Agents created after this ships MUST default to **Trainee**.
- **FR-37** Each level MUST carry exactly one sentence of user-visible meaning:
  - Trainee — *"Nothing leaves without you."*
  - Assistant — *"Routine work runs. Anything that reaches the outside waits."*
  - Specialist — *"Owns its lane end to end. Money and public actions still wait."*
  - Lead — *"Coordinates other agents and can spend within its cap."*
- **FR-38** Each level MUST define a complete set of defaults over the agent's existing
  permission flags and approval posture. The defaults MUST be:

  | Setting | Trainee | Assistant | Specialist | Lead |
  | --- | --- | --- | --- | --- |
  | Create other agents | no | no | no | **yes** |
  | Assign tasks | no | no | **yes** | **yes** |
  | Edit skills | no | no | **yes** | **yes** |
  | Edit its own agent files | no | **yes** | **yes** | **yes** |
  | Spend | no | no | no | **yes** |
  | Commit to a repository | no | no | **yes** | **yes** |
  | Open pull requests | no | no | no | **yes** |
  | Call external tools | no | **yes** | **yes** | **yes** |
  | Approval posture | everything queues | routine work runs | routine work runs | routine work runs, plus may propose spawning another agent |

- **FR-39** Sending a message outside the workspace and overriding a budget MUST queue for
  a human at **every** level, including Lead. No level auto-approves either.
- **FR-40** Applying a level's defaults MUST always be an explicit action with a preview
  that lists every field that will change, old value → new value, and MUST NOT be applied
  automatically at any time except at agent creation.
- **FR-41** A preview that removes autonomy MUST list the removals first under the heading
  *"This takes autonomy away"* and MUST label its confirm button **Apply and reduce
  autonomy**.
- **FR-42** Setting a level without applying its defaults MUST be possible, and MUST
  immediately produce the drift indicator described in FR-43.
- **FR-43** When an agent's settings differ from its level's defaults in **one or more**
  fields, the card MUST show the count and MUST offer a list of the exact differences. It
  MUST NOT change anything on its own.
- **FR-44** A level MUST NOT introduce a new runtime authorisation check. Applying a level
  writes the existing permission and approval fields; enforcement continues to happen
  exactly where it happens today.
- **FR-45** A promotion-readiness line MUST appear when, and only when, an agent below Lead
  has, in the last **30 days**: at least **20** completed runs, **zero** rejected approval
  proposals, and at most **1** escalation. It MUST state those numbers.
- **FR-46** No agent may ever be promoted automatically. The readiness line is an
  invitation to open the preview, nothing more.
- **FR-47** A level change MUST be recorded with its author, its old and new value, and
  whether defaults were applied.
- **FR-48** Applying defaults MUST be refused if the agent changed since the preview was
  computed, and MUST return a fresh preview rather than overwriting.

### 4.5 Personality

- **FR-49** Each agent MUST gain one new file, **Personality**, alongside its existing
  files and the Notes file that AW-07 adds.
- **FR-50** Personality MUST be loaded on every run of that agent with no retrieval step.
- **FR-51** Personality MUST have a budget of **600 tokens** and a body cap of **8 KB**.
- **FR-52** Over budget, Personality MUST truncate by the same head-and-tail rule and show
  the same load meter and marked skipped region as every other context file.
- **FR-53** Personality MUST be positioned in what the agent receives so that it can never
  override the agent's role, its tools, its permissions, its guardrails, or the
  workspace's shared voice on brand and legal matters. It governs tone only.
- **FR-54** The editor MUST state that constraint on screen, permanently, not as a
  dismissible tip.
- **FR-55** A saved Personality MUST take effect from the agent's **next** run. A run
  already in flight MUST finish using the version it started with, and the platform MUST
  record which version each run used.
- **FR-56** The save confirmation MUST say *"takes effect on the next run"* and MUST name
  the number of runs in flight when that number is greater than zero.
- **FR-57** Personality MUST be secret-scanned on write and refused when a secret is
  detected, naming the field and never echoing the value.
- **FR-58** Personality MUST be treated as untrusted reference text when it reaches a run:
  fenced, labelled, and stripped of anything that could forge a turn boundary — the same
  handling every other authored segment already receives.
- **FR-59** Personality MUST carry the same revision history, attribution and one-click
  restore as every other context file.
- **FR-60** An agent MUST be able to *propose* a change to its own Personality and Notes,
  and MUST NOT be able to write either without the existing "edit agent files"
  permission. An agent MUST NEVER write another agent's files.
- **FR-61** Personality MUST be included in export and import of an agent, and an import
  that carries a Personality MUST NOT be treated as a permission change.

### 4.6 Notes on the card

- **FR-62** The Notes file itself — its storage, its every-run load, its budget, its
  revision history and the permission an agent needs to write it — is delivered by
  [AW-07](../AW-07-memory-context/spec.md) and is a hard dependency of this epic. This
  epic adds no second notes mechanism and no second notes budget.
- **FR-63** This epic MUST surface Notes on the identity card (FR-4) and MUST add it, with
  Personality, to the existing per-agent instructions editor so both are edited in the
  same place as the other agent files.
- **FR-64** Notes and Personality MUST be the only two agent files an agent may propose
  changes to on its own initiative.

### 4.7 Non-functional

- **NFR-1 Performance.** The identity card MUST return in under **300 ms** at P95. The
  batched status read MUST return in under **250 ms** at P95 for 100 agents.
- **NFR-2 Run impact.** The pause check MUST add no more than **20 ms** at P95 to run
  admission, and MUST be a single indexed read.
- **NFR-3 Safety.** The brake fails closed (FR-30). The status read fails soft (FR-20).
  These two directions are deliberate and opposite.
- **NFR-4 Privacy.** No credential value, no token fragment and no provider secret may
  appear in a halt reason, a halt detail, an activity entry, a log line or an API
  response.
- **NFR-5 Observability.** Every halt, resume, level change, defaults application and
  personality save emits an activity entry. Every parked-for-pause admission emits a run
  log line naming the agent and the reason.
- **NFR-6 Rate limits.** Pause and resume: **30** per minute per user. Level writes: **30**
  per minute per user. Personality writes: **60** per minute per user. Batched status
  reads: **120** per minute per user.
- **NFR-7 Degradation.** With no personality set, no level set and no halt reason stored,
  the card MUST render correctly with three explicit empty states and no errors — this is
  the state of every agent in every existing workspace on the day this ships.
- **NFR-8 Accessibility.** Status MUST never be conveyed by colour alone: every dot is
  accompanied by its reason as text, and the reason is what a screen reader announces.

## 5. Key entities & domain concepts

| Concept | New? | Description | States → transitions |
| --- | --- | --- | --- |
| **Agent** | Existing (extended) | Gains a level, a personality file, and a persisted halt reason with its cause, time, author and run. | `draft → active → paused ⇄ active`, `active → error`, `* → archived` — **unchanged**. This epic adds no status member and no transition. |
| **Agent level** | **New field on an existing noun** | A four-rung declaration of earned autonomy that seeds the agent's existing permission flags and approval posture and is displayed everywhere the agent appears. Not a new entity, not a new authorisation layer. | `unset → trainee → assistant → specialist → lead`, and freely back down. Every move is a human act with a preview. |
| **Halt reason** | **New field on an existing noun** | Why an agent is not working, persisted at the moment it stops: one of `user`, `credential`, `failures`, `cap`, `platform`, plus an optional note, a time, an author and the run that caused it. | written on halt · cleared on resume, activate or unarchive · never edited in place |
| **Status reason** | **New read model, not stored** | The single derived answer to "what is this agent doing and why", computed server-side from status, halt reason, in-flight runs, open decisions and schedule. Ten closed values (FR-10). | computed per request |
| **Identity card** | **New surface, not an entity** | The composed read model behind the card: identity, level, status reason, current run, notes preview, personality preview, drift count, readiness. | computed per request |
| **Personality** | **New agent file** | An authored file whose only job is tone. Joins the agent-file family — same endpoints, same optimistic-concurrency hash, same revision history, same secret scan. Distinct from Notes (what the agent has learned) and from the workspace's shared voice (house style for everyone). | `empty → written → written`. No delete; clearing it is a write of empty. |
| **Notes** | Existing from AW-07 | The agent's own durable notes, loaded every run. This epic surfaces it and adds no second mechanism. | unchanged |
| **Run** | Existing (extended) | Records which version of the agent's personality it used, so "takes effect on the next run" is checkable rather than asserted. Gains one more parked reason: *the agent is paused*. | unchanged |
| **Approval / Escalation** | Existing (untouched) | Levels write the approval posture; they do not change how an approval is raised, queued or decided. | unchanged |

### 5.1 Why "level" is not a synonym for anything we already have

Ever Works already has three things a level could be confused with, and it is none of
them:

- **`title`** is free text an owner writes for a human audience ("Senior researcher"). It
  carries no defaults and no meaning to the platform. Levels are a closed set with
  behaviour attached.
- **`reportsToAgentId`** is the organisation chart. It answers *who coordinates whom*,
  carries no authority today, and is orthogonal: a Trainee can report to a Specialist, and
  two Leads can report to nobody.
- **Permissions and guardrails** are the enforcement. A level does not replace them, does
  not wrap them and does not shadow them — it *writes* them, once, with a preview, and
  then gets out of the way. That is exactly why FR-43 exists: when the two disagree, the
  permissions win and the level says so.

### 5.2 Why "personality" is not a sixth instruction file by another name

The existing files answer *what the agent is for* (`SOUL.md`), *what its job is*
(`AGENTS.md`), *what it does when it wakes up* (`HEARTBEAT.md`), *what it may reach for*
(`TOOLS.md`) and *how it is configured* (`agent.yml`). None of them answers *how it
sounds*. Today voice is written into the first two, which means every voice edit is also
an edit to the agent's purpose or its job — the highest-risk files it has. Splitting tone
into its own small, budgeted, revision-tracked file makes voice cheap to change and
impossible to change by accident.

### 5.3 What this epic deliberately does not add as a new noun

- No "profile" — the card renders the Agent; there is no second record.
- No "state" or "health" entity — the status reason is derived, not stored.
- No "role" or "seniority" table — the level is a value on the agent.
- No new approval type, no new escalation reason code, no new run status.

## 6. UX

Every string below is the exact user-visible English and is an i18n key
(see [plan.md §8](./plan.md#8-i18n)).

### 6.1 Identity card — working

```
+------------------------------------------------------------------------------+
|  ( RA )  research-agent                          [ Specialist ]     [ Pause ] |
|          Senior researcher                                                    |
|          * Working  -  Reading the Q3 pricing page                            |
|          Started 4 minutes ago  ·  Open the run                               |
|------------------------------------------------------------------------------|
|  Working on   Reading the Q3 pricing page                        Open the run |
|  Notes        Prefers UK spelling. Never cites a source older              Edit|
|               than 18 months.                                                 |
|  Personality  Short sentences. No adjectives you would not say             Edit|
|               out loud.                                                       |
|  Level        Specialist - Owns its lane end to end. Money and         Change |
|               public actions still wait.                                      |
+------------------------------------------------------------------------------+
```

The dot before **Working** is green and animates only while a run is in flight.

### 6.2 Identity card — paused by you

```
+------------------------------------------------------------------------------+
|  ( RA )  research-agent                          [ Specialist ]    [ Resume ] |
|          Senior researcher                                                    |
|          * Paused by you                                                      |
|          Since 14:02 today  -  "holding until the rebrand ships Friday"       |
|          1 run still finishing  ·  Stop it now                                |
|------------------------------------------------------------------------------|
|  Working on   Nothing - this agent is paused. 2 runs are held.   Show the held|
|  Notes        Prefers UK spelling. Never cites a source older              Edit|
|               than 18 months.                                                 |
|  Personality  Short sentences. No adjectives you would not say             Edit|
|               out loud.                                                       |
|  Level        Specialist - Owns its lane end to end. Money and         Change |
|               public actions still wait.                                      |
|               2 settings differ from the Specialist defaults   Show the       |
|                                                                differences    |
+------------------------------------------------------------------------------+
```

### 6.3 Identity card — blocked on a credential

```
+------------------------------------------------------------------------------+
|  ( BA )  billing-agent                            [ Assistant ]    [ Resume ] |
|          Invoicing                                                            |
|          * Blocked on a credential                                            |
|          The model provider rejected this agent's account at 09:14.           |
|          See the run  ·  Fix the connection                                   |
|          Halted for this reason twice.                                        |
+------------------------------------------------------------------------------+
```

The sub-line names the connection and never the credential. Copy is
*"The model provider rejected this agent's account at {time}."* — the provider's display
name is substituted, nothing else.

### 6.4 Identity card — hit an error

```
+------------------------------------------------------------------------------+
|  ( SA )  support-agent                              [ Trainee ]    [ Resume ] |
|          First-line support                                                   |
|          * Hit an error                                                       |
|          3 runs failed in a row - last one 12 minutes ago.                    |
|          See the failing run                                                  |
+------------------------------------------------------------------------------+
```

### 6.5 Identity card — never run, and archived

```
+-------------------------------------------+  +-------------------------------+
|  ( NA )  new-agent        [ Level not set ]|  |  ( OA )  old-agent            |
|          No title set        [ Activate ]  |  |          * Archived           |
|          o Not started                     |  |          Restore it to use it |
|          This agent has never run.         |  |          again.               |
|          Set a level                       |  |          [ Restore ]          |
+-------------------------------------------+  +-------------------------------+
```

### 6.6 Pause dialog

```
+--------------------------------------------------+
|  Pause research-agent                            |
|                                                  |
|  It stops picking up scheduled runs, assigned    |
|  tasks, chat replies, email and delegated work.  |
|  Anything already held is released when you      |
|  resume. Nothing is lost.                        |
|                                                  |
|  Why? (optional)                                 |
|  +--------------------------------------------+  |
|  | holding until the rebrand ships Friday     |  |
|  +--------------------------------------------+  |
|  38 / 200                                        |
|                                                  |
|  1 run is in flight. It will finish.             |
|                                                  |
|                     [ Cancel ]  [ Pause agent ]  |
+--------------------------------------------------+
```

Keyboard: `Esc` cancels, `Cmd/Ctrl+Enter` confirms, focus lands in the note field.

### 6.7 Level dialog — choosing and previewing

```
+----------------------------------------------------------------------+
|  Level for research-agent                                            |
|                                                                      |
|  ( ) Trainee      Nothing leaves without you.                        |
|  ( ) Assistant    Routine work runs. Anything that reaches the       |
|                   outside waits.                                     |
|  (o) Specialist   Owns its lane end to end. Money and public         |
|                   actions still wait.                                |
|  ( ) Lead         Coordinates other agents and can spend within      |
|                   its cap.                                           |
|                                                                      |
|  [x] Apply this level's defaults                                     |
|                                                                      |
|  This changes 4 settings                                             |
|    Assign tasks .................. no  ->  yes                       |
|    Edit skills ................... no  ->  yes                       |
|    Edit its own agent files ...... no  ->  yes                       |
|    Commit to a repository ........ no  ->  yes                       |
|    Approvals ..... everything queues -> routine work runs;           |
|                    money and outside actions still queue             |
|                                                                      |
|  Sending a message outside the workspace and overriding a budget     |
|  always wait for you, at every level.                                |
|                                                                      |
|                              [ Cancel ]  [ Set level and apply ]     |
+----------------------------------------------------------------------+
```

Reducing autonomy replaces the list heading with **This takes autonomy away**, sorts
removals first, and changes the confirm button to **Apply and reduce autonomy**.

With **Apply this level's defaults** cleared, the change list is replaced by:

> *"Only the level is recorded. No permission or approval setting changes — the card will
> show 4 settings differing from the Specialist defaults."*

### 6.8 Level drift — the difference list

```
+----------------------------------------------------------------------+
|  Settings that differ from the Specialist defaults                   |
|                                                                      |
|  Commit to a repository ...... Specialist: yes   ·  this agent: no   |
|  Spend ....................... Specialist: no    ·  this agent: yes  |
|                                                                      |
|  The agent's own settings are what the platform enforces. The level  |
|  is a label and a set of defaults.                                   |
|                                                                      |
|                    [ Close ]  [ Apply the Specialist defaults ]      |
+----------------------------------------------------------------------+
```

### 6.9 Promotion readiness

Rendered as a single line under the level row, never as a badge or a banner:

> *"Ready for Specialist — 34 runs, no rejected approvals, 1 escalation in 30 days."*
> **Review**

When the agent does not qualify, nothing is rendered. There is no "not ready yet" state.

### 6.10 Personality editor

```
+---------------------------------------------------------------------------+
| Identity | Role | Notes | Personality | Operating loop | Tools | Manifest  |
+---------------------------------------------------------------------------+
|                                                                           |
|  Personality changes how this agent writes, never what it may do.         |
|  Permissions live on the Capabilities tab.                                |
|                                                                           |
|  +---------------------------------------------------------------------+  |
|  | Short sentences. No adjectives you would not say out loud.          |  |
|  | Never open with "Certainly".                                        |  |
|  | When you are not sure, say the number you are not sure about.       |  |
|  |                                                                     |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  [#########.................] 214 / 600 tokens                            |
|  Saved - takes effect on the next run.                                    |
|                                                                           |
|  [ Preview ]  [ History ]  [ Ask an agent to update this ]                |
+---------------------------------------------------------------------------+
```

Over budget the meter and message become:

```
  [##########################] 600 / 600 tokens  ·  800 tokens skipped
  Lead with the rules that matter most - the top of the file is the part
  that always survives.
```

Empty:

```
  No personality set - this agent writes in the platform's default voice.

  Try one:
    Short sentences. No adjectives you would not say out loud.        [ Use ]
    Always show your working before your conclusion.                  [ Use ]
    Write like a colleague, not a press release.                      [ Use ]
```

Saved while a run is in flight:

```
  Saved - takes effect on the next run. 1 run in flight is still using
  the previous version.
```

### 6.11 Held work

```
+----------------------------------------------------------------------+
|  Held while research-agent is paused                     3 items     |
|                                                                      |
|  Task   Draft the Q3 summary            held 42 minutes ago          |
|  Task   Check the pricing page          held 39 minutes ago          |
|  Chat   Reply to @research-agent        held 12 minutes ago          |
|                                                                      |
|  These are released oldest first when you resume. Nothing is lost.   |
|                                                        [ Resume ]    |
+----------------------------------------------------------------------+
```

### 6.12 Error and over-limit states

| Situation | Exact copy |
| --- | --- |
| Run now on a paused agent | *"This agent is paused. Resume it first."* with an inline **Resume** |
| Delegation to a paused agent | *"That agent is paused."* |
| Someone else changed the state | *"Someone else changed this — showing the current state."* |
| Level preview went stale | *"This agent changed since the preview — here is the new preview."* |
| Secret detected in Personality | *"That looks like a secret. Personality is stored as plain text and shown to the agent — remove the value in {field} and save again."* |
| Secret detected in a pause note | *"That looks like a secret. Remove it from the note and try again."* |
| Personality over 8 KB | *"Personality is limited to 8 KB. This is {size} — trim it and save again."* |
| Pause note over 200 characters | The counter turns red at 200 and the confirm button disables |
| Status could not be read | *"Status last checked {relative time}."* |
| Level list could not be read | *"Levels are unavailable right now. The agent's own settings are unchanged."* |

### 6.13 Keyboard affordances

| Key | Where | Action |
| --- | --- | --- |
| `P` | Identity card focused | Open the pause dialog, or resume when paused |
| `L` | Identity card focused | Open the level dialog |
| `Esc` | Any dialog | Cancel without writing |
| `Cmd/Ctrl + Enter` | Pause dialog, level dialog | Confirm |
| `Tab` | Level dialog | Moves through the four radios, then the checkbox, then the buttons |
| `Enter` | Reason sub-line link | Follows it (failing run, connection, decision) |
| `Cmd/Ctrl + S` | Personality editor | Save now instead of waiting for autosave |

All dots expose their reason as text to assistive technology; the card's status region is
announced politely on change, not assertively, so a background poll never interrupts.

## 7. Out of scope

- **Enforcement by level.** A level writes existing settings; it does not add a new
  authorisation check. The trust ladder that makes autonomy *earned* rather than
  *declared* — automatic promotion on evidence, level-scoped policy, level-aware approval
  routing — is [AW-24](../README.md).
- **Connection health.** This epic derives *blocked on a credential* from a run that
  failed on a rejected credential. Scheduled probing of every connection, the
  healthy/expired/unreachable states and the Reconnect flow are
  [AW-15](../AW-15-connections-scopes/spec.md); when they land they become a second, better
  input to the same reason.
- **The failure taxonomy on runs.** [AW-09](../AW-09-runs-receipts/spec.md) owns the
  classified failure reason shown on a run receipt. This epic consumes it where present and
  falls back to its own narrow credential detection where it is not; it does not define a
  second taxonomy.
- **The Notes file itself.** Delivered by [AW-07](../AW-07-memory-context/spec.md).
- **Spend caps.** The reason `stoppedAtACap` is defined and rendered here; the caps that
  raise it are [AW-17](../README.md). Until then the reason exists and is simply never
  raised.
- **A roster surface.** The compact card is defined here and reused by whatever lists
  agents; building a dedicated roster is not part of this epic.
- **Agent-to-agent voice.** Personality shapes what the agent writes. It does not change
  routing, delegation or who talks to whom.
- **Per-agent avatars beyond what exists.** The three avatar modes ship today and are
  unchanged.
- **Renaming any existing status value.** `draft`, `active`, `running`, `paused`, `error`
  and `archived` all keep their names and their transitions.

## 8. Acceptance criteria

**The brake**

- [ ] Pausing an agent stops a scheduled heartbeat run from firing.
- [ ] Assigning a task to a paused agent creates a parked run, not a running one, and the
      response says it is held because the agent is paused.
- [ ] An `@mention` chat reply to a paused agent does not run.
- [ ] Inbound email for a paused agent does not run.
- [ ] A parent agent cannot delegate to a paused agent, and is told why.
- [ ] **Run now** on a paused agent is refused with a 409 and creates no run row.
- [ ] Resuming releases held runs oldest-first and reports the count.
- [ ] Held runs never increment the error count and are never reaped by the stale sweeper
      while the agent is paused.
- [ ] A run in flight when the pause lands finishes; the card says how many are finishing;
      **Stop it now** requests the existing cooperative stop.
- [ ] With the pause state unreadable, work is parked, not run.
- [ ] Pausing twice does not overwrite the first note, time or author, and writes one
      activity entry.

**The stated reason**

- [ ] Every agent renders a dot **and** a sentence, in the card and in any list.
- [ ] A paused agent shows *Paused by you*, the time, and the note when there is one.
- [ ] Three consecutive failures show *Hit an error* with a one-click link to the newest
      failed run.
- [ ] A credential rejection halts the agent after **one** failure and shows *Blocked on a
      credential* naming the connection.
- [ ] No credential value appears in the payload, the UI, the activity feed or the logs.
- [ ] An agent with an open decision shows *Waiting on you* and links to it.
- [ ] A failed status refresh keeps every dot and shows when it was last checked.
- [ ] One request refreshes up to 100 agents' statuses.
- [ ] Polling stops when the tab is hidden.

**Levels**

- [ ] Existing agents render *Level not set*; none is assigned a level by the migration.
- [ ] A new agent is created at Trainee.
- [ ] Choosing a level shows a preview of every changing field before anything is written.
- [ ] Reducing autonomy sorts removals first and relabels the confirm button.
- [ ] Clearing the defaults checkbox writes only the level and immediately shows the drift
      count.
- [ ] The drift list matches the level table field for field.
- [ ] Sending a message outside the workspace and overriding a budget queue at Lead.
- [ ] The readiness line appears only at 20+ runs, 0 rejected approvals and ≤1 escalation
      in 30 days, and states those numbers.
- [ ] No agent is ever promoted without a human confirmation.
- [ ] A stale preview is refused and replaced with a fresh one.

**Personality**

- [ ] Personality appears as a pill in the per-agent instructions editor next to Notes.
- [ ] Saving confirms *takes effect on the next run* and names in-flight runs when there
      are any.
- [ ] A run in flight finishes with the version it started with, and the run records which
      version it used.
- [ ] The next run uses the new version.
- [ ] Over budget, the meter reads used/budget plus tokens skipped and marks the skipped
      region.
- [ ] A pasted secret is refused, the field is named, the value is not echoed, and the
      unsaved text survives.
- [ ] A personality that claims a permission changes nothing about what the agent may do.
- [ ] Personality has a revision history with attribution and one-click restore.
- [ ] Personality round-trips through agent export and import.

**The card**

- [ ] The card renders from one request.
- [ ] Every row has an empty state and none renders `undefined`.
- [ ] The compact card and the full card always agree on the reason.
- [ ] An archived agent's card is read-only with no Pause, Resume or level control.
- [ ] Colour is never the only carrier of status.

## 9. Open questions

- [NEEDS CLARIFICATION: Should a paused agent's held work expire? Today parked runs sit
  until the agent resumes. A workspace that pauses an agent for a month would release a
  month of stale task runs at once. Options: no expiry (current proposal), an expiry after
  N days with a visible countdown on the held list, or a "release only the newest per
  task" rule on resume.]
- [NEEDS CLARIFICATION: Should pausing an agent that other agents delegate to notify those
  parents proactively, or is refusing at delegation time (S14) enough?]
- [NEEDS CLARIFICATION: Should the level's defaults also seed the merge policy, which is a
  fifth resolution chain that decides who may land a pull request? Leaving it out keeps
  this epic to permissions and approvals; putting it in makes "Lead" mean one more true
  thing. Proposal: leave it out here and let AW-24 fold it in.]
- [NEEDS CLARIFICATION: When AW-15's connection health lands, should a connection going
  unhealthy halt every agent that depends on it pre-emptively, or continue to halt each
  agent only when its own run fails? Pre-emptive is kinder and noisier.]
- [NEEDS CLARIFICATION: Is a 10-second status poll the right cadence for a workspace with
  100+ agents on screen, or should the list fall back to 30 seconds above a threshold and
  keep 10 seconds for the open agent?]
- [NEEDS CLARIFICATION: Should the promotion-readiness window be fixed at 30 days, or move
  with the workspace's activity so a quiet workspace can still promote?]

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration is added. The credential-rejection
      signal is read from run failures the platform already produces through existing
      facades; no provider is contacted directly.
- [x] **II — Capability-driven.** No plugin id appears outside a plugin. The halt detail
      stores a provider's display name resolved through the existing facade, never a
      hardcoded id branch.
- [x] **III — Source-of-truth repositories.** Personality follows exactly the storage rule
      the other agent files already follow: workspace-scoped agents store it in the
      database, scoped agents store it in their scope's repository. No content moves.
- [x] **IV — Job runtime.** Releasing held work reuses the existing promotion path, which
      dispatches through the configured job-runtime provider's dispatcher symbols. Nothing
      calls a queue directly.
- [x] **V — Forward-only migrations.** Every new column is additive and nullable, shipped
      with its migration in the same change. No rename, no drop, no backfill that could
      lose data.
- [x] **VI — Tests.** Unit tests for the reason derivation, the level defaults and diff,
      and the brake middleware; controller specs for every new and extended endpoint; an
      end-to-end spec per user-visible flow.
- [x] **VII — Secrets.** Halt details, activity entries and API payloads carry a display
      name and never a credential. Personality and pause notes are secret-scanned on write.
- [x] **VIII — Plugin counts.** Not applicable; no plugin is added or removed.
- [x] **IX — Behaviour-first.** This document names no class, no file and no endpoint.
- [x] **X — Backwards compatibility.** No field is renamed or removed. `pause` and `resume`
      keep their paths, their verbs and their success shapes; the request body is newly
      optional and the response gains fields.

### 10.1 Program rules

- [x] **Additive only.** Ten tabs stay ten tabs. Five files stay five files, plus the one
      AW-07 adds and the one this epic adds. Six statuses stay six statuses.
- [x] **No duplicate nouns.** Level is a field, not an entity. Status reason is derived,
      not stored. Personality joins an existing file family. Notes belongs to AW-07 and is
      not re-implemented.
- [x] **Behaviour in the spec, detail in the plan.**
- [x] **Plugin-first for anything external.** Nothing external is added.
- [x] **Background work through the job runtime.** Held-work release reuses the existing
      promotion path.
- [x] **Schema changes ship with migrations.**
- [x] **Tests are a prerequisite.**
- [x] **i18n.** Every string above is a key; every leaf name is camelCase with no literal
      dot.
- [x] **Every new surface answers "what did it cost?"** This epic spends nothing new: it
      adds no model call, no background sweep and no scheduled job. The one place it
      touches spend is the level's *"can spend"* default, and that is shown in the preview
      before it is written. "Hear its voice" is deliberately routed through chat, which
      already carries its own cost accounting and its own receipt.

## 11. References

- Program: [Agent Workspace README](../README.md) · [Existing substrate](../EXISTING-SUBSTRATE.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Depends on: [AW-07 — Memory, context files & the load meter](../AW-07-memory-context/spec.md)
- Consumed by: AW-24 — Safety rails & the trust ladder
- Related: [AW-09 — Runs & receipts](../AW-09-runs-receipts/spec.md) ·
  [AW-15 — Connections, scopes & vault](../AW-15-connections-scopes/spec.md)
- Implementation: [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md)
