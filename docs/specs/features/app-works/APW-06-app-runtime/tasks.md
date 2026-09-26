# Task Breakdown: App runtime on Kubernetes

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests
> per **Constitution VI**. Schema tasks ship their migration in the same PR per **Constitution V**.

**Epic ID**: `APW-06-app-runtime`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify; `_(new)_` files do not exist yet; every other **Modify** path
  exists on `develop` @ `ee45946e5`.
- Every task has a **Test** line (a file and what it asserts, or the command that is the test) and a **Done when**
  line that is checkable without reading the diff. `(ACC-06-nn)` tags name the spec §8 criteria a Test line proves.
- Add new tasks at the bottom rather than renumbering. T47 and T48 were moved from P2 into P1.8 by Resolution R-16 and
  keep their numbers.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- Commands run from the monorepo root; migrations are authored from `apps/api/`. Package filters:
  `@ever-works/contracts`, `@ever-works/plugin`, `@ever-works/k8s-plugin`, `@ever-works/agent`, `ever-works-api`,
  `ever-works-web`, `@ever-works/trigger-tasks`.
- API behaviour is tested under `apps/api/src/**` or `apps/web/e2e/` — never `apps/api/test/` (Resolution R-22).
- **Additive guard for every task:** the existing suites `packages/plugins/k8s/src/__tests__/*.spec.ts`,
  `apps/api/src/plugins-capabilities/deploy/*.spec.ts` and `apps/web/e2e/flow-work-deploy-*.spec.ts` pass with no
  edits to existing assertions.
- **Resolutions that shape these tasks** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
  R-2 (Activity families), R-3 (eligibility read from APW-03, no attestation stored here), R-5 (Ever Works Apps only
  through `AppsTierPolicy` and the `apps-tier` deployment plugin), R-10 (verification targets), R-12 (target **None**),
  R-15 (deleting an App Work), R-16 (managed subdomain on Your cluster in Wave 1), R-24 (sandboxed runtime from Wave 2).

---

# Phase P1 — Your cluster (Wave 1)

_Delivers spec FR-1…FR-6, FR-9…FR-21, FR-23…FR-51 (managed subdomain on Your cluster included), FR-54…FR-62._

## P1.1 — Contracts and ports

- [ ] **T1. Runtime constants.**
      **Create** `packages/contracts/src/apps/app-runtime.ts` _(new)_ with every constant in [plan §5.3](./plan.md)
      plus `APP_DEPLOYMENT_STATES`, `APP_RUNTIME_HEALTH`, `APP_DEPLOY_TARGETS` (`none`, `your-cluster`,
      `ever-works-apps` — no "not yet" value, R-12), `APP_PRECONDITION_CODES` (plan §5.1, incl. `managed_ineligible`,
      `managed_sandbox_unavailable`, `app_work_deleting`) and `APP_FAILURE_CODES` (plan §5.4, §11).
      **Modify** `packages/contracts/src/apps/index.ts` (APW-03's barrel — append `export * from './app-runtime.js'`;
      create it and **Modify** `packages/contracts/src/index.ts` only if APW-03 has not landed — R-1).
      **Test**: `packages/contracts/src/apps/__tests__/app-runtime.spec.ts` pins every numeric value and every union;
      `APP_DEPLOY_TARGETS` is exactly the three values.
      **Done when**: `pnpm --filter @ever-works/contracts test` is green and `import { APP_ROLLOUT_MAX_S } from
'@ever-works/contracts'` resolves from `apps/api`.

- [ ] **T2 (parallel with T1). Plugin App contract.**
      **Create** `packages/plugin/src/contracts/capabilities/app-deployment.types.ts` _(new)_ with the types of
      [plan §3](./plan.md) **and §3.1 (the normative field reference)** (`AppDeployTarget`, `AppDeployPhase`, `AppTargetRef`, `AppRenderInput` incl. `purpose` and
      `ttlMinutes`, `AppComponentInput`, `AppJobInput` incl. `http.authScheme`, `AppCronInput`, `AppSmokeInput`,
      `AppDeployHooks`, `AppDeployResult` incl. `cancelReason` and `image`, `AppScaleResult`, `AppStatusSnapshot`,
      `AppStatusSpec`, `AppJobRunRequest` incl. the `runner: 'smoke'` variant, `AppJobResult`, `AppLogRequest`,
      `AppLogTail`, `AppLogRef`, `AppClusterCheckRequest`, `AppClusterCheck`, `AppDestroyResult` incl. `kept`,
      `AppQuotaInput`, `AppLimitRangeInput`, `CheckResult`, `AppSmokeRun`, `AppSmokeResult`, `AppComponentStatus`,
      `AppFailureCode`, `AppRuntimeState`).
      **Modify** `packages/plugin/src/contracts/capabilities/deployment.interface.ts` — add the ten **optional**
      members (`supportsApps`, `deployApp`, `getAppStatus`, `runAppJob`, `destroyApp`, `scaleApp`, `getAppLogs`,
      `checkAppCluster`, `prepareAppNamespace`, `publishAppHosts`) and `isAppDeploymentPlugin(plugin)` guard (`supportsApps === true && typeof deployApp === 'function'`);
      `scaleApp` returns `Promise<AppScaleResult>` and takes the optional `resumeChecks` argument.
      **Modify** `packages/plugin/src/contracts/capabilities/index.ts` — export the new file.
      **Test**: `packages/plugin/src/contracts/__tests__/app-deployment.types.spec.ts` _(new)_ — a type-level test that a
      plugin implementing only the pre-existing members still satisfies `IDeploymentPlugin` (and that a plugin
      implementing only the eight earlier App members still satisfies it, so the two new members stay optional);
      `isAppDeploymentPlugin` true/false cases.
      **Done when**: `pnpm --filter @ever-works/plugin test` is green and `packages/plugins/vercel` builds unchanged.

- [ ] **T3. Ports.**
      **Create** `packages/agent/src/app-runtime/ports.ts` _(new)_ exactly as [plan §9.6](./plan.md) (incl.
      `AppsTierPolicy.eligibility`, `AppRuntimeEnvSource.resolveEphemeral`, `target: AppDeployTarget` in both
      resolve contexts, `AppRuntimeTargetPort` / `APP_RUNTIME_TARGET`, `AppRuntimeEventSink` /
      `APP_RUNTIME_EVENT_SINK`, `AppVerificationSink` / `AppVerificationSink` and `AppVerificationUpdate`), and
      `packages/agent/src/app-runtime/default-ports.ts` _(new)_: `DisabledAppsTierPolicy` (`isOpen() = false`,
      `eligibility` → `{ eligible: false, reasons: ['managedTierDisabled'] }`), `UnavailablePullCredentialSource`,
      `UnavailableRuntimeEnvSource` and `UnavailableRuntimeTarget` that throw `AppPortUnavailableError(code)`, and
      an `UnavailableVerificationSink` that throws `verification_sink_unavailable`.
      **Create** `packages/agent/src/app-runtime/index.ts` _(new)_ barrel.
      **Modify** `packages/agent/package.json` — add the `./app-runtime` subpath export next to `./deployment-context`.
      **Test**: `packages/agent/src/app-runtime/__tests__/default-ports.spec.ts` — disabled policy never reports open;
      unavailable sources throw with codes `pull_credential_unavailable` / `env_source_unavailable`;
      `UnavailableRuntimeTarget.prepareDependencyTarget` resolves `{ unavailable: 'target_none' }` rather than
      throwing, so a caller reports a precondition; the verification sink refuses before any namespace exists; a grep
      assertion finds no `EVER_WORKS_APPS_MANAGED_ENABLED` in `packages/agent/src/app-runtime/` (R-5).
      **Done when**: `pnpm --filter @ever-works/agent test -- default-ports` is green and the symbols resolve from
      `@ever-works/agent/app-runtime`.

## P1.2 — The App renderer (k8s plugin)

- [ ] **T4. Names and labels.**
      **Create** `packages/plugins/k8s/src/app/app-names.ts` _(new)_ per [plan §4.1](./plan.md): `appNamespaceName(slug,
workId)`, `previewNamespaceName(ns, pr)`, `verificationNamespaceName(ns, provisioningId, attempt)`, object name helpers,
      `appLabels(...)`, `componentSelector(name)`, `internalUrl(component, namespace)`.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-names.spec.ts` — 63-char cap, slug truncation at 30,
      deterministic 8-hex suffix, the verification suffix `-v<first 6 hex of provisioningId>-<attempt ≤ 9>` stays ≤ 63
      characters and ≤ 52 in practice, is deterministic and gives two provisionings different names (APW06-G09);
      labels never contain
      `ever-works.io/managed` or `app.kubernetes.io/name`, Job name ≤ 45 and CronJob name ≤ 37 for a 32-char `Name`.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-names` is green and the helpers are pure and 100 %
      branch-covered.

- [ ] **T5. Security context.**
      **Create** `packages/plugins/k8s/src/app/app-security.ts` _(new)_ — `podSecurityContext(input, component)`,
      `containerSecurityContext(...)`, `tmpVolume(...)`, `namespacePodSecurityLabels(policy)` per plan §4.4.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-security.spec.ts` — one `it` per cell of the plan §4.4 table:
      no privilege escalation, `drop: [ALL]`, `RuntimeDefault` seccomp, `runAsNonRoot`, read-only root unless declared
      (ACC-06-07); `runAsNonRoot: false` only with `allowRoot` on `your-cluster` and never for `ever-works-apps`
      (ACC-06-08); `privileged_port` refusal on `ever-works-apps`; `NET_BIND_SERVICE` only with `allowRoot` and port < 1024.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-security` is green and no rendered container lacks
      `allowPrivilegeEscalation: false` and `capabilities.drop: [ALL]`.

- [ ] **T6. Workloads, services, volumes, secrets, ingress.**
      **Create** `packages/plugins/k8s/src/app/app-manifest.renderer.ts` _(new)_ — `renderNamespace`,
      `renderServiceAccount`, `renderLimitRange`, `renderResourceQuota`, `renderEnvSecret` (immutable, keys = env
      names), `renderPlatformConfigMap`, `renderPullSecret` (reuse `buildImagePullSecret` shape without editing it),
      `renderPvc` (`emptyDir` substitute for `purpose: 'verification'`), `renderComponentDeployment`,
      `renderComponentService`, `renderIngress` (reuse `IngressStrategyRegistry`; TLS only for `cert-manager`; none for
      verification), `componentDeadlineSeconds(component)` (plan §5.3 formula), and `validateRenderInput` returning
      `volume_replicas`, `volume_shrink`, `privileged_port`; export the pure entry points as a library (R-5).
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-manifest.renderer.spec.ts` with golden JSON fixtures in
      `packages/plugins/k8s/src/app/__tests__/fixtures/` built from APW-03 `schema.md` §24 examples: digest image;
      `Recreate` with volumes; `envFrom` not optional; no env value in any pod spec and no pull credential other than
      the render input's (ACC-06-16); `automountServiceAccountToken: false`; `enableServiceLinks: false` (ACC-06-07);
      the pod template's `ever-works.io/env-checksum` changes when one env value changes and is byte-identical otherwise
      (ACC-06-15); **rendering twice with different `deploymentId` / `deploymentShort` but the same Build, env and spec
      yields byte-identical component `spec.template`s and identical `envFrom` object names, puts
      `ever-works.io/deployment-id` only under the Deployment's `metadata.annotations`, and leaves no
      `EVER_WORKS_DEPLOYMENT_ID` key in the platform ConfigMap (ACC-06-58, APW06-G07)**; Ingress only for the primary web
      component; strict host validation; deadline clamp at 300 and 2400;
      a component with a volume and `replicas: 2` → `volume_replicas` (ACC-06-18); the `prepare-namespace` subset renders
      the namespace, the ServiceAccount and the `LimitRange` and — with `isolation: true` — exactly `ew-default-deny`,
      `ew-allow-same-namespace` and `ew-allow-egress`, never `ew-allow-ingress` / `ew-allow-deps` (ACC-06-54, plan §4.2).
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-manifest.renderer manifest.renderer` is green and
      `manifest.renderer.spec.ts` (existing) is untouched.

- [ ] **T7 (parallel with T6). Network policies.**
      **Create** `packages/plugins/k8s/src/app/app-network-policy.renderer.ts` _(new)_ per plan §4.10.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-network-policy.spec.ts` — the five default policies render
      and every excepted IPv4/IPv6 CIDR is present (ACC-06-17); controller-namespace and fallback variants;
      `extraEgress` and hairpin rules; `isolation: false` renders zero policies and returns the five names to delete —
      and **never** a `dep-<kind>` name (APW07-G01, ACC-06-54).
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-network-policy` is green and the fixture diff is
      reviewed against the plan table.

