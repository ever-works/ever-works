# FL-06 — Session git & actions: worktree, git line, PR, actions menu

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. The only file references are the evidence citations in §2 and §11
> that program rule 13 requires. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-06-session-git-actions`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-06-session-git-actions`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-04 (sessions, daemon, `session.input`, start dialog), FL-14 (Checkouts, git line snapshot) · **Related:** FL-05 (session card, R-22), FL-15 (Task → session), FL-19 (tool parity), FL-20 (cost attribution)
**Extends (existing Ever Works nouns):** Session · Checkout · Run · Task · Agent · Work · Organization · Fleet audit · Merge policy · GitHub App

---

## 0. TL;DR

A session on a computer usually lives in a Checkout. This epic makes that relationship visible
and useful. Every session card and detail shows a **git line** — branch, lines changed, files,
commits ahead and behind, uncommitted files, and the pull request with its checks. Agent sessions
start in **their own worktree by default**, on a branch named `<prefix>/<slug>` that is never
reused for that repository, so several Agents can work on one repository at once. An **Actions**
menu offers the things a person does around an agent's work — **Commit**, **Commit and push**,
**Open a pull request**, **Review the changes**, **Fix the review comments**, **Resolve
conflicts**, **Write a recap** — each an editable prompt typed into the session, shown only when
it makes sense. Pull requests are opened by the platform through the GitHub App after the node
has pushed; agents never merge a protected branch — the merge policy decides. A read-only
**Changes** view shows the uncommitted diff; **Clean up** removes the worktree once the pull
request is merged and keeps the branch; and every action prompt says what it cost.

