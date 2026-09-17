# `manifests/app-fixture-hello/` — golden rendered output, index

**App spec:** [`APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml`](../../../../APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml)
(`sha256` of its LF-normalised bytes: `d5cff638ec9ef0cd0b8d6e75a4327e8f2cbc43f09af2c8bf2fc3ed6986320be7`)
**Renderer:** `packages/plugins/k8s/src/app/` — `app-manifest.renderer.ts` (APW-06 **T6**), `app-names.ts` (T4),
`app-security.ts` (T5), `app-jobs.renderer.ts` + `app-runner.script.ts` (T8), `app-network-policy.renderer.ts` (T7)
**Target rendered here:** `your-cluster` (the second flavour is `managed-overlay.yaml`)
**Why this app:** `ever-works/app-fixture-hello` is the purpose-built acceptance application — "the smallest
application that makes every App spec feature observable from outside the cluster" (`APW-13-golden-paths/plan.md:169-259`;
`blueprints/app-fixture-hello/README.md:7-9`). It is the app the live lane drives in **ACC-E2E-05**
(`ACCEPTANCE.md:302-357`), whose Kubernetes assertions are written against exactly these objects.

---

## 1. Pinned render inputs

| Input                                       | Pinned value                                                              | Comes from                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ref.target`                                | `your-cluster`                                                            | `WorkAppRuntimeState.target`                                                            |
| `ref.namespace`                             | `ew-app-fixture-hello-22222222`                                           | `ew-<slug ≤ 30>-<first 8 hex of workId>` (APW-06 plan §4.1)                             |
| `ref.workId`                                | `22222222-2222-4222-8222-222222222222`                                    | placeholder Work uuid                                                                   |
| `workSlug`                                  | `app-fixture-hello`                                                       | the App Work's slug                                                                     |
| `deploymentId` / `deploymentShort`          | `44444444-4444-4444-8444-444444444444` / `44444444`                       | placeholder `WorkDeployment`                                                            |
| `specCommitSha` = `build.commitSha`         | `b1c2d3e4f5061728394a5b6c7d8e9f0112345678`                                | APW-05 `WorkBuild.commitSha`                                                            |
| `isFirstDeploymentOnCluster`                | `true`                                                                    | so `job-bootstrap` is rendered (ACC-13-03)                                              |
| `skipPreDeployJobs`                         | `false`                                                                   | so `job-migrate` is rendered                                                            |
| `image.reference`                           | `ghcr.io/example-owner/app-fixture-hello/ever-works-app@sha256:0123…cdef` | FR-27 image name + a digest                                                             |
| `image.pull`                                | **not set** (public image)                                                | `AppImagePullCredentialSource.resolve()` → `null`; no `app-pull`, no `imagePullSecrets` |
| `hosts.primary`                             | `app-fixture-hello.apps.example.com`                                      | managed subdomain on Your cluster (R-16)                                                |
| `hosts.extra` / `hosts.previous`            | `[]`                                                                      | —                                                                                       |
| `ingress.className` / `controllerNamespace` | `nginx` / `ingress-nginx`                                                 | the connection check                                                                    |
| `ingress.tls` / `issuer`                    | `cert-manager` / `letsencrypt`                                            | `targetSettings.tls` / `.issuer`                                                        |
| `network.isolation`                         | `true`                                                                    | default                                                                                 |
| `network.needsHairpin`                      | `false`                                                                   | `spec.domains.needsHairpin` (works.yml:116)                                             |
| `policy.podSecurity`                        | `baseline` enforce, `restricted` warn+audit                               | APW-06 plan §4.4                                                                        |
| `policy.quota`                              | `null`                                                                    | `ResourceQuota` is `ever-works-apps` only                                               |

Placeholders: `example.com`, `example-owner`, `2222…`/`4444…`, `sha256:0123…`, `sha256:0000…`.
**No secret value, real hostname or cluster address appears in this directory.**

---

## 2. Files, and the spec field behind each object

| File                             | Object(s)                                                      | App spec field(s)                                                                  | Epic rule                        |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| `00-namespace.yaml`              | `Namespace ew-app-fixture-hello-22222222`                      | _(derived from slug + workId)_                                                     | plan §4.1                        |
| `01-serviceaccount.yaml`         | `ServiceAccount app`                                           | _(none)_                                                                           | plan §4.1, §4.3                  |
| `02-limitrange.yaml`             | `LimitRange ew-defaults`                                       | _(defaults)_                                                                       | plan §4.2                        |
| `03-configmap-platform.yaml`     | `ConfigMap app-platform-fa90df132e`                            | _(platform `EVER*WORKS*_`)\*                                                       | plan §4.7                        |
| `04-secret-env.yaml`             | `Secret app-env-fa90df132e`                                    | `spec.env[]`, `phase ∈ {runtime, both}` (12 names; `FIXTURE_BUILD_LABEL` excluded) | plan §4.1, §4.7                  |
| `10-deployments.yaml`            | `Deployment web`, `Deployment worker`                          | `spec.components[0]`, `spec.components[1]`                                         | plan §4.3                        |
| `11-services.yaml`               | `Service web`                                                  | `spec.components[0].role: web` + `.port`                                           | plan §4.3                        |
| `12-ingress.yaml`                | `Ingress web`                                                  | `spec.domains.primaryComponent: web`                                               | plan §4.11                       |
| `20-persistentvolumeclaims.yaml` | `PersistentVolumeClaim web-uploads`                            | `spec.components[0].volumes[0]`                                                    | plan §4.6                        |
| `30-networkpolicies.yaml`        | 5 × `NetworkPolicy`                                            | `spec.dependencies` (egress); `needsHairpin: false`                                | plan §4.10                       |
| `40-configmap-runner.yaml`       | `ConfigMap ew-runner-918eaf204a`                               | `spec.cron[]` + `spec.smoke[]` (as data)                                           | plan §4.8, §4.9                  |
| `50-jobs.yaml`                   | `Job job-migrate-44444444`, `Job job-bootstrap-44444444`       | `spec.jobs[]` (`pre-deploy`, `first-deploy`)                                       | plan §4.8, §5.5                  |
| `60-cronjobs.yaml`               | `CronJob cron-tick`                                            | `spec.cron[0]`                                                                     | plan §4.9                        |
| `managed-overlay.yaml`           | `Namespace`, `LimitRange`, `ResourceQuota`, both `Deployment`s | same fields, target `ever-works-apps`                                              | plan §4.2, §4.4, §4.5, §4.9; R-5 |

**Absent by construction:** no `05-secret-pull.yaml` (public image), no PVC for the worker, no Service or
Ingress for the worker, no `EVER_WORKS_SOURCE_URL` (MIT), no hairpin rule in `ew-allow-deps`.

---

## 3. Component mapping (`spec.components[]` → rendered)

| App spec field           | `web` (works.yml)                                            | `worker` (works.yml)                                        | Rendered as                                                                                                                  |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | `web`                                                        | `worker`                                                    | object name, container name, selector `ever-works.io/component: <name>`                                                      |
| `role`                   | `web`                                                        | `worker`                                                    | `web` → Service + Ingress; `worker` → neither (ACC-E2E-05)                                                                   |
| `command`                | `['node','src/server.mjs']`                                  | `['node','src/worker.mjs']`                                 | `containers[0].command`                                                                                                      |
| `port`                   | `8080`                                                       | _(forbidden)_                                               | `ports[0].containerPort`; Service `targetPort`                                                                               |
| `replicas`               | `1`                                                          | `1`                                                         | `spec.replicas`                                                                                                              |
| `writableRootFilesystem` | `false`                                                      | _(absent → false)_                                          | `readOnlyRootFilesystem: true` + `/tmp` emptyDir `sizeLimit: 256Mi` on both                                                  |
| `probes.startup`         | `{ http: /healthz, periodSeconds: 2, failureThreshold: 30 }` | —                                                           | `startupProbe` (timeout 5 / delay 0 from the schema)                                                                         |
| `probes.readiness`       | `{ http: /readyz }`                                          | —                                                           | `readinessProbe`, period 10 / failureThreshold 3 (schema defaults)                                                           |
| `probes.liveness`        | `{ http: /healthz, periodSeconds: 20 }`                      | —                                                           | `livenessProbe`, + schema defaults                                                                                           |
| _(derived)_              | —                                                            | —                                                           | `minReadySeconds: 0` (has probes) / **30** (worker, no probes — spec FR-28)                                                  |
| `resources.cpu`          | `50m`                                                        | `25m`                                                       | `requests.cpu`                                                                                                               |
| `resources.memory`       | `64Mi`                                                       | `48Mi` ⚠️ below the schema minimum — contradictions **X-3** | `requests.memory`                                                                                                            |
| `resources.memoryLimit`  | `128Mi`                                                      | `96Mi`                                                      | `limits.memory`                                                                                                              |
| `resources.cpuLimit`     | _(absent)_                                                   | _(absent)_                                                  | none on Your cluster; `1` on Ever Works Apps (`max(1, 4 × cpu)`)                                                             |
| `volumes`                | `[{ name: uploads, path: /data, size: 1Gi, backup: false }]` | _(absent)_                                                  | PVC `web-uploads`, mount at `/data`, `ever-works.io/backup: "false"`; `strategy: Recreate`; `fsGroup: 10001`                 |
| _(derived)_              | —                                                            | —                                                           | `progressDeadlineSeconds: 300` = `clamp(2×30 + 10×3 + 120, 300, 2400)` for `web`; `clamp(0 + 0 + 120, …) = 300` for `worker` |

---

## 4. Checksums and derived names

**Env checksum.** Same canonical form as cal-diy (`hashRuntimeEnv` shape: keys sorted, `key=value` lines joined
with `\n`, no trailing newline, sha256 hex truncated):

```text
DATABASE_URL=<redacted>
EVER_WORKS_APP_COMMIT=b1c2d3e4f5061728394a5b6c7d8e9f0112345678
EVER_WORKS_APP_HOST=app-fixture-hello.apps.example.com
EVER_WORKS_APP_URL=https://app-fixture-hello.apps.example.com
EVER_WORKS_DEPLOYMENT_ID=44444444-4444-4444-8444-444444444444
FIXTURE_CRON_TOKEN=<redacted>
FIXTURE_GIT_SHA=<redacted>
FIXTURE_INTERNAL_URL=<redacted>
FIXTURE_MAIL_TO=<redacted>
FIXTURE_MARKER=<redacted>
FIXTURE_PUBLIC_URL=<redacted>
FIXTURE_SESSION_SECRET=<redacted>
SMTP_FROM=<redacted>
SMTP_HOST=<redacted>
SMTP_PASSWORD=<redacted>
SMTP_PORT=<redacted>
SMTP_USER=<redacted>
```

`sha256` = `fa90df132e185345975edcb8e04ee2a45def74e6dbe7d3dc04430f1003ced1f1`
→ `checksum16 = fa90df132e185345` (pod annotation), `checksum10 = fa90df132e` (Secret + ConfigMap names).

`FIXTURE_BUILD_LABEL` is **absent**: it is `phase: build` (works.yml:91). ACC-E2E-05 asserts exactly that
exclusion, and the four-key ConfigMap ("only `EVER_WORKS_*` names", `ACCEPTANCE.md:336-338`).

**Runner ConfigMap name.** `ew-runner-918eaf204a` = first 10 hex of
`sha256("22222222-2222-4222-8222-222222222222|ever-works-runner|v1")`
(`918eaf204adeb17fcfb71215acee5456c43e06287d37696ecd31ca778a386b67`). Open question Q-4.

**TLS secret name.** `app-fixture-hello-apps-example-com-tls` (nginx strategy's `tlsSecretName`).

**Other names.** Job `job-<name>-44444444`; CronJob `cron-tick`; PVC `web-uploads`.

---

## 5. Env name → source (names only, never values)

`Secret app-env-fa90df132e` keys:

| Env name                                                                | `spec.env[]` (works.yml line) | Source kind                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                          | :71                           | derived `deps.postgres.url`                                                                         |
| `SMTP_HOST`                                                             | :72                           | derived `deps.smtp.host`                                                                            |
| `SMTP_PORT`                                                             | :73                           | derived `deps.smtp.port`                                                                            |
| `SMTP_USER`                                                             | :74                           | derived `deps.smtp.user`                                                                            |
| `SMTP_PASSWORD`                                                         | :75                           | derived `deps.smtp.password`                                                                        |
| `SMTP_FROM`                                                             | :76                           | derived `deps.smtp.from`                                                                            |
| `FIXTURE_PUBLIC_URL`                                                    | :77                           | derived `domains.primary.url`                                                                       |
| `FIXTURE_INTERNAL_URL`                                                  | :78                           | derived `components.web.internalUrl` → `http://web.ew-app-fixture-hello-22222222.svc.cluster.local` |
| `FIXTURE_GIT_SHA`                                                       | :79                           | derived `build.commitSha`                                                                           |
| `FIXTURE_MARKER`                                                        | :80-81                        | prompted, required (the harness supplies a run-unique value at creation)                            |
| `FIXTURE_MAIL_TO`                                                       | :82-83                        | prompted, required                                                                                  |
| `FIXTURE_SESSION_SECRET`                                                | :84-87                        | generated (`chars`, 32), validated 32 chars — ACC-NEG-12 reads only its length and a hash prefix    |
| `FIXTURE_CRON_TOKEN`                                                    | :88-90                        | generated (`hex`, 32 bytes)                                                                         |
| `EVER_WORKS_APP_COMMIT` / `_HOST` / `_URL` / `EVER_WORKS_DEPLOYMENT_ID` | _(platform)_                  | keys of `ConfigMap app-platform-fa90df132e` instead                                                 |