- [ ] **T8. Jobs, CronJobs and the runner.**
      **Create** `packages/plugins/k8s/src/app/app-runner.script.ts` _(new)_ (the runner source as a string constant +
      `APP_RUNNER_IMAGE` digest constant), `packages/plugins/k8s/src/app/app-jobs.renderer.ts` _(new)_ —
      `renderCommandJob`, `renderRunnerJob(kind: 'http-job'|'smoke'|'hairpin'|'isolation-probe')`,
      `renderRunnerConfigMap`, `renderCronJob`; requests with `redirect: 'manual'`, `authScheme` bearer/raw,
      `{{env.NAME}}` from `secretKeyRef`, `found` capped at 200 chars and secret-scrubbed; `cron_too_frequent` check.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-jobs.renderer.spec.ts` — backoff/deadline/TTL/Never; the
      ConfigMap contains paths with `$(`, backticks and quotes verbatim as JSON data and no command string contains them;
      cron auth via `secretKeyRef`; `concurrencyPolicy` mapping; `suspend: true` when paused (ACC-06-35).
      `packages/plugins/k8s/src/app/__tests__/app-runner.script.spec.ts` runs the script in-process against a local HTTP
      server: status, `bodyContains`, `bodyNotContains` failure quoting the found string (ACC-06-12) with the 1 MiB cap,
      latency, 307 not followed, bearer vs raw header.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-jobs.renderer app-runner.script` is green and no
      rendered `command`/`args` contains a value read from the App spec's `http` block.

- [ ] **T9. Rollout predicate and classifier.**
      **Create** `packages/plugins/k8s/src/app/app-rollout.ts` _(new)_ per plan §5.4 (`isComponentRolledOut`,
      `classifyPodFailure`, `workerStable`). Do **not** change `packages/plugins/k8s/src/status.mapper.ts`.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-rollout.spec.ts` — `metadata.generation` vs
      `observedGeneration`; old ReplicaSet with ready pods blocks success; 3 restarts; `ImagePullBackOff` for 179 s vs
      180 s; `OOMKilled`; the two root-user kubelet messages classify `image_runs_as_root` /
      `image_user_unverifiable` within 180 s (ACC-06-08).
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-rollout` is green and each `AppFailureCode` in plan
      §5.4 has at least one test.

- [ ] **T10. API wrapper additions.**
      **Modify** `packages/plugins/k8s/src/k8s-api.service.ts` — add `applyObject`, `readObject`, `listObjects(apiVersion,
kind, namespace, labelSelector)`, `deleteObject(…, propagationPolicy)`, `readPodLog(ns, pod, container,
{ tailLines, limitBytes, previous })`, `createSelfSubjectAccessReview`, and `authorizationV1Api` on
      `KubernetesClientFactory` + `defaultClientFactory`. Existing methods unchanged.
      **Test**: extend `packages/plugins/k8s/src/__tests__/k8s-api.service.spec.ts` with mocked-factory cases for each
      new method, including 404 → `null` on reads.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- k8s-api.service` is green with existing assertions
      unchanged.

- [ ] **T11. Kubeconfig guard.**
      **Create** `packages/plugins/k8s/src/app/app-kubeconfig.guard.ts` _(new)_ per plan §6.1: `assertSupportedKubeconfig`,
      `isPublicAddress(ip, allowlist)`, `pinKubeconfigServer(yaml, resolver)` → rewritten YAML with `tls-server-name`.
      **Modify** `packages/plugins/k8s/src/errors.ts` — add code `KUBECONFIG_UNSUPPORTED` and `CLUSTER_ADDRESS_NOT_PUBLIC`.
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-kubeconfig.guard.spec.ts` — `exec`, `auth-provider`,
      `tokenFile`, file certificate paths, `proxy-url`, `insecure-skip-tls-verify` and missing CA data each refused before
      any resolver or client call (ACC-06-02); every deny CIDR incl. `::ffff:10.0.0.1`, `64:ff9b::a00:1`; a hostname
      resolving to one public + one private address is refused; an operator allow-list range is accepted (ACC-06-03);
      DNS timeout 10 s; resulting YAML has the IP server and original `tls-server-name`; a mocked 307 from `/version` is
      not followed.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-kubeconfig.guard` is green and a spec spying on the
      factory proves no code path in `src/app/` calls `KubeConfig.loadFromString` without the guard.

- [ ] **T12. Deployer: phase machine and rollback.**
      **Create** `packages/plugins/k8s/src/app/app-deployer.ts` _(new)_ per plan §5.5: capture → prepare → pre-deploy
      jobs → rollout → first-deploy jobs → in-cluster smoke → isolation probe → publish → `hooks.verifyPublic` →
      hairpin (T61) → post-deploy jobs → CronJobs → GC (env Secrets/ConfigMaps beyond 3, Jobs beyond 3 per name);
      rollback from capture; first-Deployment failure handling (`scaleFailedFirstDeployToZero`); cancellation between
      phases and polls; 2-hour overall deadline; `purpose: 'verification'` path (T60).
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-deployer.spec.ts` with a fake API — phase order; a failing
      pre-deploy job ends `failed` with zero Deployment writes (ACC-06-09); a crash-looping component re-applies captured
      templates and hosts → `rolled-back` (ACC-06-10); the Ingress apply happens after the first-deploy job completes and
      `isFirstDeploymentOnCluster: false` renders no first-deploy Job (ACC-06-11); in-cluster `bodyNotContains` failure →
      `rolled-back` with the found string (ACC-06-12); public `dns_not_pointing` → `succeeded-with-warnings` and no
      rollback (ACC-06-13); rollback restores the previous `envFrom` secret name (ACC-06-15); cancel before change →
      `cancelled`, after change → `rolled-back` with `cancelled` (ACC-06-22); `skipPreDeployJobs` on a manual rollback
      input renders no pre-deploy Job and applies the captured build's image (ACC-06-23); rollback that does not become
      ready → `rollback-failed` (ACC-06-24); publish failure rolls back.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-deployer` is green and every row of spec FR-26's
      table has a test named after it.

- [ ] **T13. Status, scale, logs, destroy, cluster check.**
      **Create** `packages/plugins/k8s/src/app/app-status.reader.ts`, `app-lifecycle.ts`, `app-cluster-check.ts` _(new)_:
      `getAppStatus` (components, restarts, last `OOMKilled` within 24 h, jobs, cron last schedule/success),
      `scaleApp` (replicas + CronJob `suspend`; on `resume` it takes the optional `resumeChecks`
      `{ smoke, deadlines }`, waits with `isComponentRolledOut` / `componentDeadlineSeconds` for the phase-3
      rollout and then runs the phase-5 in-cluster smoke, resolving `AppScaleResult` — APW06-G03),
      `getAppLogs` (≤ 500 lines, 262 144 bytes, secret redaction by value ≥ 8
      chars), `runAppJob` (live Deployment's image and `envFrom`; refuses while a Job of the same name is active;
      the `runner: 'smoke'` variant runs the App spec's checks through the runner Job),
      `prepareAppNamespace` (plan §4.2 subset: namespace + pod-security labels + ownership check, ServiceAccount,
      LimitRange with the `limitrange_forbidden` warning, and the three baseline policies when `isolation` is true;
      idempotent; never draws `ew-allow-ingress`, `ew-allow-deps` or a `dep-*` policy — GAP-06),
      `publishAppHosts` (re-applies only the `Ingress` by reusing `renderIngress` and returns the observed
      `ingressAddress`; zero other applies — APW06-G03),
      `destroyApp` (never PVCs, `ever-works.io/dependency` objects or — while such objects remain — `ew-default-deny`
      unless `deleteVolumes`; namespace deleted only when `deleteVolumes`; verification namespaces deleted whole),
      `checkAppCluster` (plan §6.3 permission list, ingress classes, controller namespace, issuers, storage classes,
      **the ingress controller Service's address as `ingressAddress`, and the fingerprint inside the result** —
      GAP-09 / APW06-G03).
      **Test**: `packages/plugins/k8s/src/app/__tests__/app-status.reader.spec.ts` — every FR-46 field is filled from a
      fake cluster (ACC-06-31). `packages/plugins/k8s/src/app/__tests__/app-lifecycle.spec.ts` — `scaleApp('pause')`
      sets replicas 0 and `suspend: true` (ACC-06-35); `scaleApp('resume', …)` resolves an `AppScaleResult` carrying
      components and smoke, and reports `failure.code` without rolling back; `destroyApp` with `deleteVolumes: false`
      issues zero PVC deletes,
      zero dependency deletes, keeps `ew-default-deny` and zero namespace deletes (ACC-06-18, ACC-06-36); `getAppLogs`
      replaces a secret value appearing mid-line with its name and returns no value (ACC-06-34); `runAppJob` uses the live
      image digest and a second call while active is refused (ACC-06-37); `prepareAppNamespace` persists nothing itself
      but renders the §4.2 subset and is idempotent on a second call; `publishAppHosts` applies one `Ingress` and zero
      Deployments (ACC-06-25).
      `packages/plugins/k8s/src/app/__tests__/app-cluster-check.spec.ts` — each missing required permission is named,
      with `required: true` blocking Save (ACC-06-05); optional permissions listed as optional; the result carries
      `fingerprint` and `ingressAddress` and never writes the runtime-state `clusterFingerprint`.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-status.reader app-lifecycle app-cluster-check` is
      green and results contain no secret values (asserted with a sentinel value).

- [ ] **T14. Plugin wiring.**
      **Modify** `packages/plugins/k8s/src/k8s.plugin.ts` — `readonly supportsApps = true` and ten methods delegating to
      `src/app/*` (`deployApp`, `getAppStatus`, `runAppJob`, `destroyApp`, `scaleApp`, `getAppLogs`, `checkAppCluster`,
      `prepareAppNamespace`, `publishAppHosts`), each running `assertSupportedKubeconfig` + `pinKubeconfigServer` on
      **every** credential (the `k8s` plugin never serves `ever-works-apps`; R-5). `deploy()` and every existing method
      are untouched.
      **Modify** `packages/plugins/k8s/src/index.ts` — export the App renderer (pure functions, for APW-10's in-zone
      controller) and guard entry points.
      **Test**: extend `packages/plugins/k8s/src/__tests__/k8s.plugin.spec.ts` — `supportsApps`, delegation, the guard
      runs on every App method, an `AppTargetRef` with target `ever-works-apps` is refused, and a snapshot proving
      `deploy()` renders the same manifests as before for the existing fixture (ACC-06-43).
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test` is green.

- [ ] **T15. Kind e2e.**
      **Create** `packages/plugins/k8s/src/__tests__/e2e/app-runtime.e2e.spec.ts` _(new)_ per plan §12.1 using a
      non-root nginx image as `web`, a busybox `worker`, a `migrate` command job, a first-deploy `http` job, an `http`
      cron every minute, a 100Mi PVC, smoke checks; second Deployment with a crashing command → rolled back; isolation
      reported **not enforced**; App Work deletion without data; a verification namespace. Allow-list `127.0.0.1/32` via
      `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` for kind.
      **Modify** `.github/workflows/k8s-e2e.yml` only if the new spec needs a longer job timeout (≤ 30 min).
      **Test**: `pnpm --filter @ever-works/k8s-plugin test:e2e` on kind — first Deployment Live with web, worker, migrate,
      first-deploy job, cron and volume (ACC-06-06); the loopback allow-list admits the kind API (ACC-06-03); the crashing
      Deployment rolls back and the Service still answers with the previous version (ACC-06-10); first-deploy Job
      completion precedes the Ingress creation and no first-deploy Job exists after the second Deployment (ACC-06-11); a
      changed env value restarts pods and an unchanged one does not (ACC-06-15); policies exist and isolation reads
      `false` on kindnet (ACC-06-17); the PVC survives redeploy, pause and remove-without-data (ACC-06-18); pause scales to
      0 within 120 s (ACC-06-35); remove keeps the PVC (ACC-06-36); App Work deletion keeps the PVC and `ew-default-deny`
      and removes every workload (ACC-06-45); the verification namespace has no Ingress or PVC and is gone after destroy
      (ACC-06-48).
      **Done when**: the `k8s-e2e.yml` workflow is green and `cluster.e2e.spec.ts` is unchanged.

## P1.3 — Data model

- [ ] **T16. `WorkDeployment` columns and states.**
      **Modify** `packages/agent/src/entities/work-deployment.entity.ts` — append `buildId`, `componentStatuses`,
      `smokeResult`, `appTarget`, `appRender` (plan §7.1); extend `isTerminal()` with `ROLLED_BACK`, `SUPERSEDED`.
      **Test**: `packages/agent/src/entities/__tests__/work-deployment.entity.spec.ts` (create if absent) — columns
      nullable, no pre-existing column changed, `isTerminal` truth table.
      **Done when**: `pnpm --filter @ever-works/agent test -- work-deployment.entity` is green and
      `pnpm --filter @ever-works/agent build` is clean.

- [ ] **T17. `WorkAppRuntimeState` entity and repository.**
      **Create** `packages/agent/src/entities/work-app-runtime-state.entity.ts` _(new)_ (plan §7.2 — **no**
      `licenseAttestation` column, R-3; deletion columns for R-15; scope columns without relation decorators) and
      `packages/agent/src/database/repositories/work-app-runtime-state.repository.ts` _(new)_: `getOrCreate(workId)`,
      `claimDeployLock(workId, deploymentId, staleAfterS)`, `releaseDeployLock(workId, deploymentId)`, `setQueued(...)`,
      `selectForHealthPoll(limit)`, `recordHealth(...)`, `saveSnapshot(...)`, `claimDeletion(workId, opts)`,
      `recordDeletionAttempt(workId)`.
      **Added by the 2026-09-17 fix pass (plan §7.2).** The entity also carries `cancelRequestedAt` /
      `cancelRequestedByUserId` (the flag `hooks.isCancelled()` reads, cleared by `releaseDeployLock` in the same
      UPDATE), `pendingDomainRebuildBuildId` (with an atomic `clearPendingDomainRebuild(workId, buildId)`) and
      `upstreamSyncJudgedToSha`. `claimDeployLock` requires `paused = false` **and** `deletionRequestedAt IS NULL`
      in addition to the null lock. `prepare-namespace` (T69) and §5.6 both persist `namespace` /
      `clusterFingerprint`; a `cluster-check` never writes them.
      **FR-63 — derive the target on first read (this closes APW-01's recorded cross-epic requirement; without it a
      Work created for Your cluster stays `none` and refuses to deploy).** `getOrCreate(workId)` must set `target`
      from the Work's creation-time choice: `your-cluster` when the Work's persisted `deployProvider` names a
      deployment plugin with `supportsApps === true`, the managed target when it is `ever-works-apps`, else `none`.
      Never leave the column's default in place for a Work that was created with a target, and never overwrite a
      target the owner has since changed.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts` — register the entity next to `WorkDeployment`.
      **Test**: `packages/agent/src/database/repositories/__tests__/work-app-runtime-state.repository.spec.ts` _(new)_ —
      lock claim is atomic under two concurrent claims (one wins), stale lock reclaimed after 7 260 s, release only by the
      holder; `claimDeletion` refuses while a deploy lock is held and succeeds once; the entity metadata has no column
      named `licenseAttestation` (ACC-06-39); **and** `getOrCreate` derives `your-cluster` for a Work whose
      `deployProvider` is a `supportsApps` plugin, `ever-works-apps` for the managed provider, `none` otherwise, and
      does not clobber a target that was already set.
      **Done when**: `pnpm --filter @ever-works/agent test -- work-app-runtime-state.repository` is green and the database
      drift specs pass without editing their counts by hand beyond the new entity.

- [ ] **T18. Migrations.**
      **Create** `apps/api/src/migrations/1792060000000-ExtendWorkDeploymentsForApps.ts` and
      `apps/api/src/migrations/1792060100000-CreateWorkAppRuntimeStates.ts` _(new)_ (plan §7.3), generated with
      `cd apps/api && pnpm typeorm migration:generate …` and reviewed by hand.
      **Test**: `apps/api/src/migrations/__tests__/ExtendWorkDeploymentsForApps.spec.ts` and
      `apps/api/src/migrations/__tests__/CreateWorkAppRuntimeStates.spec.ts` — `up()` has no `DROP`/rename of pre-existing
      columns; `down()` drops only what `up()` created; existing rows read `buildId = null`; the runtime-state table
      carries `cancelRequestedAt`, `cancelRequestedByUserId`, `pendingDomainRebuildBuildId` and
      `upstreamSyncJudgedToSha`, and rows written before the column existed read `null` for all four.
      **Done when**: `pnpm --filter ever-works-api test -- ExtendWorkDeploymentsForApps CreateWorkAppRuntimeStates` is
      green and a fresh database and one with existing `work_deployments` rows both migrate.

## P1.4 — Agent services

- [ ] **T19. Config.**
      **Modify** `packages/agent/src/config/index.ts` — add `everWorks.apps` (`getDomain`, `getMaxPerUser` default 3,
      `getDnsZoneId`, `getDnsApiToken`, `isClusterWorkerIsolated`, `getClusterPrivateAllowlist`) with the apps-domain
      relation validation of plan §8.3 (P1 per R-16).
      **Test**: extend `packages/agent/src/config/config.spec.ts` — apps domain equal to / under / parent of
      `EVER_WORKS_DOMAIN` → `getDomain() === null` (ACC-06-27); invalid CIDR entries dropped with a warning and a valid
      one returned (ACC-06-03).
      **Done when**: `pnpm --filter @ever-works/agent test -- config.spec` is green and unset env keeps every getter at its
      documented default.

- [ ] **T20. `AppRuntimeFacadeService`.**
      **Create** `packages/agent/src/facades/app-runtime.facade.ts` _(new)_ — resolves, through `PluginRegistryService`
      and by capability only (R-5): for `your-cluster` the deployment plugin for the Work's `deployProvider` with
      `isAppDeploymentPlugin` and **without** `apps-tier`; for `ever-works-apps` the enabled deployment plugin with
      `isAppDeploymentPlugin` **and** `apps-tier`, only while `AppsTierPolicy.isOpen()`. Resolves the credential
      per plan §5.6 step 3 (`custom-kubeconfig` only for `your-cluster`; `AppsTierPolicy.resolveClusterCredential` only for
      `ever-works-apps`).
      **Added (APW06-G02).** It is _constructed_ in every process that imports `FacadesModule`, so it cannot refuse at
      construction: **every method call** throws `APP_CLUSTER_IO_IN_API` unless `isAppClusterWorkerContext()` is true.
      **Create** `packages/agent/src/app-runtime/worker-context.ts` _(new)_ exporting
      `markAppClusterWorkerContext()` and `isAppClusterWorkerContext()` — a process-level flag, **not** an env var.
      Only the `TriggerAppRuntimeModule` bootstrap provider (T71) calls the marker, in `onModuleInit`.
      **Modify** `packages/agent/src/facades/facades.module.ts` and `packages/agent/src/facades/index.ts` to provide it.
      **Test**: `packages/agent/src/facades/__tests__/app-runtime.facade.spec.ts` _(new)_ — constructing it outside the
      worker is allowed and the first call throws `APP_CLUSTER_IO_IN_API` (ACC-06-04); the API module graph never
      imports the marker provider (a static import scan over `apps/api/src`); never reads `EVER_WORKS_K8S_WORKS_KUBECONFIG`,
      `EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG` or `EVER_WORKS_APPS_MANAGED_ENABLED` (env spies); refuses
      `k8s-works-shared` settings for kind `app`; `validateClusterSourceForOwner` called with the data-repository owner;
      for `ever-works-apps` the `apps-tier` plugin receives the tier credential and the `k8s` plugin spy receives nothing
      (ACC-06-49).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-runtime.facade` is green and no `'k8s'` string literal
      is added outside `packages/plugins/k8s/`.

- [ ] **T21. Preconditions and license gate.** _Status 2026-09-26: [Status notes](#status-notes)._
      **Create** `packages/agent/src/app-runtime/app-deploy-preconditions.service.ts` and
      `packages/agent/src/app-runtime/app-license-gate.ts` _(new)_ per plan §5.1–§5.2 — the license gate reads
      `AppLicenseService.getHostingEligibility(workId)` (APW-03; typed fake until it lands) and stores nothing (R-3).
      **Test**: `packages/agent/src/app-runtime/__tests__/app-deploy-preconditions.service.spec.ts` — one test per
      precondition code; two unset required values and a provisioning dependency produce three named entries and no
      dispatch; no green Build for the head returns `no_green_build_for_head` with `latestGreenBuildId` (ACC-06-19); the
      App spec is read at the Build's commit, not the latest applied commit (ACC-06-20); target `none` → `target_none`
      (ACC-06-01); **a pending dependency gives exactly one `dependency_not_ready` entry naming it and exactly one
      `AppDependenciesService.ensureReadyForDeploy` call, which is what dispatches provisioning (GAP-05, ACC-06-54);
      strategy `dockerfile`/`auto` requires a green Build while strategy `image` does not and never yields
      `no_green_build*`, `nothing_to_deploy` is returned for strategy `none`, and `image_not_pinned` is returned only
      on `ever-works-apps` for a tag-only reference (FR-64, ACC-06-52/-53); an entry sourced from `domains.primary.*`
      with no primary host yields `primary_domain_missing` naming it, with the `primary_url_incluster` warning rather
      than a refusal (GAP-09); a dispatcher that resolves `null` or lacks `dispatchApp*` yields `worker_not_isolated`
      with no `WorkDeployment` row (APW06-G02, ACC-06-55)**. `packages/agent/src/app-runtime/__tests__/app-license-gate.spec.ts` — `yourCluster:
'attestationRequired'` → `license_attestation_missing`; `managed` reason (amber without agreement, red) →
      `license_blocks_target`; a changed eligibility after a license change re-requires attestation; the gate never
      writes to any repository (ACC-06-39).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy-preconditions.service app-license-gate` is green
      and the service never throws for an unmet precondition.

- [ ] **T22. Render input builder.**
      **Create** `packages/agent/src/app-runtime/app-render-input.builder.ts` _(new)_ — spec at Build commit, env via
      `AppRuntimeEnvSource` (with `buildCommitSha`, `internalUrls`, primary URL/host), pull credential via
      `AppImagePullCredentialSource`, dependency egress resolved to `/32` or `/128` CIDRs, hosts from T26, policy.
      **Added (APW06-G08 / APW06-G04).** It passes `target: AppDeployTarget` into `AppRuntimeEnvSource.resolve`; for
      `build.strategy: image` it takes the image from the spec at `specCommitSha`, passes `buildCommitSha: null` and
      **never calls** `AppImagePullCredentialSource`; for every other strategy it passes the Build's commit and resolves
      the pull credential.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-render-input.builder.spec.ts` _(new)_ — never includes
      `GH_TOKEN`, `PLATFORM_API_SECRET_TOKEN`, `PLATFORM_SYNC_SECRET` or any key the env source did not return; the image
      pull block equals exactly the port's credential and the owner's Git token sentinel appears nowhere in the input
      (ACC-06-16); image reference and `specCommitSha` come from the same Build (ACC-06-20); `target` reaches the env
      source for every target; under strategy `image` the pull-credential port records zero calls, `buildCommitSha` is
      `null` and the reference is the spec's own (ACC-06-52);
      `DeployService.collectServerSideRuntimeEnv` and `resolveGhcrReadToken` are not called (spies).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-render-input.builder` is green and the builder has no
      dependency on `apps/api`.

- [ ] **T23. Public smoke service.**
      **Create** `packages/agent/src/app-runtime/app-public-smoke.service.ts` _(new)_ — requests with manual redirects,
      1 MiB body cap, classification `dns_not_pointing` / `tls_not_ready` / `unreachable` / `check_failed`, windows
      600 s / 180 s, retry every 10 s.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-public-smoke.service.spec.ts` _(new)_ — local HTTPS server
      with a mismatched certificate → `tls_not_ready`; resolver returning another address → `dns_not_pointing`, both
      reported as warnings not failures (ACC-06-13); body mismatch → `check_failed` with the found string ≤ 200 chars.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-public-smoke.service` is green and no response body
      beyond 200 characters leaves the service.

- [ ] **T24. Deploy request service.**
      **Create** `packages/agent/src/app-runtime/app-deploy-request.service.ts` _(new)_ — preconditions, lock claim,
      latest-wins queue (`SUPERSEDED`), `WorkDeployment` creation, dispatch; manual vs Build-triggered vs
      `spec-applied` vs domain-change vs
      rollback (`skipPreDeployJobs` default true); cluster-change confirmation; refuses while `deletionRequestedAt` is set.
      **Added (APW06-G02, APW06-G04).** The request body accepts `{ buildId?, specCommitSha?, confirmClusterChange? }`;
      sending `buildId` for strategy `image` returns `400 build_not_applicable`; a strategy-`image` request creates the
      row with `buildId: null` and the spec commit, and its queue entry keeps `queuedBuildId` null; a queued request from
      the other strategy is `SUPERSEDED`. **The dispatcher is checked before the lock claim**: when it resolves `null`,
      `isEnabled()` is false or the active runtime lacks `dispatchApp*`, the request returns
      `422 worker_not_isolated` and creates no row (APW06-G02).
      **Test**: `packages/agent/src/app-runtime/__tests__/app-deploy-request.service.spec.ts` _(new)_ — second manual
      request → `APP_DEPLOY_IN_PROGRESS`; three Build-triggered requests during one run → one queued, one `SUPERSEDED`
      (ACC-06-21); a rollback request carries the old Build (or the recorded digest and spec commit under strategy
      `image`) and its commit and `skipPreDeployJobs: true` (ACC-06-23); request budget ≤ 2 s with a slow dispatcher
      mocked at 5 s; deleting App Work → `app_work_deleting`; a missing dispatcher → `worker_not_isolated`, zero rows,
      zero cache entries (ACC-06-55).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy-request.service` is green and the service never
      calls the plugin.

- [ ] **T25. `app-deploy` orchestrator.**
      **Create** `packages/agent/src/app-runtime/app-deploy.orchestrator.ts` _(new)_ per plan §5.6 (states, hooks,
      snapshot, first-deploy bookkeeping per cluster fingerprint, lock release, dequeue, event emission order).
      **Added by the 2026-09-17 fix pass.** It resolves its credential through `AppRuntimeTargetResolver` (T69), emits
      through `AppRuntimeEventSink` (T70) rather than `EventEmitter2`, resolves an `image`-strategy Deployment through
      `AppImageReferenceResolver` (T72) before `prepare`, calls APW-07's `onAppRemoved` on both removal paths (plan
      §5.6 step 8, T70's `remove` op), and runs the upstream-sync verdict of plan §5.6 step 9 (APW06-G10) after the
      terminal and `app.smoke.*` events: `APP_PROVISION_EVENTS_PORT` `@Optional()`, `upstreamSyncJudgedToSha` set
      whether the Deployment passed or failed, `smokeFailedAfterUpstreamSync` called only when the Deployment emitted
      `app.smoke.failed` (in-cluster failure ending `ROLLED_BACK`/`ERROR`, or a public `check_failed` — never
      `dns_not_pointing`, `tls_not_ready` or `unreachable`), rollback Deployments skipped, and a throwing port never
      delaying lock release.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-deploy.orchestrator.spec.ts` _(new)_ — outcome → state
      mapping table (`rolled-back` → `ROLLED_BACK`, `succeeded-with-warnings` → `READY` + warnings); lock released on every
      outcome including thrown errors; queued Build requested after release; event order `started → job.* → terminal →
smoke.*`; `rollback-failed` triggers the urgent notification producer (ACC-06-24); a thrown plugin error ends
      `ERROR (worker_failed)`; **a cancelled or quarantined result is stored `CANCELED` with
      `appRender.cancelledBy: 'quarantined'` (APW06-G05, ACC-06-55); the upstream verdict's eight cases (fast-forward
      range plus failing smoke → one call; the same `toSha` twice → one call; pass-then-fail → none; public
      `check_failed` on a `READY` + warnings Deployment → one; `tls_not_ready` alone → none; rollback → none;
      `isAncestorCommit` null and commit ≠ `toSha` → none; an unbound or throwing port leaves state and lock release
      unchanged) (APW06-G10); under strategy `image` the resolver runs once before `prepare` and a 404/401/timeout ends
      `ERROR` with its own code (ACC-06-52)**.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy.orchestrator` is green and no outcome leaves a
      held lock.

- [ ] **T26. Hosts and domains.**
      **Create** `packages/agent/src/app-runtime/app-hosts.service.ts` and `packages/agent/src/app-runtime/app-domains.service.ts`
      _(new)_ per plan §8.1, §8.2, §8.4 (custom domains, primary order custom-then-managed, URL scheme per TLS mode).
      **Modify** `packages/agent/src/facades/deploy.facade.ts` — early kind-`app` branch in `getDomains`, `addDomain`,
      `removeDomain`, `verifyDomain` delegating to `AppDomainsService`.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-hosts.service.spec.ts` _(new)_ — unverified domain never in
      `hosts`; verify → `ingress-reconcile` dispatched with no Deployment requested (ACC-06-25); primary change with
      `restart` requests a Deployment of the current Build and with `rebuild` calls `AppBuildsService.requestRebuild` and
      stores the returned id in `pendingDomainRebuildBuildId`, while a rate-limited or blocked request stores nothing and
      requests no Deployment (ACC-06-26, APW06-G11); under strategy `image` `rebuild` behaves as `restart` with the
      `rebuild_not_applicable` warning (ACC-06-52). The custom-domain **verify** path uses
      `runtimeState.ingressAddress`, which `checkAppCluster` now records before the first Deployment (GAP-09).
      `packages/agent/src/app-runtime/__tests__/app-domains.service.spec.ts` _(new)_ — DNS guidance `A` for an IP and
      `CNAME` for a hostname. `packages/agent/src/facades/__tests__/deploy.facade.spec.ts` stays green unchanged.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-hosts.service app-domains.service deploy.facade` is green
      and `mergeCustomDomainHosts` is untouched.

- [ ] **T27. Health service.**
      **Create** `packages/agent/src/app-runtime/app-health.service.ts` _(new)_ per plan §9.3.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-health.service.spec.ts` _(new)_ — 4 failing polls → no
      notification, 5th → one; failures for 7 h → 2 notifications; 3 passes → recovery only after a failure notification
      (ACC-06-32); 10 unreachable → `unreachable` not `down` with one notification (ACC-06-33); paused and deleting App
      Works skipped; per-cluster concurrency 5.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-health.service` is green and a single poll never exceeds
      20 s (fake timers).

- [ ] **T28. Events and Activity.**
      **Create** `packages/agent/src/events/app-runtime.events.ts` _(new)_; **Modify** `packages/agent/src/events/index.ts`.
      **Create** `apps/api/src/app-runtime/app-runtime-event-relay.service.ts` _(new)_ and its worker-facing proxy
      (APW06-G02): `emit(name, payload)` accepts only names in the `app.*` catalogue, runs the ACC-06-41 forbidden-key
      check and re-emits through `EventEmitter2`, so the existing listener writes Activity unchanged; an unknown name is
      refused. Register it in `apps/api/src/trigger/trigger-internal.controller.ts` and in
      `packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts` (`createRemoteProxy`).
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — `APP_DEPLOY = 'app_deploy'`, `APP_JOB = 'app_job'`,
      `APP_SMOKE = 'app_smoke'`, `APP_HEALTH = 'app_health'` (R-2).
      **Modify** `apps/api/src/activity-log/activity-log.listener.ts` — one `@OnEvent` per event in plan §9.4 with
      `action` = the dotted name and `actionType` = the family.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-runtime.events.spec.ts` _(new)_ — payload types have no
      `value`/`env`/`log`/`kubeconfig`/`token` fields (compile-time + runtime key check with sentinel values) (ACC-06-41);
      the relay refuses an unknown name and writes one Activity row for a known one (APW06-G02);
      extend `apps/api/src/activity-log/activity-log.listener.spec.ts` — each event writes its family `actionType`, never
      `deployment`; switching isolation off records a warning row (ACC-06-17).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-runtime.events` and `pnpm --filter ever-works-api test --
