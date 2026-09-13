# Post-deploy verification and revert

Self-build slice AJ (EW-809), epic EW-762. Closes finding R21.

The second half of [`RELEASE_PROMOTION.md`](./RELEASE_PROMOTION.md). Slice
AI opens the promotion pull request and reads the promotion gate; this
lane finds out whether the release that followed **actually worked**, and
offers you the undo when it did not.

Landing anything — a promotion or a revert — still goes through
[`MERGE_APPROVAL.md`](./MERGE_APPROVAL.md). Nothing here merges.

---

## 1. What this fixes

Nothing verified a deployment. The `browser-check` fleet job kind had
existed since the node shipped, with a working executor
(`apps/node/src/core/executors/browser-check.ts`), a capability tag and a
queue SLA — and **no producer anywhere on the platform**. Searching
`apps/api/src` and `packages/agent/src` for the string found type
declarations and two negative-control test fixtures.

So on 2026-09-06 a whole batch was cascaded `develop → stage → main` and
nothing on the platform confirmed the result. The production build lane is
measured at 215–243 minutes, which makes an unverified bad deploy a
multi-hour outage the fleet could neither detect nor reverse.

---

## 2. The one thing to understand first

**A revert is an OFFER, not an action.**

A promotion is merged only by a recorded human approval, and undoing one is
the same class of act. Nothing in this lane reverts production. When a
deployment is confirmed broken the platform files an inert Task holding the
coordinates and tells you about it. You decide.

There is no endpoint that reverts, no column that could record having
reverted, and no code path in `release-verification.service.ts` that
merges, pushes, deploys or rolls back. Those absences are asserted by
tests, so adding one fails CI rather than shipping.

---

## 3. What runs after a promotion merges

```
promotion pull request merges
        │
        │  ReleasePromotionService.refresh() observes state === 'merged'
        │  (the ONE moment the platform learns a promotion landed — the lane
        │   is freed in the same pass and no sweep ever visits the row again)
        ▼
  read the BASE branch's tip  ──────────────►  verifyExpectedSha
        │                                       THE artefact identity
        ▼
  verifyState = 'awaiting-rollout'
        │
        │  ReleaseVerificationCronService, every 5 minutes, distributed-locked
        │  enqueues ONE browser-check per promotion at a time, ≥10 min apart
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ awaiting-rollout   probe: <versionUrl>, expect <sha12>                │
│   3 consecutive hits ──────────────────────────────► checking-app     │
│   a miss           → streak resets, wait, try again (NOT a failure)   │
├───────────────────────────────────────────────────────────────────────┤
│ checking-app       probe: <appUrl>, expect <appExpectText>            │
│   a hit            ─────────────────────────────────► passed          │
│   3 consecutive misses ─────────────────────► confirming-failure      │
├───────────────────────────────────────────────────────────────────────┤
│ confirming-failure probe: <versionUrl> again, expect <sha12>          │
│   a hit  (environment reachable, still serving us) ──► failed  →offer │
│   a miss (cannot reach it at all) ──────────────────► inconclusive    │
└───────────────────────────────────────────────────────────────────────┘
        │
        │  at ANY point: 48 attempts used, or 8 hours elapsed
        ▼
   inconclusive     (never `failed`, therefore never a revert offer)
```

Everything above runs on **your own fleet**: the browser check is executed
by an enrolled node advertising the `browser` capability, against the
public URL, from outside the cluster. If no such node exists the job sits
until the kind's two-hour queue SLA fails it, and the verification settles
`inconclusive` — never `passed`.

---

## 4. What proves the deployed build is the one you promoted

This is the question the whole lane turns on, and the honest answer has a
limit in it.

**What is proven.** Before this lane says a single word about a
deployment, the environment's version endpoint must have served the
expected commit, in a real browser, on **three consecutive probes ten
minutes apart**. `verifyExpectedSha` is the tip of the promotion's **base**
branch, read from the git provider immediately after the pull request was
observed merged.

It is the base branch's tip and **not** `headSha`, because the merge
produces a new commit: the platform merges with the provider default
`merge` method, `GitPullRequestStatus` carries no merge-commit sha, and a
verification that compared the deployed `gitSha` against `headSha` would
report "not rolled out" for ever. `k8s-build` builds the branch tip and
stamps it into the image as `GIT_SHA`, which `/api/version` serves — that
is the chain the check closes.

The three-consecutive rule is the same discipline
`.github/workflows/smoke-deployed.yml` already encodes for the CI smoke
lane: ArgoCD replaces pods gradually, so immediately after a deploy the
version endpoint alternates between the old and the new commit depending on
which pod answers. Sampling once is a coin flip.

