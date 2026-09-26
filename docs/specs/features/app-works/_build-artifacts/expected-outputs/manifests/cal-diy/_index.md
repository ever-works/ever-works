# `manifests/cal-diy/` — golden rendered output, index

**App spec:** [`ever-works/cal-template` `.works/works.yml`](https://github.com/ever-works/cal-template/blob/main/.works/works.yml)
(`sha256` of the LF-normalised bytes this index was rendered from: `6977cfdf9b4ae12e83e6c0710ebef2b27d36f46e1fc875dd376bd0d1bcb0ecea`)
_Note (2026-09-26): this is a generated expected-output index, not an evidence transcript; it was rendered from the retired in-tree draft `APW-13-golden-paths/blueprints/cal-diy/.works/works.yml`, whose content now lives in the Blueprint repository above, so its `works.yml:` line citations may drift from the live file._
**Renderer:** `packages/plugins/k8s/src/app/` — `app-manifest.renderer.ts` (APW-06 **T6**), `app-names.ts` (T4),
`app-security.ts` (T5), `app-jobs.renderer.ts` + `app-runner.script.ts` (T8), `app-network-policy.renderer.ts` (T7)
**Target rendered here:** `your-cluster` (the second flavour is `managed-overlay.yaml`)
**Cal.diy is the program's flagship golden path** (`APW-13-golden-paths/spec.md:32-33`; the golden-path lane
defaults to it, `plan.md:501`).

---

## 1. Pinned render inputs

`AppRenderInput` (CONTRACTS §3) is not derivable from the App spec alone — the Work's identity, its
namespace, its hosts and the target's ingress/TLS settings come from platform state. This golden set pins
them as follows, so the renderer's output is a function of nothing else.