activity-log.listener` are green; Activity summaries name components/jobs/checks only.

- [ ] **T29. Notifications.**
      **Modify** `packages/agent/src/notifications/core-event-catalogue.ts` — `app_deploy_failed`, `app_unhealthy`,
      `app_recovered`, `app_cluster_unreachable` (plan §9.4). **Modify**
      `packages/agent/src/notifications/notification.service.ts` — the four producers with `deduplicationKey`
      `app-health:<workId>` / `app-deploy:<deploymentId>` and `actionUrl` to the Deploy tab.
      **Test**: `packages/agent/src/notifications/__tests__/event-registry-coverage.spec.ts` green;
      `packages/agent/src/notifications/__tests__/app-runtime-notifications.spec.ts` _(new)_ — a rollback-failed producer
      call creates an urgent notification with the Deploy tab link (ACC-06-24); dedupe keys as stated.
      **Done when**: `pnpm --filter @ever-works/agent test -- event-registry-coverage app-runtime-notifications` is green
      and urgent rows ship in-app + email by the catalogue's defaults rule.

- [ ] **T30 (parallel with T29). Source offer.**
      **Create** `packages/agent/src/app-runtime/app-source-offer.ts` _(new)_ — `required` and the URL from APW-03's
      `getHostingEligibility(workId).sourceOffer` (the shared C3 condition: obligation **and** (link **or** ahead > 0)),
      the deployed commit substituted into the URL, `license.sourceOfferUrl` when private; `privateWithoutUrl` warning.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-source-offer.spec.ts` _(new)_ — truth table of obligation ×
      link × ahead × private × url; the URL targets the deployed commit, not the branch head (ACC-06-30).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-source-offer` is green and `EVER_WORKS_SOURCE_URL` is set
      only when the offer applies.

## P1.5 — Background jobs

- [ ] **T31. Dispatchers.**
      **Create** `packages/agent/src/tasks/app-deploy-dispatcher.ts`, `app-deploy.types.ts`, `app-smoke-dispatcher.ts`,
      `app-smoke.types.ts`, `app-cluster-op-dispatcher.ts`, `app-cluster-op.types.ts` _(new)_ (ops incl.
      `prepare-namespace`, `delete-app-work`, `verification-deploy`, `verification-status`, `verification-destroy`, with
      the typed verification payloads of plan §9.2).
      **Modify** `packages/agent/src/tasks/index.ts` and `packages/agent/src/tasks/_tasks-symbols.ts` (alphabetical).
      **Modify** `packages/agent/src/tasks/job-runtime.providers.ts` and `packages/tasks/src/trigger/trigger.module.ts` —
      bind the three dispatchers to the active runtime.
      **Added (APW06-G02).** `TriggerService` gains `dispatchAppDeploy`, `dispatchAppSmoke` and `dispatchAppClusterOp`
      that **propagate** errors and never return `null` on a throw; `dispatchersFromTenantClient` mirrors them with the
      propagate shape `kb-reembed-work` uses, not `softDispatch`; their ids join `TASK_IDS`, the three symbols join
      `DISPATCHER_SYMBOLS`, and the arity pin in
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts:134-143` is updated — count it off the merged
      list (14 at HEAD after AW-22), not by adding branch numbers.
      **Test**: `packages/agent/src/tasks/tasks.spec.ts` green;
      `packages/agent/src/tasks/__tests__/app-cluster-op-dispatcher.spec.ts`
      _(new)_ — dispatchers refuse in production when `isClusterWorkerIsolated()` is false (`worker_not_isolated`)
      (ACC-06-04); a registry that resolves `null` returns `worker_not_isolated` with no `WorkDeployment` row and no
      in-process call, in every environment (APW06-G02); the tenant dispatcher propagates a thrown dispatch error;
      the verification payloads round-trip through the dispatcher.
      **Done when**: `pnpm --filter @ever-works/agent test -- tasks.spec app-cluster-op-dispatcher` is green, the arity
      spec is updated rather than loosened, and no call site imports `@trigger.dev/sdk`.

