# App Works — local quickstart

**Status:** `Draft` · **Created:** 2026-09-17 · **Program:** [App Works](./README.md)
**Closes:** `SK-12` (no local quickstart, although no CI lane runs on pull requests and authors run the
suites locally)
**Owner:** [APW-13](./APW-13-golden-paths/spec.md)
**Companion documents:** [ACCEPTANCE.md](./ACCEPTANCE.md) §0 (**read this first** — the lanes, the binding
environment rules, the test estate, secrets by name only, the harness rules) · [CONFIGURATION.md](./CONFIGURATION.md)
§4 (the per-environment inventory this file makes runnable) · [CONTRACTS.md](./CONTRACTS.md) §7 ·
[data-model.md](./data-model.md) §4 (the re-stamp procedure) ·
[`contracts/README.md`](./contracts/README.md) §3 (regenerating the OpenAPI document)

---

## 0. Why a local quickstart exists

> _"Current CI policy runs no workflow on `pull_request`, so authors run the new specs locally before
> merge."_ — [ACCEPTANCE.md](./ACCEPTANCE.md):36

`.github/workflows/e2e.yml` has **no `pull_request` trigger and no `develop`/`main` push trigger** — it runs
on a push to `stage` and on `workflow_dispatch` (`.github/workflows/e2e.yml:10-11,58-61`). The App Works
specs therefore have to be green on a developer's machine **before** the PR exists. This file is that path.

**Two things this document is not.** It is not a substitute for the lane table
([ACCEPTANCE.md](./ACCEPTANCE.md) §0.1), and it never prints a secret value — every credential below is a
**name** ([ACCEPTANCE.md](./ACCEPTANCE.md) §0.4).

> **Build state, stated honestly (2026-09-17).** APW-13 is specified and **not implemented**: the fake GitHub
> server, `playwright.app-works.config.ts`, the live setup project, the harness helpers, the app-works
> fixture specs and three of the four workflows **do not exist yet**. Every step below that depends on them
> names the task that creates it. Steps 1–4 (prerequisites, env, SQLite, start the stack) work today; steps
> 5–9 work as each APW-13 task lands.

---

## 1. Prerequisites

