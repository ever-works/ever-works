# Task Breakdown: Golden paths — fixture app, Umami and Cal.diy App Blueprints, acceptance lanes

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests per
> **Constitution VI**. No task adds a migration.

**Epic ID**: `APW-13-golden-paths`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md) · **Suite**: [`../ACCEPTANCE.md`](../ACCEPTANCE.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. Paths are monorepo-relative unless prefixed with a repository
  (`ever-works/app-fixture-hello:` …) or a placeholder organization (`<e2e-upstream-org>/…`). Monorepo paths not marked
  new were checked with `git ls-files` on `develop` @ `ee45946e5`.
- Every task carries **Create**/**Modify**, **Test** and **Done when**. `(owner action)` marks work a person with the
  right access must do; no agent performs it.
- "Done when" is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Specs for scenarios whose epic has not merged land as `test.fixme('<blocking epic id>: <reason>')`, never as a skip
  without a reason, and are un-fixme'd in the epic's own PR.
- **Never** add a repository-delete call anywhere under `apps/web/e2e/` (T9 enforces it).
- Live specs are only ever run against dev or stage. Running one locally requires the same interlocks (T8).
- A **live run** of a spec means
  `cd apps/web && APW_E2E_LIVE=1 pnpm exec playwright test -c playwright.app-works.config.ts <spec>` with the lane's
  variables of ACCEPTANCE §0.4; a **PR-lane run** means `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test <spec>`
  against the local stack with the fake GitHub of T2.
- API behaviour is tested only by controller/service specs under `apps/api/src/**` or request-level Playwright specs in
  `apps/web/e2e/`; nothing is added under `apps/api/test/` (Resolution R-22).
- Phase boundaries are ship boundaries: `develop` stays green and deployable after each phase.

---

# Phase P0 — Harness and regression gaps

_Delivers the fake GitHub, the non-production switch, the helpers and interlocks, the live config, and closes the
regression gaps of ACCEPTANCE §5 that need no App Works code._

## P0.1 — Fake GitHub

- [ ] **T1. Recorded response fixtures.**
      **Create** `apps/web/e2e/fakes/github-fake/fixtures/` (new) with one JSON file per route in
      [plan §8.3](./plan.md), recorded with read-only GETs against the test estate (`<e2e-upstream-org>`, never a
      third-party repository) and, for write routes, from the documented response examples. Strip tokens, emails and
      node ids.
      **Create** `apps/web/e2e/fakes/github-fake/fixtures/README.md` (new) stating when and how they were recorded.
      **Test**: the fixture scan in `apps/web/e2e/fakes/github-fake/__tests__/contract.unit.spec.ts` (T3) finds no
      token-shaped string, email address or node id.
      **Done when**: that scan passes over every fixture file.

- [ ] **T2. Fake server.**
      **Create** `apps/web/e2e/fakes/github-fake/server.mjs` (entry, `PORT` default 3900),
      `apps/web/e2e/fakes/github-fake/routes/repos.mjs`, `routes/pulls.mjs`, `routes/actions.mjs`, `routes/contents.mjs`,
      `apps/web/e2e/fakes/github-fake/git-backend.mjs` (smart HTTP over bare repositories in a temp directory via
      `git http-backend`), `control.mjs` (`/_control/seed`, `/_control/fault`, `/_control/calls`), `state.mjs` (in-memory
      repositories, forks with readiness delay, permissions per token) — all new. `clone_url` in every repository
      response points at the fake.
      **Add the consumer-derived routes** (added 2026-09-17, [plan §8.3](./plan.md)): the route table there is derived
      from every consuming epic, not only from APW-13 — `GET /repos/:o/:r/forks` (APW-02), the Git Data API
      (`git/refs`, `git/trees`, `git/blobs`, `git/commits`, APW-02/APW-03), topics and hooks, workflow
      disable/enable per id, Actions secrets public-key/PUT, runs/jobs/artifacts, branch protection, and issue comments
      — with the fault vocabulary (`delay`, `never-ready`, `rate-limit`, `server-error`, `auth-refused` **per token
      identity**, `conflict`) and the `/_control/seed` shape of the same section. Seed the PR-lane catalog (the test
      `ever-works/templates` manifest, `licenses.yml`, the three Blueprint repositories, the amber and red licence
      upstreams) from a checked-in JSON fixture per spec rather than per-test code.
      **Test**: `apps/web/e2e/fakes/github-fake/__tests__/server.unit.spec.ts` (new) — fork readiness delay and "never
      ready"; a clone and push round-trip through `git-backend`; `/_control/calls` records method, path and token
      identity; a per-token `auth-refused` fault returns `401` for that token and is restored afterwards; a seeded
      catalog fixture serves the routes APW-02, APW-03 and APW-05 consume. Run (after T4):
      `pnpm --filter ever-works-web test:e2e-harness server`.
      **Done when**: the spec passes, the server starts in under 1 s, and every route in the plan §8.3 table has a
      handler and a recorded fixture.

- [ ] **T3 (parallel with T2). Contract test.**
      **Create** `apps/web/e2e/fakes/github-fake/__tests__/contract.unit.spec.ts` (new) — for every served route, the
      fake's response has the same keys and value types as the recorded fixture; scans fixtures for token-shaped strings.
      **Test**: `pnpm --filter ever-works-web test:e2e-harness contract` (after T4) — green; red when a key is deleted
      from any fake response.
      **Done when**: both outcomes are observed.

- [ ] **T4. Harness unit-test runner.**
      **Create** `apps/web/vitest.e2e-harness.config.ts` (new; include `e2e/helpers/__tests__/**/*.unit.spec.ts`,
      `e2e/fakes/**/__tests__/*.unit.spec.ts`, environment `node`).
      **Modify** `apps/web/package.json` — add script `test:e2e-harness`
      (`vitest run -c vitest.e2e-harness.config.ts`).
      **Test**: `pnpm --filter ever-works-web test:e2e-harness` runs the T2 and T3 specs green;
      `pnpm --filter ever-works-web test` reports the same file count as before the change.
      **Done when**: both commands behave as stated.

## P0.2 — Non-production switch

- [ ] **T5. `EVER_WORKS_E2E_FAKES` in the GitHub plugin.**
      **Modify** `packages/plugins/github/src/github.plugin.ts` — when `process.env.NODE_ENV !== 'production'` and
      `EVER_WORKS_E2E_FAKES === '1'` and `APW_E2E_GITHUB_FAKE_URL` is set, use it as the API base URL for every call; the
      admin `apiBaseUrl` setting and its SSRF guard are untouched. **Also switch every URL builder, not just the API base
      (added 2026-09-17, plan §8.3):** `getCloneUrl` (`:155-157`, injected at `:663-667` and `:763`) and `getWebUrl`
      (`:159-161`) return the fake's origin, and the `https://github.com/<full_name>.git` fallback and the
      `raw.githubusercontent.com` content URL in `github-api.service.ts` (`:1364`) honour the same switch. Without the
      `getCloneUrl` case an isomorphic-git clone/push still reaches real GitHub while this task's unit test passes.
      **Modify** `packages/plugins/github/src/github-api.service.ts` — the `https://github.com/<full_name>.git` fallback
      honours the same switch.
      **Test**: `packages/plugins/github/src/__tests__/e2e-fakes-switch.spec.ts` (new) — honoured in
      `test`/`development`; ignored with `NODE_ENV=production`; a loopback `apiBaseUrl` setting is still refused with the
      switch on; **`getCloneUrl` and `getWebUrl` return the fake origin under the switch and `github.com` without it**;
      a clone through `GitOperations` uses the fake's `clone_url`. Run:
      `pnpm --filter @ever-works/github-plugin test e2e-fakes-switch`.
      **Done when**: all cases pass and CONTRACTS §7's `EVER_WORKS_E2E_FAKES` row matches the behaviour.

## P0.3 — Helpers

- [ ] **T6. API wrappers.**
      **Create** `apps/web/e2e/helpers/app-works.ts` (new) — raw-status wrappers for every route in CONTRACTS §4,
      following the never-throw create helper in `apps/web/e2e/flow-work-kind-template-activation-deep.spec.ts`.
      **Test**: `apps/web/e2e/helpers/__tests__/app-works.unit.spec.ts` (new) — with a stubbed `APIRequestContext`, every
      wrapper returns the raw status and body on `2xx`, `4xx` and `5xx` without throwing; a table derived from the
      CONTRACTS §4 route list has a wrapper for each route. Run: `pnpm --filter ever-works-web test:e2e-harness app-works.unit`.
      **Done when**: the spec is green and wrappers for unshipped routes are exported and documented as such.

- [ ] **T7. Polling.**
      **Create** `apps/web/e2e/helpers/app-works-poll.ts` (new) — `waitForActivity`, `waitForLiveMarker`,
      `expectAbsentThenPresent`, and the single deadline table of [plan §8.6](./plan.md).
      **Test**: `apps/web/e2e/helpers/__tests__/app-works-poll.unit.spec.ts` (new) — failure event short-circuits; expiry
      reports the last state; present-without-prior-absent fails; no helper or spec under `apps/web/e2e/flow-app-work*`
      calls `waitForTimeout` (source grep in the test). Run: `pnpm --filter ever-works-web test:e2e-harness app-works-poll`.
      **Done when**: the spec is green.

- [ ] **T8. Interlocks, estate file, redaction, budgets.**
      **Create** `apps/web/e2e/helpers/app-works-live.ts` (new) — the seven interlocks of [plan §8.5](./plan.md) including
      the hard-coded production origin deny-list; `readEstate` / `writeEstate` at `e2e/.auth/app-works-estate.json`;
      `runMarker()`; `redact(artefact)` over every `APW_E2E_*` secret value and the honeytoken; `accountSpend(receipts)`.
      **Test**: `apps/web/e2e/helpers/__tests__/app-works-live.unit.spec.ts` (new) — each interlock refuses; a production
      origin inside a misconfigured allow-list is still refused; redaction in nested JSON and plain text; budget overrun
      fails with reason `budget` (ACC-13-16, cross-cutting "refuses to start" and "no secret in an artefact"). Run:
      `pnpm --filter ever-works-web test:e2e-harness app-works-live`.
      **Done when**: all cases pass.

- [ ] **T9. GitHub estate helper — without delete.**
      **Create** `apps/web/e2e/helpers/github-estate.ts` (new) — `generateFromTemplate({ repo, newName, includeAllBranches })`
      (`include_all_branches: true`, so the `variant/*` branches travel with the copy — T68),
      `pushCommit({ repo, branch, files, message, token })` (the token is the customer's own for a variant push — T67 — and
      never the estate token in a platform-facing call), `archiveAndLabel`
      (topic `apw-e2e-expired`, run id in description), `closePullRequest`, `getRepo`, `getActionsPermissions`,
      `listWorkflowRuns`, `listPulls`, `getUserPermission`.
      **Test**: `apps/web/e2e/helpers/__tests__/github-estate.unit.spec.ts` (new) — the module exports no function whose
      name matches `/delete|remove|destroy/i`; a source scan of `apps/web/e2e/**` finds no `DELETE` request to `/repos/`
      and no `deleteRepository` reference (ACC-13-17, static half); `generateFromTemplate` always sends
      `include_all_branches: true`. Run:
      `pnpm --filter ever-works-web test:e2e-harness github-estate`.
      **Done when**: the spec is green and adding a `deleteRepo` export makes it fail.

- [ ] **T10 (parallel with T9). Read-only Kubernetes assertions.**
      **Create** `apps/web/e2e/helpers/k8s-assert.ts` (new) — list objects by App Work label; `getIngressCreatedAt`,
      `getJobCompletedAt`, `listCronJobs`, `secretKeys` (keys only); `deleteTestNamespace(name)` refuses unless the
      context is allow-listed and the name starts with `apw-e2e-`.
      **Test**: `apps/web/e2e/helpers/__tests__/k8s-assert.unit.spec.ts` (new) — refuses `Secret.data` access; refuses
      deletion outside the allow-list or prefix (ACC-13-17, namespace half). Run:
      `pnpm --filter ever-works-web test:e2e-harness k8s-assert`.
      **Done when**: both refusals are tested and green.

- [ ] **T11 (parallel with T10). Canary sink reader and evidence builder.**
      **Create** `apps/web/e2e/helpers/canary-sink.ts` (new; `listRequests(since)`, `assertNoLeak(values)`) — reads the
      sink's read API of [plan §5.3](./plan.md) (`GET /requests?since=&limit=` with the bearer read token, paged by
      `receivedAt`, `authorization` stripped by the sink) and `apps/web/e2e/helpers/app-works-evidence.ts` (new; evidence
      JSON of [plan §3.1](./plan.md) at `evidence/<blueprint-id>/<runId>.json` — validated against the schema T61 drafts —
      lane summary of spec §6.2, artefact secret scan before upload).
      **Test**: `apps/web/e2e/helpers/__tests__/app-works-evidence.unit.spec.ts` (new) — evidence validates against
      `ever-works/templates/schema/evidence.schema.json` (T61) and a file missing `license.class`, `passCount` or
      `upstream.kind` fails; the summary shows spend against budget; an attachment containing a known secret fails the
      run (ACC-13-16, 23); a `truncated` sink page is followed and a wrong read token is refused (ACC-13-24 fixture).
      Run: `pnpm --filter ever-works-web test:e2e-harness app-works-evidence`.
      **Done when**: the spec is green.

## P0.4 — Configs and the suite workflow

- [ ] **T12. Live config.**
      **Create** `apps/web/playwright.app-works.config.ts` (new, [plan §8.1](./plan.md)) and
      `apps/web/e2e/app-works-live.setup.ts` (new; runs interlocks, registers throwaway accounts, connects the account's
      GitHub through the surface T63 lands, creates the account's Agent with limited networking and its model credential
      (spec FR-65) and records the Agent id in the estate file, writes the estate file).
      **Modify** `apps/web/playwright.config.ts` — add `flow-app-works-(live|kind)-` to the ignore patterns of both the
      `chromium` and `chromium-no-auth` projects. No other change.
      **Test**: `cd apps/web && pnpm exec playwright test --list` lists no `flow-app-works-live-` or `-kind-` spec, and
      `pnpm exec playwright test -c playwright.app-works.config.ts --list` lists them.
      **Done when**: both listings are as stated, and the setup fails with the surface's name (S10) when the connection
      surface is absent rather than letting a scenario fail at its first fork call.

- [ ] **T13. `e2e.yml` starts the fake and the job runtime.**
      **Modify** `.github/workflows/e2e.yml` — in the Playwright step, start `node e2e/fakes/github-fake/server.mjs` in
      the background before the API and wait for it; add `EVER_WORKS_E2E_FAKES=1` and
      `APW_E2E_GITHUB_FAKE_URL=http://127.0.0.1:3900` to the API and Playwright environments and
      `EVER_WORKS_APP_WORKS_ENABLED=true` to the API environment (Resolution R-6); dump the fake's log in the existing
      failure trap. Triggers, shards and concurrency unchanged.
      **Also start the App runtime worker** (added 2026-09-17, spec FR-55; the exact step and readiness probe are in
      [plan §9.1](./plan.md)): `EVER_WORKS_APPS_LOCAL_WORKER=true nohup pnpm --filter @ever-works/trigger-tasks app-runtime:local-worker`
      in the background with its log in the failure trap. Without it fork readiness reports `dispatch_unavailable` and
      every App cluster call is refused, so ACC-E2E-02's PR twin, ACC-NEG-09 and T30/T31 can never pass. Production
      refuses to boot with that variable, so the step is non-production by construction.
      **Add the lane switches** (spec FR-65) to the API and Playwright environments:
      `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS` (ACC-NEG-09's shortened readiness window) and the non-production
      override that forces the web `works-app` chip on in the lane (the web runs `NODE_ENV=production` here, so the
      override is an explicit environment value, never `NODE_ENV`; APW-01 T7b owns the fail-closed helper it overrides).
      **Test**: `gh workflow run e2e.yml --ref <branch>` — the run's logs show the fake and the worker starting in every
      shard, and a run with the worker step removed fails the new specs with the named dispatch reason (ACC-13-22).
      **Done when**: that run is green and no existing spec changes result (cross-cutting: existing workflows keep
      passing).

## P0.5 — Regression gaps (ACCEPTANCE §5)

- [ ] **T14. Repository Work, full contract.**
      **Create** `apps/web/e2e/flow-repo-work-kind-regression.spec.ts` (new) — successful create with a seeded fake
      connection; `409` for a second account; the generate, deploy and write refusals over HTTP; with `works-app` on,
      unchanged. Covers ACC-REG-01, ACC-NEG-15.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-repo-work-kind-regression`.
      **Done when**: it passes locally and in a dispatched `e2e.yml` run. **Until T63 lands** the "seeded fake connection"
      this task needs has no supported surface, so the spec ships as
      `test.fixme('APW-13 T63: no supported GitHub connection surface')` and is un-fixme'd in T63's PR — the same marker
      T15, T16, T30 and T31 carry.

- [ ] **T15. Template fork succeeds.**
      **Create** `apps/web/e2e/flow-template-fork-success.spec.ts` (new) — fork into the user and into an organization;
      the fake records the user's token. Covers ACC-REG-02.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-template-fork-success`.
      **Done when**: it passes and `/_control/calls` shows the user's token on the fork call. **Until T63 lands** it carries
      `test.fixme('APW-13 T63: no supported GitHub connection surface')` (T14's marker).

- [ ] **T16. Activity for deploy and PR events.**
      **Create** `apps/web/e2e/flow-activity-deploy-and-pr-events.spec.ts` (new) — template fork and PR events appear
      with names only. Covers ACC-REG-07.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-activity-deploy-and-pr-events`.
      **Done when**: it passes (**until T63 lands** with `test.fixme('APW-13 T63: no supported GitHub connection surface')`,
      T14's marker).

- [ ] **T17. Signed GitHub delivery.**
      **Create** `apps/web/e2e/flow-github-intake-signed-delivery.spec.ts` (new) — a delivery signed with the CI webhook
      secret is accepted and fans out. Covers ACC-REG-12.
      **Test**: `cd apps/web && pnpm exec playwright test flow-github-intake-signed-delivery`.
      **Done when**: it passes and an unsigned delivery in the same spec is refused.

- [ ] **T18. Managed subdomain allocation.**
      **Create** `apps/web/e2e/flow-managed-subdomain-allocation.spec.ts` (new) — allocation and the per-user cap of 3.
      If the DNS provider cannot be faked without a new switch, mark the allocation half
      `test.fixme('APW-13 T18: needs a DNS provider fake')` and record it in ACCEPTANCE §5. Covers ACC-REG-05.
      **Test**: `cd apps/web && pnpm exec playwright test flow-managed-subdomain-allocation`.
      **Done when**: the cap half passes and the allocation half passes or carries the named `fixme`.

- [ ] **T19. P0 ship gate.**
      **Modify** `apps/web/e2e/COVERAGE.md` — rows for the new specs. **Modify** `docs/specs/features/app-works/ACCEPTANCE.md`
      §5 verdicts for REG-01, 02, 05, 07, 12.
      **Test**: `pnpm --filter ever-works-web test:e2e-harness`; a dispatched `e2e.yml` run; root `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      Since `1be4770c9` (2026-09-26) CI runs the first of these itself: `ci.yml`'s `lint-and-test` has an "App Works
      e2e harness unit specs (apps/web)" step after `pnpm test`, behind the same code-scope gate.
      **Done when**: all three are green.

---

# Phase P1 — Wave 1 golden paths

_Delivers the fixture application, the injection fixture, the three Blueprints, the cluster, nightly and golden-path
lanes, every Wave 1 scenario of ACCEPTANCE §1–§2, and the verification evidence flow._

## P1.1 — Test estate (owner actions)

- [ ] **T20. Estate.** `(owner action)`
      **Create** (outside the monorepo) the **Ever Works test tenant** for dev and one for stage (owner decision J-08,
      ACCEPTANCE §0.3 — the tenancy comes from Ever Works itself, not a purpose-built GitHub test organization), the
      GitHub account that tenant connects, and the `<e2e-user>` machine user (read-only on the upstream organization);
      a dedicated test budget for model spend and the lane's model/pipeline credential; the canary sink; the test DNS
      zone; the test cluster(s) and their operations-change claim procedure. **Modify** the monorepo's GitHub
      environments `app-works-dev` and `app-works-stage` with the secrets and variables of ACCEPTANCE §0.4, including
      `APW_E2E_JOB_RUNTIME_PROJECT_REF` / `TRIGGER_SECRET_KEY` for any lane that does not use the credential-free local
      worker. Record addresses and ownership in the private operations repository only.
      **Test**: `gh workflow run app-works-nightly.yml -f lane=dry-run` (the `lane` input sets `APW_E2E_LANE`; a dry run runs the interlocks and exits).
      **Done when**: `app-works-live.setup.ts` passes its interlocks in that dry run, the test tenant is recorded in the
      private operations repository, and `<e2e-upstream-org>` resolves to `ever-works` while `<e2e-fork-org>` resolves to
      the tenant account's fork space.

- [ ] **T21. Long-lived repositories.** `(owner action)`
      **Create** `<e2e-fork-org>/umami` and `<e2e-fork-org>/cal-diy` once **in the test tenant's connected account's fork
      space** (fork or private copy — record the choice privately). Automation only links them.
      **Test**: `getRepo` from `apps/web/e2e/helpers/github-estate.ts` returns both, not archived; `getUserPermission`
      shows `<e2e-user>` can push to both and cannot push to `<e2e-upstream-org>`.
      **Done when**: both reads return as stated in a dry-run dispatch.

## P1.2 — Fixture application and its Blueprint

- [ ] **T22. `ever-works/app-fixture-hello`.**
      **Create** in that repository every file of [plan §4.1](./plan.md) with the HTTP surface of plan §4.2; mark it a
      template repository; MIT licence; topics `ever-works-app-fixture` (so the repository is discoverable and the
      template generation of T9 works).
      **Modify** `ever-works/app-fixture-hello:Dockerfile` — the `runtime` stage ends with a **numeric** `USER 1000`, never
      `USER node` (plan §4.1): kubelet refuses a non-numeric image user under the platform's `runAsNonRoot` default with
      `image has non-numeric user`, which APW-06 classifies `image_user_unverifiable` and refuses before apply on
      `ever-works/templates`. The shipped repository currently says `USER node`; the App's own README records the numeric uid.
      **Create** `ever-works/app-fixture-hello:.github/workflows/image.yml` — builds and publishes
      `ghcr.io/ever-works/app-fixture-hello:<sha>` and fails when `docker build` exceeds 120 s.
      **Test**: `ever-works/app-fixture-hello:test/routes.test.mjs`, `test/migrate.test.mjs`, `test/bootstrap.test.mjs`
      (`sawPublicApp` is false on 404 and on a different marker) run by `npm ci && npm test` (ACC-13-01 build-time half,
      ACC-13-03 unit half); a `docker image inspect` assertion that the image's `Config.User` is numeric.
      **Done when**: image CI is green under the time limit; `docker run` + a local Postgres answers every route; the
      image's configured user is numeric and non-root.

- [ ] **T23. Variant branches and images.**
      **Create** branches `variant/build-oom`, `variant/baked-localhost`, `variant/bad-migration`, `variant/slow-boot`
      ([plan §4.3](./plan.md)); image CI publishes `:variant-<name>-<sha>` for the three that build.
      **Create** `ever-works/app-fixture-hello:.github/workflows/variants.yml` — manual dispatch and weekly; one job per
      variant branch that runs `docker build` and asserts the raw outcome of its plan §4.3 row (T58 adds the Builds-epic
      variants).
      **Test**: dispatch `variants.yml` — the out-of-memory build exits 137, the baked build's `/marker` contains
      `localhost`, the bad migration exits non-zero, the slow boot listens after 120 s (preconditions of ACC-NEG-10,
      ACC-NEG-11, ACC-13-08).
      **Modify** `ever-works/app-fixture-hello:VARIANTS.md` and `.github/workflows/variants.yml` (added 2026-09-17) —
      `VARIANTS.md` is the branch contract (`variant/<name>`, its single commit, its mechanism, its scenario) and is
      already published; this task keeps it in step with the branches it creates, and T67 adds the rebase rule for when
      `main` moves.
      **Done when**: each branch is one commit on `main` and its `variants.yml` job is green.

- [ ] **T24. `ever-works/app-fixture-hello-template`.**
      **Create** from `docs/specs/features/app-works/APW-13-golden-paths/blueprints/app-fixture-hello/`
      (`.works/works.yml`, `README.md`) plus `profiles/all-dependencies.works.yml`; topic `ever-works-app-blueprint`;
      `.github/workflows/validate.yml` validating every App spec in the repository (`.works/works.yml` and `profiles/*`)
      against the Apps catalog schema (APW-03).
      **Test**: `validate.yml` runs on the repository's first push; a deliberately misspelled key in a scratch branch
      fails it with `unknown_field`.
      **Done when**: validation is green on `main`; `blueprint.sha` is stamped by the release workflow.

- [ ] **T25 (parallel with T24). Stable and licence-variant upstreams.**
      **Create** `<e2e-upstream-org>/app-fixture-hello` (copy of the fixture), `app-fixture-license-amber` (`BUSL-1.1`),
      `app-fixture-license-red` (`PolyForm-Noncommercial-1.0.0`).
      **Test**: GitHub `GET /repos/{owner}/{repo}/license` through `github-estate.ts` for each.
      **Done when**: GitHub reports the expected licence key for each.

## P1.3 — Injection fixture

- [ ] **T26. `<e2e-upstream-org>/app-fixture-injection`.**
      **Create** the repository from the fixture code plus every payload of [plan §5.2](./plan.md), all addresses pointing
      at the canary sink; banner, description and topics of plan §5.1.
      **Test**: a reviewer checks every row of the payload table; `git grep -nE 'https?://'` in the repository lists only
      canary-sink addresses and public documentation links.
      **Done when**: the review confirms every row is present and no real address or real credential appears anywhere.

## P1.4 — Umami and Cal.diy Blueprints

- [ ] **T27. `ever-works/umami-template`.**
      **Status (2026-09-26):** the repository exists and is the source —
      [`ever-works/umami-template`](https://github.com/ever-works/umami-template), public, topic
      `ever-works-app-blueprint`, Blueprint id `umami`, its App spec only at `.works/works.yml`; `ever-works/templates`
      lists it as a `placeholder` (no release tag yet). It was created from this epic's draft under `blueprints/umami/`,
      which is retired. Still open: the repository's own `validate.yml`, the relation record below, the first
      `v<version>` tag, and the nightly run.
      **Modify** [`ever-works/umami-template`](https://github.com/ever-works/umami-template) (created from the draft,
      see the status line); `validate.yml`. After the first nightly run, resolve each item of its README's
      "Unverified" list in the same repository. The Blueprint's `web` component declares `runAsUser: 1001` once APW-03's `components[].runAsUser`
      exists (T61's field request) — the image sets its user by name.
      **Record the relation** (added 2026-09-17): the Blueprint declares `source.relation: fork` and the golden-path lane
      states which relation each run uses; applying the Blueprint to a **Link** App Work strips
      `upstreamSync`/`upstreamPullRequests.enabled` per APW-03's apply rule, and that rule is APW-03's to write
      (plan §13).
      **Test**: `validate.yml` green; `apps/web/e2e/flow-app-works-live-umami.spec.ts` (T43) on dev; the enabled
      `default-admin-refused` smoke (`POST /api/auth/login`, expecting `401`) passes in the same run.
      **Done when**: ACC-13-05 and ACC-13-06 are green once.

- [ ] **T28. `ever-works/cal-template` (formerly `cal-diy-template`).**
      **Status (2026-09-26):** the repository exists and is the source —
      [`ever-works/cal-template`](https://github.com/ever-works/cal-template), renamed from `cal-diy-template` on
      2026-09-25, public, topic `ever-works-app-blueprint`, Blueprint id `cal` (metadata-only shape over the upstream
      `calcom/cal.diy`), its App spec only at `.works/works.yml`, with no root `app-spec.yml`; `ever-works/templates`
      lists it as a `placeholder` (no release tag yet). It was created from this epic's draft under `blueprints/cal-diy/`,
      which is retired. Still open: the repository's own `validate.yml`, the relation record below, the first
      `v<version>` tag, and the T46 build step.
      **Modify** [`ever-works/cal-template`](https://github.com/ever-works/cal-template) (created from the draft, see
      the status line); `validate.yml`. Re-read the facts table at the then-current pin (refresh procedure in its
      README). Resolve the
      open coordination items of [plan §13](./plan.md) with APW-05, APW-06 and APW-07 in their PRs, not here.
      **Record the relation** (added 2026-09-17): the Cal.diy golden path accepts **Link** (ACC-E2E-14), so the Blueprint's
      `upstreamSync` block must survive Link apply — either APW-03's apply rule strips it for a link (recorded in
      CONTRACTS) or the Blueprint's fork-only fields move to a documented `examples/` spec. T27's relation note applies
      identically; the choice is recorded in the Blueprint's README facts table.
      **Test**: `validate.yml` green; `apps/web/e2e/flow-app-works-live-cal-diy-golden-path.spec.ts` (T46) build step on
      stage.
      **Done when**: ACC-13-07 is green once.

- [ ] **T29. Catalog content.**
      **Create** in `ever-works/templates` (CONTRACTS §7: the listing repository, renamed from `ever-works/apps`, and the
      name ACCEPTANCE §0.3's test-catalog row uses): branch `e2e` whose `manifest.json` adds the test upstreams of
      ACCEPTANCE §0.3; `candidate` entries for the three Blueprints on `main` (**changed 2026-09-26:** two — Cal and Umami;
      the fixture Blueprint `ever-works/app-fixture-hello-template` stays private and is not part of the catalog, owner
      decision); an `evidence/` directory with a README (the
      path APW-03 `catalog.md` §3.2 defines). The `e2e` branch also lists the generated upstream prefix
      `<e2e-upstream-org>/app-fixture-gen-*` (added 2026-09-17, spec FR-9) so a per-run upstream still resolves from a
      verified Blueprint (ACC-13-21).
      **Modify** dev and stage deployment configuration (APW-03's documented place) so `EVER_WORKS_APPS_CATALOG_REF` pins
      a commit of `e2e`.
      **Test**: `GET /api/apps-catalog` on dev and on production.
      **Done when**: dev lists the fixture Blueprint and production's response does not, and the generated upstream
      prefix resolves to the fixture Blueprint in the `e2e` branch's manifest.

## P1.5 — PR-lane specs

- [ ] **T30. Create from URL.**
      **Create** `apps/web/e2e/flow-app-work-create-from-url.spec.ts` (new) — ACC-E2E-01, ACC-NEG-08.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-app-work-create-from-url`.
      **Done when**: it passes with the fake (or is `fixme('APW-01')`), uses no `waitForTimeout`, and asserts every
      GitHub write through `/_control/calls`. **Until T63 lands** it also carries
      `test.fixme('APW-13 T63: no supported GitHub connection surface')`, because the create call needs the account's Git
      connection to exist (T14's marker).

- [ ] **T31. Fork lifecycle.**
      **Create** `apps/web/e2e/flow-app-work-fork-lifecycle.spec.ts` (new) — ACC-E2E-02 twin, ACC-NEG-09.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-app-work-fork-lifecycle`.
      **Done when**: as T30 (blocking epic APW-02).

- [ ] **T32. Security pins.**
      **Create** `apps/web/e2e/sec-pin-app-works-license-gate.spec.ts` (NEG-01, 02),
      `apps/web/e2e/sec-pin-app-works-managed-gate.spec.ts` (NEG-03),
      `apps/web/e2e/sec-pin-app-works-upstream-pr-approval.spec.ts` (NEG-06; Wave 2 cases `fixme('APW-09')`),
      `apps/web/e2e/sec-pin-app-works-secret-surfaces.spec.ts` (NEG-12), `apps/web/e2e/sec-pin-app-works-scoping.spec.ts`
      (NEG-13) — all new.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test sec-pin-app-works-`.
      **Done when**: as T30 (blocking epics named per case).

- [ ] **T33. Delete, None target, interlocks; launcher referenced.**
      **Create** `apps/web/e2e/flow-app-work-delete-retains.spec.ts` (NEG-07 twin), `apps/web/e2e/flow-app-work-target-none.spec.ts`
      (E2E-11; the deploy target is **None**, value `none` — Resolution R-12) and
      `apps/web/e2e/flow-app-works-harness-interlocks.spec.ts` (NEG-16, ACC-13-16, ACC-13-17, cross-cutting refusals) —
      all new. **Reference, do not create**, `apps/web/e2e/flow-app-launcher-apps.spec.ts` for E2E-12: it is created and
      owned by APW-11 T20 (Resolution R-22); this epic only runs it and reads its result.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test flow-app-work-delete-retains flow-app-work-target-none flow-app-works-harness-interlocks flow-app-launcher-apps`.
      **Done when** (T30–T33): each spec passes locally with the fake, or is `fixme` naming the unmerged epic; none uses
      `waitForTimeout`; every GitHub write is asserted through `/_control/calls`; this epic's diff adds no
      `flow-app-launcher-apps.spec.ts`.

## P1.6 — Cluster lane

- [ ] **T34. `app-works-kind.yml`.**
      **Create** `.github/workflows/app-works-kind.yml` (new) per [plan §9.2](./plan.md), copying the kind bootstrap steps
      of `.github/workflows/k8s-e2e.yml`, with `EVER_WORKS_APP_WORKS_ENABLED=true`, `EVER_WORKS_APPS_DOMAIN` **left
      unset so the shared default applies** (`EVER_WORKS_DOMAIN`) and the lane asserts the default managed address, and
      `EVER_WORKS_APPS_DNS_ZONE_ID` / `EVER_WORKS_APPS_DNS_API_TOKEN` unset so no real zone is written; the lane also
      reads the host the platform assigned and passes on a custom domain (plan §8.4).
      **Also** (added 2026-09-17, plan §8.4): start the App runtime worker with the step of T13; set
      `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` to the kind API's private CIDRs (`127.0.0.1/32`, the kind Docker network
      CIDR read live from `docker network inspect kind`, and the ingress network when it differs) — without it every
      Deployment is refused by APW-06's cluster-address guard; and paste a **service-account** kubeconfig carrying
      `certificate-authority-data` and no client certificate/key, which is what APW-06 plan §6.1 requires.
      **Test**: `gh workflow run app-works-kind.yml --ref <branch>`; a run with the allowlist removed fails the first
      Deployment with the guard's reason rather than timing out (ACC-13-22).
      **Done when**: the run bootstraps kind and reaches the Playwright step (specs may be `fixme`) and no Deployment is
      refused by the address guard.

- [ ] **T35. Runtime on kind.**
      **Create** `apps/web/e2e/flow-app-works-kind-runtime.spec.ts` (new) — ACC-E2E-05 cluster half, ACC-NEG-11, ACC-13-02,
      ACC-13-03, ACC-13-08 (bad migration and slow boot variants keep the previous Deployment serving). The spec **adds and
      verifies the custom domain in `<e2e-dns-zone>` before the App Work's first Deployment** (added 2026-09-17, plan §8.4),
      because the fixture's `FIXTURE_PUBLIC_URL` references `domains.primary.url` and APW-05/APW-06 refuse an unresolved
      referenced entry.
      **Create** `apps/web/e2e/flow-work-deploy-custom-kubeconfig.spec.ts` (ACC-REG-04) and
      `apps/web/e2e/flow-custom-domain-verify.spec.ts` (ACC-REG-06) — new.
      **Create** `packages/agent/src/ever-works-providers/__tests__/ever-works-db-provision.integration.spec.ts` (new;
      ACC-REG-10), skipped unless `EVER_WORKS_DB_PROVISION_IT_URL` is set; the kind lane sets it to a throwaway Postgres.
      **Test**: `gh workflow run app-works-kind.yml --ref <branch>` (ACC-13-02, 03, 08; ACC-E2E-05 cluster half); locally
      `pnpm --filter @ever-works/agent test ever-works-db-provision.integration` skips without the variable.
      **Done when**: a dispatched run is green within 25 minutes.

## P1.7 — Nightly lane

- [ ] **T36. `app-works-nightly.yml`.**
      **Create** `.github/workflows/app-works-nightly.yml` (new) per [plan §9.3](./plan.md), environment `app-works-dev`,
      jobs `interlocks → fixture → model → umami → safety → cleanup → evidence` **in sequence** (one worker, spec FR-44),
      each with its own `timeout-minutes` from the per-job budget table of [plan §9.6](./plan.md), the whole lane at
      `timeout-minutes: 240`; the job-runtime worker step of T13; the lane switches of spec FR-65
      (`EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`, the web chip override, `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`);
      the throwaway account's Agent and model credential created before `fixture`; summary step.
      **Test**: `gh workflow run app-works-nightly.yml -f lane=dry-run`, then a full dispatch; the run's job list, each
      job's duration and its `timeout-minutes` are compared with the plan §9.6 table.
      **Done when**: the dry run passes interlocks, the summary step writes the spec §6.2 table, no job exceeds its own
      budget, and the summary prints Build minutes and check minutes separately from runner minutes.

- [ ] **T37. Fork, link, private copy.**
      **Create** `apps/web/e2e/flow-app-works-live-fork.spec.ts` (E2E-02, 03) and
      `apps/web/e2e/flow-app-works-live-private-copy.spec.ts` (E2E-04) — new.
      **Test**: live run (How to use) of both specs on dev.
      **Done when**: both pass on dev and every repository they touched is archived and labelled.

- [ ] **T38. Blueprint path.**
      **Create** `apps/web/e2e/flow-app-works-live-blueprint-path.spec.ts` (new; E2E-05, ACC-13-01, 02, 03) — including the
      custom domain on `<e2e-dns-zone>`, the host assertion of T60 and the mail sink check.
      **Test**: live run of the spec on dev (ACC-13-01, 02, 03; ACC-E2E-05).
      **Done when**: it passes and every row of the fixture Blueprint README's feature table is recorded as observed.

- [ ] **T39. Provisioner path.**
      **Create** `apps/web/e2e/flow-app-works-live-provisioner-path.spec.ts` (new; E2E-06) — plants the honeytoken before
      the Provisioner starts.
      **Test**: live run of the spec on dev.
      **Done when**: it passes and the canary sink holds no honeytoken.

- [ ] **T40. Evolve loop and None target.**
      **Create** `apps/web/e2e/flow-app-works-live-evolve-loop.spec.ts` (E2E-07) and
      `apps/web/e2e/flow-app-works-live-no-deploy-target.spec.ts` (E2E-11; deploy target **None**, R-12) — new.
      **Test**: live run of both specs on dev.
      **Done when**: both pass; the evolve spec proved the marker absent before present.

- [ ] **T41. Sync, targets, launcher.**
      **Create** `apps/web/e2e/flow-app-works-live-upstream-sync.spec.ts` (E2E-09, NEG-14),
      `apps/web/e2e/flow-app-works-live-deploy-targets.spec.ts` (E2E-10 a; b as `fixme('APW-10')`),
      `apps/web/e2e/flow-app-works-live-launcher.spec.ts` (E2E-12, live half; the PR half is APW-11's
      `flow-app-launcher-apps.spec.ts`) — new.
      **Test**: live run of the three specs on dev.
      **Done when**: all pass (E2E-10 b remains `fixme('APW-10')`).

- [ ] **T42. Safety.**
      **Create** `apps/web/e2e/flow-app-works-live-protected-paths.spec.ts` (NEG-04),
      `apps/web/e2e/flow-app-works-live-prompt-injection.spec.ts` (NEG-05, ACC-13-04),
      `apps/web/e2e/flow-app-works-live-build-failures.spec.ts` (NEG-10; T59 extends it),
      `apps/web/e2e/flow-app-works-live-delete-retains.spec.ts` (NEG-07) — new.
      **Add** (added 2026-09-17, ACC-NEG-11): the `variant/baked-localhost` case belongs in
      `flow-app-works-live-build-failures.spec.ts` — the lane pins the variant branch through the Blueprint's
      `source.branch`, deploys it, and asserts the `marker` smoke fails on `bodyNotContains: ['localhost']` while the
      previous Deployment keeps serving. ACCEPTANCE `:664` records that the nightly run on `variant/baked-localhost` has
      no live spec named in APW-13's tasks; this is that spec.
      **Test**: live run of the four specs on dev (ACC-13-04; ACC-NEG-04, 05, 07, 10, 11).
      **Done when**: all pass and the injection run meets every FR-13 condition.

- [ ] **T43. Umami.**
      **Create** `apps/web/e2e/flow-app-works-live-umami.spec.ts` (new; ACC-13-05, 06) — asserts the default credential is
      refused directly **and** reads the Blueprint's `default-admin-refused` smoke result, which the enabled smoke now
      proves too (added 2026-09-17: APW-03 `schema.md` §16 defines `smoke[].http.body`, so the Blueprint's call carries
      the body and the direct assertion is an addition, not the only path).
      **Test**: live run of the spec on dev (ACC-13-05, 06).
      **Done when**: it passes within 15 minutes of create and both the direct assertion and the smoke row pass.

- [ ] **T44. Task isolation PR, live.**
      **Create** `apps/web/e2e/flow-task-isolation-pr-live.spec.ts` (new; ACC-REG-03) on a generated fixture repository.
      **Test**: live run of the spec on dev; then one full dispatched nightly run.
      **Done when** (T36–T44): one dispatched nightly run on dev is green end to end, **every job stays inside its own
      budget of the plan §9.6 table** (the `fixture` job inside its 90 minutes) and the lane inside 225, its cleanup left
      no namespace behind, and every repository it touched is archived and labelled.

## P1.8 — Golden-path lane

- [ ] **T45. `app-works-golden-path.yml`.**
      **Create** `.github/workflows/app-works-golden-path.yml` (new) per [plan §9.4](./plan.md) (Wave 2 jobs present and
      gated off).
      **Test**: `gh workflow run app-works-golden-path.yml -f scenarios=cal-diy -f wave2=false -f lane=dry-run`.
      **Done when**: the dry run passes interlocks and the Wave 2 jobs are skipped with their gate reason.

- [ ] **T46. Cal.diy end to end.**
      **Create** `apps/web/e2e/flow-app-works-live-cal-diy-golden-path.spec.ts` (new) — `test.describe.serial` with one
      test per step and its own budget: link and create; Build; migrate before first ready replica; bootstrap before
      ingress; smoke; CronJobs and first `tasker` success; sign in; event type; booking and confirmation email; evolve
      change with the `M3` control; Goal scoped to the App Work; launcher entry; protected branding request; domain
      change without rebuild. Covers ACC-E2E-14, ACC-13-07, 09, 10, 11, 12, 13, 14.
      **Add** (added 2026-09-17): the lane's deploy target carries `allowRoot: true` before the Cal.diy App Work is created
      (the pinned image has no `USER` and runs as root — spec FR-26), and the run asserts it rather than assuming it; the
      sign-in and one encrypted round trip (two-factor setup) are performed with run-time `NEXTAUTH_SECRET` /
      `CALENDSO_ENCRYPTION_KEY` values that **differ** from the build placeholders, which is what settles the upstream
      README's "must match build variable" note against the source's run-time reads (plan §7.1); and the evidence records
      the measured peak memory, disk, wall time and image size for ACC-13-07.
      **Test**: a dispatched golden-path run on stage (ACC-13-07, 09, 10, 11, 12, 13, 14; ACC-E2E-14).
      **Done when**: one dispatched run on stage is green within 4 hours and within budget, the root precondition was
      stated by the lane, the mismatched-secret round trip passed, and the measured numbers are in the evidence.

## P1.9 — Verification and smoke rows

- [ ] **T47. Evidence and status.**
      **Create** `apps/web/e2e/flow-app-works-live-blueprint-verification.spec.ts` (new; ACC-13-15) — drives a candidate
      Blueprint through the streak using recorded evidence files.
      **Create** in `ever-works/templates`: `scripts/verification-status.mjs`, `scripts/__tests__/verification-status.test.mjs`
      (state machine of spec §5.3, including `not-verified → verified` at the same pin after N fresh passes), and the CI
      step that writes the computed status into the manifest in the evidence PR. The script is the **single**
      implementation: APW-03's C8 imports it instead of recomputing the status (added 2026-09-17, spec FR-57) — T61
      drafts its input schema.
      **Modify** `.github/workflows/app-works-nightly.yml` and `.github/workflows/app-works-golden-path.yml` — their
      `evidence` jobs open one catalog PR per run.
      **Test**: `node --test scripts/__tests__/verification-status.test.mjs` in `ever-works/templates`; live run of the
      verification spec on dev; a check that APW-03's catalog CI **imports** this module (a second implementation fails
      the review, and the test asserts the import path).
      **Done when**: five recorded passes produce `verified`; two failures produce `not-verified`; a canary failure only
      sets `canaryBehind`; a `not-verified` entry with N fresh passes returns to `verified`.

- [ ] **T48. Deployed smoke rows.**
      **Modify** `apps/web/e2e-smoke/deployed-api-contract.spec.ts` — add each App Works row of [plan §9.5](./plan.md)
      **in the PR that ships its route** (tracked here, landed by the owning epic).
      **Request the three rows explicitly** (added 2026-09-17, ACC-13-18): APW-03's route PR adds `/api/apps-catalog`
      (public → `200`), APW-06's adds `/api/works/<zero-uuid>/app-status` (`401`) and APW-11's adds `/api/me/apps` (`401`).
      A grep of every `APW-*/tasks.md` finds `deployed-api-contract` only in this file, so without these three one-line
      requests ACC-13-18 has no implementing task anywhere in the program. T55's script diff covers the ids.
      **Test**: `cd apps/web && SMOKE_BASE_URL=<env origin> pnpm exec playwright test -c playwright.smoke.config.ts deployed-api-contract`
      against dev, stage and production (ACC-13-18).
      **Done when**: ACC-13-18 is green on dev, stage and production and each of the three rows landed in its route's PR.

- [ ] **T49. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — epics whose listed scenarios are all green → `Verified`.
      **Test**: nightly five consecutive runs on dev; golden path green on stage; catalog statuses read back from
      `GET /api/apps-catalog`.
      **Done when**: all Wave 1 rows of ACCEPTANCE §1–§2 are green; fixture and Umami Blueprints are `verified`; Cal.diy
      is `verified` after three weekly passes.

---

# Phase P2 — Wave 2

- [ ] **T50. Upstream pull requests.**
      **Create** `apps/web/e2e/flow-app-works-live-upstream-pr.spec.ts` (new; ACC-E2E-08). **Modify**
      `apps/web/e2e/sec-pin-app-works-upstream-pr-approval.spec.ts` (un-fixme the Wave 2 cases) and
      `.github/workflows/app-works-golden-path.yml` (enable the `upstream-pr` job).
      **Test**: two dispatched golden-path runs on stage with `scenarios=upstream-pr`.
      **Done when**: green on stage twice; the upstream PR was never merged by the platform and was closed by the harness.

- [ ] **T51. Managed tier.**
      **Modify** `apps/web/e2e/flow-app-works-live-deploy-targets.spec.ts` (un-fixme ACC-E2E-10 b),
      `apps/web/e2e/sec-pin-app-works-managed-gate.spec.ts` (add the golden-path twin of ACC-NEG-03 as a live-gated
      describe block) and `.github/workflows/app-works-golden-path.yml` (enable the `managed-tier` job only after APW-10's
      launch gate is recorded as passed).
      **Test**: a dispatched golden-path run on stage with `wave2=true`.
      **Done when**: green on stage; the tier refuses a non-verified Blueprint.

- [ ] **T52. Ever ID.**
      **Create** `apps/web/e2e/flow-ever-id-switch.spec.ts` (new; ACC-E2E-13). **Modify**
      `.github/workflows/app-works-golden-path.yml` — enable the `ever-id` job when the flag is on for stage.
      **Test**: a dispatched golden-path run on stage with the `ever-id` flag on.
      **Done when**: the spec is green on stage.

- [ ] **T53. Upstream-sync canary and pin refresh.**
      **Modify** `.github/workflows/app-works-golden-path.yml` — implement the `canary` job; on three consecutive canary
      passes at a newer upstream commit, open (never merge) a Blueprint pin-bump PR carrying the facts-table re-read
      checklist. **Create** `apps/web/e2e/helpers/canary-pin-bump.ts` (new).
      **Test**: `apps/web/e2e/helpers/__tests__/canary-pin-bump.unit.spec.ts` (new) — a recorded streak of three passes
      opens exactly one PR; two passes or a failure in between open none (ACC-13-15 canary half). Run:
      `pnpm --filter ever-works-web test:e2e-harness canary-pin-bump`.
      **Done when**: the spec is green and a recorded canary streak opens exactly one PR.

- [ ] **T54. P2 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md`.
      **Test**: the Wave 2 golden-path jobs on stage.
      **Done when**: Wave 2 rows are green on stage and the tracker reflects it.

---

# Cross-phase closing tasks

- [ ] **T55. Merge per-epic scenarios.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` §3 — replace each `ACC-NN-xx` placeholder with the rows of
      that epic's spec §8, and refresh the §4 matrix.
      **Test**: a script diff of the ACC ids in every epic spec §8 against ACCEPTANCE §3.
      **Done when**: the diff is empty.

- [ ] **T56. Operator runbook.**
      **Create** `docs/runbooks/app-works-acceptance-lanes.md` (new) — how to dispatch each lane, read the summary, find
      evidence, and what to do on `budget`, interlock refusal and leftover namespaces. No estate addresses (they stay
      private).
      **Test**: `npx prettier --check docs/runbooks/app-works-acceptance-lanes.md` and a grep for IP-address and hostname
      patterns returning nothing.
      **Done when**: both checks pass.

- [ ] **T57. Statuses.**
      **Modify** `spec.md`, `plan.md` and this file — `Implemented` / `Done`.
      **Test**: re-read every gate in [plan §13](./plan.md).
      **Done when**: every gate still holds.

- [ ] **T58. Fixture variants other epics need (added 2026-09-17, Resolution R-23).**
      **Create** in `ever-works/app-fixture-hello` the branches `variant/dockerfile-error`, `variant/missing-value`,
      `variant/secret-in-image`, `variant/services-postgres`, `variant/build-timeout`, `variant/disk-full`, each one
      commit on `main` with the diff of its [plan §4.3](./plan.md) row. APW-05 T31's short names (`oom`,
      `dockerfile-error`, `secret-in-image`, `missing-value`, `services-postgres`) refer to `variant/build-oom` and these
      branches; no other epic creates fixture branches.
      **Modify** `ever-works/app-fixture-hello:.github/workflows/variants.yml` (T23) — one job per new branch asserting its
      raw outcome: exit code of the failing `RUN` for `dockerfile-error`; the first step failing on an empty build value
      for `missing-value`; `docker image inspect` showing the leaked `ENV` for `secret-in-image`; a green build whose
      migration ran against the job's own service container for `services-postgres`; a build killed by a 5-minute job
      timeout for `build-timeout`; `No space left on device` for `disk-full`.
      **Test**: dispatch `variants.yml` (ACC-13-19).
      **Done when**: every variant job is green, i.e. every variant reproduces its declared outcome.

- [ ] **T59. Variant profiles and the Builds epic's live acceptance (added 2026-09-17, Resolution R-23).**
      **Create** in `ever-works/app-fixture-hello-template`: `profiles/missing-value.works.yml`,
      `profiles/secret-in-image.works.yml`, `profiles/build-services.works.yml`, `profiles/build-timeout.works.yml`
      ([plan §4.4](./plan.md)); `validate.yml` (T24) covers them.
      **Modify** `apps/web/e2e/flow-app-works-live-build-failures.spec.ts` (T42) — one serial test per variant: commit the
      profile as the App spec on the fork's test branch, push the variant commit, and assert the product-visible result of
      the plan §4.3 row through `GET /api/works/:id/builds/:buildId` and Activity — ACC-05-12 (services-postgres, then
      `GET /state` lists no `build-time` row), ACC-05-14 (missing-value blocked naming the value), ACC-05-15
      (secret-in-image, nothing pushed, value absent from the response and Activity), ACC-05-17 (`dockerfileError`,
      `missingBuildValue`, `timeout`, `diskFull`).
      **Test**: `validate.yml` green on the Blueprint repository; live run of `flow-app-works-live-build-failures` on dev.
      **Done when**: every variant test passes on dev (or is `fixme('APW-05')` until APW-05 P1 merges) and no profile
      uses a `build.strategy` outside `dockerfile | image | auto | none` or a `keypair` generator without `format:`
      (R-11, R-13).

- [ ] **T60. Wave 1 hosts and the None target (added 2026-09-17, Resolutions R-12 and R-16).**
      **Modify** `apps/web/e2e/helpers/app-works.ts` — `readAssignedHosts(workId)` over `GET /api/works/:id/app-status`.
      **Modify** `apps/web/e2e/flow-app-works-live-blueprint-path.spec.ts` (T38) and
      `apps/web/e2e/flow-app-works-kind-runtime.spec.ts` (T35) — when the platform assigned `<slug>.<apps-domain>`, assert
      it resolves to the user cluster's ingress and serves `/marker`; otherwise assert only the custom domain serves it;
      assert the assigned apex is the installation's configured one — the platform domain on the default, a dedicated apex
      when one is configured — and assert no assigned host ends in **another Ever product's** domain (`ever.team`,
      `gauzy.co`, …), never merely "the platform's parent domain", which is now a valid default (R-16).
      **Modify** `apps/web/e2e/flow-app-work-target-none.spec.ts` (T33) and
      `apps/web/e2e/flow-app-works-live-no-deploy-target.spec.ts` (T40) — the target reads **None — don't deploy yet**,
      the stored value is `none`, and no "not yet" state is asserted anywhere.
      **Test**: `apps/web/e2e/helpers/__tests__/app-works.unit.spec.ts` gains a `readAssignedHosts` case; the kind lane
      (shared default apex) and a live nightly run on dev (ACC-13-20).
      **Done when**: the kind run passes the managed-address case, the nightly run passes whichever case dev is in, and a
      host under another Ever product's domain makes the assertion fail in a unit case.

---

# Additions from the 2026-09-17 fact re-check (FR-55…FR-65)

_Every task below is additive: each one adds a schema field, a job, a step or a variable, and none removes an existing
one._

- [ ] **T61. Evidence schema and the numeric component user (spec FR-57, FR-65).**
      **Create** in `ever-works/templates`: `schema/evidence.schema.json` — object, required
      `blueprint`/`upstream`/`license`/`platform`/`lane`/`passCount`/`runId`/`startedAt`/`steps`/`spend` — with
      `upstream.kind ∈ {pin, canary}`, `license.class ∈ {green, amber, red, unknown}` and `passCount` an integer ≥ 1, plus
      `scripts/__tests__/evidence-schema.test.mjs` (a file missing any field the status rules read fails validation).
      **Modify** APW-03's `schema.md` §10 and CONTRACTS §1 — add the optional numeric `components[].runAsUser`
      (integer ≥ 1) requested in [plan §14](./plan.md), and record the RE2 constraint on `env[].validate.pattern` that
      Cal.diy's administrator password depends on.
      **Test**: `node --test scripts/__tests__/evidence-schema.test.mjs` in `ever-works/templates`; the schema rejects a
      file without `license.class`; APW-03's `validate.mjs` accepts a spec with `components[].runAsUser: 1001` and rejects
      `runAsUser: 0`.
      **Done when**: T11's evidence builder validates against the published schema, and the two contract additions are
      recorded in their owners' files.

- [ ] **T62. Canary sink draft and its read API (spec FR-61, ACC-13-04).**
      **Create** in the private operations repository the sink's source (a tiny HTTPS service) and its deployment note,
      implementing the read API of [plan §5.3](./plan.md): `GET /requests?since=&limit=`, `GET /healthz`, bearer read
      token, `authorization` stripped before storage, `truncated` flag, `receivedAt` paging.
      **Modify** `<e2e-upstream-org>/app-fixture-injection` (T26) — every payload address is the **placeholder** base
      address `https://canary.invalid` until the harness rewrites it in the per-run generated copy; the repository's
      `git grep -nE 'https?://'` lists only placeholders and public documentation links.
      **Test**: `apps/web/e2e/helpers/__tests__/app-works-evidence.unit.spec.ts` (T11) against a local instance; the T26 review
      confirms no real address is committed. **Corrected 2026-09-18:** this line named `canary-sink.unit.spec.ts`, a file
      that was never created — T11's own Test line names the evidence spec, and the six FR-61 cases are green there.
      **Done when**: the sink answers a recorded request and the fixture repository contains no real sink address.

- [ ] **T63. The GitHub connection surface (spec FR-56; unblocks T14, T15, T16, T30, T31).**
      **Decide and land one** of the two surfaces of [plan §8.8](./plan.md), exactly as written there. Either
      **Modify** `packages/plugins/github/src/github.plugin.ts` (mode `hybrid` + a user-scope `x-secret` `accessToken`
      setting) and `packages/agent/src/plugins/services/plugin-operations.service.ts` (allow that one field at user scope,
      by name), with the security review recorded in the PR; or **Create** the non-production connection-seeding route for
      the PR lanes plus the operator-run OAuth connect for the live lanes, recorded in T20's estate file.
      **Create** `apps/web/e2e/helpers/github-connection.ts` (new, [plan §8.2](./plan.md)) — `connectCustomerGitHub` plus
      its state assertion.
      **Modify** APW-13's five marked specs — remove the
      `test.fixme('APW-13 T63: no supported GitHub connection surface')` marker in the same PR — and record the chosen
      surface in CONTRACTS (a §1 row, or §7 rows) and ACCEPTANCE §0.5.
      **Test**: `apps/web/e2e/helpers/__tests__/github-connection.unit.spec.ts` (new) — each surface asserts the state it
      claims, a refused surface fails with its name and no raw `400`, and (surface a) every other admin-only setting is
      still refused at user and work scope.
      **Done when**: T14, T15, T16, T30 and T31 run un-fixme'd against the fake and pass, and the contract row is merged.

- [ ] **T64. Lane switches, dev/stage enablement and the Agent credential (spec FR-65, S10).**
      **Modify** `.github/workflows/app-works-nightly.yml` (T36) and `.github/workflows/app-works-golden-path.yml` (T45) —
      set every switch the specs need (the web chip's non-production override, `EVER_WORKS_APP_WORKS_ENABLED`,
      `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`, `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`) and create the throwaway
      account's Agent with limited networking plus its model credential before the first Run, recording the Agent id in
      the estate file.
      **Create** `docs/runbooks/app-works-acceptance-lanes.md` rows (T56) or the private operations repository's runbook —
      `(owner action)` the dev and stage enablement: `works-app` on, `EVER_WORKS_APP_WORKS_ENABLED=true`,
      `EVER_WORKS_APP_LAUNCHER_ENABLED=true`, and the worker attestation
      (`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`) so APW-06 does not refuse App cluster jobs in production-shaped
      environments — with a read-back verification of each.
      **Test**: a dry-run dispatch lists every switch it set and reads each back from the platform; a lane started with one
      switch missing fails before any platform call and names it (S10, ACC-13-22).
      **Done when**: the nightly dry run passes with no switch assumed, and the dev/stage read-back is recorded in the
      private operations repository.

- [ ] **T65. Maintenance issues and their credential (spec FR-58).**
      **Create** `apps/web/e2e/helpers/blueprint-issues.ts` (new) — `openOrUpdateMaintenanceIssue`, whose input is
      `{ blueprintId, runs, firstFailingUpstreamCommit }`: deduplicated by label `verification-failure` plus the
      Blueprint id, updating the open issue when one exists and commenting otherwise.
      **Modify** the `evidence` job of `.github/workflows/app-works-nightly.yml` and
      `.github/workflows/app-works-golden-path.yml` — call it on a failure and on a canary failure, linking both runs.
      **Test**: `apps/web/e2e/helpers/__tests__/blueprint-issues.unit.spec.ts` (new) — two failures open exactly one
      issue; a third failure adds one comment and no new issue; a canary failure names the first failing upstream commit.
      **Done when**: the unit spec passes and the credential below is recorded — a least-privilege **GitHub App
      installation** for `ever-works/templates` and the three Blueprint repositories (issues and pull requests only, no
      contents write), named in ACCEPTANCE §0.4 in the same PR (the ready-to-paste row is in the change report).

- [ ] **T66. Per-Run token counts for the spend total (spec FR-59, ACC-13-16).**
      **Modify** `apps/web/e2e/helpers/app-works-live.ts` — `accountSpend(receipts: RunReceipt[])` reads
      `{ actionsMinutes, tokens }` from the Run and Build receipts of CONTRACTS §4 and the summary prints the total.
      **Modify** whichever owner ships it first: CONTRACTS §4's Run DTO (APW-05) or APW-08's `TaskCostView` — a per-Run
      token count, requested in [plan §13](./plan.md) and [plan §14](./plan.md).
      **Test**: `apps/web/e2e/helpers/__tests__/app-works-live.unit.spec.ts` (T8) gains a case with two receipts of known
      token counts and asserts the total; a receipt without a token count fails the accounting instead of being counted as
      zero.
      **Done when**: the summary's token figure comes from a real field, and no lane estimates it.

- [ ] **T67. Variant commits reach the fork (spec FR-60; T58's push half).**
      **Modify** `ever-works/app-fixture-hello` — a `variants.yml` job (T23/T58) that **rebases every `variant/*` branch
      onto `main`** whenever `main` moves, so a variant never drifts behind the base app.
      **Modify** `apps/web/e2e/flow-app-works-live-build-failures.spec.ts` (T42/T59) — push the variant commit to the
      fork's tracked branch with the **customer account's own token** (never the estate token) and, where the run starts
      from a generated upstream, assert the branch travelled with `include_all_branches: true` (T9) before falling back to
      a cherry-pick onto the fork head.
      **Test**: a case where the generated upstream carries `variant/*` and the fork's tracked branch is set from it; a
      case where the branch is absent and the cherry-pick path produces the same tree; the rebase job is red when a variant
      branch is behind `main`.
      **Done when**: a variant commit is verifiably present on the fork's tracked branch before the Build starts, and the
      `/_control/calls` record shows the customer's token identity on that push.

- [ ] **T68. Make the image pullable (spec FR-62, S20, ACC-13-24).**
      **Modify** `.github/workflows/app-works-kind.yml` (T34), `app-works-nightly.yml` (T36) and
      `app-works-golden-path.yml` (T45) — before the first Deployment, assert the image the lane will deploy is pullable:
      either the GHCR package is public, or the App Work holds the read-only pull token variable named in ACCEPTANCE §0.4.
      Record which path the lane used in the evidence file.
      **Create** `apps/web/e2e/helpers/image-pull.ts` (new) — `assertPullable({ packageRef, token? })`.
      **Test**: a lane pointed at a private package with no token fails with the platform's
      `pull_credential_unavailable` reason and names the package and the variable, never a rollout timeout; a public
      package passes with no token.
      **Done when**: ACC-13-24 is green on the kind lane and both paths are exercised once. **Probe first:** whether a
      package first pushed by `GITHUB_TOKEN` from a public fork defaults to public — the probe decides which path the
      fixture lanes take, and its result is recorded in the fixture README.

- [ ] **T69. Managed-constraint lint and the managed-compatible fixture profile (spec FR-63, ACC-13-25).**
      **Create** `ever-works/templates/scripts/managed-constraints.mjs` and its test — lint a Blueprint's static App spec
      for `cron` schedules that can fire more often than every 5 minutes, a root-running image, and a private-address
      dependency, and write the result into the evidence file's managed-hosting field.
      **Create** `ever-works/app-fixture-hello-template:profiles/managed-cron.works.yml` and the matching file in
      `ever-works/app-fixture-hello` — the every-5-minute `tick` profile of [plan §4.4](./plan.md); the every-2-minute
      profile stays exactly as it is.
      **Test**: `node --test scripts/__tests__/managed-constraints.test.mjs` in `ever-works/templates`; the lint marks
      Cal.diy's minute-level `tasker` and `webhook-triggers` crons as managed-hosting ineligible **and still reports the
      Blueprint as verified**, and marks the fixture's `managed-cron` profile eligible.
      **Done when**: every Blueprint's evidence carries a managed-hosting result, and ACC-E2E-10 (b) has a fixture
      Blueprint the tier admits.

- [ ] **T70. Test-catalog entry for generated upstreams (spec FR-9, ACC-13-21).**
      **Modify** `ever-works/templates`' `e2e` branch `manifest.json` (T29) — add an owner-scoped entry for
      `<e2e-upstream-org>/app-fixture-gen-*` pointing at Blueprint `app-fixture-hello`, so an App Work created from a
      per-run upstream is resolved from a verified Blueprint.
      **Modify** APW-03's `catalog.md` — a test-only rule that an owner-scoped repository pattern in the test catalog's
      `e2e` branch keeps verified status for an explicit match (requested in [plan §13](./plan.md)).
      **Test**: `GET /api/apps-catalog` on dev resolves `app-fixture-gen-<runId>` to the fixture Blueprint; the explicit
      choice for a repository outside the pattern is still refused managed hosting (APW-03 FR-81 unchanged).
      **Done when**: ACC-E2E-10 (b) can be set up from a per-run upstream without weakening APW-03 FR-81.

- [ ] **T71. Verification lane walls, per-job budgets and check minutes (spec FR-64, ACC-13-16).**
      **Modify** `.github/workflows/app-works-nightly.yml` (T36) and `app-works-golden-path.yml` (T45) — per-job
      `timeout-minutes` from the [plan §9.6](./plan.md) table, the lane's `timeout-minutes` above the sum, and a summary
      that prints Build minutes **and** `checksBillableMinutes` separately from runner minutes.
      **Test**: a full nightly dispatch — no job exceeds its budget, the summary's two minutes figures add up to
      `spend.actionsMinutes` in the evidence file, and a scenario that overruns its job fails that job with reason
      `budget`.
      **Done when**: ACC-13-16 is green with the per-job table in force and the numbers in the evidence match the summary.

- [ ] **T72. Cal.diy non-root variant and the root precondition (spec FR-26, R-27).**
      **Create** `ever-works/cal-template:variants/nonroot.Dockerfile` and its README row — a fork-side Dockerfile
      that adds a numeric non-root `USER` owning `apps/web/.next` and `apps/web/public`, so the managed tier stays open to
      Cal.diy. Marked unverified until a lane run passes.
      **Modify** `apps/web/e2e/flow-app-works-live-cal-diy-golden-path.spec.ts` (T46) — assert the App Work's deploy target
      carries `allowRoot: true` before the first Deployment, and record that assertion in the evidence.
      **Test**: the golden-path run on stage asserts the target setting before creating the App Work; the variant is built
      once in the Blueprint repository's CI without being deployed, and its result is recorded as unverified or verified
      on its own evidence.
      **Done when**: the golden path runs on a target whose `allowRoot` the lane asserted, and the non-root variant has a
      recorded status of its own — with no existing deploy shape removed (R-27).

- [ ] **T73. Fixture repository facts the apps rely on (added 2026-09-17).**
      **Modify** `ever-works/app-fixture-hello` — `package.json` keeps `dependencies` and `devDependencies` **empty**
      (`format:check` runs the repository's own `tools/format-check.mjs`, and `src/pg.mjs` speaks the wire protocol, so no
      package is needed) and the `runtime` stage installs with `npm ci --omit=dev`; add topics to `app-fixture-hello`
      itself (`ever-works-app-fixture`, `ever-works-test-fixture`) and mark it a **template repository**, which T9's
      `generateFromTemplate` requires.
      **Modify** `ever-works/app-fixture-hello-template:README.md` and the draft's blueprint README — the fixture builds
      in under three minutes **as measured by its own CI**, and the recorded figure replaces the estimate of
      [plan §4.5](./plan.md); the disk-reclaim step is part of the budget.
      **Test**: `gh api repos/ever-works/app-fixture-hello --jq '.is_template, .topics'` shows `true` and both topics;
      `npm ci && npm run format:check` passes with an empty dependency set; the image CI's recorded wall time is quoted in
      the README.
      **Done when**: the repository is a template with the topics, and no estimate remains quoted as a measurement.

---

## Definition of Done

- Every checkbox above is ticked, or carries a `fixme` naming an unmerged epic that the TRACKER shows as not merged.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` and `test:e2e-harness` are green
  (`ci.yml`'s `lint-and-test` runs `test:e2e-harness` since `1be4770c9`).
- The existing `e2e.yml`, `k8s-e2e.yml` and `smoke-deployed.yml` runs pass with no change to any pre-existing spec.
- No file under `apps/web/e2e/` can delete a GitHub repository (T9), and no live spec can target production (T8).
- The nightly lane has five consecutive green runs on dev and the golden-path lane three on stage.
- No document, Blueprint, fixture or workflow in a public repository names a test-estate address, an internal host or an
  upstream security finding.
