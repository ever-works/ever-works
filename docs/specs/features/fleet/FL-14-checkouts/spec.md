# FL-14 — Checkouts on computers: discovery, clone, worktree, bin

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. The only file references in this document are the evidence citations
> in §2 and §11 that program rule 13 requires. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-14-checkouts`
**Program:** [Fleet](../README.md) · Wave 1
**Branch:** `feat/fl-14-checkouts`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-02 (node link, `--manage`, node modules) · **Related:** FL-01 (hub, tabs, roles), FL-04 (sessions start in a checkout), FL-06 (git line on sessions, PR pill, clean up), FL-11 (file roots), FL-15 (Task → checkout), FL-19 (tool parity), FL-20 (cost)
**Extends (existing Ever Works nouns):** Node · Fleet · Work · Task · Run · Agent · Organization · Fleet audit

---

## 0. TL;DR

A **Checkout** is a git clone or worktree on a Node. Today the node already keeps a pool of
clones and per-Task worktrees under its own root, but nothing on the platform can list them, no
person can create one on purpose, and a clone sitting in `~/code` on a machine is invisible to
Ever Works. This epic makes Checkouts a first-class thing you can see on every computer, create
(fresh clone, worktree of an existing checkout, or a container-isolated folder), keep in sync
(fetch, pull, push), tidy away (archive to a bin) and delete safely (a changes-check refuses to
throw away uncommitted or unpushed work without a typed confirmation). Every Checkout carries a
**git line** — branch, lines changed, files, ahead/behind, uncommitted, PR — refreshed while a
session runs in it. Checkouts are what sessions start in (FL-04), what the Files tab may browse
(FL-11, R-18), and what a Task hands an Agent (FL-15, R-16).

```
 FLEET › CHECKOUTS                                       [Scan computers]  [+ New checkout ▾]
 ┌ Overview │ Computers │ Sessions │ Checkouts ● │ Commands │ Usage ┐
 │  All computers ▾ · All repositories ▾ · Ready ▾                                   Bin (2)
 │
 │  acme/api  ·  Work "API"                                     3 checkouts on 2 computers
 │   build-01   ~/code/api                     main        ✓ clean   ↓2        found 2 h ago   [Fetch ▾] [⋯]
 │   build-01   …/checkouts/api/fix-login      nina/fix-login ⎇  +214 −38 · 6 files · ↑3   Nina · working   [Open session] [⋯]
 │   build-02   …/checkouts/api/release-notes  ops/release-notes ⎇  ✓ clean  ↑1          idle 3 d          [Open] [⋯]
 │
 │  acme/web  ·  no Work linked                                 1 checkout on 1 computer
 │   design-mac ~/Developer/web                develop     ● 3 uncommitted              found 1 d ago   [Fetch ▾] [⋯]
 │
 │  ○ win-lab is offline — its 2 checkouts are shown as last known (3 h ago)
 └────────────────────────────────────────────────────────────────────────────────────────────────
