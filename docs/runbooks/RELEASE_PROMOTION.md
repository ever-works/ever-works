# Release promotion lane — `develop → stage → main`

Self-build slice AI (EW-808), epic EW-762. Closes finding R20.

Companion to [`MERGE_APPROVAL.md`](./MERGE_APPROVAL.md), which this lane
reuses wholesale for landing, and to
[`FLEET_BREAK_GLASS.md`](./FLEET_BREAK_GLASS.md), whose manual `gh pr create`
cascade this replaces for the platform's own repository.

---

## 1. What this fixes

Once a pull request merged to `develop`, the work stopped. Nothing opened
the two promotion pull requests the house release flow requires; there was
no promotion Task kind and no code path anywhere that opened a
`develop → stage` or `stage → main` pull request. The platform's own deploy
surface could not help either — a Repository Work is explicitly
non-deployable and is refused before a provider resolves.

The lane makes promotion **possible and legible**. It does not make it
automatic, and the rest of this document is mostly about that distinction.

---

## 2. What a promotion Task does

1. **Opens ONE pull request**, from the branch the Work's release ladder
   names to the branch the ladder names. Nothing about which branches is
   taken from the caller.
2. **Waits on `promotion-gate.yml`** for the pull request's head commit and
   records what it said, stamped with the commit it was about.
3. **Reports each stage into the Task** (its chat thread) and **files ONE
   Inbox item** per head commit, so a human can see the gate result and
   decide.

The Task is filed `in_review` with the labels `release:promotion` and
`release:promotion:<rung>`, priority P1, bound to the Work and to the Agent
you named.

## 3. What it will NEVER do on its own

- **It will never merge.** `ReleasePromotionService` contains no merge call
  at all — asserted by a test that reads its own source. Landing a
  promotion pull request goes through the SAME path as every other agent
  merge: a `merge_pull_request` proposal in your Inbox, decided by a real
  human identity, re-verified against the live head commit at merge time.
  All twelve merge-time conditions in `MERGE_APPROVAL.md` apply unchanged.
- **It will never cascade.** Merging the `develop → stage` promotion frees
  the lane and stops. Opening `stage → main` is a separate, separately
  approved act that you perform when you are ready. There is no
  "next rung" function anywhere in the contracts, and a test fails if one
  appears.
- **It will never widen the merge gate.** The promotion guard can only ever
  say NO. A promotion whose gate is anything other than an explicit
  `success` is refused before an approval is even raised.

Why: the stage e2e gate has been unreliable for weeks, and a bad promotion
is a multi-hour outage on a build lane measured at **215–243 minutes**. Two
promotions is most of a working day. The decision is yours, per batch,
after reading the end-to-end verdict.

---

## 4. Setting the lane up (once per Work)

The ladder is **platform state**, declared once by the Work's owner:

```
PUT /api/works/:workId/release-ladder
{ "integration": "develop", "staging": "stage", "production": "main" }
```

Rules, all fail-closed:

