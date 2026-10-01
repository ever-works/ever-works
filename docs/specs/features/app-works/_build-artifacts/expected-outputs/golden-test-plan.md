# Golden-test plan — how the acceptance suite asserts these expected outputs

**Scope.** Two generated-output families are asserted here: (A) the build workflow APW-05's build plugin
writes into a tenant repository, and (B) the Kubernetes manifests APW-06's App renderer produces. Both were
specified only in prose, so this directory supplies the bytes.

**Files.**

```
build-workflow/ever-works-build.yml        the generated workflow (reference spec: app-fixture-hello)
build-workflow/README.md                   every interpolation point, and which epic task writes it
manifests/cal-diy/…                        golden rendering, target your-cluster  (+ managed-overlay.yaml)
manifests/app-fixture-hello/…              golden rendering, target your-cluster  (+ managed-overlay.yaml)
manifests/<app>/_index.md                  spec-field → rendered-object mapping, checksums, env name → source
golden-test-plan.md                        this file
contradictions.md                          renderer-contract conflicts with today's code, and with itself
open-questions.md                          genuinely undecidable points, each with a recommended default
```

---

## 1. Where the fixtures live, and where the test code goes

**Inputs (App specs) already exist and are NOT copied here.** The epics pin them:

| Input              | Path                                                                                              | Pinned by              |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------------------- |
| App spec (fixture) | `docs/specs/features/app-works/APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml` | sha256 `d5cff638…0be7` |
| App spec (cal-diy) | `docs/specs/features/app-works/APW-13-golden-paths/blueprints/cal-diy/.works/works.yml`           | sha256 `6977cfdf…ecea` |

**Outputs (golden files) for the build workflow** go where the owning task already says they must:
`packages/plugins/github-actions-build/src/__tests__/golden/` (APW-05 T8, `APW-05-builds/tasks.md:140-142`;
`checks.yml` per T41, `tasks.md:563`). This directory is the **committed expectation** those files are
diffed against and, until T8 lands, the only definition of their bytes.

**Outputs for the manifests** go where APW-06 T6 says: golden JSON fixtures in
`packages/plugins/k8s/src/app/__tests__/fixtures/` (`APW-06-app-runtime/tasks.md:115-116`). The task's own
framing is "golden JSON fixtures … built from APW-03 `schema.md` §24 examples" — note that §24 has three
samples but **no `## 10.` heading** and no "fixture" designation (`schema.md:179-201` holds `components[]`;
§24 is `schema.md:507-718`), and that the two _real_ App specs are the APW-13 Blueprints, which are what this
directory renders. See `contradictions.md` **X-12**.

**Recommended layout at implementation time**

```
packages/plugins/k8s/src/app/__tests__/fixtures/
  cal-diy/            ← byte-for-byte copies of manifests/cal-diy/*.yaml (comments included)
  app-fixture-hello/  ← byte-for-byte copies of manifests/app-fixture-hello/*.yaml
packages/plugins/github-actions-build/src/__tests__/golden/
  ever-works-build.app-fixture-hello.yml   ← build-workflow/ever-works-build.yml
  ever-works-build.cal-diy.yml             ← the cal-diy instance (§3 below)
  checks.yml                               ← the checks job alone (T41)
```

The copies are mechanical: this directory is the source of truth, and a small script (or a test that reads
across package boundaries) must keep them identical. Prefer **copying** over cross-referencing, because the
plugin packages must not depend on `docs/` at build time.

---

## 2. The snapshot approach

### 2.1 What "golden" means for each family

The two families need different comparison rules, because only one of them is byte-stable by contract.

