# App Works — golden output artifacts

The **validated build artifact** for the App Works programme: for each of the three App Blueprints,
the exact files the platform is specified to generate, plus a zero-dependency check that proves they
still follow from the Blueprint and can be shown to fail.

```text
golden/
├── README.md                          this file
├── check.mjs                          the check (zero dependencies, re-reads each Blueprint at run time)
├── __negative-control__/              THREE deliberately broken copies + their README — never "fix" them
│   ├── README.md
│   ├── .variants.json                           the three corruptions, as data
│   ├── nc-01-port/app-fixture-hello/…           one port changed (8080 → 8081)
│   ├── nc-02-latest-tag/app-fixture-hello/…     one image tag changed (digest → :latest)
│   └── nc-03-literal-secret/app-fixture-hello/… one literal injected into the env Secret
├── .generated-files.json              the generator's own file list (machine-readable provenance)
├── app-fixture-hello/
│   ├── ever-works-build.yml           the workflow APW-05 writes into the Work Repository
│   ├── your-cluster/                  20 objects — one file per object — for the `your-cluster` target
│   └── ever-works-apps/work.yaml      the `Work` resource the APW-10 tier consumes
├── cal-diy/…                          25 objects
└── umami/…                            16 objects; `ever-works-build.yml` is an explicit ABSENT marker
```

The two dotfiles are inert metadata — `check.mjs` reads only `golden/<blueprint>/`, so neither can
influence a verdict.

One file per object, so a lane can diff, de-duplicate or point at a single object without parsing a
multi-document YAML stream. The numeric prefixes are the renderer's apply order (APW-06 plan
§4.2: Namespace → ServiceAccount → LimitRange → NetworkPolicies → pull Secret → env Secret → PVCs →
Services → workloads → runner ConfigMap → Jobs → CronJobs).

---

## 1. How to run the check

```bash
cd docs/specs/features/app-works/_build-artifacts/expected-outputs/golden
node check.mjs                                     # all three Blueprints; exit 0 when clean
node check.mjs --blueprint cal-diy                 # one Blueprint
node check.mjs --root __negative-control__/nc-01-port --blueprint app-fixture-hello
node --check check.mjs                             # syntax only
```

It is a **zero-dependency** Node script: it reads `.works/works.yml` with its own small YAML reader
(block maps/sequences, flow collections, quoted scalars, `|` block scalars, comments) — no `yaml`, no
`ajv`, nothing to install. `--root` exists so the negative control can be pointed at.

What it asserts, per Blueprint (2064 assertions in total on the clean tree):

| #   | Suite                       | What it proves                                                                                                                                                                |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the file set                | every object the App spec implies exists, and nothing extra is rendered                                                                                                       |
| 2   | components and ports        | each `spec.components[]` is one Deployment, `containerPort` = `port`, web ⇒ Service `80 → <port>`, worker ⇒ no Service/Ingress/ports, Ingress only on `primaryComponent`      |
| 3   | probes                      | every probe path is declared in the App spec, with the spec's `periodSeconds`/`failureThreshold`/`timeoutSeconds`/`initialDelaySeconds`, and no probe the spec never declared |
| 4   | jobs                        | one Job per `spec.jobs[]` **in declared order**, phase order pre-deploy → first-deploy, command verbatim, `activeDeadlineSeconds` = `timeoutSeconds`                          |
| 5   | cron                        | one CronJob per `spec.cron[]` in order, `schedule` verbatim, `Etc/UTC`, history limits, and the auth scheme the request list uses                                             |
| 6   | env split                   | Secret keys = the `runtime`/`both`-phase names exactly; no build-only name; build args never name a runtime-only entry; `envFrom` is `optional: false`; checksum recomputed   |
| 7   | labels                      | `managed-by`/`part-of`/`work-id`/`kind` on every object, `ever-works.io/component` values are real components, and neither forbidden label appears                            |
| 8   | network policies            | `ew-default-deny` with no rules, the other four by name, the ingress port, the IPv4+IPv6 except lists, hairpin iff `needsHairpin`                                             |
| 9   | images                      | nothing is `:latest`; every Deployment is `@sha256:`-pinned with the App-Work-scoped pull credential                                                                          |
| 10  | secrets                     | the env Secret holds only non-secret literals the Blueprint states and `<…>` placeholders elsewhere; no known secret shape anywhere                                           |
| 11  | the managed Work            | the tier receives desired state, not objects; components/jobs/cron/smoke/env names/hosts/dependencies mirror the App spec                                                     |
| 12  | the build workflow          | header line, pins as 40-hex, triggers, the `verify` job, the checks matrix (name, order, `ceil(seconds/60)`, base64 command), and the absent-file case                        |
| 13  | App spec schema cross-check | MemQuantity range, R18 (volumes ⇒ 1 replica), R23 (no `EVER_WORKS_` env name), five-field cron, PVC size = declared volume size                                               |