- Three **distinct** branch names. `develop → develop` is not a promotion.
- Plain names only: no `..`, no leading `-` or `/`, no whitespace, no
  `~^:?*[\`, no trailing `/` or `.lock`, max 128 characters. A branch name
  ends up as a pull request's `head`/`base`.
- A Work with **no ladder has no lane**. `POST …/promotions` refuses with
  `ladder-not-configured` rather than guessing `main`.

`GET /api/works/:workId/release-ladder` reads it back — through the
sanitiser, not raw.

---

## 5. Running a promotion

```
POST /api/works/:workId/promotions
{ "rung": "develop-to-stage", "agentId": "<an Agent you own>" }
```

`rung` is the only choice you make. It is a closed enum — there is no
`develop-to-main`, because skipping `stage` is the mistake the lane exists
to make hard.

`agentId` must be an Agent **you own**: the Inbox merge approval this Task
will later raise is decidable only by the proposal's own owner, and
`TasksService.create` refuses an Agent that is not yours.

### Responses

| Result                                           | Meaning                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `201` `{ outcome: "opened", promotion, taskId }` | The pull request is open and the Task is filed.                                             |
| `409` `{ message, promotion }`                   | A promotion for this rung is **already open**. Not a new one — the live one is in the body. |
| `400` `{ code, message }`                        | Refused. See the codes below.                                                               |
| `404`                                            | The Work does not exist, or is not yours. Same words for both.                              |

### Refusal codes at open time

| Code                                          | What happened                                                                          | What to do                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ladder-not-configured`                       | No ladder, or one that is not three distinct plain branch names.                       | `PUT …/release-ladder` first.                                                          |
| `head-branch-missing` / `base-branch-missing` | The ladder names a branch the repository does not have.                                | Fix the ladder, or create the branch.                                                  |
| `head-sha-unknown`                            | The branch tip could not be read (often a token without repo scope).                   | Fix credentials; nothing was created.                                                  |
| `no-git-provider`                             | No git provider wired in this deployment.                                              | Deployment problem, not a lane problem.                                                |
| `pull-request-failed`                         | The provider refused (commonly "no commits between" — the branches are already level). | Nothing to promote, or read the provider error.                                        |
| `branches-not-as-claimed`                     | The provider opened a pull request between DIFFERENT branches than we asked for.       | **The pull request is disowned. Close it by hand.** Nothing in the lane will merge it. |
| `promotion-not-recorded`                      | The pull request IS open on the provider, but the platform could not record it.        | Retry. The retry **adopts** the open pull request rather than opening a second one.    |

Every refusal frees the lane, so a retry is a clean retry — including the
crash window between claiming the lane and binding the pull request: an
`open` row with no `prNumber` older than ten minutes is wreckage nothing
else can free, and the next claimant retires it. A refusal that happens
_after_ the Task was filed **cancels that Task** and leaves the reason on
its chat thread. That matters: a promotion-labelled Task sitting in
`in_review` with no pull request behind it is indistinguishable on the board
from a real promotion, and each retry would add another.

### The pull request that is already open

The founder performs this promotion by hand today, so an open
`develop → stage` is the normal state of the world the first time the lane
runs — and GitHub answers a second request for the same pair with a 422.
`openPromotion` therefore **looks for the open `head → base` pull request
first and adopts it**, exactly as `openPullRequestForBranch` already does
for Task branches. A pull request between other branches is never adopted.

### The head the promotion reports

The branch tip is read before the lane is claimed (so a missing branch
refuses before anything exists), but the commit the promotion **reports** is
read back from the pull request itself once it exists. Two merges to
`develop` seconds apart would otherwise have the lane publish a commit that
is not what gets promoted. If that read-back fails, the branch tip is used
and the Task thread says so.

### What is NOT written to the Task

`task.branchRef` is deliberately left NULL. It is the slot the platform
treats as a **disposable task branch**: `DELETE /api/tasks/:id/branch` and
the nightly branch-GC sweep both hand it to `gitFacade.deleteBranch`, and an
agent run provisions its workspace onto it. A promotion owns no branch — it
moves two that already exist — so writing `develop` there would aim the
branch reaper at the integration branch. The pull request is bound through
`prNumber`, which is what `findDuePrStatusSync` selects on.

---

## 6. Watching a promotion

The promotion is refreshed on the same two-minute `task-pr-status-sync`
sweep that drives every other Task's pull request, and immediately on
`GET /api/tasks/:id/pr-status?refresh=true`.

The promotion is identified by its **row**, keyed on `taskId` — never by
the Task's labels. Labels are free-form and any owner can rewrite them
through `PATCH /api/tasks/:id`; keying the lane on them meant one request
could freeze a live promotion and disarm its gate while the row still said
`open`. Labels survive only as the fail-closed answer for a Task that
claims to be a promotion with no row behind it.

Each refresh, in order:

1. **Refuses if the Task's pull request has been rebound**
   (`pull-request-rebound`) — the status being read must be the promotion's
   own pull request, or every step below would be about someone else's.
2. Re-reads the pull request and **refuses if the branches moved**
   (`branches-moved`) — the promotion must be for the branches it claims.
3. Adopts a new head if the branch advanced, and **drops the recorded gate
   verdict**. A verdict is about a commit. Any human approval dies with it
   automatically, because the approval subject key contains the head SHA.
4. Reads `promotion-gate.yml` for that exact commit and records the verdict.
   A run that names pull requests **not including this one** is treated as
   `absent`: a run is keyed by commit, and one commit can head more than one
   pull request.