```
 ← Sessions    Nina · claude-code · build-01                          ◐ working · 12 min      [Actions ▾] [End]
 ┌ acme/api · …/checkouts/api/fix-login · nina/fix-login ⎇ · +214 −38 · 6 files · ↑3 ↓0 · 2 uncommitted · PR #912 open ✓ ┐
 │                                                                                            [Changes] [↻ 41 s ago]
 ├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 │  (live terminal — FL-04)
 ├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 │  ACTIONS ▾                                           │  ACTIONS SO FAR
 │   Commit                                              │   09:41  Commit                ≈ 1.2k tokens · $0.01
 │   Commit and push                                     │   09:52  Open a pull request   ≈ 3.4k tokens · $0.03 → #912
 │   Update the pull request #912                        │
 │   Review the changes                                  │
 │   Fix the review comments  (2 unresolved)             │
 │   Write a recap                                       │
 │   ──────────────                                      │
 │   Clean up  — after #912 is merged                    │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

| Phase  | Ships                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Session ↔ Checkout binding; worktree-per-Agent-session default in the start dialog; branch naming and never-reuse; the git line (with PR and checks, platform-side) on every session card and detail; the read-only Changes view.           |
| **P2** | The Actions menu: default templates, per-Agent overrides, relevance rules, typing into the session, the platform-side pull request (tool for Agent sessions, dialog for owner sessions), cost attribution per action.                           |
| **P3** | Clean up after merge; Agent tools, MCP and CLI verbs; the per-Agent prefix and template editor.                                                                                                                                                    |

Each phase is independently shippable behind `FLEET_SESSIONS_ENABLED`.

---

## 1. Overview

When a session starts (FL-04) in a Checkout (FL-14), the session records which checkout it is in.
Everything in this epic follows from that one link. The **git line** is the checkout's snapshot —
computed on the node, enriched on the platform with the pull request that has this branch as its
head and the roll-up of its checks — and it is rendered in one place for every surface: the
session card's footer (FL-05 owns the card, CONTRACTS R-22; this epic fills its `gitLine`,
`prPill` and `cleanUp` slots, §4.8), the session detail header, and the checkout row.

An **Agent session** defaults to a **new worktree** of the chosen checkout, because two agents in
one working tree overwrite each other and because a worktree shares history with its parent and
is ready in seconds. The proposed branch is `<prefix>/<slug>`: the prefix is the Agent's name
(or the person's handle for an owner session), the slug comes from the Task or the first message,
and the platform guarantees the name has never been used for that repository — on the remote or
by any earlier checkout, archived ones included. A session started from a Task keeps the Task's
own branch, so everything the Task page already does with branches and pull requests keeps
working unchanged.

The **Actions** menu turns the ceremony around an agent's work into one click each. Every action
is a prompt template with `{branch}`, `{base}`, `{pull}` and `{task}` placeholders; the person
sees the rendered prompt, may edit it, and sends it into the session exactly as if they had typed
it — the agent still asks before any command it has not been allowed to run. Only actions that
make sense are shown: outside a checkout only a recap; on the repository's default branch no pull
request and no "fix the review comments"; "fix the review comments" only when a pull request is
open and has unresolved comments; "resolve conflicts" only when the branch cannot be merged
cleanly. Templates live with the Agent's instructions: the platform ships defaults, and an Agent's
own `agent.yml` may override any of them, because how an Agent commits, describes a pull request
or writes a recap is part of how that Agent works — and nothing new has to be stored.

**Pull requests stay platform-side.** The node pushes the branch with the run-scoped credential it
already uses; the platform opens or updates the pull request through the GitHub App, with the
Agent's "may open pull requests" permission and the merge policy applied exactly as they are for
Task runs today. No action in this epic merges anything; the merge policy decides whether and how
an agent may ever merge, and protected branches are never merged by an agent.

---

## 2. Why now

### 2.1 The user's question

> _"Which branch is Nina on, is it pushed, is there a PR, and are the checks green — without
> opening a terminal?"_

Then:

> _"Tell her to commit and open a PR. And when it's merged, clean up the worktree."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                  | Today they must…                                                                        | What breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What branch is this session on, and is it pushed?"         | Open the Task page, if there is a Task.                                                 | The sessions list shows status, agent, Work, activity line, tokens, gate chip (`apps/web/src/components/agents/AgentSessionsClient.tsx:23-33`); the session detail shows status, runner, task link, duration, chips and a timeline (`apps/web/src/components/agents/SessionDetailClient.tsx:38-49`). Neither carries a branch, a diff size or a pull request. Only the Task page has a branch cockpit (`apps/web/src/components/tasks/TaskBranchSection.tsx:27-33`). |
| "Tell the agent to commit and push."                        | Nothing while it runs on a machine.                                                     | Steering a run appends to a queue "that no node ever reads" (`apps/api/src/fleet/fleet-agent-task-reconciler.service.ts:725-728`); fleet runs commit and push only at the end of a Task run (`apps/node/src/core/executors/agent-task.ts:1048-1060`). There is no way to type a prompt into a machine-hosted agent, and FL-04 adds that pipe — this epic puts the right prompts on it.                                                                             |
| "Open a PR from what it did."                               | Wait for the run to finish; the platform opens one from the pushed branch.              | PR opening is tied to the end of a Task run (`fleet-agent-task-reconciler.service.ts:100-135`, `packages/contracts/src/fleet/fleet-jobs.types.ts:583-587` "the platform opens the pull request from the pushed branch"). A persistent session has no "end of run" to hang it on.                                                                                                                                                                                       |
| "Give each agent its own copy of the repo."                 | Rely on Task isolation, when the Work turned it on.                                     | Task isolation gives a Task its own branch and checkout (`docs/features/task-isolation.md:9`, `:24` `taskIsolation off · worktree`); the name is `task/<slug>-<id>` (`packages/agent/src/tasks-domain/task-isolation.ts:43-56`). A session without a Task has no branch rule, no uniqueness rule, no worktree default.                                                                                                                                       |
| "Show me the uncommitted diff."                             | Open the PR, if one exists.                                                             | The Task diff sheet shows the PR's diff from the git provider, read-only (`apps/web/src/components/tasks/TaskDiffSheet.tsx:11-24`). Nothing shows what is on disk and not yet committed.                                                                                                                                                                                                                                                                                 |
| "Where do I set how Nina writes commit messages?"           | Put it in her instructions and hope.                                                    | An Agent's instructions are five canonical files (`packages/agent/src/entities/agent.entity.ts:204-209`; editor `apps/web/src/app/[locale]/(dashboard)/agents/[id]/instructions/page.tsx:5`). No Agent-level or user-editable action prompt exists: no prompt-template entity or setting under `packages/agent/src/entities` or `apps/web/src/components/settings` (`rg -il 'prompt.?template'` over both → no match). The `prompt-provider` capability (`packages/plugin/src/contracts/capabilities/prompt-provider.interface.ts:26-30`) fetches externally managed pipeline prompts; it is not reachable from a session or an Agent's instructions. |
| "Did that commit prompt cost anything?"                     | Nothing.                                                                                | Cost is per job/run (`AgentRun.costCents`); nothing attributes a slice of a session to one prompt.                                                                                                                                                                                                                                                                                                                                                                       |
| "Is it safe to clean up the worktree?"                      | `ever-works-node gc`, or by hand.                                                       | The reaper removes a worktree only when every safety rule passes — branch merged or gone from the remote **and** unused for longer than the max age — and keeps it on any unknown (`apps/node/src/core/workspaces/workspace-reaper.ts:36-56`); nothing offers "the PR is merged — remove this worktree, keep the branch" at the moment it becomes true, before the age rule is met.                                                                                                                      |

### 2.3 The gaps this epic closes

1. **Sessions are git-blind.** The git line (CONTRACTS §4.7) on every card and detail.
2. **No worktree default for free sessions.** `<prefix>/<slug>`, never reused, worktree first.
3. **No way to say "commit", "PR", "recap" to a machine-hosted agent.** The Actions menu over
   FL-04's input pipe, with relevance rules so irrelevant actions never appear.
4. **PRs only at run end.** A platform-side pull request opened when the agent (or the owner)
   asks, after the push, through the GitHub App, under the same permission and merge policy.
5. **No uncommitted view.** A read-only Changes view from the machine.
6. **No per-action cost.** Each action is a marked turn whose tokens FL-20 attributes.

### 2.4 Why this epic is additive only

Task runs keep their branch rule, their end-of-run commit/push/PR tail and the Task branch
cockpit. Sessions started from a Task reuse the Task's branch. Steering of cloud runs is
untouched. The merge policy and the Agent permission to open pull requests are applied, not
changed. The five Agent files stay five; `agent.yml` gains an optional block.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Start in a worktree by default.**
  **Given** Nina (Agent) is started on build-01 from the start dialog with checkout `~/code/api`
  chosen,
  **when** the owner reaches the **Where** step,
  **then** **New worktree** is preselected, the branch field proposes `nina/<slug>` (from the first
  message, or a short generated name when there is none), a note says _"never used before on
  acme/api"_, and **Create** starts the session inside the new worktree within 15 seconds on a
  warm repository.

- **S2 — The git line follows the work.**
  **Given** Nina's session is working,
  **when** the owner looks at the session card or detail,
  **then** the footer reads `acme/api · nina/fix-login ⎇ · +214 −38 · 6 files · ↑3 · 2
  uncommitted` and updates at least once a minute; when she pushes and a pull request exists the
  pill `PR #912 open ✓` appears with the checks roll-up and opens the pull request on click.

