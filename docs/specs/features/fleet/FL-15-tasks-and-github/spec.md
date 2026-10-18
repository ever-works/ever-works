# FL-15 — Tasks & GitHub on the fleet: fix on this computer, Triggers, identity

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. The only file references are the evidence citations in §2 and §11
> that program rule 13 requires. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-15-tasks-and-github`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-15-tasks-and-github`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-04 (Agent sessions, start request), FL-06 (git line, PR, Task-branch reuse), FL-14 (Checkouts) · **Related:** FL-01 (computer Settings tab registry), FL-05 (session card Task slot, R-22), FL-19 (tool parity)
**Extends (existing Ever Works nouns):** Task · Trigger · Session · Checkout · Run · Agent · Work · GitHub App · Fleet audit · Node

---

## 0. TL;DR

Tasks stay the hand-off unit (README §2). This epic connects them to the computers: from any Task
— including one a Trigger made from a GitHub issue or pull request — **Fix with an agent on this
computer** opens one dialog that picks the machine (honouring the Agent's pinned computer), the
Agent, the checkout (an existing one, a new worktree, or a fresh clone) and a first message
prefilled from the Task, then starts an Agent session there. The Task page gains a **Computer**
block that links Task ↔ Session ↔ Checkout ↔ Pull request, and the session card carries the Task.
A Trigger source turns GitHub's "review requested from me", "assigned to me" and "my pull
requests" into Tasks — a feed on the board you already have, never a second inbox. And every
computer gets a **git identity check** — name, email, whether Ever Works can push for agents
there — with a one-click **Use my Ever Works identity** fix that changes that machine's global
git configuration only when you press it.

```
 TASK T-42 · Login form drops the session cookie                      from GitHub · acme/api#910
 ┌ Branch · task/login-form-drops-the-… · not pushed ┐  ┌ Computer ────────────────────────────────┐
 │ …                                                 │  │ build-01 · Nina · ◐ working 4 min  [Open] │
 └───────────────────────────────────────────────────┘  │ …/checkouts/api/task-login-form ⎇        │
 [ Run with agent ▾ ]  [ Fix with an agent on this computer ]│ +12 −3 · 2 files · no PR yet        │
                                                        └──────────────────────────────────────────┘
 ┌ Fix with an agent on this computer ────────────────────────────────────────────────────────┐
 │ Computer   (•) build-01   ● online · Linux · claude-code, codex                             │
 │            ( ) build-02   ● online · Linux · codex                      (Nina needs Claude)  │
 │            ( ) design-mac ○ offline · last seen 2 h ago                                      │
 │            Nina is pinned to build-01. Change that on Nina's Capabilities tab.               │
 │ Agent      Nina — Assigned ▾                                                                 │
 │ Checkout   (•) New worktree of ~/code/api on task/login-form-drops-the-…                     │
 │            ( ) ~/code/api itself     ( ) Fresh clone of acme/api                             │
 │ First message                                                                                │
 │ ┌ Fix T-42 "Login form drops the session cookie". Source: https://github.com/acme/api/…  ┐  │
 │ │ Description: … Acceptance: … When done, commit and open a pull request.                 │  │
 │ └──────────────────────────────────────────────────────────────────────────────────────────┘  │
 │ Git on build-01   name ✓ · email ✓ · Ever Works can push for agents ✓                        │
 │ Starts a session with Nina's model on build-01; its cost appears on the session and T-42.    │
 │                                                                 [ Cancel ] [ Start session ] │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Phase  | Ships                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The dialog from Task detail and the board card; machine list honouring affinity, Agent candidates, checkout choice, prefilled first message; the Task page **Computer** block; the Task chip on the session card. |
| **P2** | Per-machine git identity check on the computer page and in the dialog; **Use my Ever Works identity**.                                                                                              |
| **P3** | The GitHub "for me" Trigger source (review requests, assignments, my pull requests → Tasks); pull-request Tasks check out the pull request's branch; Agent tools, MCP and CLI verbs.                 |

Each phase is independently shippable behind `FLEET_CHECKOUTS_ENABLED` (the dialog also needs
`FLEET_SESSIONS_ENABLED`, which FL-04 owns).

---

## 1. Overview

**Fix with an agent on this computer** is a second way to start work on a Task, beside **Run with
agent**. Where **Run with agent** dispatches a headless Task run wherever the routing rules put it,
this dialog starts a persistent Agent session (FL-04) on a computer you choose, in a checkout you
choose, with the Task as its first message — so you can watch, steer and finish it with the
session surfaces. The Agent's pinned computer is respected, never silently changed: when the Agent
is pinned, that computer is the only selectable one and the dialog says where to change the pin.
A Task that came from GitHub through a Trigger carries its issue or pull request link into the
first message; a pull-request Task checks out the pull request's own branch.

The Task page shows the result in one **Computer** block: which computer, which session (state,
elapsed, Open / End), which checkout (path and git line), which pull request. The session card
(FL-05) carries a Task chip in the slot R-22 reserved for it. These are links over rows that
already exist — a Session knows its Run and its Checkout, a Run knows its Task, a Task knows its
pull request — so nothing new is stored.

The **GitHub "for me" Trigger source** uses the Triggers people already have: an event-sourced
Trigger whose matcher says "GitHub events about me" — review requested from me, assigned to me,
pull requests I opened — identified by the GitHub account linked to the person. Each matching
event becomes (or updates) a Task on the board, parked in Backlog by default, so it is a feed to
act on from the Task page, not a second inbox.

The **git identity check** is a card on each computer: the machine's global git `user.name` and
`user.email`, whether a credential helper is configured, and whether Ever Works can push for
agents there (the scoped push capability plus a GitHub App installation that covers at least one
repository). **Use my Ever Works identity** sets the name to your Ever Works display name and the
email to your GitHub no-reply address when a GitHub account is linked (your account email
otherwise, and the dialog says it will appear in public commits), on that machine only, only when
clicked, with one confirmation that names the machine. Agent commits are unaffected: the node
already attributes them author = Agent, committer = node.

---

## 2. Why now

### 2.1 The user's question

> _"This issue just came in — put Nina on it, on my build box, in a fresh worktree, and show me
> where she is."_

Then, later:

> _"Why do her commits on design-mac say `unknown <unknown@…>`?"_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                           | Today they must…                                                       | What breaks                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run this Task on build-01, not wherever."                           | Pin the Agent to build-01 on its Capabilities tab, then **Run with agent**. | The run menu picks only an Agent (`apps/web/src/components/tasks/RunWithAgentMenu.tsx:20-50`); assigning passes only `taskId` (`apps/api/src/agents/agents.controller.ts:1886`); the node is chosen by affinity alone (`apps/api/src/fleet/fleet-run-router.service.ts:294, 326-340`). A one-off machine choice means changing a durable binding (`apps/web/src/components/agents/AgentFleetSection.tsx:33-55`). |
| "Start it in a worktree I can watch."                                | Nothing — a Task run is headless.                                      | Runs are `claude -p` jobs; sessions (FL-04) are new. No Task surface starts one.                                                                                                                                                                                                                                                                                              |
| "Which computer is this Task being worked on?"                       | Open the Agent's Computer tab and guess.                               | Task detail shows branch, checks, runs, chat, approvers (`apps/web/src/components/tasks/TaskDetailClient.tsx:26-32, 541, 810`; `TaskBranchSection.tsx:27-33`) — never a computer, a session or a checkout path.                                                                                                                                                             |
| "Turn 'review requested from me' into work."                         | Write a webhook Trigger and hope the event carries it.                 | Triggers are `webhook` or `event` with matchers on `source`, `kind`, `workId` (`packages/agent/src/entities/inbound-trigger.entity.ts:12-69`; `docs/features/inbound-triggers.md:42`). Issue intake emits `github.issue` for `assigned`/`unassigned` (`apps/api/src/ingest/github/github-issue-intake.service.ts:31, 40-48`); the PR bridge emits `github.pr` for review flows (`github-pr-review-bridge.service.ts:1298`) but no `review_requested` anywhere under `apps/api/src/ingest/github/`. Nothing knows which GitHub login is "me". |
| "Is git set up on that machine for my own commits?"                  | Shell in; `git config --global -l`.                                    | The node probes `git --version` only (`apps/node/src/core/capabilities.ts:264-310`); the GitHub link stores login and id, no name or email (`packages/agent/src/entities/github-app-user-link.entity.ts:11-35`); nothing reads or sets a machine's git identity.                                                                                                             |
| "Let my Agent do the hand-off."                                      | Nothing.                                                               | MCP exposes node reads, affinity and drain (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`); no tool starts a session for a Task on a machine.                                                                                                                                                                                                                             |