---

## 6. Acceptance ids this directory is the golden output for

| Id                                       | What these objects prove                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ACC-E2E-05** (`ACCEPTANCE.md:334-341`) | Deployments `web` + `worker`; Service and Ingress for `web` only; `job-migrate-<id>` complete; `CronJob cron-tick` `*/2 * * * *`; PVC `web-uploads`; `Secret app-env-<checksum>` immutable with the run-phase key set; `ConfigMap app-platform-<checksum>` with only `EVER_WORKS_*`; no env value in any pod spec; bootstrap completion and in-cluster smoke both precede the Ingress `creationTimestamp` |
| **ACC-13-03**                            | `FIXTURE_INTERNAL_URL` is the in-cluster Service address, so the first-deploy job saw the app internally and not publicly                                                                                                                                                                                                                                                                                 |
| **ACC-13-08 / ACC-06-09**                | the pre-deploy `migrate` Job uses the component's own image and env, and its failure precedes any component change                                                                                                                                                                                                                                                                                        |
| **ACC-06-07**                            | `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `runAsNonRoot: true`, no token, read-only root, `/tmp` on read-only components                                                                                                                                                                                                                           |
| **ACC-06-15**                            | `ever-works.io/env-checksum` changes when one env value changes and is byte-identical otherwise                                                                                                                                                                                                                                                                                                           |
| **ACC-06-16**                            | the image is digest-pinned and no pull credential other than the render input's appears                                                                                                                                                                                                                                                                                                                   |
| **ACC-06-17**                            | the five NetworkPolicies, every excepted CIDR, and the `needsHairpin: false` variant                                                                                                                                                                                                                                                                                                                      |
| **ACC-06-18**                            | the PVC survives redeploy/pause/rollback/remove-without-data; a volume with `replicas: 2` is refused (**not** in this rendering — `replicas: 1`)                                                                                                                                                                                                                                                          |
| **ACC-06-29**                            | the TLS block exists for `cert-manager` and lists every host                                                                                                                                                                                                                                                                                                                                              |
| **ACC-NEG-11**                           | `smoke/marker`'s `bodyNotContains: ['localhost']` is the check that quotes the found string and rolls back                                                                                                                                                                                                                                                                                                |
| **ACC-NEG-12**                           | the generated-value fingerprint is identical across redeploy, rebuild, restart, spec re-apply and upstream sync                                                                                                                                                                                                                                                                                           |

`packages/plugins/k8s/src/app/__tests__/app-manifest.renderer.spec.ts` (APW-06 T6) is the unit-level
assertion point; the kind lane (APW-13 T35) and the live lane are the integration-level ones. See
`../../golden-test-plan.md`.
