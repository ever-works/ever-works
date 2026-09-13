# Merge approval — operator runbook

**Jira:** EW-805 (epic EW-762, self-build fleet) · **Slice:** AE

This describes how an agent-opened pull request becomes a merged one, what
a human has to do, and exactly what changes if you turn the approval
requirement off.

---

## The short version

1. An agent run pushes a branch and opens a pull request. **Nothing is
   merged at this point** and nothing is said about merging.
2. The `task-pr-status-sync` cron reads the pull request from the git
   provider every ~2 minutes while it is open.
3. The first time that read says **open + CI passing**, the platform files
   a **`merge_pull_request` approval** in the Task owner's Inbox, bound to
   the pull request's current head commit.
4. A person clicks **Approve**.
5. On the next status read (≤ ~2 minutes, or immediately via
   `GET /api/tasks/:id/pr-status?refresh=true`), the platform re-checks
   everything against the provider and merges, pinning the merge to the
   approved commit.

If any of that is not true, the merge is refused with a stable code and
the pull request is left open and unchanged.

---

## What changed, and why

The merge decision used to fire inside `openPullRequestForBranch`, seconds
after the pull request was created — before any CI had run — and it passed
`humanApproved: false` as a hardcoded literal
(`packages/agent/src/tasks-domain/task-workspace.service.ts`). Under the
shipped default (`requireHumanApproval: true`) that meant **an agent-opened
pull request could never be merged by the platform, ever**, and there was
no `merge_pull_request` proposal type for anybody to approve. The code
comment was honest about the gap; the gap had simply never been filled.

Slice AE fills it:

| Before                                    | Now                                         |
| ----------------------------------------- | ------------------------------------------- |
| Merge judged at PR-open time, before CI   | Merge judged after each provider CI read    |
| `humanApproved: false`, hardcoded         | Looked up from a recorded human decision    |
| No approval surface at all                | `merge_pull_request` proposal in the Inbox  |
| Merge sent with no head pin               | Merge pinned to the approved commit (`sha`) |
| Nothing ever read `status === 'approved'` | The approval is what triggers the merge     |

---

## What must be true for a merge to land

Every one of these is checked **at merge time**, against the provider, on
every path that can reach a merge. Any failure refuses and leaves the pull
request untouched.

| #   | Condition                                                        | Refusal code                                 |
| --- | ---------------------------------------------------------------- | -------------------------------------------- |
| 1   | The effective merge policy allows agent merges                   | `agent-merge-disabled`                       |
| 2   | The base branch is not protected                                 | `protected-branch` / `target-branch-unknown` |
| 3   | The merge method is allowed                                      | `merge-method-not-allowed`                   |
| 4   | The run's own quality gate is green (if `requireGreenGate`)      | `gate-not-green`                             |
| 5   | The pull request is **open** right now (not draft/closed/merged) | `pull-request-not-open`                      |
| 6   | **Provider CI is passing right now**                             | `pull-request-not-green`                     |
| 7   | The CI read was **complete** — not a truncated sample            | `pull-request-not-green`                     |
| 8   | The provider reports a head commit                               | `head-sha-unknown`                           |
| 9   | An approval exists **for this pull request at this head commit** | `approval-missing` / `approval-stale`        |
| 10  | It was made by a person, not a guardrail                         | `approval-not-human`                         |
| 11  | It is less than 24 hours old                                     | `approval-expired`                           |
| 12  | The approver is entitled to approve for this Task's scope        | `approver-not-entitled`                      |

Conditions 9–12 apply only when the effective policy requires an approval
(see below). Conditions 5–8 apply to **every** policy — an operator who
turns approvals off has opted out of a person, not out of CI. Conditions
1–4 are the pre-existing merge-policy matrix.

### Things that deliberately do **not** count

- **A green pull request from an hour ago.** CI is re-read from the
  provider immediately before the merge. `tasks.ciState` is a cache the
  sweep refreshes every couple of minutes and is never the merge input.
- **A green verdict over part of the checks.** `GitPullRequestStatus.checks`
  is a bounded DISPLAY list (20 rows); `ciState` is the roll-up over every
  check on the head commit, and the provider reports
  `checksComplete: false` when it could not read the whole set (a source
  it lacks scope for, or more checks than its page budget). An incomplete
  read is treated as not-green by both the gate and the merge path — the
  pill still shows what it saw, but nothing authorises on a sample. This
  monorepo's own CI runs well over 20 legs, with external commit statuses
  last, so a sample is exactly where a red check hides.
- **An approval for an earlier commit.** The approval is keyed
  `merge:<taskId>:<prNumber>:<headSha>`. A force-push, a rebase or one
  extra commit produces a different key, so the old decision matches
  nothing and a fresh approval is raised for the new head.