```

| Phase  | Ships                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The Checkout entity; discovery of clones under the code folders the machine owner lists; the node's existing Task worktrees shown as checkouts; `missing` detection; the git line and its refresh cadence; hub and computer Checkouts tabs; fetch; archive and restore. |
| **P2** | Create a checkout: fresh clone (platform-minted, repository-scoped credential) and worktree of an existing checkout; pull and push; delete with the changes-check; Checkout paths become file roots (R-18); Agent tools, MCP and CLI verbs. |
| **P3** | Container-isolated checkouts (folder mounted into a container the sessions run in); shared folders between worktrees of one repository; bin purge policy.                                                                                           |

Each phase is independently shippable behind `FLEET_CHECKOUTS_ENABLED`.

---

## 1. Overview

A Checkout belongs to a Node and to the person who owns that Node. It has a path on the machine,
a kind — `clone` (Ever Works cloned it), `worktree` (Ever Works added it to an existing checkout)
or `discovered` (it was already there) — an optional link to the repository Work whose remote it
matches, a branch, a base ref, an isolation mode (`host` or `container`) and a state: `creating`,
`ready`, `missing` (the folder is gone) or `archived` (in the bin).

Checkouts appear in two places, deliberately grouped differently: the **Fleet → Checkouts** tab
lists every checkout on every computer grouped by repository, so "where do I have `acme/api`
checked out?" is one glance; the **computer page → Checkouts** tab lists the same rows filtered
to one machine, with **New checkout** and **Scan now** beside them. Nothing about a checkout is
done without the node: discovery, clone, worktree, fetch, pull, push, delete and the git line are
all computed on the machine and reported over the node link. The platform stores only the
registry row, the git line snapshot and the audit trail; it never holds a machine credential and
never reads repository content for its own database.

Two kinds of credential, two kinds of checkout. A **discovered** checkout is the owner's own
clone: fetch, pull and push on it run exactly as they would in that person's terminal, with the
machine's own git configuration. A checkout **Ever Works created** never relies on the machine's
credential helper: the node asks the platform for a repository-scoped, short-lived credential
minted through the GitHub App — the same mechanism Task runs already use to push — and the
credential never leaves that machine's memory.

---

## 2. Why now

### 2.1 The user's question

> _"Where is this repo checked out, on which of my machines, on what branch, and is anything
> uncommitted there?"_

And right after:

> _"Give Nina her own copy of `acme/api` on build-01 so she stops stepping on my branch."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                        | Today they must…                                                                                                                     | What breaks                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Which clones are on build-01?"                                   | Open a shell on the machine and look.                                                                                                | The node knows only its own pool: one bare clone per repository plus one worktree per Task under its root (`apps/node/src/core/workspaces/workspace-inventory.ts:17-37`). A clone in `~/code` is not a thing the platform has a name for; nothing on the platform lists even the pool (`docs/features/fleet.md:490` mentions the reaper, never a list).                             |
| "Put a fresh clone of the repo on that machine."                  | Nothing. Start a Task and hope a run provisions one.                                                                                 | Provisioning is a side effect of an `agent-task` job (`apps/node/src/core/workspaces/fleet-task-workspace.ts:584-600`): the spec is a Task's repository, base ref and Task branch (`packages/contracts/src/fleet/fleet-task-workspace.types.ts:9-40`). There is no request shape for "a clone of X for a person", no worktree-of-this-checkout, no isolation choice.                    |
| "Is anything uncommitted or unpushed there?"                      | Shell in; `git status`.                                                                                                              | The node already computes exactly this evidence for its reaper — dirty, lock files, unreachable commits, remote branch gone or merged (`apps/node/src/core/workspaces/workspace-reaper.ts:36-56`) — and prints it only in `ever-works-node doctor`. It reaches no platform surface and no Agent.                                                                                     |
| "Fetch / pull / push from the dashboard."                         | Nothing.                                                                                                                             | The only git the platform can make a node do is the commit-and-push at the end of a Task run (`apps/node/src/core/executors/agent-task.ts:1048-1060`).                                                                                                                                                                                                                             |
| "Delete that worktree, but not if I'd lose work."                 | `ever-works-node gc` on the machine, or `rm -rf` and hope.                                                                           | The reaper is fail-closed and age-based (`workspace-reaper.ts:36-56`); there is no person-initiated delete with a changes-check and a bin.                                                                                                                                                                                                                                       |
| "Which repository Work does this clone belong to?"                | Know it.                                                                                                                             | A Work knows its source repository and GitHub App installation (`packages/agent/src/entities/work.entity.ts:399`, `:988-998`), and the installation snapshot knows every repository's `owner/repo` (`packages/agent/src/entities/github-app-installation-repository.entity.ts:10-30`), but nothing links a folder on a machine to either.                                              |
| "Let my Agent fetch or browse it."                                | Nothing.                                                                                                                             | The one Agent fleet tool lists nodes (`packages/agent/src/fleet/agent-fleet-tools.ts:32-56`); the MCP whitelist exposes reads, affinity and drain (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`); `apps/cli/src/commands/` has `auth`, `kb`, `plugins`, `work` and no `fleet`. The node's file access is confined to Task worktrees (`docs/features/fleet.md:490`). |

### 2.3 The gaps this epic closes

1. **The pool is hidden.** The node already keeps clones and worktrees with lease, usage and
   ownership stamps; this epic gives them a platform row and a tab (README D5).
2. **Only a Task can make a checkout.** People and Agents need to create one on purpose, choose
   worktree vs fresh clone vs container, and name the machine.