| Input                                       | Pinned value                                                    | Comes from                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ref.target`                                | `your-cluster`                                                  | `WorkAppRuntimeState.target`                                                                                       |
| `ref.namespace`                             | `ew-cal-diy-11111111`                                           | `appNamespaceName('cal-diy', workId)` — `ew-<slug ≤ 30>-<first 8 hex>` (APW-06 plan §4.1)                          |
| `ref.workId`                                | `11111111-1111-4111-8111-111111111111`                          | placeholder Work uuid; its first 8 hex are `11111111`                                                              |
| `workSlug`                                  | `cal-diy`                                                       | the App Work's slug                                                                                                |
| `deploymentId` / `deploymentShort`          | `33333333-3333-4333-8333-333333333333` / `33333333`             | placeholder `WorkDeployment`                                                                                       |
| `specCommitSha` = `build.commitSha`         | `a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`                      | APW-05 `WorkBuild.commitSha`; APW-06 spec FR-25 ("image and App spec always come from the same commit")            |
| `isFirstDeploymentOnCluster`                | `true`                                                          | so the first-deploy Job is rendered                                                                                |
| `skipPreDeployJobs`                         | `false`                                                         | so the pre-deploy Job is rendered                                                                                  |
| `image.reference`                           | `ghcr.io/example-owner/cal.diy/ever-works-app@sha256:0123…cdef` | APW-05 spec FR-27 image name + a digest; APW-06 spec FR-32 ("Deployments reference a Build's digest, never a tag") |
| `image.pull`                                | **set** (private package)                                       | `AppImagePullCredentialSource.resolve(workId, buildId)`; APW-06 spec FR-19                                         |
| `hosts.primary`                             | `cal-diy.apps.example.com`                                      | managed subdomain on Your cluster, `<slug>.<apps-domain>` (R-16, spec FR-41)                                       |
| `hosts.extra` / `hosts.previous`            | `[]`                                                            | `WorkCustomDomain` rows are platform data, not App spec fields                                                     |
| `ingress.className` / `controllerNamespace` | `nginx` / `ingress-nginx`                                       | the connection check's detected class + controller namespace                                                       |
| `ingress.tls` / `issuer`                    | `cert-manager` / `letsencrypt`                                  | `WorkAppRuntimeState.targetSettings.tls` / `.issuer`                                                               |
| `network.isolation`                         | `true`                                                          | default; the Your-cluster opt-out renders **zero** NetworkPolicies (APW-06 plan §4.10)                             |
| `network.needsHairpin`                      | `true`                                                          | `spec.domains.needsHairpin` (works.yml:247)                                                                        |
| `policy.podSecurity`                        | `baseline` enforce, `restricted` warn+audit                     | APW-06 plan §4.4, spec FR-22                                                                                       |
| `policy.allowRoot`                          | `false`                                                         | default                                                                                                            |
| `policy.runtimeClassName`                   | `null`                                                          | Your cluster names none                                                                                            |
| `policy.quota`                              | `null`                                                          | `ResourceQuota` is `ever-works-apps` only (APW-06 plan §4.2)                                                       |
| `purpose`                                   | `deploy` (not `verification`)                                   | R-10; the verification variant is exercised by ACC-06-48                                                           |

`example.com`, `example-owner`, `1111…`/`3333…` and the `sha256:0123…`/`sha256:0000…` digests are
documentation placeholders (RFC 2606 / RFC 9562). **No secret value, real hostname or cluster address
appears in this directory.**

---

## 2. Files, and the spec field behind each object

| File                         | Object(s)                                                      | App spec field(s) that produce it                                   | Epic rule                                |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `00-namespace.yaml`          | `Namespace ew-cal-diy-11111111`                                | _(none — derived from the Work's slug + id)_                        | plan §4.1; spec FR-10                    |
| `01-serviceaccount.yaml`     | `ServiceAccount app`                                           | _(none)_                                                            | plan §4.1, §4.3; spec FR-12              |
| `02-limitrange.yaml`         | `LimitRange ew-defaults`                                       | _(defaults for containers the spec under-specifies)_                | plan §4.2; spec FR-15                    |
| `03-configmap-platform.yaml` | `ConfigMap app-platform-3b2eee9155`                            | _(none — the platform's own `EVER*WORKS*_` values)\*                | plan §4.7; spec FR-18                    |
| `04-secret-env.yaml`         | `Secret app-env-3b2eee9155`                                    | `spec.env[]` where `phase ∈ {runtime, both}`                        | plan §4.1, §4.7; spec FR-17              |
| `05-secret-pull.yaml`        | `Secret app-pull`                                              | _(none — APW-05's read-only pull credential)_                       | plan §4.7; spec FR-19                    |
| `10-deployments.yaml`        | `Deployment web`                                               | `spec.components[0]`                                                | plan §4.3; spec FR-11                    |
| `11-services.yaml`           | `Service web`                                                  | `spec.components[0].role: web` + `.port`                            | plan §4.3; spec FR-11                    |
| `12-ingress.yaml`            | `Ingress web`                                                  | `spec.domains.primaryComponent` + the platform's hosts/TLS settings | plan §4.11; spec FR-38…FR-42             |
| `30-networkpolicies.yaml`    | 5 × `NetworkPolicy`                                            | `spec.dependencies` (egress) + `spec.domains.needsHairpin`          | plan §4.10; spec FR-20                   |
| `40-configmap-runner.yaml`   | `ConfigMap ew-runner-1bd8272a14`                               | `spec.cron[]` + `spec.smoke[]` (as **data**, never as commands)     | plan §4.8, §4.9, §4.10                   |
| `50-jobs.yaml`               | `Job job-migrate-33333333`, `Job job-bootstrap-admin-33333333` | `spec.jobs[]`                                                       | plan §4.8, §5.5; spec FR-26 rows 2 and 4 |
| `60-cronjobs.yaml`           | 7 × `CronJob cron-<name>`                                      | `spec.cron[]`                                                       | plan §4.9; spec FR-26 row 9              |
| `managed-overlay.yaml`       | `Namespace`, `LimitRange`, `ResourceQuota`, `Deployment web`   | same fields, target `ever-works-apps`                               | plan §4.2, §4.4, §4.5, §4.9; R-5         |

**Not rendered for this spec, deliberately:**

| Object                                                                           | Why not                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PersistentVolumeClaim`                                                          | cal-diy's `web` component declares no `volumes` (works.yml:73-89). Volumes are the app-fixture-hello case.                                                   |
| `HorizontalPodAutoscaler`, `PodDisruptionBudget`, `StatefulSet`, `Job` for smoke | no App spec field exists for any of them (see `../../contradictions.md` §"No spec field behind it")                                                          |
| `EVER_WORKS_SOURCE_URL` in the platform ConfigMap                                | FR-44 applies only when the license requires offering source **and** the data repository is a link or is ahead of upstream; cal-diy is MIT (works.yml:33-37) |
| the hairpin / smoke / isolation-probe runner Jobs                                | rendered by `app-deployer` at deploy time, not in the desired-state set (plan §4.11, §4.12)                                                                  |