- **A guardrail auto-approval.** An Agent in `autonomous` mode cannot
  auto-approve its own merge. Three independent layers stop it: the risk
  scorer flags every merge `destructive`, `evaluateGuardrails` refuses to
  auto-approve `merge_pull_request` unconditionally, and the verifier
  requires `decidedVia = 'user'` with a non-null decider.
- **A GitHub review approval.** These are now recorded (see below) and
  shown to the approver as context, but a provider login is not a platform
  identity — this platform cannot map one to an entitled Organization
  member — so it never authorises anything on its own.
- **"Approve all".** `merge_pull_request` proposals are excluded from
  `POST /api/agent-approvals/approve-all`, with or without explicit ids.
  They come back in a separate `excluded` counter, NOT in `skipped`:
  `skipped` means "somebody already decided this", and the queue renders
  it as such, so counting a still-pending merge there would tell the user
  the one irreversible item in their queue had been handled. A merge has
  to be decided one pull request at a time.

### Who may approve

Derived from platform state, never from the proposal:

- **Task in an Organization** — the approver's `users.tenantId` must equal
  the Task's `tenantId`, **and** one of: they hold an
  `organization_members` row for that Organization, they are the Tenant
  owner, or that Organization has no roster at all.

    The roster clause is what makes removal mean something. Removing
    somebody from an Organization deletes their roster row but only clears
    `users.tenantId` once their LAST membership in the Tenant is gone — so a
    pure tenant-equality check hands a removed member continuing merge
    authority over the Organization they were removed from, whenever they
    still belong to a sibling Organization. Everywhere else in the platform
    that is a visibility question; here it is the one irreversible write.

    The two exemptions keep the predicate from repeating a mistake this repo
    has already made twice. The Tenant owner is a member of every
    Organization by construction and holds no roster row to find, and
    Organizations created before invitations existed have an empty roster —
    roster-strictness against those admitted only the Tenant owner in
    production, and had to be reverted in `assertActorReachable` and
    `UploadsController` both. Where there is no roster there is no
    revocation to honour.

- **Task in a personal scope** — only the Task's owner.
- The approver must be an **active, non-anonymous** account in either case.

Note that today the approvals queue and the Inbox are **owner-scoped**:
`AgentApprovalsService.decide` only lets a proposal's own `userId` decide
it, so in practice the person who approves is always the Task owner. The
tenant check above is the second gate, and it is what will hold when the
queue becomes Organization-wide — it is deliberately derived from the Task
row and the approver's user row, never from the proposal.

---

## Turning the approval off

Set `requireHumanApproval: false` on the merge policy at whichever scope
you want: Tenant, Organization, Work or Agent. (Merge policy resolves
field by field, most specific wins:
`platform default < tenant < organization < work < agent`.)

**With `requireHumanApproval: false`:**

- No `merge_pull_request` proposal is ever raised, and no Inbox item
  appears. Asking for permission you have said you do not need would be
  noise.
- The merge is attempted **once**, from the same place as every other
  merge: the post-CI gate, after the PR-status sweep reads the provider
  and reports the pull request open and green. Nothing is attempted at
  pull-request-open time under any policy — a branch pushed one second ago
  has no check runs, so "is this green?" has no answer there yet.
- Conditions 1–8 above still apply. `requireGreenGate` (on by default)
  still gates on the run's acceptance checks, and provider CI still has to
  be green: you opted out of a **person**, not out of CI. If you want
  neither, the run's own quality gate is the knob (`requireGreenGate`),
  and it is a separate decision.
- The merge is **still pinned to the head commit** the platform just read
  from the provider. Pinning can only ever refuse a merge whose head moved
  under it, so it is applied whether or not an approval was required.
- Expect the merge up to one sweep (~2 min) after CI reports, rather than
  seconds after the pull request opens.

**You still need `allowAgentMerge: true`.** The platform default is
`false`, and with it nothing is attempted and nothing is said — an upgrade
to this version changes no behaviour for any existing deployment.

### Recommended production posture

```jsonc
// Organization- or Work-scoped mergePolicy
{
	"allowAgentMerge": true, // opt in
	"requireGreenGate": true, // the run's own checks
	"requireHumanApproval": true, // the Inbox approval  ← keep this
	"allowedMergeMethods": ["squash"],
	"protectedBranches": ["main", "master", "develop", "stage"]
}
```

Note the protected-branch list is the platform default and it protects the
branches the self-build fleet actually targets. An agent merging into
`develop` needs that list narrowed deliberately.

---

