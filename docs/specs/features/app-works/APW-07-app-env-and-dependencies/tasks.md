# Task Breakdown: App env & dependencies

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests per
> **Constitution VI**. The schema task ships its migration in the same PR per **Constitution V**.

**Epic ID**: `APW-07-app-env-and-dependencies`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to guess a path. **Modify**
  paths not marked "(create if absent)" exist on `develop` @ `ee45946e5`.
- Every task has a **Test** line (a file and what it asserts, or the command that is the test) and a **Done when**
  line that is checkable without reading the diff. `(ACC-07-nn)` tags name the spec §8 criteria a Test line proves.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- Repo commands run from the monorepo root unless a task says otherwise. Migrations are authored from `apps/api/`.
  Package filters: `@ever-works/contracts`, `@ever-works/plugin`, `@ever-works/agent`, `@ever-works/k8s-plugin`,
  `ever-works-api`, `ever-works-web`, `@ever-works/trigger-tasks`, `@ever-works/app-dependencies-external-plugin` (new,
  T22), `@ever-works/apps-tier-dependencies-plugin` (new, T36).
- API behaviour is tested under `apps/api/src/**` or `apps/web/e2e/` — never `apps/api/test/` (Resolution R-22).
- **Never modify** `packages/agent/src/services/work-runtime-env.constants.ts`, `work-runtime-env.service.ts`,
  `docs/runbooks/WORK_RUNTIME_ENV.md` or `apps/web/src/components/works/detail/deploy/RuntimeEnvManagement.tsx`.
- **Cross-epic prerequisites** (typed fakes until they land): APW-03 effective App spec + `app.spec.applied` and the
  `generate.keypair.format` schema field (R-11); APW-05's latest deployable Build with its
  **`buildValueFingerprints`** map (APW07-G03); APW-06's
  **`AppRuntimeTargetPort.prepareDependencyTarget`** (the runtime target resolver — `{ kubeconfig, context, namespace,
appPodLabels }`, plus the `unavailable` reasons), the `AppRuntimeEnvSource` port with `target`, `fingerprints` and
  `resolveEphemeral(…, { dependencyOutputs })`, APW-06's current Deployment `appRender.envFingerprints`, domain state,
  the `delete-app-work`, `prepare-namespace` and `verification-deploy` ops (R-15, R-10, GAP-06) and its calls to
  `reconcile` / `ensureReadyForDeploy` / `onAppRemoved` / `list` / `provisionEphemeral` (APW-06 T69, T70, T58, T60);
  APW-01's `WorkCapabilities.appEnvironment` (R-7) and **`AppWorkAccessService.resolve`** (APW07-G13);
  APW-10's `AppsTierPolicy` (R-5) and **`IAppsTierProvider.setDependencies` / `releaseDependencies`** plus the
  `Work.status.dependencies[]` contract (GAP-22, APW10-G01).

---

# Phase P1 — App env, Your-cluster and external dependencies

_Delivers spec FR-1…FR-50 and FR-56…FR-60: the Environment table, secrecy, generators and keypair formats, validation,
resolution, gating, `.env` import, dependency providers on Your cluster and external servers, lifecycle and backup
states, App Work deletion and verification values._

## P1.1 — Contracts

- [ ] **T1. App env contracts.**
      **Create** `packages/contracts/src/apps/app-env.ts` with `APP_ENV_ORIGINS`, `APP_ENV_PHASES`,
      `APP_ENV_GENERATOR_KINDS`, `APP_ENV_ALPHABETS` (exact strings from [plan §3.3](./plan.md)), `APP_ENV_KEYPAIR_TYPES`,
      `APP_ENV_KEYPAIR_FORMATS`, `APP_ENV_KEYPAIR_RAW_TYPES`, `APP_ENV_NAME_PATTERN`, `APP_ENV_RESERVED_PREFIX`,
      `APP_ENV_PUBLIC_PREFIXES`, the numeric constants and `AppEnvEntryView`.
      **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` to export it (create the barrel and its export from
      `packages/contracts/src/index.ts` only if APW-03 has not landed — R-1).
      **Test**: `packages/contracts/src/apps/__tests__/app-env.spec.ts` — alphabet lengths 62 / 76 / 16 / 64 with no
      duplicate characters; `alnum-symbols` contains no double quote, single quote, backtick, `$` or space;
      `APP_ENV_KEYPAIR_FORMATS` is exactly `pem`, `base64url-raw`, `pkcs12`; every numeric constant (`65_536`,
      `1_048_576`, `300`, `16_384`, `50`, `65_536`, `500`, `60_000`, `10`, `30`, `10`).
      **Done when**: `pnpm --filter @ever-works/contracts test` is green and
      `pnpm --filter @ever-works/contracts build` emits declarations.

- [ ] **T2 (parallel with T1). App dependency contracts.**
      **Create** `packages/contracts/src/apps/app-dependencies.ts` with `APP_DEPENDENCY_KINDS`,
      `APP_DEPENDENCY_OUTPUTS`, deadlines, sizes, retry, refresh, backup-overdue, relay limit, `APP_DEPENDENCY_MANAGED`,
      the `AppDependencyView` type **and every status, status-reason and API error code as a constant**
      (`APP_DEPENDENCY_STATUSES` incl. `awaitingConfig`, `APP_DEPENDENCY_REASONS`, `APP_ENV_ERROR_CODES` in
      `app-env.ts`) so a code added without copy fails the key test below (APW07-G23).
      **Test**: `packages/contracts/src/apps/__tests__/app-dependencies.spec.ts` — output names and secret flags equal
      [spec FR-40](./spec.md) exactly; `APP_DEPENDENCY_READY_DEADLINE_MS` = 600,000 / 300,000 / 600,000 / 30,000;
      `APP_DEPENDENCY_BACKUP_OVERDUE_MS` = 93,600,000; **every reason and error-code constant resolves to exactly one
      message key under `dashboard.workDetail.appDependencies.*` / `…appEnv.errors.*` in `apps/web/messages/en.json`
      (APW07-G23)**.
      **Done when**: `pnpm --filter @ever-works/contracts test` is green.

- [ ] **T3 (parallel with T1). `app-dependency` capability and category.**
      **Create** `packages/plugin/src/contracts/capabilities/app-dependency.interface.ts` exactly as
      [plan §4.7](./plan.md), including `AppDependencyContext.ephemeral`, the `stopWorkloads` deprovision option and
      `isAppDependencyProvider`, **plus the `ResourceRefs` type the rest of the file references**
      (`{ namespace?: string; objects: Array<{ kind: string; name: string }> ≤ 20; databases?: string[]; buckets?: string[] }`
      — added, APW07-G24: plan §4.7 named the type without defining it).
      **Modify** `packages/plugin/src/contracts/capabilities/index.ts` (export),
      `packages/plugin/src/contracts/facade-capabilities.ts` (`APP_DEPENDENCY: 'app-dependency'`),
      `packages/plugin/src/contracts/plugin-manifest.types.ts` (append `'app-dependency'`).
      **Test**: `packages/plugin/src/contracts/__tests__/app-dependency-capability.spec.ts` — validity helpers, type
      guard, no existing capability/category removed.
      **Done when**: `pnpm --filter @ever-works/plugin test` is green.

- [ ] **T4 (parallel with T1). `appEnvironment` Work capability — consume only.**
      **No change** to `packages/contracts/src/domain/work-capabilities.ts`: APW-01 T3 adds `readonly appEnvironment: boolean`
      (`true` for `app`, `false` for every other kind) and its spec pins (Resolution R-7). This epic only reads
      `getWorkCapabilities(work.kind).appEnvironment` (T27's sub-tabs) and never declares or defaults the field.
      **Test**: `git grep -n "appEnvironment" packages/contracts/src/domain/work-capabilities.ts` shows APW-01's field, and
      no APW-07 change touches that file or its spec.
      **Done when**: APW-01 T3 is merged and web, API and agent type-check against it.

## P1.2 — Entities, migration, repositories

- [ ] **T5. `WorkAppEnvValue` entity.**
      **Create** `packages/agent/src/entities/work-app-env-value.entity.ts` ([plan §3.1](./plan.md)).
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`
      (`'WorkAppEnvValue'`), `packages/agent/src/database/_entities-inventory.ts`.
      **Test**: `packages/agent/src/entities/__tests__/work-app-env-value.entity.spec.ts` — unique index, `valueEncrypted`
      NOT NULL, scope columns present, no `select: true` default exposure of `valueEncrypted` in repository `find` helpers.
      **Done when**: `pnpm --filter @ever-works/agent test -- work-app-env-value.entity` is green and the drift specs
      `packages/agent/src/database/database.module.spec.ts` and `database.config.spec.ts` pass.