---

## 3. Component-by-component mapping (`spec.components[0]` → `Deployment web`)

| App spec field           | Value (works.yml)                                                 | Rendered                                                                                                                                                                         | Rule                                                                                       |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                   | `web`                                                             | `metadata.name`, container name, Service name, Ingress name, selector `ever-works.io/component: web`                                                                             | plan §4.1, §4.3                                                                            |
| `role`                   | `web`                                                             | Service + Ingress rendered; `ports[0]` rendered                                                                                                                                  | plan §4.3; `APW-03 schema.md:184`                                                          |
| `command`                | `['/calcom/scripts/start.sh']`                                    | `containers[0].command`                                                                                                                                                          | plan §4.3                                                                                  |
| `port`                   | `3000`                                                            | `containers[0].ports[0] = { name: http, containerPort: 3000 }`; Service `targetPort: 3000`                                                                                       | plan §4.3                                                                                  |
| `replicas`               | `1`                                                               | `spec.replicas: 1`                                                                                                                                                               | plan §4.3; spec FR-11 (0–10)                                                               |
| `writableRootFilesystem` | `true`                                                            | `readOnlyRootFilesystem: false`; **no** `/tmp` emptyDir                                                                                                                          | plan §4.4 (`readOnlyRootFilesystem = !writableRootFilesystem`; `/tmp` only when read-only) |
| `probes.startup`         | `{ http: /api/version, periodSeconds: 10, failureThreshold: 60 }` | `startupProbe.httpGet{path,port:http}`, period 10, failureThreshold 60, + schema defaults timeout 5 / delay 0                                                                    | plan §4.5; `APW-03 schema.md:198-201`                                                      |
| `probes.readiness`       | `{ http: /auth/login }`                                           | `readinessProbe.httpGet /auth/login`, period 10, timeout 5, delay 0, failureThreshold 3 (all schema defaults)                                                                    | plan §4.5; `schema.md:198-201`                                                             |
| `probes.liveness`        | `{ http: /api/version, periodSeconds: 30 }`                       | `livenessProbe.httpGet /api/version`, period 30, + schema defaults                                                                                                               | plan §4.5                                                                                  |
| _(none)_                 | —                                                                 | `minReadySeconds: 0` — workers without probes get 30, this one has probes                                                                                                        | plan §4.3                                                                                  |
| `resources.cpu`          | `500m`                                                            | `requests.cpu: 500m`                                                                                                                                                             | plan §4.5                                                                                  |
| `resources.memory`       | `1536Mi`                                                          | `requests.memory: 1536Mi`                                                                                                                                                        | plan §4.5                                                                                  |
| `resources.memoryLimit`  | `3Gi`                                                             | `limits.memory: 3Gi`                                                                                                                                                             | plan §4.5                                                                                  |
| `resources.cpuLimit`     | _(absent)_                                                        | **no** `limits.cpu` on Your cluster; `max(1, 4 × 0.5) = 2` on Ever Works Apps                                                                                                    | plan §4.5                                                                                  |
| `volumes`                | _(absent)_                                                        | no PVC; `strategy: RollingUpdate { maxSurge: 0, maxUnavailable: 1 }` (replicas 1)                                                                                                | plan §4.3, §4.6                                                                            |
| _(derived)_              | —                                                                 | `progressDeadlineSeconds: 750` = `clamp(10×60 + 10×3 + 120, 300, 2400)`                                                                                                          | plan §5.3                                                                                  |
| _(derived)_              | —                                                                 | pod annotations `ever-works.io/env-checksum`, `ever-works.io/build-commit`, `ever-works.io/deployment-id`                                                                        | plan §4.3                                                                                  |
| _(derived)_              | —                                                                 | `serviceAccountName: app`, `automountServiceAccountToken: false`, `enableServiceLinks: false`, soft `topologySpreadConstraints`, `imagePullPolicy: IfNotPresent` (digest-pinned) | plan §4.3                                                                                  |

`spec.domains.primaryComponent: web` is why the Ingress is on `web` and not on a worker;
`spec.domains.publicUrlEnv: [NEXT_PUBLIC_WEBAPP_URL, NEXTAUTH_URL]` is consumed by APW-09/APW-10 to build
`domains.primary.url` — it does not change any rendered object.

---

## 4. Checksums and derived names