### 2.3 The gaps this epic closes

1. **No one-off "on this computer".** The dialog chooses a machine per session while respecting the
   durable pin.
2. **Tasks do not know about sessions, checkouts or computers.** One block links them.
3. **GitHub's "for me" signals are not Tasks.** A Trigger source with an audience filter feeds the
   board.
4. **Git identity on a machine is invisible and unfixable from the product.** A check and a
   one-click fix, scoped to that machine.
5. **No tools.** Agents, MCP and CLI get the same hand-off.

### 2.4 Why this epic is additive only

**Run with agent**, assign-task, affinity, the Task branch rule and the Trigger kinds are
unchanged. The dialog is a second button; the Computer block is a new section; the Trigger source
is an additive matcher field with a preset; the identity fix is a new card that writes only on
click. No table changes (CONTRACTS §13 reserves no FL-15 slot).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Fix a Task on a chosen computer.**
  **Given** Task T-42 of the `acme/api` Work, Agent Nina assigned and unpinned, build-01 and
  build-02 online with `--work` and Nina's CLI installed,
  **when** the owner clicks **Fix with an agent on this computer**, picks build-01, keeps **New
  worktree**, edits the first message and clicks **Start session**,
  **then** an Agent session starts on build-01 within 15 seconds in a worktree on the Task's
  branch, the Task moves to **In progress** with the run in its history, the first message is the
  session's first turn, and the Task page's **Computer** block shows build-01 · Nina · working.