- **S3 — Commit and push from the menu.**
  **Given** the session is in a checkout on a non-default branch,
  **when** the owner picks **Actions → Commit and push**,
  **then** a sheet shows the rendered prompt with `{branch}` filled, editable; **Send** types it
  into the session, the terminal shows it arriving, an audit row records the action, and the
  "Actions so far" ledger gains a row that fills in its token count on the next usage scan.

- **S4 — Open a pull request (Agent session).**
  **Given** the branch is pushed and no pull request exists,
  **when** the owner picks **Open a pull request**,
  **then** the prompt asks the agent to commit, push and then request the pull request with a
  title and body; the platform opens it through the GitHub App against `{base}`, the git line's
  pill appears within 30 seconds of the request, and when the session belongs to a Task the Task
  records the pull request and moves to **In review** exactly as a Task run would.

- **S5 — Open a pull request (owner session).**
  **Given** the owner's own session on design-mac has pushed `dana/typo-fixes`,
  **when** they pick **Open a pull request**,
  **then** a dialog prefilled from the branch's commits asks for title and body, and the platform
  opens the pull request; the session is never asked to use any GitHub credential of its own.

- **S6 — Fix the review comments.**
  **Given** PR #912 is open with 2 unresolved review comments,
  **when** the owner picks **Fix the review comments (2 unresolved)**,
  **then** the prompt names the pull request and asks the agent to address each comment, reply on
  its thread, and push; the action is hidden again once zero comments are unresolved.

- **S7 — Resolve conflicts.**
  **Given** the pull request cannot be merged cleanly,
  **when** the owner picks **Resolve conflicts**,
  **then** the prompt asks the agent to merge `{base}` into `{branch}`, resolve, run the tests and
  push only when green; the action disappears when the pull request becomes mergeable.

- **S8 — Review the changes without touching them.**
  **Given** any session in a checkout,
  **when** the owner picks **Review the changes**,
  **then** the prompt asks for a reviewer's verdict against `{base}` and states that no code may be
  changed; the git line's uncommitted count is unchanged afterwards.

- **S9 — Write a recap outside a checkout.**
  **Given** a session whose working folder is not a checkout,
  **when** the owner opens **Actions**,
  **then** only **Write a recap** is offered, with a note _"This session is not in a checkout"_.

- **S10 — Changes view.**
  **Given** a session with uncommitted changes,
  **when** the owner clicks **Changes**,
  **then** a side panel lists the changed files with add/delete counts and each file's patch as
  text, read-only, refreshed every 10 seconds while the session works, capped and saying so when
  the diff is large.

- **S11 — Clean up after merge.**
  **Given** PR #912 is merged and the session has ended,
  **when** the owner clicks **Clean up** on the card or the checkout row,
  **then** the worktree is removed with FL-14's changes-check, the branch is kept, and the card
  reads _"Worktree removed · branch nina/fix-login kept"_.

- **S12 — An Agent edits its own action prompts.**
  **Given** the owner wants Nina's commits in a house style,
  **when** they edit the `commit` action in Nina's instructions,
  **then** the next **Commit** from any of Nina's sessions renders the new text and the sheet says
  _"Nina's own template"_.