3. **Owner clones are invisible.** The machine owner lists the folders they keep code in; the
   node scans them and links each clone to its repository Work by remote (R-16).
4. **Nothing refreshes a git line.** FL-06 needs branch, ±lines, files, ahead/behind, uncommitted
   and PR on every session card; this epic computes and stores that snapshot (§4.7 of CONTRACTS).
5. **Deleting is unsafe or impossible.** A person-initiated delete needs the reaper's evidence
   and a typed confirmation when work would be lost; a bin makes archiving reversible.
6. **Files have no roots.** R-18 defines file roots as every Checkout path plus the node's root;
   without Checkouts, FL-11 has only the Task pool to browse.

### 2.4 Why this epic is additive only

Nothing the node does for Task runs changes: the bare pool, the per-Task worktrees, the reaper
and the push credential all keep working untouched. Checkouts are a registry _over_ that pool
plus new, person-initiated actions beside it. Task worktrees the node already holds are shown as
checkouts of kind `worktree` created by `task`; the reaper keeps its own rules and the Checkouts
tab says when the reaper would remove one.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Discovery after listing a code folder.**
  **Given** build-01 runs the node with `--manage` and its owner has listed `~/code` as a code
  folder on that machine,
  **when** the owner opens build-01 → Checkouts and presses **Scan now**,
  **then** within 30 seconds every git clone found up to three folders deep under `~/code` is
  listed as a `discovered` checkout with its path, branch, remote (token-free), dirty count and
  "found just now"; clones whose remote matches a repository Work show that Work's name.

- **S2 — The hub view answers "where is acme/api?".**
  **Given** `acme/api` is checked out on build-01 (twice) and build-02,
  **when** the owner opens Fleet → Checkouts,
  **then** the three rows sit under one `acme/api` heading, each naming its computer, path,
  branch, git line and who (session or Agent) last worked there; offline computers show their
  last-known rows dimmed with the age of that knowledge.

- **S3 — New worktree for an Agent.**
  **Given** a `discovered` checkout of `acme/api` on build-01 at `~/code/api`,
  **when** the owner chooses **New checkout → Worktree of ~/code/api**, accepts the proposed
  branch `nina/fix-login` and presses **Create**,
  **then** the row appears as `creating` within 500 ms, becomes `ready` within 15 seconds on a
  LAN-sized repository, its path is under the node's checkouts root (never inside the parent),
  and the parent row shows "1 worktree".

- **S4 — Fresh clone with a platform credential.**
  **Given** `acme/api` is a private repository covered by the owner's GitHub App installation,
  **when** the owner chooses **New checkout → Fresh clone of acme/api** on build-02,
  **then** the node clones it with a short-lived, repository-scoped credential that the platform
  mints for this operation and revokes when it ends; no credential is stored on the machine, in
  the clone's git configuration, or on the platform row, and progress is reported until `ready`.

- **S5 — Fetch, pull, push.**
  **Given** a `ready` checkout with nothing running in it,
  **when** the owner presses **Fetch**, then **Pull**, then **Push**,
  **then** fetch runs without a dialog and the git line's ahead/behind updates; pull asks one
  confirmation and refuses with a reason when the working tree has uncommitted changes; push
  asks one confirmation naming the branch and remote; each outcome is shown inline with the exit
  code and the first line of any error.

- **S6 — The git line follows a session.**
  **Given** Nina has an Agent session running in `…/checkouts/api/fix-login`,
  **when** the owner watches that checkout's row,
  **then** the git line refreshes at least once a minute while the session runs, once more when
  the session stops, and never more often than every 10 seconds when a person presses Refresh.

- **S7 — Delete safely.**
  **Given** a worktree checkout with 2 uncommitted files and 1 unpushed commit,
  **when** the owner presses **Delete**,
  **then** the dialog says exactly what would be lost — _"2 uncommitted files and 1 commit not on
  any remote would be lost"_ — and requires typing the checkout's name; on confirmation the folder
  is removed, the branch is kept, and the row moves to the bin with "folder removed".

- **S8 — Archive and restore.**
  **Given** a `ready` checkout nobody has used for a week,
  **when** the owner presses **Archive**,
  **then** the row leaves the list and the folder stays untouched; from the **Bin** the owner can
  **Restore** it (folder present) or **Delete** it (changes-check applies).

