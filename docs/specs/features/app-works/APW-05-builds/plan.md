# Implementation Plan: Builds

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail;
> the spec owns behaviour. **Every existing path below was opened in the worktree before it was written
> down**; paths marked **(new)** do not exist yet and are created by [`tasks.md`](./tasks.md).

**Epic ID**: `APW-05-builds`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Program contracts**: [`../CONTRACTS.md`](../CONTRACTS.md) (this epic owns `build`, `IBuildPlugin`, `WorkBuild`,
the builds routes, `app-build-*` jobs and `app.build.*` events)
**Status**: `Draft`
**Last updated**: 2026-09-17

> **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding--2026-09-17-against-develop--ee45946e5))
> binding on this plan: **R-1** shared types in `packages/contracts/src/apps/` (§3.2); **R-2** Activity `action` =
> dotted event, `actionType` = `app_build` (§7.3); **R-4** a linked repository always gets a pull request (§4.6);
> **R-5** the managed builder resolves only through `AppsTierPolicy` (§4.13); **R-7** `WorkCapabilities.builds` is set
> for `app` by APW-01 (§6.1); **R-9** the `checks` matrix job (§2.4, §4.14); **R-10** `startBuild({ verification })`
> with APW-07's ephemeral mode (§4.10); **R-13** strategy `auto` (§4.1, §7.2); **R-22** no `apps/api/test/` suites
> (§10); **R-23** fixture branches are APW-13's (§10.3); **R-24** sandboxed in-zone builds are Wave 3 / LG-24 (§4.13).

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer        | File                                                                                                                                                                                                                                                         | What it does                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract     | [`packages/plugin/src/contracts/capabilities/deployment.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/deployment.interface.ts)                                                                                                    | `IDeploymentPlugin` — the model for a capability interface: `providerName`, required + optional methods, `getWorkflowFilenames?`, `getDeploymentSecrets?`, and the `isDeploymentPlugin` guard over `capabilities.includes('deployment')`.                                                      |
| Contract     | [`packages/plugin/src/contracts/capabilities/index.ts`](../../../../../packages/plugin/src/contracts/capabilities/index.ts)                                                                                                                                  | Barrel of every capability interface. No `build`.                                                                                                                                                                                                                                              |
| Contract     | [`packages/plugin/src/contracts/facade-capabilities.ts`](../../../../../packages/plugin/src/contracts/facade-capabilities.ts)                                                                                                                                | `PLUGIN_CAPABILITIES` map → `PluginCapability` union + `isValidPluginCapability`. No `BUILD`.                                                                                                                                                                                                  |
| Contract     | [`packages/plugin/src/contracts/plugin-manifest.types.ts`](../../../../../packages/plugin/src/contracts/plugin-manifest.types.ts)                                                                                                                            | `PLUGIN_CATEGORIES` tuple — "single source of truth for plugin categories". No `build`.                                                                                                                                                                                                        |
| Contract     | [`packages/plugin/src/contracts/plugin.interface.ts`](../../../../../packages/plugin/src/contracts/plugin.interface.ts)                                                                                                                                      | `IPlugin`: `id`, `category`, `capabilities`, `settingsSchema`, and `validateSettings?` which **may be async** — the hook the pull-token check uses.                                                                                                                                            |
| Contract     | [`packages/plugin/src/contracts/capabilities/git-provider.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/git-provider.interface.ts)                                                                                                | `GitWorkflowRun` (`status`, `conclusion`, `url`, `runAttempt`, pull request numbers) and `getWorkflowRunForCommit?`. File writes exist only as clone → `add` → `commit` → `push`; there is no REST file write.                                                                                 |
| Plugin       | [`packages/plugins/k8s/package.json`](../../../../../packages/plugins/k8s/package.json)                                                                                                                                                                      | The `everworks.plugin` block shape (`id`, `category`, `capabilities`, `autoEnable`, `builtIn`, `visibility`) the new package copies.                                                                                                                                                           |
| Plugin       | [`packages/plugins/k8s/src/registries/provider.ts`](../../../../../packages/plugins/k8s/src/registries/provider.ts), [`github.provider.ts`](../../../../../packages/plugins/k8s/src/registries/github.provider.ts)                                           | `RegistryProvider` strategy. GHCR: `imageBase` lower-cases the owner; `resolveVisibility('auto')` is private when repository visibility is unknown; `pullSecretCredentials` returns an empty password the caller must inject.                                                                  |
| Plugin       | [`packages/plugins/k8s/src/k8s.plugin.ts`](../../../../../packages/plugins/k8s/src/k8s.plugin.ts) (~line 692)                                                                                                                                                | `sanitiseDockerTag((opts.gitSha ?? '').slice(0, 12))` — a tag is truncated to 12 characters, which is why a commit cannot address an image today and why App Works deploy by **digest**.                                                                                                       |
| Plugin       | [`packages/plugins/github/src/github-actions.service.ts`](../../../../../packages/plugins/github/src/github-actions.service.ts)                                                                                                                              | `getRepositoryPublicKey`, `setActionSecret` (libsodium sealed box; name `^[A-Z_][A-Z0-9_]{0,254}$`, refuses `GITHUB_`), `listWorkflows`, `enable/disableWorkflow`, `enableDeploymentWorkflows` (sleeps 7 s, enables only `ACTIVE_WORKFLOW_FILES`), `dispatchWorkflow` (**returns no run id**). |
| Plugin       | [`packages/plugins/github/src/types.ts`](../../../../../packages/plugins/github/src/types.ts)                                                                                                                                                                | `ACTIVE_WORKFLOW_FILES` — the three template deploy workflows. Untouched by this epic.                                                                                                                                                                                                         |
| Plugin       | [`packages/plugins/github/src/github-api.service.ts`](../../../../../packages/plugins/github/src/github-api.service.ts) (`getWorkflowRunForCommit`)                                                                                                          | Lists runs by `head_sha`, filters by workflow file name, newest run id then `run_attempt` wins; 404 → `null`, 403/5xx throw. The polling shape this epic copies.                                                                                                                               |
| Plugin       | [`packages/plugin/src/common/github.scopes.ts`](../../../../../packages/plugin/src/common/github.scopes.ts)                                                                                                                                                  | `GITHUB_FULL_SCOPES` includes `repo` and `workflow` (writing a workflow file needs `workflow`) but **not** `read:packages` — the user's connection cannot call the Packages API.                                                                                                               |
| Facade       | [`packages/agent/src/facades/git.facade.ts`](../../../../../packages/agent/src/facades/git.facade.ts)                                                                                                                                                        | `getAccessToken`, `getWorkflowRunForCommit`, `createPullRequest`, and `resolvePluginAndToken` (explicit token → managed PAT → App installation → OAuth → settings PAT).                                                                                                                        |
| Facade       | [`packages/agent/src/facades/base.facade.ts`](../../../../../packages/agent/src/facades/base.facade.ts), [`metrics.facade.ts`](../../../../../packages/agent/src/facades/metrics.facade.ts)                                                                  | `BaseFacadeService` resolution chain (override → Work active → default → first enabled), `getResolvedSettings`, plus the usage-recording pattern around a provider call.                                                                                                                       |
| API          | [`apps/api/src/plugins-capabilities/deploy/deploy.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.service.ts)                                                                                                                    | `setKubernetesGhcrPullSecret` and `resolveGhcrReadToken` resolve pull credentials for platform-generated sites; `deployServerSideManaged` deploys a **branch alias** tag; `collectServerSideRuntimeEnv`. None of this is reused for App Works.                                                 |
| API          | [`apps/api/src/plugins/plugins.controller.ts`](../../../../../apps/api/src/plugins/plugins.controller.ts)                                                                                                                                                    | `PATCH works/:workId/plugins/:pluginId/settings` — how per-App-Work build settings and the pull token are saved (`x-secret` handled by the settings service).                                                                                                                                  |
| Ingest       | [`apps/api/src/ingest/github/github-webhook-dispatcher.service.ts`](../../../../../apps/api/src/ingest/github/github-webhook-dispatcher.service.ts)                                                                                                          | The single verified GitHub receiver; `registerConsumer({ events, handle(binding, eventName, body) })` from `onModuleInit`.                                                                                                                                                                     |
| Ingest       | [`apps/api/src/ingest/github/github-check-intake.service.ts`](../../../../../apps/api/src/ingest/github/github-check-intake.service.ts)                                                                                                                      | Existing `workflow_run` consumer: normalises fields but **drops every non-completed delivery** and resolves no Work. It stays as is; a second consumer is registered for builds.                                                                                                               |
| Jobs         | [`packages/agent/src/tasks/kb-reembed-work-dispatcher.ts`](../../../../../packages/agent/src/tasks/kb-reembed-work-dispatcher.ts), [`_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts)                                          | Dispatcher interface + `Symbol()` token; every runtime symbol listed alphabetically in `TASKS_BARREL_RUNTIME_SYMBOLS`.                                                                                                                                                                         |
| Jobs         | [`packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`](../../../../../packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts)                                                                                                                | Scheduled poller shape: `schedules.task({ id, cron })`, Nest application context, service call, close.                                                                                                                                                                                         |
| Jobs         | [`packages/agent/src/cache/distributed-task-lock.service.ts`](../../../../../packages/agent/src/cache/distributed-task-lock.service.ts)                                                                                                                      | Overlap guard for ticks with no owning row. Builds use atomic row claims instead (§7.6).                                                                                                                                                                                                       |
| Usage        | [`packages/agent/src/usage/plugin-usage.service.ts`](../../../../../packages/agent/src/usage/plugin-usage.service.ts)                                                                                                                                        | `record(RecordPluginUsageInput)` — `units`, `costCents`, `operation`, `outcome`, `payer`, `metadata`; never throws.                                                                                                                                                                            |
| Usage        | [`packages/agent/src/entities/plugin-usage-event.entity.ts`](../../../../../packages/agent/src/entities/plugin-usage-event.entity.ts), [`packages/contracts/src/billing/meter.types.ts`](../../../../../packages/contracts/src/billing/meter.types.ts)       | `PluginUsageCapability` is a varchar enum (additive values need no migration); payer `workspace` = "a credential the Workspace owns".                                                                                                                                                          |
| Entity       | [`packages/agent/src/entities/work-deployment.entity.ts`](../../../../../packages/agent/src/entities/work-deployment.entity.ts)                                                                                                                              | Conventions copied by `WorkBuild`: `TimestampColumn` from `_types.ts`, `ManyToOne(Work, CASCADE)`, Tier A `tenantId`/`organizationId` without relations.                                                                                                                                       |
| Activity     | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts), [`packages/agent/src/activity-log/activity-log.service.ts`](../../../../../packages/agent/src/activity-log/activity-log.service.ts) | `ActivityActionType` enum + `log(entry)` with `actionType`, `action`, `summary`, `metadata`.                                                                                                                                                                                                   |
| Secrets      | [`packages/agent/src/plugins/services/plugin-secret-enc.service.ts`](../../../../../packages/agent/src/plugins/services/plugin-secret-enc.service.ts)                                                                                                        | `enc::v1::` AES-256-GCM envelope for `x-secret` settings (`PLUGIN_SECRET_ENCRYPTION_KEY`), required in production.                                                                                                                                                                             |
| Contracts    | [`packages/contracts/src/domain/work-capabilities.ts`](../../../../../packages/contracts/src/domain/work-capabilities.ts)                                                                                                                                    | `WorkCapabilities` hide-list consumed by API, agent and web; every kind-conditional decision routes through it.                                                                                                                                                                                |
| Web          | [`apps/web/src/components/works/detail/WorkTabs.tsx`](../../../../../apps/web/src/components/works/detail/WorkTabs.tsx)                                                                                                                                      | Tab strip, `visible` per tab from `getWorkCapabilities(work.kind)`, i18n namespace `dashboard.workDetail.tabs`.                                                                                                                                                                                |
| Web          | [`apps/web/src/components/works/detail/overview/`](../../../../../apps/web/src/components/works/detail/overview)                                                                                                                                             | `WorkInfo.tsx`, `WorkStats.tsx`… — where the **Latest build** card is added.                                                                                                                                                                                                                   |
| CI precedent | [`.github/workflows/k8s-build.yml`](../../../../../.github/workflows/k8s-build.yml)                                                                                                                                                                          | This repository's own image lane: `cancel-in-progress: false` with a measured rationale (cancelling starved production builds), registry cache `:buildcache` `mode=max`, `permissions: contents: read, packages: write`.                                                                       |
| Migrations   | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations)                                                                                                                                                                                         | Newest on `develop` @ `ee45946e5`: `1791240000000-AddSafetyRailsCore.ts` (`1791200100000-CreateOnboardingChecklists.ts` when authored). APW-05 block: `17920500…`.                                                                                                                             |