**What is NOT proven, stated plainly.**

1. **The commit may not be exclusively yours.** If another pull request
   lands on the base branch between your merge and our read, we record
   _that_ commit. Your promotion is still an ancestor of it — a pass never
   means your change is absent — but the artefact verified is then a later
   one. Fixing this properly needs a `mergeCommitSha` on
   `GitPullRequestStatus`, which does not exist and would touch every git
   provider.
2. **Three samples are not every pod.** Three consecutive hits mean three
   samples in a row reached updated pods. It is strong evidence the rollout
   settled; it is not a proof that no old pod survives. `smoke-deployed.yml`
   has the same limitation with five samples.
3. **The web bundle is only checked if you ask it to be.** The app probe
   asserts `appExpectText`, whatever you configured. Point it at a page
   that carries the build sha and the check becomes sha-aware for the web
   half too; point it at `/api/health` and it only proves the app answers.

    **The verdict says which one you got.** A pass whose app expectation
    does not contain the promoted commit reads

    > The app answered as expected at `app.ever.works`, and
    > `api.ever.works` served the promoted commit. The app expectation is a
    > fixed string that does not carry the commit, so this does NOT prove
    > the app deployment itself rolled out — a build that never rolled out
    > answers it identically.

    and the Task thread says "Confirm the app deployment itself by hand"
    instead of "Nothing further is required". Only a sha-carrying app
    expectation gets the stronger sentence. This was added after the
    slice-AJ review: the verdict used to say "The app rendered as expected.
    Nothing further is required" for both, which is a claim the lane had not
    measured — the API image can publish and roll out while the web
    deployment fails its rollout entirely.

4. **The failure confirmation is a different origin from the failure.**
   `confirming-failure` re-probes `versionUrl`, and `versionUrl` is
   normally a different host from `appUrl`. The two must share a
   registrable domain — a target whose hosts are unrelated is refused
   outright, which is why an unrelated `status.example.com` cannot
   "confirm" anything about `app.ever.works` — but a bot interstitial, an
   HTTP Basic wall or a proxy rule scoped to the app host **alone** would
   fail three app probes and still be confirmed by a healthy version host.
   The `failed` verdict therefore names both hosts and says so:

    > The failures were at `app.ever.works` and the confirmation at
    > `api.ever.works`; a network condition specific to `app.ever.works`
    > would look the same from this node.

    Read that sentence before acting on a revert offer.

None of these can make a `failed` verdict fire on nothing — that path also
requires a re-confirmed, reachable environment — and none of them is
hidden: `GET /api/works/:workId/promotions` returns `verification.expectedSha`
and `verification.lastUrl` so you can check the reasoning yourself.

---

## 5. Set it up

Two configuration acts, both platform state on the Work, both separate from
asking for a promotion.

```bash
# 1. The branch ladder (slice AI).
curl -X PUT https://api.ever.works/api/works/$WORK_ID/release-ladder \
  -H 'content-type: application/json' \
  -d '{"integration":"develop","staging":"stage","production":"main"}'

# 2. Where each environment can be observed (slice AJ).
curl -X PUT https://api.ever.works/api/works/$WORK_ID/verification-targets \
  -H 'content-type: application/json' \
  -d '{
    "staging": {
      "versionUrl": "https://apistage.ever.works/api/version",
      "appUrl": "https://appstage.ever.works/api/health",
      "appExpectText": "\"status\":\"OK\""
    },
    "production": {
      "versionUrl": "https://api.ever.works/api/version",
      "appUrl": "https://app.ever.works/api/health",
      "appExpectText": "\"status\":\"OK\""
    }
  }'
```

The host is `app.ever.works`, singular. (`apps.ever.works` appears only in
two stale specs.)

`versionUrl` **must** serve the commit sha in its rendered body.
`/api/version` does; `apps/web`'s `/api/health` does **not** — it answers a
fixed `{"status":"OK"}` with no version in it, so it returns 200 for the
old build throughout a rollout and for a rollout that never started. That
is why it is the _app_ probe and never the _version_ probe.

`appUrl` is `/api/health` above because it is what this platform actually
serves today. If your app renders the build commit anywhere — a
`/build-info` page, a `<meta name="build-sha">`, a footer — point `appUrl`
there and set `appExpectText` to the **twelve-character** commit prefix
instead. That is the only configuration in which a pass proves the app
deployment itself rolled out; see §4 limit 3.