- **S2 — The pin is respected, not changed.**
  **Given** Nina is pinned to build-01,
  **when** the dialog opens,
  **then** build-01 is preselected and the only selectable computer; the others are listed with the
  note _"Nina is pinned to build-01. Change that on Nina's Capabilities tab."_, and starting the
  session leaves the pin untouched.

- **S3 — From a GitHub-born Task.**
  **Given** a Trigger created T-57 from issue `acme/api#910`,
  **when** the owner opens the dialog on T-57,
  **then** the first message carries the issue title, link and body excerpt, and the checkout step
  proposes a worktree of the matching `acme/api` checkout on the chosen computer.

- **S4 — A pull-request Task checks out the pull request (P3).**
  **Given** T-61 was created from pull request `acme/api#912`,
  **when** the owner starts a session for it,
  **then** the worktree is on the pull request's head branch, the first message says "review and
  address the comments on #912", and the git line shows `PR #912 open`.

- **S5 — The Task page links everything.**
  **Given** a session was started for T-42,
  **when** the owner opens T-42,
  **then** the **Computer** block shows the computer, the session (state glyph, elapsed, **Open**,
  **End**), the checkout path with its git line, and the pull request pill; each is a link; after
  the session ends the block keeps the last session with "ended 2 h ago".

- **S6 — The session card names the Task.**
  **Given** the same session,
  **when** the owner looks at any session card,
  **then** a `T-42` chip in the card's Task slot opens the Task.

- **S7 — Git identity check (P2).**
  **Given** design-mac runs with `--manage`,
  **when** the owner opens design-mac → Settings → **Git**,
  **then** the card reads name, email, credential helper and _"Ever Works can push for agents:
  yes/no"_ with the reason, and offers **Use my Ever Works identity** when name or email is unset
  or differs.

- **S8 — Use my Ever Works identity.**
  **Given** the owner has a linked GitHub account,
  **when** they click **Use my Ever Works identity** and confirm _"Set the global Git identity on
  design-mac for every repository there?"_,
  **then** the machine's global `user.name` becomes their display name and `user.email` their
  GitHub no-reply address, the card re-reads within 5 seconds, and one audit row records it.