### 3.2 Edge cases and failures

- **U1 — Node offline.** The git line shows its last snapshot with its age; Actions, Changes and
  Clean up are disabled with _"build-01 is offline (last seen 12 min ago)"_; the server refuses
  with `unreachable`.
- **U2 — Consent missing.** An owner session's actions need `--manage`, an Agent session's need
  `--work`; the menu says which is missing with the command, and the server answers
  `consent_missing`.
- **U3 — Kill switch on.** Every action, Changes refresh and Clean up is refused with
  `kill_switch`; the session is paused by R-24 and the menu carries the stop banner; a pull request
  already requested before the switch completes, and the ledger says so.
- **U4 — Permission denied.** A viewer outside the Node's `sessions` audience sees the menu
  disabled with _"Only the owner of build-01 can send actions"_; Clean up follows the `checkouts`
  audience; the server refuses with `permission_denied` naming the policy.
- **U5 — Not relevant.** A direct request for an action the rules hide (pull request on the
  default branch, fix-comments with no open pull request) is refused with `invalid` and the rule
  named; the menu never showed it.
- **U6 — Protected branch.** An Agent session whose branch is in the merge policy's protected
  list never sees **Commit and push** or **Open a pull request**; an owner session sees **Commit
  and push** with an amber note _"This pushes straight to main"_.
- **U7 — The agent is not accepting input.** When the session is `needs you`, actions are allowed
  (they answer by typing) but the sheet warns _"Nina is waiting for an answer — your action will be
  read as the answer"_; when the session has ended, actions are disabled with **Restart session**.
- **U8 — Shell session.** A `shell` session has no agent to prompt: the Actions menu shows only
  Changes and Clean up.
- **U9 — Branch name collision.** A proposed `nina/fix-login` that exists on the remote or on any
  checkout row for the repository becomes `nina/fix-login-2` and the dialog says why.
- **U10 — Push failed.** The agent reports a failed push in the terminal; the git line keeps
  `↑3`, no pull request is opened, and **Open a pull request** stays available with a note _"branch
  is not pushed yet"_.
- **U11 — Pull request open refused.** When the Agent lacks "may open pull requests", the request
  is refused with `permission_denied` and the hint names the Agent permission; the branch stays
  pushed and the owner may open the pull request from the dialog.
- **U12 — GitHub unreachable.** PR enrichment fails silently into "PR: unknown" with the age of the
  last good answer; opening a pull request fails with `operation_failed` and the first line of the
  provider's error, retried on click only.
- **U13 — Link drops mid-action.** A prompt that could not be confirmed as delivered is marked
  _"not delivered"_ in the ledger and may be re-sent; it is never sent twice silently.
- **U14 — Two viewers act at once.** The second action within 2 seconds on the same session is
  refused with `busy` naming the first sender.
- **U15 — Large diff.** The Changes view stops at the cap, names how many files and bytes were
  omitted, and offers the pull request link when one exists.
- **U16 — Clean up with uncommitted work.** The changes-check (FL-14) demands the typed name and
  states what would be lost; the branch is always kept.

---

## 4. Functional requirements

### 4.1 P1 — Binding, worktree default, naming, git line, changes

- **FR-1** A session started in a Checkout MUST record that Checkout, and a session whose working
  folder is not a Checkout MUST record none.
- **FR-2** The start dialog MUST offer **Existing checkout**, **New worktree** and **Fresh clone**
  under **Where**, and MUST preselect **New worktree** for Agent sessions when the chosen folder is
  a checkout.
- **FR-3** A proposed branch MUST be `<prefix>/<slug>`; the prefix MUST default to the Agent's slug
  for Agent sessions and the person's handle for owner sessions; the slug MUST come from the Task's
  branch rule when the session is started from a Task, else from the first message, else from the
  title, else a short generated name.
- **FR-4** A session started from a Task MUST use the Task's existing branch and MUST NOT invent a
  second one.
- **FR-5** A proposed branch name MUST never have been used for that repository — on the remote or
  by any Checkout row for the same remote, archived included — and a collision MUST be resolved
  with a numeric suffix, stated in the dialog.
- **FR-6** Every session card and detail MUST render the session's Checkout git line in one shared
  form: branch (worktree marked), lines added and removed, files changed, ahead and behind,
  uncommitted count, pull request pill with state and checks, and the snapshot age.
- **FR-7** The pull request part of the git line MUST be resolved by the platform through the
  GitHub App for the Checkout's remote and branch, at most once per minute per checkout, and MUST
  be refreshed at once on a pull request event for that branch.
- **FR-8** The pull request pill MUST show one of `open · draft · merged · closed` and a checks
  roll-up of `pending · passing · failing · none` ("none" is the stored `null` of CONTRACTS §4.7),
  and MUST open the pull request on click.