## `AGENT_MERGE_POLICY_ENFORCEMENT=off`

**This kill-switch no longer waives the approval requirement.**

It disables the merge-policy _matrix_ — the branch, method and quality-gate
rules (conditions 1–4) — and nothing else. Conditions 5–12 still apply,
and the head pin is still sent.

Why it was narrowed: the switch exists to un-break a deployment the matrix
is refusing. Letting one environment variable also waive "a person said yes
to this commit" would make the difference between a reviewed merge and an
unreviewed one a pod env var, which is precisely the failure this slice
exists to prevent. It waives nothing that used to work, either — before
slice AE the approval could never be satisfied, so no merge ever depended
on it.

If you want agents to land green work with no human in the loop, set
`requireHumanApproval: false` on the policy. It is scoped, auditable, and
visible in the resolved-policy UI instead of in a deployment manifest.

---

## Provider-side review approvals

A `pull_request_review` with state `approved` **from a human** is now
recorded on the Task (`prReviewApprovedSha`, `prReviewApprovedAt`,
`prReviewApprovedBy`), stamped with `review.commit_id` — the commit the
reviewer actually opened, not the branch head at delivery time.

It is shown to the person deciding the Inbox approval, and only when it
covers the _current_ head. It is not an authorization.

Bots are dropped, all of them:

- the platform's own `<GITHUB_APP_SLUG>[bot]` identity, and
- every allow-listed reviewer bot (`GITHUB_TRUSTED_REVIEW_BOTS` —
  CodeRabbit, Copilot, Codex, Greptile …).

Their _rejections_ are still trusted (finding R16). A bot saying "looks
good" is not a person having looked.

---

## Where things live

| Concern                       | File                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| Subject key + validity window | `packages/contracts/src/policy/merge-approval.types.ts`            |
| Verifier + raiser             | `packages/agent/src/agent-approvals/merge-approval.service.ts`     |
| Verifier port (token)         | `packages/agent/src/policy/merge-approval.port.ts`                 |
| Enforcement                   | `packages/agent/src/facades/git.facade.ts` (`assertAgentMayMerge`) |
| Post-CI re-evaluation         | `packages/agent/src/tasks-domain/task-merge-gate.service.ts`       |
| CI read that triggers it      | `packages/agent/src/tasks-domain/task-pr-status.service.ts`        |
| Provider review approvals     | `packages/agent/src/tasks-domain/task-review-approval.service.ts`  |
| Webhook entry                 | `apps/api/src/ingest/github/github-pr-review-bridge.service.ts`    |
| Schema                        | `apps/api/src/migrations/1789700000000-AddMergeApprovalBinding.ts` |

---

## Troubleshooting

**"The Inbox never shows a merge approval."** In order:

1. Is `allowAgentMerge` true at some scope? With the default `false` the
   platform will not ask for permission it could not use. Check
   `GET /api/merge-policy/resolve`.
2. Is the Task's `agentId` set? A Task with no Agent has no policy scope
   and no one to attribute the merge to; the gate stands down.
3. Is provider CI actually green? Check `GET /api/tasks/:id/pr-status`.
   `unknown` counts as not-green and is indistinguishable from "no CI
   configured" and "the token lacks `checks:read`". A token that cannot
   read one of the two check sources also reports `checksComplete: false`,
   which counts as not-green even when the half it COULD read is passing —
   grant `checks:read` to the installation if the pill looks green and the
   gate still will not raise an approval.
4. Is the pull request a draft? Drafts are excluded.
5. Is the `task-pr-status-sync` cron running? It is the only trigger.

**"The Task chat says the merge was refused, over and over."** It should
not: a refusal is reported once per (head commit, refusal code) and the
marker lives on `tasks.mergeRefusedSha` / `mergeRefusedCode`. The ATTEMPT
still repeats every sweep, deliberately, so a transient provider fault
clears itself. If you are seeing repeats, the head is moving or the code
is changing — read the codes, they will say which.

**"I approved it and nothing merged."** Give it one sync tick (~2 min), or
force it with `GET /api/tasks/:id/pr-status?refresh=true`. If it still has
not merged, the Task chat carries the refusal message with its code — see
the table above. The most common are `pull-request-not-green` (something
went red after you approved) and `approval-stale` (a commit landed after
you approved; approve the new head).

**"It says `approval-stale` but nobody pushed."** A rebase, an amend, or a
"Update branch" click on the provider all change the head commit. The
approval covers the commit that was reviewed; re-approve.

**"The merge returned `Head branch was modified`."** The provider refused
because the head moved between the check and the merge call. That is the
pin working. The next sweep will raise a fresh approval for the new head.