- [ ] **T6 (parallel with T5). `WorkAppDependency` entity.**
      **Create** `packages/agent/src/entities/work-app-dependency.entity.ts` ([plan §3.2](./plan.md)); register in the same
      three files (`'WorkAppDependency'`).
      **Test**: `packages/agent/src/entities/__tests__/work-app-dependency.entity.spec.ts` — partial unique index
      `WHERE status NOT IN ('kept','deleted')`, defaults (`attempts` 0, `outputsVersion` 0, `inSpec` true).
      **Done when**: `pnpm --filter @ever-works/agent test -- work-app-dependency.entity` is green and the drift specs pass.

- [ ] **T7. Migration.**
      **Create** `apps/api/src/migrations/1792070000000-CreateAppEnvAndDependencies.ts` (generate the skeleton from
      `apps/api/`, re-stamp to the APW-07 block). `down()` drops only the two tables.
      **Test**: `apps/api/src/migrations/__tests__/CreateAppEnvAndDependencies.spec.ts` — both tables, FKs `ON DELETE
CASCADE`, indexes; no `ALTER TABLE "works"`; the partial unique index is the Postgres-guarded raw form while SQLite and
      MySQL/MariaDB get their own branches (APW07-G12); up/down on the in-memory SQLite lane plus the opt-in Postgres run
      (`EVER_WORKS_POSTGRES_RACE_TEST_URL`, `describe.skip` when unset — the convention of
      `apps/api/src/works/existing-website-link.postgres.integration.spec.ts:12-13`).
      **Done when**: `pnpm --filter ever-works-api test -- CreateAppEnvAndDependencies` is green on SQLite, the opt-in
      Postgres run is green when the URL is set, and the timestamp is above the newest `develop` migration.

- [ ] **T8. Repositories.**
      **Create** `packages/agent/src/database/repositories/work-app-env-value.repository.ts` (`findByWork`, `insertIfAbsent`
      → returns the stored row, `upsertValue` with version + 1, `deleteNames`, `totals(workId)` → `{ count, bytes }`) and
      `packages/agent/src/database/repositories/work-app-dependency.repository.ts` (`findActiveByWork`, `findByWorkAndKind`,
      `claimLease(id, ms)`, `markKept`, `markDeleted`, `updateOutputs(id, envelope)` with `outputsVersion + 1`).
      **Modify** `packages/agent/src/database/index.ts` (exports) **and, if the repository inventory requires it,
      `packages/agent/src/database/_repository-inventory.ts`** (added, APW07-G24: `database.module.spec.ts:41` enforces
      that inventory, so a repository missing from it fails that spec — register both there rather than only in the
      feature module).
      **Test**: `packages/agent/src/database/repositories/__tests__/work-app-env-value.repository.spec.ts` — 20 concurrent
      `insertIfAbsent` → one row and all callers read the same envelope (ACC-07-02);
      `packages/agent/src/database/repositories/__tests__/work-app-dependency.repository.spec.ts` — lease exclusivity; a
      second active row for the same kind is refused while a kept one is allowed; the lease is a parameterised timestamp
      compare-and-set with no `now() + interval` SQL (APW07-G12).
      **Done when**: `pnpm --filter @ever-works/agent test -- work-app-env-value.repository work-app-dependency.repository`
      is green on the SQLite lane and on the opt-in Postgres run (`EVER_WORKS_POSTGRES_RACE_TEST_URL`).

## P1.3 — Env core

- [ ] **T9. `AppEnvCrypto`.**
      **Create** `packages/agent/src/app-env/app-env-crypto.ts` wrapping
      `packages/agent/src/plugins/services/plugin-secret-enc.service.ts` ([plan §4.1](./plan.md)).
      **Test**: `packages/agent/src/app-env/__tests__/app-env-crypto.spec.ts` — no key → `AppEnvEncryptionUnavailableError`
      under `NODE_ENV` `production`, `development` and `test`, and a spy repository records zero writes (ACC-07-12);
      round-trip with a key; unprefixed input refused.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env-crypto` is green.

- [ ] **T10 (parallel with T9). Generators.**
      **Create** `packages/agent/src/app-env/generators.ts` ([plan §4.3](./plan.md)) using only `node:crypto` for
      randomness (the `pem` keypair format here; other formats in T42).
      **Test**: `packages/agent/src/app-env/__tests__/generators.spec.ts` — 1,000 samples each: base64 of 24 bytes → 32
      chars, hex of 32 → 64, chars 40 alnum → 40 with membership, uuid → 36 and version nibble `4` (ACC-07-01); `chars`
      byte-frequency chi-square below the 99.9% critical value for 62 buckets; each keypair type produces PKCS#8/SPKI PEM
      whose public key verifies a signature made with the private key (ed25519, ec-p256, rsa-2048; rsa-4096 once)
      (ACC-07-06); fingerprints stable.
      **Done when**: `pnpm --filter @ever-works/agent test -- generators` is green in under 60 seconds.

- [ ] **T11 (parallel with T9). Validation.**
      **Create** `packages/agent/src/app-env/validation.ts` ([plan §4.4](./plan.md)); **Modify**
      `packages/agent/package.json` — add `re2js`.
      **Test**: `packages/agent/src/app-env/__tests__/validation.spec.ts` — every refusal code; a 44-character value for
      `length: 32` → `lengthMismatch { expected: 32, actual: 44 }` with the S15 message; `(a+)+$` against 65,536 × `a` + `!`
      completes under 50 ms (ACC-07-07); `EVER_WORKS_FOO` → `reservedName`, `bad-name` → `invalidName`, a 65,537-byte value
      → `valueTooLarge` (ACC-07-08); code-point counting (`"é" × 32` passes `length: 32`); a look-around pattern is refused as
      unsupported; no message contains the tested value.
      **Done when**: `pnpm --filter @ever-works/agent test -- validation` is green.

- [ ] **T12 (parallel with T9). Dotenv parser.**
      **Create** `packages/agent/src/app-env/dotenv-parser.ts` ([plan §4.5](./plan.md)) and fixture
      `packages/agent/src/app-env/__tests__/fixtures/import-12-lines.env`.
      **Test**: `packages/agent/src/app-env/__tests__/dotenv-parser.spec.ts` — the fixture yields 11 entries + 1 refusal at
      line 7 (ACC-07-11); `export` prefix; single quotes literal; double-quote escapes and multi-line; inline ` #` comment;
      BOM; CRLF; duplicates last-wins; 501 lines and 65,537 bytes refused before parsing; a spy proves no logger or
      `console` call.
      **Done when**: `pnpm --filter @ever-works/agent test -- dotenv-parser` is green.