- **FR-9** The Changes view MUST show the uncommitted diff of the session's Checkout — changed
  files with add/delete counts and each file's patch as text — read-only, computed on the node,
  capped at 1 MiB total and 64 KiB per file, saying what was omitted.
- **FR-10** The Changes view MUST refresh every 10 seconds while the session is `working` and on
  demand otherwise, and MUST NOT interpret any diff content as markup.
- **FR-11** A session in a Checkout MUST refresh that Checkout's git line every 60 seconds while
  `working` and once when it stops (FL-14 computes; this epic drives the cadence through session
  events).

### 4.2 P2 — Actions

- **FR-12** The Actions menu MUST offer exactly these prompt actions: Commit, Commit and push, Open
  a pull request (or Update the pull request), Review the changes, Fix the review comments, Resolve
  conflicts, Write a recap.
- **FR-13** Each prompt action MUST be a template with `{branch}`, `{base}`, `{pull}` and `{task}`
  placeholders; the platform MUST ship a default for each, and an Agent's own instructions MAY
  override any of them.
- **FR-14** Before sending, the rendered prompt MUST be shown and editable; sending MUST type it
  into the session as owner input through the session channel and MUST NOT bypass the agent's own
  permission prompts.
- **FR-15** Relevance rules MUST hide: every prompt action but Write a recap outside a Checkout;
  Open a pull request, Fix the review comments and Resolve conflicts on the repository's default
  branch; Fix the review comments unless a pull request is open with at least one unresolved review
  comment; Resolve conflicts unless the pull request is not cleanly mergeable; Commit and push and
  Open a pull request for Agent sessions on a merge-policy protected branch.
- **FR-16** Open a pull request MUST read **Update the pull request #n** when one is open for the
  branch, and the resulting action MUST update that pull request's title and body instead of
  opening a second one.
- **FR-17** Pull requests MUST be opened or updated by the platform through the GitHub App after
  the branch is pushed; the session MUST never be given a platform credential for the git
  provider's API.
- **FR-18** In an Agent session the pull request request MUST arrive as a platform tool call from
  the agent (title, body, draft flag), gated by the Agent's "may open pull requests" permission;
  in an owner session it MUST arrive from a dialog prefilled from the branch's commits.
- **FR-19** Opening a pull request for a session that belongs to a Task MUST record the pull
  request on the Task and move it to **In review**, as a Task run does today.
- **FR-20** No action in this epic MUST merge a pull request; the merge policy alone decides
  whether and how an agent may merge, and a protected branch MUST never be merged by an agent.
- **FR-21** Every sent action MUST write one audit row (session input with the action named). In
  an Agent session it MUST also write one ledger entry on the session's Run, which MUST gain the
  tokens and cost attributed to that turn when the usage scan runs and MUST read "unknown" until
  then. An owner session has no Run (CONTRACTS R-1, §4.2): its ledger MUST be read from the
  session's audit rows and its cost column MUST read "session total only", showing the session's
  total once FL-20 fills it.
- **FR-22** The session detail MUST show the ledger of actions sent, each with time, action,
  tokens, cost and the pull request it produced when one did.
- **FR-23** Action sends MUST be limited to 10 per minute per session and MUST refuse a second
  send within 2 seconds of the first with `busy`.
- **FR-24** A send that cannot be confirmed delivered MUST be marked "not delivered", MUST be
  re-sendable, and MUST never be delivered twice silently.

### 4.3 P3 — Clean up, tools, editor

- **FR-25** **Clean up** MUST be offered on the session card and the checkout row only when the
  Checkout is a worktree, its pull request is merged or closed, and no live session uses it; it
  MUST remove the worktree through the Checkout delete with its changes-check and MUST keep the
  branch.
- **FR-26** Agents MUST get `list actions`, `send action`, `read changes` and `open pull request`
  as tools with the annotations of CONTRACTS §11.3, gated by Agent permissions and the Node's family
  audiences; clean up for an Agent MUST be FL-14's checkout delete tool, refused unless FR-25's
  conditions hold — no second delete tool.
- **FR-27** The Agent instructions editor MUST offer the per-action templates and the branch prefix
  as fields that write the Agent's own file, with the default shown beside each override.

### 4.4 Permissions, confirmations, audit (program rule 12)