- [ ] **T32. Trigger tasks.**
      **Create** `packages/tasks/src/tasks/trigger/app-deploy.task.ts` (`maxDuration: 7200`, `retry.maxAttempts: 1`,
      `onFailure`), `app-smoke.task.ts` (`maxDuration: 900`), `app-cluster-op.task.ts` (`maxDuration: 900`; the
      dispatcher passes `maxDuration: 3600` for `verification-deploy`),
      `app-health-poll.task.ts` (`schedules.task`, `cron: '* * * * *'`, guarded by `DistributedTaskLockService`) — all
      on queue `app-cluster-io` (`concurrencyLimit: 20`). **Every one of them boots `TriggerAppRuntimeModule` (T71)**,
      which is what sets the worker-context flag T20 checks; `app-cluster-op.task.ts` delegates to the router (T70).
      **Create** `packages/tasks/src/tasks/trigger/app-runtime-local-worker.ts` _(new)_ — the
      `app-runtime:local-worker` entry point (an npm script in `packages/tasks/package.json`) that boots
      `TriggerAppRuntimeModule` and drains the same exported task run functions from a local queue. It refuses to start
      when `NODE_ENV=production`.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts`.
      **Test**: `packages/tasks/src/__tests__/app-deploy.task.spec.ts` and `app-health-poll.task.spec.ts` _(new)_ with
      mocked orchestrators — `onFailure` marks `ERROR (worker_failed)` and releases the lock; the poll task exits when the
      lock is held; every task declares queue `app-cluster-io` and boots `TriggerAppRuntimeModule`; the local-worker entry
      exits non-zero under `NODE_ENV=production`.
      **Done when**: `pnpm --filter @ever-works/trigger-tasks test` is green and the tasks package builds and lists the
      four ids.

## P1.6 — API

- [ ] **T33. App runtime module and controller.**
      **Create** `apps/api/src/app-runtime/app-runtime.module.ts`, `app-runtime.controller.ts`, `dto/*.dto.ts` _(new)_ with
      every route of [plan §9.1](./plan.md) (incl. `GET :id/app-deletion-preview`, the `POST :id/app-target/check` body
      and the response shapes of plan §9.1's "Response shapes" block); `AppWorkAccessService.resolve` (view for GET,
      edit for the rest), called **before** the kind check; throttles; 202 shapes; 422 `APP_DEPLOY_PRECONDITIONS` and
      `APP_TARGET_REFUSED`; typed-slug check for `deleteData`; 409 `APP_WORK_DELETING`.
      **Create** `apps/api/src/app-runtime/app-runtime-ports.module.ts` _(new)_ — the `@Global()` module of plan §9.8 that
      provides and exports `APPS_TIER_POLICY`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_ENV_SOURCE`,
      `APP_RUNTIME_TARGET`, `APP_RUNTIME_EVENT_SINK`, `APP_VERIFICATION_SINK` and `APP_WORK_DELETION_PORT` with their
      disabled/unavailable defaults (APW06-G12). It is the single provider for each token; the owning epics replace the
      binding there (T44 replaces the tier policy binding in **this** file, never in `app-runtime.module.ts`).
      **Modify** `apps/api/src/api.module.ts` — import both modules.
      **Test**: `apps/api/src/app-runtime/app-runtime.controller.spec.ts` — every route × {202/200, 404 foreign, 403 viewer
      on actions, 409, 422, 429} (ACC-06-40); unmet preconditions → 422 listing every code and nothing dispatched
      (ACC-06-19); manual deploy during a run → 409 (ACC-06-21); `GET app-status` returns every FR-46 field, `stale: true`
      after 180 s, the in-flight `ops[]` entries and refresh 429 inside 15 s (ACC-06-31, ACC-06-55); `app-lifecycle remove`
      with `deleteData` and a wrong slug → 422,
      without `deleteData` → 202 keeping data (ACC-06-36); `app-jobs/:name/run` while active → 409 (ACC-06-37);
      `app-deletion-preview` lists names and sizes only; kind ≠ `app` → 400 on `POST :id/deploy`; **`app-target/check` with
      a kubeconfig performs one settings write and one `cluster-check` dispatch with no kubeconfig in the payload, while
      spies on `PluginValidationService.tryValidateConnection` and on the plugin's `validateConnection` record zero calls
      (ACC-06-02, ACC-06-56); a `PUT app-target` that changes the target or fingerprint calls `reconcile` once and
      dispatches `prepare-namespace` once, while an unchanged PUT calls neither (GAP-05, ACC-06-54); the access cases of
      ACC-06-57 with the real `AppWorkAccessService` over stubbed repositories**.
      `apps/api/src/app-runtime/__tests__/app-runtime-ports.module.spec.ts` _(new)_ — the module is global and exports all
      seven tokens; the deletion-port provider has `useExisting` and `useClass` undefined and `inject` equal to
      `[ModuleRef]`; a reduced graph that does **not** import the module still injects a defined
      `@Optional() @Inject(APP_WORK_DELETION_PORT)` whose `requestDeletion` delegates to `AppRuntimeDeletionService`
      (APW06-G12).
      **Done when**: `pnpm --filter ever-works-api test -- app-runtime.controller app-runtime-ports.module` is green and no
      controller method awaits a plugin call.

- [ ] **T34. Delegation from existing routes.**
      **Modify** `apps/api/src/plugins-capabilities/deploy/deploy.service.ts` — kind-`app` branch next to the `repo`
      refusal delegating to `AppDeployRequestService.request()` before any website-repository work.
      **Modify** `apps/api/src/plugins-capabilities/deploy/deploy.controller.ts` — `deploy` and `rollback` delegate for
      kind `app` and skip `deploymentVerifier.startVerification`. **Modify**
      `apps/api/src/plugins-capabilities/deploy/managed-subdomain.service.ts` — kind `app` delegates to T48's branch.
      **Modify** `apps/api/src/plugins/plugins.controller.ts` (added, APW06-G01) — when the Work's kind is `app` and the
      plugin has the `deployment` capability, `updateWorkPluginSettings` **skips**
      `PluginValidationService.tryValidateConnection` and returns `validation: null`, because that call reaches
      `KubernetesPlugin.validateConnection` and dials the pasted cluster from the API process before the §6.1 guard.
      Non-app Works are byte-identical to today.
      **Test**: extend `apps/api/src/plugins-capabilities/deploy/deploy.service.spec.ts` and `deploy.controller.spec.ts` —
      kind `app` performs zero Actions secret pushes and zero workflow dispatches; every existing test unchanged
      (ACC-06-43). Extend `apps/api/src/plugins/plugins.controller.spec.ts` — PATCH settings on a kind-`app` Work calls
      `tryValidateConnection` **0** times and `KubeConfig.loadFromString` 0 times; on a website Work it is called once,
      unchanged (ACC-06-56).
      **Done when**: `pnpm --filter ever-works-api test -- deploy.service deploy.controller plugins.controller deploy.e2e`
      is green with `deploy.e2e.spec.ts` unchanged.

- [ ] **T35. Build-succeeded trigger and spec-applied trigger.**
      **Create** `apps/api/src/app-runtime/app-build-succeeded.listener.ts` _(new)_ — consumes APW-05's
      `AppBuildFinishedEvent` (CONTRACTS §2A) on `app.build.succeeded` for the spec's deploy branch, when `autoDeploy`
      (or the Build named by `pendingDomainRebuildBuildId`) and target ≠ `none`. It requests a Build-triggered Deployment
      when `deployable: true` and `branch` is the deploy branch, or a `domain-change` Deployment when
      `buildId === pendingDomainRebuildBuildId` (then clearing the marker). `deployable: false` never requests a
      Deployment, and `app.build.failed` / `app.build.cancelled` for the marked Build clears the marker and requests
      nothing (APW06-G11).
      **Create** `apps/api/src/app-runtime/app-spec-applied.listener.ts` _(new)_ and
      `packages/agent/src/app-runtime/app-image-reference.resolver.ts` _(new)_ (added, APW06-G04): the listener starts a
      `spec-applied` Deployment when the strategy is `image`, `autoDeploy` is on, the target is not `none` and the changed
      blocks intersect `APP_IMAGE_REDEPLOY_BLOCKS`; the resolver performs the anonymous registry `HEAD`, resolves a tag to
      a digest once, and returns the `image_not_found` / `image_private_unsupported` / `image_unresolvable` code.
      **Test**: `apps/api/src/app-runtime/app-build-succeeded.listener.spec.ts` _(new)_ — other branches ignored;
      `autoDeploy: false` ignored unless a rebuild is pending; target `none` makes zero deploy requests and zero facade
      calls, so Builds still complete with no cluster call (ACC-06-01); a non-deployable succeeded event on the deploy
      branch requests nothing. `apps/api/src/app-runtime/app-spec-applied.listener.spec.ts` _(new)_ — changed blocks that
      change nothing that runs, `autoDeploy` off, target `none` and strategy `dockerfile` each request nothing;
      `packages/agent/src/app-runtime/__tests__/app-image-reference.resolver.spec.ts` _(new)_ — digest existence, tag
      resolution recorded as `resolvedFromTag`, and one case per registry answer (ACC-06-52, ACC-06-53).
      **Done when**: `pnpm --filter ever-works-api test -- app-build-succeeded.listener app-spec-applied.listener` and
      `pnpm --filter @ever-works/agent test -- app-image-reference.resolver` are green and a green Build on the
      deploy branch produces exactly one `app.deploy.started`.

## P1.7 — Web

- [ ] **T36. Client, actions, BFF.**
      **Create** `apps/web/src/lib/api/app-runtime.ts` (`server-only`), `apps/web/src/app/actions/dashboard/app-runtime.ts`,
      `apps/web/src/app/api/works/[id]/app-status/route.ts` _(new; cookie auth like the existing deploy status route)_.
      **Added (APW06-G01).** `apps/web/src/lib/api/app-runtime.ts` gains
      `checkAppTarget(workId, { kubeconfig, kubeContext })`, and the client types carry no kubeconfig or env value.
      **Test**: `apps/web/src/app/api/works/[id]/app-status/route.unit.spec.ts` _(new)_ — 401 without session; passes
      through `stale` and every FR-46 field (ACC-06-31).
      **Done when**: `pnpm --filter ever-works-web test -- app-status/route` is green and no kubeconfig or env value type
      exists in the web client types.

- [ ] **T37. Deploy page branch, target card, connect dialog.**
      **Modify** `apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx` — kind `app` renders `AppDeployPage`
      before the website-repository redirect.
      **Create** `apps/web/src/components/works/detail/deploy/app/AppDeployPage.tsx`, `AppTargetCard.tsx`,
      `ConnectClusterDialog.tsx`, `ClusterCheckResult.tsx`, `AppLicenseAttestationDialog.tsx` _(new)_ (spec §6.1–§6.2;
      target label **None — don't deploy yet**, R-12; **Deploy now** checkbox default on; attestation through APW-03's
      `POST /api/works/:id/app-license/attest`, R-3).
      **Test**: `apps/web/src/components/works/detail/deploy/app/AppTargetCard.unit.spec.tsx` _(new)_ — target None
      renders the S1 copy and the label "None — don't deploy yet" (ACC-06-01); Ever Works Apps disabled with its reason
      when off or ineligible (ACC-06-38). `ConnectClusterDialog.unit.spec.tsx` _(new)_ — Save disabled while a required
      permission is missing (ACC-06-05); refusal reasons render (ACC-06-02); switching isolation off shows the warning
      (ACC-06-17); **it sends the kubeconfig only through `checkAppTarget` (T36) and the unit spec asserts the generic
      work-plugin-settings action is never called (APW06-G01, ACC-06-56)**. `AppLicenseAttestationDialog.unit.spec.tsx`
      _(new)_ — a `403` renders "Only the App Work's owner can
      attest." and the request body is APW-03's (ACC-06-39).
      **Done when**: `pnpm --filter ever-works-web test -- AppTargetCard ConnectClusterDialog AppLicenseAttestationDialog`
      is green and non-app Works render the Deploy tab byte-identically (snapshot).

- [ ] **T38. Live card, progress, components, smoke, jobs, cron.**
      **Create** `apps/web/src/components/works/detail/deploy/app/AppLiveCard.tsx`, `AppDeployButton.tsx`,
      `AppDeployProgress.tsx`, `AppComponentsTable.tsx`, `AppSmokeResults.tsx`, `AppJobsList.tsx`, `AppCronList.tsx`,
      `AppSourceOffer.tsx` _(new)_.
      **Test**: `apps/web/src/components/works/detail/deploy/app/AppDeployProgress.unit.spec.tsx` _(new)_ — polls every
      3 s during a Deployment and 30 s otherwise and stops on unmount; the precondition list renders one row per code with
      its fix link (ACC-06-19). `AppLiveCard.unit.spec.tsx` _(new)_ — "Last checked <n> minutes ago" after 180 s
      (ACC-06-31); Source link only when `sourceOffer.required` (ACC-06-30).
      **Done when**: `pnpm --filter ever-works-web test -- AppDeployProgress AppLiveCard` is green and every state and phase
      key renders translated text.

- [ ] **T39. History, rollback, logs, danger zone.**
      **Create** `apps/web/src/components/works/detail/deploy/app/AppHistoryTable.tsx`, `AppRollbackDialog.tsx`,
      `AppLogsDrawer.tsx`, `AppDangerZone.tsx` _(new)_.
      **Test**: `apps/web/src/components/works/detail/deploy/app/AppHistoryTable.unit.spec.tsx` _(new)_ — Rollback shown
      only on Live rows among the last 20 with an existing image, and the dialog shows the disclaimer (ACC-06-23);
      an `image`-strategy row shows the short digest instead of a Build link (ACC-06-52).
      `AppDangerZone.unit.spec.tsx` _(new)_ — remove with data enables only on the exact slug (ACC-06-36); pause disabled
      during a Deployment with the S27 copy (ACC-06-35). `AppLogsDrawer.unit.spec.tsx` _(new)_ — nothing written to local
      storage.
      **Done when**: `pnpm --filter ever-works-web test -- AppHistoryTable AppDangerZone AppLogsDrawer` is green.

- [ ] **T40 (parallel with T39). Overview health card.**
      **Create** `apps/web/src/components/works/detail/overview/AppHealthCard.tsx` _(new)_; **Modify**
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` to render it for kind `app`.
      **Test**: `apps/web/src/components/works/detail/overview/AppHealthCard.unit.spec.tsx` _(new)_ — out-of-memory line
      only within 24 h; Source link only when the offer applies (ACC-06-30).
      **Done when**: `pnpm --filter ever-works-web test -- AppHealthCard` is green and other kinds' Overview is unchanged.

- [ ] **T41. i18n.**
      **Modify** `apps/web/messages/en.json` — sub-trees of [plan §10.3](./plan.md); mirror keys into the 20 other locale
      files in `apps/web/messages/`.
      **Test**: `node apps/web/scripts/sync-locale-parity.mjs && git diff --exit-code apps/web/messages` adds zero keys
      (ACC-06-44); a grep over the new leaves finds no `.`.
      **Done when**: both commands exit 0 and no string literal remains in the new components.

- [ ] **T42. Playwright.**
      **Create** `apps/web/e2e/flow-app-deploy-target.spec.ts`, `apps/web/e2e/flow-app-deploy-lifecycle.spec.ts`,
      `apps/web/e2e/flow-app-deploy-domains.spec.ts` _(new)_ (BFF-mocked). Wire the kind-cluster scenarios into APW-13's
      `apps/web/e2e/flow-app-works-kind-runtime.spec.ts` rows for ACC-06-06, -10, -11, -12, -15, -18, -25, -35, -36, -45,
      -47, -48 (APW-13 owns that file; this task adds rows through its owner). **Modify**
      `apps/web/e2e/flow-app-deploy-target.spec.ts` to cover the published-image strategy's two refusals and the
      dependency-before-first-Deployment ordering of ACC-06-54 through mocks (APW06-G04, GAP-06).
      **Test**: `pnpm --filter ever-works-web test:e2e flow-app-deploy-` — target: None copy (ACC-06-01), refused
      kubeconfig (ACC-06-02), missing permission blocks Save (ACC-06-05), Ever Works Apps refused while off (ACC-06-38);
      lifecycle: rollback dialog (ACC-06-23), pause/resume and refused pause during a Deployment (ACC-06-35), remove with
      typed slug (ACC-06-36); domains: verify publishes without a restart request (ACC-06-25), primary change
      restart/rebuild (ACC-06-26).
      **Done when**: the three specs pass locally and in `e2e.yml`, and the existing `flow-work-deploy-*.spec.ts` suites pass
      unchanged.

- [ ] **T43. P1 docs and ship gate.**
      **Create** `docs/features/app-runtime.md` _(new)_ — targets, service-account recipe with the plan §6.3 permission
      list, what gets applied, TLS modes, the managed subdomain, smoke, rollback, health, pause/remove, deleting an App
      Work, source offer. **Modify** `apps/docs/sidebarsPlatform.ts`. **Modify** `docs/specs/features/app-works/TRACKER.md`
      APW-06 row and, through its owner, the APW-06 table in `docs/specs/features/app-works/ACCEPTANCE.md` with
      ACC-06-01…49.
      **Test**: `pnpm --filter ever-works-docs build`; root `pnpm format:check`, `pnpm lint`, `pnpm type-check`,
      `pnpm test`, `pnpm build`.
      **Done when**: every command exits 0 and spec ACC-06-01…49 except the P2 rows (-38 managed half, -49) and the P3 row
      (-42) are walked on a kind cluster.

## P1.8 — Managed subdomain on Your cluster (moved from P2 by Resolution R-16)

- [ ] **T47. Apps-domain DNS.**
      **Create** `packages/agent/src/ever-works-providers/apps-domain-dns.service.ts` _(new)_ (plan §8.3).
      **Test**: `packages/agent/src/ever-works-providers/__tests__/apps-domain-dns.service.spec.ts` _(new)_ — **apex unset
      → the platform domain is used as the default root and managed subdomains ARE offered** (ACC-06-27, owner decision
      2026-09-17); a malformed apex → `null` provider and managed subdomains hidden; a **dedicated** apex equal to, under
      or above the platform domain → `null` while the shared default does not trip this check (ACC-06-27); configured →
      `rootDomain()` equals the apps domain; the apps-domain DNS configuration (`EVER_WORKS_APPS_DNS_ZONE_ID` /
      `EVER_WORKS_APPS_DNS_API_TOKEN`) is the only DNS configuration it reads — on the shared default it resolves the
      zone for the platform domain, and it never silently falls back to the platform's _own_ DNS provider instance.
      **Done when**: `pnpm --filter @ever-works/agent test -- apps-domain-dns.service` is green and `EverWorksDnsService`
      is untouched.

- [ ] **T48. Managed subdomain for App Works.**
      **Modify** `apps/api/src/plugins-capabilities/deploy/managed-subdomain.service.ts` — kind-`app` branch: allocator with
      apps DNS ops, label ≥ 3, `editable` per target settings, rename → onChange (T26).
      **Modify** `packages/agent/src/app-runtime/app-hosts.service.ts` — the managed subdomain as a host (primary only when
      no custom domain is primary, plan §8.1); `dns-reconcile` op in `app-cluster-op` writes `A`/`CNAME` unproxied only for a
      public ingress address (guard from T11) on `your-cluster`; the health poll re-validates every 10th poll and withdraws a
      non-public target.
      **Create (added, APW06-G14).** `packages/agent/src/app-runtime/app-managed-host-root.resolver.ts` _(new)_ with
      `AppManagedHostRootResolver implements ManagedHostRootResolver`: for kind `app` it returns
      `config.everWorks.apps.getDomain()` (null when unset or rejected by the plan §8.3 boot validation, in which case
      the launcher skips the managed-subdomain candidate and falls back to the latest READY Deployment's address); for
      any other kind it delegates to APW-11's `DefaultManagedHostRootResolver`. **Modify**
      `packages/agent/src/app-runtime/index.ts` (export) and `apps/api/src/app-runtime/app-runtime-ports.module.ts` /
      `app-runtime.module.ts` — provide `MANAGED_HOST_ROOT_RESOLVER` with `useClass: AppManagedHostRootResolver`,
      visible to APW-11's `AppLauncherService` (a typed fake of the token until APW-11 lands). This is a **P1.8** deliverable
      (R-16 moved the apps-domain subdomain to Wave 1); APW-11 tasks.md line 401 is updated by its owner from "APW-06 P2" to
      "APW-06 T48 (P1.8)".
      **Test**: extend `apps/api/src/plugins-capabilities/deploy/managed-subdomain.service.spec.ts` — kind `app` allocates
      under the **configured** apps domain, which defaults to `EVER_WORKS_DOMAIN` (so `<slug>.ever.works` is the expected
      default and asserting it is the point of the case), and never under another Ever product's domain (ACC-06-27).
      Extend `packages/agent/src/app-runtime/__tests__/app-hosts.service.spec.ts` — a private ingress address never
      produces a record, a changed public address updates it and a non-public one withdraws it (ACC-06-28); a first
      `your-cluster` Deployment's hosts include `<slug>.<apps-domain>` on the default apex **and** with a dedicated apex,
      while only a switched-off or invalid managed shape leaves custom domains alone (ACC-06-47).
      `packages/agent/src/app-runtime/__tests__/app-managed-host-root.resolver.spec.ts` _(new)_ — kind `app` with the
      apps domain set returns it; unset or invalid returns null; for kind `app` the result never equals or ends with
      `EVER_WORKS_DOMAIN`; kind `website` returns `EVER_WORKS_DOMAIN` (APW06-G14).
      **Done when**: `pnpm --filter ever-works-api test -- managed-subdomain.service` and
      `pnpm --filter @ever-works/agent test -- app-hosts.service app-managed-host-root.resolver` are green, every allocated
      label sits under the configured apps domain — the platform domain when it is the default, a dedicated apex when one is
      configured — and no App Work launcher address resolves under `EVER_WORKS_DOMAIN`.

---

# Phase P2 — Ever Works Apps for verified Blueprints (Wave 2)

_Delivers FR-7, FR-8, FR-22 and FR-40 on the managed target. Starts only after APW-10's P2 gate provides an
`AppsTierPolicy` and the `apps-tier` deployment plugin (R-5). T47 and T48 moved to P1.8 (R-16)._

- [ ] **T44. Tier policy binding.**
      **Modify** `apps/api/src/app-runtime/app-runtime.module.ts` — bind `APPS_TIER_POLICY` to APW-10's implementation when
      present; keep `DisabledAppsTierPolicy` otherwise.
      **Test**: extend `apps/api/src/app-runtime/app-runtime.controller.spec.ts` — with the disabled policy
      `PUT app-target { target: 'ever-works-apps' }` → 422 `managed_disabled` (ACCEPTANCE NEG-03); with scope
      `verified-blueprints` a provisioned App Work → `managed_scope_unverified_blueprint`; `eligibility` false →
      `managed_ineligible`; `podPolicy().runtimeClassName === null` → `managed_sandbox_unavailable` (R-24) (ACC-06-38); the
      fake tier plugin receives zero calls in each refused case.
      **Done when**: `pnpm --filter ever-works-api test -- app-runtime.controller` is green.

- [ ] **T45. Quota.**
      **Create** `packages/agent/src/ever-works-providers/ever-works-apps-quota.service.ts` _(new)_ + counter token (plan
      §9.5); call from `PUT app-target` and inside the lock claim.
      **Test**: `packages/agent/src/ever-works-providers/__tests__/ever-works-apps-quota.service.spec.ts` _(new)_ — 4th App
      Work refused with the three counted Works named; two concurrent claims for the 3rd and 4th → exactly one succeeds;
      fails closed when the policy is open and the counter missing (ACC-06-38); paused App Works count, removed ones do not.
      **Done when**: `pnpm --filter @ever-works/agent test -- ever-works-apps-quota.service` is green.

- [ ] **T46. Managed target through the tier (re-scoped by Resolution R-5).**
      **Modify** `packages/agent/src/app-runtime/app-render-input.builder.ts` — for `ever-works-apps` fill `policy` from
      `AppsTierPolicy.podPolicy()` / `ingress()` (restricted labels, quota, `runtimeClassName`, `cpuLimit` default,
      cron ≥ 5 minutes, `requireIsolationEnforced`, `scaleFailedFirstDeployToZero`, `tls: 'edge'`) as **desired state for the
      tier** — the platform applies none of it. **Modify** `packages/agent/src/app-runtime/app-deploy.orchestrator.ts` —
      hand the render input to the `apps-tier` deployment plugin selected in T20 with the credential from
      `AppsTierPolicy.resolveClusterCredential`; map tier refusals (`isolation_not_enforced`, admission refusals) to
      `ERROR` with codes. **Modify** `packages/plugins/k8s/src/app/app-manifest.renderer.ts` and `app-security.ts` only to
      keep the managed variant as pure library output for APW-10's controller (no apply path).
      **Create** `packages/agent/src/app-runtime/app-image-config.reader.ts` _(new)_ (plan §4.4): image config `User` read
      in the worker before handing over → `managed_root_forbidden` / `image_user_unverifiable` on `ever-works-apps`.
      **Test**: extend `packages/plugins/k8s/src/app/__tests__/app-manifest.renderer.spec.ts` with managed-variant fixtures
      (restricted labels, quota, runtime class). Extend `packages/agent/src/app-runtime/__tests__/app-deploy.orchestrator.spec.ts`
      — `ever-works-apps` calls the tier plugin's `deployApp` once, the `k8s` plugin fake records zero calls and zero applied
      objects, and a tier `isolation_not_enforced` refusal ends `ERROR` (ACC-06-49).
      `packages/agent/src/app-runtime/__tests__/app-image-config.reader.spec.ts` _(new)_ — OCI index, single manifest,
      `User` empty / `0` / `root` / `nextjs` / `10001`, registry timeout; root refused before any tier call (ACC-06-08).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy.orchestrator app-image-config.reader` and
      `pnpm --filter @ever-works/k8s-plugin test -- app-manifest.renderer` are green, and ACCEPTANCE E2E-10 (b) assertions
      pass against the fake tier.

- [ ] **T49. Web for P2.**
      **Modify** `apps/web/src/components/works/detail/deploy/app/AppTargetCard.tsx`, `ConnectClusterDialog.tsx`,
      `apps/web/src/components/works/detail/deploy/SubdomainManagement.tsx` (App branch copy for edge-owned managed
      hostnames), messages in all 21 files under `apps/web/messages/`.
      **Test**: extend `apps/web/src/components/works/detail/deploy/app/AppTargetCard.unit.spec.tsx` — managed target
      states disabled, scope refused, ineligible, sandbox unavailable, quota reached, available (ACC-06-38); extend
      `apps/web/e2e/flow-app-deploy-target.spec.ts` with the managed path against mocks.
      **Done when**: `pnpm --filter ever-works-web test -- AppTargetCard` and `pnpm --filter ever-works-web test:e2e
flow-app-deploy-target` are green.

- [ ] **T50. P2 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — tick APW-06 P2.
      **Test**: ACC-06-38 (managed half) and ACC-06-49 walked on stage behind APW-10's gate; root `pnpm format:check`,
      `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`.
      **Done when**: both criteria are recorded green and every root command exits 0.

---

# Phase P3 — Any App Work on the managed tier, preview Deployments (Wave 3)

_Delivers FR-7 (scope `any`), FR-52, FR-53._

- [ ] **T51. Scope `any`.**
      **Modify** `packages/agent/src/app-runtime/app-deploy-preconditions.service.ts` — honour `managedScope() === 'any'`
      (the sandboxed-runtime precondition from T44 already applies since Wave 2, R-24).
      **Test**: extend `packages/agent/src/app-runtime/__tests__/app-deploy-preconditions.service.spec.ts` — a provisioned
      App Work is accepted when scope is `any` and the tier reports a runtime class, refused when it reports none
      (ACC-06-38).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy-preconditions.service` is green and scope
      `verified-blueprints` behaviour is unchanged.

- [ ] **T52. Preview Deployments.**
      **Modify** `packages/agent/src/app-runtime/app-deploy-request.service.ts`, `app-render-input.builder.ts`,
      `app-hosts.service.ts` — trigger on a green Build of a same-repository pull request head when
      `targetSettings.previews` and flag `works-app-previews`; `environment = preview`, `prNumber`, namespace `<ns>-pr<n>`,
      host `pr-<n>-<label>.<apps-domain>`, replicas 1, no CronJobs, `emptyDir` volumes, env context `preview`; refuse when
      `AppRuntimeEnvSource` cannot provision preview dependencies (`preview_dependencies_unavailable`) and comment the
      reason on the pull request through the Git facade.
      **Test**: extend `packages/agent/src/app-runtime/__tests__/app-deploy-request.service.spec.ts` — fork pull requests
      ignored; 4th concurrent preview refused; production dependencies never referenced (sentinel check on env values)
      (ACC-06-42).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-deploy-request.service` is green and a preview never
      shares a namespace, Secret or dependency with the live app.

- [ ] **T53. Preview garbage collection.**
      **Create** `packages/tasks/src/tasks/trigger/app-preview-gc.task.ts` _(new)_ (`*/5 * * * *`) and
      `packages/agent/src/app-runtime/app-preview-gc.service.ts` _(new)_ — remove within 10 minutes of close/merge and after
      72 h without a push; `destroyApp(…, { deleteVolumes: true })` for previews only, after APW-07 deprovisions preview
      dependencies.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-preview-gc.service.spec.ts` _(new)_ — closed 9 min ago kept,
      11 min ago removed (tick cadence 5 min ⇒ ≤ 10 min); idle 71 h kept, 73 h removed (ACC-06-42); a query-level test
      proves GC never selects a non-preview Deployment.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-preview-gc.service` is green.

- [ ] **T54. Preview UI and ship gate.**
      **Modify** `apps/web/src/components/works/detail/deploy/app/AppTargetCard.tsx` (Previews toggle),
      `AppHistoryTable.tsx` (preview rows with pull request link), messages in all 21 locale files;
      `docs/specs/features/app-works/TRACKER.md` (tick P3).
      **Create** `apps/web/e2e/flow-app-deploy-previews.spec.ts` _(new)_.
      **Test**: `pnpm --filter ever-works-web test:e2e flow-app-deploy-previews` — a preview row links its pull request and
      disappears after close (mocked) (ACC-06-42); ACC-06-42 walked on stage; root checks.
      **Done when**: the spec is green, ACC-06-42 is recorded and root `format / lint / type-check / test / build` pass.

---

# Cross-phase closing tasks

- [ ] **T55. Telemetry.**
      **Create** `packages/agent/src/app-runtime/app-runtime.telemetry.ts` _(new)_ emitting, through the existing monitoring
      package, deploy requested/started/outcome (with phase and code), rollback outcome, smoke outcome by classification,
      health transitions, cluster check outcome, lifecycle actions, App Work deletion outcome.
      **Modify** `packages/agent/src/app-runtime/app-deploy.orchestrator.ts`, `app-health.service.ts`,
      `app-runtime-deletion.service.ts` to call it.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-runtime.telemetry.spec.ts` _(new)_ — no payload contains a
      hostname, URL, namespace, env name, env value, kubeconfig fragment or log text.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-runtime.telemetry` is green.

- [ ] **T56. Security review pass.**
      **Modify** `docs/specs/features/app-works/APW-06-app-runtime/plan.md` §14 "Known gaps" if the review finds one.
      **Test**: a reviewer outside the epic walks plan §6, §4.4, §9.7 and §4.12 against the merged code; findings are
      recorded in the private operations repository, not in this public repository (program rule 10, R-14).
      **Done when**: every item in plan §14 is re-confirmed or a gap is added to plan §14 "Known gaps".

- [ ] **T57. Statuses.**
      **Modify** `docs/specs/features/app-works/APW-06-app-runtime/spec.md`, `plan.md`, this file and
      `docs/specs/features/app-works/TRACKER.md` — `Implemented` / `Done`.
      **Test**: `rg -n "Status\*\*: \`Implemented\`|Status\*\*: \`Done\`" docs/specs/features/app-works/APW-06-app-runtime`
      lists all three files.
      **Done when**: the three files and the TRACKER row show the shipped status.

---

# Program audit follow-ups (added 2026-09-17)

- [ ] **T58. Deleting an App Work — runtime removal (Resolution R-15).**
      **Create** `packages/agent/src/app-runtime/app-runtime-deletion.service.ts` _(new)_ per [plan §9.7](./plan.md):
      `preview(workId)`, `requestDeletion({ workId, userId, deleteStoredData })` returning
      `{ status, target, reason? }` with status `pending` or `done` — the binding of APW-01's `APP_WORK_DELETION_PORT`
      (`packages/agent/src/app-works/app-work-deletion.port.ts`) — and the `delete-app-work` op handler (APW-07
      `onAppWorkDeleting` first, then `destroyApp` with `deleteVolumes` equal to `deleteStoredData`; on Ever Works Apps the
      `apps-tier` plugin maps it to APW-10's `removeWork(workId, { deleteData })`
      — managed DNS record removal, Activity `app.deploy.removed` with `kept[]` / `mayRemain[]`, 3 attempts over 15
      minutes, then APW-01's `completeAppWorkDeletion(workId)`). **Modify** `packages/agent/src/app-runtime/index.ts`
      (export), `apps/api/src/app-runtime/app-runtime-ports.module.ts` (provide `APP_WORK_DELETION_PORT` with a lazy
      `useFactory` + `inject: [ModuleRef]` resolving `AppRuntimeDeletionService` — **never** `useExisting`, because the
      port and `WorkLifecycleService` form a cycle) and
      `packages/tasks/src/tasks/trigger/app-cluster-op.task.ts` (route the op through T70's router). APW-01 calls
      `requestDeletion` from `WorkLifecycleService.deleteWork` (its task T39; typed fake here).
      **Added (APW06-G08, APW06-G12).** The `delete-app-work` op gets its cluster access for `onAppWorkDeleting` from
      T69's `AppRuntimeTargetResolver`, deprovisions APW-07 **before** deleting volumes on the Remove-with-data path,
      ends with `mayRemain[]` and deletes no volume when APW-07 reports `remaining`, and finishes by calling a remote
      proxy of `AppRuntimeDeletionService.finishDeletion(workId, { mayRemain })` — a method that runs in the API,
      resolves `WorkLifecycleService` through `ModuleRef` and calls `completeAppWorkDeletion(workId)`. Add the
      `finishDeletion` entry to `apps/api/src/trigger/trigger-internal.controller.ts` and the matching
      `createRemoteProxy` in `packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts`.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-runtime-deletion.service.spec.ts` _(new)_ — target `none` or
      never deployed → `{ status: 'done' }` and zero dispatches; a live App Work → claim + one `delete-app-work` dispatch
      and `{ status: 'pending' }`; a second request while pending → `pending` and zero new dispatches; the op calls APW-07
      before `destroyApp`, passes `deleteVolumes: false` by default, and calls `completeAppWorkDeletion(workId)` only after
      removal (ACC-06-45); with `deleteStoredData: true` dependencies are deprovisioned before
      `destroyApp(…, { deleteVolumes: true })` (ACC-06-46); three unreachable attempts spaced 5 minutes → completion with
      `mayRemain[]` (ACC-06-46); Activity rows carry names only; the keep path calls
      `onAppRemoved(workId, { deleteData: false })` **after** `destroyApp`, the data path calls
      `onAppRemoved(workId, { deleteData: true })` **before** it and aborts the volume delete when it reports
      `remaining` (APW06-G08); the port resolves to `AppRuntimeDeletionService` from a module graph that does not import
      the ports module (APW06-G12).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-runtime-deletion.service` is green.

- [ ] **T59. Deleting an App Work — API preview and dialog section (R-15).**
      **Modify** `apps/api/src/app-runtime/app-runtime.controller.ts` — `GET :id/app-deletion-preview`; every action route
      answers `409 APP_WORK_DELETING` while deletion is in progress.
      **Create** `apps/web/src/components/works/detail/deploy/app/AppDeleteStoredDataSection.tsx` _(new)_ — kept list, the
      **Also delete stored data** checkbox (unticked), typed slug, generated-values warning. **Modify**
      `apps/web/src/components/works/detail/settings/DeleteComponent.tsx` (created for kind `app` by APW-01 T39) — mount
      this section in place of APW-01's inline stored-data checkbox; the payload rule stays APW-01's
      (`delete_stored_data: true` only on the exact slug).
      **Test**: extend `apps/api/src/app-runtime/app-runtime.controller.spec.ts` — preview returns names and sizes only;
      deploy during deletion → 409 (ACC-06-45). `apps/web/src/components/works/detail/deploy/app/AppDeleteStoredDataSection.unit.spec.tsx`
      _(new)_ — checkbox unticked by default; the confirmation input appears only when ticked; the section reports
      `deleteStoredData: true` only on the exact slug (ACC-06-46).
      **Done when**: `pnpm --filter ever-works-api test -- app-runtime.controller` and
      `pnpm --filter ever-works-web test -- AppDeleteStoredDataSection` are green.

- [ ] **T60. Verification targets — `purpose: 'verification'` (Resolution R-10).**
      **Modify** `packages/plugins/k8s/src/app/app-deployer.ts`, `app-manifest.renderer.ts`, `app-lifecycle.ts`,
      `app-status.reader.ts` — plan §4.12 (namespace `verificationNamespaceName(ns, provisioningId, attempt)` with the
      purpose label and expiry annotation, no Ingress,
      TLS, CronJob, DNS or PVC; `emptyDir` volumes; in-namespace smoke only; destroy deletes the namespace).
      **Create** `packages/agent/src/app-runtime/app-verification-target.service.ts` _(new)_ — handlers for
      `verification-deploy`, `verification-status`, `verification-destroy` on `app-cluster-op` (registered in T70's
      router), env via
      `AppRuntimeEnvSource.resolveEphemeral({ target: 'cluster' })`, dependencies via APW-07
      `AppDependenciesService.provisionEphemeral(workId, <verification namespace>, kinds)` applied **after** the
      namespace and its policies and **before** the workloads (APW06-G08), results reported through
      `AppVerificationSink` (APW06-G09); no `WorkDeployment` row and no runtime-state write.
      **Test**: extend `packages/plugins/k8s/src/app/__tests__/app-deployer.spec.ts` and
      `app-manifest.renderer.spec.ts` — the verification variant renders zero Ingress, CronJob and PVC objects, sets the
      expiry annotation from `ttlMinutes`, runs smoke with `Host: <component>.<ns>.svc`, and `destroyApp` on it issues one
      namespace delete (ACC-06-48). `packages/agent/src/app-runtime/__tests__/app-verification-target.service.spec.ts`
      _(new)_ — zero `work_deployments` inserts, zero calls to the stored-value env path, and the returned status has
      components, jobs and smoke only (ACC-06-48); **exactly one `provisionEphemeral` call with the verification namespace
      and the declared kind set, zero `work_app_dependencies` writes, and one `AppVerificationSink.report` per phase
      carrying components, jobs and smoke only (APW06-G08, APW06-G09); a Work whose name would collide with a leftover
      attempt namespace from an earlier provisioning gets a different name (ACC-06-48)**.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-deployer app-manifest.renderer` and
      `pnpm --filter @ever-works/agent test -- app-verification-target.service` are green.

