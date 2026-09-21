# Task Breakdown: Ever Works Apps — isolated hosting tier (launch gate)

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships
> with tests per **Constitution VI**. Schema tasks ship their migrations in the same PR per
> **Constitution V**.

**Epic ID**: `APW-10-apps-hosting-tier`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the files to create or modify. **new** marks a file that does not exist yet; every other path was
  checked with `git ls-files` on `develop` @ `ee45946e5`.
- Every task has a **Test** line (file + assertion, or the run command for a test task) and a **Done when** line
  that is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Program audit resolutions ([CONTRACTS.md §0](../CONTRACTS.md)) applied here: R-1 (shared types in
  `packages/contracts/src/apps/`), R-2 (Activity `actionType` `app_tier`, dotted `action`), R-5 (the platform writes
  desired state only; this epic owns `AppsTierPolicy`), R-15 (delete semantics), R-20 (Quarantine naming), R-22 (no
  suite under `apps/api/test/`), R-24 (sandboxed runtime in Wave 2, sandboxed builds in Wave 3).
- **Public-repository hygiene applies to every task:** no address, host name, cluster or node name, vendor
  account id, or assessment of an existing system in code, tests, fixtures, comments, commit messages or PR
  text. Probe targets, zone values and drill evidence live in the private operations repository.
- Infrastructure work (building the zone, admission products, edge account, data servers) is **not** in
  this file; it is tracked in the private operations plan. Tasks here that need a zone say so. Where a Test line is an
  operator attestation, it names the automated self-check run it relies on and the private evidence artefact **by
  name only** (plan §10.5).
- Run commands, from the monorepo root:
    - contracts: `pnpm --filter @ever-works/contracts test`
    - plugin contracts: `pnpm --filter @ever-works/plugin test`
    - controller: `pnpm --filter ever-works-hosting-operator test` (kind lane: `test:integration`)
    - tier plugin: `pnpm --filter @ever-works/ever-works-apps-plugin test`
    - agent: `pnpm --filter @ever-works/agent test -- apps-tier`
    - tasks: `pnpm --filter @ever-works/trigger-tasks test`
    - API: `cd apps/api && pnpm test -- apps-tier`
    - web unit: `pnpm --filter ever-works-web test -- apps-tier`; web e2e: `pnpm --filter ever-works-web test:e2e admin-apps-tier`

---

# Phase P1 — The gate can be evaluated and the brakes work (Wave 2)

_Delivers spec FR-1…FR-29, FR-41…FR-46, FR-52, FR-53. The tier stays **Closed**._

## P1.1 — Shared contracts

