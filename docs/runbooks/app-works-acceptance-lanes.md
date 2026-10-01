# App Works acceptance lanes — operator runbook

**Owner:** APW-13 (T56). **Applies to:** the App Works PR lane and the acceptance (`live`) lane.
**Deliberately carries no addresses:** estate hosts, IPs and private domains live in the private
operations repository and in the lane's own environment block, never here. Everything below names a
**variable** and lets the environment supply the value.

---

## 1. What the lanes are

| Lane                       | Config / workflow                                                                             | What it proves                                                                                                                                                                                                                                           | Needs                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **PR lane**                | `.github/workflows/e2e.yml` (sharded Playwright matrix) + the fake GitHub the workflow starts | the platform's existing behaviour, plus APW-13's five regression specs (`flow-repo-work-kind-regression`, `flow-template-fork-success`, `flow-activity-deploy-and-pr-events`, `flow-github-intake-signed-delivery`, `flow-managed-subdomain-allocation`) | a stack the workflow builds itself: fake GitHub, in-memory SQLite API, prod-built web, the App runtime worker |
| **PR lane — flags-on job** | `e2e.yml` job `e2e-app-works-flags-on` (one shard) + the fake GitHub + the catalog fake       | ACC-E2E-12 (`flow-app-launcher-apps`) and ACC-REG-05's cap and allocation boundary (`flow-managed-subdomain-allocation`) — the cases that skip by name on the matrix, where both switches are off on purpose                                             | the matrix's stack plus the launcher and ever-works-deploy switches, the apps apex and the catalog fixture    |
| **Acceptance (live) lane** | `apps/web/playwright.app-works.config.ts` (`workers: 1`, its own setup project)               | the golden paths end to end against the run account                                                                                                                                                                                                      | everything above, plus the interlocks and a GitHub connection surface (T63)                                   |
| **Nightly lane**           | `app-works-nightly.yml` / `app-works-golden-path.yml` (APW-13 T36/T45)                        | the Blueprints, the fixture variants and the live sandbox checks                                                                                                                                                                                         | operator switches and an estate                                                                               |
| **Harness unit lane**      | `apps/web/vitest.e2e-harness.config.ts` (`pnpm exec vitest run -c …`)                         | the harness's own specs — fake GitHub, helpers, evidence                                                                                                                                                                                                 | nothing but the repo                                                                                          |

The harness unit lane is the one to run first when something looks wrong: it is fast, needs no
stack, and covers the fake and the helpers. Run it with `pnpm --filter ever-works-web test:e2e-harness`
(add a name filter such as `flags-on-lane` to run one file). CI runs it in `ci.yml`'s `lint-and-test`
job, in the step after `pnpm test`, on pushes to `stage` and `main` and on dispatch. `pnpm test` does not
reach it: `apps/web/vitest.config.ts` includes only `src/**`.

---

## 2. Dispatching a lane

```bash
gh workflow run e2e.yml --ref <branch>
```

**A dispatched run tests the SHA the branch pointed at when the dispatch was created, not the branch as
it moves.** Confirm what a run actually tested before drawing conclusions from it:

```bash
gh run view <run-id> --json headSha --jq .headSha
git ls-tree -r --name-only <sha> -- packages/tasks/src/tasks/trigger/   # e.g. is the local worker in it?
```

That check is not academic: a run dispatched before the App runtime worker landed legitimately took the
worker step's "no script yet" branch, and its logs show a `::warning title=App runtime worker absent`
that reads like a defect and is not one.