### 1.2 The exact blockers

- **No capability and no category.** `build` exists in neither `PLUGIN_CAPABILITIES` nor `PLUGIN_CATEGORIES`, so
  no plugin can declare it and no facade can resolve it.
- **Dispatch returns no run id.** `dispatchWorkflow` → `createWorkflowDispatch` answers 204. A Rebuild must be
  correlated to its run some other way (§4.8).
- **The existing `workflow_run` intake cannot drive Builds.** It ignores `queued`/`in_progress` and never maps a
  repository to a Work.
- **Writing one file means cloning the repository.** Repository writes go through `GitOperations` (no depth, per
  EXISTING-SUBSTRATE §3). Cloning a 1 GB data repository to add one workflow file is not acceptable; the workflow
  is written through APW-03's clone-free `IGitProviderPlugin.commitFiles?` (CONTRACTS §3), handed to the plugin (§4.6).
- **Tags cannot address a commit.** The k8s plugin truncates tags to 12 characters; Builds record digests instead.
- **Existing pull credential resolution is not reused for App Works.** It was built for platform-generated sites,
  whose credentials are chosen for the platform's own repositories. App Works use a per-App-Work token that can only
  read packages (§4.12), so a cluster running user-controlled code never holds a credential that can do more.
- **Nothing runs App checks in the repository's CI.** APW-08 needs the App spec's checks as ordinary provider check runs
  on the pull request (Resolution R-9); only this epic writes a workflow into the data repository (§2.4, §4.14).
- **No webhook is guaranteed.** Repository webhooks are APW-02 (`createWebhook?`); App deliveries may not cover a fork.

### 1.3 What already exists and must be reused, not rebuilt

- **Secret sealing** — `GitHubActionsService.setActionSecret`'s libsodium sealed-box sequence and name validation,
  reproduced (about 15 lines) against the plugin's own Octokit, since plugins do not import other plugins.
- **Run lookup** — `getWorkflowRunForCommit`'s newest-run rule; **webhooks** — `registerConsumer`, no second receiver.
- **Jobs** — `kb-reembed-work-dispatcher.ts`, `deploy-ready-poller.task.ts`; **receipts** — `PluginUsageService.record`
  (payer `workspace`); **secrets at rest** — the settings cascade with `x-secret`; **concurrency** — `k8s-build.yml`.

---

## 2. Architecture and the seams this plugs into

### 2.1 Pieces

```
  app.spec.applied (APW-03) ──┐   app.env.changed, phase build|both (APW-07) ──┐   POST /builds (Rebuild)
                              ▼                                                ▼          ▼
                     AppBuildsService.requestPrepare()  ───────────►  APP_BUILD_PREPARE_DISPATCHER
                                                                              │
                                                              job app-build-prepare { workId, buildId? }
                                                                              │
                              BuildFacadeService.resolve(workId) ──► IBuildPlugin (github-actions-build)
                                    ├─ prepareRepository(): workflow file (commit | PR) incl. the checks job
                                    │                       (R-9, from spec.checks), EW_ secret sync
                                    └─ startBuild(): workflow_dispatch   (manual + verification only)

  GitHub workflow_run ─► GitHubWebhookDispatcherService ─► AppBuildWorkflowRunConsumer (NEW)
                                                               │ upsert work_builds by run id
  cron app-build-sweep (*/2) ── silent non-terminal Builds ────┤
                                                               ▼
                                              APP_BUILD_WATCH_DISPATCHER → job app-build-watch { buildId }
                                                  IBuildPlugin.getBuild() → BuildSnapshot
                                                  terminal ⇒ result artifact → digest confirm → classify
                                                           → receipt → deployable verdict → events
                                                               │
                              EventEmitter2 'app.build.succeeded' (deployable) ─► APW-06 app-deploy
                              Activity  app.build.* (names, ids, class — never values)
```

### 2.2 Sequence — first Build on a fork with an unprotected branch

1. APW-03 emits `app.spec.applied { workId, commitSha, specHash }`; `AppBuildsListener` dispatches `app-build-prepare`.
2. The job resolves the plugin, build values (APW-07) and runner; `prepareRepository` checks branch protection (404 =
   none), seals and writes `EW_` secrets, writes blob → tree → commit → ref on `main`, reads the file back.
3. GitHub starts the run (push). `workflow_run requested` reaches `AppBuildWorkflowRunConsumer`, which inserts Build #1
   `queued` and dispatches `app-build-watch`; `in_progress` and `completed` deliveries dispatch it again.
4. `app-build-watch` calls `getBuild` (jobs, minutes, result artifact, log tail on failure), confirms the digest,
   computes the deployable verdict, records the receipt, writes Activity and emits `app.build.succeeded`.

### 2.3 Sequence — Rebuild and correlation

`POST /api/works/:id/builds` inserts Build #n (`queued`, trigger `manual`, `dispatchCorrelationId = build.id`) and
dispatches `app-build-prepare { workId, buildId }`. The job syncs secrets, then `startBuild` dispatches the workflow
on the tracked branch with inputs `ew_build_id`, `ew_sha`, `ew_mode=build`. The workflow's `run-name` is
`Ever Works build ${{ inputs.ew_build_id || github.sha }}`; the observer lists `workflow_dispatch` runs of the file
created at or after the dispatch time minus 5 seconds and adopts the one whose `display_title` contains the Build id.
Until adoption the Build is `queued` with `providerRunId = null`; a Build not adopted within 5 minutes is re-listed
by the sweep and failed as `lost` after its timeout plus 30 minutes.

### 2.4 The generated workflow (normative sketch)

Values in `<…>` are filled by the generator; `‹pin:…›` comes from `ACTION_PINS` (§4.5). Blocks marked _if_ are
emitted only when their condition holds.

```yaml
# Generated by Ever Works from .works/works.yml. Do not edit: hand edits are never overwritten;
# Ever Works proposes changes to this file as pull requests.
# ever-works-build generator=1 inputs=sha256:<64 hex of canonical inputs>
name: Ever Works build
run-name: "Ever Works build ${{ inputs.ew_build_id || github.event.pull_request.head.sha || github.sha }}"
on:
  push: { branches: ["<tracked branch>"] }
  pull_request: { branches: ["<tracked branch>"], types: [opened, synchronize, reopened] }
  workflow_dispatch:
    inputs:
      ew_build_id: { type: string, required: true }                    # + ew_sha (string, required)
      ew_mode: { type: choice, options: [build, verify], default: build }
      ew_verify_plan: { type: string, required: false, default: "" }   # base64url JSON, ≤ 60,000 chars
permissions: {}
concurrency:
  group: ever-works-build-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref_name }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  build:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: <runner label>
    timeout-minutes: <build.resources.timeoutMinutes + (30 when a verification plan may run)>
    permissions: { contents: read, packages: write }          # + attestations: write, id-token: write (if enabled)
    services:                                                   # if build.services non-empty
      <name>: { image: "<image>", env: {…}, ports: ["<port>:<port>"], options: "<health options by known image>" }
    env:
      EW_IMAGE: ghcr.io/<owner lower>/<repo lower>/ever-works-app
      EW_SHA: ${{ inputs.ew_sha || github.event.pull_request.head.sha || github.sha }}
      EW_SECRET_NAMES: "<space-separated EW_ names whose env entries are secret and not build-service derived>"
    steps:
      - name: Check build values                              # if any fromEnv args
        env: { EW_<NAME>: "${{ secrets.EW_<NAME> }}", … }
        run: <prints names only; `echo "EW_MISSING:<NAME>"; exit 78` on the first empty required value>
      - uses: actions/checkout@‹pin:checkout›
        with: { ref: "${{ env.EW_SHA }}", fetch-depth: 1, persist-credentials: false, lfs: false }
      - name: Reclaim runner disk                             # if setting reclaimDisk (default true)
        run: sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL
      - uses: docker/setup-buildx-action@‹pin:setup-buildx›
        with: { buildkitd-flags: "--allow-insecure-entitlement network.host" }   # if services
      - uses: docker/login-action@‹pin:login›
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - id: build
        if: inputs.ew_mode != 'verify'
        uses: docker/build-push-action@‹pin:build-push›
        with:
          context: <build.context>
          file: <build.context>/<build.dockerfile>
          target: <build.target>                                # if set
          load: true
          push: false
          provenance: false
          network: host                                         # if services
          allow: network.host                                   # if services
          build-args: |
            <NAME>=<literal value>                              # value args, as written in the App spec
            <NAME>=${{ secrets.EW_<NAME> }}                     # fromEnv args
          tags: |
            ${{ env.EW_IMAGE }}:sha-${{ env.EW_SHA }}
            ${{ env.EW_IMAGE }}:${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('branch-{0}', '<branch slug>') }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ env.EW_SHA }}
            io.ever-works.app-spec-hash=<hash>
          cache-from: type=registry,ref=${{ env.EW_IMAGE }}:buildcache
          cache-to: ${{ github.event_name == 'push' && format('type=registry,ref={0}:buildcache,mode=max', env.EW_IMAGE) || '' }}
      - name: Check the image for secret build values          # if EW_SECRET_NAMES non-empty
        if: inputs.ew_mode != 'verify'
        env: { EW_<NAME>: "${{ secrets.EW_<NAME> }}", … }
        run: <§4.11 — exit 79 with EW_SECRET_IN_IMAGE:<NAME>; never echoes a value>
      - name: Push
        if: inputs.ew_mode != 'verify'
        run: docker push --all-tags "$EW_IMAGE" && docker image inspect --format '{{index .RepoDigests 0}}' "$EW_IMAGE:sha-$EW_SHA" > ew-digest.txt
      - name: Verify in the runner                            # if a verification plan may run
        if: inputs.ew_verify_plan != ''
        timeout-minutes: 30
        run: <§4.10 embedded verify runner>
      - name: Write result
        if: always()
        run: <writes ever-works-build-result.json, ≤ 8 KB: schema, buildId, sha, imageRepository, digest, tags, secretCheck, verify results>
      - uses: actions/upload-artifact@‹pin:upload-artifact›
        if: always()
        with: { name: ever-works-build-result, path: ever-works-build-result.json, retention-days: 7, if-no-files-found: ignore }

  checks:                                                       # if spec.checks non-empty (R-9); the only job when strategy is image|none
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    name: "Ever Works check: ${{ matrix.check.name }}"          # the check run name, exactly (FR-65)
    runs-on: <runner label>                                     # same selection as the build job (§4.4)
    timeout-minutes: ${{ matrix.check.timeoutMinutes }}
    continue-on-error: ${{ !matrix.check.required }}            # advisory checks never fail the run (FR-68)
    permissions: { contents: read }                             # nothing else (FR-66)
    strategy:
      fail-fast: false
      max-parallel: 5
      matrix:
        check:                                                  # one entry per spec.checks[], in declared order
          - { name: "<name>", required: <true|false>, timeoutMinutes: <ceil(timeoutSeconds / 60)>, commandB64: "<base64 of command>" }
    steps:
      - uses: actions/checkout@‹pin:checkout›
        with: { ref: "${{ github.event.pull_request.head.sha }}", fetch-depth: 1, persist-credentials: false, lfs: false }
      - name: Run check
        env: { EW_CHECK_COMMAND_B64: "${{ matrix.check.commandB64 }}" }
        run: printf '%s' "$EW_CHECK_COMMAND_B64" | base64 -d > "$RUNNER_TEMP/ew-check.sh" && bash -e "$RUNNER_TEMP/ew-check.sh"
```