**Env checksum.** `hashRuntimeEnv`'s canonical form as APW-06 adopts it (plan §4.7: "`checksum` = first 16 hex
of sha256 over `name=value` lines of both maps sorted by name (the `hashRuntimeEnv` form)"; the existing
implementation is `k8s.plugin.ts:60-69` — keys sorted, `key=value` lines joined with `\n`, **no trailing
newline**, sha256 hex truncated):

```text
APP_BOOTSTRAP_ADMIN_EMAIL=<redacted>
APP_BOOTSTRAP_ADMIN_PASSWORD=<redacted>
APP_WEB_INTERNAL_URL=<redacted>
CALCOM_TELEMETRY_DISABLED=<redacted>
CALENDSO_ENCRYPTION_KEY=<redacted>
CRON_API_KEY=<redacted>
CRON_SECRET=<redacted>
DATABASE_DIRECT_URL=<redacted>
DATABASE_HOST=<redacted>
DATABASE_URL=<redacted>
EMAIL_FROM=<redacted>
EMAIL_FROM_NAME=<redacted>
EMAIL_SERVER_HOST=<redacted>
EMAIL_SERVER_PASSWORD=<redacted>
EMAIL_SERVER_PORT=<redacted>
EMAIL_SERVER_USER=<redacted>
EVER_WORKS_APP_COMMIT=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678
EVER_WORKS_APP_HOST=cal-diy.apps.example.com
EVER_WORKS_APP_URL=https://cal-diy.apps.example.com
EVER_WORKS_DEPLOYMENT_ID=33333333-3333-4333-8333-333333333333
GOOGLE_API_CREDENTIALS=<redacted>
GOOGLE_LOGIN_ENABLED=<redacted>
GOOGLE_WEBHOOK_TOKEN=<redacted>
NEXTAUTH_SECRET=<redacted>
NEXTAUTH_URL=<redacted>
NEXT_PUBLIC_WEBAPP_URL=<redacted>
TZ=<redacted>
```

`sha256` = `3b2eee9155911d5d82a79d55b534ba6826c3e658e982f33b611fb9bd19fa9b80`
→ `checksum16 = 3b2eee9155911d5d` (pod annotation), `checksum10 = 3b2eee9155` (Secret and ConfigMap names).

Because the input text is a fixture of placeholders, the checksum is a fixture too: it pins the **name set**
and the two maps' composition, not any real value. With real values the name changes — which is the point
(APW-06 spec FR-17: "a changed value always restarts pods … an unchanged value never does").

**Runner ConfigMap name.** `ew-runner-<hash10>` (plan §4.1). The epic does not say what is hashed; this
golden set defines `hash10 = first 10 hex of sha256("<workId>|ever-works-runner|v1")` =
`sha256('11111111-1111-4111-8111-111111111111|ever-works-runner|v1')` → `1bd8272a143518c8…` →
`ew-runner-1bd8272a14` (open question Q-4).

**TLS secret name.** From the nginx strategy's `tlsSecretName(hosts)` (`ingress/nginx.strategy.ts:30-33`):
`cal-diy.apps.example.com` → `cal-diy-apps-example-com-tls`.

**Other derived names.** Job `job-<name>-<deploymentShort>` (`job-migrate-33333333`,
`job-bootstrap-admin-33333333`); CronJob `cron-<name>`.

---

## 5. Env name → source (names only, never values)

Every name below is a key of `Secret app-env-3b2eee9155`. `EVER_WORKS_APP_COMMIT`, `EVER_WORKS_APP_HOST`,
`EVER_WORKS_APP_URL` and `EVER_WORKS_DEPLOYMENT_ID` are keys of `ConfigMap app-platform-3b2eee9155` instead.