- **S9 — An Agent creates a checkout for its Task.**
  **Given** an Agent with `--work` on build-01 is started on a Task of the `acme/api` Work,
  **when** the start dialog (FL-04) chooses "new worktree",
  **then** the node creates a `worktree` checkout created by `task`, linked to the Work, on the
  Task's branch, and the session's row names it; the Agent needs no extra permission because the
  Node already consented to work.

- **S10 — A machine owner removes the folder by hand.**
  **Given** a `ready` checkout,
  **when** its folder is deleted outside Ever Works and the node next reconciles,
  **then** the row becomes `missing` within 10 minutes, its row says _"The folder is gone from
  build-01"_, sessions refuse to start in it, and the owner can **Forget** it or **Clone again**.

- **S11 — Container-isolated checkout (P3).**
  **Given** build-01 advertises `docker` and `managed`,
  **when** the owner creates a checkout with **Isolation: container**,
  **then** sessions started in it run inside a fresh container with the folder mounted, the row
  carries a container badge, and the host never runs that checkout's commands.

### 3.2 Edge cases and failures

- **U1 — Node offline.** Every state-changing action refuses with `unreachable` and the last
  heartbeat age; the rows stay visible as last known. Scan, create, fetch, pull, push and delete
  are disabled with that reason as their tooltip.
- **U2 — Consent missing.** A node without `--manage` shows the Checkouts tab with its last-known
  Task worktrees and a banner: _"Checkout management needs `--manage` on build-01"_ with the exact
  command; discovery, create-for-a-person, fetch, pull, push and delete refuse with
  `consent_missing`. A node with only `--work` still creates checkouts for Tasks.
- **U3 — Kill switch on.** Every link request refuses with `kill_switch`; a clone or sync in
  flight is cancelled, its row reads `creating → missing` or keeps its last git line, and the hub
  carries the fleet stop banner.
- **U4 — Permission denied.** An Organization member outside the Node's `checkouts` audience sees
  the tab read-only (when `view` allows) and every action disabled with _"Only the owner of
  build-01 can manage checkouts"_; the server refuses the same act with `permission_denied` and
  the policy named.
- **U5 — Limit exceeded.** A scan stops at 300 discovered checkouts per Node and the tab says
  _"300 of more — narrow the code folders on build-01"_; create refuses with `limit_exceeded`
  while the Node is at the cap.
- **U6 — Link drops mid-clone.** The node keeps cloning; when the link returns, the operation
  resumes reporting and the row settles to `ready` or `missing`; a clone that cannot be verified
  on reconnect is reported `operation_failed` with the first stderr line and the partial folder
  is removed by the node.
- **U7 — Pull on a dirty tree.** Refused before anything runs: _"3 uncommitted files on build-01 —
  commit or stash them in a session first"_; nothing changes.
- **U8 — Push without a credential.** A platform-created checkout whose remote is not covered by
  any installation refuses with `operation_failed` and the hint _"install the GitHub App on
  acme/web, or push from a session with your own login"_; the machine's own credential helper is
  never used for a platform-created checkout.
- **U9 — Something is running in the checkout.** Pull, push, delete and archive refuse with
  `busy` naming the session (_"Nina is working in this checkout"_); fetch is allowed.
- **U10 — Reaper holds it.** A create or sync that collides with the reaper reclaiming the same
  worktree refuses with `busy` and _"being tidied — try again in a minute"_.
- **U11 — Container isolation on an unsupported node.** A Windows node, or a node without
  `docker`, refuses `isolation: container` with `unsupported_on_node` and names the missing piece.
- **U12 — Remote with a secret in it.** A discovered clone whose remote URL carries a token is
  reported with the token stripped and the row shows _"remote had an embedded credential —
  stripped"_; the raw URL never leaves the machine.
- **U13 — Two checkouts, one path.** A create whose target path already exists refuses with
  `invalid` and proposes the next free name; discovery never registers the same path twice.
- **U14 — Bin item whose folder came back.** A `missing` row whose folder reappears is reconciled
  back to `ready` on the next check and the row says so.

---

## 4. Functional requirements

### 4.1 P1 — Registry, discovery, git line, bin

