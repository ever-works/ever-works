# Task Breakdown: Dynamic Plugin Distribution (dual-mode)

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small
> enough to land in a single PR and ships with tests per Constitution Principle VI.

**Feature ID**: `dynamic-plugin-distribution`
**Plan**: `./plan.md`
**Status**: `In progress` — Phase 7: T27 is complete (bundled plugins hydrate; a plugin the worker image does not carry is installed into the worker's own store and registered, in dynamic mode). T26's first long-running caller ships behind a switch that is off by default; its FR-15 facade path (a second switch, off by default) takes effect since T27's runtime-installed half. See the Phase 7 status note.
**Last updated**: 2026-09-26

---

## How to use

- Tasks are sequential by default. `(parallel)` tasks can run alongside their predecessor.
- Each task has explicit file paths so an implementer can pick it up cold.
- Jira mapping: the parent Epic groups these into child Tasks named
  `[EW-<epic> Tn-Tm] …` (see the Epic for the live keys).

## Phase 1 — SDK & manifest (T1–T4)

- [ ] **T1**. Add `distribution?: 'core' | 'registry'` and
      `executionProfile?: 'sync' | 'long-running'` to `PluginManifest` at
      `packages/plugin/src/contracts/plugin-manifest.types.ts`.
    - Document default derivation: `systemPlugin === true ⇒ 'core'`, else `'registry'`.
    - **Test**: manifest type + default-derivation unit test in `packages/plugin`.
- [ ] **T2**. Update the manifest JSON-schema validator
      (`packages/agent/src/plugins/services/plugin-manifest-validator.service.ts`)
      to accept and validate the new fields; keep old manifests valid (forward-compat).
    - **Test**: validator spec covering present/absent/invalid values.
- [ ] **T3** (parallel with T2). Add install/catalog DTOs in
      `packages/contracts/src/api/plugins/` (`PluginInstallStateDto`, catalog
      entry, allowlist DTOs); export from the package index.
- [ ] **T4**. Bump `@ever-works/plugin` minor; note additive change in its
      changelog. Confirm `pnpm build:plugins` + type-check green.

## Phase 2 — Data model & migrations (T5–T8b)

- [ ] **T5**. Add columns to `PluginEntity` at
      `packages/agent/src/plugins/entities/plugin.entity.ts`: `source`,
      `registrySpec`, `installedVersion`, `integrity`, `installState`.
    - **Test**: entity spec.
- [ ] **T6**. Add `PluginAllowlistEntity` at
      `packages/agent/src/plugins/entities/plugin-allowlist.entity.ts`; register
      in `PLUGIN_ENTITIES` and the agent entities index.
- [ ] **T7**. Add `PluginAllowlistRepository` +
      `PluginRepository` methods for install-state transitions at
      `packages/agent/src/plugins/repositories/`.
    - **Test**: repository specs.
- [ ] **T8**. Generate migrations from `apps/api/`:
      `AddPluginDistributionColumns` + `CreatePluginAllowlist`
      (`pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/<Name>`).
      Read the SQL by hand — additive, forward-only, no `DROP`. (NN #16)
- [ ] **T8b**. Decouple the API from storage plugins: remove
      `@ever-works/{aws-s3,minio,github-storage}-plugin` from
      `apps/api/package.json`; resolve storage via the capability facade/registry
      instead of static imports. Set those three plugins' manifest
      `distribution: 'registry'`. Keep `local-fs` (`systemPlugin`) bundled as the
      core default so the API boots with working storage and no distributable
      plugin is boot-critical (FR-4).
    - **Test**: API boots with only `local-fs`; s3/minio/github-storage resolve
      via facade when enabled; e2e for default-storage path.

## Phase 3 — Publish pipeline (T9–T13)

- [ ] **T9**. Add Changesets (`.changeset/config.json`) configured for
      independent versioning of `packages/plugins/*` + `packages/plugin`.
- [ ] **T10**. Flip `private: true → false` and add `publishConfig` (access +
      registry) to each **distributable** plugin `package.json`. Leave core
      plugins as-is. Verify the core/distributable split against T1's rule.
- [ ] **T11**. Add a dual-publish GitHub Actions workflow at
      `.github/workflows/publish-plugins.yml` mirroring the auth pattern in
      `.github/workflows/publish-cli.yml`: build changed plugins, publish to
      **public npm** and **GitHub Packages** (`@ever-works` scope), gated on
      release/changeset.
- [ ] **T12**. Add a `release`/`publish` script per distributable plugin (or a
      root orchestration script) and wire into the workflow; include a `--dry-run`.
- [ ] **T13**. CI dry-run publish on a PR; confirm both registries resolve the
      package and that `npm view` / GitHub Packages show the version.

## Phase 4 — Config & feature flag (T14–T15)

- [ ] **T14**. Add config to `apps/api/src/config/constants.ts` (lazy-fn pattern):
      `PLUGIN_DISTRIBUTION_MODE` (`bundled`|`dynamic`, default `bundled`),
      `PLUGIN_REGISTRY_URL`, `PLUGIN_REGISTRY_GITHUB_URL`, `PLUGIN_REGISTRY_TOKEN`
      (secret), `PLUGIN_INSTALL_DIR` (default `/app/plugins`),
      `FEATURE_DYNAMIC_PLUGINS`. Fail-fast validation when dynamic + no registry.
    - **Test**: config validation spec.
- [ ] **T15**. Thread the mode/paths into `PluginsModule.forRootAsync` options
      (`packages/agent/src/plugins/plugins.module.ts`,
      `apps/api/src/api.module.ts`) so `pluginPaths`/install dir derive from config.

## Phase 5 — Installer & boot reconcile (T16–T20)

- [ ] **T16**. Implement `PluginInstallerService` at
      `packages/agent/src/plugins/services/plugin-installer.service.ts`:
      resolve `pkg@version` from the registry, **allowlist-check first**,
      download, **verify integrity**, place into `PLUGIN_INSTALL_DIR`. Per-id
      concurrency guard; idempotent (skip if present + integrity matches).
    - **Test**: installer spec with mocked registry + allowlist + integrity paths.
- [ ] **T17**. Allowlist enforcement: first-party `@ever-works/*` implicitly
      allowed; everything else must match an enabled `plugin_allowlist` row;
      refuse before download (FR-11). **Test**: allow/deny matrix.
- [ ] **T18**. Wire installer into the enable flow in
      `packages/agent/src/plugins/services/plugin-operations.service.ts`
      (`enablePluginForUser`): in dynamic mode, if not installed →
      install → `PluginLoaderService.load(path)` → register → then enable.
      Bundled mode unchanged. Update `installState` transitions + failure reason.
    - **Test**: enable-installs-then-enables; failure leaves no partial registration (FR-14).
- [ ] **T19**. **Lazy install-on-use** `ensurePluginAvailable(pluginId)` on the
      installer/loader path: before any node invokes a distributable plugin,
      install-if-missing (pinned version+integrity, per-id lock) then load+register.
      This is the correctness guarantee (FR-13) — a plugin enabled on replica A is
      usable on replica B and in the worker with no restart/shared volume. Also add
      **boot warmup** in `plugin-bootstrap.service.ts` that pre-installs the
      DB-recorded set (FR-13a, optimisation only). Idempotent.
    - **Test**: enable on one registry instance → second instance with empty store
      lazily installs on first use; warmup pre-installs; both safe to re-run.
- [ ] **T20**. Uninstall path (`DELETE /plugins/:id/install` service method);
      refuse for core/`systemPlugin`; default retention = keep files, mark
      not-installed. **Test**: core refusal + non-core uninstall.

## Phase 6 — API surface (T21–T24)

- [ ] **T21**. Add controller methods in
      `apps/api/src/plugins/plugins.controller.ts`: `GET /plugins/catalog`,
      `POST /plugins/:id/install`, `DELETE /plugins/:id/install`,
      `GET /plugins/:id/install-status`. Swagger decorators + error mapping
      (409/424/502/422).
- [ ] **T22**. Catalog service: list distributable plugins (manifest summaries)
      from the registry/catalog source, merged with local install state.
    - **Test**: catalog merge + registry-down degradation.
- [ ] **T23**. Admin allowlist endpoints `GET/POST/DELETE /admin/plugins/allowlist`
      (admin-gated) in a new `apps/api/src/plugins/allowlist.controller.ts`.
- [ ] **T24**. e2e: `apps/api/test/plugins-dynamic.e2e-spec.ts` — install →
      enable → use, non-allowlisted refusal, integrity mismatch, registry-down.

## Phase 7 — Execution router (T25–T28)

> **Status (2026-09-24).** The router existed but could never run a
> long-running call: it was not exported and had no caller; it lazy-imported
> `@trigger.dev/sdk` (which does not resolve from `packages/agent`) and waited
> on `wait.forRunToComplete` (absent in SDK 4.5.11); and the worker task booted
> a context with no plugin registry. Now:
>
> - the router routes an explicit per-call profile, or the manifest's
>   `executionProfile`, in bundled AND dynamic mode (an unmarked call stays
>   in-process in bundled mode, FR-22), is exported from `PluginsModule`, and
>   dispatches through the active job runtime —
>   `dispatchers.dispatchPluginOperation`, then the contract's new optional
>   `getRunResult` (deadline, backoff, `AbortSignal`), with
>   `startLongRunning` / `pollLongRunning` for callers that must not block;
> - `run-plugin-operation` boots `TriggerRunPluginOperationModule` (registry +
>   remote cache), hydrates the plugins bundled into the worker image, and
>   resolves the operation on the materialised plugin — an end-to-end spec runs
>   a fixture plugin through the REAL module.
>
> **Review follow-ups:**
>
> - Only operations a plugin DECLARES in `everworks.plugin.operations` can be
>   called by name, on both paths. Before this, TS-`private` helpers, inherited
>   `BasePlugin` helpers and function-valued class fields were all reachable.
>   Each declaration may carry its own `executionProfile` (FR-17), which the
>   router ranks between an explicit call profile and the manifest-level one.
> - A lazily loaded plugin whose `onLoad` fails is refused: the task answers
>   `WORKER_PLUGIN_LOAD_FAILED` and the router `PLUGIN_LOAD_FAILED`. Before, the
>   failure was recorded on the registry entry but the operation ran anyway.
> - Wait hardening:
>     - every read has a time limit (30 s, or the time left) and ends on an abort;
>     - `pollLongRunning` reads for at most 20 s;
>     - `sleep` no longer leaves listeners on the caller's signal;
>     - `timeoutMs`/`pollIntervalMs` are validated, and the interval never drops
>       below 250 ms;
>     - a run that stays unreadable answers `JOB_RUNTIME_RUN_UNREADABLE` ("not
>       cancelled"), no longer `JOB_RUNTIME_FAILED`;
>     - the last sleep is cut to the time left, and one final read is made at
>       the deadline, so a run that finished inside the budget is answered.
> - A completed run whose offloaded output failed to download is
>   `completed` + `outputUnavailable` (a new optional `JobRunResult` field). It is
>   read again, and if it stays that way the answer is
>   `JOB_RUNTIME_OUTPUT_UNREADABLE`: completed, do not re-dispatch. It is never
>   reported as failed or as "may still be running".
> - Second review:
>     - a caller that arrives while another caller's first materialisation is
>       still in `onLoad` now waits for it (`__materialize({ waitForLoad: true })`)
>       before the state check;
>     - `operations` and `executionProfile` are read from the static manifest
>       only, never from `getManifest()`, so cold and warm replicas route alike;
>     - an invalid plugin manifest is logged, not dropped silently.
> - The task id, the payload type, the queue TTL and `maxDuration` are shared
>   constants in `@ever-works/agent/tasks`. The router's default wait (80 min:
>   TTL + `maxDuration` + boot) is derived from them, and an unmocked spec pins
>   the wiring.
>
> **T26 (owner decision 2026-09-25: all three, each behind configuration,
> nothing removed):**
>
> - **The first long-running caller.** `claude-managed-agent` declares
>   `runSandboxSession` in `everworks.plugin.operations` with
>   `executionProfile: 'long-running'`. `ManagedAgentSandboxRunnerService`
>   (`packages/agent/src/plugins/services/managed-agent-sandbox-runner.service.ts`,
>   provided and exported by `PluginsModule`) runs one sandbox session through
>   the router: it starts, polls, waits for and cancels the session, with the
>   Work's tenant. The switch is `PLUGIN_SANDBOX_SESSIONS_VIA_JOB_RUNTIME`
>   (`PluginsModuleOptions.sandboxSessionsViaJobRuntime`). It is off by
>   default, and then the session runs in the API process through the plugin
>   and stops on the caller's `AbortSignal`.
>     - The runner names no plugin id (Constitution Principle II). Its caller
>       passes the plugin id on every `run` / `start`. APW-04 T48's session
>       runner selects that plugin by `enforcesRuntimeNetworking` plus
>       `runSandboxSession` (the first enabled such pipeline with resolvable
>       settings); only specs name `claude-managed-agent`.
>     - On the job-runtime path, a signal that is already aborted starts
>       nothing, on `run` and `start` alike. On `start`, a signal aborted
>       while the run is being started cancels that run.
>     - The router gained `cancelLongRunning(runId, { tenantId })`. It calls
>       `provider.cancel` through the tenant's view, answers within 20 s and
>       never throws.
>     - It also gained `dispatchSync(…, { signal })`, which hands the signal to
>       the operation as its second argument.
>     - The APW-04 App Provisioner does not exist yet. Its session runner (T48)
>       is meant to select the pipeline and then open the session through this
>       runner.
> - **FR-15 facade install-on-use.** `BaseFacadeService.resolvePlugin` asks
>   `FacadePluginAvailabilityService` for a plugin this process has not
>   registered. Two lookups ask: an explicit provider override and the Work's
>   active plugin. The service calls `installer.ensureLocalInstall(pluginId)`
>   (the pinned version and integrity, allowlist first, into THIS replica's
>   store, never writing the shared row), then
>   `loader.registerFromPath(installPath, { expectedId })`, loads the plugin and
>   reads the registry again.
>     - It is active only in dynamic mode, and only with
>       `PLUGIN_FACADE_INSTALL_ON_USE` (`PluginsModuleOptions.facadeInstallOnUse`,
>       off by default) turned on.
>     - Only a plugin the platform already installed and pinned qualifies: a
>       `registry`-sourced row in state `installed` with its `registrySpec`
>       and `installedVersion`. A miss is not retried for 60 s, and at most
>       1,000 misses are remembered (oldest forgotten first).
>     - **In effect since T27's runtime-installed half.** A row with no
>       integrity pin is refused before any fetch and answered as absent.
> - **T27's acceptance proof** stays the real-module fixture test
>   `packages/tasks/src/trigger/worker/modules/__tests__/trigger-run-plugin-operation.module.spec.ts`.
>
> **T27 runtime-installed half (2026-09-25, `05e4b0236`):**
>
> - `run-plugin-operation` hydrates first. Then, in dynamic mode and for a
>   plugin the worker image does not carry, it calls
>   `PluginInstallerService.ensureLocalInstall`: the version the API pinned
>   (exact version + integrity), allowlist first (FR-11), into the worker's own
>   store (`PLUGIN_INSTALL_DIR`, default `<cwd>/.plugin-store`). It never writes
>   the shared install row: the worker only reads
>   `PluginRepository.findByPluginId`.
> - `PluginLoaderService.registerFromPath` then registers the extracted
>   directory.
> - New codes: `WORKER_INSTALL_REFUSED` (refused before any download) and
>   `WORKER_INSTALL_FAILED` (the fetch or the registration failed).
> - The worker reads `PLUGIN_DISTRIBUTION_MODE`, `PLUGIN_REGISTRY_*` and
>   `PLUGIN_INSTALL_DIR` exactly as the API does.
> - Allowlisted third-party packages may run in the worker, through the
>   read-only `PluginAllowlistReader` remote target (owner decision).
> - With `PLUGIN_DISTRIBUTION_MODE=dynamic` set for `pnpm deploy:trigger`,
>   `prepare-plugins.js` copies core plugins only (mirrors T29). Bundled stays
>   the default. `pacote` is external and installed via `additionalPackages`.
> - A worker run in dynamic mode on an image built without
>   `PLUGIN_DISTRIBUTION_MODE=dynamic` runs the image's copy of a distributable
>   plugin, and logs a warning once per plugin version per process.
> - The store marks a complete copy with `.ew-install.json` (name, version, and
>   the integrity it was verified against), written before the extract is
>   renamed into place. A tree without it (for example an interrupted pre-T27
>   in-place extract) or marked for another integrity (a re-published version)
>   is fetched again, once. This includes an explicit re-install.
> - A pin that is not a plain npm package name and an exact semver version is
>   refused before anything on disk is touched: 409 on the API,
>   `WORKER_INSTALL_REFUSED` in the worker. The store path and the
>   `node_modules` link are built from row data.
> - API side: `ensurePluginAvailable` no longer takes the shared row as proof
>   of local files. It answers from this replica's store, or fetches the pinned
>   version there without writing the row. The enable path and
>   `POST /plugins/:id/install` register what was installed
>   (`PluginOperationsService.registerInstalledPlugin`).
> - The boot warmup gives each plugin at most `PLUGIN_WARMUP_TIMEOUT_MS`
>   (default 60000; `0` = no bound). A slower plugin keeps fetching in the
>   background.
> - Acceptance: the dynamic-mode describe in
>   `trigger-run-plugin-operation.module.spec.ts` (real module, stub registry,
>   stub API).
>
> **Tenant-aware routing (2026-09-25, `05e4b0236`; bounds 2026-09-26,
> `68ffb9a97`).** `dispatch`, `dispatchLongRunning`,
> `startLongRunning(pluginId, op, args, { tenantId })`,
> `pollLongRunning(runId, { tenantId })` and `cancelLongRunning` take the
> Work's tenant. With one, the run goes through
> `TenantAwareRuntimeResolver.resolve(tenantId)`, looked up through `ModuleRef`
> (`getOptionalProvider`) because the resolver lives in the non-global
> `TenantJobRuntimeModule`. A BYO tenant's run starts and is read in the
> tenant's own Trigger.dev project, and the wait reads through the same view it
> dispatched through; the caller keeps the tenant next to the run id for
> polling. With no resolver, or a resolver that throws, the call uses the
> platform runtime; a resolver answering `null` gives
> `JOB_RUNTIME_UNAVAILABLE`. Without `tenantId` nothing is looked up and the
> payload is unchanged.
>
> - The lookup is time-limited in `startLongRunning`, `pollLongRunning` and
>   `cancelLongRunning` (the HTTP callers' methods), not in
>   `dispatchLongRunning`. In `startLongRunning` the lookup and the FR-5 stamp
>   share a budget of about 20 s (the stamp always gets at least 1 s): a lookup
>   that does not answer in time is `JOB_RUNTIME_DISPATCH_FAILED` with nothing
>   dispatched (deliberately not the platform provider), and a stamp that does
>   not answer in time dispatches unstamped. In `dispatchLongRunning`, an abort
>   before or during the lookup dispatches nothing (`JOB_RUNTIME_WAIT_ABORTED`,
>   no `runId`); an abort during or after the dispatch keeps the `runId`, and
>   `ManagedAgentSandboxRunnerService.run()` cancels by it.
> - FR-5: a tenant call's `run-plugin-operation` payload carries `tenantId` and,
>   when `RuntimeBindingStamperService` is bound, its `providerId` /
>   `credentialVersion`; the worker ignores them. The BYO dispatcher map
>   (`dispatchersFromTenantClient`) gained `dispatchPluginOperation`, so a BYO
>   tenant's Trigger.dev project must deploy `run-plugin-operation`.
> - Two latent defects were fixed along the way. `TenantJobRuntimeModule` bound
>   its own, never-registered `JOB_RUNTIME_PROVIDER_REGISTRY`, so the resolver
>   answered `null` for every tenant. And a BYO view's stamping Proxy used the
>   frozen BYO dispatcher map as its target, so every BYO dispatch threw a
>   Proxy-invariant `TypeError`.
> - Known limits are recorded with the router consumer in
>   [`tenant-job-runtime-overlay/tasks.md`](../tenant-job-runtime-overlay/tasks.md)
>   (Phase 3).
>
> **Still open:**
>
> - `PluginExecutionRouterService.dispatchSync` and the boot warmup place a
>   runtime-installed plugin on the replica but do not register it (the warmup
>   is bounded by `PLUGIN_WARMUP_TIMEOUT_MS`).
> - Worker tasks other than `run-plugin-operation` do not install at runtime,
>   so do not build a core-only worker image while they need a distributable
>   plugin.
> - `onLoad` does not run for a runtime-registered plugin when
>   `PLUGIN_LAZY_LOAD=false`.

- [x] **T25**. Implement `PluginExecutionRouterService` at
      `packages/agent/src/plugins/services/plugin-execution-router.service.ts`:
      decide in-process vs job-runtime per capability/operation from
      `executionProfile` + operation classification (FR-17).
    - **Test**: routing matrix.
- [ ] **T26**. In-process path: facades (`packages/agent/src/facades/*`) call the
      dynamically-loaded plugin directly for `sync` operations (FR-15). No change
      for bundled/core. **Test**: short call stays in-process (no job dispatch).
    - **Status (2026-09-25)**: the long-running caller is done
      (`ManagedAgentSandboxRunnerService`, behind
      `PLUGIN_SANDBOX_SESSIONS_VIA_JOB_RUNTIME`, off by default). The FR-15
      facade path (`FacadePluginAvailabilityService`, behind
      `PLUGIN_FACADE_INSTALL_ON_USE`, off by default) is wired, and takes
      effect since T27's runtime-installed half (`ensureLocalInstall` +
      `registerFromPath`; see the Phase 7 note).
- [x] **T27**. Long-running path: route `long-running` plugin calls through the
      job runtime (Trigger.dev task in `packages/tasks/src/tasks/trigger/`). The
      task MUST call `ensurePluginAvailable` (T19) **first** — the worker is a
      separate runtime with its own store, so a runtime-installed plugin is absent
      there until installed — then import the plugin and return via the existing
      result channel (FR-16). Coordinate with [EW-683] for provider abstraction.
    - **Test**: long call for a runtime-installed plugin succeeds in the worker
      (worker installs into its own store first), not just the API.
    - **Acceptance proof**: the real-module fixture test
      `packages/tasks/src/trigger/worker/modules/__tests__/trigger-run-plugin-operation.module.spec.ts`.
    - **Status (2026-09-25)**: done. The task installs via `ensureLocalInstall`
      (not `ensurePluginAvailable`, which can write the shared row); acceptance
      proof as above.
- [x] **T28**. Result/error propagation + timeout/retry parity between paths.
      (Both paths answer one `PluginExecutionResult`; the job-runtime path adds the
      run id and named `JOB_RUNTIME_*` codes; the worker task runs one attempt.)

## Phase 8 — Deployment (T29–T32)

- [ ] **T29**. Dynamic-mode image: build a core-only plugin set into the image
      (build arg / variant) at `.deploy/docker/api/Dockerfile`; keep the current
      all-bundled image as the `bundled` default. Confirm only core plugins land
      in `/app/plugins`.
- [ ] **T30**. Writable runtime store: ensure `PLUGIN_INSTALL_DIR` is writable
      in k8s (`.deploy/k8s/k8s-manifest.prod.yaml`) — emptyDir (per-replica) or
      optional PVC; readiness gate until boot reconcile completes.
- [ ] **T31**. Entrypoint/boot wiring (`.deploy/docker/api/entrypoint.sh`) so
      reconcile runs before serving; document ordering vs migrations.
- [ ] **T32**. Document that read-only-FS serverless targets (Vercel) support
      `bundled` only; dynamic mode requires a writable store.

## Phase 9 — Web / CLI (T33–T36)

- [ ] **T33**. Extend `apps/web/src/lib/api/plugins.ts` with catalog, install,
      install-status, uninstall calls + types.
- [ ] **T34**. Plugins settings page
      (`apps/web/src/app/[locale]/(dashboard)/settings/plugins/[category]/page.tsx`):
      install-state chips, Install action, progress, error surfacing; Enable
      triggers install-then-enable in dynamic mode (FR-18/19/20).
- [ ] **T35**. Admin allowlist management page + components.
- [ ] **T36** (optional). CLI `ever-works plugins install|uninstall|list`
      under `apps/cli/src/commands/`.

## Phase 10 — Observability, docs & rollout (T37–T40)

- [ ] **T37**. Activity-log events + metrics for install/upgrade/uninstall/reconcile
      (`plugin.install.*`), Sentry tags (`plugin_source`, `distribution_mode`).
- [ ] **T38**. Update canonical `docs/plugin-system/built-in-plugins.md` with the
      core vs distributable split (Principle VIII); update
      `docs/specs/architecture/runtime-plugins.md` cross-links and
      `docs/specs/README.md` index.
- [ ] **T39**. Operator runbook: enabling dynamic mode, registry config, store
      volume, troubleshooting failed installs (under `docs/` + Workspace KB).
- [ ] **T40**. Flip spec `Status: Implemented`, mark plan/tasks `Done`; run
      `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` green.

## Definition of Done

- All checkboxes ticked; all new code tested and green in CI.
- `pnpm format:check` and `pnpm lint` green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Bundled-mode behaviour is byte-for-byte unchanged for a no-config deployment.
- Both execution paths (in-process + job-runtime) covered by integration tests.
- Constitution gates in `spec.md` §9 all confirmed satisfied.