### Captured output — the clean tree

```console
$ node check.mjs
================================================================================================
Ever Works App Works — GOLDEN ARTIFACT CHECKS
================================================================================================
run at        : 2026-09-17T21:41:06.874Z
node          : v24.14.0
repo root     : E:\Coding\Worktrees\ever-works-platform-any-repo-works
golden root   : docs/specs/features/app-works/_build-artifacts/expected-outputs/golden
blueprints    : app-fixture-hello, cal-diy, umami
                app-fixture-hello    works.yml sha256 afd38c6e24f3f8e49894845107a49b36b054d9546bf83795e0f339140a67cdf4
                cal-diy              works.yml sha256 538a1389bc4dfc0f8fab31821d6e78aca2a0622d1f0e55fec1794433b646c16a
                umami                works.yml sha256 a2a7ba30b69e6fe55deebdbbddfd794623afcb59f23d57ff9bc89d39ed66f104
…
PASS  app-fixture-hello · 1 · the file set             66 / 66   assertions
PASS  cal-diy · 5 · cron                              113 / 113  assertions
…
assertions    : 2064
failures      : 0
verdict       : every golden file matches its App Blueprint

All 2064 golden assertions passed.                                   (stderr; exit code 0)
```

---

## 2. The negative control — proof the check can fail

Three copies of `app-fixture-hello/`, each differing from the golden tree in **exactly one field of one
file** (verified mechanically: 1 of 22 files differs, and the check reports which). See
[`__negative-control__/README.md`](__negative-control__/README.md) — **those files are broken on
purpose and must never be "fixed".**

```console
$ node check.mjs --root __negative-control__/nc-01-port --blueprint app-fixture-hello
  FAIL  2.5     1 of 1
        app-fixture-hello/your-cluster/10-deployment-web.yaml containerPort is 8081, expected 8080
assertions    : 677
failures      : 1
verdict       : 1 assertion(s) failed — the golden set and the App Blueprint disagree

1 golden assertion(s) FAILED.                                        (stderr; exit code 1)

$ node check.mjs --root __negative-control__/nc-02-latest-tag --blueprint app-fixture-hello
  FAIL  9.1     1 of 5
        app-fixture-hello/your-cluster/10-deployment-web.yaml/spec/template/spec/containers/0/image is not `:latest`
  FAIL  9.2     1 of 2
        app-fixture-hello/your-cluster/10-deployment-web.yaml container image is digest-pinned
        (ghcr.io/example-owner/app-fixture-hello/ever-works-app:latest)
assertions    : 677
failures      : 2                                                    (exit code 1)

$ node check.mjs --root __negative-control__/nc-03-literal-secret --blueprint app-fixture-hello
  FAIL  10.2    1 of 3
        app-fixture-hello/your-cluster/04-secret-env.yaml:39 `FIXTURE_SESSION_SECRET` holds a literal value
        "hunter2-not-a-placeholder" — every secret must be a reference or a placeholder
  FAIL  10.4    1 of 13
        app-fixture-hello/your-cluster/04-secret-env.yaml FIXTURE_SESSION_SECRET is a placeholder or the
        documented derived value — got "hunter2-not-a-placeholder" (its env entry is secret, generated,
        prompted or derived)
assertions    : 677
failures      : 2                                                    (exit code 1)
```

Every failure names the golden **file** and the **field**. The clean tree passes and the corrupted
trees fail, from the same script, in the same run shape.

---

## 3. What each golden file is derived from

Line numbers are those of the revision recorded in §8. `works.yml:NN` always means the Blueprint's
`.works/works.yml`.

### 3.1 `ever-works-build.yml`

