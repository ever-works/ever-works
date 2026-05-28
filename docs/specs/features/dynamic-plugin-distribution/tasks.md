# Task Breakdown: Dynamic Plugin Distribution (dual-mode)

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small
> enough to land in a single PR and ships with tests per Constitution Principle VI.

**Feature ID**: `dynamic-plugin-distribution`
**Plan**: `./plan.md`
**Status**: `Draft`
**Last updated**: 2026-05-28

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
- [ ] **T19**. Boot reconcile in
      `packages/agent/src/plugins/services/plugin-bootstrap.service.ts`: in
      dynamic mode, install any DB-recorded installed/enabled distributable
      plugins missing from the store before marking ready (FR-13). Idempotent.
    - **Test**: reconcile installs missing, skips present, is safe to re-run.
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

- [ ] **T25**. Implement `PluginExecutionRouterService` at
      `packages/agent/src/plugins/services/plugin-execution-router.service.ts`:
      decide in-process vs job-runtime per capability/operation from
      `executionProfile` + operation classification (FR-17).
    - **Test**: routing matrix.
- [ ] **T26**. In-process path: facades (`packages/agent/src/facades/*`) call the
      dynamically-loaded plugin directly for `sync` operations (FR-15). No change
      for bundled/core. **Test**: short call stays in-process (no job dispatch).
- [ ] **T27**. Long-running path: route `long-running` plugin calls through the
      job runtime (Trigger.dev task in `packages/tasks/src/tasks/trigger/`) that
      imports the plugin and returns via the existing result channel (FR-16).
      Coordinate with [EW-683] for provider abstraction. **Test**: long call dispatched.
- [ ] **T28**. Result/error propagation + timeout/retry parity between paths.

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