- [ ] **T1. Launch-gate ids, outcomes and reason codes.**
      **Create** `packages/contracts/src/apps/apps-tier.ts` (**new**, Resolution R-1) — `LAUNCH_GATE_ITEM_IDS`
      (`LG-01`…`LG-25`), `LaunchGateKind` (`automated`/`attested`/`both`), `LaunchGatePhase` (`P2`/`P3`),
      `LaunchGateOutcome` (`passed`/`failed`/`inconclusive`/`error`), every reason code from
      [plan §3.7](./plan.md) and §5.4, tier states and scopes, `Work` phases (incl. `removed`), quarantine categories
      and sources, signal kinds and severities, owner eligibility reasons (`emailUnverified`, `planRequired`,
      `ownerQuarantined`, `capReached`, `tierClosed`), and the numeric constants (`GATE_MAX_AGE_HOURS = 24`,
      `SELF_CHECK_BUDGET_MS = 900_000`, `PROBE_CONNECT_TIMEOUT_MS = 3_000`, `PROBE_ATTEMPTS = 2`,
      `SELF_CHECK_INTERVAL_HOURS = 6`, `ATTESTATION_TTL_DAYS = 90`, `ATTESTATION_NOTICE_DAYS = [14, 1]`,
      `HEARTBEAT_MAX_AGE_MS = 120_000`, `GATE_WATCH_INTERVAL_MIN = 5`, `QUARANTINE_ISOLATE_MS = 15_000`,
      `QUARANTINE_SCALE_MS = 60_000`, `QUARANTINE_EDGE_MS = 120_000`, `RELEASE_RESTORE_MS = 180_000`,
      `DETECTOR_QUARANTINE_MS = 60_000`, `IMAGE_ALLOWANCE_MAX_DAYS = 30`, `PULL_CREDENTIAL_MAX_MS = 900_000`,
      `REMOVED_DATA_RETENTION_DAYS = 30`).
      **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` — `export * from './apps-tier.js';` (create the
      barrel, and `export * from './apps/index.js';` in `packages/contracts/src/index.ts`, only if APW-03 has not
      landed).
      **Test**: `packages/contracts/src/apps/__tests__/apps-tier.spec.ts` (**new**) — pins the 25 ids in order, every
      union (a member cannot be added without editing the test) and every constant, incl. the 6-hour
      `SELF_CHECK_INTERVAL_HOURS` (ACC-10-01, ACC-10-07); run `pnpm --filter @ever-works/contracts test`.
      **Done when**: `import { LAUNCH_GATE_ITEM_IDS } from '@ever-works/contracts'` resolves from `apps/api`,
      `apps/web` and `apps/hosting-operator`, and `packages/contracts/src/__tests__/index.barrel.spec.ts` passes.

- [ ] **T2 (parallel with T1). `apps-tier` capability contract.**
      **Create** `packages/plugin/src/contracts/capabilities/apps-tier.interface.ts` and
      `apps-tier.types.ts` (**new**) exactly as [plan §5.1](./plan.md), incl. `removeWork(workId, { deleteData })`.
      **Modify** `packages/plugin/src/contracts/capabilities/index.ts` (export both) and
      `packages/plugin/src/contracts/facade-capabilities.ts` (`APPS_TIER: 'apps-tier'`).
      **Test**: `packages/plugin/src/contracts/__tests__/apps-tier.types.spec.ts` (**new**) — `submitBuild` and
      `getBuild` stay optional, `removeWork` requires the `deleteData` option, `PLUGIN_CAPABILITIES.APPS_TIER` equals
      `'apps-tier'`; run `pnpm --filter @ever-works/plugin test`.
      **Done when**: `pnpm --filter @ever-works/plugin build` is clean and no existing capability constant changed.

## P1.2 — The zone controller

- [ ] **T3. Controller package and CRDs.**
      **Create** `apps/hosting-operator/` (**new**): `package.json` (name `ever-works-hosting-operator`,
      private, ESM, `tsup`, `vitest`, scripts `test` and `test:integration`, dependency `@kubernetes/client-node`
      matching `packages/plugins/k8s/package.json`), `tsconfig.json`, `vitest.config.ts`,
      `src/crds/{work,selfcheck,usagereport,abusesignal,appbuild}.ts` (schemas from [plan §3.1–3.2](./plan.md),
      incl. `spec.desiredState: removed`, `spec.dataDeletion`, `status.removal`, `status.dependencies`),
      `scripts/generate-crds.ts` → `deploy/crds/*.yaml`. `pnpm-workspace.yaml` already globs `apps/*`.
      **Test**: `packages/hosting-crds/src/crds/__tests__/crds.spec.ts` (**new**) — generated YAML equals committed
      YAML; `Work` rejects a `namespace` field (ACC-10-26), an image without `@sha256:`, and an object over 512 KiB
      (ACC-10-27); run `pnpm --filter ever-works-hosting-operator test`.
      **Done when**: `pnpm --filter ever-works-hosting-operator build test` passes and CI fails if generated CRDs
      drift.

> **T3 landed differently, and deliberately — two owner rulings.** (1) 2026-09-20: T3 shipped as written,
> then the schema half was split out, because both ends of the tier import it and `apps/*` here means a
> process, which a CRD-only package was not. (2) 2026-09-21: the owner rejected the name
> `apps-tier-controller` outright. The process is now **`apps/hosting-operator`**
> (`ever-works-hosting-operator`) and the contract is **`packages/hosting-crds`**
> (`@ever-works/hosting-crds`) — “operator” is the Kubernetes word for a controller that owns custom
> resources, and `hosting` matches the API group these CRDs actually serve, `hosting.ever.works/v1alpha1`.
> The drift gate is `pnpm --filter @ever-works/hosting-crds test` (47 tests); the process’s bootstrap,
> config and reconciler port landed on 2026-09-20 and it **refuses to start** until T6 registers a
> reconciler. The `APPS_TIER_*` names in `@ever-works/contracts` are deliberately unchanged: they are
> operator-facing env-var names and the tier’s own product vocabulary, not this package’s name. See
> `apps/hosting-operator/README.md`.

- [ ] **T4. Tenant template and pod overlays.**
      **Create** `apps/hosting-operator/src/template/tenant-template.ts` and `src/template/pod-overlays.ts`
      (**new**) per [plan §3.4](./plan.md) (pure functions of `Work`, profile and zone info; StatefulSet PVC
      retention pinned to `Retain`).
      **Test**: `apps/hosting-operator/src/template/__tests__/tenant-template.spec.ts` and `pod-overlays.spec.ts`
      (**new**) with golden files in `src/template/__tests__/fixtures/` — a hostile rendered pod (privileged,
      `hostNetwork`, `runAsUser: 0`, token automount, no runtime class, extra capabilities) comes out fully
      overwritten (ACC-10-15 unit half); the egress `except` list contains all 11 standard ranges; ports 25/465/587
      absent (ACC-10-13 unit half); the Starter and Standard `ResourceQuota` objects equal spec FR-47 incl. 0 load
      balancers and 0 node ports (ACC-10-14 unit half, ACC-10-41).
      **Create** `apps/hosting-operator/src/template/__tests__/canary-parity.spec.ts` (**new**) — the template for
      a `Work` labelled `hosting.ever.works/canary: "true"` equals the template for a real `Work` object by object once
      names, ids and the canary label are masked (ACC-10-06).
      **Done when**: no overlay field can be influenced by any `Work.spec` value and the three specs pass.

- [ ] **T5. Validation, fingerprints and unsealing.**
      **Create** `apps/hosting-operator/src/validate/work-spec.validator.ts`,
      `src/validate/credential-fingerprints.ts`, `src/seal/unseal.ts` (**new**).
      **Test**: `apps/hosting-operator/src/validate/__tests__/work-spec.validator.spec.ts` — every FR-26 limit at N
      and N+1 (ACC-10-27), each refusal code of [plan §3.1](./plan.md), a host already referenced by another `Work`
      refused `HOST_CLAIMED` (ACC-10-31 unit half);
      `src/validate/__tests__/credential-fingerprints.spec.ts` — an env value equal to a configured fingerprint
      refuses the `Work` with `PLATFORM_CREDENTIAL_IN_ENV` and zero workloads, a one-character change passes
      (ACC-10-28); `src/seal/__tests__/unseal.spec.ts` — rejects a tampered tag and a wrong key id.
      **Done when**: the three specs pass and no refusal message contains the env value.

- [ ] **T6. Work reconciler, heartbeat, leader election.**
      **Create** `apps/hosting-operator/src/main.ts`, `src/reconcile/work.reconciler.ts` (**new**) —
      informers on `Work`, level-triggered reconcile with 300 s resync, Lease `ever-works-apps-controller`
      renewed every 30 s (FR-29), status phases and `observedGeneration`, namespace `ewa-<first 20 hex>`,
      template applied before any workload, rendering through APW-06's App renderer library (import from
      `packages/plugins/k8s/src/app/` as APW-06 exports it — the platform never sends workload objects, Resolution
      R-5), overlays, server-side apply by the controller with field manager `ever-works-apps-controller`. Removal
      without data deletion (FR-28) delegates to T39's `removal.reconciler.ts`.
      **Added by the 2026-09-17 fix pass.** The reconciler uses **only** APW-06's workload builders (component
      `Deployment`s, `Service`s, `Ingress`, command/runner `Job`s, `CronJob`s, `PVC`s, env `Secret`) and **discards**
      the renderer's `Namespace`, `ServiceAccount`, `LimitRange`, `ResourceQuota` and `NetworkPolicy` objects — tenancy
      objects come only from T4's `tenant-template.ts` (APW10-G03). **Create** `src/render/work-to-render-input.ts`
      _(new)_ for the reverse mapping (`Work.spec` → APW-06 `AppRenderInput`, including `env.values` after T44's
      substitution, `policy`, `ingress`, `hosts.previous`, `deploymentShort`) with a golden round-trip test against
      T26's forward mapper. It runs T43's dependency reconciler before reporting a phase, and it performs T52's P1
      image promotion at startup (APW10-G08).
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/work.reconciler.spec.ts` (**new**) with a fake API —
      ordering (template before workloads); refusal leaves zero workload objects; two `Work`s get two namespaces
      (ACC-10-26); a removed `Work` still has its PVCs and its dependency references after a simulated 30 days
      (ACC-10-29); the Lease renew interval is 30 s.
      **Done when**: the spec passes and the reconciler's API call log contains no create/patch from any identity
      other than the controller's.

- [ ] **T7. Quarantine sequencer.**
      **Create** `apps/hosting-operator/src/reconcile/quarantine.sequencer.ts` (**new**) per
      [plan §2.5](./plan.md): isolate → record counts → scale 0 + suspend CronJobs/Jobs → hosts to unavailable
      backend, each with a status timestamp; release in reverse from recorded counts; detector quarantine with
      `source: detector`.
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/quarantine.sequencer.spec.ts` (**new**) — order
      asserted from the fake API call log with each timestamp inside the LG-18 budgets on a healthy fake (ACC-10-32
      unit half); release restores `{ web: 2, worker: 1 }` exactly and removes the isolation policy (ACC-10-33 unit
      half); a quarantine arriving mid-rollout stops further apply steps and sets condition `Cancelled` with reason
      `Quarantined` (ACC-10-35 controller half); no PVC, Secret or image is modified.
      **Done when**: the spec passes; the quarantine timing evidence on a real zone is `apw10-quarantine-drill` (T22).

- [ ] **T8. Probe entrypoint and library.**
      **Create** `apps/hosting-operator/src/probe/main.ts`, `net.ts`, `kernel.ts`, `token.ts`, `marker.ts`,
      `report.ts` (**new**) — the `probe` command reads its plan from a mounted ConfigMap, runs TCP/HTTPS checks with
      the T1 timeouts, writes a ≤ 4 KiB JSON result to the termination message, never prints a target address.
      **Test**: `apps/hosting-operator/src/probe/__tests__/net.spec.ts` and `report.spec.ts` (**new**) — fake
      sockets: refused, timeout, accepted; a failed control turns dependents `inconclusive` (ACC-10-04 unit half); an
      accepted connection to a private-range sentinel yields `PRIVATE_RANGE_REACHABLE` (ACC-10-08 unit half), to a
      metadata address `METADATA_REACHABLE` (ACC-10-12 unit half), to tenant B `CROSS_TENANT_REACHABLE` (ACC-10-11
      unit half); `kernel.spec.ts` — no sandbox signature yields `SANDBOX_KERNEL_NOT_DETECTED`; output never contains
      an input address.
      **Done when**: the specs pass and the result JSON of every fixture is ≤ 4 KiB.

- [ ] **T9. SelfCheck reconciler (zone side).**
      **Create** `apps/hosting-operator/src/reconcile/selfcheck.reconciler.ts`, `src/policy/drift.ts`
      (**new**) — ensures `canary-a`/`canary-b` `Work`s from zone config through the same `work.reconciler.ts` path
      (plan D-F), runs probe Jobs for LG-02…LG-11, LG-13, LG-14, LG-19 (zone part), LG-22; server-side dry-runs as the
      `apps-tier-prober` service account; zone part of the LG-18 **Tenant quarantine drill**; writes
      `SelfCheck.status.results`; enforces FR-7 minimums (`misconfigured` → `error`).
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/selfcheck.reconciler.spec.ts` (**new**) — a run with
      every probe passing; one with a failing control (dependents `inconclusive`, ACC-10-04); one with one sentinel
      fewer than the FR-7 minimum per private range, 2 platform endpoints or 1 public control, each turning its
      dependent items `error` with reason `misconfigured` (ACC-10-05); a dry-run admitting a `baseline` pod yields
      `PRIVILEGED_POD_ADMITTED` (ACC-10-10 unit half); an unsigned digest admitted yields `UNSIGNED_IMAGE_ADMITTED`
      (ACC-10-17 unit half); canaries are created through `work.reconciler.ts`, never a special path (ACC-10-06);
      `src/policy/__tests__/drift.spec.ts` (**new**) — a one-field change in a policy object yields `POLICY_DRIFT`
      (ACC-10-18 unit half).
      **Done when**: the specs pass; the weakened-zone proof of ACC-10-05, 06, 08…18 is recorded in
      `apw10-weakened-zone-drill` (T22).

- [ ] **T10. Image, manifests and CI.**
      **Create** `apps/hosting-operator/Dockerfile` (distroless Node 22, non-root, read-only root
      filesystem), `deploy/rbac/controller.yaml`, `deploy/rbac/platform-role.yaml` (exactly
      [plan §3.3](./plan.md)), `deploy/rbac/prober.yaml`, `deploy/controller.yaml`, `deploy/README.md`
      (public-safe: what the zone's GitOps must supply, no values).
      **Create** `.github/workflows/hosting-operator.yml` (**new**) — build, test, push image to the
      organisation registry with `:sha-<full sha>` and a branch alias; runs on GitHub-hosted runners.
      **Test**: `apps/hosting-operator/deploy/__tests__/platform-role.spec.ts` (**new**) — parses
      `deploy/rbac/platform-role.yaml` and asserts its rules equal plan §3.3 exactly (no extra resource, verb or
      ClusterRole; ACC-10-16 static half); the workflow runs `pnpm --filter ever-works-hosting-operator test`.
      **Done when**: the workflow publishes an image whose digest is recorded in the run summary.

- [ ] **T11. kind integration job.**
      **Create** `apps/hosting-operator/test/integration/tenant-template.int.spec.ts`,
      `credential-scope.int.spec.ts`, `sandbox-control.int.spec.ts` (**new**) and a job in the T10 workflow that
      starts a kind cluster, installs CRDs + RBAC + controller, applies a fixture `Work`, and asserts: tenant
      template objects exist; overlays present on pods; **LG-04 reports `SANDBOX_KERNEL_NOT_DETECTED`** (the
      known-dirty control — kind has no sandbox runtime; ACC-10-09); LG-11 passes with no token file (ACC-10-15);
      LG-12 fails with `CREDENTIAL_TOO_BROAD` when the test adds `secrets get` to the platform Role (ACC-10-16).
      **Test**: run `pnpm --filter ever-works-hosting-operator test:integration` in the job.
      **Done when**: the job is green on a clean run and red when any of those three assertions is inverted.

## P1.3 — Platform plugin and domain

- [ ] **T12. `ever-works-apps` plugin — control client and sealing.**
      **Create** `packages/plugins/ever-works-apps/` (**new**): `package.json` (name
      `@ever-works/ever-works-apps-plugin`, `everworks.plugin` id `ever-works-apps`, category `deployment`,
      capabilities `["apps-tier","deployment"]`), `vitest.config.ts`, `src/index.ts`, `src/control-client.ts`,
      `src/seal.ts`, `src/apps-tier.provider.ts` implementing the P1 methods of `IAppsTierProvider` (`zoneInfo`,
      `setDesiredState`, `startSelfCheck`, `getSelfCheck`, `reviewCredentialScope`, `getHeartbeat`, `removeWork`),
      export `EVER_WORKS_APPS_PLUGIN_ID`. The client writes only `hosting.ever.works` objects in the control namespace.
      **Modify** `docs/plugin-system/built-in-plugins.md` — one row (Constitution VIII).
      **Test**: `packages/plugins/ever-works-apps/src/__tests__/control-client.spec.ts` (**new**) — with a fake
      `CustomObjectsApi` every call is namespaced to the control namespace and targets only `hosting.ever.works`
      kinds; the credential never appears in a thrown error; `src/__tests__/seal.spec.ts` (**new**) — seal/unseal round
      trip against T5, tamper refused, key id change forces a re-read; run
      `pnpm --filter @ever-works/ever-works-apps-plugin test`.
      **Done when**: plugin discovery lists `ever-works-apps` disabled by default and both specs pass.

- [ ] **T13. Entities and migrations 1–2.**
      **Create** in `packages/agent/src/entities/` (**new**): `apps-tier-gate-run.entity.ts`,
      `apps-tier-attestation.entity.ts`, `apps-tier-state-event.entity.ts`, `apps-tier-quarantine.entity.ts`,
      `apps-tier-abuse-signal.entity.ts`, `apps-tier-image-allowance.entity.ts` per [plan §4](./plan.md);
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts` to register them.
      **Create** `apps/api/src/migrations/1792100000000-CreateAppsTierGate.ts` (seeds one `closed` state
      event) and `1792100100000-CreateAppsTierQuarantineAndSignals.ts` (**new**).
      **Test**: `apps/api/src/migrations/__tests__/CreateAppsTierGate.spec.ts`,
      `CreateAppsTierQuarantineAndSignals.spec.ts` (**new**) — seed present; on SQLite the unique expression index
      refuses a second active quarantine for one Work; the Postgres branch's SQL contains the partial unique index
      `WHERE "state" IN ('requested','active','releasing')`; `down()` drops only what `up()` created.
      **Done when**: `packages/agent/src/database/database.module.spec.ts` and `database.config.spec.ts` pass without a
      magic-number edit.

- [ ] **T14. Gate registry and state service.**
      **Create** `packages/agent/src/apps-tier/gate/launch-gate.registry.ts`,
      `packages/agent/src/apps-tier/gate/apps-tier-state.service.ts`, `packages/agent/src/facades/apps-tier.facade.ts`,
      `packages/agent/src/apps-tier/apps-tier.module.ts`, `packages/agent/src/apps-tier/index.ts` (**new**) —
      `evaluate()` exactly as [plan §5.4](./plan.md) with a 30 s cache, `open()`, `close()`, `recordTransitions()`.
      LG-18's title key resolves to **Tenant quarantine drill**.
      **Modify** `packages/agent/src/facades/facades.module.ts` (`FACADES`) and `packages/agent/src/facades/index.ts`.
      **Test**: `packages/agent/src/apps-tier/__tests__/launch-gate.registry.spec.ts` (**new**) — 25 items with kind and
      phase exactly spec FR-2 (ACC-10-01); `apps-tier-state.evaluate.spec.ts` (**new**) — the full matrix of
      [plan §10.1](./plan.md): a heartbeat older than 120 s yields `CONTROLLER_STALE` and closed (ACC-10-19), a red run
      closes (ACC-10-22), a stale-only closure reopens after a green run (ACC-10-23), scope `any` without LG-24/LG-25
      passed stays closed (ACC-10-25); `apps-tier-state.open.spec.ts` (**new**) — red, 25-hour-old or missing run,
      expired attestation and ceiling off are each refused with every reason listed and no event written
      (ACC-10-20); a green 3-hour-old run with current attestations opens and records run id, actor and reason
      (ACC-10-21).
      **Done when**: no test can open the tier with a missing state row, a missing run, a stale heartbeat or
      the ceiling off.

- [ ] **T15. Attestations.**
      **Create** `packages/agent/src/apps-tier/gate/apps-tier-attestation.service.ts` (**new**) — create
      (evidence 20–2,000 chars, ref ≤ 500), revoke, `expiresAt = attestedAt + 90 d`, notices at 14 d and 1 d
      through `packages/agent/src/facades/email.facade.ts` to every `isPlatformAdmin` user.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-attestation.service.spec.ts` (**new**) — boundaries
      19/20 and 2,000/2,001 chars; one notice per threshold; a revoked or expired attestation makes the next
      `evaluate()` return `ATTESTATION_EXPIRED` or `NOT_ATTESTED` with its item id (ACC-10-20).
      **Done when**: the spec passes and no email body contains the private evidence reference.

- [ ] **T16. Self-check orchestration.**
      **Create** `packages/agent/src/apps-tier/gate/apps-tier-self-check.service.ts` (**new**) — single-flight
      request, `execute(runId)`: create `SelfCheck`, poll 10 s ≤ 15 min, run platform-side probes (LG-12
      access review, LG-15 PSL fetch 8 s, LG-16 canary TLS, LG-18 public reachability timings via the T17
      service path, LG-20, LG-21, LG-23), merge, write `apps_tier_gate_runs` with policy revision and controller
      version.
      **Create** `packages/agent/src/tasks/apps-tier-self-check-dispatcher.ts` (**new**, `Symbol()` token);
      **modify** `packages/agent/src/tasks/_tasks-symbols.ts` and `packages/agent/src/tasks/index.ts`.
      **Create** `packages/tasks/src/tasks/trigger/apps-tier-self-check.task.ts` (**new**; one-shot +
      `schedules.task` cron `23 */6 * * *`, `maxDuration` 20 min, retries 0); **modify**
      `packages/tasks/src/tasks/trigger/index.ts`; bind the dispatcher through the job-runtime provider like
      every other `*_DISPATCHER`.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-self-check.service.spec.ts` (**new**) — a second
      request while running returns the same run with `reused: true` (ACC-10-03); a finished run records outcome,
      reason code and duration per item, policy revision and controller version, and items still pending at 15 min are
      `error` (ACC-10-02); a failed control keeps the gate not green (ACC-10-04);
      `packages/agent/src/tasks/__tests__/apps-tier-dispatchers.spec.ts` (**new**) — the dispatcher is registered and
      the schedule starts a run with trigger `schedule` and no actor (ACC-10-07).
      **Done when**: `packages/agent/src/tasks/tasks.spec.ts` passes without a magic-number edit; the 15-minute
      budget on a real zone is recorded in `apw10-p1-ship-gate` (T22, ACC-10-02 manual half).