**The same dispatch runs the flags-on job** (`e2e-app-works-flags-on`, added 2026-09-25) beside the
32-shard matrix. It is a new gate, so the programme's rule for new gates applies: its first dispatched
run is the proof that the job itself runs, and until one run of it is green nothing it has not yet shown
is trusted. On that run the matrix should report the two flags-on files' switch-dependent cases as
**skipped**, and the flags-on job should report them as **passed**. On the matrix the skips show **by
count only**: in CI `playwright.config.ts` uses the `github` reporter, which prints skip totals but not
skip reasons, and no HTML report is written. At the time of writing that is the 7 cases of
`flow-app-launcher-apps` and the 2 switch cases of `flow-managed-subdomain-allocation` (the cap and the
allocation boundary), spread across the shards. The named reasons in §5 are visible locally (the default
`html` reporter) or with `--reporter=json` (each skipped result's `annotations[].description`).
`--reporter=list` does not help here: it marks a skipped case with `-` and shows WHICH cases skipped,
never why.

---

## 3. Reading the summary and finding evidence

```bash
gh run view <run-id>                     # per-shard conclusions
gh run view <run-id> --json jobs | jq '.jobs[] | {name, conclusion}'
gh run view --job <job-id> --log-failed  # the failing step's log
gh api repos/<org>/<repo>/actions/jobs/<job-id>/logs > /tmp/job.log
```

Where the artefacts live:

| Artefact                                               | Path                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Playwright traces, screenshots, error contexts         | `apps/web/e2e/test-results/` (per-attempt directories; gitignored)          |
| The run's estate record (account, Agent, cleanup list) | the path in `APW_E2E_ESTATE_PATH`                                           |
| The lane's evidence JSON                               | written by `helpers/app-works-evidence.ts`; the catalog schema validates it |
| The fake GitHub's served state and fixtures            | `apps/web/e2e/fakes/github-fake/` (43 recorded fixtures)                    |

**Before believing a red, reproduce it locally** (§4). This fleet runs a shard in roughly half an hour
where a developer machine finishes the same shard in under a minute, and several shards per run fail on
assorted pre-existing specs; a failing shard is a lead, not a verdict.

---

## 4. Running the lanes locally

The lane is three processes and two Playwright invocations. Every value below comes from the
environment — substitute your own origins for the variables.

```bash
# 1. The fake GitHub (the workflow starts this BEFORE the API, because the API's first GitHub call
#    must already reach it). Port 3900.
#
#    ⚠️ `EVER_WORKS_E2E_FAKES=1` on THIS line matters since T45 (2026-09-19): the fake's
#    `POST /_control/seed` honours its two APW-09 keys (`upstream_pull_requests`,
#    `upstream_approval_proposals`) ONLY while the switch is armed, and the switch is read in the
#    FAKE's process when the seed arrives. `e2e.yml` already exports it to the step that starts
#    this process, so CI needs no change; a hand-run local lane does, or its upstream seed is
#    silently ignored. Start it without the switch and the seed answers
#    `upstreamSeed: { applied: false, reason: 'switch-off' }`, which
#    `helpers/github-fake-upstream.ts` turns into a lane failure rather than a mystery.
EVER_WORKS_E2E_FAKES=1 node apps/web/e2e/fakes/github-fake/server.mjs &

# 1a. BUILD THE PLUGIN PACKAGES FIRST. `packages/plugins/github/dist` absent is the single most
#     expensive oversight here: the API logs "Failed to load plugin module from …packages/plugins/github"
#     and every GitProvider read then answers `connected: false`, so a lane looks like "no GitHub
#     connection" instead of "the plugin was never built".
pnpm --filter @ever-works/github-plugin build

# 2. The API — built dist, in-memory SQLite, the lane's switches. Port 3100.
DATABASE_TYPE=sqlite DATABASE_IN_MEMORY=true DATABASE_AUTOMIGRATE=true \
AUTH_SECRET=<32+ chars> NODE_ENV=development PORT=3100 \
REQUIRE_EMAIL_VERIFICATION=false \
EVER_WORKS_E2E_FAKES=1 APW_E2E_GITHUB_FAKE_URL=<the fake's origin> \
EVER_WORKS_APP_WORKS_ENABLED=true DEPLOY_EVER_WORKS_ENABLED=true \
EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER=3 \
REGISTER_THROTTLE_LIMIT=100000 LOGIN_THROTTLE_LIMIT=100000 E2E_DISABLE_AUTH_THROTTLE=true \
GITHUB_APP_WEBHOOK_SECRET=<any CI-only value> node apps/api/dist/main.js &

# 3. The web — a PROD build (`next build` first), and the port must be set for the web process only.
NODE_ENV=production PORT=3000 pnpm --filter ever-works-web start &

# 4. The five regression specs (the PR lane's App Works half)
pnpm --filter ever-works-web exec playwright test --project=chromium \
  flow-repo-work-kind-regression flow-template-fork-success flow-activity-deploy-and-pr-events \
  flow-github-intake-signed-delivery flow-managed-subdomain-allocation

# 5. The acceptance lane's interlocks and setup
pnpm --filter ever-works-web exec playwright test -c playwright.app-works.config.ts
```

**Step 5 reads the same interlocks as step 4, and its setup project is where they bite.** The setup lane
(`app-works-live.setup.ts`) throws before anything runs if `APW_E2E_RUN_ID` (or `APW_E2E_ALLOWED_BASE_URLS`,
or `APW_E2E_TOKEN_BUDGET`) is unset — see the refusal table in §3 — and because the setup is a _dependency_
of the live project, a runner that exports the interlocks only for step 4 gets a wall of
`Error: APW_E2E_RUN_ID is not set` with no scenario having run. Export them once for the whole shell
(the workflow's env block is the source of truth for the values) and both steps work. This is worth stating
because it reads like a broken lane and is in fact the interlock doing its job.

**`APP_WORKS_CLOUD_PUSH_ENABLED` stays unset (off, the default) on every lane**: neither `e2e.yml` nor
the recipes here set it. Off, a cloud run on an App Work commits locally, pushes nothing, opens no pull
request and blocks the Task with a message naming APW-08 FR-12 / T12, and the agent git tools
`commitToRepo` / `openPullRequest` refuse an App Work with the same message
(`packages/agent/src/tasks-domain/app-work-cloud-push.ts`). Leave it off on any stack whose API runtime
does not meet FR-12's isolation, because cloud runs have no admission yet (T12). Only the exact value
`true` turns it on. It is read per call from the API process's environment (never captured at import), so
a changed value takes effect when the API restarts or is redeployed.

### The flags-on recipe — ACC-E2E-12 and ACC-REG-05's cap (added 2026-09-25)

`flow-app-launcher-apps` and the cap and allocation-boundary cases of `flow-managed-subdomain-allocation`
need two switches the matrix keeps **off** on purpose: the launcher's flag-off lane needs
`EVER_WORKS_APP_LAUNCHER_ENABLED` unset, and `flow-deploy-capability-contract` asserts that an
`ever-works` create becomes `vercel` while `DEPLOY_EVER_WORKS_ENABLED` is off. So those cases read both
switches from the API and **skip by name** where they are off, and they run on the `e2e-app-works-flags-on`
job. Locally that is the stack above plus a fourth process and the variables below:

```bash
# 1b. The platform-catalog fake — the launcher's "versioned catalog". Port 4084, from its OWN variable
#     APW_E2E_PLATFORM_CATALOG_PORT (never PORT, so the PORT trap below cannot move it). It serves
#     apps/web/e2e/fakes/platform-catalog/{platforms.json,icons/} at exactly the coordinates the API
#     reads (EVER_WORKS_PLATFORM_CATALOG_REPO / _REF, default ever-works/platforms @ main).
node apps/web/e2e/fakes/platform-catalog/server.mjs &
curl -s http://127.0.0.1:4084/_control/health     # { status: 'ok', catalogVersion, platforms, … }

# 2. The API exactly as in step 2 above (it already carries DEPLOY_EVER_WORKS_ENABLED=true and the
#    fakes switch the catalog override is gated on), plus the lines below. The apps apex is a SIBLING
#    of EVER_WORKS_DOMAIN, not a subdomain: config.everWorks.apps.getDomain() refuses an explicit apex
#    that is equal to, under or a parent of the platform domain, so apps.e2e.local would answer null.
EVER_WORKS_APP_LAUNCHER_ENABLED=true E2E_APP_LAUNCHER_SEED=true \
EVER_WORKS_APPS_DOMAIN=apps-e2e.local EVER_WORKS_DOMAIN=e2e.local \
EVER_WORKS_PLATFORM_CATALOG_BASE_URL=http://127.0.0.1:4084 EVER_WORKS_PLATFORM_CATALOG_ENV=develop \
  … node apps/api/dist/main.js &

# 4. The two files. Playwright needs the apex (it asserts the exact tile URL) and the base URL (it then
#    requires the catalog to have been READ). APW_E2E_FLAGS_ON_LANE=1 makes a switch that reads off a
#    failure instead of a skip — without it a mis-set stack reports named skips, not failures.
APW_E2E_FLAGS_ON_LANE=1 EVER_WORKS_APPS_DOMAIN=apps-e2e.local \
EVER_WORKS_PLATFORM_CATALOG_BASE_URL=http://127.0.0.1:4084 \
pnpm --filter ever-works-web exec playwright test --project=chromium \
  e2e/flow-app-launcher-apps.spec.ts e2e/flow-managed-subdomain-allocation.spec.ts
```

- **The job's env is the matrix's, key for key, plus exactly those deltas.**
  `apps/web/e2e/fakes/platform-catalog/__tests__/flags-on-lane.unit.spec.ts` (harness unit lane) reads
  `e2e.yml` and fails if the two drift, if either switch appears on the matrix, if the job stops running
  exactly the two files, or if the job's apps apex is one `config.everWorks.apps.getDomain()` would refuse.
  Change a matrix variable and the flags-on job's copy together. CI runs this check in `ci.yml`
  (`lint-and-test`), not in `e2e.yml`, so run
  `pnpm --filter ever-works-web test:e2e-harness flags-on-lane` yourself after editing either env block.
- **The fixture is the reader's to accept, not the fake's.** `…/__tests__/server.unit.spec.ts` feeds the
  served `platforms.json` and every icon to the API reader's own parser
  (`apps/api/src/app-launcher/platform-catalog.schema.ts`) and requires them accepted whole, so an edit that
  the reader would silently drop is a red harness run rather than a tile that quietly goes missing from both
  sides of ACC-E2E-12's catalog-versus-launcher comparison.
- **A catalog that was never read** shows up as `GET /api/app-launcher/platforms` answering
  `catalogVersion: null`. `curl http://127.0.0.1:4084/_control/calls` lists every read the fake answered,
  hit or miss; a `404` there names the path the API asked for. The flags-on job prints the same list when
  it fails.

### The fake's `_control` API — what a spec author may call

Added 2026-09-19 (C14). The fake had these endpoints from the start but documented them only in
`apps/web/e2e/fakes/github-fake/{control,state}.mjs`, which is not where a spec author looks when a case
"cannot be exercised". The census, so nobody has to open the source to arm a refusal:

| Endpoint                | Body / answer                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /_control/seed`   | `{ repositories[], users[], organizations[], catalog, blueprints }`. Idempotent; unknown keys ignored. A `users[]` entry maps a token **value** to a login once, which is what gives later requests an identity.                                        |
| `POST /_control/fault`  | `{ route, behaviour, method?, token?, tokenValue?, status?, body?, seconds?, times? }` → `200 { faults[] }`. Behaviours: `delay`, `never-ready`, `rate-limit`, `server-error`, `auth-refused`, `conflict`. An unknown `behaviour` is a `500` naming it. |
| `GET  /_control/calls`  | `{ calls[], count }` — `{ method, path, tokenIdentity, authenticated, faultApplied, status, at }` per request. The **identity**, never the value.                                                                                                       |
| `GET  /_control/faults` | `{ faults[] }` — what is still armed, in match order.                                                                                                                                                                                                   |
| `GET  /_control/state`  | The seeded repositories, user logins, organizations, catalog and Blueprints.                                                                                                                                                                            |
| `POST /_control/reset`  | Clears repositories, users, catalog, Blueprints, the call log and the fault queue. Keeps the git root.                                                                                                                                                  |

**Added 2026-09-19 (T45) — the upstream seed, and the switch that arms it.** `POST /_control/seed`
also takes two APW-09 keys, and they are the only gated ones:

| Key                             | Shape                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream_pull_requests[]`      | APW-09 plan §3.1's own column names: `{ id, userId, workId, sourceTaskId, upstreamOwner, upstreamRepo, baseBranch, headOwner, headRepo, headBranch, headSha, upstreamBaseSha, state, number, url, title }`. Idempotent on `id`. |
| `upstream_approval_proposals[]` | §6's proposal: `{ id, userId, agentId, title, subjectKey, status, payload: { workId, sourceTaskId, upstreamPullRequestId? } }`.                                                                                                 |

- **Armed only when `EVER_WORKS_E2E_FAKES === '1'` and `NODE_ENV !== 'production'`** — the fake's own
  `upstreamSeedGate`, the same two conditions the GitHub plugin's API-base switch keeps
  (`packages/plugins/github/src/e2e-fakes.ts`). Unarmed, the two keys are ignored and the seed answers
  `200 { seeded: { …, upstreamSeed: { applied: false, reason: 'switch-off' \| 'production' \| 'not-requested' } } }`.
  Everything else on the route is fake-GitHub fixture data and stays unconditional.
- **A proposal is matched to its row** by `payload.upstreamPullRequestId`, else by
  `(payload.workId, payload.sourceTaskId)`; the match writes both back (`payload.upstreamPullRequestId`
  on the proposal, `approvalProposalId` on the row). A proposal matching no row is a **`400`** naming the
  orphan — a lane whose "an `awaiting_approval` proposal is seeded" precondition quietly seeded nothing is
  the one failure this route can prevent.
- Read both back from `GET /_control/state` → `upstreamPullRequests[]`, `upstreamApprovalProposals[]`;
  `POST /_control/reset` clears them.
- `apps/web/e2e/helpers/github-fake-upstream.ts` is the recommended entry point: it posts the seed,
  **refuses the lane** when the fake reports `applied: false` (naming the switch), and reads the pair back.

**"The next matching call only" — the semantics that decide where a plant goes.** A fault is planted
with `times` (default **1**) and matched in plant order; each matching request takes one application and
the fault is dropped when its last one is spent. So a spec must plant **in the case's own setup,
immediately before the request under test** — never once in `global-setup`, never once for a file. The
fake is **one process shared by every worker and every spec file**, so the next matching call from
anywhere consumes it. "Matching" is the `route` method+pathname, narrowed by:

- `token` — the token **identity** the fake resolved (a login, or the literal `anonymous` / `unknown`).
  Use it when the case is about a _member's_ credential, which the fake has seeded.
- `tokenValue` — the token **value** the caller presents. Use it for a **dead** credential: the fake
  never seeded it, so it collapses to the identity `unknown` and an identity-narrowed fault cannot tell
  it apart from any other unknown token — nor survive a second lane arming its own. `apps/web/e2e/helpers/github-fake-control.ts`
  wraps both (`armDeadTokenRefusal` / `assertDeadTokenRefusalProven`) and is the recommended entry point.

⚠️ **`GET /user` answers 200 for every token by default** (it is the `user` fixture route). A case that
means to prove "this credential is dead, so this surface refuses" must arm `auth-refused` for it;
otherwise the identity resolves and the request fails later at a _different_ gate — for
`POST /api/register-work` that is `gh_repo_access_denied` from `assertRepoAccess`, not
`gh_credential_invalid` from `resolveGitHubIdentity`. Both are `403`, so only the typed `code` tells
them apart.

### The fake's upstream (APW-09) endpoints — added 2026-09-19 (T45)

APW-09's upstream lanes read and write more GitHub than APW-13's did. The subset, and the field each
consumer reads (`packages/plugins/github/src/github-api.service.ts`):

| Endpoint                                               | Answers                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /repos/:o/:r/git/refs/*ref`                    | `204`, and the ref is really removed — a following `GET …/git/refs/heads/<branch>` is a `404`. This is **Withdraw**'s branch delete (FR-33/FR-45). |
| `GET /repos/:o/:r/interaction-limits`                  | `200 { limit, origin, expires_at }` when seeded; GitHub's own **`204`** when not, which the plugin maps to `null` and never to `'none'`.           |
| `GET /repos/:o/:r/commits/:ref/check-runs`             | `{ total_count, check_runs[] }`; each run carries `name`, `status`, `conclusion`, `details_url`.                                                   |
| `GET /repos/:o/:r/commits/:ref/statuses`               | The commit statuses; `readChecks` keys them by `context`, newest first.                                                                            |
| `GET /repos/:o/:r/commits/:ref/status`                 | The combined status, **rolled up** from the statuses above (any `failure`/`error` wins, then `pending`, else `success`) rather than asserted.      |
| `POST /git/refs`, `PATCH /git/refs/*ref`               | Already served (APW-02/03); pinned by T45 so they cannot regress.                                                                                  |
| `GET /repos/:o/:r/compare/:basehead`                   | Already answered `total_commits` (APW-09 T1); pinned by T45.                                                                                       |
| `GET /repos/:o/:r/pulls/:n`, `…/reviews`, `…/comments` | Already served (PR status, review follow-up); pinned by T45.                                                                                       |

`checkRuns` and `commitStatuses` are **seedable per repository** so a lane can exercise the states the
acceptance rows turn on (`action_required` → _waiting for maintainers_, ACC-09-17; a red check; a
`pending` status). The PR-lane catalog (`fixtures/catalog-pr-lane.seed.json`) seeds
`ever-works/cal-diy-template` with an `action_required` `build` run, a green `lint` run, one green
commit status and a `collaborators_only` interaction limit. Unseeded, a repository answers the one
deterministic green run and green status `routes/commits.mjs` derives.

### Traps that cost real time

- **Windows:** `Start-Process pnpm` does not launch — use `pnpm.cmd`. A failed launch shows up later as
  `ERR_CONNECTION_REFUSED` from Playwright, not as a clear error.
- **A `PORT` set for the API leaks into `next start`.** The web then tries the API's port, dies with
  `EADDRINUSE`, and Playwright fails at the login page. Set the web's port **after** the API has started.
- **The worker answers 200 even when it is useless.** Without `TRIGGER_INTERNAL_SECRET` it starts
  _degraded_: its health endpoint returns 200 with `{"status":"degraded","boot":{"ok":false}}` and every
  `POST /run` answers 503. Read `boot.ok`, never the status code alone. `TRIGGER_INTERNAL_API_URL` is
  defaulted; the secret deliberately never is.
- **The API takes minutes to boot on a loaded machine** (route-table compilation). The workflow's
  readiness loop retries with connection refused until it answers; that is expected, not a failure.
- **Four variables are load-bearing in ways the first version of this runbook did not say**, each of which
  cost a stack restart to find (recorded by APW-13 T63, 2026-09-18):
    - `pnpm --filter @ever-works/github-plugin build` **before** the API, or every GitProvider read answers
      `connected: false` and the lane looks unconnected rather than unbuilt (§4 step 1a).
    - `REQUIRE_EMAIL_VERIFICATION=false`, or `POST /api/auth/login` answers **403 "Email not verified"** and
      the Playwright global setup dies before a single spec runs.
    - `DEPLOY_EVER_WORKS_ENABLED=true`, or the managed-subdomain lane's cap and allocation-boundary cases
      cannot run — without it the platform rewrites `deployProvider: 'ever-works'` to `'vercel'` and the cap
      is unreachable. Since 2026-09-25 they read the switch from the API and skip by name when it is off
      (and fail instead under `APW_E2E_FLAGS_ON_LANE=1`, the flags-on recipe above).
    - `GITHUB_APP_WEBHOOK_SECRET` must reach the **Playwright** process as well as the API, or the four
      intake specs self-skip instead of signing their own deliveries.
- **The fake GitHub reads `PORT` too, and defaults to 3900 — so a script that has already exported
  `PORT=3100` for the API silently starts the fake ON THE API'S PORT.** The symptom is maddening and worth
  recognising by shape: the API logs `Nest application successfully started` and maps `/api/health`, both
  processes are listening, and **every client gets `404` for `/api/health`** — because on Windows the
  fake's IPv4 `127.0.0.1` bind wins IPv4 client calls over the API's IPv6 `::` bind, and `SO_REUSEADDR`
  lets both binds succeed. Meanwhile `:3900` answers nothing, so `APW_E2E_GITHUB_FAKE_URL` points at air.
  Set `PORT=3900` for the fake's own process (step 1), then `PORT=3100` for the API, and assert the fake
  answers on **3900** and that **3100 has no owner** before starting the API. Cost: one full battery run
  that reported a healthy API and then failed four specs on a 404 health check.
- **Running ONE spec file on its own (`--no-deps`, or a single file) skips what the lane does for it**
  (recorded while proving ACC-NEG-07's delete Activity row, 2026-09-25):
    - `--no-deps` skips the `setup` project, but the `chromium` project still reads its `storageState`
      from `apps/web/e2e/.auth/user.json`, so that file must already exist. `{"cookies":[],"origins":[]}`
      is enough for request-only specs.
    - A spec that calls `connectCustomerGitHub` before it seeds the fake (for example
      `flow-app-work-delete-retains.spec.ts`, which connects and only then seeds inside its create
      helper) needs a manual `POST /_control/seed` with
      `apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json` first. On a fresh fake the
      connection otherwise reads "unknown" and S10 throws; in a full shard an earlier spec has already
      seeded it.
    - `EVER_WORKS_E2E_FAKES=1` must be set in the **Playwright** process as well
      (`helpers/github-estate.ts` resolves the fake's origin only while it is `1`).
    - The three auth-throttle variables `e2e.yml` sets (`REGISTER_THROTTLE_LIMIT`, `LOGIN_THROTTLE_LIMIT`,
      `E2E_DISABLE_AUTH_THROTTLE`, now in §4 step 2) are needed on the API, or repeated local runs hit
      `registerUserViaAPI failed (429)`.
- **A concurrent build of a workspace package can wipe `apps/api/dist` mid-build.** Rebuilding
  `packages/plugin` or `packages/agent` in another process while the API is building produces phantom type
  errors and an empty `dist`; if the API stops starting, rebuild it **after** the package builds finish
  rather than chasing the errors.

---

## 5. What each refusal means, and what to do

| Symptom                                                                                                 | Meaning                                                                                                                                                                                                                         | Action                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APW_E2E_RUN_ID is not set`, `… is not in APW_E2E_ALLOWED_BASE_URLS`, `APW_E2E_TOKEN_BUDGET is not set` | one of the seven interlocks refused **before** anything ran. The message names the variable and the plan clause                                                                                                                 | set it. All of them are in the workflow's env block — copy from there rather than inventing values                                                                                                    |
| `S10: no supported GitHub connection surface for this run account`                                      | **since T63 this no longer means "the platform has no surface"** — surface (b) landed and the message names what the _account_ lacks: neither a seeded OAuth row nor the operator-run connect. Surface (a) is named as declined | arm the seeding route (`EVER_WORKS_E2E_FAKES=1` **and** `APW_E2E_GITHUB_FAKE_URL`, on the API process) so `connectCustomerGitHub` can seed, or run the lane with the fixtures that need no connection |
| `neither APW_E2E_USER_CLUSTER_CONTEXT nor APW_E2E_APPS_TIER_CONTEXT is set`                             | interlock 2 (plan §8.5): the **live** lanes place real workloads, so they refuse without an allow-listed kube context                                                                                                           | set one of the two and hand the lane a cluster you are willing to let it write to. The five PR-lane specs (`playwright.config.ts`) need no cluster — that is the half a laptop can run                |
| A job pauses with a named reason instead of failing                                                     | the credential of record is unusable (member left, access lost, scope withdrawn) — FR-43                                                                                                                                        | hand the credential over from the UI, or re-connect the member's GitHub; nothing upstream was touched                                                                                                 |
| `waiting: 'budget'` / the member sees a reset time                                                      | the Work's own budget refused the run (FR-44)                                                                                                                                                                                   | wait for the reset, or raise the Work's budget. The row keeps its state and nothing was opened                                                                                                        |
| `dispatch_unavailable` on fork readiness                                                                | no App runtime worker is reachable                                                                                                                                                                                              | check the worker's `boot.ok` (§4); in CI, that the step is enabled and the secret is set                                                                                                              |
| A shard fails with API timeouts under load                                                              | fleet contention, not a defect                                                                                                                                                                                                  | reproduce locally (§4) before opening anything                                                                                                                                                        |
| skipped: `EVER_WORKS_APP_LAUNCHER_ENABLED is off …` or `DEPLOY_EVER_WORKS_ENABLED is off …`             | the 32-shard matrix, where both switches are off on purpose: the two flags-on files read the switch from the API and skip by name there                                                                                         | nothing on the matrix — the cases run on the flags-on job; locally, use the flags-on recipe (§4)                                                                                                      |
| `STACK: this is the flags-on job (APW_E2E_FLAGS_ON_LANE=1) … but …`                                     | the flags-on job's API is missing the switch the message names, so the case fails rather than skip                                                                                                                              | restore the variable in the job's env; `flags-on-lane.unit.spec.ts` (harness lane) pins that env against the matrix's                                                                                 |
| `STACK: EVER_WORKS_PLATFORM_CATALOG_BASE_URL is set, but the API served no catalog`                     | the catalog fake was unreachable, the API runs without `EVER_WORKS_E2E_FAKES` (the override is gated on it), or it asked for other coordinates                                                                                  | read the job log's "platform-catalog fake log and catalog reads" group — a `404` there names the path the API asked for                                                                               |

---

## 6. Leftovers

- **Namespaces.** Live lanes create real namespaces. The estate file (`APW_E2E_ESTATE_PATH`) carries
  the cleanup list; the lane's cleanup step reads it. If a run died before cleanup, drive the cleanup
  from that file rather than deleting by hand — the file is the only record of what the run created.
- **Throwaway accounts and Agents.** Every run seeds them from `APW_E2E_RUN_ID`, which is why every
  run-unique name is derived from it (ACCEPTANCE §0.4). Re-using a run id re-uses the account; changing
  it leaves the old one behind for the cleanup step.
- **The fake's data** is in-process and dies with the server, except for the git roots it writes under
  the system temp directory — clear those if a probe was killed mid-clone.

---

## 7. See also

- `docs/internal/app-works-test-estate.md` — the two Organizations the lanes use and the estate gaps.
- `docs/specs/features/app-works/APW-13-golden-paths/plan.md` — §8 is the lane's design, §9.1 its wiring.
- [`apps/web/e2e/COVERAGE.md`](../../apps/web/e2e/COVERAGE.md) — which spec covers which acceptance id.
- `docs/internal/app-works-build-progress.md` — the build ledger: what is landed, what is routed, and the
  programme's own traps (§5 is the routed-findings register).