`appExpectText` is required, minimum **eight** characters, and it may not
be a slice of a bare HTML skeleton — `div`, `<html><head`, `<!doctype`,
`</body></html>` and the like are refused. A check with no real expectation
passes on any document the browser managed to render, including Chrome's
own network-error page and a CDN 502 interstitial: both exit 0 under
`--dump-dom` and produce a non-empty document, so the executor's
empty-document guard does not catch them either. (The minimum was three
until the slice-AJ review pointed out that three characters has exactly the
property the guard was documented as preventing.)

`versionUrl` and `appUrl` must share a registrable domain —
`api.ever.works` + `app.ever.works` is fine, `api.ever.works` +
`status.example.com` is refused. The failure confirmation re-probes
`versionUrl` to tell "the app is broken" apart from "this node lost the
internet", and that argument only holds while the two URLs are about the
same deployment.

Refused on write and again on read: plain `http`, embedded credentials, a
fragment, an IP literal, a bracketed IPv6 address, a single-label host like
`localhost` or a bare Kubernetes service name. These URLs are loaded by a
real browser on somebody's actual PC inside their actual network, so a
target that could name a link-local address would be an SSRF primitive
pointed at the node operator.

**An environment with no target is `unsupported`, reported to you as NOT
VERIFIED.** It is never read as a pass.

---

## 6. What you see, and what you must decide

One Inbox item per verdict, exactly once, claimed with a compare-and-set so
two API replicas cannot both narrate.

| Verdict            | Inbox title                                                            | What happened                                                                                                           | What you must decide                                                                                                 |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `passed`           | `Deployment VERIFIED for <lane> (@ sha)`                               | The promoted commit served on three consecutive probes, then the app rendered.                                          | Nothing. The next rung is a separate promotion and is not opened automatically.                                      |
| `failed`           | `DEPLOYMENT FAILED after <lane> (@ sha) — revert prepared`             | The environment is reachable and serving your commit, and the app failed three consecutive checks, re-confirmed.        | **Do nothing** (the release stands), **roll forward**, or **start the revert Task**. See §7.                         |
| `failed`, no offer | `DEPLOYMENT FAILED after <lane> (@ sha) — NO revert could be prepared` | The same, except the offer Task could not be written. The verdict is terminal, so nothing retries it.                   | Decide by hand — there is no Task waiting in review, and the notice says so rather than sending you looking for one. |
| `inconclusive`     | `Deployment NOT VERIFIED for <lane>`                                   | The rollout never arrived inside the budget, the node could not reach the environment, or the target became unreadable. | Read the environment yourself. Nothing was measured, so nothing was offered.                                         |
| `unsupported`      | `Deployment NOT VERIFIED for <lane>`                                   | No verification target is configured for the environment this rung deploys.                                             | Configure one (§5) if you want future releases checked.                                                              |

The promotion Task's own chat thread carries the same story in order:
verification started, rollout confirmed, verdict.

`GET /api/works/:workId/promotions` returns the machine-readable version:

```jsonc
{
	"verification": {
		"state": "failed",
		"expectedSha": "bbbbbbbbbbbb…",
		"lastUrl": "https://app.ever.works/api/health",
		"attempts": 11,
		"checkedAt": "2026-09-06T18:40:00.000Z",
		"detail": "The environment is serving bbbbbbbbbbbb but the app failed 3 consecutive checks."
	},
	"revertOffer": { "taskId": "…", "offeredAt": "2026-09-06T18:40:00.000Z" }
}
```

`state: null` means the deployment was never checked. The field is always
present rather than omitted, precisely so a reader cannot round an absence
up to "fine".

---

## 7. The revert offer

When — and only when — a verification reaches `failed`, the platform files
one Task:

- **Title** `Revert release: <head> → <base>`
- **Status** `in_review`, deliberately. `TaskGraphFanoutService` starts
  unblocked `todo` Tasks; a revert Task filed `todo` would be a platform
  that reverts production by itself the moment a check goes red.
- **Labels** `release:revert` and `release:revert:<rung>`. Note what is
  **absent**: `release:promotion`. A revert Task is an ordinary Task, so
  the promotion refresh answers `not-a-promotion` for it and the promotion
  merge guard leaves it to the ordinary path — which is what stops "a
  revert triggers a promotion that triggers another check" from being a
  cycle.
- **Body** the promotion pull request, the base branch, the commit the
  failing deployment was serving, the URL that failed and the reading.

Your three options, in the order you should consider them:

1.  **Do nothing.** The release stands. The Task sits in review and changes
    nothing, for ever, until you touch it.
2.  **Roll forward.** Usually cheaper here: the production build lane is
    215–243 minutes, so a revert is not a fast undo — it is another full
    release with its own promotion and its own approval. Roll forward when
    the fix is obvious.
3.  **Start the revert Task.** Move it to `todo` yourself. It becomes an
    ordinary agent Task that opens an ordinary pull request, and landing
    that pull request needs the same `merge_pull_request` approval in your
    Inbox, verified against the head commit at merge time, as every other
    merge in this platform.

        Moving a Task out of review is a **start this work** act, not a merge
        approval, and `TaskMergeGateService` treats it as such: it recognises
        the `release:revert` label, forces the approval path **whatever your
        scope's `requireHumanApproval` says**, and resolves the pull request's
        base branch from your release ladder rather than from the Work's
        `taskIsolationBaseBranch`. That base is both the branch the
        protected-branch rule is evaluated against and the branch named in the
        Inbox line you read ("Merge PR #12 into `main`"). Until the slice-AJ
        review neither was true: on the exact configuration this lane requires
        (`allowAgentMerge: true`, `main` unprotected, `requireHumanApproval:

    false`) a revert pull request merged into production unattended, and the
    protected-branch rule was evaluated against a branch nobody was merging
    into.

        A revert Task whose rung label is missing, or whose Work has no usable
        ladder, is refused outright with `revert-base-unresolved` rather than
        merged against a guess.

Offered at most once per promotion, ever, enforced by
`WHERE revertTaskId IS NULL AND verifyState = 'failed'`.

---

## 8. Every path that could reach a revert, and how each is gated