- [ ] **T17. Quarantine service.**
      **Create** `packages/agent/src/apps-tier/apps-tier-quarantine.service.ts` (**new**) — request (row then
      synchronous `setDesiredState`, `202` semantics), release, pause-all (batch id), release-paused (only
      that batch), mirror of zone timestamps and detector quarantines; Activity with owner-safe category.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append one member
      `APP_TIER = 'app_tier'` (Resolution R-2); every tier row uses it with `action` `app.tier.quarantined`,
      `app.tier.released`, `app.tier.deploy_refused`, `app.tier.egress_threshold` or `app.tier.usage_daily`.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-quarantine.service.spec.ts` (**new**) — the rows of
      [plan §10.1](./plan.md): `setDesiredState` is awaited before the method resolves and no job is dispatched
      (ACC-10-34); a second request on an active quarantine → `APPS_TIER_QUARANTINE_ACTIVE`; release restores
      (ACC-10-33); **Pause all** creates one batch, **Release all paused** releases only that batch and leaves abuse
      quarantines (ACC-10-36); Activity rows carry `actionType: 'app_tier'`, the category and never the operator's
      reason, and no owner-callable method releases (ACC-10-37); timings mirrored from zone status (ACC-10-32).
      **Done when**: the spec passes; `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` passes with the
      one new member.

- [ ] **T18. Gate watch task.**
      **Create** `packages/agent/src/apps-tier/gate/apps-tier-gate-watch.service.ts` (**new**) — `recordTransitions()`,
      attestation notices, stuck `requested` quarantines re-patched, `running` runs older than 20 min marked `error`,
      operator email on every automatic close; each step in its own try/catch.
      **Create** `packages/tasks/src/tasks/trigger/apps-tier-gate-watch.task.ts` (**new**, cron `*/5 * * * *`,
      4 min budget) calling it; **modify** `packages/tasks/src/tasks/trigger/index.ts`.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-gate-watch.service.spec.ts` (**new**) — an open tier
      with a red scheduled run is closed by one tick and a later green run does not reopen it (ACC-10-22); a heartbeat
      silent 3 minutes closes it with `CONTROLLER_STALE` (ACC-10-19); one failing step does not abort the others;
      `packages/tasks/src/__tests__/apps-tier-tasks.task.spec.ts` (**new**) — ids, crons, budgets and retries of the
      four tier tasks.
      **Done when**: both specs pass and `pnpm --filter @ever-works/trigger-tasks build` lists the task.