Why these choices: `load` + a separate push means a secret found in the image metadata is caught **before** any
byte leaves the runner (FR-21). `cache-to` only on `push` events keeps pull requests read-only on the cache (FR-26).
`permissions: {}` at the top and job-level grants keep FR-12 checkable by grep. The concurrency expression implements
FR-14 with GitHub's native "one running, one pending, newest pending wins" behaviour. The `checks` job has no `needs`,
so a failed image build never skips a check (FR-69); its job-level `name` makes each matrix entry report the check run
`Ever Works check: {name}` without GitHub's matrix suffix; commands travel base64-encoded so neither YAML nor the
`${{ }}` expression engine ever interprets a byte of repository-authored text (FR-67); the job references no `secrets.*`
and no `EW_*` variable (FR-66, asserted by the generator test).

---

## 3. Data model

**Workspace backup (Resolution R-25).** `WorkBuild` exports as `data/works/builds.jsonl` through the parent Work ids; its secret-name and spec-hash columns are reviewed as benign and `buildInputsHash` is dropped ([tasks](./tasks.md) T45).

### 3.1 `work_builds` — the new table

```
work_builds
├── id uuid PK · workId uuid NOT NULL FK works.id ON DELETE CASCADE
├── number int NOT NULL                 per-App-Work sequence from 1 (APW-06 shows "Build #14")
├── buildPluginId varchar(64) NOT NULL
├── status varchar(16) NOT NULL         queued|running|succeeded|failed|cancelled|blocked
├── trigger varchar(16) NOT NULL        push|pull_request|manual|verification
├── blockedReason varchar(40) NULL · blockedDetail simple-json NULL (names and numbers only, ≤ 2 KB)
├── cancelReason varchar(16) NULL       user|superseded
├── branch varchar(255) NOT NULL · commitSha varchar(40) NOT NULL · pullRequestNumber int NULL
├── providerRunId varchar(64) NULL · runAttempt int NOT NULL DEFAULT 1
├── dispatchCorrelationId uuid NULL (= id for manual/verification) · dispatchedAt timestamp NULL
├── appSpecHash varchar(64) NULL · specValidAtCommit boolean NULL (AppSpecService.getEffectiveSpec(workId, sha), APW-03)
├── buildInputsHash varchar(64) NULL    sha256 over (name, fingerprint) of the synced build values (§4.7)
├── buildSecretNames simple-json NULL   string[] ≤ 50 — the EW_ names this preparation wrote
├── secretsSyncedAt timestamp NULL
├── runnerLabel varchar(64) NULL · runnerClass varchar(24) NULL (github-public|github-private|github-larger|apps-builder)
├── imageRepository varchar(255) NULL · imageDigest varchar(71) NULL (sha256:<64>) · imageTags simple-json NULL (≤ 3)
├── digestConfirmed boolean NOT NULL DEFAULT false · secretCheck varchar(16) NULL (passed|failed|not_needed)
├── deployable boolean NOT NULL DEFAULT false · notDeployableReason varchar(40) NULL
├── failureClass varchar(32) NULL
├── failureDetail simple-json NULL      { step?, total?, command? (≤ 120), names?: string[], memory?, max? }
├── failureExcerpt simple-json NULL     string[] ≤ 20, each ≤ 300, redacted
├── verificationResult simple-json NULL { componentsReady, jobs[] ≤ 10, smoke[] ≤ 50 } (CONTRACTS §3 shape)
├── verifiesBuildId uuid NULL           verification run that reused an earlier Build's image
├── logsUrl varchar(512) NULL
├── queuedAt · startedAt · completedAt · lastObservedAt · watchLeaseUntil   timestamp NULL
├── durationSeconds int NULL · billableMinutes int NULL · checksBillableMinutes int NULL (R-9; part of billableMinutes)
├── verifySecretNames simple-json NULL  string[] — per-run prompted-value secret written for a verification (§4.10), removed at the end
├── usageEventId uuid NULL (plugin_usage_events.id, the receipt, no FK) · triggeredByUserId uuid NULL
├── tenantId · organizationId uuid NULL (Tier A scope, stamped by the subscriber)
└── createdAt · updatedAt timestamp NOT NULL
```

| Index                             | Columns                                                                                        | Why                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `uq_work_builds_work_number`      | `(workId, number)` UNIQUE                                                                      | Build numbers never repeat.                              |
| `uq_work_builds_provider_run`     | `(buildPluginId, providerRunId, runAttempt)` UNIQUE, partial `WHERE providerRunId IS NOT NULL` | Webhook and poll upserts converge on one row.            |
| `idx_work_builds_work_created`    | `(workId, createdAt)`                                                                          | The Builds list.                                         |
| `idx_work_builds_work_commit`     | `(workId, commitSha)`                                                                          | Rebuild dedupe (FR-42), APW-06 "green Build for commit". |
| `idx_work_builds_status_observed` | `(status, lastObservedAt)`                                                                     | The sweep (§7.4).                                        |

`number` is assigned inside the insert transaction: `SELECT COALESCE(MAX(number), 0) + 1 … FOR UPDATE` on Postgres;
on unique violation the insert retries up to 3 times (SQLite test databases take the same path without the lock).

### 3.2 Shared types — `packages/contracts/src/apps/builds.ts` (new)

```ts
export const APP_BUILD_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'] as const;
export const APP_BUILD_TRIGGERS = ['push', 'pull_request', 'manual', 'verification'] as const;
export const APP_BUILD_FAILURE_CLASSES = [
	'outOfMemory',
	'diskFull',
	'dockerfileError',
	'dependencyDownloadFailed',
	'registryPushDenied',
	'missingBuildValue',
	'secretInImage',
	'timeout',
	'workflowInvalid',
	'digestMismatch',
	'verificationFailed',
	'egressBlocked',
	'lost',
	'unknown'
] as const;
export const APP_BUILD_BLOCKED_REASONS = [
	'workflowPending',
	'workflowEditedByHand',
	'workflowWriteFailed',
	'actionsDisabled',
	'missingBuildValues',
	'runnerTooSmall',
	'tooManyBuildValues',
	'buildValueTooLarge',
	'secretLimitReached',
	'strategyNotSupported',
	'specInvalid',
	'gitConnectionMissing',
	'repositoryUnavailable',
	'managedConcurrencyLimit',
	'buildValueNameReserved' // an env name that maps onto EW_VERIFY__PROMPTED (§4.10)
] as const;
export const APP_BUILD_NOT_DEPLOYABLE_REASONS = [
	'notSucceeded',
	'pullRequest',
	'verification',
	'specInvalid',
	'staleInputs',
	'secretCheckFailed',
	'digestUnconfirmed',
	'criticalVulnerability',
	'unsigned'
] as const;
// … `type X = (typeof X_CONST)[number]` for each, plus:
export interface AppBuildSummary {
	id: string;
	number: number;
	status: AppBuildStatus;
	trigger: AppBuildTrigger;
	branch: string;
	commitSha: string;
	pullRequestNumber: number | null;
	blockedReason: AppBuildBlockedReason | null;
	blockedDetail: Record<string, string | number | string[]> | null;
	deployable: boolean;
	notDeployableReason: AppBuildNotDeployableReason | null;
	imageRepository: string | null;
	imageDigest: string | null;
	imageTags: string[];
	failureClass: AppBuildFailureClass | null;
	queuedAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationSeconds: number | null;
	logsUrl: string | null;
}
export interface AppBuildDetail extends AppBuildSummary {
	runnerClass: string | null;
	runnerLabel: string | null;
	buildValueNames: string[];
	failureDetail: Record<string, unknown> | null;
	failureExcerpt: string[];
	verificationResult: AppBuildVerificationResult | null;
	receipt: {
		billableMinutes: number | null;
		checksBillableMinutes: number | null;
		payer: 'workspace' | 'platform';
		costKnown: boolean;
	} | null;
	triggeredBy: { userId: string; name: string } | null;
	canEdit: boolean;
}

export const APP_BUILD_WORKFLOW_PATH = '.github/workflows/ever-works-build.yml';
export const APP_BUILD_WORKFLOW_BRANCH = 'ever-works/build-workflow';
export const APP_BUILD_SECRET_PREFIX = 'EW_',
	APP_BUILD_IMAGE_NAME = 'ever-works-app',
	APP_BUILD_GENERATOR_VERSION = 1;
export const APP_BUILD_MAX_VALUES = 50,
	APP_BUILD_SECRET_MAX_BYTES = 48_000,
	APP_BUILD_SECRET_CHECK_MIN_CHARS = 8;
export const APP_BUILD_REBUILD_DEDUPE_MS = 10_000,
	APP_BUILD_REBUILDS_PER_HOUR = 10,
	APP_BUILD_ENV_SYNC_SLA_MS = 60_000;
export const APP_BUILD_POLL_AFTER_SILENCE_MS = 90_000,
	APP_BUILD_SWEEP_BATCH = 200,
	APP_BUILD_ADOPT_WINDOW_MS = 300_000;
export const APP_BUILD_LOST_GRACE_MINUTES = 30,
	APP_BUILD_RESULT_MAX_BYTES = 8_192,
	APP_BUILD_LOG_TAIL_BYTES = 2_097_152;
export const APP_BUILD_EXCERPT_MAX_LINES = 20,
	APP_BUILD_EXCERPT_MAX_LINE_CHARS = 300,
	APP_BUILD_RUNNER_HEADROOM_GIB = 2;
export const APP_BUILD_RUNNERS = {
	githubPublic: { label: 'ubuntu-latest', vcpu: 4, memoryGiB: 16 },
	githubPrivate: { label: 'ubuntu-latest', vcpu: 2, memoryGiB: 7 }
} as const;
export const APP_BUILD_VERIFY_TIMEOUT_MINUTES = 30,
	APP_BUILD_VERIFY_MEMORY_GIB = 12,
	APP_BUILD_VERIFY_PLAN_MAX_CHARS = 60_000;
export const APP_BUILD_PULL_TOKEN_EXPIRY_WARN_DAYS = 14,
	APP_BUILD_LIST_PAGE_SIZE = 20,
	APP_BUILD_LIST_MAX_PAGE_SIZE = 100;
export const APP_BUILD_MANAGED_DEFAULTS = { vcpu: 4, memoryGiB: 12, diskGiB: 30, timeoutMinutes: 60 } as const;
export const APP_BUILD_MANAGED_MAXIMUMS = { vcpu: 16, memoryGiB: 64, timeoutMinutes: 180 } as const;
export const APP_BUILD_MANAGED_CONCURRENCY = { perAppWork: 1, perAccount: 3 } as const;
export const APP_BUILD_STRATEGIES = ['dockerfile', 'image', 'auto', 'none'] as const; // R-13
export const APP_BUILD_CHECKS_JOB_ID = 'checks',
	APP_BUILD_CHECK_NAME_PREFIX = 'Ever Works check: ',
	APP_BUILD_CHECKS_MAX = 20,
	APP_BUILD_CHECKS_MAX_PARALLEL = 5; // R-9
export const APP_BUILD_VERIFY_PROMPTED_SECRET = 'EW_VERIFY__PROMPTED'; // reserved; §4.10
```