| Family               | Contract                                                                                                                                                                                                                                                                                             | Comparison                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build workflow       | **Byte-stable.** "Generation is deterministic: the same `build` block and provider settings produce a byte-identical file" (`APW-05-builds/spec.md:218`); "the same inputs yield identical bytes on every platform (LF line endings, trailing newline)" (`APW-05-builds/plan.md:664-667`); ACC-05-03 | **Exact bytes**, LF-normalised, including comments and the header line                                                                                                 |
| Kubernetes manifests | Object-stable. No epic states byte-stability for manifests — APW-13's documents contain **no** statement about snapshots, golden files or byte-stability at all (the only near-hit, `APW-13-golden-paths/spec.md:36`, means "a deterministic lane", not a byte comparison)                           | **Canonical JSON equality** after YAML parsing; order-insensitive for map keys, order-**sensitive** for lists (hosts, egress rules, matrix rows, `rules[].http.paths`) |

So: a byte diff for the workflow, a structural diff for the manifests. This matters — the manifest files in
this directory carry long explanatory comment banners, and a byte comparison would make every comment edit a
test failure.

### 2.2 Recommended primitives

- **Workflow.** `expect(generated).toBe(readFixture('ever-works-build.app-fixture-hello.yml'))` — one exact
  string compare, plus a second run compared to the first (`expect(second).toBe(first)`) for ACC-05-03.
  Normalise CRLF → LF before comparing on Windows developer machines, and assert the file **ends with a
  single `\n`**.
- **Manifests.** A multi-document read (`js-yaml`'s `loadAll`, already a dependency of the package —
  `packages/plugins/k8s/package.json:36`) into `Map<'<kind>/<name>', object>`, then
  `expect(canonicalise(rendered)).toEqual(canonicalise(golden))` where `canonicalise` sorts object keys
  recursively and leaves arrays alone. Fail with a **per-object** diff (`expect(rendered[name]).toEqual(golden[name])`
  inside a loop over the golden key set plus a check for extra keys) so a failure names the object, not the file.
- **No `toMatchSnapshot`.** The package has **no** snapshot infrastructure: no `__snapshots__` directory, no
  `toMatchSnapshot` call anywhere under `packages/plugins/k8s/src/__tests__/`, and the existing renderer tests
  assert hand-written structural expectations against the returned plain objects
  (`manifest.renderer.spec.ts:29-34`; `server-side-deploy.spec.ts:80-81`). Introducing Vitest snapshots would
  put the expectation in a machine-written file that a careless `-u` silently rewrites — the opposite of a
  golden file. Keep the committed fixtures authoritative.

### 2.3 The golden files must pin their inputs, or they assert nothing

Every manifest is a function of `AppRenderInput` (CONTRACTS §3) — which is **not** derivable from the App
spec alone. Each `_index.md` records the full pinned input set (§1 in both). The test must construct that
input explicitly and assert it round-trips; a renderer test that builds its own input differently would
produce a different namespace, checksum and host and fail for the wrong reason.

Three derivations are worth their own unit assertions, because they are where a silent drift is likeliest:

1. **Env checksum.** `hashRuntimeEnv`'s canonical form (keys sorted, `key=value` joined with `\n`, **no
   trailing newline**, sha256 → first 16 hex). The existing implementation is `k8s.plugin.ts:60-69`; APW-06
   plan §4.7 adopts it by name. A regression test should recompute `3b2eee9155911d5d` /
   `fa90df132e185345` from the documented fixture text in each `_index.md` §4. **Do not** hash the real
   Secret values — the fixture text is placeholders by construction, and that is the point.
2. **Namespace name.** `ew-<slug ≤ 30>-<first 8 hex of workId>` (APW-06 plan §4.1) with a 63-character cap.
   `app-fixture-hello` is 17 characters, so the fixture namespace is `ew-app-fixture-hello-22222222` (29 chars).
3. **Component deadline.** `clamp(startup.period × startup.failureThreshold + readiness.period ×
readiness.failureThreshold + 120, 300, 2400)` (APW-06 plan §5.3) with the schema's probe defaults filled
   in where the spec is silent (`periodSeconds` 10, `failureThreshold` 3; `APW-03 schema.md:198-201`):
   cal-diy `10×60 + 10×3 + 120 = 750`; fixture `web` `2×30 + 10×3 + 120 = 210 → 300`; fixture `worker`
   `0 + 0 + 120 → 300`. The plan's own worked example (`750`) confirms the defaults reading.