| Action                    | Consent (CONTRACTS §1.1)                        | Family · default audience (§2.1) | Confirmation (§2.2)                                                                 | Audit (§7)                                    | Errors (§8)                                                                                       | Kill switch (R-24)                 | Agent tool                                      |
| ------------------------- | ----------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| See the git line, actions list, ledger | none beyond the link                | `view` · org-members             | `plain`                                                                             | none (read)                                   | `not_found`                                                                                       | readable (last snapshot)           | `fleet_sessions_actions_list` · read-only       |
| Send an action            | owner session `--manage`; Agent session `--work` | `sessions` · owner              | `plain` (the sheet shows the prompt before **Send**)                                | `node.session.input` with the action named    | `invalid` "not available on main", `busy` "another action was sent 1 s ago", `limit_exceeded` "10 per minute", `unreachable`, `consent_missing`, `permission_denied`, `kill_switch` | refused                            | `fleet_sessions_action` · `destructive: false`  |
| Read the Changes view     | `--manage` (`--work` for a Task-created worktree) | `checkouts` · owner            | `plain`                                                                             | none (read)                                   | `unreachable`, `consent_missing`, `permission_denied`, `kill_switch`                              | refused                            | `fleet_checkouts_changes` · read-only           |
| Open / update a pull request | none on the node (platform-side, after the push) | `checkouts` · owner, plus the Agent's "may open pull requests" | `plain`                                    | none in `fleet_audit` (no §7 name); the Task trail and activity log record it | `invalid` "branch is not pushed yet", `permission_denied` "Nina may not open pull requests", `operation_failed` (provider's first line), `kill_switch` | refused for new requests; one already requested completes | `fleet_checkouts_open_pull_request` · `destructive: false` |
| Clean up                  | as Changes                                      | `checkouts` · owner              | `confirm` "Remove the worktree of nina/fix-login on build-01? The branch is kept."; `confirm-destructive` (type the branch) when it has uncommitted work | `node.checkout.delete`                        | FL-14's delete codes; `invalid` "the pull request is not merged or closed yet"                     | refused                            | FL-14's `fleet_checkouts_delete` · `destructive: true` |

---

## 5. UX

Copy below is exact; keys live under `fleet.sessionGit.*`.

### 5.1 Git line (shared, every surface)

`acme/api · nina/fix-login ⎇ · +214 −38 · 6 files · ↑3 ↓0 · 2 uncommitted · PR #912 open ✓ · 41 s ago`.
Omit zero parts except branch and age. Tooltip on `⎇`: _"Worktree of ~/code/api"_. PR pill tones:
open green, draft muted, merged violet, closed grey; checks glyph ✓ ⏳ ✗. States: **no checkout**
— _"Not in a checkout"_; **stale** (> 5 min) — age in amber; **offline** — dimmed with age;
**unknown PR** — _"PR: unknown (GitHub unreachable 3 min)"_.

### 5.2 Session detail

Header gains the git line and `[Changes] [↻]`. **Actions ▾** sits beside **End**. Below the
terminal: **Actions so far** ledger. Keyboard: `A` open Actions, `D` Changes, `G` refresh,
`1`–`7` pick an action while the menu is open, `Esc` closes.

### 5.3 Actions sheet

```
┌ Commit and push — Nina on build-01 ───────────────────────────────────────────┐
│ Commit the current changes on nina/fix-login with a clear message that        │
│ explains why, then push nina/fix-login to origin. Tell me the commit and       │
│ whether the push succeeded.                                   (Nina's own)    │
│ ─────────────────────────────────────────────────────────────────────────────  │
│ Nina still asks before running anything you have not allowed.                 │
│ Uses Nina's model; shown in Actions so far with its cost.                     │
│                                                       [ Cancel ]  [ Send ]    │
└───────────────────────────────────────────────────────────────────────────────┘
```

Hidden-action note when opened via keyboard: _"Open a pull request is not available on main."_

### 5.4 Pull request dialog (owner sessions)

Title (≤ 70 chars, prefilled from the last commit), body (prefilled from commit messages), base
(`main`, read-only), **Draft** toggle, _"Opened by Ever Works through the GitHub App as you."_

### 5.5 Changes panel

File list (path, `+a −d`), patch per file behind a disclosure, text only; footer _"Refreshes every
10 s while Nina works · 3 files omitted (1.4 MiB) — see the pull request"_.

### 5.6 Start dialog — Where (additions to FL-04)

`( ) Existing checkout ~/code/api   (•) New worktree   ( ) Fresh clone` · Branch
`nina/fix-login` _"never used before on acme/api"_ / _"nina/fix-login exists — using nina/fix-login-2"_.

### 5.7 Card (FL-05), checkout row (FL-14), Agent instructions

Card footer: git line + PR pill; **Clean up** button on done cards when FR-25 holds. Checkout row:
PR pill and **Clean up**. Agent → Instructions: a **Fleet actions** section under `agent.yml`
with seven template fields and the branch prefix.

### 5.8 Activity view and Agent page

Activity → Sessions board cards show the git line through the shared card; the Agent page is
unchanged. No new palette entries.

---

## 6. Non-functional requirements

- **Performance:** git line render ≤ 50 ms from stored snapshot; PR enrichment ≤ 1 call/min/
  checkout; action send acknowledged ≤ 500 ms; Changes view ≤ 2 s for a 1 MiB diff.