- [ ] **T61. Self-address (hairpin) check (spec FR-37, ACC-06-14).**
      **Modify** `packages/plugins/k8s/src/app/app-deployer.ts` and `app-jobs.renderer.ts` — plan §4.11 hairpin Job after
      publish when `network.needsHairpin` and a primary host exist; result into `smokeResult.hairpin`; warning
      `hairpin_unreachable`, never a rollback. **Modify**
      `apps/web/src/components/works/detail/deploy/app/AppSmokeResults.tsx` — hairpin row.
      **Test**: extend `packages/plugins/k8s/src/app/__tests__/app-jobs.renderer.spec.ts` — `renderRunnerJob('hairpin')` is
      created in the app namespace, targets `<scheme>://<primary host><path>` without a `Host` override (ACC-06-14). Extend
      `packages/plugins/k8s/src/app/__tests__/app-deployer.spec.ts` — `needsHairpin: true` renders one hairpin Job after the
      Ingress apply and a failing one yields `succeeded-with-warnings`; `needsHairpin: false` renders none (ACC-06-14).
      `apps/web/src/components/works/detail/deploy/app/AppSmokeResults.unit.spec.tsx` _(new)_ — the hairpin warning copy.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- app-jobs.renderer app-deployer` and
      `pnpm --filter ever-works-web test -- AppSmokeResults` are green.

- [ ] **T62. TLS modes and URL scheme (spec FR-41, FR-42, ACC-06-29).**
      **Modify** `packages/agent/src/app-runtime/app-hosts.service.ts` — `appUrlScheme(tls, hostKind)` (plan §4.11) used for
      `EVER_WORKS_APP_URL`, `domains.primary.url`, the Deploy tab URL and public smoke URLs.
      **Modify** `packages/plugins/k8s/src/app/app-manifest.renderer.ts` — TLS block lists every published host with the
      issuer annotation only for `cert-manager`.
      **Test**: extend `packages/agent/src/app-runtime/__tests__/app-hosts.service.spec.ts` — `cert-manager` → `https` for
      custom and managed hosts; `external` → `https` for custom, `http` for managed; `none` → `http` with warning
      `tls_disabled`; `edge` → `https` (ACC-06-29). Extend `packages/plugins/k8s/src/app/__tests__/app-manifest.renderer.spec.ts`
      — `cert-manager` renders a TLS block and issuer annotation; `external` and `none` render neither (ACC-06-29).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-hosts.service` and
      `pnpm --filter @ever-works/k8s-plugin test -- app-manifest.renderer` are green.