- [ ] **T13. `AppEnvService`.**
      **Create** `packages/agent/src/app-env/app-env.service.ts`, `packages/agent/src/app-env/app-env.module.ts`,
      `packages/agent/src/app-env/index.ts` ([plan §4.2](./plan.md)) — `list`, `ensureGenerated`, `apply` (set / unset /
      reset / import with per-item results), `rotate`, `missingRequired`, `buildRedactor`.
      **Test**: `packages/agent/src/app-env/__tests__/app-env.service.spec.ts` — S1 fixture counts (6 generated set, 2
      required prompted missing); calling `ensureGenerated` again after a re-apply of the same App spec, and after a
      simulated rebuild, redeploy and upstream-sync event, leaves every generated `version` and envelope unchanged
      (ACC-07-03); the 12-line import stores 9 declared, creates 2 undeclared with the warning, refuses line 7 and skips a
      generated name unless `replaceGenerated` + `acknowledgeNeverRotate` (ACC-07-11); `missingRequired('runtime')` lists
      both names with descriptions (ACC-07-09); set on a `from` entry becomes an override and `reset` restores; keypair and
      `<NAME>_PUBLIC` cannot be set; `generatorChanged` after the fixture's `bytes` changes, value unchanged; 301st value
      and 1 MiB + 1 byte refused; `EVER_WORKS_X` refused; one `app.env.changed` per call with names and actions only; the
      redactor replaces every stored value ≥ 6 chars with `***`.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env.service` is green.

- [ ] **T14. `AppEnvResolver` and the `AppRuntimeEnvSource` port.** _Status 2026-09-26: [Status notes](#status-notes)._
      **Create** `packages/agent/src/app-env/app-env.resolver.ts` ([plan §2.2 and §4.6](./plan.md)) and
      `packages/agent/src/app-env/app-env-runtime.source.ts` implementing APW-06's `AppRuntimeEnvSource`
      (`packages/agent/src/app-runtime/ports.ts`, typed copy until APW-06 lands) bound to `APP_RUNTIME_ENV_SOURCE`, with
      `ew-dep://<kind>/<output>` placeholders **decided from `ctx.target`** (never the stored row) and
      `resolveEphemeral` (T43). **Added by the 2026-09-17 fix pass:** `resolve` returns `fingerprints` (the §2.2 per-name
      map, same keys as `values`), reads `ctx.target`, derives `notReadyDependencies` from
      `AppDependenciesService.ensureReadyForDeploy(workId)` (which dispatches `pending` kinds — GAP-05), and
      `resolveEphemeral`'s `cluster` target reads `ctx.dependencyOutputs` for derived references (APW07-G03, APW07-G04).
      **Test**: `packages/agent/src/app-env/__tests__/app-env.resolver.spec.ts` — one case per §2.2 row for both phases;
      only `build`/`both` entries reach `resolveForBuild` and a build-phase `deps.postgres.url` resolves to
      `postgresql://ever-works-build:…@127.0.0.1:5432/app` (ACC-07-10); a derived build-phase entry's fingerprint differs
      after the primary domain changes, so `changedSinceBuild` flips (ACC-07-13); `platform.smtp.*` at build →
      `notAvailableAtBuild`; dependency not ready → listed in `notReadyDependencies` **and exactly one
      `ensureReadyForDeploy` call**; a non-required `smtp` with no provider leaves its entries unset with the
      `smtpNotConfigured` warning instead of blocking (ACC-07-33, FR-62); template depth 11 →
      `templateUnresolvable`; fingerprints follow the §2.2 rule, including `t<…>` for a secret template — its fingerprint
      changes when an input fingerprint changes and **no sha256 of a secret value is ever produced**; `fingerprints` has a
      key for every key in `values`; unresolved items never
      carry a value. `packages/agent/src/app-env/__tests__/app-env-runtime.source.spec.ts` — port shape (`values`,
      `fingerprints`, `secretNames`, `unsetRequired` naming both unset required values — ACC-07-09,
      `notReadyDependencies`, `egress`
      host/ports for `smtp-external` and `s3-external`); keypair `<NAME>_PUBLIC` included and the private value only in
      `values` (ACC-07-06); managed target emits placeholders and no output value; `cluster` ephemeral mode resolves a
      derived reference from `ctx.dependencyOutputs` and stores nothing (ACC-07-31).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env.resolver app-env-runtime.source` is green.

- [ ] **T15. Listener.** _Status 2026-09-26: [Status notes](#status-notes)._
      **Create** `packages/agent/src/app-env/app-env.listener.ts` — `app.spec.applied` → `ensureGenerated` then
      `AppDependenciesService.reconcile` (T16).
      **Test**: `packages/agent/src/app-env/__tests__/app-env.listener.spec.ts` — generated rows exist when the handler
      call returns, well inside 60 s (ACC-07-01); a thrown reconcile does not undo generation.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env.listener` is green.

## P1.4 — Dependencies core and providers

- [ ] **T16. `AppDependencyFacadeService` and `AppDependenciesService`.**
      **Create** `packages/agent/src/facades/app-dependency.facade.ts` (extends `BaseFacadeService`,
      `CAPABILITY = PLUGIN_CAPABILITIES.APP_DEPENDENCY`, preference-ordered selection) and
      `packages/agent/src/app-dependencies/app-dependencies.service.ts`, `app-dependencies.module.ts`, `index.ts`
      (`reconcile`, `ensureReadyForDeploy`, `onAppRemoved`, `list`, `configure`, `retry`, `requestDataDeletion`).
      **Modify** `packages/agent/src/facades/facades.module.ts`, `packages/agent/src/facades/index.ts`.
      **Test**: `packages/agent/src/app-dependencies/__tests__/app-dependencies.service.spec.ts` — reconcile transitions
      (new kind → `pending` + dispatch, or `awaiting_config` + **no** dispatch and **no** deadline for a provider with
      `awaitingConfig: true`; removed kind → `inSpec=false`, no dispatch; target change → old `kept`, new pending);
      `onAppRemoved({ deleteData: false })`, removal from the spec and a target change each leave the provider's
      `deprovision` uncalled or called with `deleteData: false` (ACC-07-21); target `none` → nothing provisioned; explicit
      provider choice wins when supported; `ensureReadyForDeploy` lists not-ready kinds; a facade-source grep finds no
      provider id literal; **a Work with a declared Postgres and no Deployment calls
      `AppRuntimeTargetPort.prepareDependencyTarget` once and reaches `ready` with zero `app-deploy` dispatches (the
      GAP-06 / APW07-G01 deadlock regression), `target_not_checked` and `namespace_owned_elsewhere` give failed with that
      reason, and `cluster_unreachable` is retried 3 times (ACC-07-14)**.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-dependencies.service` is green.

- [ ] **T17. `app-dependency-provision` dispatcher and job.**
      **Create** `packages/agent/src/tasks/app-dependency-provision-dispatcher.ts`, `app-dependency-provision.types.ts`,
      `packages/agent/src/app-dependencies/app-dependency-provision.runner.ts` ([plan §7](./plan.md)),
      `packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts` on APW-06's queue `app-cluster-io` (refuses to
      dispatch in production unless `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`).
      **Modify** `packages/agent/src/tasks/index.ts`, `packages/agent/src/tasks/_tasks-symbols.ts`
      (`APP_DEPENDENCY_PROVISION_DISPATCHER`), `packages/agent/src/tasks/job-runtime.providers.ts`,
      **`packages/tasks/src/trigger/trigger.service.ts`** and
      `packages/tasks/src/trigger/trigger.module.ts` (added, APW07-G24: each dispatcher needs a concrete
      `TriggerService.dispatchAppDependencyProvision(payload)` method that **propagates** errors, plus its mirror in
      `dispatchersFromTenantClient` with the propagate shape rather than `softDispatch`, and its `TASK_IDS` entry; the
      arity pin in `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` is updated by counting the merged
      `DISPATCHER_SYMBOLS` list). The delayed re-dispatch uses the existing `notBefore` → `deferUntil` → `delay` shape
      (`packages/tasks/src/trigger/trigger.service.ts:581-591`), never a sleep in the job.
      **Test**: `packages/agent/src/app-dependencies/__tests__/app-dependency-provision.runner.spec.ts` — lease; `pending`
      re-dispatch ≤ 30 s until the kind's deadline then `failed deadlineExceeded`; a cluster-unreachable outcome retried 3
      times at 5-minute spacing before `failed clusterUnreachable` (ACC-07-20); definite failure immediate; outputs
      encrypted and `outputsVersion + 1` only when changed; `refresh` updates backup state; `deprovision` keep →
      `app.dependency.released` and row `kept` (ACC-07-21), delete → `app.dependency.data_deleted` and row `deleted`
      (ACC-07-22); `packages/agent/src/tasks/tasks.spec.ts` passes.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-dependency-provision.runner tasks.spec` is green.