## P1.4 — API and operator UI

- [ ] **T19. Operator API.**
      **Create** `apps/api/src/apps-tier/guards/apps-tier-admin.guard.ts`,
      `apps/api/src/apps-tier/apps-tier-admin.controller.ts`, `apps/api/src/apps-tier/dto/apps-tier-admin.dto.ts`,
      `apps/api/src/apps-tier/apps-tier.module.ts` (**new**) — P1 routes of [plan §6.1](./plan.md) (status,
      self-checks, attestations, open/close, state events, works, quarantine, release, pause-all,
      release-paused); **modify** `apps/api/src/api.module.ts` to import the module.
      **Test**: `apps/api/src/apps-tier/apps-tier-admin.controller.spec.ts` (**new**) — table-driven `404` for a
      non-admin on every route in the controller's route list (ACC-10-45); throttle metadata (self-check 6/hour,
      quarantine 60/min); `409 APPS_TIER_OPEN_REFUSED` with every reason (ACC-10-20); `400 CONFIRMATION_MISMATCH`
      unless `confirm` is exactly `PAUSE ALL` (ACC-10-36); every other error code of [plan §6.3](./plan.md).
      **Done when**: `cd apps/api && pnpm test -- apps-tier-admin` is green and the route table in the spec is built
      from the controller's metadata, so a route added later without a 404 case fails it.

- [ ] **T20. Operator pages.**
      **Create** `apps/web/src/app/[locale]/(dashboard)/admin/apps-tier/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/admin/apps-tier/self-checks/[runId]/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/admin/apps-tier/works/page.tsx`, and in
      `apps/web/src/components/admin/apps-tier/` `GateBoard.tsx`, `GateItemRow.tsx`, `OpenTierDialog.tsx`,
      `AttestDialog.tsx`, `SelfCheckRunDetail.tsx`, `TierWorksTable.tsx`, `QuarantineDialog.tsx`, `PauseAllDialog.tsx`;
      `apps/web/src/lib/api/admin-apps-tier.ts`, `apps/web/src/app/actions/admin/apps-tier.ts` (**new**), following
      `apps/web/src/app/[locale]/(dashboard)/admin/usage/page.tsx` (`notFound()` on error). Copy exactly spec
      §6.1–6.2; polling 10 s during a run or quarantine, otherwise 60 s.
      **Test**: `apps/web/src/components/admin/apps-tier/GateBoard.unit.spec.tsx` (25 rows with kind and phase,
      ACC-10-01), `OpenTierDialog.unit.spec.tsx` (every refusal reason rendered), `QuarantineDialog.unit.spec.tsx`,
      `PauseAllDialog.unit.spec.tsx` (button disabled until `PAUSE ALL` typed, ACC-10-36) (**new**);
      `apps/web/e2e/admin-apps-tier-gate.spec.ts` and `apps/web/e2e/admin-apps-tier-quarantine.spec.ts` (**new**) with a
      mocked API; run `pnpm --filter ever-works-web test:e2e admin-apps-tier`.
      **Done when**: both e2e specs pass and a non-admin visiting `/admin/apps-tier` gets the not-found page.

