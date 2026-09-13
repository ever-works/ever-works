---
id: ci-auto-resume
title: CI feedback and the autonomous fix loop
sidebar_label: CI Auto-Fix
---

# CI feedback and the autonomous fix loop

An Agent opens a pull request. Two minutes later the build goes red. Until this feature existed, that was where the platform stopped: the check result never became an event, nothing dispatched on it, and the run sat finished until a person noticed and pressed **Resume**.

Now the red build is the signal. The platform ingests the provider's own check results, attaches the failing output to the Task, and resumes the run that opened the pull request — **under a hard, durable retry budget**, and with an Inbox notice when that budget is spent.

:::warning This feature spends money
Every automatic retry is a full Agent run: the same order of model spend as the run that opened the pull request in the first place. The default budget is **2 attempts per Task, for the Task's whole life** — not per push, not per day. Set `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS=0` to switch the fix loop off entirely; the check results are still ingested and the board still shows the red dot.
:::

## What arrives, and what it becomes

Subscribe the GitHub App (or the repository webhook) to **Check runs**, **Check suites** and **Workflow runs** — see [Connect integrations](../guides/connect-integrations.md). Deliveries ride the existing GitHub receiver, so they are signature-verified and attributed to an account exactly like pull requests are.

| Delivery       | Becomes                                                                                | Carries                                                                               |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `check_run`    | a `github.check` event, identity `check:<repo>@<sha>:run:<id>:<status>[:<conclusion>]` | the per-job **output** (`title`, `summary`) — the only failing text a webhook carries |
| `check_suite`  | a `github.check` event, identity `…:suite:<id>:…`                                      | the aggregate verdict; no per-job output and no page link                             |
| `workflow_run` | a `github.check` event, identity `…:workflow:<id>#<attempt>:…`                         | the run attempt counter, which is what tells a re-run from a redelivery               |

Every one routes to a Work through the repository (`workHint: repo`), so an [inbound trigger](inbound-triggers.md) can match `{ "source": "github", "kind": "github.check" }` with no extra wiring.

The identity is the whole dedupe story. A byte-identical **redelivery** produces the same id and dedupes to nothing; a **re-run** of the same commit produces a new id, because a re-run is a genuinely new result.

Only **completed** results are ingested. A job announcing itself as `queued` or `in_progress` carries no verdict anything can act on, and it is roughly half of everything a provider sends — a fifteen-job matrix announces three states per job, and the suite and workflow events restate every transition. Each stored event costs an activity-feed row and, where a memory provider is configured, a paid embedding, so the intermediate states are dropped at the edge. Every completed verdict — red, green and inconclusive — is still stored, so the board and inbound triggers see all of them.

### Onto the Task

Two Task columns are written from these deliveries rather than from the two-minute [PR status poll](tasks.md):

- **`ciHeadSha` / `ciHeadSeenAt`** — the head commit CI last reported against. This is what makes "is this result for the commit we still care about?" answerable; before it, the platform stored the branch's _base_ commit and nothing else. The [PR status poll](tasks.md) writes the same pair from the pull request's own head, through the same compare-and-set, so the two writers cannot clobber each other.
- **`ciState`** — written **red only**. A single green check is not a green gate; only the poll, which sees every check at once, may write `passing`. Red beats everything, and the loop never reports green early.

## What counts as red

Exactly what the board's CI dot counts as red: `failure`, `timed_out`, `action_required`, and (for workflow runs) `startup_failure`.

`cancelled`, `neutral`, `skipped` and `stale` are **not** failures — a human stopping a job, or a job that decided it had nothing to do, is not something to spend a model run fixing. A check that has not completed is never actionable whatever its conclusion field says, and a completed check with no conclusion at all is treated as unsettled rather than as a pass.

## The retry budget

|                         |                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **Setting**             | `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS`                                                                   |
| **Default**             | `2`                                                                                                  |
| **Range**               | `0`–`5` (`0` = the fix loop is off; an unparseable value falls back to the default)                  |
| **Scope**               | per **Task**, for the Task's whole life                                                              |
| **Cost of one attempt** | one `agent-task-execute` run — the same order of model spend as the run that opened the pull request |
| **Shared with**         | the reviewer-rejection path below; both spend the same budget                                        |

Two, because the first retry catches the ordinary case — a lint slip, a missing import, a snapshot the Agent forgot to update — and the second catches "the fix was almost right". A third has in practice meant the Agent does not understand the failure, and paying a third run to find that out is worse than filing the notice one run earlier.

**The budget is rows, not a counter.** Each attempt is a row in `task_ci_auto_resume_attempts`, written _before_ the resume is dispatched. Counting rows is counting attempts — never events — and it survives a crash, a redeploy and a replica swap. If the ledger cannot be read, the loop **stops**: a budget nobody can count is not a budget.

The count is re-read straight after the row is claimed, so two deliveries for two different commits that both read the same stale count cannot both spend a run — the one that pushed the Task past its budget refuses to dispatch. Its row stays claimed (deleting it would re-open the coordinate to the next redelivery), so a lost race costs an attempt slot and no model run. This side of the trade is deliberate: it fails toward not spending.

### One resume per push, not one per failing job

A twelve-job matrix goes red twelve times for one push, each job reports `created` and then `completed`, the suite and the workflow report too, and GitHub redelivers anything it did not get a `200` for — roughly thirty deliveries, doubled on a retry. The attempt row is claimed on `(task, head commit)` with a database-level unique index, so **all of it collapses into one attempt**. The losers are told the coordinate is already claimed and do nothing.