- [ ] **T18. `KubernetesApiService` helpers.**
      **Modify** `packages/plugins/k8s/src/k8s-api.service.ts` — add only `crdServed(name, version)` and
      `defaultStorageClass()`; reuse APW-06's `applyObject`, `readObject`, `listObjects`, `deleteObject`,
      `createSelfSubjectAccessReview` (if APW-06 has not landed, add those five with APW-06's exact signatures from its plan
      §6.3 and let APW-06 adopt them).
      **Test**: `packages/plugins/k8s/src/__tests__/k8s-api.dependencies.spec.ts` against the existing client factory mock —
      404 CRD → `false`; served-version mismatch → `false`; a `StorageClass` annotated default is returned and none → `null`
      (ACC-07-20).
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- k8s-api.dependencies` is green and every pre-existing
      k8s plugin spec passes unchanged.

- [ ] **T19. `k8s-inline-postgres`.**
      **Create** `packages/plugins/k8s/src/app-dependencies/common.ts` (labels, security context, network policy),
      `packages/plugins/k8s/src/app-dependencies/images.ts` (digest-pinned images per Postgres version 14–17, Redis 7, S3
      server, client job images), `packages/plugins/k8s/src/app-dependencies/postgres.provider.ts` (operator path + plain
      path, extensions, outputs, backup state, deprovision incl. `stopWorkloads`, ephemeral variant).
      **Modify** `packages/plugins/k8s/src/k8s.plugin.ts` — `capabilities: ['deployment', 'app-dependency']`,
      `dependencyProviders`, delegate `supports/provision/getOutputs/deprovision/backupStatus`; settings
      `appDependencyStorageClass`, `appDependencySizes`, admin image overrides.
      **Modify** `packages/plugins/k8s/package.json` — capabilities array.
      **Test**: `packages/plugins/k8s/src/app-dependencies/__tests__/postgres-operator-path.spec.ts` — CRD served + allowed →
      `Cluster` manifest with `instances: 1` (ACC-07-15); CRD served + denied → plain path with `operatorSkipped`; backup
      states from Backup objects, the newest `completed` → healthy, `failed` → failing, none → not configured, including a
      cluster whose summary claims success while the newest Backup failed → `failing` (ACC-07-15); no Backup +
      ScheduledBackup 27 h old → `overdue`. `packages/plugins/k8s/src/app-dependencies/__tests__/postgres-plain-path.spec.ts`
      — StatefulSet for Postgres 16 with a readiness probe and a 10 GiB claim, backup state `none` (the no-backup warning);
      security context uid 999, `runAsNonRoot`, drop ALL; APW-06 labels plus `ever-works.io/dependency` and
      `ever-works.io/retain` on the PVC; **the provider applies NetworkPolicy `dep-postgres` (same-namespace ingress
      only, plus the operator namespace on the operator path) before the StatefulSet or `Cluster`, so a pod outside the
      namespace cannot connect (ACC-07-14) and the policy is drawn with isolation off too (APW07-G01)**; no default
      storage class → `failed noDefaultStorageClass` with the S18 reason
      (ACC-07-20); a 403 on StatefulSet create → `clusterPermissionMissing` (APW07-G10); `directUrl` output only when
      declared.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- postgres-operator-path postgres-plain-path` is green.

- [ ] **T20 (parallel with T19). `k8s-inline-redis`.**
      **Create** `packages/plugins/k8s/src/app-dependencies/redis.provider.ts`.
      **Test**: `packages/plugins/k8s/src/app-dependencies/__tests__/redis.spec.ts` — Deployment without persistence,
      StatefulSet + 1 GiB PVC with; `--maxmemory 400mb` and the declared policy; readiness uses `REDISCLI_AUTH` (no password
      in args); ready when `readyReplicas == 1` inside the 5-minute deadline (ACC-07-16); outputs URL shape;
      **`dep-redis` admits same-namespace ingress only and is applied before the workload (APW07-G01)**.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- redis` is green.

- [ ] **T21 (parallel with T19). `k8s-inline-minio`.**
      **Create** `packages/plugins/k8s/src/app-dependencies/object-storage.provider.ts`.
      **Test**: `packages/plugins/k8s/src/app-dependencies/__tests__/object-storage.spec.ts` — StatefulSet 20 GiB; init Job
      creates every declared bucket and ready requires Job success inside 10 minutes (ACC-07-16); anonymous download only on
      `publicBuckets`; service-account keys written to `dep-s3-app`; outputs; `deleteData: false` makes zero API calls and
      `true` deletes PVCs and re-lists to zero; **`dep-s3` admits same-namespace ingress only and is applied before the
      init Job and the StatefulSet (APW07-G01)**.
      **Also (T20/T21, APW07-G01).** The shared `dep-<kind>` rendering lives in `common.ts`, so its unit spec covers the
      label set, `podSelector`, the three ingress ports, the operator-namespace variant and the fact that it is drawn
      with isolation off.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- object-storage` is green.