- [ ] **T21. i18n (P1 keys).**
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files in `apps/web/messages/` —
      `admin.appsTier.board.*`, `admin.appsTier.items.lg01Title`…`lg25Title` (`lg18Title` = "Tenant quarantine
      drill", Resolution R-20), `admin.appsTier.outcomes.*`, `admin.appsTier.reasons.*`,
      `admin.appsTier.quarantine.*`. Leaf keys camelCase, no literal dot. No value says "kill switch", "stop flag" or
      "Pause everything" — those name the platform stop flag and the AW-24 workspace pause (plan §1.3).
      **Test**: `apps/web/src/components/admin/apps-tier/apps-tier-messages.unit.spec.ts` (**new**) — iterates every
      reason code exported by T1 and finds a message key for it in all 21 locale files; asserts `lg18Title` in
      `en.json` equals "Tenant quarantine drill" and that no `admin.appsTier` value in any locale matches
      `/kill switch|stop flag|pause everything/i`.
      **Done when**: the spec passes and `pnpm --filter ever-works-web build` reports no missing message.

- [ ] **T22. P1 ship gate.** _(operator attestation)_
      Root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`; controller image
      published; **with a staging zone provided by the private operations plan**: run a self-check and a tenant
      quarantine drill on canaries; run the weakened-zone drills; record evidence in the private repository only.
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-10 P1 row (status and the gate run id, no zone detail).
      **Test**: the automated self-check run (`apps-tier-self-check`, trigger `manual`) whose run id is cited by the
      private artefacts `apw10-p1-ship-gate` (ACC-10-01…07), `apw10-quarantine-drill` (ACC-10-32…34, ten consecutive
      drills) and `apw10-weakened-zone-drill` (ACC-10-05, 06, 08…19).
      **Done when**: ACC-10-01…07 and ACC-10-32…37 pass on stage, the weakened-zone artefact shows each of ACC-10-08…19
      turning its item **Failed**, and the tier is still **Closed**.

---

# Phase P2 — Open for verified Blueprints (Wave 2)

_Delivers spec FR-30…FR-40, FR-47…FR-51. Coordinated with APW-06 P2 (T44–T50), APW-07 P2 and APW-03._

- [ ] **T23. Promotion: copy, scan, sign; allowances.**
      **Create** `apps/hosting-operator/src/promote/promotion-job.ts` (**new**) — one Job per new digest
      (tools named in zone config), `status.promotion[]` with `{ critical, criticalFixable, high }`, refuse on
      `criticalFixable > 0` unless an allowance annotation for that digest is present and unexpired; single-use
      pull credential ≤ 15 min.
      **Create** `packages/agent/src/apps-tier/apps-tier-image-allowance.service.ts` (**new**, FR-31).
      **Modify** `apps/api/src/apps-tier/apps-tier-admin.controller.ts` — `POST image-allowances` (≤ 30 days);
      **modify** `packages/plugins/ever-works-apps/src/control-client.ts` to project allowances onto the `Work`.
      **Test**: `apps/hosting-operator/src/promote/__tests__/promotion-job.spec.ts` (**new**) — refusal
      `IMAGE_SCAN_BLOCKED` at `criticalFixable = 1`, pass at 0, pass with an unexpired allowance for that digest,
      refusal again once it expired (ACC-10-30); `packages/agent/src/apps-tier/__tests__/apps-tier-image-allowance.service.spec.ts`
      (**new**) — 30 days accepted, 31 refused, reason recorded (ACC-10-30); extend
      `apps/api/src/apps-tier/apps-tier-admin.controller.spec.ts` with the new route in the 404 table (ACC-10-45) and
      extend `packages/plugins/ever-works-apps/src/__tests__/control-client.spec.ts` with the projection.
      **Done when**: the four specs pass and an expired allowance is never projected.

- [ ] **T24 (parallel with T23). `edge-hostnames` capability.**
      **Create** `packages/plugin/src/contracts/capabilities/edge-hostnames.interface.ts` (**new**) per
      [plan §5.6](./plan.md); **modify** `packages/plugin/src/contracts/capabilities/index.ts` and
      `packages/plugin/src/contracts/facade-capabilities.ts` (`EDGE_HOSTNAMES: 'edge-hostnames'`); **modify**
      `packages/plugins/cloudflare-dns/package.json` (add capability `edge-hostnames`) and add
      `packages/plugins/cloudflare-dns/src/edge-hostnames.provider.ts` (**new**) with its own operator credential
      setting (`x-secret`), separate from the platform zone token.
      **Create** `packages/agent/src/facades/edge-hostnames.facade.ts` (**new**); **modify**
      `packages/agent/src/facades/facades.module.ts` and `packages/agent/src/facades/index.ts`.
      **Test**: `packages/plugins/cloudflare-dns/src/__tests__/edge-hostnames.provider.spec.ts` (**new**) — fake HTTP
      client: status mapping, idempotent delete, token never logged; `packages/agent/src/facades/__tests__/edge-hostnames.facade.spec.ts`
      (**new**) — a host is handed to `Work.spec.hosts[]` only when `status` and `certificateStatus` are both `active`
      (ACC-10-31; the duplicate-host half is T5's `HOST_CLAIMED`, the live half is ACC-E2E-10 (b)).
      **Done when**: `packages/plugins/cloudflare-dns/src/__tests__/cloudflare-dns.plugin.spec.ts` passes unchanged and
      no plugin id string appears in the facade.

- [ ] **T25. Quota profiles.**
      **Create** `packages/agent/src/entities/apps-tier-quota-profile.entity.ts`,
      `packages/agent/src/entities/apps-tier-usage-window.entity.ts` (**new**; register both in
      `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`) and
      `apps/api/src/migrations/1792100200000-CreateAppsTierQuotaAndMetering.ts` (**new**; seeds `starter` and
      `standard` exactly as spec FR-47; adds `works.appsTierQuotaProfile`).
      **Create** `packages/agent/src/apps-tier/apps-tier-quota-profile.service.ts` (**new**; ceilings 16 CPU, 32
      GiB, 100 pods, 500 GiB); routes `GET/PUT quota-profiles`, `PUT works/:workId/quota-profile` in
      `apps/api/src/apps-tier/apps-tier-admin.controller.ts`; page
      `apps/web/src/app/[locale]/(dashboard)/admin/apps-tier/quota-profiles/page.tsx` and
      `apps/web/src/components/admin/apps-tier/QuotaProfileEditor.tsx`, `ImageAllowanceDialog.tsx` (**new**).
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-quota-profile.service.spec.ts` (**new**) —
      `QUOTA_CEILING_EXCEEDED` at 16.1 CPU, 32.1 GiB, 101 pods and 501 GiB; accepted at each ceiling (ACC-10-41);
      `apps/api/src/migrations/__tests__/CreateAppsTierQuotaAndMetering.spec.ts` (**new**) — seeded values equal FR-47
      (ACC-10-41); extend `apps-tier-admin.controller.spec.ts` (`422` body and the new routes in the 404 table,
      ACC-10-45); `apps/web/src/components/admin/apps-tier/QuotaProfileEditor.unit.spec.tsx` (**new**) — the save
      button shows the ceiling error.
      **Done when**: the specs pass and T4's quota golden files still equal the seeded profiles.

- [ ] **T26. Desired-state mapper and App additions.**
      **Create** `packages/plugins/ever-works-apps/src/desired-state.mapper.ts` (**new**); **modify**
      `packages/plugins/ever-works-apps/src/apps-tier.provider.ts` to implement `applyWork`, `getWork`,
      `setEgressThrottle`, **`setDependencies` / `releaseDependencies` / `getDependencies` (T45)** and APW-06's
      `IDeploymentPlugin` App additions (`supportsApps`, `deployApp`, `getAppStatus`, `runAppJob`,
      `scaleApp` → `desiredState: paused` with `pausedReplicas`, `getAppLogs` → `pods/log` through the platform Role,
      `checkAppCluster` → `zoneInfo()`, `prepareAppNamespace` / `publishAppHosts` → no-ops returning the zone's observed
      values, `destroyApp` → `removeWork({ deleteData: deleteVolumes })`). The plugin writes the
      `Work` desired-state object only (Resolution R-5). The managed behaviour of every member is the table in plan
      §5.2; leaving one out makes the tier a second-class target (added, APW10-G04).
      **Test**: `packages/plugins/ever-works-apps/src/__tests__/desired-state.mapper.spec.ts` (**new**) — every §3.1
      limit (ACC-10-27), non-digest image refused before any network call, unknown render-input fields dropped,
      generation monotonic, **smoke checks and `cron[].http.authScheme` and job `when` carried through (ACC-10-53)**;
      `src/__tests__/apps-tier.provider.status.spec.ts` (**new**) — a `Quarantined` phase with
      `observedGeneration < generation` maps to a cancelled result with reason `quarantined` (ACC-10-35 plugin half),
      **each refusal code of plan §3.1 maps to the APW-06 outcome in the plan's mapping table**, `scaleApp('pause')`
      writes `desiredState: paused` with the recorded counts and `scaleApp('resume')` reverses it, `getAppLogs` reads
      `pods/log` and answers `logs_unavailable_on_tier` on a temporary refusal, and
      `destroyApp` passes `deleteVolumes` through unchanged; the fake API sees no write outside `works`.
      **Done when**: both specs pass and APW-06's deploy job, run against the plugin with a fake zone, records a
      Deployment whose state reads **Cancelled — quarantined** (cross-epic check with APW-06).

- [ ] **T27. `AppsTierPolicy` implementation and eligibility.** _(Resolution R-5 — this epic owns the policy)_
      **Create** `packages/agent/src/apps-tier/apps-tier-policy.impl.ts`,
      `packages/agent/src/apps-tier/apps-tier-eligibility.service.ts` (**new**) per [plan §5.5](./plan.md) and
      spec FR-35 (`User.emailVerified`, `SubscriptionService.getActiveSubscription` in
      `packages/agent/src/subscriptions/subscription.service.ts`, no active abuse/security quarantine, per-person
      cap). `isOpen()` is the method consumers call; `isManagedEnabled()` is an alias defined only on this implementation
      (not on APW-06's port) that returns `isOpen()` and that no consumer calls; `resolveClusterCredential()` returns the control-namespace credential.
      **Modify** `packages/agent/src/app-runtime/ports.ts` (created by APW-06) only if it lacks `isOpen()` or
      `eligibility(userId)` — add them to `AppsTierPolicy` and to its disabled default (additive).
      **Cross-epic PR (with APW-06 T44):** bind `APPS_TIER_POLICY` to this implementation; APW-06
      preconditions call `isOpen()` and `eligibility(userId)`; APW-06's facade hands the render input to the
      `apps-tier`-capable plugin for target **Ever Works Apps**.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-policy.impl.spec.ts` (**new**) — with the env ceiling
      `true` and the tier **Closed**, `isOpen()` is `false` and deployment admission is refused while an already-`Ready`
      `Work` receives no desired-state write (ACC-10-24); the alias `isManagedEnabled() === isOpen()` in every state;
      `apps-tier-eligibility.service.spec.ts` (**new**) — each FR-35 condition alone yields its own reason code, in
      order (ACC-10-38); APW-13's `apps/web/e2e/sec-pin-app-works-managed-gate.spec.ts` (ACC-NEG-03) passes with the
      tier **Closed** and the env ceiling **on**.
      **Done when**: no file outside `packages/agent/src/apps-tier/` and `packages/agent/src/config/` reads
      `EVER_WORKS_APPS_MANAGED_ENABLED` (grep asserted in `apps-tier-policy.impl.spec.ts`).

- [ ] **T28. Usage, metering import, receipts.**
      **Create** `apps/hosting-operator/src/usage/usage-reporter.ts` (**new**, hourly `UsageReport`s,
      canaries excluded).
      **Create** `packages/agent/src/apps-tier/apps-tier-metering.service.ts` (**new**);
      `packages/tasks/src/tasks/trigger/apps-tier-metering-import.task.ts` (cron `7 * * * *`) and
      `packages/tasks/src/tasks/trigger/apps-tier-daily-receipts.task.ts` (cron `15 0 * * *`) (**new**); **modify**
      `packages/tasks/src/tasks/trigger/index.ts`.
      **Modify** `packages/agent/src/entities/plugin-usage-event.entity.ts` — `PluginUsageCapability.HOSTING =
'hosting'`; `packages/agent/src/usage/credit-price-list.ts` — the five `hosting.*` price keys at 0.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-metering.service.spec.ts` (**new**) — importing the
      same hour twice creates no duplicate usage row or `PluginUsageEvent` (ACC-10-42); one daily receipt per App Work
      with non-zero CPU, with quantities and no host (ACC-10-43); 80 % notification and 100 % `egressThrottle` fire
      once per month (ACC-10-44); `apps/hosting-operator/src/usage/__tests__/usage-reporter.spec.ts` (**new**) —
      hourly windows, canaries excluded (FR-10); extend `packages/tasks/src/__tests__/apps-tier-tasks.task.spec.ts`
      with the two crons.
      **Done when**: the specs pass and a price list without hosting prices still produces a receipt with 0 credits.

- [ ] **T29. Abuse signals and detector quarantine.**
      **Create** `apps/hosting-operator/src/signals/signal-rules.ts` (**new**) — FR-38 heuristics, runtime
      sensor intake adapter (sensor named in zone config), detector quarantine ≤ 60 s.
      **Create** `packages/agent/src/apps-tier/apps-tier-signals.service.ts` (**new**); routes `GET signals`,
      `POST signals/:id/dismiss|quarantine`, `POST works/:workId/reports` in
      `apps/api/src/apps-tier/apps-tier-admin.controller.ts`; page
      `apps/web/src/app/[locale]/(dashboard)/admin/apps-tier/signals/page.tsx` and
      `apps/web/src/components/admin/apps-tier/SignalsTable.tsx` (**new**); T18's watch service imports signals.
      **Test**: `apps/hosting-operator/src/signals/__tests__/signal-rules.spec.ts` (**new**) — boundary values
      89/90 %, 29/30 min, 9/10 attempts; a sustained 90 % CPU for 30 min with 10 refused mining-port attempts raises
      **High** and requests a detector quarantine in the same reconcile (ACC-10-39); 49 refused mail-port attempts raise
      nothing and 50 raise **Medium** with no quarantine (ACC-10-40);
      `packages/agent/src/apps-tier/__tests__/apps-tier-signals.service.spec.ts` (**new**) — dedupe by `zoneName`,
      detector quarantine mirrored within one watch tick, `test: true` never quarantines a non-canary Work; extend
      `apps-tier-admin.controller.spec.ts` (new routes in the 404 table, ACC-10-45);
      `apps/web/src/components/admin/apps-tier/SignalsTable.unit.spec.tsx` (**new**).
      **Done when**: the specs pass and no signal summary longer than 500 characters is stored.

- [ ] **T30. Owner routes, banner, eligibility copy.**
      **Create** `apps/api/src/apps-tier/apps-tier-user.controller.ts` (**new**) — `GET api/me/apps-tier`,
      `GET api/works/:id/apps-tier` per [plan §6.2](./plan.md) (`abuse`/`security`/`legal` → `review`).
      **Create** `apps/web/src/components/works/detail/deploy/AppsTierQuarantineBanner.tsx`,
      `apps/web/src/lib/api/apps-tier.ts` (**new**); mount the banner in APW-06's App deploy page.
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — `dashboard.appsTier.eligibility.*`,
      `dashboard.workDetail.appsTier.*`, remaining `admin.appsTier.*` keys (spec §6.3 copy).
      **Test**: `apps/api/src/apps-tier/apps-tier-user.controller.spec.ts` (**new**) — reasons never contain an operator
      reason code; `abuse` maps to `review` (ACC-10-37); another account's Work → `404` (ACC-NEG-13);
      `apps/web/src/components/works/detail/deploy/AppsTierQuarantineBanner.unit.spec.tsx` (**new**) — both banner
      variants, no operator reason shown, no release control (ACC-10-37).
      **Done when**: both specs pass and T21's messages spec still passes with the new keys.

- [ ] **T31. APW-03 availability wiring.** _(cross-epic PR with the APW-03 owner, Resolution R-5)_
      **Modify** `packages/agent/src/apps-catalog/apps-catalog.mapper.ts` (created by APW-03 T23) — make
      `managedHostingAvailability` read `AppsTierPolicy.isOpen()` and `managedScope()`; the env var alone becomes the
      ceiling only.
      **Test**: extend `packages/agent/src/apps-catalog/__tests__/apps-catalog.mapper.spec.ts` — with the env var
      `true` and the tier **Closed**, availability reports `managedTierDisabled`; with the tier open for
      `verified-blueprints`, an unverified entry reports `blueprintNotVerified`.
      **Done when**: `apps-catalog.mapper.ts` no longer reads `EVER_WORKS_APPS_MANAGED_ENABLED`.

- [ ] **T32. P2 ship gate.** _(operator attestation)_
      On stage with the zone from the private operations plan: all P2 attestations recorded; a green
      self-check; **open for verified Blueprints**; walk ACC-10-01…ACC-10-48 except ACC-10-25 (weakened-zone
      drills ACC-10-08…19 run against the staging copy per the private runbook); ACCEPTANCE.md ACC-E2E-10 (b)
      and ACC-NEG-03 green.
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — the APW-10 rows (public-safe wording, sent to the program
      owner of that file) and `docs/specs/features/app-works/TRACKER.md` — APW-10 P2 row.
      **Test**: the green `apps-tier-self-check` run the open action cites; private artefacts `apw10-p2-ship-gate`,
      `apw10-attestations`, `apw10-weakened-zone-drill` and `apw10-hygiene-drill` (ACC-10-46).
      **Done when**: the owner approves opening production (spec §9 open questions on location, apex domain and prices
      answered).

---

# Phase P3 — Open for all App Works (Wave 3)

_Sandboxed in-zone builds (LG-24) and build limits (LG-25) — Resolution R-24._

- [ ] **T33. `AppBuild` reconcile.**
      **Create** `apps/hosting-operator/src/reconcile/appbuild.reconciler.ts` (**new**) — one sandboxed
      build workload per `AppBuild` on build-dedicated capacity, allow-listed egress, caps, push only to
      `t-<id>`, workload deleted ≤ 10 minutes after completion, status fields APW-05 expects (`scanSummary`,
      `signatureState`, `blockedEgressHosts`).
      **Modify** `packages/plugins/ever-works-apps/src/apps-tier.provider.ts` — `submitBuild`, `getBuild`.
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/appbuild.reconciler.spec.ts` (**new**) — a 60 s cap
      on a 120 s fixture terminates the build at 60 s and records it as cap-exceeded in status; cross-tenant push
      refused; the build pod carries the sandbox runtime class; extend `packages/plugins/ever-works-apps/src/__tests__/apps-tier.provider.status.spec.ts`
      with `getBuild` status mapping.
      **Done when**: both specs pass and a finished build workload is gone within 10 minutes on the fake clock.

- [ ] **T34. Probes LG-24, LG-25.**
      **Modify** `apps/hosting-operator/src/reconcile/selfcheck.reconciler.ts` and
      `packages/agent/src/apps-tier/gate/launch-gate.registry.ts` scope logic so `any` requires them.
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/selfcheck.reconciler.p3.spec.ts` (**new**) —
      `BUILD_UNSANDBOXED`, `BUILD_EGRESS_OPEN`, `BUILD_PUSH_CROSS_TENANT`, `BUILD_CAP_NOT_ENFORCED`; extend
      `packages/agent/src/apps-tier/__tests__/apps-tier-state.open.spec.ts` — a run missing LG-24 cannot open scope
      `any` (ACC-10-25).
      **Done when**: both specs pass.

- [ ] **T35. Scope `any`.**
      **Cross-epic PRs:** **Modify** `packages/agent/src/facades/build.facade.ts` (created by APW-05; **its T16** — this
      file used to cite its own T35 here) so `apps-builder`
      resolves on `isOpen() && managedScope() === 'any'`; **modify** `packages/agent/src/apps-catalog/apps-catalog.mapper.ts`
      (APW-03) so the verified-only rule derives from `managedScope()`; APW-06 T51.
      Set `EVER_WORKS_APPS_MAX_SCOPE=any` on stage only (operator configuration, not a repository file).
      **Test**: extend `packages/agent/src/apps-tier/__tests__/apps-tier-policy.impl.spec.ts` — `managedScope()` is
      `any` only when the last open event is `open-any` and `EVER_WORKS_APPS_MAX_SCOPE=any`; stage evidence in
      `apw10-p3-ship-gate`.
      **Done when**: a provisioned (non-Blueprint) App Work deploys on stage with scope `any` and is refused
      with scope `verified-blueprints`.

- [ ] **T36. P3 ship gate.** _(operator attestation)_
      ACC-10-25 plus a full re-walk of ACC-10-01…48 on stage.
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-10 P3 row.
      **Test**: the green `apps-tier-self-check` run covering LG-24 and LG-25; private artefact `apw10-p3-ship-gate`.
      **Done when**: the tier is opened **for all App Works** on stage by an operator action citing that run.

---

# Closing tasks

- [ ] **T37. Program documents.**
      **Modify** `docs/specs/features/app-works/README.md` §1 — confirm the **Launch gate** and **Quarantine** rows
      (already present) and add **Self-check**, **Attestation**, **Quota profile**, **Abuse signal** (spec §5.2);
      confirm the CONTRACTS.md rows named in the plan header match merged code.
      **Create** `docs/features/ever-works-apps.md` (**new**) — owner-facing: eligibility, limits, quarantine
      and receipts; no infrastructure detail. **Modify** `apps/docs/sidebarsPlatform.ts`.
      **Test**: run `pnpm --filter ever-works-docs build`.
      **Done when**: the docs build has no broken link and `docs/features/ever-works-apps.md` contains no address, host
      or vendor account name.

- [ ] **T38. Statuses.**
      **Modify** `docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md`, `plan.md` and `spec.md` — `Status` to
      `Implemented`; confirm every item in [plan §12](./plan.md).
      **Test**: `grep -n "Status" docs/specs/features/app-works/APW-10-apps-hosting-tier/*.md` shows `Implemented` on all
      three.
      **Done when**: TRACKER.md shows APW-10 implemented and plan §12 has no unticked item.

- [ ] **T39. Delete semantics on the tier (Resolution R-15).**
      **Create** `apps/hosting-operator/src/reconcile/removal.reconciler.ts` (**new**) per [plan §2.6](./plan.md):
      isolate; delete Deployments, StatefulSets (PVCs retained), Services, Ingresses, Jobs, CronJobs, NetworkPolicies
      other than `default-deny` and `quarantine`, and the env Secret; drop hosts; label `retained-until`; phase
      `Removed`; only with `spec.dataDeletion` **and** every `status.dependencies[]` `released`, delete PVCs then the
      namespace and set `status.removal.dataDeletedAt`.
      **Modify** `packages/plugins/ever-works-apps/src/apps-tier.provider.ts` — `removeWork(workId, { deleteData })`
      sets `desiredState: removed` and, only when `deleteData`, `dataDeletion`; **and, added by APW10-G01, calls
      `releaseDependencies(workId, { deleteData })` and waits for every `status.dependencies[]` entry to report
      `released` before `dataDeletion` is written** — otherwise nothing ever sets the phase this reconciler waits for
      and ACC-10-47 can never pass.
      **Test**: `apps/hosting-operator/src/reconcile/__tests__/removal.reconciler.spec.ts` (**new**) — after removal
      the fake API holds no Deployment, Service, Ingress, Job, CronJob or env Secret for the Work and still holds its
      PVCs (ACC-10-29, ACC-10-47); with `dataDeletion` but one dependency not `released`, zero PVC deletes; once all are
      `released`, PVCs are deleted before the namespace (ACC-10-47); without `dataDeletion` no PVC or namespace delete
      is ever issued; extend `packages/plugins/ever-works-apps/src/__tests__/apps-tier.provider.status.spec.ts` —
      `destroyApp({ deleteVolumes: false })` writes no `dataDeletion`.
      **Done when**: both specs pass and a repository-wide search finds no PVC delete call outside
      `removal.reconciler.ts`.

- [ ] **T40. Stop-flag independence (Resolution R-20).**
      **Create** `packages/agent/src/apps-tier/__tests__/apps-tier-stop-independence.spec.ts` (**new**) — no code
      change unless it fails.
      **Test**: that spec — (1) statically, no file under `packages/agent/src/apps-tier/` imports
      `packages/agent/src/agents/run-kill-switch.ts`, `agent-brake.service.ts` or
      `packages/agent/src/safety/workspace-pause.service.ts`, and none of those three imports `apps-tier`; (2) with a
      fake plugin, setting the platform stop flag, braking an Agent and pausing a workspace issue zero
      `setDesiredState` calls and write zero `apps_tier_quarantines` rows while a tier App Work stays `Ready`
      (ACC-10-48); run `pnpm --filter @ever-works/agent test -- apps-tier-stop-independence`.
      **Done when**: the spec passes on `develop`.

- [ ] **T41. Redaction guard (FR-53).**
      **Create** `packages/agent/src/apps-tier/__tests__/apps-tier-redaction.spec.ts` (**new**).
      **Test**: that spec — plants a sentinel env value, sealed payload, control credential and probe address, runs
      self-check merge, quarantine, signals import, metering and receipts through fakes, and asserts none of the
      sentinels appears in any logger call, Activity metadata, controller response body or telemetry payload
      (ACC-10-46 automated half); the full-drill scan is the private artefact `apw10-hygiene-drill` (T32).
      **Done when**: the spec passes and removing one redaction in a service makes it fail.

- [ ] **T42 (lands with T13 and T25). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — `BACKUP_DROPPED_ENTITIES` gains
      `AppsTierGateRun`, `AppsTierAttestation`, `AppsTierStateEvent`, `AppsTierQuotaProfile`, `AppsTierQuarantine`,
      `AppsTierAbuseSignal` and `AppsTierImageAllowance`, under one comment giving the reason: operator launch-gate,
      moderation and quota state that is not stored on a workspace's behalf (detector rules, operator reasons and
      operator ids never reach a tenant); the quarantine an owner sees already travels as the Deployment's cancelled
      state in `works/deployments.jsonl`.
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `runs` domain,
      beside `plugin-usage-events.jsonl`:
      `{ file: 'apps-tier-usage-windows.jsonl', entity: 'AppsTierUsageWindow', scope: { by: 'parent', column: 'workId', from: 'workIds' }, trim: 'pluginUsageEvents' }`
      — metering is a record, not restorable state, and still reached through the parent Work ids. The tier's credential
      fingerprints live only in a zone Secret ([plan §3.6](./plan.md)), never in a platform table, so there is no row to
      drop; `Work.appsTierQuotaProfile` rides `works/works.jsonl`.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — the seven operator
      entities are in `BACKUP_DROPPED_ENTITIES` and referenced by no domain; `AppsTierUsageWindow` is referenced exactly
      once, in `runs`, scoped `parent` on `workId` from `workIds`, with the `pluginUsageEvents` trim.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      with a tier App Work lists `data/runs/apps-tier-usage-windows.jsonl` and no `apps_tier_*` operator row.

---

## Fix-pass additions (added 2026-09-17)

_Closes APW10-G01 and GAP-22 (blockers), APW10-G02…G08 and GAP-25. T43–T46 are **P2** and pair with APW-07's T36/T37;
T47, T48 and T52 land with the P1 tasks they modify; T49–T51 are P2._

- [ ] **T43 (P2). In-zone dependency reconciler (APW10-G01, GAP-22).**
      **Create** `apps/hosting-operator/src/dependencies/dependency.reconciler.ts` (**new**) — reads
      `Work.spec.dependencies[]`, and for each kind: creates the tenant database with
      `buildTenantPostgresDdl(input)` from `packages/contracts/src/apps/tenant-postgres-ddl.ts` on the data server named
      in the new zone Secret (plan §3.6), creates the App Work's own Redis instance, creates its prefixed buckets with a
      user limited to `aw-<hex12>-*` and the 10 GiB quota, and obtains the mail credential from the relay's credential
      API (T46). Writes `status.dependencies[]` with `phase` ∈ `pending|ready|failed|released`, `lastBackupAt` and a
      `detail` that names a reason and never a value, and schedules a backup at most every 24 hours.
      **Modify** `src/reconcile/work.reconciler.ts` (T6) to run it before reporting a tenant phase, and
      `src/reconcile/removal.reconciler.ts` (T39) to release rather than delete unless `spec.dataDeletion` is set.
      **Test**: `apps/hosting-operator/src/dependencies/__tests__/dependency.reconciler.spec.ts` (**new**) — each
      kind reaches `ready` with a fresh `lastBackupAt`; an unreachable data server yields `failed` with a reason and no
      value; an unknown kind is refused; a release sets `released` without deleting data and a delete happens only
      afterwards (ACC-10-49, ACC-10-51). The live properties (another App Work's role refused, 21st connection refused,
      70-second statement cancelled at 60 s, bucket prefix, quota) are LG-14's, extended by T45.
      **Done when**: the spec passes, APW-07's T36 reads a real `Work.status.dependencies[]`, and ACC-E2E-10 (b)'s
      dependency cards are green.

- [ ] **T44 (P2). Dependency token substitution (APW10-G01).**
      **Create** `apps/hosting-operator/src/seal/dep-token-substitution.ts` (**new**) — after unsealing and before
      the tenant env Secret is written, replaces every `ew-dep://<kind>/<output>` token with the value T43 resolved, and
      refuses an unknown token or an unresolved kind with the new refusal code `DEPENDENCY_TOKEN_UNKNOWN`.
      **Modify** `src/seal/unseal.ts` (call it) and `src/crds/work.ts` (the code).
      **Test**: `apps/hosting-operator/src/seal/__tests__/dep-token-substitution.spec.ts` (**new**) — a known token
      is replaced in a plain value and inside a template; an unknown token, an unknown kind and a missing output each
      refuse the `Work` with `DEPENDENCY_TOKEN_UNKNOWN`; **no placeholder ever reaches the rendered env Secret** — the
      assertion is on the applied Secret's bytes, not on the intermediate string (ACC-10-49, FR-55).
      **Done when**: the spec passes and a repository-wide search finds no code path that writes the env Secret before
      substitution.

- [ ] **T45 (P2). `IAppsTierProvider` dependency methods and the extended LG-14 probe (APW10-G01).**
      **Modify** `packages/plugin/src/contracts/capabilities/apps-tier.interface.ts` — add `setDependencies`,
      `releaseDependencies` and `getDependencies` exactly as plan §5.1; **modify**
      `packages/plugins/ever-works-apps/src/apps-tier.provider.ts` (T26) to implement them by patching only
      `spec.dependencies` on the `Work` (never the whole object — that would restart the app's workloads for a
      dependency change).
      **Modify** `apps/hosting-operator/src/reconcile/selfcheck.reconciler.ts` and the LG-14 row of plan §3.7 — the
      probe additionally asserts, on the canary's own database, that a 21st connection is refused
      (`CONNECTION_LIMIT_NOT_ENFORCED`) and that a 70-second statement is cancelled at 60 s
      (`STATEMENT_TIMEOUT_NOT_ENFORCED`), because APW-07 relies on this probe for ACC-07-26.
      **Test**: `packages/plugins/ever-works-apps/src/__tests__/apps-tier.provider.dependencies.spec.ts` (**new**) — the
      fake API sees exactly one patch to `spec.dependencies`, the `Work`'s `spec.generation` and every other field are
      untouched, and `releaseDependencies` waits for `released`; extend
      `apps/hosting-operator/src/reconcile/__tests__/selfcheck.reconciler.spec.ts` with both new LG-14 reasons.
      **Done when**: both specs pass and the live LG-14 run on stage records the two new outcomes.

- [ ] **T46 (P2). Managed mail on the tier (GAP-22).**
      **Modify** `apps/hosting-operator/src/dependencies/dependency.reconciler.ts` (T43) and `src/crds/work.ts` —
      `smtp` joins `Work.spec.dependencies`, and its credential comes from the relay's credential API named in the zone
      Secret (`smtpRelay.credentialApiUrl`, `adminSecretRef`), never from a tenant-reachable mail port.
      **Modify** `packages/plugins/apps-tier-dependencies/src/managed-smtp.provider.ts` (APW-07 T36) — the platform side
      writes `{ kind: 'smtp', ref: 'dep-smtp' }` and reports readiness from `status.dependencies[]`. **LG-08 is
      unchanged**: ports 25, 465 and 587 remain blocked, and the relay is reached over its own HTTPS endpoint.
      **Test**: extend `dependency.reconciler.spec.ts` — declaring `smtp` yields a `ready` dependency whose outputs carry
      the relay endpoint, credential and from-address, and a credential-API refusal yields `failed` with a reason;
      extend `packages/plugins/hosting-operator/src/template/__tests__/tenant-template.spec.ts` — the egress policy
      still omits 25/465/587 while the relay endpoint is reachable on 443 (ACC-10-50, and ACC-07-32 on APW-07's side).
      **Done when**: the specs pass and `app-fixture-hello`'s `smtp: { required: true }` reaches `ready` on a stage
      tier, so ACC-E2E-10 (b) can pass.

- [ ] **T47 (P1, lands with T4/T6). Deployment phase order, smoke checks and status (GAP-25).**
      **Modify** `packages/hosting-crds/src/crds/work.ts` — `spec.smoke[]`, `spec.cron[].http.authScheme`,
      `status.jobs[]`, `status.smoke[]` and `status.deployPhase` exactly as plan §3.1; **modify**
      `src/reconcile/work.reconciler.ts` — the phases are **normative and ordered**: pre-deploy jobs → rollout →
      first-deploy jobs → in-cluster smoke → publish hosts at the edge → post-deploy jobs → CronJobs, each written to
      `status.deployPhase`, with `status.smoke[]` populated by the in-cluster runs and a first-deploy job never running
      after the first Deployment; **modify** `src/render/work-to-render-input.ts` and
      `packages/plugins/ever-works-apps/src/desired-state.mapper.ts` (T26) to carry all three.
      **Test**: extend `work.reconciler.spec.ts` — the phase order is asserted from the fake API call log, an
      in-cluster smoke failure stops before hosts are published, and no first-deploy job exists on a second
      Deployment; extend `packages/plugins/ever-works-apps/src/__tests__/apps-tier.provider.status.spec.ts` — APW-06's
      `hooks.onPhase` sees each `status.deployPhase` in order and `status.smoke[]` reaches its smoke result
      (ACC-10-53).
      **Done when**: both specs pass and APW-06's Deployment on the managed target shows job and smoke results.

- [ ] **T48 (P1, lands with T4/T7/T9). Quarantine isolation that blocks (APW10-G02).**
      **Modify** `src/template/tenant-template.ts` — every `allow-*` policy carries
      `podSelector.matchExpressions: [{ key: hosting.ever.works/quarantined, operator: NotIn, values: ['true'] }]`, and
      `default-deny` / `quarantine` keep selecting all pods; **modify**
      `src/reconcile/quarantine.sequencer.ts` — step (1) labels every pod template, applies `quarantine`, records
      `status.quarantine.policiesSuspended[]`, and release re-applies the template's policies and clears the label;
      **modify** `src/probe/net.ts` and the LG-18 row of plan §3.7 — the drill's canary pod, kept alive through the
      window, must observe the public control and the edge path **refused** within 15 s (`QUARANTINE_NOT_ISOLATING`).
      **Test**: extend `tenant-template.spec.ts` and `pod-overlays.spec.ts` — golden files carry the selector on every
      `allow-*` policy; extend `quarantine.sequencer.spec.ts` — the label, the policy and `policiesSuspended[]` are set
      in step (1) and cleared in reverse; extend `probe/__tests__/net.spec.ts` — a reachable public control during
      quarantine yields `QUARANTINE_NOT_ISOLATING` even when `networkIsolatedAt` is fresh (ACC-10-52). **Modify**
      T11's kind job to install a CNI that enforces NetworkPolicy and to assert egress is refused there.
      **Done when**: the specs pass and the LG-18 drill on a real zone fails when the label or the selector is removed.

- [ ] **T49 (P2). Custom hostnames on the tier (APW10-G06).**
      **Create** `packages/agent/src/entities/apps-tier-custom-hostname.entity.ts`,
      `packages/agent/src/apps-tier/apps-tier-custom-hostname.service.ts` and
      `apps/api/src/migrations/1792100300000-CreateAppsTierCustomHostnames.ts` (**new**) per plan §4; routes
      `POST /api/works/:workId/custom-hostnames`, `GET` (with the validation record and the CNAME target) and `DELETE`
      on the user controller; a `apps-tier-gate-watch` step that polls pending hostnames until both statuses are
      `active`. **Modify** `packages/plugins/ever-works-apps/src/desired-state.mapper.ts` — `customHostnameRef` reaches
      `Work.spec.hosts[]` only when the statuses are `active`.
      **Test**: `packages/agent/src/apps-tier/__tests__/apps-tier-custom-hostname.service.spec.ts` (**new**) — creation
      stores id, status and validation; a pending hostname never reaches `Work.spec.hosts[]`; the owner view carries the
      TXT record and the fallback target and **no credential**; removal deletes the edge hostname and the row.
      Extend `apps-tier-user.controller.spec.ts` (another account's Work → 404, ACC-10-31).
      **Done when**: the specs pass, the new table is classified under R-25 with the other operator tables (T42), and
      ACC-10-56 is walked.

- [ ] **T50 (P2, lands with T28). Hosting prices in the pricebook and a real debit (APW10-G07).**
      **Modify** `packages/agent/src/subscriptions/billing/credit-pricebook.ts` — a new **`VERSION_2`** with an
      `effectiveFrom` date (VERSION_1 stays frozen), carrying `hosting.*` and `relay.messages` keys in whole billing
      units; **modify** `packages/contracts/src/billing/meter.types.ts` — `hosting` joins `CREDIT_PRICE_GROUPS`;
      **modify** `packages/agent/src/apps-tier/apps-tier-metering.service.ts` — the integer conversions (core-seconds ÷
      3600, MiB-hours ÷ 1024, MiB ÷ 1024, GiB-hours ÷ 720) with the remainder carried on
      `AppsTierUsageWindow.carriedRemainder`, `PluginUsageService.record` called with `operation` **and**
      `payer: 'platform'`, and the daily receipt debiting the credit ledger once with idempotency key
      `apps-tier:<workId>:<YYYY-MM-DD>`. **Modify** `packages/tasks/.../apps-tier-daily-receipts.task.ts` accordingly.
      **Test**: `packages/agent/src/subscriptions/billing/__tests__/credit-pricebook.spec.ts` — VERSION_2 is additive,
      VERSION_1 is byte-identical, `hosting` is a valid group, and each key resolves; extend
      `apps-tier-metering.service.spec.ts` — the conversions and the carried remainder are exact, a re-run of the same
      day debits once, and a price list without hosting keys still records quantities with 0 credits
      (ACC-10-55).
      **Done when**: the specs pass and a day's receipt reconciles against the ledger's single debit.

- [ ] **T51 (P2). Credits, caps and the billing quarantine (XC-12).**
      **Modify** `packages/agent/src/apps-tier/apps-tier-eligibility.service.ts` and
      `apps-tier-metering.service.ts` — notify the owner at 80 % and 100 % of available credits, enforce an optional
      per-App-Work monthly cap, and on zero credits or a lapsed subscription quarantine the App Work with category
      **Billing** after a 7-day grace period, releasing it automatically when payment resumes; **modify**
      `apps/api/src/apps-tier/apps-tier-user.controller.ts` — the monthly cost estimate from the quota profile.
      **Test**: extend `apps-tier-metering.service.spec.ts` and `apps-tier-quarantine.service.spec.ts` — both
      notifications fire once per month, the cap refuses a scale that would exceed it, the grace period is exact, a
      Billing quarantine is released automatically and never by an owner (ACC-10-54).
      **Done when**: the specs pass and the owner banner shows the billing variant of plan §6.3.

- [ ] **T52 (P1, lands with T6/T10). P1 promotion of the canary and controller images (APW10-G08).**
      **Create** `apps/hosting-operator/canary/` (**new**) — the canary application image (HTTPS client for LG-16, a
      Postgres client for LG-14, a marker writer/reader for LG-18) built by T10's workflow — and
      `src/promote/canary-promotion.ts` (**new**) performing the copy/scan/sign of the controller's own image and the
      canary image into each canary's `t-<id>` registry space at startup. **Modify** `src/main.ts` to run it before the
      first canary reconcile, and `src/reconcile/selfcheck.reconciler.ts` to report P2-only items
      (`LG-13`'s promotion half, LG-16, LG-17, LG-20) as **`inconclusive`** with reason **`PHASE_NOT_ENABLED`** in a P1
      run.
      **Test**: `apps/hosting-operator/src/promote/__tests__/canary-promotion.spec.ts` (**new**) — both images land
      signed in each canary's space, admission then admits the canary pods, and a P1 run reports the P2-only items
      `inconclusive` rather than `passed` or skipped (ACC-10-57).
      **Done when**: a P1 self-check run and quarantine drill complete on a real zone (T22) with the probe Jobs
      admitted.

- [ ] **T53 (P2). Hosting terms and abuse policy (EXT-18).**
      **Create** `docs/specs/features/app-works/policies-draft/` (**new**) — a hosting terms addendum, an
      acceptable-use policy, an abuse and copyright takedown process (intake, response targets, mapping to FR-41's
      quarantine categories), a trademark display policy and a names-only subprocessor delta, each marked for counsel
      review. **Modify** `packages/agent/src/apps-tier/apps-tier-eligibility.service.ts` (T27) — the hosting terms join
      the platform's existing required-documents set (migration `1785000000000-CreateTermsAcceptance`) and must be
      accepted before an owner's first deployment to the tier, with `termsNotAccepted` added to FR-35's reason codes.
      **Test**: extend `apps-tier-eligibility.service.spec.ts` — an owner who has not accepted the hosting terms is
      refused with `termsNotAccepted`, and accepting them clears it (ACC-10-38).
      **Done when**: the drafts exist, the documents are registered, and the reason code has owner copy.

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` green; the controller's kind
  integration job green.
- Every acceptance criterion in [spec §8](./spec.md) (ACC-10-01…48) walked on stage, with drill evidence stored only
  in the private operations repository and referred to here by artefact name.
- A repository-wide search of the merged diff finds no address, internal host name, cluster or node name.
- The tier opened on production only by an operator action that cites a green self-check less than 24 hours
  old.