| Rendered                                                                | Rule                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the whole file                                                          | APW-05 `plan.md:151-308` (the normative generator sketch, §2.4); spec `FR-5…FR-30`, `FR-65…FR-72`                                                                                                   |
| header `# ever-works-build generator=1 inputs=sha256:…`                 | CONTRACTS `§9` (`CONTRACTS.md:538`); APW-05 `plan.md:159`                                                                                                                                           |
| `EW_IMAGE: ghcr.io/<owner>/<repo>/ever-works-app` (lower-cased)         | APW-05 `plan.md:186`; `spec.md:289` (FR-27); CONTRACTS `CONTRACTS.md:541`                                                                                                                           |
| `on.push` / `on.pull_request` branch `main`/`master`                    | `works.yml` `spec.source.branch` (fixture:19, cal-diy:25, umami:22)                                                                                                                                 |
| `runs-on: ubuntu-latest`                                                | `APP_BUILD_RUNNERS.githubPublic` (APW-05 `plan.md:523-526` — a _public_ repository; `spec.md:274` FR-22), cal-diy `plan.md:186`                                                                     |
| `timeout-minutes` = `build.resources.timeoutMinutes`                    | APW-05 `plan.md:181`, `spec.md:281` (FR-24 — exact); the verify job adds 30 (`plan.md:246`, `spec.md:358` FR-53)                                                                                    |
| `services.postgres`                                                     | `BUILD_SERVICE_DEFAULTS` (APW-05 `plan.md:810-829`: `POSTGRES_USER/PASSWORD=ever-works-build`, `POSTGRES_DB=app`, port 5432, `pg_isready -U <user> -d <db>`), cal-diy:69-77                         |
| `build-args` literal lines                                              | `works.yml` `spec.build.args[].value` (cal-diy:58-59)                                                                                                                                               |
| `build-args` `fromEnv` lines                                            | APW-05 `plan.md:215` and `§4.7b` (`plan.md:910-941`, `spec.md:412` FR-71) — `<NAME>=${{ github.event_name == 'pull_request' && 'ew-restricted' \|\| secrets.EW_<NAME> }}`                           |
| "Check build values" step (guard `github.event_name != 'pull_request'`) | APW-05 `plan.md:190-192`, `plan.md:939`                                                                                                                                                             |
| `checks` job (`name: Ever Works check: …`, matrix, base64 command)      | APW-05 `plan.md:276-294` (§2.4) and `plan.md:1142-1156` (§4.14); `APP_BUILD_CHECK_NAME_PREFIX`/`APP_BUILD_CHECKS_MAX_PARALLEL` (`plan.md:538-539`); resolution R-9; `spec.md:394-410` (FR-65…FR-70) |
| `verify` job                                                            | APW-05 `plan.md:243-274`; `plan.md:304-308`; `spec.md:358` (FR-53), `spec.md:362` (FR-54)                                                                                                           |
| umami: **no file**                                                      | APW-05 `plan.md:883-885` (§4.6 step 8) — strategy `image` + no checks ⇒ nothing is written; `spec.md:407` (FR-70)                                                                                   |

Two `run:` bodies are **placeholders**, because the specs describe their contract and own the text in
a source file: `verify-runner.sh.ts` (APW-05 `plan.md:1004-1066`, §4.10) and `result-artifact.ts`
(`plan.md:236-238`). One further placeholder is the sketch's own: `EW_VERIFY_BUILD`
(`plan.md:252`). Everything else is emitted as the sketch spells it.

### 3.2 `your-cluster/*.yaml`