- **FR-1** A Checkout MUST belong to exactly one Node and MUST record path, kind, state, branch,
  base ref, remote (token-free), isolation, who created it and when.
- **FR-2** The Checkouts tab on a computer page MUST list every checkout on that Node, and the
  Fleet → Checkouts tab MUST list every checkout on every Node the viewer may see, grouped by
  repository.
- **FR-3** A machine owner MUST be able to list code folders for that Node on the machine itself;
  the platform MUST never choose folders for them and the home directory MUST never be scanned
  whole.
- **FR-4** Discovery MUST run on the node, MUST stop descending at the first `.git` it finds in a
  branch of the tree, MUST go at most three folders deep, MUST skip dependency and build folders,
  and MUST stop at 300 checkouts per Node, saying so.
- **FR-5** Discovery MUST report remote URLs with any embedded credential removed and MUST flag
  that a credential was present.
- **FR-6** A discovered checkout whose remote matches a repository Work of the viewer MUST be
  linked to that Work; matching MUST be host-aware so a same-named repository on another host is
  never linked.
- **FR-7** Task worktrees the node already holds MUST appear as checkouts of kind `worktree`
  created by `task`, linked to the Task's Work, without changing how the node provisions them.
- **FR-8** Every checkout MUST carry a git line snapshot — branch, worktree flag, base ref, ahead,
  behind, lines added and removed, files changed, uncommitted count, PR and the snapshot time.
- **FR-9** The git line MUST be refreshed every 60 seconds while a session runs in the checkout,
  once when that session stops, on demand (no more than once per 10 seconds per checkout), and
  otherwise at most once per 5 minutes when listed.
- **FR-10** Computing the git line MUST NOT contact the remote; ahead/behind MUST be computed
  against the remote-tracking ref the last fetch left.
- **FR-11** The node MUST reconcile every checkout's path on link open and every 10 minutes; a
  path that is gone MUST move the row to `missing`, and a `missing` path that returns MUST move it
  back to `ready`.
- **FR-12** Fetch MUST run without confirmation, MUST refresh the git line afterwards, and MUST be
  allowed while a session runs in the checkout.
- **FR-13** Archive MUST hide a checkout without touching its folder; the bin MUST list archived
  checkouts with Restore (folder present) and Delete (changes-check applies).
- **FR-14** Every checkout row MUST show its size on disk and the computer MUST show the total
  size of its checkouts, so the cost of a checkout is visible.
- **FR-15** Offline Nodes MUST show their last-known rows dimmed with the age of that knowledge,
  never an empty tab.

### 4.2 P2 — Create, pull, push, delete, roots, tools

- **FR-16** A person MUST be able to create a checkout as a fresh clone, as a worktree of an
  existing checkout on the same Node, or (P3) as a container-isolated folder, naming the Node.
- **FR-17** A fresh clone MUST authenticate only with a credential the platform mints for that
  operation — repository-scoped, time-limited, revoked when the operation ends — and MUST NOT use
  the machine's own credential helper.
- **FR-18** A worktree MUST be created with the branch name the caller gives or the program's
  branch rule proposes (FL-06), MUST be placed under the node's checkouts root, never inside the
  parent checkout, and MUST record its parent.
- **FR-19** A branch name MUST never be reused for the same remote: a proposed name that exists
  on the remote or on any checkout row for that remote (archived included) MUST get a numeric
  suffix.
- **FR-20** Create MUST return within 500 ms with the row in `creating` and MUST report progress
  until `ready`; a failed create MUST remove any partial folder and MUST report the first line of
  the error.
- **FR-21** Pull MUST require one confirmation, MUST refuse when the working tree has uncommitted
  changes, and MUST refuse while a session runs in the checkout.
- **FR-22** Push MUST require one confirmation naming branch and remote, MUST refuse while a
  session runs in the checkout, and on a platform-created checkout MUST use the operation-scoped
  credential of FR-17.
- **FR-23** On a `discovered` checkout, fetch, pull and push MUST run with the machine's own git
  configuration and login, exactly as the owner's terminal would.
- **FR-24** Delete MUST compute, on the node, uncommitted files and commits unreachable from any
  remote; when both are zero it MUST ask a plain confirmation, otherwise it MUST require typing
  the checkout's name and MUST state the counts.