- **S9 — GitHub "for me" Trigger (P3).**
  **Given** the owner's GitHub account is linked,
  **when** they click **GitHub: things for me** on the Triggers page and keep the defaults
  (review requested, assigned, my pull requests; park in Backlog),
  **then** a Trigger exists with that audience; a later review request on `acme/api#912` creates
  one Task in Backlog titled from the pull request with its link; a second review request on the
  same pull request updates that Task instead of creating another.

### 3.2 Edge cases and failures

- **U1 — No eligible computer.** Every computer is offline, lacks `--work`, or lacks the Agent's
  CLI: the dialog lists them all with the reason each and disables **Start session** with _"No
  computer can run Nina right now"_ and a link to **Run with agent** (cloud).
- **U2 — Consent missing.** A computer without `--work` is listed with _"needs `--work` on
  build-02"_ and the command; the server refuses a direct start with `consent_missing`. The
  identity card needs `--manage` and says so.
- **U3 — Kill switch on.** **Start session** and **Use my Ever Works identity** are disabled with
  the stop banner; the server refuses with `kill_switch`.
- **U4 — Permission denied.** An Organization member outside the Node's `sessions` audience sees
  the dialog read-only with _"Only the owner of build-01 can start sessions there"_; the identity
  fix follows the `commands` family's audience. The server refuses with `permission_denied`.
- **U5 — No free slot.** The computer is at its Agent-session concurrency: refused with
  `limit_exceeded` and _"build-01 is running 2 of 2 agent sessions"_; the dialog offers another
  computer.
- **U6 — Wrong CLI.** Nina needs Claude Code and build-02 has only Codex: build-02 is listed with
  _"Nina needs Claude Code; build-02 has Codex"_; a direct start is refused with
  `unsupported_on_node`.
- **U7 — Task without a repository.** The Work has no source repository: the checkout step offers
  only **Existing checkout** (any on that computer) or **None (home folder)** and the first message
  omits the clone line.
- **U8 — Fork pull request.** A pull request from a fork checks out read-only; the dialog says
  _"From a fork — Nina can review and comment but not push"_ unless the fork allows maintainer
  edits.
- **U9 — Link drops during start.** The start request was accepted (202); the dialog waits on the
  operation; after 40 seconds without a daemon acknowledgement it reads _"build-01 has not
  started the session yet"_ with **Keep waiting** / **Cancel**; nothing is started twice.
- **U10 — Identity set fails.** `git config` exits non-zero: `operation_failed` with the first
  stderr line; nothing else on the machine is touched.
- **U11 — No GitHub account linked (P3 preset).** The preset refuses with `invalid` and _"Connect
  your GitHub account first — the Trigger needs to know who 'me' is"_ and links to Settings.
- **U12 — Trigger fires for a Task already in progress.** The coalescing identity (the pull
  request or issue) updates the existing Task's description and posts a chat line; no second Task.
- **U13 — Two people start sessions for one Task.** The second start within the first's
  acceptance window is refused with `busy` naming the session that exists, with **Open** it.

---

## 4. Functional requirements

### 4.1 P1 — The dialog and the links

- **FR-1** Task detail and the board card menu MUST offer **Fix with an agent on this computer**
  beside **Run with agent**, visible only when both flags are on and the viewer has at least one
  Node.
- **FR-2** The dialog MUST list every computer the viewer may see with online state, OS, installed
  agent CLIs and, when not selectable, one reason from a closed set: offline, needs `--work`,
  missing CLI, no free slot, not pinned, kill switch.
- **FR-3** When the Agent has a pinned computer, that computer MUST be preselected and the only
  selectable one, and the dialog MUST name where the pin is changed; starting a session MUST NOT
  change the pin.
- **FR-4** Agent candidates MUST be the same as **Run with agent** offers (assignee, Task agent,
  Work default), tagged the same way.
- **FR-5** The checkout step MUST offer **New worktree** (default when a matching checkout exists on
  that computer), the matching **existing checkout(s)**, and **Fresh clone** of the Task's repository;
  with no repository it MUST offer existing checkouts or none.