| Object                            | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-namespace.yaml`               | APW-06 `plan.md:383-400` §4.1 (name `ew-<slug≤30>-<first 8 hex of workId>`) and `§4.4` (`plan.md:472-491`: enforce `baseline`, warn+audit `restricted`); spec `FR-10` (`spec.md:303`)                                                                                                                                                                                                                                                       |
| `01-serviceaccount.yaml`          | `plan.md:393` (`app`, `automountServiceAccountToken: false`); spec `FR-12` (`spec.md:312`)                                                                                                                                                                                                                                                                                                                                                  |
| `02-limitrange.yaml`              | `plan.md:408-441` §4.2 (default request 100m/128Mi, default limit 1 CPU/512Mi + 1Gi ephemeral-storage, max 8 CPU/64Gi on `your-cluster`); spec `FR-15` (`spec.md:322`)                                                                                                                                                                                                                                                                      |
| `03-configmap-platform.yaml`      | `plan.md:513-521` §4.7 (`EVER_WORKS_APP_URL/HOST/COMMIT/DEPLOYMENT_ID`, `EVER_WORKS_SOURCE_URL` only under FR-44); spec `FR-18` (`spec.md:334`), `FR-44` (`spec.md:455`)                                                                                                                                                                                                                                                                    |
| `04-secret-env.yaml`              | `plan.md:390-393` §4.1 (`app-env-<checksum first 10 hex>`, `immutable: true`), `plan.md:513-521` §4.7, `plan.md:520` (checksum over both maps); spec `FR-17` (`spec.md:328`)                                                                                                                                                                                                                                                                |
| `05-secret-pull.yaml`             | `plan.md:394` (`app-pull`, mutable), `plan.md:463` (`imagePullSecrets` when `image.pull` is set); spec `FR-19` (`spec.md:338`)                                                                                                                                                                                                                                                                                                              |
| `06-persistentvolumeclaim-*.yaml` | `plan.md:395` (`<component>-<volume>`, label `ever-works.io/retain: "true"`), `plan.md:506-512` §4.6 (`ReadWriteOnce`, `requests.storage`, `ever-works.io/backup`); spec `FR-16` (`spec.md:325`)                                                                                                                                                                                                                                            |
| `1x-deployment-*.yaml`            | `plan.md:442-472` §4.3 (replicas, `revisionHistoryLimit: 5`, `progressDeadlineSeconds`, Recreate/RollingUpdate, `minReadySeconds`, pod annotations, `envFrom` **not** optional, `enableServiceLinks: false`, topology spread, `imagePullPolicy: IfNotPresent`), `plan.md:473-496` §4.4, `plan.md:497-505` §4.5, `plan.md:754-757` (deadline clamp); spec `FR-11` (`spec.md:310`), `FR-14` (`spec.md:319`), `FR-15`, `FR-28` (`spec.md:386`) |
| `20-service-*.yaml`               | `plan.md:456-459` §4.3 (ClusterIP, `port 80 → targetPort <spec port>`; workers get none); spec `FR-11`                                                                                                                                                                                                                                                                                                                                      |
| `21-ingress-*.yaml`               | `plan.md:597-618` §4.11 (only `domains.primaryComponent`; rules for primary ∪ extra ∪ previous; TLS block + issuer annotation only for `cert-manager`); spec `FR-38…FR-42` (`spec.md:426-452`)                                                                                                                                                                                                                                              |
| `3x-networkpolicy-*.yaml`         | `plan.md:554-595` §4.10 and `plan.md:381-398` §4.1 for the five names; spec `FR-20` (`spec.md:340`), `FR-21` (`spec.md:346`)                                                                                                                                                                                                                                                                                                                |
| `40-configmap-runner.yaml`        | `plan.md:396` (`ew-runner-<hash10>`: script + check list), `plan.md:527-544` §4.8 (the runner; paths/bodies are **data**, never interpolated), `plan.md:545-553` §4.9                                                                                                                                                                                                                                                                       |
| `5x-job-*.yaml`                   | `plan.md:527-544` §4.8 (`backoffLimit: retries`, `activeDeadlineSeconds: timeoutSeconds`, `ttlSecondsAfterFinished: 86400`, `restartPolicy: Never`); spec `FR-26` rows 2 and 4 (`spec.md:370-384`), `FR-51`                                                                                                                                                                                                                                 |
| `6x-cronjob-*.yaml`               | `plan.md:545-553` §4.9 (`timeZone: Etc/UTC`, `concurrencyPolicy`, `startingDeadlineSeconds: 300`, history limits 1/3, `suspend`) and `plan.md:552` (managed-tier minimum); spec `FR-26` row 9                                                                                                                                                                                                                                               |

### 3.3 `ever-works-apps/work.yaml`

| Rendered                                                                | Rule                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| the whole object, group `hosting.ever.works/v1alpha1`, kind `Work`      | APW-10 `plan.md:223-270` §3.1; actor `plan.md:616` (`desired-state.mapper.ts`), `plan.md:122`                     |
| `metadata.name` / `namespace` / labels                                  | `plan.md:228-229` (`w-<workId>`, `ever-works-apps-control`, owner + canary labels)                                |
| `workId`, `ownerUserId`, `organizationId`, `generation`, `quotaProfile` | `plan.md:231-235` (`starter` is the seeded profile — `plan.md:522`, `tasks.md:408`)                               |
| `desiredState: running`, `pausedReplicas: null`, `dataDeletion: null`   | `plan.md:236-238`                                                                                                 |
| `images[].source` (digest-pinned) + `pullCredential.sealed`             | `plan.md:241-244`; refusals `IMAGE_NOT_DIGEST_PINNED` (`plan.md:274`), `SEALED_PAYLOAD_INVALID` (`plan.md:275`)   |
| `components[]`                                                          | `plan.md:245-247`                                                                                                 |
| `jobs[]`                                                                | `plan.md:248`                                                                                                     |
| `cron[].http.authScheme`                                                | `plan.md:249` (per CONTRACTS C2)                                                                                  |
| `smoke[]`                                                               | `plan.md:250` — the App spec's `expect` minus `maxLatencyMs`, lifted to `latencyMs` (`app-spec.schema.json:1875`) |
| `hosts[]`, `env.sealed` + `env.names`                                   | `plan.md:251-252`; the sealed payload is hybrid RSA-OAEP-256 + AES-256-GCM (`plan.md:101` D-D, `plan.md:615`)     |
| `dependencies[]`                                                        | `plan.md:253` (`postgres \| redis \| objectStorage \| smtp`)                                                      |
| **not** a Deployment / Service / Ingress / Secret / Namespace           | Resolution R-5, APW-06 `spec.md:268-272` (FR-7) and APW-10 `plan.md:107` (D-J), `plan.md:160`                     |

---

## 4. Pinned inputs and the placeholder convention

`AppRenderInput` — and the `Work` the tier consumes — are not functions of the App spec alone: the
Work's identity, its namespace, its hosts and the target's cluster settings are platform state. These
values are **pinned** so the golden output is a function of nothing else. Every one is a documented
placeholder; **no real host, cluster address or secret appears in any file here.**

| Pin                                                | fixture                                       | cal-diy                             | umami                                     | Why the spec does not state it                                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------- | ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workId` → namespace, `part-of`, `w-<workId>`      | `22222222-…`, `ew-app-fixture-hello-22222222` | `11111111-…`, `ew-cal-diy-11111111` | `33333333-…`, `ew-umami-33333333`         | the Work's uuid is runtime identity                                                                                                                                                                          |
| `ownerUserId` (Work label)                         | `44444444-…`                                  | `55555555-…`                        | `66666666-…`                              | who created the App Work                                                                                                                                                                                     |
| `deploymentId` → job name suffix                   | `77777777-…`                                  | `88888888-…`                        | `99999999-…`                              | one WorkDeployment row per deploy (APW-06 `plan.md:399` `job-<name>-<deploymentShort>`)                                                                                                                      |
| `build.commitSha` → `FIXTURE_GIT_SHA`, annotations | `b1c2d3e4…`                                   | `a1b2c3d4…`                         | `c3d4e5f6…`                               | the deployed commit (spec FR-25)                                                                                                                                                                             |
| image `@sha256:` digest                            | placeholder                                   | placeholder                         | **the Blueprint's own digest** (umami:43) | the registry digest of a Build is not known before the Build runs                                                                                                                                            |
| repository owner `example-owner`                   | all                                           | all                                 | _(upstream `umami-software`)_             | the fork owner is the user's account                                                                                                                                                                         |
| host                                               | `app-fixture-hello.ever.works`                | `cal-diy.ever.works`                | `umami.ever.works`                        | **spec-stated**: `<slug>.<apps-domain>`, `EVER_WORKS_APPS_DOMAIN` defaults to the installation's platform domain, "so the ordinary managed address is `<slug>.ever.works`" (APW-06 `spec.md:434-438`, FR-40) |
| `ingress.className` / `controllerNamespace`        | `nginx` / `ingress-nginx`                     | same                                | same                                      | the connection check's detection (APW-06 `spec.md:264-267`, FR-6)                                                                                                                                            |
| `ingress.tls` / issuer                             | `cert-manager` / `letsencrypt`                | same                                | same                                      | the owner's TLS choice (APW-06 `spec.md:448-452`, FR-42)                                                                                                                                                     |
| `image.pull` set ⇒ `05-secret-pull.yaml`           | set                                           | set                                 | set                                       | see below                                                                                                                                                                                                    |
| `network.extraEgress` (RFC 5737 `198.51.100.0/24`) | 1 rule                                        | 1 rule                              | 1 rule                                    | dependency endpoints are "resolved by the platform at render time" (APW-06 `plan.md:593`)                                                                                                                    |
| hairpin ingress address (`203.0.113.0/24`, 80/443) | n/a (`needsHairpin: false`)                   | 1 rule                              | n/a                                       | the cluster's ingress address is operator state; the **ports** are spec-stated (`plan.md:593`)                                                                                                               |
| TLS secret name `<host with dashes>-tls`           | all                                           | all                                 | all                                       | APW-06 `plan.md:597-618` says the renderer reuses the existing ingress strategy's naming; the specs do not spell it out                                                                                      |
| runner image `<APP_RUNNER_IMAGE …>`                | all (CronJobs)                                | all                                 | n/a (no cron)                             | APW-06 `plan.md:527-529`: a constant, "reviewed on bump" — its value is not in the specs                                                                                                                     |
| runner mount path `/ew`, `defaultMode: 292` (0444) | all                                           | all                                 | n/a                                       | §4.8 specifies the behaviour, not the mount path                                                                                                                                                             |
| `retries` absent ⇒ `backoffLimit: 0`               | all                                           | all                                 | all                                       | `job.retries` is optional with **no default** in the schema (`app-spec.schema.json:1624-1628`)                                                                                                               |
| `quotaProfile: starter`                            | all (Work)                                    | all                                 | all                                       | `starter`/`standard` are the seeded profiles (APW-10 `plan.md:522`)                                                                                                                                          |
| `generation: 1`                                    | all (Work)                                    | all                                 | all                                       | the first Deployment's generation                                                                                                                                                                            |