- **FR-25** Delete of a worktree MUST remove the folder and its registration and MUST keep the
  branch; delete of a clone MUST remove the folder; a `discovered` checkout MUST only be forgotten
  (row removed, folder untouched).
- **FR-26** A deleted checkout MUST appear in the bin as "folder removed" and MUST NOT offer
  Restore.
- **FR-27** Every Checkout path in `ready` MUST be an allowed file root for FL-11 on that Node;
  an `archived` or `missing` path MUST NOT be.
- **FR-28** Every state-changing action MUST write one Fleet audit row naming the family
  `checkouts`, the target path, the requester and the confirmation class, and MUST never write a
  credential or a remote URL with a credential.
- **FR-29** Agents MUST get the same actions as tools, read-only tools always allowed, and
  state-changing tools gated by Agent permissions and the Node's `checkouts` audience.
- **FR-30** When the kill switch is on, every checkout request MUST be refused with `kill_switch`
  and any clone or sync in flight MUST be cancelled.

### 4.3 P3 — Isolation and sharing

- **FR-31** A container-isolated checkout MUST run every session and command for that checkout
  inside a container with the folder mounted, MUST be refused on Nodes without `docker`, and MUST
  be labelled on every surface.
- **FR-32** A repository Work MAY list shared folders (ignored by git) that are linked, not
  copied, into every new worktree of that repository on a Node.
- **FR-33** Bin rows older than 30 days whose folder is gone MUST be purged by a scheduled sweep,
  not on read.

---

## 5. UX

All copy is the exact user-visible string; keys are under `fleet.checkouts.*`.

### 5.1 Fleet → Checkouts (hub tab)

Header: filters (computer, repository, state), **Scan computers**, **New checkout ▾**, **Bin (n)**.
Body: groups by repository (Work name when linked, else `owner/repo`, else "unlinked"), each row:
computer dot+name · path (home-relative, full on hover) · branch (⎇ when worktree) · git line ·
activity ("Nina · working", "idle 3 d", "found 2 h ago") · actions (**Fetch ▾** with Pull/Push,
**Open session** when one runs, **⋯**: Archive, Delete, Forget, Copy path, Open on computer page).

States: **empty** — _"No checkouts yet. List a code folder on a computer and scan it, or create
one."_ with both buttons; **loading** — skeleton rows; **unavailable** — per computer: _"win-lab
is offline — 2 checkouts shown as last known (3 h ago)"_ / _"Checkout management needs `--manage`
on build-01"_ + command; **error** — the error code's hint inline, never a toast alone.

### 5.2 Computer page → Checkouts tab

Same rows filtered to one machine, plus a **Code folders** card: the folders this machine scans
(read from the node; _"Set on the machine: `ever-works-node start --code-folder ~/code`"_),
**Scan now**, last scan time, "N of 300". A reaper note on rows the node would tidy: _"Would be
tidied in 3 days (unused 11 d)"_.

### 5.3 New checkout dialog

Steps: **Where** (computer; disabled rows say why) → **What** (repository: Works, installation
repositories, or a public URL) → **How** (Fresh clone · Worktree of… [list of checkouts of that
repository on this computer] · Container (P3)) → **Branch** (proposed, editable, collision note) →
**Create**. The footer always states the cost: _"Uses disk on build-01 (acme/api is about 420
MB). No tokens or credits."_

### 5.4 Delete dialog

Clean: _"Delete …/checkouts/api/fix-login on build-01? The branch nina/fix-login is kept."_
Dirty: amber box _"2 uncommitted files and 1 commit not on any remote would be lost."_ + _"Type
fix-login to confirm."_

### 5.5 Activity view and Agent page