| What                            | Minimum                                                                                                                                                                              | Where it comes from                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**                     | `>= 22`                                                                                                                                                                              | root `package.json:64-67` (`"engines": { "node": ">=22" }`); `apps/mcp/package.json:48-50` (`>=22.0.0`); CI pins `'22'` (`.github/workflows/k8s-e2e.yml:72`)                                |
| **pnpm**                        | `>= 9.9.0`                                                                                                                                                                           | root `package.json:66`; the repository pins `packageManager: "pnpm@10.33.3"` (`package.json:68`) and CI uses `10.33.3` (`.github/workflows/k8s-e2e.yml:67`)                                 |
| **git**                         | any recent version, with **`git http-backend`** available                                                                                                                            | the fake GitHub serves repositories over git smart HTTP through `git http-backend` ([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §8.3), so a git built without it cannot serve a clone |
| **Docker + `kind` + `kubectl`** | **not version-pinned by this repository — no document states a required version.** Docker Compose is separately documented as needing v2.20+ for the _server_ path (`README.md:185`) | needed **only** for the **PR — cluster** lane ([ACCEPTANCE.md](./ACCEPTANCE.md):37)                                                                                                         |
| **MailHog-compatible sink**     | any                                                                                                                                                                                  | `MAILHOG_URL` ([ACCEPTANCE.md](./ACCEPTANCE.md):127); CI runs `mailhog/mailhog:latest` on 1025/8025 (`.github/workflows/e2e.yml:121-125`)                                                   |
| **Redis** (optional)            | any                                                                                                                                                                                  | CI runs `redis:7-alpine` on 6379 (`.github/workflows/e2e.yml:126-129`); locally `docker compose -f docker-compose.infra.yml up -d` (`README.md:231`)                                        |

**Check what the repository's own script checks.** `.specify/scripts/bash/check-prerequisites.sh:19-22` and
`.specify/scripts/powershell/check-prerequisites.ps1:19-22` test **exactly three commands — `pnpm`, `node`,
`git`** and print their versions. They check **no** docker, kind, kubectl or Playwright, and they **enforce
no version** (the `10+` / `20+` in their hint strings are prose, and `20+` is looser than the repo's real
`>= 22` floor).

```bash
# one-liner that matches the repo's own floor (run from the worktree root)
node --version && pnpm --version && git --version
```

---

## 2. Environment

Copy the two templates (this is the repository's documented path —
`README.md:218-219`, `docs/environment-variables.md:14-15`):

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

### 2.1 The App Works switches (both halves)

The kind gate is **two** settings, and a chip without the API gate always refuses (R-6):

```bash
# apps/api/.env  — the API gate. Without it, create/inspect answer 400 app_works_disabled
# from every client (web, chat, MCP and CLI).
EVER_WORKS_APP_WORKS_ENABLED=true

# apps/api/.env — enable the App runtime worker in-process (refused when NODE_ENV=production).
EVER_WORKS_APPS_LOCAL_WORKER=true
```

```dotenv
# apps/web/.env.local — the web evaluates the chip flag fail-closed for kind `app`.
# Put `works-app` in the PostHog project the web points at (POSTHOG_API_KEY / POSTHOG_HOST
# are read by apps/web/src/lib/feature-flags/work-kinds.ts:36-50). No value goes in this file.
```

`works-app` is a **PostHog** flag, not an env variable; the env twin is `EVER_WORKS_APP_WORKS_ENABLED`.
`EVER_WORKS_APP_LAUNCHER_ENABLED=true` + the `app-launcher` flag and `EVER_WORKS_APPS_MANAGED_ENABLED`
(master ceiling — leave it `false` locally) follow the same twin pattern. The full per-environment matrix,
including which variables must stay **unset** locally, is [CONFIGURATION.md](./CONFIGURATION.md) §4.1.

### 2.2 Pointing the platform at the fake GitHub

```bash
# apps/api/.env — BOTH are required. EVER_WORKS_E2E_FAKES is ignored when NODE_ENV=production,
# and the switch lives inside the GitHub plugin (APW-13 plan §8.3).
EVER_WORKS_E2E_FAKES=1
APW_E2E_GITHUB_FAKE_URL=http://127.0.0.1:3900

# apps/api/.env — a kind/loopback ingress is a private address, which the App runtime refuses
# unless the CIDR is listed (APW-13 plan §8.4). Locally, add the Docker network's CIDR that
# `docker network inspect kind` reports — never guess it.
EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST=127.0.0.1/32,172.18.0.0/16

# apps/api/.env — a test catalog, so the fixture Blueprint resolves. Pin it to a commit of the
# catalog's `e2e` branch (ACCEPTANCE §0.3). NEVER point local at production's ref.
EVER_WORKS_APPS_CATALOG_REF=<commit-sha-of-the-templates-e2e-branch>

# Add ONLY if you want the fork-readiness timer shortened for a test; honoured outside production
# only, clamped 5 000–900 000 ms.
EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS=15000
```

Leave `EVER_WORKS_APPS_DOMAIN`, `EVER_WORKS_APPS_DNS_ZONE_ID` and `EVER_WORKS_APPS_DNS_API_TOKEN`
**unset** so the shared default apex applies and **no real DNS zone is ever written**
([`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T34; [CONFIGURATION.md](./CONFIGURATION.md) §4.1).

### 2.3 The test harness's own variables

The live lanes read `APW_E2E_*` names — `APW_E2E_LIVE`, `APW_E2E_ALLOWED_BASE_URLS`,
`APW_E2E_TOKEN_BUDGET`, `APW_E2E_GITHUB_USER_TOKEN`, … — all listed **by name only** in
[ACCEPTANCE.md](./ACCEPTANCE.md) §0.4. **Do not run a live lane locally unless you are deliberately
pointing it at dev or stage and have satisfied every interlock** (§10 below).

---

## 3. The database — SQLite by default

Nothing to install for the default path: `DATABASE_TYPE` defaults to a SQLite engine and development
defaults to **in memory**.

| Fact                                                                                                    | Where                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_TYPE` defaults to `better-sqlite3`                                                            | `packages/agent/src/config/index.ts:663-665`                                                                                                                                                                                                     |
| `sqlite` / `sqlite3` are aliased to `better-sqlite3`                                                    | `packages/agent/src/database/database.config.ts:131-133`                                                                                                                                                                                         |
| Development and test default to `:memory:` unless `DATABASE_IN_MEMORY=false`                            | `database.config.ts:151-157`                                                                                                                                                                                                                     |
| An unknown type falls back to SQLite in memory                                                          | `database.config.ts:220-225`                                                                                                                                                                                                                     |
| The seven modes the specs must work on: **SQLite**, Postgres on dev/stage/production, and MySQL/MariaDB | `apps/api/src/migrations/1786900001000-CreateGoalEvents.ts:33`; [data-model.md](./data-model.md) §5                                                                                                                                              |
| Postgres locally, when you want it                                                                      | `DATABASE_TYPE=postgres` in `apps/api/.env` (`apps/api/.env.example:88` shows the SQLite default; `.env.compose:147` shows the Postgres value the compose stack uses), plus `docker compose -f docker-compose.infra.yml up -d` (`README.md:231`) |

**Why this matters for an App Works change.** The PR lane and the demo run **SQLite**; dev, stage and
production run **Postgres**. A partial index, a `FOR UPDATE`, a nullable-column uniqueness rule or a
dialect-specific type that works on one and not the other is a defect the local run must catch. The rules are
collected in [data-model.md](./data-model.md) §5.

---

## 4. Start the stack

```bash
pnpm install          # README.md:215
pnpm build            # README.md:220 — build workspace packages first (Turborepo orders the graph)

pnpm dev:api          # API on http://localhost:3100   (README.md:223)
pnpm dev:web          # Web on http://localhost:3000   (README.md:224)
# or both: pnpm dev:apps  (README.md:222)
```

There is **no root `pnpm dev` script** (`package.json:20-22` defines `dev:apps`, `dev:api`, `dev:web` and
nothing named `dev`). The API applies pending migrations on startup
(`README.md:230`: _"The API self-applies pending database migrations on startup, so there is nothing to run
manually on a fresh setup"_).

Playwright does **not** start the stack for you: `apps/web/playwright.config.ts:94-110` has its `webServer`
block commented out, and its header states the pairing it expects (`:7-8` — API on 3100 via `pnpm dev:api`,
web on 3000 via `pnpm dev:web`).

> **Use `127.0.0.1`, not `localhost`, in every origin you set.** The dev API and web bind IPv4 only; a
> `localhost` origin can resolve to IPv6 `::1` first and fail while the health gate passes — the exact
> failure CI documents at `.github/workflows/e2e.yml:426-432`. This bites Windows identically.

---

## 5. The fake GitHub, and the App runtime worker

**Build state: the fake GitHub does not exist yet.** `apps/web/e2e/fakes/github-fake/` is created by APW-13
P0 T1–T5 ([`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T1/T2/T3; the entry file is named at T1 as
`server.mjs` with `PORT` default **3900**). Once it lands:

```bash
# from the worktree root — start it BEFORE the API, as the PR lanes do
node apps/web/e2e/fakes/github-fake/server.mjs        # serves on :3900
```

What it offers ([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §8.3):

- a REST subset recorded from the real GitHub API into `fixtures/*.json` — `GET /user`, `GET /user/orgs`,
  `GET /repos/:o/:r`, `POST /repos/:o/:r/forks`, `POST /repos/:o/:r/generate`,
  `POST /repos/:o/:r/merge-upstream`, `GET /repos/:o/:r/compare/:basehead`, the pull-request routes,
  `…/contents/:path`, `…/actions/permissions`, `…/actions/workflows`, `…/license`;
- **git smart HTTP** over bare repositories on disk through `git http-backend`, so clone and push work
  against the `clone_url` the fake advertises;
- a **control API**: `POST /_control/seed` (the fixtures a spec needs), `POST /_control/fault`
  (`delay`, `never-ready`, `rate-limit`, `server-error`, `auth-refused`, `conflict`) and
  `GET /_control/calls` — every recorded call, which is how a spec asserts **"no GitHub write happened"**.

**Then the worker — easy to miss and it will cost you an afternoon.** App cluster I/O runs in the App runtime
worker, not in the API process, so the fake-GitHub PR lane must start it too
([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §9.1, added 2026-09-17):

```bash
EVER_WORKS_APPS_LOCAL_WORKER=true \
  pnpm --filter @ever-works/trigger-tasks app-runtime:local-worker
# CI then waits on it:  npx wait-on --timeout 30000 http-get://127.0.0.1:3101/health
```

---

## 6. Create an App Work from the fixture URL

The fixture application is **`ever-works/app-fixture-hello`** (source only, no `.works/`); its Blueprint is
`ever-works/app-fixture-hello-template` ([CONTRACTS.md](./CONTRACTS.md) §8;
[ACCEPTANCE.md](./ACCEPTANCE.md) §0.3).

1. Open `http://127.0.0.1:3000`, sign in, and start **Create Work**.
2. Pick the **App** chip, paste `https://github.com/ever-works/app-fixture-hello`, and let the preview run.
   The preview is `POST /api/works/app-source/inspect` — it **always answers `200`** for a provider-side
   refusal, with the reasons in the body, because nothing failed on our side
   ([`APW-01/plan.md`](./APW-01-app-work-kind/plan.md) §4.1).
3. Create. `POST /api/works` with `kind: 'app'` and `repositoryMode: link` (you can push to your own
   fixture) or `fork`/`private-copy` with a `targetOwner`.
4. Watch the Upstream tab at `/works/:id/upstream`.

**What you should see in Activity, in this order** ([CONTRACTS.md](./CONTRACTS.md) §6):

| Step                       | Event                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create                     | `app.source.linked` · `app.source.forked` · `app.source.copied` (one of them)                                                                             |
| readiness                  | `app.fork.ready` (or `app.fork.timeout`, which is also covered by `app.fork.missing`)                                                                     |
| Actions hygiene            | `app.actions.disabled`                                                                                                                                    |
| spec                       | `app.spec.validated` → `app.spec.applied`                                                                                                                 |
| Blueprint (fixture path)   | `app.blueprint.matched` → `app.blueprint.applied`                                                                                                         |
| licence                    | `app.license.classified`                                                                                                                                  |
| provisioner (no Blueprint) | `app.provision.started` → `app.provision.proposed` → `app.provision.succeeded` (or `…failed`, `…needs_input`)                                             |
| build                      | `app.build.queued` → `app.build.started` → `app.build.succeeded` (or `…failed`, `…cancelled`)                                                             |
| deploy                     | `app.deploy.started` → `app.job.*` in execution order → the terminal `app.deploy.succeeded` \| `failed` \| `rolled_back` → `app.smoke.passed` \| `failed` |

**How a wait must be written.** Poll, never sleep: `expect.poll` or the harness's
`waitForActivity(workId, type, deadline)`; **`page.waitForTimeout` is banned in these specs**
([ACCEPTANCE.md](./ACCEPTANCE.md):141). Every wait must also watch the terminal failure events of the same
step (`app.build.failed`, `app.deploy.failed`, `app.deploy.rolled_back`, `app.job.failed`,
`app.smoke.failed`, `app.provision.failed`, `app.change.failed`, `app.upstream_pr.refused`,
`app.fork.timeout`, and `app.provision.needs_input`) and fail at once with the payload and the logs URL
([ACCEPTANCE.md](./ACCEPTANCE.md):143-146). A wait that only greps for success is worse than none.

**The fixture image path (`build.strategy: image`).** The fake cannot run GitHub Actions, so the PR — cluster
lane uses the fixture's **published image tags** with `build.strategy: image` instead of building
([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §4.3; `build.strategy` values are
`dockerfile | image | auto | none`, R-13). That is the profile to select locally too.

---

## 7. Migrations and the OpenAPI artifact

```bash
# generate a migration skeleton into the epic's reserved block, then re-stamp it (data-model.md §4)
pnpm --filter ever-works-api migration:generate -- src/migrations/<timestamp>-<Name>

pnpm --filter ever-works-api migration:run      # or just start the API — it self-applies
pnpm --filter ever-works-api migration:show
pnpm --filter ever-works-api schema:log         # what TypeORM would change, without changing it
```

The reserved-timestamp shape is **`1792` + two-digit epic + two-digit slot + `00000`** (README §7 rule 6);
the 19 files the programme reserves are tabulated in [data-model.md](./data-model.md) §4, together with the
re-stamp rule. A migration whose `down()` drops more than its `up()` created fails review.

**The OpenAPI document is generated, never committed:**

```bash
pnpm --filter ever-works-api build
pnpm --filter ever-works-api generate:openapi     # writes apps/api/openapi.json (git-ignored)
```

`apps/api/package.json:19` defines the script; `.gitignore:80-81` ignores the output. The MCP server reads
that document (or a copy bundled at `EVER_WORKS_OPENAPI_SPEC_PATH`) to build its tool schemas, so **a DTO
property without `@ApiProperty` silently removes a tool argument**. Regenerate and run the fragment check
before pushing an API change — see [`contracts/README.md`](./contracts/README.md) §3.

---

## 8. The kind path (the PR — cluster lane, locally)

**Build state: `playwright.app-works.config.ts`, the kind specs and `.github/workflows/app-works-kind.yml`
do not exist yet** (APW-13 T34/T35). The steps the lane performs, which you can mirror by hand today:

```bash
# 1. a kind cluster (CI uses helm/kind-action v1, cluster name `ever-works-e2e`, wait 120s)
kind create cluster --name ever-works-e2e --wait 120s

# 2. ingress-nginx, the same manifest CI applies
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=180s

# 3. export the kubeconfig (the harness reads APW_E2E_KIND_KUBECONFIG_PATH;
#    CI exports the same file as KUBECONFIG_E2E_PATH)
kind get kubeconfig --name ever-works-e2e > ./kind-kubeconfig
```

Then paste it as the App Work's custom kubeconfig and **say that the cluster's address is private**:

- The kubeconfig must be a **service-account** kubeconfig carrying `certificate-authority-data` and **no**
  `client-certificate` / `client-key` — that is what the kubeconfig guard requires.
- Set `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` to the CIDRs the API will see. A kind API is a
  container-network address or loopback; read the real CIDR with
  `docker network inspect kind` rather than guessing ([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §8.4).
  Without the allowlist **every Deployment in the lane is refused**.
- `EVER_WORKS_APPS_DNS_ZONE_ID` / `EVER_WORKS_APPS_DNS_API_TOKEN` stay unset and
  `EVER_WORKS_APPS_DOMAIN` stays unset, so the shared default apex applies and no real DNS is written.
- Host names resolve to the kind ingress through a public wildcard-DNS resolver (accepted for this lane
  only); a per-App-Work `/etc/hosts` entry is the fallback.

**The live-marker check.** Whenever a scenario claims "the change is live", it must first prove the marker is
**absent**, then prove it is present **and** that `GET /marker` reports the expected commit
([ACCEPTANCE.md](./ACCEPTANCE.md):22-26,150-151). The fixture exposes `GET /marker` returning
`{ marker, sha, buildLabel, publicUrl, greeting }`. A check that can only ever return "found" is not a check.

---

## 9. Running the suites

**Lane commands.** The PR lane's form is written into the tasks
([`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md):29):

```bash
cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test <spec>
```

Real, existing script names (`apps/web/package.json`) — the sharded suite runs through the config whose
`testDir` is `./e2e`:

```bash
# the whole Playwright suite (long: ~1670 tests)
pnpm --filter ever-works-web test:e2e
# or from apps/web
pnpm exec playwright test --shard=1/32          # CI shards it 32 ways (.github/workflows/e2e.yml:103-107)

# one App Works spec by name, with the fake
cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-app-work-create-from-url
```

Spec naming (APW-13 §8.1) — the name tells you which lane it belongs to:

| Kind                       | Pattern                         | Runs in                       | Gate                                                   |
| -------------------------- | ------------------------------- | ----------------------------- | ------------------------------------------------------ |
| Deterministic, fake GitHub | `flow-app-work-*.spec.ts`       | `e2e.yml` shards (`chromium`) | self-skips unless `EVER_WORKS_E2E_FAKES=1`             |
| Security pins              | `sec-pin-app-works-*.spec.ts`   | `e2e.yml` shards              | same                                                   |
| kind cluster               | `flow-app-works-kind-*.spec.ts` | `app-works-kind.yml`          | `test.skip(!APW_E2E_KIND_KUBECONFIG_PATH)`             |
| Live                       | `flow-app-works-live-*.spec.ts` | nightly / golden path         | `test.skip(APW_E2E_LIVE !== '1')`, then the interlocks |

**Unit and API suites** (R-22: `apps/api/test/*.e2e-spec.ts` is **not** a runnable lane — API behaviour is
tested by Jest specs under `apps/api/src/**` or by request-level Playwright specs under `apps/web/e2e/`):

```bash
pnpm --filter ever-works-api test          # Jest, single worker (apps/api/package.json:22)
pnpm --filter ever-works-web test          # Vitest  (apps/web/package.json:24)
pnpm --filter ever-works-mcp test          # Vitest  (apps/mcp/package.json:20)
pnpm test                                  # turbo run test --continue (package.json:40)
pnpm type-check && pnpm lint
```

APW-04's sandbox-isolation live spec is the one that needs an explicit live switch and otherwise reports
**skipped, never failed** ([ACCEPTANCE.md](./ACCEPTANCE.md):44-47):

```bash
APW_E2E_LIVE=1 pnpm --filter @ever-works/claude-managed-agent-plugin test -- provision-sandbox-isolation.live
```

One integration spec self-skips without a variable the kind lane sets
([`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T35):

```bash
pnpm --filter @ever-works/agent test ever-works-db-provision.integration   # skips without EVER_WORKS_DB_PROVISION_IT_URL
```

---

## 10. Teardown, and what never to run locally

**Never locally, ever** ([ACCEPTANCE.md](./ACCEPTANCE.md) §0.2, binding):

1. **Production is never a target** for anything that creates a Work, forks, builds, deploys, calls a model
   or writes anything. The only production traffic anywhere in this programme is the Deployed smoke lane's
   read-only route rows.
2. **Destructive and spending scenarios run on dev or stage only.** The live harness refuses to start unless
   the web and API origins are in `APW_E2E_ALLOWED_BASE_URLS`.
3. **No App Work under test deploys to a cluster that hosts Ever Works or any production product.** Test
   clusters are dedicated and live in the private operations repository.
4. **Namespaces are torn down only in test clusters**, only when the kube context is in the allow-list, and
   only by the harness. The product deletes volumes and dependency data only when the owner ticks **Also
   delete stored data** and types the App Work's slug — **automation never exercises that path**.
5. **Upstream pull requests target test upstreams only.** The harness hard-fails before proposing one whose
   base owner is not `APW_E2E_UPSTREAM_ORG` — **never a real third-party repository**.
6. Live lanes run `retries: 0` and `workers: 1` on purpose: a retry could create a second fork, PR or Build
   and mask a double-execution defect.
7. **Never add a repository-delete call under `apps/web/e2e/`** ([`APW-13/tasks.md`](./APW-13-golden-paths/tasks.md) T9 enforces it).

**Cleanup, once you are done with the fake path:**

```bash
# stop the fake GitHub and the local worker (Ctrl-C in their shells), then:
kind delete cluster --name ever-works-e2e        # test cluster only
rm -f apps/web/e2e/.auth/app-works-estate.json    # the run's estate file (git-ignored, like .auth/)
```

Forks, private copies and per-run upstreams created by a **live** run are **never deleted by automation** —
they are archived, labelled `apw-e2e-expired` and pruned quarterly by a person
([ACCEPTANCE.md](./ACCEPTANCE.md):165).

---

## 11. Troubleshooting

### 11.1 The create form refuses before it starts

| Symptom                            | Cause                                                                                                                                                                                    | Fix                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The **App** chip is missing        | PostHog flag `works-app` is not on for this environment — the chip is evaluated **fail-closed for this one kind**, unlike every other `works-<kind>` chip (R-6)                          | create the flag in the PostHog project the web points at; check `POSTHOG_API_KEY` is set (`apps/web/src/lib/feature-flags/work-kinds.ts:36-50`) |
| `400 app_works_disabled`           | `EVER_WORKS_APP_WORKS_ENABLED` is unset/false — the API refuses create **and** inspect from every client, including chat, MCP and the CLI (R-6)                                          | set it `true` in `apps/api/.env` and restart the API                                                                                            |
| `400 invalid_url`                  | the URL did not parse or names another provider                                                                                                                                          | paste a plain `https://github.com/<owner>/<repo>` URL                                                                                           |
| `400 managed_hosting_unavailable`  | the managed target was chosen and `AppsTierPolicy.isOpen()` is false — locally it always is, since `EVER_WORKS_APPS_MANAGED_ENABLED` is the ceiling and the tier must also be **opened** | choose **Your cluster** or **None** (R-5, R-12)                                                                                                 |
| `400 cluster_target_unavailable`   | the named deploy plugin is not enabled for you or advertises no App support                                                                                                              | pick an enabled apps-capable provider, or set the target to **None**                                                                            |
| `409 app_work_exists`              | an equivalent App Work already exists (same slug, created within 600 s)                                                                                                                  | open the existing Work, or change the slug                                                                                                      |
| `409 create_in_progress`           | another create for the same `user + upstream + mode + owner` holds the lock (120 s TTL)                                                                                                  | wait and retry                                                                                                                                  |
| `503 rate_limited` + `Retry-After` | GitHub rate-limited the probe                                                                                                                                                            | wait for `Retry-After`; the preview answers `200` with `rate_limited` in the body rather than failing                                           |

### 11.2 The spec will not validate

The issue codes are **`APP_SPEC_ISSUE_CODES`** (append-only) — _not_ `APW_SPEC_ISSUE_CODES`, which does not
exist. The authoritative list with severity and meaning is
[`APW-03-app-spec-and-catalog/schema.md`](./APW-03-app-spec-and-catalog/schema.md) and the executable
mapping in [`_build-artifacts/apw-03-schema/validator-rules.md`](./_build-artifacts/apw-03-schema/validator-rules.md).
The ones a first App spec hits most:

| Code                                                           | Meaning                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `unknown_field`                                                | an unknown key inside `spec` — `x-` keys are the only exception (C1)                       |
| `reserved_env_name`                                            | an env entry starting `EVER_WORKS_` — that prefix is reserved for platform-injected values |
| `components_require_strategy` / `strategy_requires_components` | `components` and `build.strategy` must agree                                               |
| `reference_unresolved` / `reference_syntax`                    | a `from:` or `template:` reference that names nothing                                      |
| `env_source_count`                                             | an env entry with two value sources                                                        |
| `literal_secret_value`                                         | `secret: true` with a literal `value`                                                      |
| `pattern_unsupported`                                          | the `validate.pattern` cannot compile under RE2 (no look-around)                           |
| `out_of_range`                                                 | e.g. a memory quantity below the `64Mi` floor                                              |
| `volume_replicas`                                              | `volumes` with `replicas > 1`                                                              |
| `cron_invalid`                                                 | a cron expression with the wrong field count                                               |
| `duplicate_name`                                               | a name repeated, including an implicit `<NAME>_PUBLIC`                                     |
| `blueprint_mode_forbidden_key`                                 | a key forbidden in blueprint mode (the schema now allows `source`/`blueprint`)             |
| `image_not_pinned`                                             | a tag-only image reference — a warning, an error in `blueprint` mode for a verified entry  |

You can validate a draft without touching a repository: `POST /api/works/:id/app-spec/validate`, or run the
artifact's own validator against a fixture — `node _build-artifacts/apw-03-schema/evidence/validate.mjs`.

### 11.3 A Build failed

Fourteen failure classes with exact user copy
([`APW-05-builds/spec.md`](./APW-05-builds/spec.md) §6.3): `outOfMemory`, `diskFull`, `dockerfileError`,
`dependencyDownloadFailed`, `registryPushDenied`, `missingBuildValue`, `secretInImage`, `timeout`,
`workflowInvalid`, `digestMismatch`, `verificationFailed`, `egressBlocked`, `lost`, `unknown`. The classifier
they come from, in evaluation order with the exact log signal per class, is
[`APW-05-builds/plan.md`](./APW-05-builds/plan.md) §4.9.

| Class                       | Usual local cause                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `missingBuildValue`         | a `build.args[].fromEnv` name with no matching `env` entry, or a prompted value never set                                                |
| `runnerTooSmall` (blocked)  | the Blueprint asks for more memory than a private repository's runner has — a **public** repository or a larger runner label is required |
| `actionsDisabled` (blocked) | Actions hygiene disabled the workflow, or Actions are off for the fork                                                                   |
| `secretInImage`             | a secret reached a build argument or a layer — the platform refuses it on purpose                                                        |
| `digestMismatch`            | the workflow's reported digest did not match the registry — the artifact is untrusted until it does                                      |
| failure with **no** class   | the run was never adopted; `app-build-sweep` marks a Build silent > 90 s and reconciles it                                               |

The workflow's own result file is `ever-works-build-result` (`ever-works-build-result.json`, ≤ 8 KB, 7-day
retention) — **untrusted until the digest is confirmed against the registry** ([CONTRACTS.md](./CONTRACTS.md) §9).

### 11.4 Nothing deploys

- `409 app_runtime_unavailable` — the App runtime path is not registered yet (APW-06 replaces this refusal).
- `cluster_unreachable`-class refusal — the cluster API is private and its CIDR is not in
  `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`. Add the CIDR you read from `docker network inspect kind`.
- `worker_not_isolated` (422) — production refuses App Work cluster jobs until the operator declares the
  isolated worker. Locally, run the worker in-process (`EVER_WORKS_APPS_LOCAL_WORKER=true`, §5) — it is
  **refused** when `NODE_ENV=production`.
- Nothing happens at all — the App runtime worker is not running (§5). Cluster I/O does not happen in the
  API process.

### 11.5 The harness itself refuses to start

The interlocks are enforced in `app-works-live.setup.ts` and re-checked by each destructive helper
([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §8.5): origins not in `APW_E2E_ALLOWED_BASE_URLS` (with a
hard-coded production deny-list as a second check), an unlisted kube context, an upstream owner outside
`APW_E2E_UPSTREAM_ORG`, missing budgets, or a namespace not starting `apw-e2e-`. The refusal **names what it
refused and never a value** (ACC-NEG-16). If you see one locally you are pointing a live lane somewhere it
must not go — stop, and read §10.

---

## 12. Windows notes

The repository does not ship Windows quickstart guidance, and this section says only what is **observed**:

- **`npm run smoke` in the fixture app crashes at teardown on Windows** — a libuv double-close after all 18
  checks have printed, so the **exit code is unusable** even though the results are valid. Re-run it on Linux
  before trusting the exit status (`BUILD-READINESS.md:194-195`; the raw assertion is in
  `_build-artifacts/fixture-app/evidence/proof.txt:112`).
- **Some specs skip with a reason on Windows developer machines** — that is a documented, accepted outcome,
  not a failure ([`APW-05/tasks.md`](./APW-05-builds/tasks.md) (the task that runs those specs on Linux CI)).
- **Normalise CRLF → LF before comparing generated files**, and assert the file ends with a newline
  (`_build-artifacts/expected-outputs/golden-test-plan.md:80`).
- **Use `127.0.0.1`, not `localhost`**, for every origin you set (§4) — the stack binds IPv4 only.
- `.specify/scripts/powershell/check-prerequisites.ps1` is the PowerShell twin of the prerequisite check
  (§1); it tests the same three commands.

Nothing else about Windows is documented — treat anything more specific as unverified.