Because of that, the resumed run reads the _first_ red result reported for the commit, not a full list — and the message it is seeded with says so, and tells it to read the pull request's checks before fixing.

### An unchanged failure is not progress

Each attempt also records a fingerprint of _what_ failed (the failing check names plus a digest of the reported output). If the same failure comes back byte-identical on a **new** commit, the Agent pushed something and the build broke the same way: the loop stops there rather than buying another run, and files the notice.

## What refuses to resume

| Situation                                                                      | Why                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A green, pending, cancelled or skipped result                                  | Only a completed failure is actionable. A green re-run arriving after a red one is not a failure, so it changes nothing.                                                                                                            |
| A **superseded head** — see below                                              | CI catching up on a revision that has already been replaced would fix code nobody has.                                                                                                                                              |
| A **merged or closed** pull request                                            | There is nothing left to push a fix to. Checked from `prState` / `branchState`, because the merged → done transition is poll-driven and can lag by minutes, and a pull request closed without merging is never transitioned at all. |
| A repository that belongs to the Work but is **not the one its Tasks live in** | A Work owns up to three repositories; Task branches and Task pull requests are opened in the **data** repo, so a pull request `#7` in the website repo is a different pull request that happens to share a number.                  |
| A run that is **queued or running**                                            | The fix may already be in flight.                                                                                                                                                                                                   |
| A run **parked on a question**                                                 | That is yours to answer; resuming would consume the Inbox item with CI feedback.                                                                                                                                                    |
| A **failed or cancelled** run                                                  | A cancel is an explicit human stop and is never undone by a webhook.                                                                                                                                                                |
| A **done or cancelled** Task                                                   | Finished is finished.                                                                                                                                                                                                               |
| The **global stop flag** set, or unreadable                                    | Panic controls fail closed.                                                                                                                                                                                                         |
| A repository that is not a Work you hold                                       | The Task is resolved from platform state — the owning account, its Works, then the pull request number or branch. Nothing in a webhook body chooses an account.                                                                     |

### Which commit a result is really about

Two different commits are **not** ordered by their timestamps. A push's jobs finish at wildly different times, so a slow job belonging to the previous commit routinely completes _after_ the next push has already reported its first check — and a manual "Re-run jobs" on an old commit carries a brand-new timestamp by definition. Ordering by the clock would classify both as a fresh head, rewrite `ciHeadSha` backwards, and spend an attempt on a revision nobody has.

Instead the delivery's own pull-request head pointer decides: every same-repository check delivery says where the pull request's head is _right now_, so a result whose commit is not that head is refused outright, with no clock involved. The clock is the fallback only when there is no pointer (a fork pull request, a push-triggered workflow run) — and a delivery that reported no usable time at all is refused rather than trusted, because a substituted "now" is always the newest thing in any comparison.

### When a red result arrives at a bad moment

A webhook delivery is a one-shot: refusing it (because a run was still in flight, or a question was still open) used to mean the red build was never retried at all, silently. The two-minute PR status poll is the safety net — it already walks exactly the open pull requests whose verdict has gone stale, so a gate that is _still_ red is re-offered to the same evaluator on the next tick. That cannot double-spend: the claim is keyed on the head commit, so a commit already resumed for is refused forever after.

## Reviewer rejections

The same loop acts on the other half of the feedback: when a human requests changes on the pull request, or an allow-listed [reviewer bot](community-pr-processing.md) leaves a finding, the review bridge records a durable rejection — and this loop resumes the run to answer it, instead of parking the row until somebody presses Resume.

It reads the recorded rejection, not the delivery, so a review that recorded nothing (an approval, a plain comment) resumes nothing. The claim is keyed on the rejection row, so a redelivery cannot double it, and the attempt comes out of the same budget as a CI failure.

A comment is only a doorbell — it carries no link to the row it is meant to answer — so the row it rings for is checked rather than merely fetched:

- the platform's **own** identity and any **untrusted bot** never ring it, so the loop cannot wake itself on its own status comment (the same rule the review bridge applies before it records anything);
- a `gate` row (this loop's own record of a CI failure) is never cashed in by a comment — the CI half owns those;
- the row has to be about **this** pull request, and less than a week old. A rejection nobody consumed for a week was handled by a human or abandoned.

## When the budget is spent

Exactly **one** Inbox notice per Task — claimed with a compare-and-set marker on the Task itself, so the dozens of deliveries that all rediscover a spent budget cannot each file a row. It names the pull request, the last head commit seen, how many attempts were used, and whether the loop stopped because the budget ran out or because the same failure came back unchanged.

Nothing further is retried automatically for that Task, and that is literal: the notice marker **is** the stop flag, so once it is claimed every later delivery for that Task is a read and nothing else. Open the pull request, read the failing check, and either fix it yourself or resume the run manually once you know what to tell the Agent.

## What it looks like in the audit trail

- The resumed run's `agent_run_logs` row is stamped `action: 'resume'` with `autoResume: true`, so a machine-initiated run is never mistaken for you pressing the button.
- The failing output is persisted as a rejection on the Task (source `gate`), which is what the resumed run reads first — and what survives if the dispatch itself fails.
- `task_ci_auto_resume_attempts` is append-only: the budget is the history.