5. Reports a **change** into the Task thread (never a repeat — the change is
   the database's own answer to "did this row differ?", so two replicas
   cannot both narrate it), and files the one Inbox item.

`GET /api/works/:workId/promotions` lists the history, newest first.

### The gate verdicts, and which one is a pass

**Only `success` is a pass.** Every other reading — including "cannot
tell" — is not.

| Verdict      | Meaning                                                                             | Pass?   |
| ------------ | ----------------------------------------------------------------------------------- | ------- |
| `success`    | The run completed and concluded `success`.                                          | **YES** |
| `failure`    | It ran and failed (`failure`, `timed_out`, `action_required`).                      | no      |
| `pending`    | A run exists and has not finished.                                                  | no      |
| `cancelled`  | Somebody stopped it. There is no verdict and none is coming.                        | no      |
| `skipped`    | It finished without evaluating (`skipped`, `neutral`, `stale`).                     | no      |
| `absent`     | No run of that workflow exists for that commit.                                     | no      |
| `unreadable` | The lookup failed, or the provider cannot answer. **A broken gate, not a verdict.** | no      |

Two of these deserve emphasis, because the platform's ordinary CI roll-up
gets them wrong:

- **`skipped` renders GREEN in branch protection.** `deriveCiState` treats
  `skipped`, `neutral`, `stale` and `cancelled` as non-blocking — correct
  for the board's CI dot, unusable as a release gate. The lane reads the
  named workflow's own run instead, and refuses all four.
- **`absent` is invisible in a roll-up.** A commit with other green checks
  rolls up `passing` while the gate never ran at all.

`pending`, `absent` and `unreadable` do not raise an Inbox item until they
have stayed that way for **20 minutes** (past `node-contract`'s own budget
plus queue time). A run does not exist the instant a pull request opens.

The one Inbox item is keyed on **(commit, reading)**, not on the commit
alone. `pending` past twenty minutes is routine on this gate, and keyed on
the commit alone that first post-grace reading consumed the slot and the
verdict that actually decided the promotion — including a FAILURE — was
never filed. Every undecided reading shares one token (`stuck`), so a
`pending → unreadable → pending` flap is still one item; each decided
verdict gets its own.

### What a green gate actually means, per rung

`promotion-gate.yml` runs on pull requests into **both** `stage` and `main`
(slice AI widened it; before, the first rung had no verdict at all). But the
two rungs get different coverage, and conflating them is dangerous:

| Rung              | `e2e-result`                                  | `node-contract` | A `success` means                                                                                    |
| ----------------- | --------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `develop → stage` | **skips** (its `if:` requires a `stage` head) | runs            | **the node contract held, and nothing more**                                                         |
| `stage → main`    | runs                                          | runs            | stage's e2e result was green, or a human applied `override-e2e-gate`, **and** the node contract held |

The first rung genuinely has no e2e signal: `e2e.yml` runs on push to
`develop` only, so the `develop → stage` pull request shows zero e2e shards
**by design**. The first e2e result for a batch arrives on `stage`, which is
what the second rung gates on. **Do not read a green `develop → stage`
promotion as "e2e passed".**

Because the two rungs differ, the Inbox item **says which legs actually
evaluated**. A `develop → stage` notice reads "the node wire contract ONLY
… NO end-to-end result was consulted here"; a `stage → main` notice names
both. The operator deciding a release reads the Inbox item, not this
runbook.

### The override

`override-e2e-gate` is a real, attributable, visible-in-the-timeline escape
on the `e2e-result` job, and it is used. `node-contract` has no override at
all.

The workflow exits 0 on the label in **all four** of its failure branches —
a broken lookup, no run found, a run still going, and a red run — and
GitHub then folds the whole thing back into a plain `success` run
conclusion. Read from the run alone, "the E2E was green" and "somebody with
repository write applied a label" are byte-for-byte identical.

So the lane reads the label off the pull request beside the run, records it
(`release_promotions.gateOverridden`, surfaced as `gate.overridden` on the
API read model), and **says so in the words the human reads**: the Inbox
title becomes `Promotion gate PASSED — E2E WAIVED, not green — for …` and
the body carries a `WAIVED, NOT GREEN` line naming the label. Applying the
label to a red gate therefore files a SECOND Inbox item rather than being
swallowed as "we already told them about this commit".

