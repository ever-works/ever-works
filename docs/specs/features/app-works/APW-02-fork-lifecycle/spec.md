# Feature Specification: Fork lifecycle — readiness, Actions hygiene, upstream sync, divergence, checkout keys

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-02-fork-lifecycle`
**Program**: [App Works](../README.md) — Wave 0 (P0, independently shippable) · Wave 1 (P1)
**Branch**: `feat/apw-02-fork-lifecycle` (P0 ships alone as `feat/apw-02-fork-lifecycle-p0`)
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: L · **Depends on**: — · **Depended on by**: APW-01 (readiness, existing forks, repository facts),
APW-03 (re-evaluation after sync), APW-04 (fork ready), APW-05 (Actions permissions, webhooks), APW-08,
APW-09 (fork network)

> **Additive-only (program rule 1).** Every existing caller of the fork call, the repository read and the
> local working copies keeps its behaviour: template forks still wait for readiness, existing clones still
> work, and nothing that reads a repository today reads anything different. P0 changes only **where** a
> working copy lives and **whether** a clone may start from an empty working copy when the caller says the
> repository must already exist.

> **Program audit resolutions applied (2026-09-17).** This spec follows
> [CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5):
> R-1 and R-2 (in the plan), R-4 (the setup pull request an App Work may wait for), R-8 (the **Upstream** tab), R-14
> (existing weaknesses described generically) and R-21 (who a conflict Task is assigned to). Where older text in this
> epic disagreed, the resolution wins and the text below was aligned.

---

## 1. Overview

A fork is not finished when GitHub accepts the request, and it does not stay useful on its own. This epic
makes an App Work's Work Repository behave like something a member can trust over months:

- **Ready means ready.** An App Work leaves **Preparing** only when its repository can be read and its
  default branch has a commit — and, when its source is recorded through a setup pull request, only once that pull
  request is merged. Slow forks time out visibly at 15 minutes with **Try again**; nothing ever asks GitHub for a
  second fork.
- **Inherited automation is off.** Workflows that came with the upstream are switched off in the fork so
  they do not spend the member's GitHub Actions minutes or run code nobody reviewed. The Ever Works build
  workflow stays allowed, and a workflow the member turns back on stays on.
- **Upstream is followed, never pushed to.** On a schedule, or when the member presses **Sync now**, a fork
  that is only behind is fast-forwarded; a fork with its own changes gets a sync pull request; a conflict
  becomes one Task — never an automatic resolution, never a force push. Private copies get the same pull
  request, prepared by a background job.
- **Divergence is visible.** A badge says **"12 commits behind upstream"** or **"3 ahead, 12 behind
  upstream"**, with when it was checked.
- **Working copies are kept apart.** Checkout directory keys become case-preserving, separator-safe and
  provider-scoped, so two different repositories always get two different local working copies, and a clone that
  must find an existing repository refuses instead of starting from an empty one.
- **One place to look.** The App Work's **Upstream** tab shows how its repository relates to upstream, whether it
  is ready, how syncing is going and which inherited workflows were switched off.

Lost access, deleted forks, archived or deleted upstreams, renamed default branches and GitHub rate limits
each end in a named state with a next step — never a silent stop.

## 2. Why now

### 2.1 The user's question

> _"My fork is three months old. What has upstream shipped since, and can I take it without losing my
> changes?"_ — and, the week after forking: _"Why did my Actions minutes run out?"_

### 2.2 What they do today instead

| The need                       | What Ever Works offers today                                                                            | What the user actually does                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Know a fork is ready           | The fork call waits up to two minutes inside the request, then gives up with nothing.                   | Refreshes GitHub.                                           |
| Reuse an existing fork         | Found only when the caller passes a name, and fork identity is not confirmed.                           | Deletes or renames forks by hand.                           |
| Stay current with upstream     | Nothing syncs a fork. A "fork update" path exists and does nothing.                                     | Clicks **Sync fork** on GitHub, resolves conflicts locally. |
| See how far behind the fork is | Nothing.                                                                                                | Opens GitHub's compare page.                                |
| Stop inherited workflows       | Nothing for forks; the platform only enables its own deployment workflows on repositories it generated. | Disables workflows one by one on GitHub.                    |
| Keep working copies apart      | Checkout directory keys are not guaranteed unique across owners and repositories.                       | Nothing — it is invisible to them.                          |

### 2.3 The gaps, all of them ours

1. **Checkout directory keys are not guaranteed unique.** The key that picks a local working copy is not
   guaranteed to differ for different owners and repositories; the fix makes keys case-preserving,
   separator-safe and provider-scoped.
2. **A clone cannot say "this repository must already exist".** A clone that finds nothing starts from an empty
   working copy — right for a repository about to be populated, wrong for a fork that GitHub is still creating.
3. **Forks are fire-and-forget.** No readiness, no sync, no divergence, no hygiene, and a two-minute block
   inside a web request.

## 3. User scenarios

### 3.1 Primary

- **S1 — Ready when it has a commit.**
  **Given** an App Work whose fork was just requested,
  **when** GitHub makes the repository readable but its default branch is still empty,
  **then** the App Work stays **Preparing**; once the default branch has a commit it becomes ready within
  30 seconds, Activity records one "fork ready" entry, and the App Work's setup step runs exactly once.

- **S1b — Ready after the setup pull request is merged.**
  **Given** an App Work whose setup step opened a setup pull request (a linked repository, or a fork Ever Works did
  not create — Resolution R-4),
  **when** the member merges that pull request,
  **then** the App Work becomes ready within 60 seconds of being viewed (and within 10 minutes regardless), the
  setup step's follow-ups run exactly once, and if the member instead closes the pull request without merging, the
  App Work shows it as failed with **Try again**, which opens a new setup pull request.

- **S2 — An existing fork is found, whatever its name.**
  **Given** the member forked `acme/tasks-app` a year ago as `me/tasks-fork`,
  **when** any flow asks for a fork of `acme/tasks-app` into `me`,
  **then** `me/tasks-fork` is returned within 5 seconds without a fork request, and a repository called
  `me/tasks-app` that is **not** a fork of `acme/tasks-app` is never mistaken for one.

- **S3 — Inherited workflows switched off.**
  **Given** a fork whose upstream has 7 workflows, one of them the Ever Works build workflow,
  **when** the fork becomes ready,
  **then** 6 workflows are disabled, the build workflow is left enabled, Activity records
  **"6 inherited workflows disabled"**, and the Upstream card lists their file paths.

- **S4 — Behind only: fast-forward.**
  **Given** a fork with no commits of its own that is 12 commits behind,
  **when** the scheduled sync runs,
  **then** the default branch is fast-forwarded to upstream, the badge reads **"Up to date with upstream"**,
  and Activity records **"Synced 12 commits from upstream"**.

- **S5 — Diverged: a sync pull request.**
  **Given** a fork 3 commits ahead and 12 behind,
  **when** a sync runs,
  **then** the branch `ever-works/upstream-sync` points at upstream's head, a pull request
  **"Sync with upstream (12 commits)"** targets the tracked branch, nothing is merged automatically, and the
  card shows **"Opened a pull request to sync 12 commits"** with a link.

- **S6 — Conflict: one Task.**
  **Given** the sync pull request from S5 cannot merge because of conflicts,
  **when** the sync finishes,
  **then** one Task **"Resolve upstream sync conflicts in me/tasks-app"** is created on the App Work, its
  description lists the pull request, the upstream range and the conflicting files GitHub reports (up to
  50), its Agent is the one the evolve loop's change-Agent rule resolves for the App Work (FR-38), and nothing
  attempts to resolve the conflict.

- **S7 — Divergence badge.**
  **Given** an App Work whose divergence was last checked 40 minutes ago,
  **when** the member opens its Overview,
  **then** the badge renders the last known counts with **"Checked 40 minutes ago"** immediately and refreshes
  them in the background because they are older than 10 minutes.

- **S8 — Sync now.**
  **Given** the Upstream card,
  **when** the member presses **Sync now**,
  **then** the button changes to **Syncing…** within 2 seconds, the request returns before the sync
  finishes, and the card shows the result when it lands.

- **S9 — Private copy sync.**
  **Given** a private copy 20 commits behind its upstream,
  **when** a sync runs,
  **then** a background job fetches upstream's default branch, pushes it to `ever-works/upstream-sync` in the
  copy, and opens the same kind of pull request as S5.

- **S10 — Two repositories, two working copies.**
  **Given** Works on two distinct owner/repository pairs whose normalized names collide,
  **when** each is cloned locally,
  **then** each gets its own directory, and deleting one never removes another's.

- **S10b — The Upstream tab.**
  **Given** an App Work on a fork or private copy,
  **when** the member opens its **Upstream** tab,
  **then** they see the relation (**Fork of acme/tasks-app** or **Private copy of acme/tasks-app**), the readiness
  state (with **Try again** when it timed out or failed), the divergence badge, the last and next sync, and the
  inherited workflows that were switched off; a linked App Work has no Upstream tab.

### 3.2 Unhappy paths

- **S11 — Fork never finishes.** After 15 minutes of **Preparing**: **"Your fork is taking longer than 15
  minutes."** with **Try again** (resumes waiting; at most 3 per hour) and **Open on GitHub**. Activity
  records one "fork timeout".
- **S12 — Access revoked while preparing.** The member disconnects GitHub: readiness stops with
  **"Ever Works lost access to GitHub while preparing this App Work."**; after reconnecting, **Try again**
  resumes on the same fork.
- **S13 — Upstream archived.** The card shows **"Upstream is archived — sync is paused."**; scheduled syncs
  stop; the divergence badge keeps its last counts.
- **S14 — Upstream deleted or no longer readable.** **"Upstream acme/tasks-app is no longer reachable. Sync is
  paused."**; Activity records one "upstream unavailable"; the check repeats daily and sync resumes by itself
  when the upstream is readable again.
- **S15 — Fork deleted.** GitHub deleted the fork (for example after the member lost access to a private
  upstream): the App Work shows **"Your fork me/tasks-app no longer exists on GitHub."**, every background job
  for it stops, and Activity records one "fork missing".
- **S16 — Rate limited.** **"GitHub rate limit reached — sync will retry at 14:05."**; no request is sent
  before that time; after 3 consecutive rate-limited runs the card keeps the notice until a run succeeds.
- **S17 — Upstream renamed its default branch.** Upstream moved from `main` to `trunk`: the card shows
  **"Upstream's default branch changed from main to trunk."**, and the next sync opens its pull request from
  upstream's `trunk` instead of failing.
- **S17b — Upstream rewrote its history.** The sync pull request cannot be moved without a force push, so the card
  shows **"Upstream rewrote its history. Close the sync pull request, then sync again."**; after the member closes it,
  the next sync starts a fresh pull request.
- **S18 — A workflow arrives later.** An upstream sync brings a new workflow file: once the sync pull request
  is merged, the next hygiene run disables it and lists it; the card explains **"Workflows added later — by an
  upstream sync or a pull request — are switched off after each sync. Turn one on in GitHub only if you trust
  it."**
- **S19 — Clone before the repository exists.** A clone of the App Work's repository while it is still
  empty fails with **"The repository isn't ready yet."** and leaves no local copy behind.
- **S20 — No admin on the fork.** In an organization where the member can push but not administer:
  **"You need admin access to my-org/tasks-app to switch off its workflows."**; syncing still works.
- **S21 — GitHub App lacks a permission.** When the App Work uses the Ever Works GitHub App and the App lacks
  a permission a step needs: **"The Ever Works GitHub App needs the {permission} permission on {repo}."**
  naming exactly one permission per step.
- **S22 — Private copy too large to sync.** A private copy whose upstream has grown past 500 MB:
  **"Upstream is now too large to sync into a private copy ({size})."**; scheduled syncs pause.

### 3.3 Race and permission edges

- **S23 — Two syncs at once.** A scheduled and a manual sync for the same App Work: exactly one runs; the
  other answers **"A sync is already running."**
- **S24 — New commits while a conflict Task is open.** No second Task: the open Task gains a comment with
  the new upstream range, and the sync pull request branch moves to the new upstream head.
- **S25 — Someone pushes between check and sync.** A fork that gained a commit after being judged
  "behind only" is never force-pushed; the fast-forward is refused by GitHub and the run falls back to the
  pull-request path.
- **S26 — Sync pull request already open.** It is updated in place, never duplicated; one closed by the
  member is not reopened — the next sync opens a new one only when upstream has moved since.
- **S27 — Readiness job lost.** A readiness job that never starts or dies is found within 10 minutes and
  started again, at most 3 times, before the App Work is marked timed out.
- **S28 — Someone else's App Work.** Every read and action on another account's App Work answers not found.

- **S29 — Upstream adds automation.** **Given** an App Work whose tracked branch is up to date and whose upstream
  commits a change that adds or edits a file under `.github/workflows/`, **when** the next sync runs, **then** the
  sync does **not** fast-forward the tracked branch, and it does not push that range onto `ever-works/upstream-sync`
  until the member has confirmed it: the card reads **"Upstream changed its workflows. Review and confirm before
  syncing."** with **Review the changes** and an explicit **Sync anyway** action; until the member confirms, no
  workflow from that range can run in the App Work's repository, and the member's GitHub Actions minutes are
  untouched. Confirming records one Activity entry naming the changed workflow paths (paths only, never file
  contents).

- **S30 — A sync pull request is merged.** **Given** a sync pull request opened by S5, **when** the member merges
  it, **then** the App Work notices within one dispatcher tick (and within 60 seconds of being viewed): "Last
  synced" and the divergence badge update to the commit the pull request carried, one "upstream synced" Activity
  entry records the count, the inherited-workflow list refreshes, and the license gate is asked again — exactly
  once, however many times the check runs.

- **S31 — A fresh fork cannot run workflows yet.** **Given** a fork of an upstream that ships its own workflows,
  **when** the App Work becomes ready and the platform's build workflow is present in the fork, **then** the build
  workflow runs on the first push the platform makes; if the provider reports that a fresh fork's workflows are
  gated, the readiness job enables **exactly that one workflow** and nothing else, records it, and the first Build
  starts. Inherited workflows stay off (S3).

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 Working copies (P0)

- **FR-1.** Two repositories that differ in provider, owner or name — including only in case or in where a
  separator sits — MUST never resolve to the same local working copy.
- **FR-2.** A caller MUST be able to ask for a working copy dedicated to one Work and one repository role, so
  that no other Work can resolve to it.
- **FR-3.** No part of a directory name derived from a repository or Work coordinate MUST be able to leave the
  working-copy root.
- **FR-4.** Concurrent requests for the same working copy MUST share one clone; requests for different working
  copies of the same repository MUST NOT.
- **FR-5.** Removing a working copy MUST remove only that copy.
- **FR-6.** Working copies created before this change MUST NOT be read again; they are left untouched.

### 4.2 Clones that must find a repository (P0)

- **FR-7.** A caller MUST be able to declare that a repository is expected to exist and have commits.
- **FR-8.** For such a caller, a repository that is missing or empty MUST fail with a "not ready" error and
  leave no local directory; it MUST NOT be initialised empty.
- **FR-9.** Callers that do not declare it MUST keep today's behaviour.

### 4.3 Fork requests (P0)

- **FR-10.** Every fork request MUST first look for an existing fork of that upstream in the target owner and
  return it when found, whether or not a name was given.
- **FR-11.** A repository in the target owner is an existing fork only when GitHub reports it as a fork whose
  network root or parent is the requested upstream. A same-named repository that is not MUST NOT be returned.
- **FR-12.** A caller MUST be able to request a fork without waiting: the answer MUST arrive within 10 seconds
  with the fork's owner, name and default branch and a **pending** readiness.
- **FR-13.** Callers that do not ask for the non-waiting mode MUST keep today's waiting behaviour.

### 4.4 Repository facts and errors (P1)

- **FR-14.** A repository read MUST also report: network root, whether forking is allowed, archived,
  visibility, star count, size, detected license identifier, and whether the default branch has a commit.
- **FR-15.** A read of a repository that moved MUST report its new coordinates and the old ones.
- **FR-16.** Provider refusals MUST be classified — not found, unauthorised, rate limited (with reset time),
  secondary rate limited (with retry time), SAML authorization required, third-party access restricted,
  missing permission (with its name), conflict, unprocessable — for every capability in this epic.

### 4.5 Readiness (P1)

- **FR-17.** An App Work's Work Repository is **ready** when it can be read with the Work's credentials and
  its default branch has at least one commit.
- **FR-18.** Readiness MUST be checked in a background job at 2, 4, 8 and 15 seconds after the request, then
  every 15 seconds, for at most 15 minutes, then marked **timed out** with one Activity entry.
- **FR-18a.** A non-production installation MAY shorten the 15-minute readiness deadline (to no less than 5 seconds)
  so automated acceptance tests can reach **timed out**; a production installation MUST always use 15 minutes and
  ignore any override.
- **FR-19.** **Try again** MUST resume checking the same repository, never request another fork or copy, and be
  limited to 3 per App Work per hour.
- **FR-20.** Losing access while preparing MUST end in **failed** with reason `access_revoked`; **Try again**
  MUST work once access is restored.
- **FR-21.** For a private copy, the job MUST push the upstream default branch with full history into the empty
  repository before readiness is checked, MUST refuse upstreams over 500 MB or using Git LFS, and MUST be safe to
  repeat (a copy already holding the same head is not pushed again).
- **FR-22.** On readiness the job MUST run Actions hygiene (§4.6) and then the App Work's setup step exactly once,
  and record the setup outcome, including "waiting for a setup pull request".
- **FR-23.** A readiness job that was never started or stopped reporting for 10 minutes MUST be started again, at
  most 3 times per App Work, before the state becomes **timed out**.
- **FR-24.** A linked repository MUST pass through the same readiness job and pass its readiness check on the first
  probe; its setup step then waits for its setup pull request (FR-24a).
- **FR-24a.** When the setup step reports it is waiting for a setup pull request (Resolution R-4), the system MUST
  check that pull request at least every 10 minutes and within 60 seconds of the App Work being viewed. Merged ⇒ the
  App Work becomes **ready** and the setup step runs once more so its follow-ups happen exactly once. Closed without
  merging ⇒ **failed** with reason `setup_pull_request_closed`; **Try again** re-runs the setup step, which opens a
  new pull request. The check never merges, reopens or edits the pull request.

### 4.6 Actions hygiene (P1)

- **FR-25.** For forks and private copies, every enabled workflow present when the repository becomes ready MUST
  be disabled, except the Ever Works build workflow.
- **FR-26.** Hygiene MUST NOT switch Actions off for the repository as a whole, and MUST NOT enable any workflow.
- **FR-27.** A workflow disabled by hygiene that the member later turns back on MUST stay on; hygiene only
  disables workflows it has not seen before.
- **FR-28.** Hygiene MUST run again after every upstream sync that changed the tracked branch and after a sync
  pull request is merged, capped at 100 workflows per run.
- **FR-29.** Hygiene MUST record the disabled and kept workflow paths (at most 100 each) and emit one
  "Actions disabled" Activity entry per run that disabled at least one.
- **FR-30.** Missing admin permission MUST end in a named state (`needs_admin` or `permission_missing` with the
  permission) and MUST NOT block readiness or sync.
- **FR-31.** Linked repositories MUST NOT be touched by hygiene.

### 4.7 Upstream sync (P1)

- **FR-32.** Sync MUST run on the App spec's schedule when present (five-field cron, UTC), else on Mondays at
  06:00 UTC; schedules firing more often than once an hour MUST be treated as hourly; each App Work's run MUST be
  delayed by a stable 0–300 seconds so App Works do not all start at once.
- **FR-33.** **Sync now** MUST return within 2 seconds without waiting, and MUST be limited to 6 per App Work per
  hour.
- **FR-34.** At most one sync MUST run per App Work at a time.
- **FR-35.** A fork with no commits of its own MUST be fast-forwarded to upstream's default branch head. Because
  Resolution R-4 gives every App Work fork a commit of the platform's own (the source file, or the merged setup pull
  request), in practice an App Work is never behind-only: the reading after readiness is at least one commit ahead,
  so the pull-request path of FR-36 is the normal path and fast-forward stays the exception it is written for. The
  divergence reading MUST report that ahead count truthfully rather than rounding it to zero.
- **FR-36.** A fork with commits of its own, and every private copy that is behind, MUST get the branch
  `ever-works/upstream-sync` pointing at upstream's head and one open pull request into the tracked branch, reused
  and updated on later syncs.
- **FR-37.** Before fast-forwarding, the system MUST ask the license gate (APW-03) whether upstream's head changes
  the license class for the worse; if it does, it MUST open the pull request instead and say why.
- **FR-38.** A pull request that GitHub reports as conflicting MUST produce exactly one open Task on the App Work,
  labelled for this sync, containing the pull request link, the upstream range and up to 50 conflicting paths.
  The Task's Agent is the one the evolve loop's change-Agent rule (APW-08) resolves for the App Work; when no Agent
  resolves, the Task stays unassigned and the owner is notified (Resolution R-21). The system never resolves the
  conflict itself.
- **FR-39.** The system MUST NEVER push to the upstream, force-push the tracked branch, or resolve a conflict
  automatically.
- **FR-40.** A successful sync MUST record the upstream sha it reached, emit "upstream synced" with the commit
  count, request license re-evaluation, and re-run hygiene when the tracked branch changed.
- **FR-41.** Archived upstreams MUST pause scheduled sync; unreadable upstreams MUST pause it, emit "upstream
  unavailable" once, and be re-checked every 24 hours.
- **FR-42.** A missing Work Repository MUST stop every background job for the App Work, emit "fork missing" once
  and show a health warning.
- **FR-43.** When upstream's default branch was renamed, the sync MUST follow the new name, record it, and show it.
- **FR-44.** A linked App Work has no upstream: sync MUST NOT be offered and a sync request MUST be refused.
- **FR-45.** Private copies MUST refuse to sync once upstream exceeds 500 MB, and pause.

### 4.8 Divergence (P1)

- **FR-46.** The system MUST report commits ahead and behind upstream's default branch for forks, refreshed after
  every sync, when the App Work is viewed and the counts are older than 10 minutes, and at least daily.
- **FR-47.** For private copies the counts MUST come from the last sync run and carry its time; before any sync
  they are unknown.
- **FR-48.** "Upstream behind" MUST be emitted when behind changes from 0 to more than 0, and again each time it
  grows by 25 or more since the last emission.

### 4.9 Rate limits and budgets (P1)

- **FR-49.** One sync MUST make at most 20 provider calls, plus at most 100 workflow calls for hygiene.
- **FR-50.** When fewer than 300 requests remain in the member's budget, the run MUST be skipped until the reset
  plus 60 seconds.
- **FR-51.** Secondary rate limits MUST back off for the provider's retry time, else 60 seconds doubling to at most
  60 minutes; no request is retried sooner.
- **FR-52.** Three consecutive rate-limited runs MUST make the rate-limit notice persistent until a run succeeds.
- **FR-53.** The dispatcher MUST start at most 50 syncs per 10-minute tick.

### 4.10 Permissions, webhooks and scope (P1)

- **FR-54.** Every step MUST name the single permission it lacks: reading the repository, writing contents,
  opening pull requests, administering Actions, managing webhooks.
- **FR-55.** The system MUST be able to install and remove a signed webhook on an App Work's Work Repository
  (used by builds, APW-05), idempotently, and MUST NEVER install one on an upstream.
- **FR-56.** Every read and write MUST be scoped to the caller; another account's App Work answers not found.
- **FR-57.** Every user-visible string MUST be translatable; keys present in every locale file.
- **FR-58.** Telemetry MUST carry counts, durations, outcomes and reason codes — never repository names, file
  paths, commit messages or tokens.

### 4.11 The Upstream tab (P1)

- **FR-59.** Every App Work on a fork or private copy MUST have one **Upstream** tab at its own address, showing the
  relation to upstream, the readiness state (with **Try again** when timed out or failed), sync status and
  divergence, and the inherited-workflow state (Resolution R-8). Linked App Works and every other kind MUST NOT show
  it. The tab MUST leave room below its card for upstream pull requests (APW-09), which adds that section to the same
  tab rather than a second one.

### 4.12 Upstream automation, sync completion and the build workflow (added by the 2026-09-17 audit pass)

- **FR-60.** Before fast-forwarding a fork, and before creating or updating a sync pull request, the system MUST
  compare the incoming upstream range with the tracked branch and detect whether it touches `.github/workflows/**`.
  When it does, the system MUST NOT fast-forward, MUST NOT push that range onto `ever-works/upstream-sync` before the
  member confirms, and MUST show the hold with the changed workflow paths; confirming records one Activity entry
  with paths and counts only. This is what keeps a workflow nobody reviewed from running — and reading the App
  Work's own build values — inside the member's repository before the next hygiene pass could ever see it.
- **FR-61.** The values the platform writes for a Build MUST NOT be readable by any workflow other than the one the
  platform itself maintains on the tracked branch. Until that holds, FR-60's hold is the only thing standing between
  an upstream-added workflow and those values, so the hold MUST NOT be bypassed by the scheduled path, the manual
  path or a retry. (The scoping itself is APW-05's; this epic owns the hold and MUST record in the Upstream card
  when a sync was held for this reason.)
- **FR-62.** The system MUST detect that a sync pull request was merged and finish that sync: update the last-synced
  commit and the divergence counts, clear the pull request fields, re-run hygiene for the range and ask the license
  gate again — each exactly once per merged pull request, whether the detection comes from polling the open pull
  request or from the repository's pull-request delivery. A merged sync pull request counts as the sync having
  happened even though the branch never moved through a fast-forward.
- **FR-63.** A private copy's sync MUST be expressible with the platform's own capabilities: comparing a private
  copy against its upstream and moving the sync branch MUST NOT require the platform layer to shell out to git
  itself (Constitution I). The comparison MUST report the upstream head, how far ahead and behind the copy is, and
  whether the count was capped.
- **FR-64.** Sync MUST honour the App spec's own settings rather than its defaults: a schedule turned off in the
  spec MUST leave the next run unset (`disabled_by_spec`) while **Sync now** still works, and a configured sync
  branch MUST be the branch compared and merged. A spec change that touches those blocks MUST be picked up without
  waiting for the next scheduled run.
- **FR-65.** The readiness reasons, sync results and warning codes this epic reports MUST each be a closed set with
  one stable value per user-visible state, so a card, a test id and a translation key can be derived from the value
  itself; a provider-specific failure MUST be reported through the typed provider reason rather than a composed
  string.
- **FR-66.** When the provider reports that a fork's workflows are gated — the state a fresh fork of a repository
  that ships workflows starts in — the readiness job MUST enable **exactly** the Ever Works build workflow and no
  other, record that it did, and leave every other workflow disabled (FR-25, FR-26). Enabling is permitted for that
  one path only, because it is the platform's own workflow and the Build chain does not start without it.

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity           | Today                                                              | This epic adds                                                                                            |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Work**         | Work Repository coordinates; App Works carry an upstream (APW-01). | Nothing on the row; lifecycle lives in Upstream state.                                                    |
| **Task**         | Delegated work with labels and an assignee.                        | A conflict is an ordinary Task, one open per App Work.                                                    |
| **Activity**     | Records Work events.                                               | Fork ready, fork timeout, fork missing, Actions disabled, upstream synced, behind, conflict, unavailable. |
| **Work tabs**    | Overview, Tasks, Deploy and the other per-Work tabs.               | The **Upstream** tab for App Works on a fork or private copy (shared with APW-09).                        |
| **Pull request** | Opened by Tasks on the same repository.                            | The sync pull request on `ever-works/upstream-sync`.                                                      |

### 5.2 New

| Entity             | Why it must exist                                                                                                                                                                     | Shape                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream state** | Readiness, sync progress, divergence, hygiene and health change on their own schedule, are needed by five epics, and must survive restarts. None of it is content (Constitution III). | One per App Work: relation, data and upstream coordinates, readiness state and reason, divergence counts and time, sync schedule/next run/last result/pull request/conflict Task, Actions hygiene state and lists, upstream and repository health. |

### 5.3 States

```
 readiness:  preparing ──ready check ok──► ready
                │  └── 15 min / 3 lost jobs ──► timed_out ──Try again──► preparing
                └── access lost / copy refused ──► failed ──Try again──► preparing
             ready check ok ──setup needs a PR──► waiting_for_setup_pr ──merged──► ready
                                                         └──closed unmerged──► failed ──Try again──► (new setup PR)

 sync:  idle ─schedule / Sync now─► running ─┬► up_to_date
                                             ├► fast_forwarded
                                             ├► pull_request_opened / pull_request_updated
                                             ├► conflict ──► one Task (reused)
                                             ├► skipped (rate limited, license worse → PR instead)
                                             └► paused (archived · unavailable · repository missing · too large)
```

## 6. UX

All copy below is final English copy, keyed for translation. For forks and private copies, the **Upstream** tab
(Resolution R-8 — one tab, created by this epic; APW-09 adds its "Upstream pull requests" section below the card)
shows the card with its relation and readiness rows in every readiness state; the same card also sits on the App
Work's Overview, under the preparing card APW-01 owns, once the App Work is ready or waiting for its setup pull
request.

### 6.1 Upstream card

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Upstream   acme/tasks-app ↗                          [ Sync now ]           │
│  Fork of acme/tasks-app · Ready                                              │
│  ⬇ 12 commits behind upstream · Checked 6 minutes ago                        │
│  Last synced 3 days ago · Next sync Mon 06:03 UTC                            │
│  Opened a pull request to sync 12 commits  →  #41                            │
│  ⚙ 6 inherited workflows disabled   [ Show ]                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Element                     | Copy                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab name                    | `Upstream`                                                                                                                                      |
| Title                       | `Upstream`                                                                                                                                      |
| Relation                    | `Fork of {upstream}` · `Private copy of {upstream}`                                                                                             |
| Readiness                   | `Preparing` · `Ready` · `Waiting for the setup pull request` · `Timed out` · `Failed` — with `Try again` on the last two                        |
| Sync button / pending       | `Sync now` · `Syncing…`                                                                                                                         |
| Sync limit reached          | `You've synced 6 times this hour. Try again at {time}.`                                                                                         |
| Already running             | `A sync is already running.`                                                                                                                    |
| Up to date                  | `Up to date with upstream`                                                                                                                      |
| Behind                      | `{count, plural, =1 {1 commit behind upstream} other {# commits behind upstream}}`                                                              |
| Ahead and behind            | `{ahead} ahead, {behind} behind upstream`                                                                                                       |
| Ahead only                  | `{count, plural, =1 {1 commit ahead of upstream} other {# commits ahead of upstream}}`                                                          |
| Unknown                     | `Divergence unknown`                                                                                                                            |
| Checked                     | `Checked {ago}`                                                                                                                                 |
| Last synced / never         | `Last synced {ago}` · `Not synced yet`                                                                                                          |
| Next sync                   | `Next sync {when}`                                                                                                                              |
| Result: up to date          | `Already up to date`                                                                                                                            |
| Result: fast-forwarded      | `{count, plural, =1 {Synced 1 commit from upstream} other {Synced # commits from upstream}}`                                                    |
| Result: PR opened / updated | `Opened a pull request to sync {count} commits` · `Updated the sync pull request ({count} commits)`                                             |
| Result: license worse       | `Upstream changed its license to {spdx}. Review the pull request before merging.`                                                               |
| Result: conflict            | `Conflicts need resolving — a Task was created.` · `Open the Task`                                                                              |
| Result: failed              | `Sync failed: {reason}`                                                                                                                         |
| Workflows disabled          | `{count, plural, =1 {1 inherited workflow disabled} other {# inherited workflows disabled}}`                                                    |
| Workflows list toggle       | `Show` · `Hide`                                                                                                                                 |
| Workflows note              | `Workflows added later — by an upstream sync or a pull request — are switched off after each sync. Turn one on in GitHub only if you trust it.` |
| Workflows changed (hold)    | `Upstream changed its workflows. Review and confirm before syncing.` · `Review the changes` · `Sync anyway`                                     |

### 6.2 Warnings (shown in the card and as a Work health warning)

| State                    | Copy                                                                          | Action                      |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------- |
| Upstream archived        | `Upstream is archived — sync is paused.`                                      | —                           |
| Upstream unavailable     | `Upstream {repo} is no longer reachable. Sync is paused.`                     | `Check again`               |
| Fork missing             | `Your fork {repo} no longer exists on GitHub.`                                | `Open on GitHub`            |
| Private copy missing     | `Your private copy {repo} no longer exists on GitHub.`                        | `Open on GitHub`            |
| Rate limited             | `GitHub rate limit reached — sync will retry at {time}.`                      | —                           |
| Default branch renamed   | `Upstream's default branch changed from {old} to {new}.`                      | —                           |
| Too large (private copy) | `Upstream is now too large to sync into a private copy ({size}).`             | —                           |
| History rewritten        | `Upstream rewrote its history. Close the sync pull request, then sync again.` | `Open pull request`         |
| Needs admin              | `You need admin access to {repo} to switch off its workflows.`                | `Open on GitHub`            |
| App permission missing   | `The Ever Works GitHub App needs the {permission} permission on {repo}.`      | `Review GitHub App access`  |
| Not ready (clone)        | `The repository isn't ready yet.`                                             | —                           |
| Workflows gated          | `GitHub hasn't run workflows in this fork yet.`                               | `Enable the build workflow` |

Permission names rendered in `{permission}`: `Contents`, `Pull requests`, `Administration`, `Actions`, `Webhooks`.

### 6.3 Conflict Task (created by the system)

| Field             | Content                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title             | `Resolve upstream sync conflicts in {repo}`                                                                                                                                                                                                                                                       |
| Description       | `Upstream {upstream} moved from {fromSha} to {toSha} ({count} commits). The sync pull request {prUrl} can't merge because these files conflict:` followed by up to 50 paths, one per line, then `Resolve the conflicts on ever-works/upstream-sync and push. Don't merge into {branch} directly.` |
| Comment on update | `Upstream moved again: now {toSha} ({count} commits since the last sync).`                                                                                                                                                                                                                        |

### 6.4 Keyboard and accessibility

`Sync now` is a button reachable by `Tab` and fires on `Enter`/`Space`; the badge's counts and the checked time
are text; warnings are announced as status messages, not conveyed by colour.

## 7. Out of scope

- Opening pull requests **to** the upstream (APW-09); rebase-mode sync; merging sync pull requests automatically
  (merge policy stays human by default, D11).
- Webhooks from upstream repositories (GitHub sends none to third parties); webhook-driven divergence refresh.
- Git LFS for private copies; GitLab, Bitbucket and self-hosted Git.
- Migrating or deleting working copies created before P0.
- A UI to choose which inherited workflows stay enabled (members use GitHub; FR-27 respects their choice).

## 8. Acceptance criteria

Each item is an acceptance scenario collected into [ACCEPTANCE.md](../ACCEPTANCE.md) under its id.

- [ ] **ACC-02-01** — Two distinct owner/repository pairs whose normalized names collide resolve to two different
      working copies, and checkout-keyed copies never equal repository copies; removing one leaves the others (S10,
      FR-1…FR-6).
- [ ] **ACC-02-02** — An expected-to-exist clone of an empty or missing repository fails "not ready" and leaves no
      directory; a normal clone keeps today's behaviour (S19, FR-7…FR-9).
- [ ] **ACC-02-03** — A fork request finds an existing renamed fork with no name given; a same-named non-fork is
      never returned; the non-waiting mode answers within 10 seconds; template forks still wait (S2, FR-10…FR-13).
- [ ] **ACC-02-04** — Readiness stays preparing on an empty default branch and becomes ready within 30 seconds of the
      first commit, running setup once (S1, FR-17, FR-22).
- [ ] **ACC-02-05** — Timeout at 15 minutes emits one timeout; Try again resumes without a new fork and is limited
      to 3 per hour; a deadline override shortens it only outside production (S11, FR-18, FR-18a, FR-19).
- [ ] **ACC-02-06** — Access revoked while preparing ends in failed `access_revoked`; Try again after reconnecting
      completes (S12, FR-20).
- [ ] **ACC-02-07** — A lost readiness job is restarted within 10 minutes, at most 3 times (S27, FR-23).
- [ ] **ACC-02-08** — Hygiene disables inherited workflows except the build workflow, never switches Actions off,
      leaves member-re-enabled workflows on, and records lists and one Activity entry (S3, S18, FR-25…FR-31).
- [ ] **ACC-02-09** — A behind-only fork is fast-forwarded and records "upstream synced" with the count (S4, FR-35, FR-40).
- [ ] **ACC-02-10** — A diverged fork gets one reusable sync pull request and nothing is merged; a rewritten upstream
      history is never force-moved (S5, S17b, S26, FR-36, FR-39).
- [ ] **ACC-02-11** — A conflicting sync creates exactly one Task whose Agent comes from the evolve loop's
      change-Agent rule (unassigned with an owner notification when none resolves); a later conflict comments on it;
      no force push ever occurs (S6, S24, S25, FR-38, FR-39).
- [ ] **ACC-02-12** — A worse upstream license turns a fast-forward into a pull request with the license note (FR-37).
- [ ] **ACC-02-13** — Divergence counts render with their age and refresh when older than 10 minutes (S7, FR-46).
- [ ] **ACC-02-14** — Sync now returns within 2 seconds; a concurrent sync is refused; the 7th manual sync in an hour
      is refused (S8, S23, FR-33, FR-34).
- [ ] **ACC-02-15** — A private copy is created with full default-branch history and synced through a pull request;
      over 500 MB it pauses (S9, S22, FR-21, FR-45).
- [ ] **ACC-02-16** — Rate limits skip runs until reset + 60 s, back off on secondary limits, and become persistent after
      3 runs (S16, FR-49…FR-53).
- [ ] **ACC-02-17** — Archived and unavailable upstreams pause sync with their copy; unavailable re-checks daily and
      resumes (S13, S14, FR-41).
- [ ] **ACC-02-18** — A deleted fork stops all jobs and shows the missing warning once (S15, FR-42).
- [ ] **ACC-02-19** — A renamed upstream default branch is followed and shown (S17, FR-43).
- [ ] **ACC-02-20** — Missing admin or App permission names the permission and never blocks sync (S20, S21, FR-30, FR-54).
- [ ] **ACC-02-21** — Another account's App Work answers not found on every upstream route (S28, FR-56).
- [ ] **ACC-02-22** — An App Work waiting for its setup pull request becomes ready once it is merged (setup
      follow-ups exactly once), and shows failed `setup_pull_request_closed` with Try again when it is closed unmerged;
      the check never merges or edits the pull request (S1b, FR-24a).
- [ ] **ACC-02-23** — A fork or private copy App Work has one Upstream tab showing relation, readiness (Try again when
      timed out or failed), sync status and inherited workflows; a linked App Work and other kinds have none (S10b,
      FR-59).
- [ ] **ACC-02-24** — An upstream range that adds or edits a workflow file is never fast-forwarded and never pushed
      onto the sync branch before the member confirms; the card shows the hold with the changed paths; confirming
      records one entry with paths and counts only (S29, FR-60, FR-61).
- [ ] **ACC-02-25** — A fork carrying the platform's own `source` commit is never fast-forwarded; the divergence
      reading after readiness is `aheadBy ≥ 1` and the sync takes the pull-request path (S4, S5, FR-35, FR-36).
- [ ] **ACC-02-26** — A merged sync pull request is detected within one dispatcher tick, updates the last-synced
      commit and the divergence counts exactly once, clears the pull-request fields, re-runs hygiene and asks the
      license gate again (S30, FR-62).
- [ ] **ACC-02-27** — A private copy's divergence and sync branch are produced through the plugin capability, with no
      direct git invocation in the platform layer; the comparison reports the upstream head, ahead/behind and whether
      the count was capped (S9, FR-63).
- [ ] **ACC-02-28** — A spec whose sync schedule is off leaves the next run unset while **Sync now** still works; a
      configured sync branch is the branch compared and merged; a spec change to either block is picked up without
      waiting for the next scheduled run (FR-64).
- [ ] **ACC-02-29** — Every readiness reason, sync result and warning code is one member of its closed set, and a
      provider failure carries the typed provider reason rather than a composed string (FR-65).
- [ ] **ACC-02-30** — On a fork whose workflows are gated, readiness enables exactly the Ever Works build workflow,
      records it, leaves every inherited workflow disabled, and the first Build starts (S31, FR-66).

## 9. Open questions

- **Resolved (Resolution R-21): who resolves conflicts by default?** The conflict Task's Agent comes from APW-08's
  change-Agent rule; when none resolves, the Task stays unassigned and the owner is notified. A nominated default
  Agent, if ever added, belongs to APW-08.
- **[NEEDS CLARIFICATION: merge a clean diverged sync directly?]** GitHub can merge upstream into a diverged fork in
  place. This spec always opens a pull request so builds and deploys follow review. Offer an opt-in?
- **[NEEDS CLARIFICATION: minimum schedule.]** Hourly is the floor to protect the member's API budget. Lower for
  paying accounts?
- **[NEEDS CLARIFICATION: hygiene on linked repositories.]** Off by default (the member's own workflows). Offer it?
- **[NEEDS CLARIFICATION: must an upstream update be reviewed before it goes live?]** The 2026-09-17 audit raised
  this: a fast-forward lands upstream's commits on the tracked branch, APW-05 builds that push and APW-06 deploys
  it, so a compromised upstream release can be live within one sync tick with no human in the loop — against
  **agents open pull requests, humans merge** (README D11). FR-60/FR-61 now hold automatic syncs whenever the
  incoming range touches workflows, but the general question is the owner's: should every upstream update reach a
  running app only after the member approves it, with per-App-Work **Upstream updates: open a pull request
  (default) | fast-forward automatically** as the setting, or should a Build whose commits came from an upstream
  sync stay undeployed until the owner approves it? Until the owner answers, the default stays as specified here
  and nothing in this epic auto-deploys an unreviewed upstream change that touches automation.