No new Activity view; checkout actions appear in the Activity log as sentences (_"Dana created a
worktree of acme/api on build-01"_ pattern, names from the account). The Agent page is
unchanged; sessions show their checkout through FL-06's git line.

### 5.6 Keyboard and palette

`N` new checkout, `S` scan, `F` fetch on the focused row, `/` filter; palette entries "Checkouts"
(hub tab) and one per repository ("acme/api checkouts").

---

## 6. Non-functional requirements

- **Performance:** list ≤ 300 rows per Node in ≤ 300 ms (p95) from the platform row; discovery of
  a 3-deep tree with 50 clones in ≤ 30 s; git line computation ≤ 2 s per checkout on the node;
  worktree create ≤ 15 s on a warm pool.
- **Reliability:** reconciliation is idempotent; a create interrupted by a node restart ends in
  `ready` or `missing`, never a phantom `creating` older than 10 minutes (swept to `missing`).
- **Security & privacy:** remotes are stored token-free; the platform never stores a path outside
  the Node's reported paths; credentials are minted per operation, repository-scoped, revoked on
  completion; discovered checkouts never receive a platform credential.
- **Observability:** every action audited (CONTRACTS §2.3, §7); counters for discovered, created,
  deleted, missing per Node.
- **Compatibility:** git ≥ 2.31 on the node (the floor the push capability already requires);
  additive contracts only.

---

## 7. Key entities & concepts

| Entity / concept                        | New?     | Description                                                                                                        |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| **Checkout** (`FleetCheckout`)          | **NEW**  | A clone or worktree on a Node (CONTRACTS §4.3). Kinds `clone · worktree · discovered`; states `creating · ready · missing · archived`. |
| **Git line**                            | **NEW** (shape) | The snapshot in CONTRACTS §4.7, computed on the node, PR part supplied by FL-06.                              |
| **Code folder**                         | **NEW** (node-local) | A folder the machine owner lists on the machine for discovery. Never stored on the platform as a secret; reported as a path. |
| **Bin**                                 | **NEW** (view) | Archived checkouts; "folder removed" when deleted.                                                             |
| **Node**, **Work**, **Task**, **Run**, **Agent**, **Fleet audit** | Existing | Unchanged; a Checkout references a Node and optionally a Work (R-16).                                     |

---

## 8. Out of scope

- A second "repositories" page or GitHub browser (FL-15 feeds Tasks; README §3 refuses a second
  inbox).
- Editing files in a checkout from the platform (FL-11 transfers; FL-06 shows a read-only diff).
- Changing where Task runs provision their worktrees.
- Cross-machine copy of a checkout.
- Windows containers.

## 8b. Open questions

- `[NEEDS CLARIFICATION: Should fetch/pull/push on a discovered checkout be allowed to use the
machine's own credential helper (this spec: yes, because it is the owner's clone, D14), or must
every platform-initiated git network action use a platform-minted credential?]`
- `[NEEDS CLARIFICATION: CONTRACTS change — the machine family vocabulary (§3.3) lists
`checkouts.list|create|delete|sync`; FL-06 needs `checkouts.changes` (uncommitted diff) and
FL-15 needs `git.identity|git.setIdentity`. This epic uses `checkouts.list { rescan, refresh,
checkoutIds }` for scan and git-line refresh so it needs no new message itself.]`
- `[NEEDS CLARIFICATION: Code folders are set on the machine (`--code-folder`, persisted like
`--workspace-root`). Should the owner also be able to set them from the computer page (a
platform-to-machine config write), or does that cross D2's "nothing on a machine is done without
the node" in spirit?]`
- `[NEEDS CLARIFICATION: Bin purge after 30 days (FR-33) — keep, or never purge?]`
- `[NEEDS CLARIFICATION: Container image for isolated checkouts — a platform default image
configurable in Fleet settings, or per Work?]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL14-01** (FR-3, FR-4) A node with `--code-folder ~/code` lists every clone ≤ 3 deep, skips `node_modules`, stops at 300 and says so.
- [ ] **ACC-FL14-02** (FR-5) A remote `https://x:token@github.com/acme/api` is stored as `https://github.com/acme/api` with the flag set.
- [ ] **ACC-FL14-03** (FR-6) A github.com remote matching a Work's repository links; a same-named repository on another host does not.
- [ ] **ACC-FL14-04** (FR-7) Existing Task worktrees appear as `worktree`/`task` rows without any change to provisioning.
- [ ] **ACC-FL14-05** (FR-8, FR-10) The git line carries every §4.7 field and is computed without a network call.
- [ ] **ACC-FL14-06** (FR-9) A running session refreshes the line every 60 s; stop refreshes once; manual refresh is capped at 1/10 s.
- [ ] **ACC-FL14-07** (FR-11) Removing a folder by hand yields `missing` within 10 min; restoring it yields `ready`.
- [ ] **ACC-FL14-08** (FR-12, FR-21, FR-22) Fetch needs no dialog; pull and push need one; pull refuses on a dirty tree.
- [ ] **ACC-FL14-09** (FR-16–FR-18, FR-20) Worktree create returns `creating` in ≤ 500 ms, lands under the checkouts root, records the parent.
- [ ] **ACC-FL14-10** (FR-17) A fresh clone of a private repository succeeds with no credential in the folder, the row or the audit, and the token is revoked at the end.
- [ ] **ACC-FL14-11** (FR-19) A proposed branch that exists on the remote gets `-2`.
- [ ] **ACC-FL14-12** (FR-24–FR-26) Delete of a dirty worktree demands the typed name and states counts; the branch survives; the bin shows "folder removed".
- [ ] **ACC-FL14-13** (FR-13) Archive leaves the folder; Restore works only while the folder exists.
- [ ] **ACC-FL14-14** (FR-27) FL-11's root list equals the `ready` checkout paths plus the node root.
- [ ] **ACC-FL14-15** (FR-28) Every action writes one audit row with family `checkouts` and never a credential.
- [ ] **ACC-FL14-16** (FR-29) `fleet_checkouts_list` works for any Agent; `fleet_checkouts_delete` is refused outside the family audience with `permission_denied`.
- [ ] **ACC-FL14-17** (FR-30, U3) Kill switch refuses every request with `kill_switch` and cancels a clone in flight.
- [ ] **ACC-FL14-18** (U2) A node without `--manage` shows the exact command and refuses with `consent_missing`.
- [ ] **ACC-FL14-19** (FR-14) Every row shows its size; the computer shows the total.
- [ ] **ACC-FL14-20** (FR-31) `isolation: container` is refused on Windows and on nodes without `docker` with `unsupported_on_node`.
- [ ] **ACC-FL14-21** Every user-visible string is a `fleet.checkouts.*` key; the banned-terms grep prints nothing.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration is added: git is a local tool on the machine; the GitHub credential comes through the existing GitHub App path.
- [x] **II — Capability-driven.** The node advertises `git`, `git-push`, `docker`, `managed`; no provider id is hard-coded.
- [x] **III — Source-of-truth repos.** Repository content stays on the machine and in the user's repositories; the platform stores a registry row and a snapshot.
- [x] **IV — Job runtime.** Creates and syncs are ephemeral link requests (CONTRACTS §12); the reconcile sweep and bin purge run as scheduled tasks via dispatcher symbols.
- [x] **V — Forward-only migrations.** One additive migration, slot `1796140000000`.
- [x] **VI — Tests.** Named per package in the plan and tasks.
- [x] **VII — Secrets.** Remotes stored token-free; operation credentials never persisted; audit redaction applies.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first.** Only evidence citations in §2 and §11.
- [x] **X — Backwards compatibility.** Additive entity, routes, tags and tools.

---

## 11. References

- Program: [Fleet README](../README.md) · [CONTRACTS](../CONTRACTS.md) §0 R-16, R-18, R-24; §1; §2; §3.3 `machine`; §4.3; §4.7; §7; §8; §9; §10; §11; §12; §13 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §E
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Evidence (HEAD `e4334baf7`): `apps/node/src/core/workspaces/fleet-task-workspace.ts:584-600`, `apps/node/src/core/workspaces/workspace-inventory.ts:17-80`, `apps/node/src/core/workspaces/workspace-reaper.ts:30-60`, `apps/node/src/core/capabilities.ts:264-310`, `apps/node/src/cli/program.ts:383-421`, `packages/contracts/src/fleet/fleet-task-workspace.types.ts:9-40`, `packages/contracts/src/fleet/fleet-push-credential.types.ts:1-40`, `apps/api/src/fleet/fleet-push-credential.service.ts:1-70`, `packages/agent/src/entities/work.entity.ts:399,988-998`, `packages/agent/src/entities/github-app-installation-repository.entity.ts:10-30`
- Related epics: FL-02, FL-04, FL-06, FL-11, FL-15, FL-19, FL-20; AW-11 (per-Agent profile dirs on a node)
- User docs to write: `docs/features/fleet-checkouts.md`