- **Reliability:** delivery of a prompt is confirmed by the daemon's echo; a lost confirmation is
  shown, never retried silently.
- **Security & privacy:** prompts are redacted by the existing secret scanner before audit; the
  diff is text-only; no provider credential ever reaches the session; PR bodies written by an
  agent pass the same redaction.
- **Observability:** audit per action; metrics for actions sent, PRs opened/updated, clean-ups.
- **Compatibility:** no schema change; `agent.yml` block is optional; the Task branch cockpit is
  untouched.

---

## 7. Key entities & concepts

| Entity / concept             | New?           | Description                                                                                             |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| **Session** (`FleetSession`) | Existing (FL-04) | Gains use of its `checkoutId`; no new columns.                                                        |
| **Checkout** (`FleetCheckout`) | Existing (FL-14) | Its git line gains the platform-resolved `pr` part.                                                 |
| **Action**                   | Plain word — no entity, no table | One of seven prompt templates; rendered, edited, sent as typed input; recorded on the Run's ledger (Agent sessions) or the audit trail (owner sessions). |
| **Action template**          | Plain word — a text in a file | Default text per action with `{branch} {base} {pull} {task}`; overridable in the Agent's `agent.yml`. |
| **Run**, **Task**, **Agent**, **Merge policy**, **GitHub App** | Existing | Applied, not changed.                                                                 |

---

## 8. Out of scope