**Placeholder convention** (one rule, applied everywhere): a value the platform computes and the
Blueprint does not state is written as a `<…>` token that says where it comes from.

| Token shape                                                           | Meaning                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `<generated:chars:32>`, `<generated:hex:32>`, `<generated:base64:32>` | an env value produced by `spec.env[].generate`           |
| `<prompted:APP_BOOTSTRAP_ADMIN_PASSWORD>`                             | an env value the owner types at creation                 |
| `<deps.postgres.url>`, `<deps.smtp.host>`                             | the resolved output of an App dependency                 |
| `<template:{{deps.postgres.host}}:{{deps.postgres.port}}>`            | a `template:` entry resolved at render time              |
| `<apw-07 dependency ref for postgres>`                                | the dependency row's ref in the Work                     |
| `<sealed env payload — …>`                                            | the Work's sealed payload (never plaintext, ≤ 256 KiB)   |
| `<APP_RUNNER_IMAGE …>`, `<APP_RUNNER_SCRIPT …>`                       | a constant or a script body the specs own in source code |
| `<verify-runner.sh.ts — the APW-05 plan.md §4.10 body …>`             | a `run:` body that is source code, not prose             |

Everything else is **literal and derived**: the two derivable env values
(`domains.primary.url` → `https://<host>`, `components.<name>.internalUrl` →
`http://<name>.<ns>.svc.cluster.local`, APW-06 `plan.md:456-459`) and `build.commitSha` are written out;
every non-secret `value:` entry the Blueprint states (e.g. `TZ: UTC`, `DISABLE_TELEMETRY: '1'`,
`EMAIL_FROM_NAME`) is written out; and `BUILD_SERVICE_DEFAULTS`
(`POSTGRES_USER/PASSWORD=ever-works-build`, `POSTGRES_DB=app`) are written out because APW-05
`plan.md:828-829` states them as non-secret by construction.