- [ ] **T22. `app-dependencies-external` plugin (SMTP, S3).**
      **Create** `packages/plugins/app-dependencies-external/` (`package.json` named
      `@ever-works/app-dependencies-external-plugin` with `everworks.plugin` id `app-dependencies-external`, category
      `app-dependency`, capability `app-dependency`, **and the manifest flags the `k8s` manifest carries —
      `autoEnable`, `builtIn` and `visibility`** (added, APW07-G24: `BaseFacadeService` selects only plugins enabled for
      the user, so a plugin without them leaves SMTP and S3 permanently unavailable); deps `nodemailer`,
      `@aws-sdk/client-s3`; tsup/vitest like
      `packages/plugins/k8s`), `src/index.ts`, `src/plugin.ts`, `src/smtp-external.provider.ts`,
      `src/s3-external.provider.ts`, `src/public-endpoint.ts` (DNS-resolved private, loopback, link-local refusal
      **honouring `EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST`** — added, APW07-G09).
      **Test**: `packages/plugins/app-dependencies-external/src/__tests__/smtp-external.spec.ts` — verify success;
      connect/TLS failures → reasons; an auth refusal → `smtpAuthRefused` within the 30 s abort and `sendMail` never called
      (ACC-07-17). `s3-external.spec.ts` — `HeadBucket` per mapping; a missing bucket → `bucketUnreadable` naming it
      (ACC-07-18). `public-endpoint.spec.ts` — `127.0.0.1`, `10.x`, `169.254.x`, `::1`, and a hostname resolving to a
      private address are refused, **while an allow-listed CIDR is accepted and a non-listed one is still refused
      (APW07-G09, ACC-07-33's lane)**.
      **Done when**: `pnpm --filter @ever-works/app-dependencies-external-plugin test` is green and prompt schemas mark
      `password` and `secretAccessKey` `x-secret`.

- [ ] **T23. `platform-smtp-relay` provider.**
      **Create** `packages/plugins/app-dependencies-external/src/platform-smtp-relay.provider.ts` and admin settings
      (`relay.apiUrl`, `relay.apiToken` `x-secret`, `relay.host`, `relay.port`, `relay.fromDomain`, `relay.dailyLimit` default
      200).
      **Test**: `packages/plugins/app-dependencies-external/src/__tests__/platform-smtp-relay.spec.ts` — the descriptor is
      absent (not disabled) unless all five required settings are set (ACC-07-19); provision posts `{ id: "work-<uuid>",
dailyLimit: 200 }`; deprovision deletes that id; outputs never contain the operator's `apiToken`.
      **Done when**: `pnpm --filter @ever-works/app-dependencies-external-plugin test -- platform-smtp-relay` is green.

## P1.5 — API and events

- [ ] **T24. App env controller.**
      **Create** `apps/api/src/app-env/app-env.controller.ts`, `apps/api/src/app-env/dto/app-env.dto.ts`
      (`ApplyAppEnvDto`, `RotateAppEnvDto`), `apps/api/src/app-env/app-env.module.ts`; routes, throttles and codes from
      [plan §5](./plan.md), accessed through `AppWorkAccessService.resolve` (APW07-G13) and marked
      `@SensitiveRequestBody()` (APW07-G05). **Modify** `apps/api/src/api.module.ts` to import the module; **create**
      `packages/monitoring/src/decorators/sensitive-request-body.decorator.ts` _(new)_ and **modify**
      `packages/monitoring/src/interceptors/sentry.interceptor.ts` to record `{ redacted: true }` for a marked route
      instead of the body.
      **Test**: `apps/api/src/app-env/app-env.controller.spec.ts` — foreign id 404 on every route with the real
      `AppWorkAccessService` over stubbed repositories, and a viewer 403 on PUT and
      rotate (ACC-07-23, APW07-G13); 503 `secureStorageUnavailable` without key (ACC-07-12); rotate without or with a wrong
      `confirmName` 422, with it 200 and the entry's version + 1 (ACC-07-04); 11th rotation 429; every response body and all
      captured logger output scanned for each submitted value → absent (ACC-07-05); **the error-reporting interceptor's
      captured context calls contain no submitted value and no `set.*`, `import.dotenv` or `config.*` fragment
      (APW07-G05)**; import results per line
      (ACC-07-11).
      `packages/monitoring/src/interceptors/__tests__/sentry.interceptor.spec.ts` — a marked route yields
      `{ redacted: true }` while an unmarked route is unchanged.
      **Done when**: `pnpm --filter ever-works-api test -- app-env.controller` is green.

- [ ] **T25. App dependencies controller.**
      **Create** `apps/api/src/app-dependencies/app-dependencies.controller.ts`, `apps/api/src/app-dependencies/dto/app-dependencies.dto.ts`,
      `apps/api/src/app-dependencies/app-dependencies.module.ts`; **Modify** `apps/api/src/api.module.ts`. Access through
      `AppWorkAccessService.resolve` (APW07-G13); `@SensitiveRequestBody()` on every write (APW07-G05); `PUT …/:kind` with
      `sizeGiB` validates the size (below the provisioned size → 422 `sizeShrinkRefused`; a class that cannot expand → 422
      `volumeExpansionUnsupported`; otherwise a `resize` dispatch) — APW07-G22.
      **Test**: `apps/api/src/app-dependencies/app-dependencies.controller.spec.ts` — GET never contains config or output
      values (seeded envelopes decrypted in the test and searched for) (ACC-07-05); stale `lastCheckedAt` dispatches one
      refresh; PUT unknown provider 422; DELETE wrong slug 422 and right slug 202 + one `deprovision` dispatch with
      `deleteData: true` (ACC-07-22); undeclared kind 404; foreign id 404 on every route (ACC-07-23);
      **an `awaiting_config` card dispatches nothing and a valid PUT moves it to `pending` with one dispatch
      (ACC-07-33); a smaller `sizeGiB` → 422 `sizeShrinkRefused`, a larger one on a non-expandable class → 422
      `volumeExpansionUnsupported`, a larger one on an expandable class → 202 and one `resize` dispatch (ACC-07-34)**.
      **Done when**: `pnpm --filter ever-works-api test -- app-dependencies.controller` is green.

- [ ] **T26 (parallel with T25). Activity types.**
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — `APP_ENV = 'app_env'`, `APP_DEPENDENCY = 'app_dependency'`.
      **Create** `packages/agent/src/app-env/app-env.activity.ts` and `packages/agent/src/app-dependencies/app-dependency.activity.ts`
      writing `app.env.changed|rotated` and `app.dependency.provisioned|failed|released|data_deleted` via
      `ActivityLogService.log` with `action` = the dotted name (R-2).
      **Test**: `packages/agent/src/app-env/__tests__/app-env.activity.spec.ts` — `app.env.rotated` carries the name only
      (ACC-07-04); metadata holds names/actions/kinds only and a property test with random values never finds a value in
      the serialised row (ACC-07-05); `actionType` is `app_env` / `app_dependency`.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env.activity` is green.

## P1.6 — Web

- [ ] **T27. Routes, sub-tabs, client and actions.**
      **Create** `apps/web/src/app/[locale]/(dashboard)/works/[id]/settings/environment/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/settings/dependencies/page.tsx`, `apps/web/src/lib/api/app-env.ts`,
      `apps/web/src/app/actions/dashboard/app-env.ts` (seven actions in [plan §6](./plan.md)).
      **Modify** `apps/web/src/components/works/detail/settings/SettingsSubTabs.tsx` — Environment and Dependencies after
      General when `appEnvironment` is true.
      **Test**: `apps/web/src/components/works/detail/settings/SettingsSubTabs.unit.spec.tsx` (create if absent) — tabs
      hidden for `directory`, shown when the capability is true.
      **Done when**: `pnpm --filter ever-works-web test -- SettingsSubTabs` is green and a directory Work's settings are
      unchanged.

- [ ] **T28. Environment table and dialogs.**
      **Create** `apps/web/src/components/works/detail/settings/app-env/AppEnvTable.tsx`, `AppEnvSetDialog.tsx`,
      `AppEnvRotateDialog.tsx`, `AppEnvImportDialog.tsx`, `AppEnvAddDialog.tsx`.
      **Test**: `apps/web/src/components/works/detail/settings/app-env/AppEnvTable.unit.spec.tsx` — origin/phase/state chips
      for each §6.1 row incl. **Changed since the last build** (ACC-07-13); no reveal control; **Copy public key** only on
      keypair rows and copies the public half (ACC-07-06). `AppEnvSetDialog.unit.spec.tsx` — field empty on every open;
      cleared on close, save and unmount; hold-to-show disabled after save. `AppEnvRotateDialog.unit.spec.tsx` — button
      disabled until the exact name is typed (ACC-07-04). `AppEnvImportDialog.unit.spec.tsx` — per-line results;
      replace-generated needs the second confirmation.
      **Done when**: `pnpm --filter ever-works-web test -- AppEnvTable AppEnvSetDialog AppEnvRotateDialog AppEnvImportDialog`
      is green.

- [ ] **T29 (parallel with T28). Dependency cards, dialogs and the deploy notice.**
      **Create** `apps/web/src/components/works/detail/settings/app-dependencies/AppDependencyCard.tsx`,
      `AppDependencyConfigureDialog.tsx`, `AppDependencyDeleteDataDialog.tsx`, and
      `apps/web/src/components/works/detail/settings/app-env/DeployBlockedByEnvNotice.tsx` (exported for APW-06).
      **Test**: `apps/web/src/components/works/detail/settings/app-dependencies/AppDependencyCard.unit.spec.tsx` — every
      status and backup state renders its copy; the no-backup warning is a warning role (ACC-07-14); 10 s polling
      starts/stops; a viewer sees Configure, Retry and Delete data disabled with "You need edit access to do this."
      (ACC-07-23). `AppDependencyDeleteDataDialog.unit.spec.tsx` — lists kept resources; enabled only on the exact slug
      (ACC-07-22). `AppDependencyConfigureDialog.unit.spec.tsx` — secret inputs never pre-filled.
      **Done when**: `pnpm --filter ever-works-web test -- AppDependencyCard AppDependencyDeleteDataDialog AppDependencyConfigureDialog`
      is green.

## P1.7 — i18n, tests, docs

- [ ] **T30. i18n.**
      **Modify** `apps/web/messages/en.json` with every key in [plan §8](./plan.md); mirror into the 20 sibling files under
      `apps/web/messages/`.
      **Test**: `node apps/web/scripts/sync-locale-parity.mjs && git diff --exit-code apps/web/messages` adds zero keys
      (ACC-07-25); a grep over the new leaves finds no `.`.
      **Done when**: both commands exit 0 in the PR.

- [ ] **T31. E2E.**
      **Create** `apps/web/e2e/app-env-table.spec.ts` (origins, set → value never re-rendered, rotate typed name —
      ACC-07-04, import results — ACC-07-11), `apps/web/e2e/app-env-deploy-blocked.spec.ts` (Deploy refused listing both
      unset names with descriptions — ACC-07-09), `apps/web/e2e/app-dependencies-cards.spec.ts` (seeded states incl. the
      no-backup warning — ACC-07-14, failed reason, delete-data dialog), `apps/web/e2e/app-env-a11y.spec.ts` (axe on both
      pages and all dialogs with no new violations + keyboard — ACC-07-25) ([plan §10.3](./plan.md)), seeded via the API with
      `EVER_WORKS_E2E_FAKES`; every spec scans captured network responses and the page for each seeded value (ACC-07-05).
      **Added by the 2026-09-17 fix pass.** **Modify** `.github/workflows/e2e.yml` to set a test-only
      `PLUGIN_SECRET_ENCRYPTION_KEY` (APW07-G06: App env refuses every write and generation without it in every
      `NODE_ENV`, and that workflow currently sets only `PLATFORM_ENCRYPTION_KEY`, so no row could ever read `Set`) and
      add a harness preflight that fails fast with `secureStorageUnavailable` when the key is missing; ask APW-13's T34
      for the same variable in `app-works-kind.yml`, and document the requirement in `apps/api/.env.example` and T33's
      docs page. **Create** the non-production fake dependency provider of T46 and drive the card states through it
      (APW07-G07: `EVER_WORKS_E2E_FAKES` only points Git at the fake GitHub and the PR lane has no cluster, so "seeded
      states incl. the no-backup warning, failed reason, delete-data dialog" had no way to exist).
      **Test**: `pnpm --filter ever-works-web test:e2e app-env- app-dependencies-cards`.
      **Done when**: all four pass locally and in `e2e.yml`, and the existing deploy runtime-env e2e specs pass unchanged.

- [ ] **T32. Live acceptance wiring.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (the APW-07 table in §3, through its owner) — map ACC-07-01…25,
      30 and 31 to the APW-13 harness scenarios on the two kind clusters (with and without the operator), the local SMTP
      server and the S3-compatible test server.
      **Test**: `rg -n "ACC-07-(0[1-9]|1[0-9]|2[0-5]|30|31)" docs/specs/features/app-works/ACCEPTANCE.md` lists every id with a
      scenario name.
      **Done when**: every P1 ACC-07 id names its scenario.

- [ ] **T33. Docs.**
      **Create** `docs/features/app-env-and-dependencies.md` — origins, generators and exact lengths, keypair formats,
      never-rotate, `.env` import grammar, providers per target, backup states, deleting data, deleting an App Work.
      **Modify** `apps/docs/sidebarsPlatform.ts`, `docs/plugin-system/built-in-plugins.md` (add `app-dependencies-external`;
      note the k8s plugin's new capability), `docs/plugin-system/plugin-categories.md` (add `app-dependency`).
      **Test**: `pnpm --filter ever-works-docs build` and `git diff --exit-code docs/runbooks/WORK_RUNTIME_ENV.md`.
      **Done when**: the build reports no broken links and the runbook has no diff.

- [ ] **T34. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — tick APW-07 P1.
      **Test**: root `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`;
      `pnpm --filter @ever-works/agent test -- work-runtime-env.service` passes with
      `packages/agent/src/services/work-runtime-env.service.spec.ts` unchanged (ACC-07-24); ACC-07-01…25, 29, 30 and 31
      walked.
      **Done when**: every command exits 0, `git diff --exit-code packages/agent/src/services/work-runtime-env.service.spec.ts`
      exits 0 and each walked criterion is recorded.

---

# Phase P2 — Dependencies on Ever Works Apps

_Delivers spec FR-51…FR-55 and ACC-07-26…28. Starts only after APW-10's launch gate passes. Managed dependencies are
resolved in the zone (APW-10); the platform never holds tenant data-server credentials and asks only
`AppsTierPolicy` whether the tier is open (R-5)._

- [ ] **T35. Tenant Postgres DDL builder and platform-server refusal.**
      **Create** `packages/contracts/src/apps/tenant-postgres-ddl.ts` — pure, dependency-free `buildTenantPostgresDdl` and
      `isPlatformDataServer(url, platformEndpoints)` ([plan §4.11](./plan.md)) so APW-10's zone controller can import them.
      **Test**: `packages/contracts/src/apps/__tests__/tenant-postgres-ddl.spec.ts` — exact statement order; every identifier
      double-quoted; `CONNECTION LIMIT 20` on the role and `25` on the database; `REVOKE CONNECT, TEMPORARY … FROM PUBLIC`;
      `statement_timeout = '60s'` and `idle_in_transaction_session_timeout = '60s'` (ACC-07-26); re-running yields `ALTER`
      not `CREATE`; `isPlatformDataServer` — host case, IPv6 brackets, default port 5432 equivalence, and a configured
      platform server is refused (ACC-07-27).
      **Done when**: `pnpm --filter @ever-works/contracts test -- tenant-postgres-ddl` is green and
      `packages/agent/src/ever-works-providers/ever-works-db-provision.service.ts` has no diff.

- [ ] **T36. `apps-tier-dependencies` plugin.**
      **Create** `packages/plugins/apps-tier-dependencies/` (package `@ever-works/apps-tier-dependencies-plugin`;
      `src/index.ts`, `src/plugin.ts`, `src/managed-postgres.provider.ts`, `src/managed-redis.provider.ts`,
      `src/managed-object-storage.provider.ts`, **`src/managed-smtp.provider.ts`** for providers `managed-postgres`,
      `managed-redis`, `managed-object-storage`, **`managed-smtp`** — GAP-22; `provision` writes `{ kind, ref }` through
      **`IAppsTierProvider.setDependencies(workId, deps)`** and reads `Work.status.dependencies[]`; no endpoint or
      credential settings;
      `outputsEncrypted` never written; `releaseDependencies(workId, { deleteData })` on removal). The change was
      `applyWork` before, which replaces the whole desired state and would have restarted the app's workloads for a
      dependency change (APW10-G01 / APW07-G19).
      **Modify** `packages/agent/src/facades/app-dependency.facade.ts` — resolvable only when
      `AppsTierPolicy.isOpen()` and the target is `ever-works-apps` (R-5).
      **Test**: `packages/plugins/apps-tier-dependencies/src/__tests__/apps-tier-dependencies.plugin.spec.ts` against an
      `IAppsTierProvider` fake — refs written per declared kind **through `setDependencies`**, never `applyWork`; ready
      mirrors zone status; no connection string or role name leaves the zone fake (ACC-07-26); **`managed-smtp` is offered
      on `ever-works-apps` and its outputs carry the relay endpoint, credential and from-address, so a `smtp: { required:
true }` App Work reaches `ready` while the tier's ports 25/465/587 stay refused (ACC-07-32, FR-61)**. Extend
      `packages/agent/src/app-dependencies/__tests__/app-dependencies.service.spec.ts`
      — the facade never offers these providers for Your cluster or while the policy is closed, and a spy proves
      `EVER_WORKS_APPS_MANAGED_ENABLED` is never read. The live isolation checks (another App Work's role refused, 21st
      connection refused, a 70-second statement cancelled at 60 s, bucket policy prefix, 10 GiB quota) run in APW-10's gated
      environment as ACC-07-26 via probe LG-14, **extended with `CONNECTION_LIMIT_NOT_ENFORCED` and
      `STATEMENT_TIMEOUT_NOT_ENFORCED` (APW10-G01)**.
      **Done when**: `pnpm --filter @ever-works/apps-tier-dependencies-plugin test` and
      `pnpm --filter @ever-works/agent test -- app-dependencies.service` are green.

- [ ] **T37. Managed backup reporting.**
      **Modify** `packages/plugins/apps-tier-dependencies/src/managed-postgres.provider.ts`,
      `managed-redis.provider.ts`, `managed-object-storage.provider.ts` — `backupStatus` reads
      `Work.status.dependencies[].lastBackupAt`; `overdue` beyond 24 hours.
      **Test**: extend `packages/plugins/apps-tier-dependencies/src/__tests__/apps-tier-dependencies.plugin.spec.ts` — fresh,
      27-hour-old (the FR-48 overdue line) and absent timestamps map to `healthy`, `overdue`, `unknown`, and a card view
      built from a 3-hour-old
      timestamp reads "last completed" (ACC-07-28). **APW07-G25:** the card's overdue line is FR-48's **26 hours**
      (`APP_DEPENDENCY_BACKUP_OVERDUE_MS`) for every card; `APP_DEPENDENCY_MANAGED.backupMaxAgeMs` (24 h) is the zone's own
      schedule target, so a 25-hour-old timestamp reads `overdue` only because the zone missed that target, and the test
      asserts the 26/27-hour boundary rather than treating 24 h as the card's rule.
      **Done when**: `pnpm --filter @ever-works/apps-tier-dependencies-plugin test` is green.

- [ ] **T38. P2 acceptance and ship gate.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (APW-07 rows ACC-07-26…28, through its owner) and
      `docs/specs/features/app-works/TRACKER.md` (tick P2).
      **Test**: ACC-07-26…28 walked in APW-10's gated environment (evidence in the private operations repository); root
      `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`.
      **Done when**: the three criteria are recorded green and every root command exits 0.

---

# Cross-phase closing tasks

- [ ] **T39. Telemetry.**
      **Create** `packages/agent/src/app-env/app-env.telemetry.ts` and
      `packages/agent/src/app-dependencies/app-dependencies.telemetry.ts` emitting the events in [plan §9.1](./plan.md);
      **Modify** `packages/agent/src/app-env/app-env.service.ts` and
      `packages/agent/src/app-dependencies/app-dependency-provision.runner.ts` to call them.
      **Test**: `packages/agent/src/app-env/__tests__/app-env.telemetry.spec.ts` — no payload contains an env name, a value,
      a host, a bucket name or a namespace (ACC-07-05).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env.telemetry` is green.

- [ ] **T40. Contracts and schema parity.**
      **Create** `packages/agent/src/works-config/schema/__tests__/dependency-outputs-parity.spec.ts` _(new — **moved**
      out of `packages/contracts/` by APW07-G20: `@ever-works/contracts` has zero dependencies and must not import the
      agent package, so the parity spec cannot live there)_ asserting
      `APP_DEPENDENCY_OUTPUTS` equals the outputs table APW-03 ships in its JSON Schema
      (`packages/agent/src/works-config/schema/` once APW-03 lands) and `APP_ENV_KEYPAIR_FORMATS` equals the schema's
      `keypair.format` enum. APW-03's reference resolver and JSON Schema **import** those two constants from
      `@ever-works/contracts` instead of re-declaring their own tables in `app-spec.refs.ts`.
      **Modify** `docs/specs/features/app-works/TRACKER.md` for APW-07 and, through its owner, `CONTRACTS.md` if the merged
      code differs from this epic's rows (three dependency routes, two events, `app-dependency` category, provider id pair,
      ephemeral mode targets, `stopWorkloads`).
      **Test**: `pnpm --filter @ever-works/contracts test -- dependency-outputs-parity`.
      **Done when**: the parity spec is green and every CONTRACTS row this epic owns matches merged code.