### 2.4 Assertion rules that are easy to get wrong

- **Union, not subset.** Assert the rendered object **set** equals the golden set — an extra `NetworkPolicy`
  or a missing `CronJob` must fail. "Contains" assertions are how a renderer that emits a `Service` for a
  `worker` slips through.
- **Negative assertions carry the acceptance weight.** ACC-E2E-05's "Service and Ingress for **web only**"
  and "no env value appears in any Deployment, Job or CronJob spec" are absences. Assert them explicitly:
  no `worker` Service; and for every pod-bearing object, a recursive scan that no string equal to any
  fixture env value appears (the fixture's env map is known, so a value scan is possible).
- **No forbidden labels.** Assert `ever-works.io/managed` and `app.kubernetes.io/name` appear on **no**
  object (APW-06 plan §1.2 #6, §4.1; APW-06 T4's `app-names.spec.ts` asserts the helpers never emit them).
- **`envFrom` is not optional.** Assert `optional: false` on both refs (APW-06 plan §4.3: "a missing Secret
  must fail loudly (`CreateContainerConfigError`), unlike the site path").
- **Digest, never tag.** Assert every container image matches `@sha256:[0-9a-f]{64}$`.
- **`ENV_` over `secretKeyRef`, not literal.** Assert the CronJob's `authEnv` value reaches the runner only
  through `valueFrom.secretKeyRef` and never as an `env[].value`.
- **Secrets have no values.** The env Secret fixture is `<redacted>` placeholders — assert key sets, and
  assert that a repo-wide grep of this directory finds no high-entropy-looking literal. `k8s-assert.ts`
  already refuses to read `Secret.data` in the harness (APW-13 plan.md:398); the unit fixtures should refuse
  to store any.
- **Workflow secrets.** For every build-workflow fixture, assert (a) every fixture-provided build value string
  is absent from the output, (b) every `EW_` reference is a `${{ secrets.EW_* }}` reference, (c) the `checks`
  job contains no `secrets.`, no `EW_` token other than `EW_CHECK_COMMAND_B64`, and no `cache-` key. These
  are literally APW-05 T8/T41's own Test lines (`tasks.md:140-149`, `:558-563`) and ACC-05-05 / ACC-05-29.

---

## 3. Which acceptance ids depend on these artifacts

Ids are from [`ACCEPTANCE.md`](../../ACCEPTANCE.md). "W" = depends on the generated build workflow; "M" =
depends on the rendered manifests.

### 3.1 The build workflow (W)

**APW-05 — the whole FR-5…FR-30 surface, asserted at unit level by the golden file:**

| Id        | `ACCEPTANCE.md` line | Criterion (abbreviated)                                                                                                                                 |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC-05-01 | 858                  | a `dockerfile` spec on an unprotected fork commits exactly the workflow file ≤ 60 s                                                                     |
| ACC-05-02 | 859                  | a review-protected branch gets one PR; re-applying keeps one open PR                                                                                    |
| ACC-05-03 | 860                  | **the same inputs generate a byte-identical workflow** ← this directory's primary assertion                                                             |
| ACC-05-04 | 861                  | a hand-edited workflow is never overwritten; a `build` change opens a PR                                                                                |
| ACC-05-05 | 862                  | no stored env value in the file; every action pinned to a 40-hex hash                                                                                   |
| ACC-05-06 | 863                  | a PR from another repository runs no secret-reading job and pushes no image                                                                             |
| ACC-05-07 | 864                  | a push yields a succeeded Build with confirmed digest, `sha-<40>` + `branch-<slug>`, no `latest`                                                        |
| ACC-05-10 | 867                  | PR commits cancel the older build; the tracked-branch running build is kept                                                                             |
| ACC-05-12 | 869                  | the fixture build migrates an ephemeral Postgres; the real database is never contacted                                                                  |
| ACC-05-14 | 871                  | a missing required build value blocks by name; a push run fails its first step < 1 min                                                                  |
| ACC-05-15 | 872                  | a secret copied into the image fails `secretInImage`, pushes nothing, never shows the value                                                             |
| ACC-05-17 | 874                  | `outOfMemory`, `dockerfileError`, `missingBuildValue`, `timeout`, `diskFull` classify with §6.3 copy                                                    |
| ACC-05-22 | 879                  | a private repository asking for 12Gi with no larger runner is blocked with both numbers                                                                 |
| ACC-05-23 | 880                  | a Verification Build runs smoke in the runner ≤ 30 min, reports each, is never deployable                                                               |
| ACC-05-29 | 886                  | same-repo PR: one `Ever Works check: {name}` check run per check, read-only token, no secret; advisory failure fails no run; a foreign PR runs no check |
| ACC-05-30 | 887                  | `build.strategy: image` + one check writes a checks-only workflow; removing the check removes it                                                        |

**APW-13 and end-to-end ids that observe the workflow in a real repository:**

| Id                                   | Criterion                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC-E2E-02 (`ACCEPTANCE.md:243-246`) | every inherited workflow reads `disabled_manually` except `ever-works-build.yml`                                                                     |
| ACC-E2E-05 (`:330-333`)              | the default branch carries the spec and `ever-works-build.yml` committed as _Add Ever Works build workflow_; a push yields `succeeded` with a digest |
| ACC-E2E-06 (`:393-397`)              | the post-merge Build's receipt is linked from `app.build.succeeded`                                                                                  |
| ACC-E2E-07 (`:428-436`)              | agent change → merge → Build for `merge_commit_sha` → deploy → live                                                                                  |
| ACC-E2E-09 (`:478-487`)              | upstream sync → Build for the PR's `merge_commit_sha`                                                                                                |
| ACC-E2E-11 (`:521-538`)              | target **None**: Builds still run, no `app.deploy.*`, no cluster object                                                                              |
| ACC-E2E-14 (`:616-621`)              | on **Link** the workflow arrives as the PR _Add Ever Works build workflow_ and is merged by a person                                                 |
| ACC-NEG-05 (`:658`)                  | no workflow other than `ever-works-build.yml` runs on the fork                                                                                       |
| ACC-NEG-10 (`:663`)                  | `variant/build-oom` on the tracked branch → `app.build.failed` `outOfMemory`                                                                         |
| ACC-NEG-14 (`:667`)                  | the default-branch head is unchanged; no Push Build for the default branch                                                                           |
| ACC-13-01 / ACC-13-07 / ACC-13-13    | fixture build < 3 min; cal-diy build ≤ 60 min in 4 CPU / 12 GiB; merge-side rebuild                                                                  |

### 3.2 The rendered manifests (M)

**APW-06 — unit level, against these fixtures:**

| Id        | `ACCEPTANCE.md` line | Criterion                                                                                                                           |
| --------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ACC-06-06 | 903                  | first Deployment Live with web, worker, migrate, first-deploy job, cron, volume                                                     |
| ACC-06-07 | 904                  | no escalation, all capabilities dropped, default seccomp, no credential, non-root, read-only root                                   |
| ACC-06-08 | 905                  | root image fails rollout ≤ 180 s; allow-root works; Ever Works Apps refuses before apply                                            |
| ACC-06-09 | 906                  | migration failure leaves the running version untouched                                                                              |
| ACC-06-10 | 907                  | crash during rollout rolls back                                                                                                     |
| ACC-06-11 | 908                  | first-deploy jobs finish before any published host routes; not rerun on the second Deployment                                       |
| ACC-06-12 | 909                  | `bodyNotContains` failure quotes the string and rolls back                                                                          |
| ACC-06-13 | 910                  | public DNS/TLS failure with in-cluster pass → Live with warnings, no rollback                                                       |
| ACC-06-14 | 911                  | the self-address check runs from inside the cluster when declared                                                                   |
| ACC-06-15 | 912                  | env change restarts pods; unchanged env does not; rollback restores the previous env copy                                           |
| ACC-06-16 | 913                  | pulls use the per-App-Work read-only credential; the owner's Git token is in no cluster object                                      |
| ACC-06-17 | 914                  | default network policies rendered; enforcement reported; isolation-off recorded                                                     |
| ACC-06-18 | 915                  | volumes survive redeploy, pause, rollback, remove-without-data; volume + 2 replicas refused                                         |
| ACC-06-22 | 919                  | cancel before components change → Cancelled; after → Rolled back (cancelled)                                                        |
| ACC-06-23 | 920                  | manual rollback deploys the old Build with the old commit's App spec                                                                |
| ACC-06-25 | 922                  | a verified custom domain is published ≤ 60 s after verify without restart                                                           |
| ACC-06-26 | 923                  | primary change: `restart` redeploys the same Build; `rebuild` builds first                                                          |
| ACC-06-29 | 926                  | TLS modes produce `https`/`http` URLs and certificate requests per FR-42                                                            |
| ACC-06-35 | 931                  | pause ≤ 120 s, resume with checks; `suspend: true` while paused                                                                     |
| ACC-06-36 | 932                  | remove keeps volumes and dependencies; data deletion needs the exact slug                                                           |
| ACC-06-37 | 933                  | **Run now** uses the live version's image and env                                                                                   |
| ACC-06-42 | 939                  | previews: same-repository PRs only, never shared data, ≤ 3                                                                          |
| ACC-06-45 | 942                  | deleting a live App Work removes every workload/job/host/secret/policy ≤ 300 s, keeps volumes, dependencies and the deny-all policy |
| ACC-06-46 | 943                  | **Also delete stored data** needs the exact slug; dependencies first, then PVCs, then the namespace                                 |
| ACC-06-47 | 944                  | `<slug>.<apps-domain>` with a record to the public ingress address, `https` only in issuer mode                                     |
| ACC-06-48 | 945                  | a verification target has no Ingress, DNS record or PVC, is its own namespace with an expiry label, and is removed whole            |
| ACC-06-49 | 946                  | on Ever Works Apps the Deployment reaches the tier plugin as desired state; the platform applies no workload object                 |

**APW-13 and end-to-end ids that observe rendered objects in a real cluster:**

| Id                                           | Criterion                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC-E2E-05 (`:334-344`)                      | the object list (Deployments, Service/Ingress for web only, `job-migrate-<id>`, `cron-tick`, PVC `web-uploads`, env Secret key set, platform ConfigMap key set, no env value in any spec) and the order (bootstrap + in-cluster smoke before the Ingress)                                         |
| ACC-E2E-14 (`:619-628`)                      | cal-diy: `migrate` completes before the first ready replica; `bootstrap-admin` completes before the Ingress exists; the seven `cron-*` CronJobs; a restart Deployment follows a domain change with no new Build                                                                                   |
| ACC-E2E-11 (`:535-538`)                      | target **None** leaves no labelled object on any cluster; after connecting, `app.deploy.succeeded`                                                                                                                                                                                                |
| ACC-NEG-07 (`:660`)                          | removal leaves the namespace, `ew-default-deny`, the PVC and dependency objects, and scales kept dependency workloads to zero                                                                                                                                                                     |
| ACC-NEG-11 (`:664`)                          | the Deployment's smoke result quotes `localhost`; on a live App Work it rolls back                                                                                                                                                                                                                |
| ACC-NEG-12 (`:665`)                          | the generated-value fingerprint is identical across redeploy, rebuild, restart, re-apply and sync                                                                                                                                                                                                 |
| ACC-04-13 / ACC-04-21 (`:820`, `:828`)       | the first-deploy job + negative smoke; a verification namespace has no Ingress/PVC and is gone ≤ 5 min after                                                                                                                                                                                      |
| ACC-13-02 / 03 / 05 / 08 / 09 / 10 / 11 / 20 | marker + exact commit; internal-not-public; the Ingress exists after the job; a failed migration stops the rollout; the administrator exists before the Ingress; the CronJobs match the Blueprint; a domain change restarts without a Build; the host is never under the platform's parent domain |

**Not covered by either family (asserted elsewhere, so nobody looks here):** ACC-05-08, -09, -11, -13, -16,
-18…-21, -24…-28; ACC-06-01…05, -19…21, -24, -27, -28, -30…34, -38…41, -43, -44; ACC-13-04, -06, -12,
-14…19. Their assertions live in the service/controller/Playwright specs named in the ACCEPTANCE rows
themselves.

---

## 4. Where the tests run

| Level       | Location                                                                                                                                                                                      | What it asserts                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Plugin unit | `packages/plugins/github-actions-build/src/__tests__/generator.spec.ts`, `checks-job.spec.ts`, `action-pins.spec.ts` (APW-05 T8/T41)                                                          | the workflow golden, byte stability, the checks matrix, pins `^[0-9a-f]{40}$`                       |
| Plugin unit | `packages/plugins/k8s/src/app/__tests__/app-manifest.renderer.spec.ts`, `app-names.spec.ts`, `app-security.spec.ts`, `app-jobs.renderer.spec.ts`, `app-network-policy.spec.ts` (APW-06 T4–T8) | the manifest goldens, object set, labels, security context, network policies, cron/runner           |
| Plugin unit | `packages/plugins/k8s/src/__tests__/manifest.renderer.spec.ts`                                                                                                                                | the **existing** site renderer — must pass **unedited** (APW-06 T6 "Done when", `tasks.md:122-123`) |
| Kind lane   | `packages/plugins/k8s/src/__tests__/e2e/app-runtime.e2e.spec.ts` (new) + `docs/specs/features/app-works/APW-13-golden-paths` T34/T35                                                          | the same objects on a real cluster, plus isolation-not-enforced on kindnet                          |
| Live lane   | `apps/web/e2e/flow-app-works-live-*.spec.ts` (APW-13 T36/T45/T46)                                                                                                                             | ACC-E2E-05/06/07/09/11/14, ACC-13-\* against the fixture and Cal.diy                                |

`pnpm --filter @ever-works/k8s-plugin test -- app-manifest.renderer` and
`pnpm --filter @ever-works/github-actions-build-plugin test -- generator checks-job` are the two commands a
change to these goldens must leave green.

---

## 5. How the managed-tier rendering differs

The managed target is **not a second renderer**. APW-06 renders once; on `ever-works-apps` the _same_ rendered
Kubernetes objects are produced by the zone's controller, from desired state, and then overlaid
(Resolution R-5; `CONTRACTS.md:48`; APW-10 spec FR-24 at `APW-10-apps-hosting-tier/spec.md:284-286`:
"The platform never applies workloads to the tier"). The platform's own write is a `Work` object
`w-<workId>` in the control namespace `ever-works-apps-control` (`APW-10 plan.md:222-248`), not manifests.

Each app directory therefore carries a `managed-overlay.yaml` holding **only** the objects whose content
changes, plus the object that exists only on this target. The differences, in one table:

| Object                   | Your cluster                                                   | Ever Works Apps                                                                                                                                                                                                                       | Source                                      |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Namespace name           | `ew-<slug≤30>-<8hex>`                                          | `ewa-<first 20 hex of workId>`                                                                                                                                                                                                        | APW-06 plan §4.1 vs APW-10 plan.md:254      |
| Namespace labels         | enforce `baseline`, warn+audit `restricted`                    | enforce `restricted`, + `…-version=latest`, `hosting.ever.works/tenant`, `hosting.ever.works/work-id`; annotation `hosting.ever.works/allowed-hosts`                                                                                  | APW-06 plan §4.4 vs APW-10 plan.md:320-322  |
| `LimitRange ew-defaults` | `max` 8 CPU / 64Gi                                             | `max` 2 CPU / 4Gi                                                                                                                                                                                                                     | APW-06 plan §4.2                            |
| `ResourceQuota ew-quota` | **not rendered** (403 would be irrelevant)                     | rendered; 403 is fatal                                                                                                                                                                                                                | APW-06 plan §4.2                            |
| Container `limits.cpu`   | absent when `cpuLimit` is undeclared                           | `max(1, 4 × cpu)` so the quota admits the pod                                                                                                                                                                                         | APW-06 plan §4.5                            |
| CronJob schedules        | any valid five-field cron                                      | refused when it can fire more often than every 5 min (`cron_too_frequent`)                                                                                                                                                            | APW-06 plan §4.9; APW-10 plan.md:245, :268  |
| Ingress TLS              | `cert-manager` / `external` / `none`                           | `edge` — the tier's edge owns TLS and the wildcard                                                                                                                                                                                    | APW-06 plan §4.11; APW-10 plan.md:583       |
| Image reference          | the Build's digest                                             | zone overlays rewrite it to `<zone registry>/t-<id>/<component>@sha256:…`                                                                                                                                                             | APW-10 plan.md:336-344                      |
| Pod security             | renderer's context                                             | the zone re-forces `runAsNonRoot: true`, sandbox `runtimeClassName`, `priorityClassName: ever-works-apps-tenant`, bandwidth annotations — "any conflicting rendered value is overwritten, never merged"                               | APW-10 plan.md:336-344                      |
| NetworkPolicies          | the five `ew-*` names                                          | the zone applies **six** differently-named policies (`default-deny`, `allow-dns`, `allow-edge-ingress`, `allow-internet-egress`, `allow-tenant-data`, `quarantine`) with a different egress except-list, and ports 25/465/587 omitted | APW-06 plan §4.10 vs APW-10 plan.md:320-334 |
| Root image               | warned, then fails the rollout ≤ 180 s; the owner may allow it | refused **before apply** (`managed_root_forbidden` / `image_user_unverifiable`)                                                                                                                                                       | APW-06 plan §4.4, spec FR-13                |
| Namespace owner          | the platform creates it                                        | the zone creates it, with its policies and quota, "before any workload, and are managed by the zone — not by the platform"                                                                                                            | APW-10 spec FR-19 (`spec.md:265-266`)       |

**What the test must assert for the managed target:** that the _rendered_ objects differ in exactly the rows
above and in nothing else — i.e. the diff between `manifests/<app>/*.yaml` and
`manifests/<app>/managed-overlay.yaml` is the whole difference. The zone's own overlays are **not** part of
that diff and must not be asserted from this directory (they are APW-10's; its golden set is
`apps/hosting-operator`'s). Asserting an overlay here would make APW-06's renderer test fail the moment
APW-10 changes a zone value.

**One refusal, not an object.** On the managed target both golden apps lose their fast schedules:
app-fixture-hello loses its only CronJob (`*/2 * * * *`), cal-diy loses three of seven. Whether the whole
Deployment is refused or only the offending schedules are dropped is not stated by the epic — see
`open-questions.md` **Q-6**.

---

## 6. Regenerating these files

1. Change nothing here by hand unless the epic changes. Each file cites the plan/spec line it implements.
2. To regenerate: render from the pinned inputs in `manifests/<app>/_index.md` §1, write the objects out in
   the file layout of §2 of that index, and re-run the sha256 derivations in §4.
3. If a derivation changes (env checksum, runner ConfigMap hash, deadline, TLS secret name), the golden
   **names** change too. That is the expected failure mode, and it is why every derivation is written out
   longhand in the indexes rather than left to a helper.
4. Recompute the build-workflow header fingerprint if any canonical input changes — the exact hashed bytes
   are in `build-workflow/README.md` §2, and the fingerprint is on line 3 of the generated file.
5. Nothing in this directory may ever contain a secret value, a real hostname or a cluster address. Grep for
   `ghcr.io/` (allowed — it is the registry FR-27 names), `example.`, and any `sha256:`/`Bearer ` before
   committing.