---

## 5. Where the Blueprint and the specs disagree

Reported, not fixed: the Blueprints and the schema/specs belong to other agents.

1. **A managed `Work` may not carry the cron schedule of two of the three Blueprints.**
   APW-10 `plan.md:249` caps a `Work` cron entry at `schedule (≥ 5 min)` and `plan.md:276` lists
   `CRON_TOO_FREQUENT` as a refusal; APW-06 `plan.md:552` refuses "schedules that can fire more often
   than every 5 minutes". The fixture's only schedule is `*/2 * * * *`
   (`app-fixture-hello/.works/works.yml:114`) and Cal.diy's `tasker` and `webhook-triggers` are
   `* * * * *` (`cal-diy/.works/works.yml:265`, `:295`). Both Blueprints acknowledge it in their own
   comments (`app-fixture-hello:107-110`, `cal-diy:258-261`) and say the managed variant needs a
   ≥ 5-minute profile or a tier exception. `golden/<bp>/ever-works-apps/work.yaml` renders the
   declared schedule — the tier would answer `Refused { code: CRON_TOO_FREQUENT }` for the fixture and
   for Cal.diy, while `your-cluster` runs both exactly as written. **The golden records the refusal
   rather than hiding it.**
2. **A Verification Build of the fixture and of Cal.diy is refused before dispatch.**
   APW-05 `plan.md:1054-1056`: "`smtp` is **not** started in the runner … a plan that needs one to run
   a job or a smoke test is refused before dispatch with
   `blocked { reason: 'verificationDependencyUnsupported', detail: { kind: 'smtp' } }`". Both Blueprints
   declare `dependencies.smtp` (`app-fixture-hello:68`, `cal-diy:102`) and the fixture's smoke/jobs are
   not smtp-free (`:128` posts to `/mail/test`'s sibling route; `:74-78` read smtp outputs). Only
   Umami (no `smtp`) is verifiable in the runner as written.
3. **An App spec that validates can still be un-representable on the managed tier.**
   `app-spec.schema.json:268` allows **10** components and `:295` allows **20** cron entries;
   APW-10 `plan.md:245` allows **8** components and `:249` allows **10** cron entries, and
   `plan.md:247` allows **4** volumes per component against the schema's **5** (`:914`). Nothing in the
   three Blueprints exceeds either cap (max 2 components, 7 cron, 1 volume) — but the caps disagree, so
   `SPEC_LIMIT_EXCEEDED` (`plan.md:273`) can refuse a spec that APW-03 accepted.
4. **Umami's image user cannot be expressed.** The Blueprint records that the published image's user is
   the _name_ `nextjs`, that kubelet refuses a non-numeric image user under `runAsNonRoot`, and that
   APW-06 `plan.md:473-479` §4.4 renders `runAsNonRoot: true` with no `runAsUser`
   (`umami/.works/works.yml:51-57`). The schema's `component` definition has no user field
   (`app-spec.schema.json:818-921`), so `golden/umami/your-cluster/10-deployment-web.yaml` renders no
   `runAsUser` — the Deployment as specified would fail the rollout with `image_user_unverifiable`
   (APW-06 `plan.md:490-495`). The Blueprint itself asks for `components[].runAsUser` as a contract
   change.
5. **`EW_VERIFY_BUILD` has no derivable value.** APW-05 `plan.md:252` emits it as
   `"<base64url of the plan's `build` section, when the plan carries one>"` — a placeholder inside the
   normative sketch, because the plan is a dispatch input. The golden carries the placeholder verbatim.

---

## 6. What is NOT in this set

| Not rendered                                                                  | Why                                                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| smoke / hairpin / isolation-probe Jobs                                        | rendered by `app-deployer` at deploy time, not in the desired-state set (APW-06 `plan.md:597-618`, `plan.md:620-646`) |
| `ResourceQuota ew-quota`, `runtimeClassName`, sandbox overlays                | `ever-works-apps` only — and there the _tier_ renders them (APW-06 `plan.md:408-441`, APW-10 `plan.md:397-406`)       |
| `HorizontalPodAutoscaler`, `StatefulSet`, `PodDisruptionBudget`               | no App spec field exists for any of them                                                                              |
| the `build`/`verify` `run:` bodies, `app-runner.script.ts`                    | source code, not spec prose (see §4's convention table)                                                               |
| `EVER_WORKS_SOURCE_URL`                                                       | FR-44 needs a licence class that requires offering source; all three Blueprints are MIT/green                         |
| the checks-only workflow for a `dockerfile` Blueprint that later drops checks | would require an `image`/`none` strategy; Umami's absent-file marker covers the branch (APW-05 `plan.md:883-885`)     |

**Not derivable at all, and therefore absent rather than invented:** the real `inputsHash` (canonical
inputs include `ACTION_PINS` and plugin settings, APW-05 `plan.md:797-806`), the `ACTION_PINS` commit
hashes (`plan.md:834-836` — the golden uses an obviously fake 40-hex placeholder), the runner image
and its mount path, the ingress strategy's annotations, the certificate issuer's real name, and every
dependency endpoint address.

---

## 7. Reproducing and re-deriving

- Every golden file carries its own provenance header: the App spec's path and **sha256**, the renderer
  file(s) that own it, and the spec sections it comes from. A Blueprint edit therefore shows up as a
  header that no longer matches `sha256sum .works/works.yml` — and as a failing assertion in
  `check.mjs`, which recomputes it.
- Formatting: `npx prettier --check` passes on every file here (YAML is printed at `tabWidth: 4` by
  this repository's `.prettierrc`).
- These artifacts were **authored** with a throwaway generator that lived outside the worktree (the
  worktree receives only the artifacts). Re-deriving after a spec change means re-reading the sections
  cited in §3; if the programme wants the generator committed, it should be added deliberately as its
  own reviewed file, not smuggled in beside the goldens.

## 8. Revision provenance — READ THIS BEFORE COMPARING

The App Works specs were being **actively rewritten by other agents while these artifacts were
produced** (every file below changed between 23:17 and 23:36 on the same day this directory was
generated). The golden set is therefore pinned to this revision, recorded so a comparison lane can
tell a real mismatch from spec drift:

| Spec file                                                           | sha256 (first 16)  | Lines |
| ------------------------------------------------------------------- | ------------------ | ----- |
| `_build-artifacts/apw-03-schema/app-spec.schema.json`               | `459fb280214f133a` | 2090  |
| `APW-03-app-spec-and-catalog/schema.md`                             | `3b7f0c5797d59e4a` | 759   |
| `APW-05-builds/spec.md`                                             | `a8138d8a2027a966` | 711   |
| `APW-05-builds/plan.md`                                             | `d806c561c76bd486` | 1763  |
| `APW-06-app-runtime/spec.md`                                        | `6c071d98bd98f1cd` | 817   |
| `APW-06-app-runtime/plan.md`                                        | `a484968c8af3281e` | 1852  |
| `APW-10-apps-hosting-tier/spec.md`                                  | `44729a8b6e613faa` | 724   |
| `APW-10-apps-tier/plan.md` (APW-10 `plan.md`)                       | `20b757512a2647b4` | 1127  |
| `CONTRACTS.md`                                                      | `5141efa2806702ad` | 702   |
| `APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml` | `afd38c6e24f3f8e4` | 144   |
| `APW-13-golden-paths/blueprints/cal-diy/.works/works.yml`           | `538a1389bc4dfc0f` | 359   |
| `APW-13-golden-paths/blueprints/umami/.works/works.yml`             | `a2a7ba30b69e6fe5` | 172   |

Two examples of drift seen during this task, both of which changed a golden file:

- APW-10 `plan.md:249-253` gained `authScheme: bearer|raw` in the `Work` cron shape and `smtp` in
  `dependencies[].kind` (an earlier revision had neither; an earlier draft of this set recorded the
  gap as a finding instead).
- APW-05 `plan.md:159-308` gained the `verify` job, the `ew_reuse_digest` input, the verification
  concurrency group, the `inputs.ew_mode != 'verify'` guard on `build` and the §4.7b `ew-restricted`
  build-argument form (an earlier revision had none of them).

`check.mjs` re-reads the **Blueprints** at run time and prints their sha256, so Blueprint drift is
caught automatically. It does **not** re-read the specs — a lane comparing platform output against
these files must confirm the spec revision first, or re-derive from §3.

### 8.1 Later spec revisions — the golden set was NOT regenerated (added 2026-09-17)

The table in §8 is the revision the artifacts in this directory were produced against, and it stays exactly as it
is: those outputs are still the outputs of that revision. The spec tree has moved since (the programme audit round
added resolutions R-28…R-41, the quota/notification/threat/signal registers, and the acceptance-id reconciliation
in `ACCEPTANCE.md`), so a comparison lane that reads a spec file today will see a newer revision than the pin:

| Spec file                                | sha256 (first 16) — current | Lines | Relationship to the §8 pin                                                                                      |
| ---------------------------------------- | --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `CONTRACTS.md`                           | `8dbae7149b4b7e9f`          | 726   | newer revision; the §8 pin (`5141efa2806702ad`, 702 lines) still names the golden set's revision                |
| `APW-09-upstream-pull-requests/tasks.md` | `2b1bbf4c1e543e75`          | 786   | not in the §8 table (T3 now records that APW-02 T9/T10 landed the interface half first)                         |
| `CONTRACTS.md` (next revision)           | `82209d3a97cde264`          | 729   | newer again — three lines of YAML front matter added 2026-09-18 (see below); §8 and the row above stay readable |

**2026-09-18 — why `CONTRACTS.md` gained a `slug:` and nothing else.** The documentation site could not build at
all, for a reason unrelated to this programme's content: `app-works/CONTRACTS.md` and
`app-works/contracts/README.md` resolve to the **same route**, so Docusaurus tried to write a redirect over an
existing `contracts/index.html` and aborted with `EEXIST` — which is why `pnpm --filter ever-works-docs build`
failed. Neither file is new. The fix is additive: three lines of YAML front matter giving `CONTRACTS.md` its own
slug (`/specs/features/app-works/programme-contracts`), so the `contracts/` directory keeps its landing page and no
file is renamed, moved or shortened. The build then succeeded end to end. The hash moved because the file gained
those three lines; the table's other rows are untouched, per the rule above.

**2026-09-20 — why `CONTRACTS.md` gained one path string.** The APW-10 CRD schemas moved from
`apps/apps-tier-controller/src/crds/` to `packages/apps-tier-crds/src/crds/` (owner ruling: `apps/*` in this
monorepo means a process, and a CRD-only package is a library — see
`apps/apps-tier-controller/README.md` §3). `CONTRACTS.md` row 374, APW-10 `plan.md` §3.8 and `tasks.md` T3 now
name the package path. Nothing was renamed inside the schemas and no golden file changed: `check.mjs` still
passes all 2 064 assertions, and `deploy/crds/*.yaml` were regenerated only because the generated-file header
names its own source path (the drift test compares that header, so the regeneration is the proof, not a risk).

| Spec file      | sha256 (first 16) — current | Lines | Relationship to the §8 pin                                                              |
| -------------- | --------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `CONTRACTS.md` | `c8c4b5cead4f7e8b`          | 817   | newer again — one path string in row 374; the §8 pin (`5141efa2806702ad`, 702) unchanged |

**How to read this:** the §8 hash is provenance — "what the golden outputs were generated from" — and the §8.1
hash is a freshness check for a lane about to compare. A mismatch against §8.1 means the specs moved, **not** that
the golden files are wrong; re-derive from §3 before concluding anything, and never edit a golden file to match a
newer spec. Later revisions append rows to this subsection rather than replacing a hash, so every revision the
golden set has drifted past stays readable.