- **FR-6** A session started from a Task MUST use the Task's branch (FL-06 FR-4) and MUST record the
  Task on its Run, so run history, board state and chat behave as for a Task run.
- **FR-7** The first message MUST be prefilled with the Task title, a description excerpt
  (≤ 2 000 characters), the acceptance checks summary when any, and the source link for a Task made
  by a Trigger; it MUST be editable before sending.
- **FR-8** The dialog MUST state the cost in prose — whose model, on which computer, where the cost
  appears — before **Start session**.
- **FR-9** Task detail MUST show a **Computer** block with the latest session for the Task (state,
  computer, Agent, elapsed, Open, End), its checkout with git line, and the pull request pill, each
  linked; it MUST read "No session on a computer yet" when none exists.
- **FR-10** The session card MUST show the Task chip in its Task slot when the session's Run has a
  Task.
- **FR-11** Starting a session MUST write the session-start audit row with the Task named in its
  details; this epic adds no audit action of its own for P1.

### 4.2 P2 — Git identity

- **FR-12** A computer with `--manage` MUST report its global git identity — name set/unset,
  email set/unset, credential helper present/absent — and whether Ever Works can push for agents
  there, with the reason when it cannot.
- **FR-13** The identity card MUST show values to the Node's owner and only set/unset to other
  audiences.
- **FR-14** **Use my Ever Works identity** MUST set the machine's global `user.name` to the person's
  display name and `user.email` to their GitHub no-reply address when a GitHub account is linked,
  else their account email with a stated warning; it MUST act only on click, only on that machine,
  after one confirmation naming the machine.
- **FR-15** The fix MUST never write a credential, a token or a credential helper, and MUST write
  one audit row with the machine and the fields set (never the email value).
- **FR-16** The dialog MUST show the identity line for the selected computer and MUST offer the fix
  inline when name or email is unset.

### 4.3 P3 — Trigger source, PR checkout, tools

- **FR-17** GitHub pull-request events for review requested, review request removed, assigned,
  unassigned, opened, ready for review, reopened and closed MUST be ingested as `github.pr` events
  carrying the requested reviewer, assignees and author logins.
- **FR-18** An event-sourced Trigger MUST accept an optional audience filter — review requested
  from me, assigned to me, authored by me — evaluated against the Trigger owner's linked GitHub
  login, and MUST refuse creation of such a filter when no account is linked.
- **FR-19** The Triggers page MUST offer a **GitHub: things for me** preset that creates an
  event-sourced Trigger with the audience filter, parked-in-Backlog auto-start, and an optional
  Agent, in one click.
- **FR-20** A Task created from a pull request MUST carry the pull request's repository, number,
  head branch and fork origin, and the dialog MUST check out that head branch; a fork's branch
  MUST be read-only unless the fork allows maintainer edits.
- **FR-21** Agents MUST get the hand-off and the identity check as tools, with CONTRACTS §11.3
  annotations, gated by Agent permissions and the Node's family audiences.

---

## 5. UX

Copy is exact; keys under `fleet.taskHandoff.*`, `fleet.gitIdentity.*`, `fleet.githubTrigger.*`.

### 5.1 Task detail — button and Computer block

Button row: `[ Run with agent ▾ ] [ Fix with an agent on this computer ]`. Block states: **empty**
_"No session on a computer yet"_ + button; **live** as in §0; **ended** _"Nina on build-01 · ended
2 h ago"_ with the checkout and pull request kept; **offline** computer dimmed with age.

### 5.2 The dialog

Sections Computer · Agent · Checkout · First message · Git on <computer> · cost sentence; footer
`[ Cancel ] [ Start session ]`. Loading: skeleton rows under Computer. Unavailable: U1 copy.
Error: the code's hint inline under the section it concerns. Keyboard: `F` opens from Task detail;
`↑/↓` move between computers; `Enter` starts when valid.

### 5.3 Board card menu

**⋯ → Fix with an agent on this computer** opens the same dialog; the card gains a small computer
glyph with the machine name while a session runs.

### 5.4 Computer page → Settings → Git (P2)