| Env name                       | `spec.env[]` entry (works.yml line) | Source kind                                                                               |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `NEXTAUTH_SECRET`              | :97-99                              | generated (`base64`, 32 bytes), `rotate: never`                                           |
| `CALENDSO_ENCRYPTION_KEY`      | :100-103                            | generated (`chars`, 32), validated 32 chars                                               |
| `CRON_API_KEY`                 | :104-106                            | generated (`hex`, 32 bytes)                                                               |
| `CRON_SECRET`                  | :107-109                            | generated (`hex`, 32 bytes)                                                               |
| `DATABASE_URL`                 | :112                                | derived `deps.postgres.url`                                                               |
| `DATABASE_DIRECT_URL`          | :113                                | derived `deps.postgres.directUrl` (requires `postgres.directUrl: true`, :92)              |
| `DATABASE_HOST`                | :116                                | template `{{deps.postgres.host}}:{{deps.postgres.port}}`                                  |
| `NEXT_PUBLIC_WEBAPP_URL`       | :117                                | derived `domains.primary.url`                                                             |
| `NEXTAUTH_URL`                 | :118                                | template `{{domains.primary.url}}/api/auth`                                               |
| `APP_WEB_INTERNAL_URL`         | :122                                | derived `components.web.internalUrl` → `http://web.ew-cal-diy-11111111.svc.cluster.local` |
| `EMAIL_SERVER_HOST`            | :121                                | derived `deps.smtp.host`                                                                  |
| `EMAIL_SERVER_PORT`            | :122                                | derived `deps.smtp.port`                                                                  |
| `EMAIL_SERVER_USER`            | :123                                | derived `deps.smtp.user`                                                                  |
| `EMAIL_SERVER_PASSWORD`        | :124                                | derived `deps.smtp.password`                                                              |
| `EMAIL_FROM`                   | :125                                | derived `deps.smtp.from`                                                                  |
| `EMAIL_FROM_NAME`              | :126                                | literal value `Cal.diy (community build)`                                                 |
| `CALCOM_TELEMETRY_DISABLED`    | :129                                | literal `1`, `phase: both` (also a build arg)                                             |
| `TZ`                           | :130                                | literal `UTC`                                                                             |
| `GOOGLE_LOGIN_ENABLED`         | :131                                | literal `false`                                                                           |
| `APP_BOOTSTRAP_ADMIN_EMAIL`    | :137-139                            | prompted, required                                                                        |
| `APP_BOOTSTRAP_ADMIN_PASSWORD` | :140-151                            | prompted, required, validated (`minLength: 15`)                                           |
| `GOOGLE_API_CREDENTIALS`       | :147-149                            | prompted, optional                                                                        |
| `GOOGLE_WEBHOOK_TOKEN`         | :150-152                            | generated (`hex`, 32 bytes)                                                               |
| `EVER_WORKS_APP_COMMIT`        | _(platform)_                        | `build.commitSha`                                                                         |
| `EVER_WORKS_APP_HOST`          | _(platform)_                        | `hosts.primary`                                                                           |
| `EVER_WORKS_APP_URL`           | _(platform)_                        | `appUrlScheme('cert-manager', …) + hosts.primary`                                         |
| `EVER_WORKS_DEPLOYMENT_ID`     | _(platform)_                        | `deploymentId`                                                                            |

`MAX_OLD_SPACE_SIZE`, `CALCOM_TELEMETRY_DISABLED` and `DATABASE_URL` appear in `spec.build.args` as **literal
build arguments** (works.yml:58-62). `NEXTAUTH_SECRET` and `CALENDSO_ENCRYPTION_KEY` are deliberately **not**
passed to the build (works.yml:63-65), which is why they are absent from the workflow's `build-args`.

---

## 6. What this golden set proves, and what it does not

**Proves** (acceptance ids in `../../golden-test-plan.md` §4): the security context of every container
(ACC-06-07), the digest-pinned image and the pull-credential wiring (ACC-06-16), `envFrom` with
`optional: false` and an immutable env Secret (ACC-06-15, ACC-06-18), the probe set and the deadline clamp
(ACC-06-06), the five NetworkPolicies and their exact CIDR lists (ACC-06-17), TLS rendering per mode
(ACC-06-29), the pre-deploy and first-deploy Jobs and their order relative to the Ingress (ACC-06-09,
ACC-06-11), and the seven CronJobs with `Forbid` + `successfulJobsHistoryLimit: 1` (ACC-13-10).

**Does not prove** (asserted elsewhere): rollout behaviour and rollback (ACC-06-10, ACC-06-12, ACC-06-22 —
`app-deployer.spec.ts` + the kind lane), smoke execution (ACC-06-12 — `app-runner.script.spec.ts`), pause and
removal (ACC-06-35, ACC-06-36 — `app-lifecycle.spec.ts`), and the verification variant (ACC-06-48).

**Deliberately absent:** any real secret value, any real hostname, any cluster address, and the
`ever-works.io/managed` / `app.kubernetes.io/name` labels (reusing them would leak App components into
`listProjects` / `listManagedDeployments` — APW-06 plan §1.2 #6).