- [ ] **T41. Update statuses.**
      **Modify** `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`, `plan.md` and this file —
      `Implemented` / `Done`.
      **Test**: re-check every gate in [plan §12](./plan.md) against the merged code with a reviewer.
      **Done when**: each gate is ticked with a link to the code or test that proves it, and known gaps remain listed.

---

# Program audit follow-ups (added 2026-09-17)

- [ ] **T42. Keypair formats (Resolution R-11).**
      **Modify** `packages/agent/src/app-env/generators.ts` — `keypair(type, format)` per [plan §4.3](./plan.md):
      `base64url-raw` for `ed25519` / `ec-p256` via JWK export, `pkcs12` with a self-signed certificate encrypted with the value of the
      `generate.keypair.passwordEnv` entry (generated first, stored as its own env value; rotating it re-packs the bundle);
      fingerprint `keypair:<type>:<format>[:<passwordEnv>]`; format or `passwordEnv` change → `generatorChanged`. **Modify** `packages/agent/package.json` —
      add `@peculiar/x509` and `pkijs`. **Modify** `packages/agent/src/app-env/app-env.service.ts` — store the public half
      as `<NAME>_PUBLIC` only, for every format.
      **Test**: `packages/agent/src/app-env/__tests__/keypair-formats.spec.ts` — `pem` PKCS#8 + SPKI; `ed25519`
      `base64url-raw` private and public each 43 characters, `ec-p256` public 87 characters; an RSA type with
      `base64url-raw` refused; `pkcs12` opens with the password entry's value, fails with an empty passphrase, and its certificate's public key
      matches; the password entry is generated before the keypair and rotating it keeps the key pair; in every
      format a signature made with the private half verifies with the public half, and the only derived row is
      `<NAME>_PUBLIC` (ACC-07-29).
      **Done when**: `pnpm --filter @ever-works/agent test -- keypair-formats generators` is green.