```
┌ Git on design-mac ───────────────────────────────────────────────────────────┐
│ Name      Dana Example                       ✓                                │
│ Email     not set                            ⚠                                │
│ Helper    osxkeychain                        ✓                                │
│ Ever Works can push for agents   yes — acme/api, acme/web                    │
│ [ Use my Ever Works identity ]  Sets name and email in this machine's global │
│ Git config. Nothing else changes.                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Confirmation: _"Set the global Git identity on design-mac for every repository there? Name: Dana
Example · Email: 12345+dana@users.noreply.github.com"_. Without a GitHub link the email line adds
_"Your account email will appear in public commits."_

### 5.5 Triggers page (P3)

Preset button **GitHub: things for me** beside **New trigger**; the Trigger editor gains an
**About me** group (three checkboxes) under the Event matcher; rows show a `for me` badge. Tasks
created carry a `github` label and the link.

### 5.6 Session card, Activity, Agent page

Card: `T-42` chip in the Task slot. Activity: no new view; the session start sentence names the
Task. Agent page: unchanged. Palette: "Fix T-42 with an agent on a computer" when a Task is in
context.

---

## 6. Non-functional requirements

- **Performance:** dialog data (computers, candidates, checkouts, identity) loads in ≤ 1 s (p95);
  start accepted ≤ 500 ms; identity read ≤ 2 s from the node.
- **Reliability:** start is idempotent per (Task, Agent) within the acceptance window (`busy`
  names the existing session); Trigger fires coalesce on subject.
- **Security & privacy:** email values are shown to the owner only; the fix writes name and email
  only; GitHub logins compared case-insensitively; no token leaves the platform.
- **Observability:** session-start audit with Task; identity-set audit; counters for hand-offs,
  identity fixes, Trigger fires by audience.
- **Compatibility:** no schema change; additive Trigger matcher field; additive ingest event
  actions.

---

## 7. Key entities & concepts

| Entity / concept                      | New?        | Description                                                                                  |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| **Task**, **Run**, **Session**, **Checkout** | Existing | Linked, not changed: Task ← Run (`taskId`) ← Session (`agentRunId`, `checkoutId`) → Checkout; Task → PR. |
| **Trigger** (inbound)                 | Existing    | Event matcher gains an optional **audience** ("about me") filter.                            |
| **Git identity** (per computer)       | **NEW** (read model) | Name, email, helper, "can push for agents"; read from the node, never stored except in audit details as set/unset. |
| **Agent**, **Work**, **GitHub App**, **Node**, **Fleet audit** | Existing | Applied.                                                                             |

---

## 8. Out of scope

- A GitHub inbox page, repository browser or favourites (README §3 refuses a second inbox).
- Switching GitHub accounts per machine; GitHub Enterprise hosts (git facade precedent, not
  wired).
- Changing affinity from the dialog.
- Agent commit identity (already author = Agent, committer = node on the push credential path).

## 8b. Open questions

- `[NEEDS CLARIFICATION: CONTRACTS change — add `git.identity` (read) and `git.setIdentity`
(write, class `confirm`) to the `machine` family vocabulary (§3.3), and `node.git.identity.set`
to the audit names (§7). Until then the identity fix cannot be audited under its own name.]`
- `[NEEDS CLARIFICATION: Which permission family governs the identity fix — `commands` (it is a
command on the machine) or `checkouts`? This spec assumes `commands`.]`
- `[NEEDS CLARIFICATION: Fork pull requests — read-only by default; should the dialog offer to
push to the fork when maintainer edits are allowed, or always propose a same-repo branch?]`
- `[NEEDS CLARIFICATION: Should the "for me" preset default to auto-start with the assigned Agent
for review requests, or always park in Backlog (this spec: park)?]`
- `[NEEDS CLARIFICATION: The audience filter needs the Trigger's event matcher column to accept an
additional JSON key; confirm it is a JSON column (no migration) — plan T-12 verifies.]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL15-01** (FR-1, FR-2) The button appears beside Run with agent; every computer is listed with a closed-set reason when unselectable.
- [ ] **ACC-FL15-02** (FR-3) A pinned Agent's computer is the only selectable one; the pin is unchanged after start.
- [ ] **ACC-FL15-03** (FR-4) Agent candidates and tags equal Run with agent's.
- [ ] **ACC-FL15-04** (FR-5, FR-6) New worktree is default when a matching checkout exists; the session uses the Task's branch and the Run carries the Task.
- [ ] **ACC-FL15-05** (FR-7, S3) A Trigger-made Task's first message contains the issue link and excerpt.
- [ ] **ACC-FL15-06** (FR-8) The cost sentence names the Agent's model and the computer.
- [ ] **ACC-FL15-07** (FR-9, FR-10) The Computer block links session, checkout and PR; the card shows the Task chip.
- [ ] **ACC-FL15-08** (U1–U6, U13) Each refusal shows its copy and the server returns `consent_missing`, `kill_switch`, `permission_denied`, `limit_exceeded`, `unsupported_on_node`, `busy` respectively.
- [ ] **ACC-FL15-09** (FR-12, FR-13) The identity card reads from the node; non-owners see set/unset only.
- [ ] **ACC-FL15-10** (FR-14, FR-15, S8) The fix sets exactly name and email globally on one machine after confirmation, writes one audit row without the email value, and never writes a credential.
- [ ] **ACC-FL15-11** (FR-17, FR-18) A `review_requested` webhook becomes a `github.pr` event; a Trigger with "review requested from me" fires only when the reviewer login matches the owner's linked login.
- [ ] **ACC-FL15-12** (FR-19, U11, U12) The preset creates the Trigger in one click, refuses without a GitHub link, and a repeated event updates the same Task.
- [ ] **ACC-FL15-13** (FR-20, S4, U8) A PR Task checks out the head branch; a fork is read-only unless maintainer edits are allowed.
- [ ] **ACC-FL15-14** (FR-21) `fleet_tasks_fix_on_computer` is refused outside the `sessions` audience with `permission_denied`; `fleet_git_identity_get` works for any Agent with the grant.
- [ ] **ACC-FL15-15** Every string is a `fleet.*` key; the banned-terms grep prints nothing.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** GitHub stays behind the existing App and ingest; no new integration.
- [x] **II — Capability-driven.** Provider through the git facade; CLI eligibility through capability tags.
- [x] **III — Source-of-truth repos.** Nothing new stored about repository content.
- [x] **IV — Job runtime.** Trigger fires ride the existing ingest drain; no new long-running work.
- [x] **V — Migrations.** None — no FL-15 slot; the matcher field is additive JSON (verified in tasks).
- [x] **VI — Tests.** Named per package in the plan and tasks.
- [x] **VII — Secrets.** No token written to a machine; email values owner-only; audit stores set/unset.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first.** Only evidence citations in §2 and §11.
- [x] **X — Backwards compatibility.** Second button, new section, optional matcher field, additive events.