- Merging pull requests from a session (merge policy and Task review own merging).
- A structured chat view over the terminal (CAPABILITY-MAP B, deferred).
- Inline review comments on the Changes view (the provider's PR UI owns them).
- Branch prefix per Organization; stacked pull requests; GitLab or other providers (git facade
  precedent exists; not wired here).

## 8b. Open questions

- **Resolved** by CONTRACTS §3.3: the `machine` family vocabulary lists `checkouts.changes`; FL-06
  sends it as `checkouts.changes { checkoutId, maxBytes }`.
- **Resolved** by CONTRACTS §10: "Action prompts per session — 10 per minute, 2 s spacing" and
  "Changes diff shown — 1 MiB total, 64 KiB per file" (FR-9, FR-23).
- **Resolved** by CONTRACTS §11.2 (rev 4): `/sessions/:id/actions` (GET, POST), `/sessions/:id/actions/ledger`, `/sessions/:id/actions/:ledgerId/resend`, `/sessions/branch-proposal`, `/checkouts/:id/pull-request` (GET, POST); audit `node.session.action` and `node.session.pull-request.open` (§7).
- **Resolved** by CONTRACTS R-38 (rev 4): an owner session's action ledger is read from its `fleet_audit` rows and its cost shows as a session total only; Agent sessions keep the Run ledger.
- `[NEEDS CLARIFICATION: Org-wide action templates. Default until answered: templates live only in
  the platform defaults and the Agent's own `agent.yml` (no table, no migration — CONTRACTS §13
  has no FL-06 slot); an org-wide layer would need a new slot and is not built.]`
- `[NEEDS CLARIFICATION: Owner-session branch prefix override. Default until answered: the prefix
  is the person's account handle, with no per-person override and nothing stored (no fleet
  user-settings row exists).]`
- `[NEEDS CLARIFICATION: Codex Agent sessions in a worktree — the Codex sandbox may refuse writes
  to the parent repository's git dir. Default until answered: FL-04's Task-run isolation is used
  unchanged (CONTRACTS R-5) — no writable root is added — and the default Commit / Commit and push
  templates tell the agent to say so and ask when a write is refused.]`
- `[NEEDS CLARIFICATION: "Commit and push" on a protected branch in an owner session. Default
  until answered: shown with the amber "This pushes straight to main" note (U6), because it is the
  person's own machine and their own git credentials; Agent sessions never see it (FR-15).]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL06-01** (FR-1, FR-2) An Agent session started in a checkout preselects New worktree and records the new Checkout.
- [ ] **ACC-FL06-02** (FR-3, FR-5, U9) Proposed name is `nina/<slug>`; a remote or row collision yields `-2` with the reason shown.
- [ ] **ACC-FL06-03** (FR-4) A session from Task T-42 uses the Task's branch; the Task cockpit shows it unchanged.
- [ ] **ACC-FL06-04** (FR-6, FR-8) Card and detail render the same git line; the pill shows state and checks and links to the PR.
- [ ] **ACC-FL06-05** (FR-7) PR enrichment calls GitHub at most once per minute per checkout and refreshes on a `github.pr` event.
- [ ] **ACC-FL06-06** (FR-9, FR-10, U15) Changes shows text-only patches, caps at 1 MiB/64 KiB, names omissions, refreshes every 10 s while working.
- [ ] **ACC-FL06-07** (FR-11) The checkout's git line refreshes every 60 s while the session works and once on stop.
- [ ] **ACC-FL06-08** (FR-12–FR-14) Each action renders its template, is editable, and arrives in the terminal as typed input.
- [ ] **ACC-FL06-09** (FR-15, U5, U6, U8) Relevance rules hide the right actions; a direct call is refused with `invalid`; shell sessions show none.
- [ ] **ACC-FL06-10** (FR-16–FR-19) Open PR in an Agent session arrives as a tool call and the platform opens it via the GitHub App; an owner session uses the dialog; a Task session records the PR and moves to In review; an existing PR is updated, not duplicated.
- [ ] **ACC-FL06-11** (FR-20) No code path in this epic calls merge; a protected base is never merged.
- [ ] **ACC-FL06-12** (FR-21, FR-22) Each send writes an audit row; in an Agent session also a ledger row whose tokens and cost fill in after the usage scan; an owner session's ledger lists the same sends from its audit rows with "session total only".
- [ ] **ACC-FL06-13** (FR-23, FR-24, U13, U14) 11th send in a minute → `limit_exceeded`; 2 s double send → `busy`; undelivered marked and re-sendable.
- [ ] **ACC-FL06-14** (FR-25, U16) Clean up appears only when merged/closed + worktree + no live session; removes the folder, keeps the branch.
- [ ] **ACC-FL06-15** (FR-26) `fleet_sessions_action` refused outside the `sessions` audience with `permission_denied`; `fleet_checkouts_changes` works for any Agent with the grant.
- [ ] **ACC-FL06-16** (FR-27, S12) Editing the commit template in Nina's instructions changes the next rendered Commit.
- [ ] **ACC-FL06-17** (U1–U4) Offline, consent-missing, kill switch and permission-denied states show the stated copy and the server returns the stated codes.
- [ ] **ACC-FL06-18** (U11, U12) PR open without the Agent permission → `permission_denied` with the permission named; GitHub down → `operation_failed` with the provider's first line.
- [ ] **ACC-FL06-19** Every string is a `fleet.sessionGit.*` key; the banned-terms grep prints nothing.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** GitHub is reached through the existing GitHub App integration and the git facade; nothing new is integrated.
- [x] **II — Capability-driven.** The git facade resolves the provider; no plugin id is named.
- [x] **III — Source-of-truth repos.** Code stays in the user's repositories and on the machine.
- [x] **IV — Job runtime.** PR enrichment runs as a scheduled task via a dispatcher symbol; action sends are link requests.
- [x] **V — Migrations.** None — this epic has no schema change (CONTRACTS §13 has no FL-06 slot).
- [x] **VI — Tests.** Named per package in the plan and tasks.
- [x] **VII — Secrets.** Prompts and PR bodies pass the secret scanner before audit; no provider credential reaches a session.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first.** Only evidence citations in §2 and §11.
- [x] **X — Backwards compatibility.** Optional `agent.yml` block; additive tools and routes.

---

## 11. References

- Program: [Fleet README](../README.md) D4, D5, D6, D7, D14 · [CONTRACTS](../CONTRACTS.md) R-1, R-5, R-13, R-16, R-22, R-24; §3.3 `session`, `machine`; §4.2, §4.3, §4.7, §4.8; §5; §7; §8; §9; §11 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §B
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Evidence (HEAD `e4334baf7`): `apps/web/src/components/agents/AgentSessionsClient.tsx:23-33`, `apps/web/src/components/agents/SessionDetailClient.tsx:38-49`, `apps/web/src/components/tasks/TaskBranchSection.tsx:27-33`, `apps/web/src/components/tasks/TaskDiffSheet.tsx:11-24`, `apps/api/src/fleet/fleet-agent-task-reconciler.service.ts:100-135,725-728`, `packages/contracts/src/fleet/fleet-jobs.types.ts:583-587`, `packages/agent/src/tasks-domain/task-isolation.ts:43-56`, `packages/agent/src/entities/agent.entity.ts:204-209`, `packages/contracts/src/policy/merge-policy.types.ts:18-57`, `docs/features/task-isolation.md:9,24`, `apps/node/src/core/executors/agent-task.ts:1048-1060`, `apps/node/src/core/workspaces/workspace-reaper.ts:36-56`, `packages/plugin/src/contracts/capabilities/prompt-provider.interface.ts:26-30`, `packages/agent/src/entities/agent-run-log.entity.ts:21-28` (`runId` not nullable); EXISTING-SUBSTRATE §1.7 (push credential), §3.1 (`fleetCliSession`), §3.3 (sessions list and detail)
- Related epics: FL-04, FL-05, FL-14, FL-15, FL-19, FL-20
- User docs to write: `docs/features/fleet-session-git.md`