- [ ] **T43. Ephemeral mode and ephemeral dependencies (Resolution R-10).**
      **Modify** `packages/agent/src/app-env/app-env-runtime.source.ts` — `resolveEphemeral(workId, specCommitSha, ctx)`
      with `ctx.target` `cluster` (in-memory `values`) and `runner` (value-free `recipe`), per [plan §4.6.1](./plan.md).
      **Modify** `packages/agent/src/app-dependencies/app-dependencies.service.ts` — `provisionEphemeral(workId, namespace,
kinds)` calling providers with `ephemeral: true` and returning outputs in memory. **Modify**
      `packages/plugins/k8s/src/app-dependencies/postgres.provider.ts`, `redis.provider.ts`, `object-storage.provider.ts` —
      the ephemeral variant (plain path, `emptyDir`, no stored outputs).
      **Test**: `packages/agent/src/app-env/__tests__/app-env-ephemeral.spec.ts` — a repository spy records zero inserts and
      updates on `work_app_env_values` and `work_app_dependencies`; two calls return different generated values; an unset
      required prompted value is listed in `unsetRequired` by name; a set prompted value is included only for `cluster`;
      the `runner` recipe contains no value from the store or generator (sentinel search) (ACC-07-31); **the `runner`
      recipe matches the normative `AppEnvRecipeEntry` union shape of plan §4.6.1 token by token, including the fixed
      container host/port/user grammar (`postgres`/`redis`/`object-storage`, never `minio`) so APW-05 cannot build a
      different format (APW07-G18); a `cluster` call resolves a derived reference from `ctx.dependencyOutputs` and the
      values it produces never reach a repository (APW07-G04, ACC-07-31)**.
      `packages/plugins/k8s/src/app-dependencies/__tests__/ephemeral.spec.ts` — each provider renders no
      `PersistentVolumeClaim` or `volumeClaimTemplates` and returns outputs without calling any persistence callback
      (ACC-07-31).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-env-ephemeral` and
      `pnpm --filter @ever-works/k8s-plugin test -- ephemeral` are green.

- [ ] **T44. Deleting an App Work (Resolution R-15).**
      **Modify** `packages/agent/src/app-dependencies/app-dependencies.service.ts` — `onAppWorkDeleting(workId,
{ deleteStoredData })` per [plan §4.12](./plan.md), idempotent. **Modify**
      `packages/plugins/k8s/src/app-dependencies/postgres.provider.ts`, `redis.provider.ts`, `object-storage.provider.ts` —
      `deprovision` option `stopWorkloads` (scale to 0 / hibernate; PVCs, Secrets and policies untouched).
      **Test**: `packages/agent/src/app-dependencies/__tests__/app-dependencies.deletion.spec.ts` — without
      `deleteStoredData` two ready dependencies are deprovisioned with `{ deleteData: false, stopWorkloads: true }`, both rows
      become `kept`, and exactly two `app.dependency.released` and zero `app.dependency.data_deleted` events are recorded;
      with it both are deleted and two `app.dependency.data_deleted` are recorded; a `pending` row records nothing; a second
      call is a no-op (ACC-07-30). `packages/plugins/k8s/src/app-dependencies/__tests__/deprovision.spec.ts` —
      `stopWorkloads` issues only scale patches and zero deletes (ACC-07-30).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-dependencies.deletion` and
      `pnpm --filter @ever-works/k8s-plugin test -- deprovision` are green.