- [ ] **T63. Deploy tab accessibility and locale parity (ACC-06-44).**
      **Create** `apps/web/e2e/flow-app-deploy-a11y.spec.ts` _(new)_ — axe (as in `apps/web/e2e/accessibility-axe-deep.spec.ts`)
      on the App Deploy tab in the None, live and failed states and on the Connect, Rollback, Remove and Stored data dialogs;
      keyboard: every action reachable by `Tab`, `Esc` closes dialogs and returns focus.
      **Test**: `pnpm --filter ever-works-web test:e2e flow-app-deploy-a11y` reports no new violations, and
      `node apps/web/scripts/sync-locale-parity.mjs && git diff --exit-code apps/web/messages` adds zero keys (ACC-06-44).
      **Done when**: both commands exit 0 in the PR.

- [ ] **T64. Managed subdomain on Your cluster — web (R-16).**
      **Modify** `apps/web/src/components/works/detail/deploy/SubdomainManagement.tsx` (App branch: apps-domain suffix,
      on/off toggle, `http` warning when the TLS choice is not the issuer) and
      `apps/web/src/components/works/detail/deploy/app/AppLiveCard.tsx` (shows the managed URL when primary).
      **Test**: `apps/web/src/components/works/detail/deploy/SubdomainManagement.unit.spec.tsx` _(new)_ — kind `app` with an
      apps domain shows `<slug>.<apps-domain>`; without one the managed section is absent and custom domains remain;
      the `http` warning shows outside issuer mode (ACC-06-47). Extend `apps/web/e2e/flow-app-deploy-domains.spec.ts` with
      the managed-subdomain row (ACC-06-47).
      **Done when**: `pnpm --filter ever-works-web test -- SubdomainManagement` and
      `pnpm --filter ever-works-web test:e2e flow-app-deploy-domains` are green and non-app Works render
      `SubdomainManagement` unchanged.