The folder is APW-03's `packages/contracts/src/apps/` (CONTRACTS §2); this file is added to its barrel.

### 3.3 Migrations (Constitution V, forward-only)

- **P1** `apps/api/src/migrations/1792050000000-CreateWorkBuilds.ts` — creates `work_builds`, its FK and the five
  indexes. `down()` drops only the table. Portable types via the entity helpers; partial index `WHERE` supported
  on both Postgres and SQLite.
- **P3** `apps/api/src/migrations/1792050100000-AddWorkBuildSupplyChain.ts` — adds `scanSummary simple-json NULL`
  (`{ critical, high, medium, low, fixableCritical }`), `signatureState varchar(16) NULL`
  (`signed|unsigned|foreign`), `blockedEgressHosts simple-json NULL` (≤ 10). Additive only.

Re-stamp both above the newest migration on `develop` before merge (README §7 rule 6).

### 3.4 Entity registration

`packages/agent/src/entities/work-build.entity.ts` **(new)**, registered in all four places the drift specs check:
`packages/agent/src/entities/index.ts` (export), `packages/agent/src/database/_entity-names.ts` (`'WorkBuild'`),
`packages/agent/src/database/_entities-inventory.ts` (import + `ENTITIES`), and the owning module's
`TypeOrmModule.forFeature`. Scope columns are declared so `apps/api/src/scope/scope-stamping.subscriber.ts` stamps them.

---

## 4. Capability contract and the build plugins

### 4.1 `IBuildPlugin` — `packages/plugin/src/contracts/capabilities/build.interface.ts` (new)

```ts
import type { IPlugin } from '../plugin.interface.js';

export type BuildStrategy = 'dockerfile' | 'image' | 'auto' | 'none'; // R-13: `auto` = provider-internal zero-config builder
export type BuildRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BuildRepositoryRef {
	readonly owner: string;
	readonly repo: string;
	readonly visibility: 'public' | 'private';
	readonly trackedBranch: string;
	readonly createdByAppWork: boolean;
}
export interface BuildAuth {
	readonly token: string;
} // resolved by the facade; never logged
export interface AppBuildBlock {
	// APW-03 schema §9, already validated
	readonly strategy: BuildStrategy;
	readonly dockerfile?: string;
	readonly context?: string;
	readonly target?: string;
	readonly args: ReadonlyArray<{ name: string; value?: string; fromEnv?: string }>;
	readonly services: ReadonlyArray<{
		name: string;
		image: string;
		port?: number;
		env?: ReadonlyArray<{ name: string; value: string }>;
	}>;
	readonly resources: { cpu: number; memoryGiB: number; timeoutMinutes: number };
}
export interface BuildValue {
	readonly name: string;
	readonly value: string;
	readonly secret: boolean;
	readonly fromBuildService: boolean;
	readonly fingerprint: string;
} // APW-07: 'v<version>' or sha256 of a non-secret value
export interface PrepareRepositoryInput {
	readonly workId: string;
	readonly repository: BuildRepositoryRef;
	readonly build: AppBuildBlock;
	readonly appSpecHash: string;
	readonly values: readonly BuildValue[];
	readonly previouslyWrittenSecretNames: readonly string[];
	readonly lastWrittenWorkflowSha256: string | null;
	readonly settings: Record<string, unknown>;
	/** spec.checks[] (APW-03 schema §17), already validated; empty → no checks job (R-9). */
	readonly checks: ReadonlyArray<{ name: string; command: string; required: boolean; timeoutSeconds: number }>;
}
export interface PrepareRepositoryResult {
	readonly workflow: {
		state: 'unchanged' | 'committed' | 'pullRequestOpened' | 'pullRequestUpdated' | 'editedByHand';
		readonly commitSha?: string;
		readonly pullRequestUrl?: string;
		readonly contentSha256: string;
	};
	readonly secretsWritten: readonly string[];
	readonly secretsRemoved: readonly string[];
	readonly buildInputsHash: string;
	readonly blocked?: { reason: string; detail: Record<string, string | number | string[]> };
}
export interface VerificationPlan {
	/** components, dependency kinds, jobs, smoke — APW-04 builds it; `env` is APW-07's value-free ephemeral recipe (§4.10). */
	readonly json: string;
	/** names of prompted values the owner already set that the recipe needs; values are fetched by the service, never carried here. */
	readonly promptedNames: readonly string[];
}
export interface StartBuildInput {
	readonly workId: string;
	readonly buildId: string;
	readonly repository: BuildRepositoryRef;
	readonly ref: string;
	readonly sha: string;
	readonly mode: 'build' | 'verify';
	readonly reuseImageDigest?: string;
	readonly verification?: VerificationPlan;
	readonly settings: Record<string, unknown>;
}
export interface BuildRef {
	readonly repository: BuildRepositoryRef;
	readonly buildId: string;
	readonly providerRunId: string | null;
	readonly dispatchedAt?: string;
}
export interface BuildSnapshot {
	readonly providerRunId: string | null;
	readonly runAttempt: number;
	readonly status: BuildRunStatus;
	readonly conclusion?: string;
	readonly trigger: 'push' | 'pull_request' | 'manual' | 'verification';
	readonly branch: string;
	readonly commitSha: string;
	readonly pullRequestNumber?: number;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly billableMinutes?: number;
	readonly checksBillableMinutes?: number; // jobs of the `checks` matrix (R-9); never affects `status`
	readonly runnerLabel?: string;
	readonly logsUrl?: string;
	readonly image?: { repository: string; digest: string; tags: string[]; confirmed: boolean };
	readonly secretCheck?: 'passed' | 'failed' | 'not_needed';
	readonly failure?: { class: string; detail?: Record<string, unknown>; excerpt: string[] };
	readonly verification?: {
		componentsReady: boolean;
		jobs: ReadonlyArray<{ name: string; exitCode: number | null; durationMs: number }>;
		smoke: ReadonlyArray<{ name: string; expected: string; observed: string; passed: boolean; durationMs: number }>;
	}; // CONTRACTS §3 (APW-04)
}

export interface IBuildPlugin extends IPlugin {
	readonly buildKind: 'github-actions' | 'apps-builder';
	readonly supportedStrategies: readonly BuildStrategy[];
	prepareRepository(
		input: PrepareRepositoryInput,
		auth: BuildAuth,
		writer: RepositoryWriter
	): Promise<PrepareRepositoryResult>;
	startBuild(
		input: StartBuildInput,
		auth: BuildAuth
	): Promise<{ providerRunId: string | null; dispatchedAt: string }>;
	getBuild(ref: BuildRef, auth: BuildAuth, redact: (text: string) => string): Promise<BuildSnapshot | null>;
	cancelBuild(ref: BuildRef, auth: BuildAuth): Promise<void>;
	getLogsUrl(ref: BuildRef, auth: BuildAuth): Promise<string | null>;
	checkImageAccess?(input: { imageRepository: string; tag: string; pullToken?: string }): Promise<ImageAccessResult>;
}
export interface ImageAccessResult {
	readonly visibility: 'public' | 'private' | 'unknown';
	readonly readable: boolean;
	readonly tokenScopesOk?: boolean;
	readonly tokenExpiresAt?: string | null;
	readonly digest?: string;
}
export function isBuildPlugin(plugin: IPlugin): plugin is IBuildPlugin {
	return plugin.capabilities.includes('build');
}
```