It does **not** change the verdict: an overridden run still has to conclude
`success` before anything is offered for merge, and refusing a documented
escape hatch would only get the lane routed around within a week. What
changes is that the override can no longer be laundered into an unqualified
pass.

---

## 7. Landing a promotion

Nothing here is new. On the refresh after the gate goes `success`, and only
if the pull request is open, its CI roll-up is `passing`, its check read was
complete, and the promotion guard allows it:

1. `TaskMergeGateService` raises a `merge_pull_request` proposal bound to
   `merge:<taskId>:<prNumber>:<headSha>`.
2. It appears in your Inbox as
   `Merge PR #N into stage in ever-works/ever-works for T-9 (@ <sha12>)`,
   with Approve / Reject. **"Approve all" cannot approve it** — a merge is
   decided one pull request at a time.
3. You approve. On the NEXT refresh (≈2 minutes, or immediately with
   `?refresh=true`) the merge is attempted, pinned to the head commit you
   approved.
4. `GitFacadeService.mergePullRequest` re-verifies the approval, re-reads
   live provider state, and applies the merge policy matrix before touching
   the provider.

Then the promotion goes `merged`, the lane is freed, and **that is the end
of it**. If you want `stage → main`, you open it — after reading the
end-to-end verdict.

### Every path that could reach a promotion merge

| Path                                                                    | Gated by                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskMergeGateService` on a PR-status refresh (cron or `?refresh=true`) | promotion guard → gate `success` for the live head AND for the promotion's own pull request; then the full slice-AE approval + `GitFacadeService.mergePullRequest` re-verification                                                                                                                                                                                                                  |
| The same, under a policy with `requireHumanApproval: false`             | **A promotion always takes the approval path anyway.** `requireHumanApproval: false` is a legitimate operator choice for ordinary agent work and is not a choice about releases; the gate raises the proposal regardless, and `attemptMergeForOpenPullRequest` also RAISES the requirement inside the facade so the property does not rest on one branch. Ordinary Tasks are unaffected.            |
| A deployment where the promotion guard is not bound                     | `TaskMergeGateService` recognises a promotion Task off its own labels and **stands down** — the refusal does not depend on the missing service                                                                                                                                                                                                                                                      |
| Running the promotion Task with an agent (`POST /api/tasks/:id/run`)    | The run pushes a Task branch (never `develop`/`stage` — `branchRef` is NULL on a promotion) and opens its OWN pull request, replacing `tasks.prNumber`. The next refresh sees `status.number !== promotion.prNumber` and **refuses the promotion** (`pull-request-rebound`), freeing the lane; the guard independently refuses with `promotion-pull-request-mismatch`. Neither pull request merges. |
| Stripping the promotion labels off the Task (`PATCH /api/tasks/:id`)    | Nothing changes. Both the watcher and the guard resolve the promotion by its **row**, keyed on `taskId`; the labels are consulted only when no row resolves, and then only to refuse.                                                                                                                                                                                                               |
| Anything else                                                           | There is nothing else. `ReleasePromotionService` has no merge call, the controller has no merge route, and the guard has no verdict that permits a merge the ordinary path would refuse.                                                                                                                                                                                                            |

There are exactly two entries into `TaskWorkspaceService.attemptMergeForOpenPullRequest`,
both inside `TaskMergeGateService`, and both sit behind the promotion guard.
There is exactly one `gitFacade.mergePullRequest(...)` call in the whole
platform. Grep for either if you want to re-verify this table.

**The branch the approval names is the branch that gets merged into.** A
promotion carries its own `baseBranch` through the guard verdict into both
the `merge_pull_request` proposal title (`Merge PR #N into main in …`) and
the merge policy's `targetBranch`. Every other Task pull request still uses
the Work's `taskIsolationBaseBranch`, exactly as before. This is not
cosmetic: `GitFacadeService` uses `targetBranch` verbatim and only reads the
pull request's real base when it is absent, so a promotion reported as
targeting `develop` would have `protectedBranches` evaluated against a
branch it is not merging into — and an operator who removes `develop` from
`protectedBranches` so Task pull requests can land there would silently
unprotect `main` for promotions at the same time.