- [ ] **T45 (P1, lands with T5–T7). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'app-env-values.jsonl', entity: 'WorkAppEnvValue', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`
      and
      `{ file: 'app-dependencies.jsonl', entity: 'WorkAppDependency', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — `ENTITY_SECRET_COLUMNS` gains
      `WorkAppEnvValue: ['valueEncrypted']` and `WorkAppDependency: ['configEncrypted', 'outputsEncrypted']`, so each
      becomes `{ wasSet }` while env names, origins, dependency kinds, statuses and backup states export as stored;
      `ENTITY_DROPPED_COLUMNS` gains `WorkAppEnvValue: ['valueBytes']` (a value's length is never shown, plan §3.1).
      Neither table joins `BACKUP_DROPPED_ENTITIES`. None of the three column names matches the shape rules or the
      secret-shaped guard in `redaction.spec.ts`, so these explicit entries are the only thing keeping the values out.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — both entities are
      referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`; an `EntityBackupCollector` over
      the `works` spec yields a fixture `WorkAppEnvValue` row
      `{ name: 'SESSION_SECRET', valueEncrypted: 'enc::v1::<sentinel>', valueBytes: 44 }` with `name` intact,
      `valueEncrypted: { wasSet: true }` and no `valueBytes` key, and `WorkAppDependency` rows whose `configEncrypted` /
      `outputsEncrypted` become `{ wasSet: true }` (sentinel envelopes) or `{ wasSet: false }` (`null`, as for
      `ever-works-apps`); no yielded line contains the sentinel or `enc::v1::`.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green, and removing either new
      `ENTITY_SECRET_COLUMNS` entry turns the new case red.

---

## Fix-pass additions (added 2026-09-17)

- [ ] **T46 (P1, lands with T22/T24/T25). Fake dependency provider, and the Activity-vs-telemetry boundary (APW07-G07, APW07-G14).**
      **Create** `packages/plugins/app-dependencies-external/src/fake.provider.ts` _(new)_ — a non-production
      `app-dependency` provider registered only when `EVER_WORKS_E2E_FAKES=1` **and** `NODE_ENV !== 'production'`, whose
      outcomes (`ready`, `failed` with a reason, any backup state, `kept`, `awaiting_config`) are driven through the
      existing fake-harness control endpoint. It is the only way the PR-lane Playwright specs can render the card states
      T31 asserts, because the PR lane has no cluster and `EVER_WORKS_E2E_FAKES` today only points Git at the fake
      GitHub.
      **Create** `packages/agent/src/activity-log/__tests__/app-activity-analytics.spec.ts` _(new)_ — pins the boundary
      plan §9.1 states: an `app_env` / `app_dependency` row may carry names, kinds and counts to Activity **and** to the
      analytics sink (`ActivityLogService.log` → `jitsu.service.ts`, which forwards `summary`, `details` and all
      `metadata`), and the dispatched payload contains no `value`, `valueEncrypted`, `configEncrypted`,
      `outputsEncrypted`, prompt, host, bucket name, connection string or namespace. Removing the guard turns it red.
      **Test**: `pnpm --filter @ever-works/app-dependencies-external-plugin test -- fake.provider` and
      `pnpm --filter @ever-works/agent test -- app-activity-analytics` are green; the fake provider is absent in a
      production build.
      **Done when**: both specs pass and `app-dependencies-cards.spec.ts` renders every state T31 lists without a cluster.

- [ ] **T47 (P1, lands with T19–T21). Dependency resize (APW07-G22 / FR-63).**
      **Modify** `packages/agent/src/app-dependencies/app-dependency-provision.runner.ts` — a `resize` mode that patches
      the volume claim when the storage class allows expansion, updates `sizeGiB`, emits `app_dependency_resize`
      (`kind`, `fromGiB`, `toGiB`) and records Activity with the two amounts; **Modify**
      `packages/plugins/k8s/src/app-dependencies/postgres.provider.ts`, `redis.provider.ts`,
      `object-storage.provider.ts` — a `resize(providerId, ctx, { sizeGiB })` capability honouring
      `allowVolumeExpansion` on the storage class and reporting `volumeExpansionUnsupported` naming the class when it is
      off; **Modify** `packages/plugins/apps-tier-dependencies/src/managed-*.provider.ts` — the managed variants resize
      through the zone's dependency record.
      **Test**: `packages/plugins/k8s/src/app-dependencies/__tests__/resize.spec.ts` _(new)_ — a larger request patches the
      claim and leaves the workload untouched; a class without `allowVolumeExpansion` → `volumeExpansionUnsupported`; a
      smaller request never reaches the provider (it is refused at the API, T25). Extend
      `app-dependency-provision.runner.spec.ts` — one `resize` dispatch, one Activity row, quantities only.
      **Done when**: `pnpm --filter @ever-works/k8s-plugin test -- resize` and
      `pnpm --filter @ever-works/agent test -- app-dependency-provision.runner` are green and ACC-07-34 is walked.

- [ ] **T48 (P1 test lane, cross-epic with APW-13). The live dependency lane needs an owner (APW07-G08).**
      ACCEPTANCE §1 promises a PR-cluster lane with **two kind clusters for APW-07** — one with the CloudNativePG
      operator, one without — plus an S3-compatible test server and a mail sink, but APW-13 sets up one kind cluster with
      no operator and no S3 server, and no spec file covers the live halves of ACC-07-14/15/16/20.
      **Modify** (through APW-13's owner) `.github/workflows/app-works-kind.yml` — a matrix `postgresOperator: [none,
cnpg]` installing a pinned operator release on the `cnpg` leg, plus the S3-compatible test server and the mail
      sink; **Create** `apps/web/e2e/flow-app-works-kind-dependencies.spec.ts` _(new)_ with one named scenario per
      ACC-07 id it proves (the operator path, the plain path, bucket creation, the no-storage-class failure, the 3×15 min
      retry); set `EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST` for the local sink (T22, APW07-G09).
      **Test**: the workflow's two legs are green, and T32's `rg` check names the new spec's scenarios rather than a
      generic clause.
      **Done when**: `app-works-kind.yml` runs both legs and every live ACC-07 id names the scenario that proves it.

## Definition of Done

- Every checkbox above is ticked for the phases being shipped.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the repo root.
- `work-runtime-env.constants.ts`, `work-runtime-env.service.ts`, `ever-works-db-provision.service.ts`,
  `docs/runbooks/WORK_RUNTIME_ENV.md` and `RuntimeEnvManagement.tsx` have **no diff**, and their specs pass unchanged.
- A repository-wide scan of test output (API responses, logs, Activity rows, telemetry) for every value the suites set or
  generated returns zero matches.
- Every acceptance box in [spec §8](./spec.md) for the shipped phase has been walked against real clusters and servers,
  and each ACC-07 id appears in at least one **Test** line above.
- No read of `EVER_WORKS_APPS_MANAGED_ENABLED` in this epic's code (R-5).
- Every gate in [plan §12](./plan.md) is confirmed, and its known gaps are still recorded there rather than silently closed.

## Status notes

Dated status for the tasks above. It is kept here, not in the task bodies, so the task text keeps the line numbers that
code comments and specs cite.

- **T14 (2026-09-26):** both halves now reach the API. `AppEnvModule` (with `AppEnvResolver` and
  `APP_ENV_RESOLVER_FINGERPRINTS`) is imported by APW-05's `AppBuildsModule` (`e23c2f844`), and `read(workId, 'build')`
  resolves against the effective spec's `build.services`, as the prepare runner does. `AppRuntimeEnvModule`
  (`APP_RUNTIME_ENV_SOURCE`) is imported by APW-06's `AppDeployRequestModule` (`3a956180e`), which also makes
  `AppBuildsModule`'s lazy runner-recipe lookup of `AppEnvRuntimeSource` resolve. `APP_DEPENDENCY_SPEC_SOURCE` (T25)
  is still unbound, so `ensureReadyForDeploy` answers `specUnavailable`.
- **T15 (2026-09-26, `3a956180e`):** `AppEnvListener` is provided only by `AppRuntimeEnvModule`, which is now in the
  API graph through `AppDeployRequestModule`'s import, so `app.spec.applied` runs `ensureGenerated` (idempotent) and
  `reconcile` in the API. A class module is one instance however many modules import it, so the listener is subscribed
  once; do not provide it anywhere else.