- [ ] **T65 (P1, lands with T16–T18). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'app-runtime-states.jsonl', entity: 'WorkAppRuntimeState', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      `packages/agent/src/account-transfer/backup/redaction.ts` is **not** modified: `WorkAppRuntimeState` holds no
      credential (`clusterFingerprint` hashes the API server address and CA; `clusterCheck` is secret-free and
      `statusSnapshot` carries no log text, plan §7.2), and T16's `WorkDeployment` columns (`buildId`,
      `componentStatuses`, `smokeResult`, `appTarget`, `appRender`) ride the existing `works/deployments.jsonl` file
      with no secret-shaped name.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` —
      `WorkAppRuntimeState` is referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not
      dropped; `WorkDeployment` is still referenced once, by `deployments.jsonl`, and a fixture row with an `appRender`
      object is yielded unchanged. The new `WorkAppRuntimeState` columns (`cancelRequestedByUserId`,
      `pendingDomainRebuildBuildId`, `upstreamSyncJudgedToSha`) ride that file and need no redaction entry — none is a
      credential — and the fixture asserts they survive verbatim.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      with one deployed App Work lists `data/works/app-runtime-states.jsonl` with one record.

---

## P1.11 — The deploy-shape family stays whole (R-27, added 2026-09-17)

- [ ] **T66. Prove no shipped cluster source was narrowed.**
      **Modify** nothing in `apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.ts` — this task is a
      **regression proof** for the owner's B-01 answer: the matrix must still return `k8s-works` for a platform admin
      (admin-only org), `k8s-works-shared` always, and `custom-kubeconfig` for every owner outside the shared orgs,
      in that UI order, with the three labels and descriptions unchanged.
      **Test**: extend `apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.spec.ts` — the three sources and
      their exact labels/descriptions are asserted as a snapshot; a platform admin on a non-`ever-works` owner gets
      `['k8s-works-shared', 'custom-kubeconfig']`; a non-admin on an `ever-works` owner gets
      `['k8s-works-shared']`; no code path returns an empty list (ACC-06-50).
      **Done when**: `pnpm --filter ever-works-api test -- cluster-source-matrix` is green and the diff touches only the
      spec file.

- [ ] **T67. Prove one runtime, two configurations.**
      **Create** `packages/agent/src/facades/__tests__/deployment-context.resolver.spec.ts` _(new)_ — the resolver has no
      unit suite of its own today, only indirect coverage through `deploy.facade.spec.ts`.
      **Test**: for each shipped provider id (`k8s`, `ever-works`) crossed with each `ClusterSource`
      (`k8s-works-shared`, `custom-kubeconfig`), assert the resolved context differs only in credential/namespace
      handling and never in shape; a non-Kubernetes provider id (`vercel`) passes the token through untouched; a
      `custom-kubeconfig` with an empty kubeconfig fails with `DEPLOY_MATRIX_VIOLATION`/`PLATFORM_KUBECONFIG_MISSING`
      as today; the platform-managed sentinel resolves without an owner credential (ACC-06-51).
      **Done when**: `pnpm --filter @ever-works/agent test -- deployment-context.resolver` is green and
      `deploy.facade.spec.ts` is untouched.

- [ ] **T68. Record the shapes that are extension points, not shipped paths.**
      **Modify** `plan.md` — add a §8.4 pointer to [`deploy-shapes.md`](./deploy-shapes.md) and state that the
      connected-node deploy executor (shape F) and the SSH provider (shape G) are **recorded additions**, not
      deliverables of this epic, and that neither may be removed from the taxonomy when they are scheduled.
      **Test**: none (documentation). The file is cited from `CONTRACTS.md` R-27, `spec.md` §4.1 and the program README.
      **Done when**: `deploy-shapes.md` is linked from `plan.md`, `spec.md` and the README's artifact table, and every
      claim in it names the file and line it was verified against.

---

## P1.12 — Task edits for the medium findings of the 2026-09-17 fix pass

_These are **edits to tasks that already exist**, not new work: each one is the task-side half of a plan change above.
Apply them in place; do not renumber._

- **T11 (APW06-G20).** **Create** `packages/plugin/src/helpers/cluster-address-policy.ts` and its spec
  `packages/plugin/src/helpers/__tests__/cluster-address-policy.spec.ts`, which takes over the deny-CIDR cases
  (every CIDR, `::ffff:10.0.0.1`, `64:ff9b::a00:1`, a mixed public/private resolution, an allow-listed range accepted,
  the 10 s timeout, and `invalid` entries reported) — ACC-06-03. `pinKubeconfigServer(yaml, { allowlist, resolver?,
timeoutMs? })` imports `isPublicAddress` and `resolvePublicAddresses` from that helper, and the guard spec keeps the
  refusal, pinning and mocked-307 cases.
- **T14 (APW06-G20).** Each App method reads the allow-list once per call from
  `parsePrivateAllowlist(process.env.EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST)` and passes it to
  `pinKubeconfigServer`; a test asserts an allow-listed private API is accepted and a non-listed one refused, and that
  the plugin imports no agent config.
- **T15 (APW06-G19).** Use a **non-root** image for the worker (for example the nginx-unprivileged image with a sleep
  command) — a root `busybox` worker fails `image_runs_as_root` under FR-13 and the spec can never reach Live; make the
  Ingress-order and public-smoke assertions conditional on the ingress matrix leg (with `ingress: false` no Ingress is
  rendered and `no_ingress_controller` is the correct outcome); replace the fixed
  `isolationEnforced === false` with the §4.10 probe result and **name the CNI the workflow actually runs in the spec**
  instead of asserting that kindnet does not enforce NetworkPolicy.
- **T16 (APW06-G16).** Widen `DeploymentTriggerSource` in `packages/agent/src/entities/work-deployment.entity.ts` with
  `build`, `target-saved`, `domain-change` and `rollback` (`manual` and `scheduled` unchanged), and add
  `work_deployments.appTrigger`. Test that the two pre-existing values still behave as before.
- **T17 (APW06-G16, APW06-G15).** Every date column in the new entity is a nullable `TimestampColumn` (never
  `timestamp`/`timestamptz`), nullability and defaults are exactly as plan §7 states, and the entity metadata test
  asserts no `timestamp`/`timestamptz` column. `getOrCreate(workId, initialTarget)` is an insert-if-absent that takes
  T69's `deriveInitialAppTarget` value and **never overwrites an existing row**; add
  `packages/agent/src/app-runtime/app-initial-target.ts` and its spec (provider null ⇒ `none`; apps-capable cluster
  plugin ⇒ `your-cluster`; website-only plugin ⇒ `none`; managed value with the policy closed or unbound ⇒ `none`, open
  ⇒ `ever-works-apps`; a row already set by `PUT app-target` is not re-derived; two concurrent first reads create one
  row).
- **T18 (APW06-G16).** Both migrations are hand-written, idempotent `Table`/`TableColumn`/`TableIndex` DDL with
  `hasTable`/`hasColumn`/index-name guards in the style of `1791240000000-AddSafetyRailsCore.ts`; a generated draft is a
  starting point only and its dialect SQL is not committed. Test `up()` twice (the second is a no-op) then `down()` in
  the in-memory better-sqlite3 harness the sibling specs use (for example
  `apps/api/src/migrations/__tests__/AddAgentHaltReason.spec.ts`), plus the opt-in Postgres run with existing
  `work_deployments` rows; every `TimestampColumn` maps to a `bigint` column.
- **T29 (APW06-G17).** Create the five catalogue rows of plan §9.4 with their category, title, description, channels and
  `alternativeSurface`, and update the pinned counts **as an intentional edit**:
  `event-registry-coverage.spec.ts` needsYou 11 → 14, routine →
  `['agent_run_finished', 'app_recovered', 'work_generation_finished']`, signals 10 → 11 (digest unchanged, the default
  quiet-hours list unchanged, plus an assertion that the three new urgent rows require the opt-in), and
  `apps/api/src/notifications/notification-matrix.service.spec.ts` length 24 → 29 at both call sites with its title
  updated. Add `app-runtime-notifications.spec.ts` cases for the rollback-failed urgent notification, a second down
  streak creating a new notification, and `app_recovered` created while the down notification is still undismissed.
- **T34 (APW06-G15).** Bind `APP_DEPLOY_ROUTE_PORT` (`useExisting: AppDeployRequestService`) in T73's global ports
  module, visible to `DeployModule` without a cycle — do **not** add a second kind-`app` branch to
  `deploy.service.ts`; APW-01's branch delegates once the token is bound. The `DeployController` rollback, 202-shape and
  verifier-skip changes stay as written. With the binding, kind `app` never yields 409 `app_runtime_unavailable` and
  calls `AppDeployRequestService.request` exactly once; with the binding removed, the 409 returns.
- **T24/T25 (APW06-G16).** A `build` or `domain-change` request that finds the lock held creates its `WorkDeployment`
  immediately (`INITIALIZING`, UI **Queued**, with `buildId`, `appTarget`, `appTrigger`), sets `queuedDeploymentId` and
  `queuedBuildId` in the same transaction and marks any previously queued row `SUPERSEDED` with
  `appRender.supersededBy`. §5.6 step 7 becomes one compare-and-set that adopts the queued row's id and clears both
  queue columns, then dispatches **that** row — no new row is created. `manual`, `rollback` and `target-saved` are
  refused with 409 while the lock is held; `build` and `domain-change` are queued. Tests: three Build-triggered requests
  during one run leave two rows (one `SUPERSEDED`, one `INITIALIZING`), and after release the same `deploymentId` is
  dispatched with the row count unchanged.

## P1.13 — Namespace preparation, the op router, the isolated worker and published images (added 2026-09-17)

_Closes GAP-06 / APW07-G01 (the ordering cycle), APW06-G02, APW06-G03, APW06-G04 and APW06-G12. All P1; T69–T71 also
unblock APW-07 P1. Numbers continue from T68._

- [ ] **T69 (P1, lands with T6–T7 and T20). Namespace preparation and the runtime target resolver (GAP-06, APW07-G01, APW06-G08).**
      **Create** `packages/agent/src/app-runtime/app-runtime-target.resolver.ts` _(new)_ implementing
      `AppRuntimeTargetPort` (T3) per plan §9.9 —
      `resolve(workId)` → `{ target: 'your-cluster', kubeconfig, context, namespace, appLabels, clusterFingerprint }`
      or `{ target: 'ever-works-apps' | 'none', cluster: null }`, and
      `prepareDependencyTarget(workId)` → `{ ref, podLabels }` or
      `{ unavailable: 'target_none' | 'target_not_checked' | 'namespace_owned_elsewhere' | 'cluster_unreachable' }`.
      It is worker-only (`APP_CLUSTER_IO_IN_API`), resolves the credential as plan §5.6 step 3, computes or reads the
      namespace and persists it with a compare-and-set, and **calls `prepareAppNamespace` before returning a
      `your-cluster` target**. **Modify** `packages/agent/src/app-runtime/index.ts` (export) and
      `apps/api/src/app-runtime/app-runtime-ports.module.ts` (bind `APP_RUNTIME_TARGET`, T73).
      **Register** the `prepare-namespace` op on T70's router, dispatched from `PUT :id/app-target` (T33) and from
      `prepareDependencyTarget`; **Modify** `packages/agent/src/tasks/app-cluster-op.types.ts` for its payload.
      **Test**: `packages/agent/src/app-runtime/__tests__/app-runtime-target.resolver.spec.ts` _(new)_ — worker-only; the
      §6.1 guard runs on the kubeconfig; the namespace is persisted once and reused; a foreign-owned namespace is refused
      `namespace_owned_elsewhere`; `ever-works-apps` and `none` return `cluster: null`; no env kubeconfig is read (spies).
      `packages/agent/src/app-runtime/__tests__/app-prepare-namespace.spec.ts` _(new)_ — a Work with **no Deployment** gets
      its namespace, `LimitRange` and the three baseline policies and has `namespace` and `clusterFingerprint` persisted;
      a second call is a no-op; with isolation off the namespace and `LimitRange` are applied with zero `ew-*` policies;
      a later `deployApp` reuses the frozen name and adds `ew-allow-ingress` / `ew-allow-deps` (ACC-06-54).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-runtime-target.resolver app-prepare-namespace` is green,
      and APW-07's `app-dependencies.service.spec.ts` case "a Work with a declared Postgres and no Deployment reaches
      ready with zero `app-deploy` dispatches" passes against the typed fake.