Note also the platform default: `PLATFORM_DEFAULT_MERGE_POLICY` has
`allowAgentMerge: false` and `protectedBranches: ['main','master','develop','stage']`.
Out of the box the platform will therefore raise the approval and then
refuse the merge with `agent-merge-disabled` (or `protected-branch` if
agent merges are enabled but the branch is still protected). That is a
**policy configuration** decision, not a lane defect: an operator who wants
the platform to land its own promotions must widen the policy for that
scope deliberately, and it is still an approval-per-merge.

---

## 8. Duplicates and races

At most **one open promotion per (Work, rung)**, enforced by a UNIQUE
database index on `(workId, rung, laneKey)` rather than by a read-then-write.

- Two merges to `develop` seconds apart → one pull request; the loser is
  told `already-open`.
- The cron worker racing an operator's retry → same.
- Re-running the request → same.
- The OTHER rung may be open at the same time. Different Works never
  collide.

`laneKey` carries the constraint as a value (`'open'` while live,
`'<state>:<id>'` once terminal) because Postgres can express a partial
unique index and better-sqlite3 — which CI and the e2e stack run — cannot,
and a constraint that behaves differently on the two databases is a race
that only reproduces in production.

---

## 9. Where to look when something is wrong

| Symptom                                                         | Where                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "It opened nothing."                                            | The `400`/`409` body. Every refusal has a code and frees the lane.                                                                                                                                                      |
| "The gate says absent forever."                                 | Is `promotion-gate.yml` on the head branch? It has to exist on the commit being promoted.                                                                                                                               |
| "The gate says unreadable."                                     | Token scope: reading workflow runs needs `actions:read`. A broken lookup never reports as `absent`.                                                                                                                     |
| "It went green but nothing merged."                             | Expected. Check your Inbox for the merge approval. Then check the merge refusal recorded on the Task (`mergeRefusedCode`) — most likely `agent-merge-disabled` or `protected-branch` under the platform default policy. |
| "It merged and nothing happened next."                          | Also expected. The next rung is yours to open.                                                                                                                                                                          |
| "Two pull requests."                                            | Shouldn't be possible via the lane. Check whether one was opened by hand, or disowned with `branches-not-as-claimed`. A pull request opened by hand for the same `head → base` is ADOPTED, not duplicated.              |
| "Every retry says `already-open` and there is no pull request." | The claim/bind crash window. The row retires itself after ten minutes with no `prNumber`; retry after that, and the retry adopts any pull request that did get opened.                                                  |
| "The Inbox says PASSED but the e2e was red."                    | Read the title. An overridden gate reads `PASSED — E2E WAIVED, not green`, and `gate.overridden` is `true` on `GET …/promotions`. A `develop → stage` notice also names the legs — that rung has no e2e signal at all.  |

Deploy, after `stage → main` lands: `k8s-build` → ghcr `:prod` → ArgoCD.
It queues rather than cancels and is measured at 215–243 minutes. Plan the
outage around that number.

---

## 10. Files

| Concern                                     | File                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ladder, rungs, labels, lane key             | `packages/contracts/src/release/promotion.types.ts`                                                                           |
| Gate verdict vocabulary + the one pass rule | `packages/contracts/src/release/promotion-gate.types.ts`                                                                      |
| Provider capability                         | `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` (`getWorkflowRunForCommit`)                            |
| GitHub implementation                       | `packages/plugins/github/src/github-api.service.ts`                                                                           |
| Facade seam                                 | `packages/agent/src/facades/git.facade.ts`                                                                                    |
| The lane                                    | `packages/agent/src/tasks-domain/release-promotion.service.ts`                                                                |
| The extra refusal                           | `packages/agent/src/policy/promotion-merge-guard.port.ts`                                                                     |
| Storage                                     | `packages/agent/src/entities/release-promotion.entity.ts`, `apps/api/src/migrations/1790000000000-CreateReleasePromotions.ts` |
| Operator surface                            | `apps/api/src/release/`                                                                                                       |
| The workflow                                | `.github/workflows/promotion-gate.yml`                                                                                        |