| #   | Path                                              | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A verification concludes the deployment is broken | Requires `verifyState = 'failed'`, which requires a confirmed rollout **and** a full failure streak **and** a re-confirmation that the environment is reachable and still serving the promoted commit.                                                                                                                                                                                                                                                                                         |
| 2   | An inconclusive or unsupported verification       | `isReleaseVerifyRevertOffered()` is `state === 'failed'` and nothing else; `claimRevertOffer` writes only `WHERE verifyState = 'failed'`. Three layers, two of them in the database.                                                                                                                                                                                                                                                                                                           |
| 3   | A flapping app check                              | A single failure never counts; the streak must be consecutive; a green reading resolves the verification to `passed` (and says it was not clean).                                                                                                                                                                                                                                                                                                                                              |
| 4   | A fleet node that lost its network                | The failure confirmation re-probes the **version** endpoint. If the node cannot reach it either, the verdict is `inconclusive` and no offer is made. The two URLs must share a registrable domain, and the verdict names both hosts — see §4 limit 4 for what this still cannot rule out.                                                                                                                                                                                                      |
| 5   | A node reporting a forged result                  | `ok` must be strictly `=== true` on a `done` job (`isReleaseVerifyCheckPass`, one rule shared by the completion listener and the sweep's recovery path). A failed job, a missing result, `"true"`, `1`, `{}` are all not-a-pass, and a not-a-pass in `confirming-failure` produces `inconclusive`, not a revert.                                                                                                                                                                               |
| 5b  | A job substituted under the idempotency key       | `FleetJobService.enqueue` returns an existing row for a matching key with no status, owner or kind filter. The lane checks what it was handed: a `browser-check`, still live, owned by the promotion's owner, carrying the exact probe payload. Anything else burns the attempt instead of being recorded.                                                                                                                                                                                     |
| 6   | The offer Task itself                             | Filed `in_review`, so no agent is dispatched. It does nothing until a human moves it.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | The Task, once a human starts it                  | An ordinary Task with one narrowing: `TaskMergeGateService` recognises `release:revert`, so the human approval is required **regardless of `requireHumanApproval`**, and the base branch is resolved from the release ladder. Its pull request lands only through `TaskMergeGateService` → `MergeApprovalService` → a human approval verified against the live head at merge time (slice AE). One `gitFacade.mergePullRequest(...)` call exists in the whole platform and it sits behind that. |
| 8   | An API caller asking for a revert                 | There is no such endpoint. Asserted by a route-inventory test.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | The verification service reverting directly       | It contains no `mergePullRequest(`, `createPullRequest(`, `createBranch(`, `push(`, `deploy(` or `rollback(` call site. Asserted by reading its source in a test.                                                                                                                                                                                                                                                                                                                              |
| 10  | A revert causing another release                  | The revert Task carries no promotion label and cannot open a promotion — only `POST /works/:id/promotions` does, which is a deliberate human act.                                                                                                                                                                                                                                                                                                                                              |

---

## 9. Why it cannot loop

Four independent stops, any one of which ends the lane:

1. **A failed check never re-enqueues itself.** It writes a result and a
   `verifyRetryAt`; only the cron sweep enqueues, and only for a live row
   with no check in flight.
2. **`RELEASE_VERIFY_MAX_ATTEMPTS` = 48 probes**, whatever the clock says.
3. **`RELEASE_VERIFY_BUDGET_MS` = 8 hours** from the merge, whatever the
   attempt count says — and this is checked **even while a check is in
   flight**, so a browser job that never comes back cannot hold a promotion
   open.
4. **Every terminal state clears `verifyRetryAt`**, so a settled promotion
   is invisible to the sweep for ever.

And one stop in the other direction, added by the slice-AJ review: a check
that reaches a terminal fleet state **without its result reaching the state
machine** — a dropped `fleet.job.completed`, an API replica that restarted
mid-handler, a transient database error inside the listener — used to wedge
the promotion until its deadline, because the sweep declines to enqueue
while a job is bound. The sweep now re-reads the bound job: a terminal one
is recorded off the job row (through the same pass rule the listener uses),
and a live one has its `verifyRetryAt` pushed forward so it cannot sit at
the head of the platform-wide sweep queue and starve other owners. The cron
logs a warning whenever it has to do this.

An unreadable deadline counts as **reached** (`isReleaseVerifyExhausted`
fails closed toward stopping), so a corrupt timestamp settles the row
rather than probing indefinitely. Note this is the opposite direction to
`isPromotionGateDecisionOverdue`, which fails closed by _not_ filing a
notice — there, an unreadable clock must not raise a false alarm; here, it
must not create an unbounded loop.

The fleet job itself is enqueued with `maxAttempts: 1`, so the fleet's own
reclaim does not multiply the attempt ladder in this file by three.

---

## 10. When it goes wrong

| Symptom                                                      | What it means                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict `unsupported` immediately after a merge              | No verification target for that environment. §5.                                                                                                                                                                                                  |
| Verdict `inconclusive`, detail mentions the budget           | The build never reached the cluster inside 8 hours. Check `k8s-build` and ArgoCD; the lane is telling you it does not know, which is correct.                                                                                                     |
| Verdict `inconclusive`, detail mentions the version endpoint | The fleet node could not reach the environment. Check the node's network before you suspect the release.                                                                                                                                          |
| Nothing happens at all after a merge                         | Is a node enrolled with the `browser` capability? Without one the job sits until the two-hour queue SLA fails it. `EVER_WORKS_NODE_BROWSER` pins a browser path; a pinned path that does not exist resolves to _no browser_, with no fallthrough. |
| `awaiting-rollout` for hours on a production promotion       | Expected. The build lane is 215–243 minutes and the rollout follows it.                                                                                                                                                                           |
| A revert Task appeared                                       | Read §7 before doing anything. Rolling forward is usually cheaper.                                                                                                                                                                                |
| Two Inbox items for one verdict                              | Should be impossible — every terminal transition is a compare-and-set and only the winner narrates. If you see it, the two items will be for different `expectedSha` values or different verdicts.                                                |

---

## 11. Files

| Concern                                                                   | File                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Environment mapping, target validation, verdicts, bounds, probe selection | `packages/contracts/src/release/deployment-verification.types.ts`                                                               |
| The state machine, the browser-check producer, the revert offer           | `packages/agent/src/tasks-domain/release-verification.service.ts`                                                               |
| The compare-and-set writes                                                | `packages/agent/src/database/repositories/release-promotion.repository.ts`                                                      |
| Storage                                                                   | `packages/agent/src/entities/release-promotion.entity.ts`, `packages/agent/src/entities/work.entity.ts` (`releaseVerification`) |
| Migration                                                                 | `apps/api/src/migrations/1790100000000-AddReleaseVerification.ts`                                                               |
| The trust boundary (node result → verdict)                                | `apps/api/src/release/release-verification.listener.ts`                                                                         |
| The clock                                                                 | `apps/api/src/release/release-verification-cron.service.ts`                                                                     |
| Operator surface                                                          | `apps/api/src/release/release-promotions.controller.ts`                                                                         |
| The executor that runs on the node                                        | `apps/node/src/core/executors/browser-check.ts`                                                                                 |
| The CI lane this mirrors                                                  | `.github/workflows/smoke-deployed.yml`                                                                                          |