---

## 11. References

- Program: [Fleet README](../README.md) §2 ("Tasks stay the hand-off unit"), D7, D14 · [CONTRACTS](../CONTRACTS.md) R-1, R-5, R-16, R-22; §1; §2; §3.3; §7; §8; §9; §11 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §E
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Evidence (HEAD `e4334baf7`): `apps/web/src/components/tasks/RunWithAgentMenu.tsx:20-50`, `apps/api/src/agents/agents.controller.ts:1886`, `apps/api/src/fleet/fleet-run-router.service.ts:294,326-340`, `packages/agent/src/fleet/fleet-agent-node-affinity.service.ts:26-78`, `apps/web/src/components/agents/AgentFleetSection.tsx:33-55`, `apps/web/src/components/tasks/TaskDetailClient.tsx:26-32,541,810`, `packages/agent/src/entities/inbound-trigger.entity.ts:12-69`, `apps/api/src/ingest/github/github-issue-intake.service.ts:31,40-48,160`, `apps/api/src/ingest/github/github-pr-review-bridge.service.ts:1298`, `packages/agent/src/entities/github-app-user-link.entity.ts:11-35`, `apps/node/src/core/capabilities.ts:264-310`, `docs/features/inbound-triggers.md:42`, `docs/features/tasks.md:217,286-299`
- Related epics: FL-04, FL-05, FL-06, FL-14, FL-19
- User docs to write: `docs/features/fleet-tasks-and-github.md`