`getBuild` receives a `redact` callback (APW-07's redactor for this App Work) so no unredacted excerpt ever leaves the
plugin; `prepareRepository` receives a `RepositoryWriter` (`getFileContent`, `commitFiles`, `createBranch`,
`createPullRequest`) bound by the facade to `GitFacadeService`, so there is one clone-free commit implementation
(APW-03's `commitFiles?`). `checkImageAccess?` and the writer parameter are additive to the CONTRACTS row.

### 4.2 Registration

`PLUGIN_CAPABILITIES.BUILD = 'build'` (`facade-capabilities.ts`); `'build'` appended to `PLUGIN_CATEGORIES`
(`plugin-manifest.types.ts`); `export * from './build.interface.js'` (`capabilities/index.ts`); the category row in
`docs/plugin-system/plugin-categories.md` and both plugins in `docs/plugin-system/built-in-plugins.md` (Constitution VIII).

### 4.3 Package `packages/plugins/github-actions-build/` (new)

```
package.json                     everworks.plugin { id: github-actions-build, category: build, capabilities: [build],
                                 autoEnable: true, builtIn: true, visibility: user-only }; deps: octokit,
                                 libsodium-wrappers, fflate (artifact unzip); tsup + vitest like packages/plugins/k8s
src/index.ts
src/github-actions-build.plugin.ts   IBuildPlugin; settingsSchema; validateSettings (async pull-token check)
src/settings.schema.ts
src/workflow/generator.ts            canonical inputs → YAML text (string builder, no YAML library, byte-stable)
src/workflow/inputs-hash.ts
src/workflow/action-pins.ts          ACTION_PINS { checkout, setupBuildx, login, buildPush, uploadArtifact }
src/workflow/checks-job.ts           spec.checks[] → the `checks` matrix job lines (R-9, §4.14)
src/workflow/verify-runner.sh.ts     the embedded verification script as a template literal
src/repo/branch-protection.ts
src/repo/workflow-writer.ts          RepositoryWriter (facade-supplied commitFiles/createBranch/createPullRequest) + read-back
src/repo/secret-sync.ts
src/runs/run-correlator.ts
src/runs/run-observer.ts             runs, jobs, minutes, artifact, logs tail
src/runs/result-artifact.ts
src/runs/failure-classifier.ts
src/registry/ghcr-access.ts          anonymous + token manifest checks, scope + expiry headers
src/runner/runner-selector.ts
src/__tests__/*.spec.ts
```

### 4.4 Settings schema

| Key                     | Type    | Default | Notes                                                                                 |
| ----------------------- | ------- | ------- | ------------------------------------------------------------------------------------- |
| `largerRunnerLabel`     | string  | `""`    | `^[A-Za-z0-9._-]{1,64}$`. Used for private repositories when set.                     |
| `largerRunnerMemoryGiB` | integer | `0`     | 8–256; required when the label is set (the memory check needs it).                    |
| `largerRunnerVcpu`      | integer | `0`     | 2–64; informational (warning only).                                                   |
| `reclaimDisk`           | boolean | `true`  | FR-25.                                                                                |
| `attestations`          | boolean | `false` | Public repositories only; `validateSettings` refuses `true` on a private repository.  |
| `pullToken`             | string  | —       | **`x-secret: true`**. Validated by `validateSettings` via `checkImageAccess` (§4.12). |
| `pullTokenExpiresAt`    | string  | —       | Written by the platform after validation; read-only in the UI.                        |

Work scope only for `pullToken`, `largerRunner*`, `attestations`; user and admin scope may set defaults for
`reclaimDisk` and `largerRunner*`.

### 4.5 Generation

- **Canonical inputs**: `{ generator: 1, trackedBranch, build (normalised: defaults applied, keys sorted), values:
names + secret + fromBuildService (never values), runner: { label, class }, settings: { reclaimDisk, attestations },
pins: ACTION_PINS, verifyEnabled, checks: [{ name, required, timeoutMinutes, commandSha256 }] }`.
  `inputsHash = sha256(canonical JSON)`. A check command change therefore changes the file and its fingerprint.
- **Emission** is a line-array builder with a `yamlString()` helper that always double-quotes and escapes, so the
  same inputs yield identical bytes on every platform (LF line endings, trailing newline).
- **Branch slug**: lower-case, `[^a-z0-9._-]` → `-`, collapse repeats, trim to 100 characters.
- **Service health options** are emitted only for recognised images (`postgres*` → `pg_isready`, `redis*` →
  `redis-cli ping`, `minio*` → HTTP `/minio/health/live`); unknown images get a 60-second `sleep`-free wait loop step on
  the declared port instead.
- **Pins**: `ACTION_PINS` values are 40-character commit hashes with the release tag in a trailing comment; a unit test
  fails when any pin is not 40 hex characters. Bumping pins bumps `inputsHash`, so every App Work gets a pull request or
  commit with the new file on its next preparation.

### 4.6 Delivery

1. `GET /repos/{o}/{r}/branches/{branch}/protection`: 404 → unprotected; 200 → protected when
   `required_pull_request_reviews` or `required_status_checks` is present; 403 → treated as protected.
2. Direct path (FR-7): the facade-supplied `RepositoryWriter.commitFiles` — APW-03's `IGitProviderPlugin.commitFiles?`
   through `GitFacadeService` (non-force, one file, message `Add Ever Works build workflow` or `Update Ever Works build
workflow`). A `nonFastForward` error retries from step 1 up to 3 times. The plugin never clones.
3. Pull request path: `RepositoryWriter.createBranch` (`ever-works/build-workflow` from the tracked head when absent),
   `commitFiles` onto it, then `createPullRequest` titled `Add Ever Works build workflow`, or reuse the open one.
4. Read back `GET contents/{path}?ref=<new commit>` and compare sha256 with the generated bytes (FR-8). Only a
   successful read-back stores `lastWrittenWorkflowSha256`.
5. Hand-edit detection (FR-9): before writing, read the current file on the tracked branch; if it exists and its
   sha256 ≠ `lastWrittenWorkflowSha256` and ≠ the new content, take the pull request path and return
   `editedByHand`.
6. Actions state: `GET actions/permissions`; `enabled: false` → blocked `actionsDisabled`. Enabling uses APW-02's
   `setActionsPermissions?` with only this workflow allowed; this epic never re-enables other workflows.
7. Relation (Resolution R-4): `repository.createdByAppWork === false` (Link) always takes the pull request path, whatever
   the branch protection says.
8. Strategy `image` or `none` with a non-empty `checks` list: the same delivery writes a **checks-only** workflow (§4.14);
   with no checks, nothing is written and an existing checks-only file the platform wrote is replaced by a pull request
   removing the jobs — never deleted directly (FR-70).

`lastWrittenWorkflowSha256` and the pull request number are stored in the Work-scoped plugin settings of the resolved
build plugin (non-secret keys `workflowSha256`, `workflowPullRequestNumber`), not in a new table.

### 4.7 Secret sync

`values` arrive from APW-07's resolver for phase `build`, with build-service references already resolved against
`build.services` (e.g. `postgresql://ever-works-build:ever-works-build@127.0.0.1:5432/app`, flagged
`fromBuildService`). The plugin: refuses more than 50 values (`tooManyBuildValues`) or any value over 48,000 bytes
(`buildValueTooLarge`, name only); fetches the public key once; seals and `PUT`s each `EW_<NAME>`; deletes names in
`previouslyWrittenSecretNames` that are no longer referenced; maps a 422 "secret limit" to `secretLimitReached`.
`buildInputsHash = sha256(sorted (name, fingerprint))`, where `fingerprint` is APW-07's stored-value `version` for stored
values and `sha256(value)` only for non-secret or build-service values — no hash of a stored secret is ever persisted.
`BuildValue` carries `fingerprint` for this. Missing required values never reach the plugin — the service
blocks first (FR-19).

### 4.8 Observation

- **Correlation** (§2.3) for `manual`/`verification`; push and pull request runs are keyed by run id from the event or
  `listWorkflowRuns(workflow_id = file name, head_sha)`.
- **Snapshot**: `GET actions/runs/{id}` → status, conclusion, `run_attempt`, `html_url`, `event`, head sha/branch,
  pull requests; `GET actions/runs/{id}/jobs` → per-job `started_at`/`completed_at` for minutes
  (`ceil((completed − started) / 60 s)` per job, summed), runner labels, failing step name + number. **Only the job
  named `build` decides `status`, `conclusion` and the failure class**; jobs whose name starts with
  `APP_BUILD_CHECK_NAME_PREFIX` are summed into `checksBillableMinutes` (also counted in `billableMinutes`) and are
  otherwise ignored — their results reach APW-08 as provider check runs (R-9). A run with only check jobs (checks-only
  workflow) is never recorded as a Build (§7.5).
- **Result artifact**: `GET actions/runs/{id}/artifacts?name=ever-works-build-result` → download zip (≤ 64 KB,
  refuse larger) → `fflate.unzipSync` → JSON ≤ 8 KB validated by a strict schema; digest must match
  `^sha256:[a-f0-9]{64}$`. The artifact is untrusted input: it is only ever _confirmed_, never believed.
- **Digest confirmation**: `checkImageAccess({ imageRepository, tag: 'sha-<sha>', pullToken })` returns the registry
  digest; equal → `confirmed`; unequal → `digestMismatch`; registry unreadable (private, no token yet) → confirmed only
  if the artifact digest equals the digest reported by `docker push` in the job log line `digest: sha256:…` of the
  Push step, otherwise the Build stays `digestUnconfirmed` until a pull token exists (rechecked on token save).
- **Logs tail** for failed runs: `GET actions/jobs/{job_id}/logs` (follows the redirect), reading at most the last
  2 MiB with a `Range` request, split into lines, passed through `redact`, then the classifier.

### 4.9 Failure classifier

Evaluated in order on the failing job; the first match wins. Patterns are case-insensitive.

| Order | Class                      | Signal                                                                                                           | `failureDetail`                                  |
| ----- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1     | `missingBuildValue`        | step "Check build values" failed and a line `EW_MISSING:<NAME>`                                                  | `names`                                          |
| 2     | `secretInImage`            | a line `EW_SECRET_IN_IMAGE:<NAME>`                                                                               | `names`                                          |
| 3     | `timeout`                  | job conclusion `timed_out`, or "exceeded the maximum execution time"                                             | `minutes`                                        |
| 4     | `workflowInvalid`          | run conclusion `startup_failure`, or zero jobs                                                                   | —                                                |
| 5     | `outOfMemory`              | `exit code: 137` · `Killed` on its own line · `JavaScript heap out of memory` · `Reached heap limit` · `ENOMEM`  | `memory`, `max`                                  |
| 6     | `diskFull`                 | `No space left on device` · `ENOSPC`                                                                             | —                                                |
| 7     | `registryPushDenied`       | Push step failed with `denied` · `403 Forbidden` · `permission_denied`                                           | —                                                |
| 8     | `dependencyDownloadFailed` | `ETIMEDOUT` · `ECONNRESET` · `EAI_AGAIN` · `TLS handshake timeout` · `429 Too Many Requests` · `toomanyrequests` | —                                                |
| 9     | `dockerfileError`          | `ERROR: failed to solve` with a `#<n> [<stage> <k>/<m>] <COMMAND>` line, or `dockerfile parse error`             | `step`, `total`, `command` (≤ 120), `dockerfile` |
| 10    | `verificationFailed`       | step "Verify in the runner" failed and the result artifact has failing smoke rows                                | `failed`, `total`                                |
| 11    | `unknown`                  | anything else                                                                                                    | —                                                |

The excerpt is the 20 lines ending at the matched line (or the last 20 lines for `unknown`), each cut to 300
characters, after `redact` and after the platform secret-pattern screen used for Skill bodies (`assertNoSecrets`
shape, applied as masking). A classifier table test pins one fixture log per class.

### 4.10 Verification in the runner

**Contract (Resolution R-10, CONTRACTS §3).** `IBuildPlugin.startBuild({ …, mode: 'verify', verification,
reuseImageDigest? })` builds the image (or reuses the confirmed digest of an earlier succeeded Build of the same commit),
then — in the same run — starts the `pre-deploy` / `first-deploy` jobs, the components and throwaway dependency containers
on the runner's private network (≤ 30 min, ≤ 12 GiB summed memory), runs the App spec smoke tests, and reports
`{ jobs[], componentsReady, smoke[] }` through `getBuild` (`BuildSnapshot.verification`).

**Env without stored values.** `AppBuildsService.startVerification(workId, { ref, sha, plan })` asks APW-07's
`AppRuntimeEnvSource` **ephemeral mode** for a **value-free recipe** (`resolveEphemeral(workId, sha, { target:
'runner', internalUrls, primaryUrl })`, APW-07 plan §4.6.1): each entry is `generate` (kind + parameters),
`literal` (a `value` from the App spec — never secret), `template` over runner-local names (dependency container host
names, `http://<component>:<port>` internal URLs, `{{gen:NAME}}` / `{{prompted:NAME}}` tokens) or `prompted` (name only).
The recipe goes into the plan JSON; no value is ever in a dispatch input, which the provider shows in the run's UI.
Prompted names the owner has already set are written, just before dispatch, as **one** sealed Actions secret
`APP_BUILD_VERIFY_PROMPTED_SECRET` (JSON `{ NAME: value }`, ≤ 48 KB) whose name is recorded in `verifySecretNames`;
`app-build-watch` deletes it on the Build's terminal transition and `app-build-sweep` deletes any left after
`startedAt + 30 min + 10 min` (FR-53). A required prompted name that is unset blocks the verification Build with
`missingBuildValues` before anything is dispatched. An App spec env name that would map to the reserved secret name is
refused by secret sync (`buildValueNameReserved`).

**The embedded script** (bash + `jq` + `openssl`, all on GitHub-hosted Ubuntu images) reads the base64url plan JSON
(≤ 60,000 characters, schema-checked), refuses when summed `--memory` of components and dependency containers exceeds
12 GiB, creates a Docker network, starts throwaway dependency containers (`postgres`, `redis`, `minio`; images pinned by
digest in the script; no volumes), materialises the recipe — `openssl rand` for `base64`/`hex`/`chars`/`uuid`,
`openssl genpkey` for `keypair` in the declared format, prompted values from the secret — into a `0600` env file under
`$RUNNER_TEMP`, starts components with `--read-only` unless `writableRootFilesystem`, runs `pre-deploy`/`first-deploy`
jobs to completion (exit code checked), waits for each component's readiness probe, runs each smoke request with
`curl --max-time 30 --max-redirs 0`, writes per-job and per-smoke rows into the result artifact, and shreds the env file.
Values are never echoed; `set +x` throughout. The plan schema is owned here; its content is produced by APW-04.
A Verification Build never writes the cache and is never deployable (FR-54, §5.1 clause `verification`).

### 4.11 Secret-in-image check

```bash
set -euo pipefail
docker image inspect "$EW_IMAGE:sha-$EW_SHA" > "$RUNNER_TEMP/ew-image.json"
docker history --no-trunc --format '{{.CreatedBy}}' "$EW_IMAGE:sha-$EW_SHA" >> "$RUNNER_TEMP/ew-image.json"
for name in $EW_SECRET_NAMES; do
  value="${!name:-}"
  [ "${#value}" -ge 8 ] || continue
  if grep -qF -- "$value" "$RUNNER_TEMP/ew-image.json"; then echo "EW_SECRET_IN_IMAGE:${name#EW_}"; exit 79; fi
done
echo "secret-check: passed"
```

`grep` reads a file, never a pipe, so a `pipefail` SIGPIPE cannot turn a match into a miss. Build-service-derived
values are excluded from `EW_SECRET_NAMES`: they are throwaway by construction. The check covers image config and
history; file contents inside layers are out of scope (spec §7 lists it implicitly under "metadata").

### 4.12 Registry access and the pull token

- **Visibility**: anonymous `GET https://ghcr.io/token?service=ghcr.io&scope=repository:<name>:pull` → bearer →
  `HEAD /v2/<name>/manifests/sha-<sha>` with OCI index + manifest `Accept` headers: 200 → `public`; 401/403/404 →
  `private` (or not yet pushed, distinguished by whether the Build confirmed a push).
- **Token check** (`validateSettings` for `pullToken`): `GET https://api.github.com/user` with the token → the
  `x-oauth-scopes` header must be exactly `read:packages` (absent header = fine-grained token → refused with the
  classic-token copy, because fine-grained tokens were measured to 403 on GHCR pulls — see the comment in
  `resolveGhcrReadToken`); `github-authentication-token-expiration` → `pullTokenExpiresAt`; then the same manifest
  `HEAD` with basic auth → 200 required.
- **Consumers**: this epic implements APW-06's port `AppImagePullCredentialSource.resolve(workId, buildId)`
  (`packages/agent/src/app-runtime/ports.ts`, CONTRACTS §3) as `AppBuildPullCredentialSource`, bound to
  `APP_IMAGE_PULL_CREDENTIAL_SOURCE`: `{ server: 'ghcr.io', username: 'x-access-token', password }` or `null` for a
  public image. It never falls back to any other token (FR-50).

### 4.13 Wave 3 — `apps-builder` plugin (new package, P3)

`packages/plugins/apps-builder/`, `buildKind: 'apps-builder'`, `supportedStrategies: ['dockerfile']`, resolvable only
when `AppsTierPolicy.isOpen()` (the tier is open — Resolution R-5; this epic never reads
`EVER_WORKS_APPS_MANAGED_ENABLED`) and `managedScope() === 'any'` (APW-10) and the deploy target is **Ever Works
Apps**. Sandboxed in-zone builds are Wave 3 (Resolution R-24, gate item LG-24); the sandboxed runtime for tenant
workloads that Wave 2 already requires (LG-04) is APW-06's and APW-10's. The plugin submits `AppBuild` resources (`hosting.ever.works/v1alpha1`, APW-10 plan §3.2) through
`IAppsTierProvider.submitBuild?` and reads them back with `getBuild?`; build values travel sealed to the zone's key, the
source token as `sealedSourceToken`. The platform holds no builder endpoint or credential. Contract the zone must
satisfy, verified by APW-10's launch gate (probe LG-24): rootless BuildKit in a sandboxed runtime class, user
namespaces, no privileged pods; one ephemeral workload per Build deleted ≤ 10 minutes after completion; default-deny
egress with an allowlist (source host, allowlisted registries); caps from `APP_BUILD_MANAGED_*`; source token
read-only, one repository, ≤ 1 hour; push token one repository in a per-tenant namespace, ≤ timeout + 60 minutes;
vulnerability scan + signature with the builder identity; admission on the hosting tier verifies signature and
identity. The snapshot adds `scanSummary`, `signatureState`, `blockedEgressHosts`; receipts use meter classification
from `PluginUsageService` with payer `platform`.

### 4.14 App checks — the `checks` job (Resolution R-9)

- **Source.** `spec.checks[]` from the effective App spec at the tracked head (APW-03 schema §17: ≤ 20, `name` a Name,
  `command` 1–500 characters, `required` default `true`, `timeoutSeconds` 60–7200). `checks-job.ts` maps each entry to
  one matrix row `{ name, required, timeoutMinutes: ceil(timeoutSeconds / 60), commandB64 }` in declared order.
- **Emission.** The job of §2.4: pull-request trigger only, same-repository guard, `permissions: { contents: read }`, no
  `services`, no `env` other than `EW_CHECK_COMMAND_B64`, no reference to `secrets.` or any `EW_` secret, no cache
  flags, `fail-fast: false`, `max-parallel: APP_BUILD_CHECKS_MAX_PARALLEL`, `continue-on-error` from `required`. The
  runner label is the build job's (§4.4); a check does not inherit the build's memory check. `name` is an APW-03 Name
  (lower-case letters, digits, hyphens), so the job name renders to exactly `Ever Works check: {name}`.
- **Checks-only workflow.** With strategy `image` / `none` and ≥ 1 check, the file carries the header, `on:
pull_request` only (no `push`, no `workflow_dispatch`), `permissions: {}`, the same concurrency block and the `checks`
  job — nothing else.
- **Observation.** The `workflow_run` consumer (§7.5) records no Build while the App Work's applied strategy is `image` or
  `none` (read from `WorkAppSpecState`, no provider call), so a checks-only run is never a Build; the observer sums check-job
  minutes into `checksBillableMinutes` on a pull request Build (FR-69). Check results are never copied into `work_builds`
  — APW-08 reads them from the provider's check runs.
- **APW-08 contract.** Replaces the "one step per check in a single job" assumption of CONTRACTS §3's APW-08 row: one
  job (and check run) per check; job-level `continue-on-error` gives the advisory semantics.

---

## 5. API

All routes: `AuthSessionGuard`, `ParseUUIDPipe`, ownership through `WorkOwnershipService` (`ensureCanView` /
`ensureCanEdit`), a Build id belonging to another Work or account → 404. Controller file
`apps/api/src/app-builds/app-builds.controller.ts` **(new)**, route prefix `api/works/:id/builds`, kind guard: non-`app`
Works → 404.

| Method | Route                                   | Body / query                                                                    | Response                                                                                                                                                                                                                                         | Throttle         |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| GET    | `/api/works/:id/builds`                 | `page` ≥ 1, `pageSize` 1–100 (20), `status`, `trigger`, `branch`, `pullRequest` | `{ items: AppBuildSummary[], total, page, pageSize, provider: { pluginId, name, buildKind }, repository: { fullName, visibility }, imageRepository, workflow: { state, pullRequestUrl }, pullAccess: { visibility, tokenSet, tokenExpiresAt } }` | 60/min           |
| GET    | `/api/works/:id/builds/:buildId`        | —                                                                               | `AppBuildDetail`                                                                                                                                                                                                                                 | 60/min           |
| POST   | `/api/works/:id/builds`                 | `{ commitSha?: string (40 hex, reachable), mode?: 'build' }`                    | `202 { build: AppBuildSummary, deduped: boolean }`                                                                                                                                                                                               | 10/hour per Work |
| POST   | `/api/works/:id/builds/:buildId/cancel` | —                                                                               | `202 { build }`; `409 notCancellable` when terminal or blocked                                                                                                                                                                                   | 30/min           |

Error codes (stable, translated by the web): `notAppWork` (404 body code), `buildNotFound`, `rebuildRateLimited`
(429, `retryAfterMinutes`), `commitNotReachable` (422), `nothingToBuild` (422, strategy `image`/`none`),
`notCancellable` (409), `buildProviderUnavailable` (503). Response serialisers never include `buildSecretNames` values
(only names), tokens, or raw artifacts.

Verification Builds are created internally by APW-04 through `AppBuildsService.startVerification(workId, { ref, sha,
plan })`, not through HTTP. Build settings and the pull token use the existing
`PATCH /api/works/:workId/plugins/:pluginId/settings`, with `pluginId` taken from the list response's `provider` —
the web never embeds a plugin id (Constitution II).

**Agent package services** (`packages/agent/src/app-builds/` **(new)**): `BuildFacadeService`
(`packages/agent/src/facades/build.facade.ts` **(new)**, extends `BaseFacadeService`, `CAPABILITY =
PLUGIN_CAPABILITIES.BUILD`, resolves plugin + git token + settings, builds the `redact` callback via APW-07's
`AppEnvService.buildRedactor(workId)`), `AppBuildsService` (preparation, rebuild dedupe, cancel, finalisation,
deployable verdict, events), `AppBuildRepository`, `AppBuildFailureCopy` (class → i18n key + params, shared with the
agent hand-off).

**Failure hand-off to agents (FR-39, ACC-05-19).** The English title and suggestion templates per class live once in
`packages/contracts/src/apps/build-failure-copy.ts` **(new)** (`APP_BUILD_FAILURE_COPY_EN`, ICU-style `{param}`
placeholders identical to the `dashboard.workDetail.builds.failure.<class>` leaves in `apps/web/messages/en.json`).
`AppBuildFailureCopy.forAgent(build)` renders them with `failureDetail` into `{ class, title, suggestion, excerpt,
logsUrl, untrusted: true }`, the payload APW-08's delivery follow-up hands to the Task's agent; the web renders the same
leaves through next-intl. A web parity test (`apps/web/src/lib/api/app-build-failure-copy.parity.unit.spec.ts`) fails
when a leaf and its template drift.

### 5.1 Deployable verdict (FR-31)

```
deployable = status == succeeded
          && trigger in (push, manual) && branch == trackedBranch
          && specValidAtCommit == true                         // WorkAppSpecState (APW-03)
          && secretsSyncedAt <= startedAt && buildInputsHash == currentInputsHash   // else staleInputs
          && secretCheck in (passed, not_needed)
          && digestConfirmed
          && (buildKind != apps-builder || (signatureState == signed && !(policy.blockFixableCritical && scan.fixableCritical > 0)))
```

The first failing clause, in that order, becomes `notDeployableReason`.

---

## 6. Web

### 6.1 Where it hangs

- Route `apps/web/src/app/[locale]/(dashboard)/works/[id]/builds/page.tsx` **(new)** beside the existing `deploy/`,
  `activity/` folders.
- Tab in `apps/web/src/components/works/detail/WorkTabs.tsx`: `visible: getWorkCapabilities(work.kind).builds`, placed
  after **Pull requests**. `WorkCapabilities.builds` is added by APW-01 (Resolution R-7: `true` for `app`, `false` for
  every other kind, in the PR that adds the kind); if this epic lands first it adds the field with `false` everywhere and
  APW-01 flips `app`.
- Overview card in `apps/web/src/components/works/detail/overview/LatestBuildCard.tsx` **(new)**, rendered when
  `builds` is true.
- Route constant `DASHBOARD_WORK_BUILDS` in `apps/web/src/lib/constants.ts`.

### 6.2 Components (all new, `apps/web/src/components/works/detail/builds/`)

| Component                 | Responsibility                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `BuildsPageClient.tsx`    | Header, filters (URL-backed), list, pagination, empty/loading/error states, polling.                     |
| `BuildRow.tsx`            | Status chip, number, trigger, branch, commit, duration, digest or failure title, row actions.            |
| `BuildStatusChip.tsx`     | Icon + text per status; `aria-live="polite"` region for transitions.                                     |
| `BuildDetailDrawer.tsx`   | §6.2 of the spec; copy-to-clipboard; receipt; verification results table.                                |
| `BuildFailurePanel.tsx`   | Title + suggestion from `failureClass` + `failureDetail`; excerpt in a `<pre>`; "Ask an agent" (APW-08). |
| `BuildBlockedNotice.tsx`  | One notice per blocked reason with its action.                                                           |
| `PullTokenDialog.tsx`     | Masked input, submit through the plugin settings action, error codes → copy.                             |
| `BuildSettingsDialog.tsx` | Larger runner label/memory, reclaim disk, attestations (public only).                                    |

Server actions `apps/web/src/app/actions/dashboard/app-builds.ts` **(new)**: `listBuildsAction`, `getBuildAction`,
`rebuildAction`, `cancelBuildAction`, `savePullTokenAction`, `saveBuildSettingsAction`. Typed client
`apps/web/src/lib/api/app-builds.ts` **(new)** mirroring the contracts types.

### 6.3 State and fetching

First paint from the server component. While any listed Build is `queued` or `running`, the client polls
`listBuildsAction` every 10 seconds, pauses while the document is hidden, and stops after 60 minutes of continuous
polling (a **Refresh** button remains). Filters, page and open drawer (`?build=<number>`) live in the URL.

---

## 7. Background work

### 7.1 Dispatchers (agent package)

`packages/agent/src/tasks/app-build-prepare-dispatcher.ts` + `app-build-prepare.types.ts` (`{ workId, buildId?,
reason: 'specApplied' | 'envChanged' | 'rebuild' | 'verification' | 'pullTokenSaved' }`) and
`app-build-watch-dispatcher.ts` + `app-build-watch.types.ts` (`{ buildId, reason: 'event' | 'dispatched' | 'sweep' }`),
each with a `Symbol()` token, exported from `packages/agent/src/tasks/index.ts` and listed in `_tasks-symbols.ts`.

### 7.2 `app-build-prepare` (one-shot)

1. Load the App Work, its effective App spec (APW-03) and `WorkAppSpecState`.
2. `strategy` `image`/`none` → no Build; `prepareRepository` still runs when `spec.checks` is non-empty (checks-only
   workflow, §4.14) and skips secret sync; `auto` → mark any requested Build `blocked strategyNotSupported` (and still
   write the checks when declared).
3. Resolve build values through APW-07 (`AppEnvResolver.resolveForBuild(workId, build.services)`); required missing →
   `blocked missingBuildValues` for a requested Build (push-started runs fail in the workflow's first step).
4. Runner selection (`runner-selector.ts`): memory above runner − 2 GiB → `blocked runnerTooSmall`.
5. `prepareRepository`; persist `buildSecretNames`, `secretsSyncedAt`, `buildInputsHash`, workflow state.
6. For a requested manual/verification Build: `startBuild`, persist `dispatchedAt`, dispatch `app-build-watch`.

Overlap guard: `DistributedTaskLockService` key `app-build-prepare:<workId>`, held ≤ 5 minutes; a dispatch that finds
it held exits and is re-dispatched once by the holder when it finishes (a `pendingRerun` flag on the lock value).

### 7.3 `app-build-watch` (one-shot)

Claim: `UPDATE work_builds SET "watchLeaseUntil" = now() + interval '2 minutes' WHERE id = :id AND ("watchLeaseUntil"
IS NULL OR "watchLeaseUntil" < now())` — 0 rows → exit. Then `getBuild`, map snapshot → row, set `lastObservedAt`. On a
terminal transition: confirm digest, compute deployable verdict, record the receipt (`PluginUsageService.record({
workId, userId: work owner, pluginId, capability: PluginUsageCapability.BUILD, units: billableMinutes, operation:
'build.run', outcome: succeeded ? OK : FAILED, payer: WORKSPACE, metadata: { buildId, runnerClass, visibility,
checksBillableMinutes } })`), write Activity (`actionType: 'app_build'`, `action: 'app.build.<status>'` — Resolution
R-2), emit `app.build.<status>`, and for a verification Build delete the per-run prompted-value secret named in
`verifySecretNames` (§4.10). Release the lease.

### 7.4 `app-build-sweep` (scheduled, `*/2 * * * *`) — **(added to CONTRACTS §5)**

Selects up to 200 Builds with `status IN (queued, running)` and `lastObservedAt < now() − 90 s` (or NULL and
`dispatchedAt < now() − 90 s`), oldest first, and dispatches `app-build-watch` for each. Builds past `startedAt +
timeoutMinutes + 30` (or `queuedAt + 5 min + timeoutMinutes + 30` when never adopted) are failed as `lost`. Also
re-checks `digestUnconfirmed` Builds whose App Work gained a pull token, and deletes a verification Build's per-run
prompted-value secret still present `30 + 10` minutes after `startedAt` (§4.10). Task file
`packages/tasks/src/tasks/trigger/app-build-sweep.task.ts`, same shape as `deploy-ready-poller.task.ts`.

### 7.5 Webhook consumer

`apps/api/src/app-builds/app-build-workflow-run.consumer.ts` **(new)**: `events = ['workflow_run']`, registered in
`onModuleInit` on `GitHubWebhookDispatcherService`. `handle`: accept only `workflow.path ===
APP_BUILD_WORKFLOW_PATH`; resolve the App Work by `repository.full_name` (case-insensitive) among `kind = 'app'` Works
owned by the delivery's bound user; ignore unknown; ignore every run while the App Work's applied `build.strategy` is
`image`, `none` or `auto` (checks-only runs, §4.14 — read from `WorkAppSpecState`); upsert by run id (create Build #n for push/pull request runs,
adopt correlated manual runs by `display_title`); dispatch `app-build-watch` on create and on every status change.
Completes in < 200 ms of database work; never calls GitHub.

### 7.6 Event listeners

`AppBuildsListener`: `app.spec.applied` (`AppSpecAppliedEvent`) → prepare when `changedBlocks` includes `build` or
`checks` (R-9), or
`changedEnvNames` names a build-phase entry; `app.env.changed` naming a `build`/`both` entry → prepare within 60 s
(debounced 10 s per Work); `app.build.*` is emitted here for APW-04 (`APP_PROVISION_EVENTS_PORT.buildUpdated`), 06, 08.

---

## 8. i18n

Keys in `apps/web/messages/en.json`, mirrored into the 20 sibling locale files in the same PR:

```
dashboard.workDetail.tabs.builds                        "Builds"
dashboard.workDetail.tabs.tooltips.builds               "Container images built from your repository"
dashboard.workDetail.builds.{title,subtitle,rebuild,buildSettings,refresh,viewerDisabled} · .filters.{status,trigger,branch,all}
dashboard.workDetail.builds.status.{queued,running,succeeded,failed,cancelled,blocked} · .trigger.{push,pullRequest,manual,verification}
dashboard.workDetail.builds.notDeployable.{pullRequest,verification,specInvalid,staleInputs,secretCheckFailed,digestUnconfirmed,criticalVulnerability,unsigned}
dashboard.workDetail.builds.blocked.{workflowPending,workflowEditedByHand,workflowWriteFailed,actionsDisabled,missingBuildValues,runnerTooSmall,tooManyBuildValues,buildValueTooLarge,secretLimitReached,strategyNotSupported,specInvalid,gitConnectionMissing,repositoryUnavailable,managedConcurrencyLimit,buildValueNameReserved}
dashboard.workDetail.builds.blockedAction.{reviewPullRequest,turnOnActions,setValue,useLargerRunner,openRepositorySettings,reconnectGithub}
dashboard.workDetail.builds.failure.<class>.{title,suggestion} (14 classes) · .failure.askAgent · .cancelReason.{user,superseded}
dashboard.workDetail.builds.detail.{trigger,commit,runner,duration,queued,image,tags,deployable,buildValues,receipt,verification,copy,viewLogs,rebuildThisCommit}
dashboard.workDetail.builds.receipt.{minutes,checksMinutes,payerGithub,freePublic,costUnknown} · .empty.{noBuilds,imageStrategy,noneStrategy,strategyUnavailable}
dashboard.workDetail.builds.errors.{loadFailed,rebuildRateLimited,commitNotReachable,notCancellable,providerUnavailable}
dashboard.workDetail.builds.pullToken.{title,body,stepCreate,stepPaste,label,submit,cancel,tooBroad,cannotRead,savedExpires,savedNoExpiry,expiringSoon}
dashboard.workDetail.builds.settings.{title,largerRunnerLabel,largerRunnerMemory,reclaimDisk,attestations,attestationsPublicOnly}
dashboard.workDetail.builds.overview.{title,deployableSame,deployableOther,open}
```

Leaves are camelCase, never containing `.`; counts use ICU plurals (`{count, plural, =1 {# build value} other {# build values}}`).

---

## 9. Telemetry and failure modes

### 9.1 Events (counters and identifiers only)

`app_build_recorded` (`trigger`), `app_build_terminal` (`status`, `failureClass`, `durationBucket`: <5, 5–15, 15–30,
30–60, >60 min, `runnerClass`), `app_build_blocked` (`reason`), `app_build_rebuild_requested` (`deduped`),
`app_build_workflow_written` (`path: commit|pullRequest|editedByHand`), `app_build_pull_token_validated`
(`result: ok|tooBroad|cannotRead`), `app_build_sweep_tick` (`observed`, `lost`, `verifySecretsRemoved`),
`app_build_checks_written` (`count`, `advisory`, `checksOnly`). No names of env entries or checks, no repository
names, no commit messages, no check commands.

### 9.2 Failure modes and the chosen behaviour

| Failure                                              | Behaviour                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub API 5xx / rate limit during prepare           | Job retries with the runtime's backoff 3 times over 10 minutes; a requested Build stays `queued`.                                                            |
| Git connection revoked                               | `blocked gitConnectionMissing`; Activity names the App Work, not the token.                                                                                  |
| Repository archived, deleted or access lost          | `blocked repositoryUnavailable`; the sweep stops polling its Builds after marking them `lost`.                                                               |
| Webhook delivered twice                              | Unique `(plugin, runId, attempt)` makes the second upsert a no-op.                                                                                           |
| Run re-attempted on GitHub                           | New `runAttempt` → a new Build number (FR-33 numbers first-recorded attempts).                                                                               |
| Artifact missing (job cancelled before upload)       | No digest; status from the run; `deployable = false` with `digestUnconfirmed`.                                                                               |
| Log download 404 (logs expired)                      | Class from job conclusion and step name only; excerpt empty. Pin bumps change `inputsHash`, so every App Work gets the new workflow on its next preparation. |
| `PLUGIN_SECRET_ENCRYPTION_KEY` missing in production | Boot fails already (`assertKeyAvailableInProd`); pull token cannot be stored in dev without it — refused.                                                    |

---

## 10. Test plan

### 10.1 Plugin — Vitest (`packages/plugins/github-actions-build/src/__tests__/`)

`generator.spec.ts` (byte stability, golden files for 6 App spec fixtures incl. services and verification, no value
leaks: every fixture value is grepped absent), `action-pins.spec.ts` (40-hex), `workflow-writer.spec.ts` (direct vs
pull request, protection 404/200/403, read-back mismatch retry, hand-edit detection), `secret-sync.spec.ts` (50/48 KB
limits, removal only of previously written names, name validation), `run-correlator.spec.ts`, `run-observer.spec.ts`
(minutes rounding, pull request head sha), `result-artifact.spec.ts` (size cap, schema, digest pattern),
`failure-classifier.spec.ts` (one fixture log per class, order precedence), `ghcr-access.spec.ts` (scopes header
exact match, fine-grained refusal, expiry header), `runner-selector.spec.ts` (16/7 GiB headroom, larger label),
`secret-check.script.spec.ts` (runs the §4.11 script in a shell against a synthetic `docker` stub: match, no match, value
shorter than 8, pipefail safety), `checks-job.spec.ts` (R-9: one matrix row per check in order, job name
`Ever Works check: ${{ matrix.check.name }}`, `permissions` exactly `contents: read`, no `secrets.`/`EW_` token in the
job, `continue-on-error` mirrors `required`, `max-parallel: 5`, `timeoutMinutes` rounding, a command containing
`${{ secrets.X }}`, backticks and quotes appears only base64-encoded), `verify-runner.script.spec.ts` (R-10: recipe
materialisation, 12 GiB refusal, per-job and per-smoke rows, env file shredded).

### 10.2 Agent package (Jest), API (Jest) and E2E (Playwright)

**Agent**: `build.facade.spec.ts` (resolution, no hard-coded id, `redact` built from env values), `app-builds.service.spec.ts`
(number assignment race, rebuild dedupe 10 s, rate limit, `startVerification` recipe + prompted secret lifecycle),
`deployable-verdict.spec.ts` (truth table — one case per clause), `app-build-failure-copy.spec.ts` (agent hand-off equals
the user copy — ACC-05-19), `app-build-watch.runner.spec.ts` (lease claim, terminal finalisation once, receipt fields,
verify secret removed), `app-build-sweep.service.spec.ts` (batch 200, lost thresholds, orphaned verify secrets),
`app-builds.listener.spec.ts` (debounce 10 s, phase filter, checks change → prepare), `work-build.entity.spec.ts`.
**Web (Vitest)**: `apps/web/src/lib/api/app-build-failure-copy.parity.unit.spec.ts` — `en.json` failure
titles/suggestions equal the contracts' English templates.
**API**: `app-builds.controller.spec.ts` (404 for non-app kind and foreign ids, 202 shapes, 429 with `retryAfterMinutes`, 409
cancel, viewer vs editor), `app-build-workflow-run.consumer.spec.ts` (path filter, unknown repo ignored, upsert
idempotency, correlation adoption), migration spec `apps/api/src/migrations/__tests__/CreateWorkBuilds.spec.ts`
(up/down, indexes, no pre-existing table touched).
**E2E** (`apps/web/e2e/`): `app-builds-tab.spec.ts` (list, filters in URL, drawer, copy digest, viewer disabled), `app-builds-failure.spec.ts`
(each failure class renders its copy from seeded rows; blocked notices), `app-builds-pull-token.spec.ts` (too broad →
error; valid → saved, never re-rendered), `app-builds-a11y.spec.ts` (axe; keyboard `↑↓`, `Enter`, `Esc`, `C`, `R`).
Seeded through the API with `EVER_WORKS_E2E_FAKES` (CONTRACTS §7) so no real GitHub run is needed.

### 10.3 Live acceptance

`ACC-05-01…23`, `29` and `30` run in APW-13's harness against the fixture repository `ever-works/app-fixture-hello`
on real GitHub-hosted runners. The failure fixtures are branches of that repository **created and maintained by APW-13**
(Resolution R-23: `variant/build-oom`, `variant/services-postgres`, `variant/missing-value`, `variant/secret-in-image`,
`variant/dockerfile-error`, created by APW-13 T58; short names elsewhere in this epic mean `variant/<name>`); this epic
references them and creates none.

---

## 11. Phasing

### P1 — Builds on GitHub-hosted runners (Wave 1; spec FR-1…FR-54, FR-60…FR-70)

Contracts, capability + category, `github-actions-build`, `work_builds`, facade + services, three jobs, consumer,
routes, Builds tab, drawer, Overview card, pull token, the App checks job (R-9), runner verification with APW-07's
ephemeral recipe (R-10), i18n, tests, docs. **Ships value alone**: App Works build and
deploy by digest on Your cluster.

**P2 — none.** Verified Blueprints on Ever Works Apps (Wave 2) build with P1 (spec FR-2).

### P3 — Ever Works Apps builder (Wave 3; FR-55…FR-59)

`apps-builder` plugin, supply-chain migration, scan/signature columns and UI, managed caps and concurrency, egress
reporting, receipts on the platform meter. **Depends on** APW-10's isolated build controller and launch gate.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** GitHub Actions builds and the managed builder are plugin packages declaring the new `build`
      capability; core code resolves them through `BuildFacadeService`.
- [x] **II — Capability-driven, no hard-coded plugin ids.** Nothing outside the plugins names `github-actions-build`
      or `apps-builder`; the web receives the resolved plugin id from the list response.
- [x] **III — Source-of-truth repositories.** The build definition lives in the user's App spec and the generated
      workflow lives in the user's repository; `work_builds` is derived state.
- [x] **IV — Job-runtime provider.** `app-build-prepare`, `app-build-watch`, `app-build-sweep` go through
      `*_DISPATCHER` symbols; Rebuild and Cancel return `202`; overlapping work is guarded by row leases and a lock.
- [x] **V — Forward-only migrations.** One new table in P1, three additive columns in P3; `down()` removes only what
      `up()` created.
- [x] **VI — Tests are a prerequisite.** 11 plugin specs, 6 agent specs, 3 API specs, 4 e2e specs, live acceptance.
- [x] **VII — Secret hygiene.** Build values travel only as sealed Actions secrets; the workflow file, API responses,
      Activity and telemetry hold names only; excerpts are redacted with the App Work's own values; the pull token is
      `x-secret` and never returned; no platform or user Git token reaches a cluster.
- [x] **VIII — Plugin counts.** Plugins and category recorded only in `built-in-plugins.md` / `plugin-categories.md`.
- [x] **IX — Behaviour-first spec.** `spec.md` names user-visible artefacts (workflow path, tags, secret prefix) only.
- [x] **X — Backwards compatibility.** New capability, category, table, routes and enum values are additive;
      `IDeploymentPlugin`, the template deploy workflows and `ACTIVE_WORKFLOW_FILES` are unchanged.
- [x] **Program rules 5, 9, 10, 12.** Builds are dispatched jobs (202); result artifacts, logs and verification output
      are untrusted (schema-checked, registry-confirmed, fenced for agents); App check commands are repository content
      run only in the repository's own runner with a read-only token and no secrets; no infrastructure address or
      third-party vulnerability detail appears; every Build that ran carries a receipt, including check minutes.
- [x] **Program audit resolutions.** R-1, R-2, R-4, R-5, R-7, R-9, R-10, R-13, R-22, R-23, R-24 applied as listed at the
      top of this plan.

### Known gaps carried forward, not silently absorbed

- **Default GHCR package visibility** for first pushes from public repositories must be verified live (spec §9); the
  design handles both outcomes.
- **Runner sizes** are GitHub's published numbers at authoring time, kept in one constant (one-line edit + selector test).
- **File contents inside image layers** are not scanned for secrets in P1 (config and history are); P3's scanner may.
- **CONTRACTS additions made by this epic**: job `app-build-prepare` and `app-build-sweep` (§5), route
  `POST /api/works/:id/builds/:buildId/cancel` (§4), `IBuildPlugin.checkImageAccess?` and the verification inputs
  (§3), and the repository conventions table (workflow path, `EW_` prefix, image name). **Requested by this fix pass**:
  the §3 "Build workflow `checks` job" row reworded to the matrix job of §4.14 (one job and check run per check,
  job-level `continue-on-error`), and a §9 row for the reserved per-run secret `EW_VERIFY__PROMPTED`.
- **Check minutes on image/none strategies** have no Build to carry a receipt; the provider's check runs remain the
  only record (APW-08's Task cost view reads them).
- **`auto` strategy** is refused by the only Wave 1 provider (spec §9).