- [ ] **T70 (P1, lands with T31–T32). The `app-cluster-op` router, the nine op handlers and `app-smoke` (APW06-G03).**
      **Create** `packages/agent/src/app-runtime/app-cluster-op.router.ts` _(new)_ — `handle(payload)` routes by `op`;
      T48, T58, T60 and T69 register their ops here and `app-cluster-op.task.ts` delegates to it.
      **Create** `packages/agent/src/app-runtime/app-lifecycle-ops.service.ts` _(new)_ — the nine handlers of plan §9.10
      (`status-refresh`, `logs`, `pause`, `resume`, `remove`, `cancel-deploy`, `job-run`, `cluster-check`,
      `ingress-reconcile`), each writing `CACHE_MANAGER` key `app-op:<workId>:<requestId>` (TTL 300 000 ms) and, where
      the plan says so, the runtime-state row; the `logs` handler writes `app-logs:<workId>:<requestId>` instead and
      **nothing to `work_deployments`, runtime state or Activity**.
      **Create** `packages/agent/src/app-runtime/app-smoke.service.ts` _(new)_ — plan §5.7.
      **Modify** `packages/agent/src/app-runtime/ports.ts` (the `AppRuntimeEventSink` binding the handlers emit through),
      `packages/agent/src/app-runtime/index.ts`, `packages/tasks/src/tasks/trigger/app-cluster-op.task.ts` and
      `packages/tasks/src/tasks/trigger/app-smoke.task.ts` (delegate to the router / the service).
      **Test**: `packages/agent/src/app-runtime/__tests__/app-lifecycle-ops.service.spec.ts` _(new)_ and
      `app-smoke.service.spec.ts` _(new)_ — refresh saves the snapshot and an unreachable cluster keeps the old one with
      `failed` (ACC-06-31); logs are cached under the Work-scoped key with TTL 300 000, write nothing to a repository or
      Activity, never leak a sentinel secret, and a foreign `requestId` misses (ACC-06-34); pause is refused while the
      lock is held and otherwise sets `paused` and emits `app.deploy.paused`; resume takes the lock, runs the rollout and
      smoke checks, then clears `paused` and emits `app.deploy.resumed`, re-dispatching when the wait exceeds the budget
      (ACC-06-35, FR-49); remove calls APW-07 before `destroyApp`, defaults `deleteVolumes: false` and sets `removedAt`
      (ACC-06-36); cancel is honoured only for the matching `deployLockId` (ACC-06-22); job-run uses the live image,
      refuses a concurrent run and re-dispatches a long one (ACC-06-37, FR-51); cluster-check writes
      `clusterCheck.fingerprint` and the observed `ingressAddress` and leaves `clusterFingerprint` untouched
      (ACC-06-05, ACC-06-54); ingress-reconcile calls `publishAppHosts` only, with zero `deployApp` calls (ACC-06-25);
      every op refuses `app_work_deleting`; for `ever-works-apps` the `k8s` plugin fake gets zero calls (R-5);
      `app-smoke` writes `smokeResult` and emits `app.smoke.*` with no rollback (ACC-06-55).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-lifecycle-ops.service app-smoke.service` and
      `pnpm --filter @ever-works/trigger-tasks test` are green, and every op in plan §9.2 has a handler or a named
      registering task.

- [ ] **T71 (P1, lands with T20 and T32). The isolated App runtime worker (APW06-G02).**
      **Status (2026-09-25, wave 2, worker-deploy-sources):** `TriggerAppRuntimeModule` binds `APP_DEPLOY_SPEC_SOURCE`
      to `createRemoteProxy(api, 'AppSpecService')` and `APP_DEPLOY_BUILD_SOURCE` to
      `createRemoteProxy(api, 'AppDeployBuildSourceAdapter')` — plan §6.4's "Proxied" rows for APW-05's `WorkBuild`
      reads and the spec read. API side: `AppDeployRequestModule` exports the `AppDeployBuildSourceAdapter` class,
      `TriggerInternalModule` imports `AppDeployRequestModule`, and `TriggerInternalController` registers
      `remoteMap.AppDeployBuildSourceAdapter` (allow-list: `getBuild`, `listDeployableBuilds`). The worker's
      render-input builder, `AppHostsService` and `AppHealthService` now read the spec and the Build over the internal
      RPC hop. Still open before a worker deploy can pass §5.6 step 1: (a) `APP_DEPLOY_DISPATCHER_AVAILABILITY` is
      unbound in the worker, so `AppDeployPreconditionsService.evaluate` answers `worker_not_isolated` at step 1 for
      every dequeued Deployment, before any spec or Build read — this needs a §5.1/§5.6 decision on how the re-check
      treats the dispatcher gate inside the isolated worker (for example, skip it when the request carries the
      lock-holding `deploymentId`); (b) `WORK_APP_RUNTIME_STATES` is unbound in the worker (runtime-state warning);
      (c) `APP_RUNTIME_ENV_SOURCE`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_TARGET` and `APPS_TIER_POLICY` are
      still default-ports fail-closed stubs (T73/T44). _Later status: [Status notes](#status-notes)._
      **Create** `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts` _(new)_ exactly as plan §6.4,
      modelled on `trigger-workflow-run.module.ts` but importing **no** `DatabaseModule`, **no** TypeORM `DataSource` and
      no Redis client. It provides the local services of plan §6.4's table, proxies the rest through
      `TriggerInternalApiClient`, and includes the one bootstrap provider that calls `markAppClusterWorkerContext()` in
      `onModuleInit`.
      **Modify** `apps/api/src/trigger/trigger-internal.controller.ts` — add every new name to `remoteMap`, with its
      constructor dependency appended last as `@Optional()` (the existing arity rule);
      `apps/api/src/trigger/trigger-internal.module.ts` — import the owning modules;
      `packages/tasks/src/tasks/trigger/app-runtime-local-worker.ts` and `packages/tasks/package.json` — the
      `app-runtime:local-worker` script (T32).
      **Test**: `packages/tasks/src/trigger/worker/modules/__tests__/trigger-app-runtime.module.spec.ts` _(new)_ — creates
      the application context with a stubbed API client, resolves the orchestrator and the facade, asserts no `DataSource`
      is in the container, and asserts the worker-context flag is set only by this module's bootstrap;
      extend `apps/api/src/trigger/trigger-internal.controller.spec.ts` — every new `remoteMap` name resolves and its
      dependency is optional (APW06-G02, ACC-06-04).
      **Done when**: `pnpm --filter @ever-works/trigger-tasks test` and
      `pnpm --filter ever-works-api test -- trigger-internal.controller` are green, and the local worker starts on a dev
      machine and refuses to start under `NODE_ENV=production`.

- [ ] **T72 (P1, lands with T21–T25). Published images — `build.strategy: image` (APW06-G04).**
      **Create** `packages/agent/src/app-runtime/app-image-reference.resolver.ts` _(new)_ and
      `apps/api/src/app-runtime/app-spec-applied.listener.ts` _(new)_ per plan §5.8; **Modify**
      `packages/agent/src/app-runtime/app-render-input.builder.ts` (spec-commit image, `buildCommitSha: null`, no pull
      credential), `app-deploy.orchestrator.ts` (resolve before `prepare`, record `appRender.image`), and the T1
      constants (`APP_IMAGE_REDEPLOY_BLOCKS`).
      **Test**: `packages/agent/src/app-runtime/__tests__/app-image-reference.resolver.spec.ts` _(new)_ —
      `@sha256:` existence check, tag → digest with `resolvedFromTag`, 404 → `image_not_found`, 401/403 →
      `image_private_unsupported`, timeout → `image_unresolvable`, and the registry host passing the §6.1 guard
      (ACC-06-52); `apps/api/src/app-runtime/app-spec-applied.listener.spec.ts` _(new)_ — the changed-block matrix, with
      blocks that change nothing that runs, `autoDeploy: false`, target `none` and strategy `dockerfile` each requesting
      nothing (ACC-06-52, ACC-06-53).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-image-reference.resolver` and
      `pnpm --filter ever-works-api test -- app-spec-applied.listener` are green, and APW-13's cluster-half fixture
      (`profiles/published-image.works.yml`, no `FIXTURE_GIT_SHA`) deploys with no Build and serves the image tag at
      `/marker.sha` (ACC-E2E-05's PR-cluster half).

- [ ] **T73 (P1, lands with T33). Port publication and wiring (APW06-G12).**
      **Create** `apps/api/src/app-runtime/app-runtime-ports.module.ts` _(new)_ — the `@Global()` module of plan §9.8,
      the single provider for `APPS_TIER_POLICY`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_ENV_SOURCE`,
      `APP_RUNTIME_TARGET`, `APP_RUNTIME_EVENT_SINK`, `APP_VERIFICATION_SINK`, `APP_WORK_DELETION_PORT` **and
      `APP_DEPLOY_ROUTE_PORT` (APW-01's token, bound here with `useExisting: AppDeployRequestService` — APW06-G15)**,
      with the
      deletion port as a lazy `ModuleRef` factory. **Modify** `apps/api/src/api.module.ts` (import it once) and
      `apps/api/src/app-runtime/app-runtime.module.ts` (import it; provide nothing for the same tokens).
      **Test**: `apps/api/src/app-runtime/__tests__/app-runtime-ports.module.spec.ts` _(new)_ — global; exports all seven
      tokens; the deletion-port provider has `useExisting` and `useClass` undefined and `inject: [ModuleRef]`; a reduced
      graph that does not import the module still injects a defined `@Optional() @Inject(APP_WORK_DELETION_PORT)` whose
      `requestDeletion` delegates to `AppRuntimeDeletionService` (APW06-G12).
      **Done when**: the spec is green and `WorkModule` contains no import added for any App runtime token.

## Definition of Done

- Every checkbox above is ticked for the phase being shipped.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the repo root.
- The k8s plugin kind e2e workflow is green, including the unchanged `cluster.e2e.spec.ts`.
- Existing deploy suites (`packages/plugins/k8s/src/__tests__`, `apps/api/src/plugins-capabilities/deploy`,
  `apps/web/e2e/flow-work-deploy-*`) pass **unchanged**.
- Every acceptance box in [spec §8](./spec.md) for the phase has been walked against a running build, each ACC-06 id
  appears in at least one **Test** line above, and the matching rows in [`../ACCEPTANCE.md`](../ACCEPTANCE.md) point at
  real test files.
- No new string literal `'k8s'` outside `packages/plugins/k8s/`; no read of `EVER_WORKS_APPS_MANAGED_ENABLED` in this
  epic; no kubeconfig, env value, token or log text in Activity, telemetry, API responses or `work_deployments`.
- `docs/plugin-system/built-in-plugins.md` untouched (no plugin added — Constitution VIII).

## Status notes

Dated status for the tasks above. It is kept here, not in the task bodies, so the task text keeps the line numbers that
code comments and specs cite.

- **T21 (2026-09-26, `3a956180e`):** the preconditions are wired in the API graph. `AppDeployRequestModule` now imports
  APW-07's `AppRuntimeEnvModule` (`APP_RUNTIME_ENV_SOURCE`) and `AppDependenciesModule` (`APP_DEPENDENCIES_SERVICE`),
  which were in no API graph, so every Deploy past the dispatcher gate had been refused `env_source_unavailable`. It
  also provides `AppLicenseGate`, so the licence preconditions run on the API request path; with APW-03's
  `APP_LICENSE_SERVICE` unwritten the gate answers its documented unreadable verdict (`license_blocks_target` on the
  managed target, a `license_eligibility_unavailable` warning on your cluster). The dependency step reuses the readiness
  the env step already fetched (one `ensureReadyForDeploy` call per evaluation), and while APW-07's
  `APP_DEPENDENCY_SPEC_SOURCE` is unbound it refuses (`dependency_not_ready`) only a spec that declares a dependency; a
  spec that declares none gets the `dependencies_unavailable` warning. Pinned by
  `packages/agent/src/app-runtime/__tests__/app-deploy-request.graph.spec.ts` and
  `app-deploy-preconditions.service.spec.ts`; guarded by `apps/api/src/app-works-di-reachability.spec.ts`.
- **T71 (2026-09-26, `3a956180e`):** `apps/api/src/app-works-di-reachability.spec.ts` walks the worker contexts the
  `app-*` tasks boot. Its `EXPECTED_WORKER_UNBOUND` list cites T71's 2026-09-25 status line for items (a) and (b).
  Besides those gaps it measured 13 more unbound worker bindings, kept in its `OPEN_WORKER_GAPS` list rather than
  called intended: six in `AppDependencyProvisionWorkerModule` (`WorkAppDependencyRepository` twice, by class and by
  name, `APP_DEPENDENCY_CLUSTER_ACCESS`, `APP_DEPENDENCY_CONFIG_CIPHER`, `APP_DEPENDENCY_PROVISION_DISPATCHER`,
  `AppDependencyFacadeService`) and seven in `TriggerAppRuntimeModule` (`APP_CUSTOM_DOMAIN_STORE`,
  `APP_DEPENDENCIES_SERVICE`, `APP_DEPLOY_DEPLOYMENT_STORE`, `APP_HOSTS_APPS_DOMAIN`, `APP_HOSTS_DEPLOYMENT_STORE`,
  `APP_HOSTS_DEPLOY_REQUESTER`, `APP_HOSTS_WORK_STORE`). **Owner decision:** add them to T71's status line (they then
  move to `EXPECTED_WORKER_UNBOUND`, citing it) or cut a T71 slice (with APW-07 T17) that binds them.
