# Contradictions

**What this file is.** Every place the epics' renderer contract conflicts with what `manifest.renderer.ts`
(and its plugin) actually does today; every conflict _between_ epics; every App spec field with no rendering
rule; every rendered object with no spec field behind it; and the refusal/error-code mismatches. Nothing here
is fixed by this directory — the golden files follow the epics, and each conflict is listed so the
implementation does not discover it by accident.

**Id scheme (citation-stable).** This file's ids are `K-n` (section A — the epics' contract vs today's code)
and `X-n` (section B — epic vs epic). They are **not** the same namespace as the sibling
`_build-artifacts/open-decisions/contradictions.md`, which uses `A-n`…`E-n` for a different subject (the
owner's 2026-09-17 answers vs the plan); always cite these with their file path. Sections C–F are unnumbered
lists. One overlap worth knowing: that file's `D-2` ("One namespace per App Work is not what the platform does
today") and this file's `K-11` describe the same underlying fact from different angles.

**Status of the code quoted.** Worktree `ever-works-platform-any-repo-works`, branch
`plan/any-repo-as-work`. `packages/plugins/k8s/src/app/`,
`packages/plugin/src/contracts/capabilities/app-deployment.types.ts` and `packages/agent/src/app-runtime/`
**do not exist yet** (verified) — every App-path behaviour below is specified in APW-06's plan, not in code.

> ⚠️ **The spec tree was being edited concurrently while this directory was produced.** Between the reads
> that produced the golden files and the writes that recorded them, 23 tracked spec files changed under
> `docs/specs/features/app-works/` (including `CONTRACTS.md`, `APW-03/schema.md`, `APW-06/{plan,spec}.md` and
> **both** relevant Blueprints). The effects on this directory were: the cal-diy Blueprint's three
> `EVER_WORKS_*` env names were renamed to `APP_*` (see **X-1**), which changed the env checksum and every
> derived object name — the cal-diy goldens here are re-derived from the post-fix content
> (`works.yml` sha256 `6977cfdf9b4ae12e83e6c0710ebef2b27d36f46e1fc875dd376bd0d1bcb0ecea`). Nothing else in the
> renderer contract changed: the APW-06/APW-10 diffs touched the verification-namespace ownership wording,
> the health-poll cadence, one Deployment state and the `Work Repository` vocabulary. **Re-check every
> `file:line` citation below against a frozen revision before implementing against it.**

---

## A. The epics' contract vs `manifest.renderer.ts` today

### K-1. One container named `app`, one port, one Work — the App renderer needs N components

`manifest.renderer.ts:41-50`:

```ts
		containers: [
			{
				name: 'app',
				image: input.image,
				imagePullPolicy: input.imagePullPolicy ?? 'Always',
				ports: [{ containerPort: input.containerPort, name: 'http' }],
```

and the input is a **singular** port (`types.ts:184` `containerPort: number`). APW-06 renders "Per component a
`Deployment`" (`plan.md:328`) named after the component (`plan.md:293`, names table). The two shapes cannot
share a code path.

APW-06 resolves this by _not_ touching the file — "Pure functions from `AppRenderInput` to manifests; no I/O.
**The existing `manifest.renderer.ts` is not edited.**" (`plan.md:285`) — so this is a divergence to keep.
The contradiction is documentary: APW-06 plan §1.1 presents `manifest.renderer.ts` as the model whose "pod and
container defaults are chosen for platform-generated sites; App defaults for user-controlled code are defined
in §4.4" (`plan.md:33`), but **no line of `manifest.renderer.ts` says anything about untrusted code**. The
only security-flavoured comments in it are about mutable tags (`:44-48`) and OOM sizing measured on the
platform's own Works (`:77-93`).

### K-2. Labels: `ever-works.io/managed: "true"` and `app.kubernetes.io/name` are forbidden for Apps

`manifest.renderer.ts:10-19`:

```ts
const COMMON_LABELS = (workId: string, slug: string): Record<string, string> => ({
	'ever-works.io/managed': 'true',
	'ever-works.io/work-id': workId,
	'app.kubernetes.io/name': slug,
	'app.kubernetes.io/managed-by': FIELD_MANAGER
});
```

APW-06 plan §4.1 requires a disjoint set and says so explicitly — "**Not** `ever-works.io/managed` and **not**
`app.kubernetes.io/name`" (`plan.md:306-307`) — because "Reusing `app.kubernetes.io/name` or
`ever-works.io/managed=true` would make App components appear in `listProjects` / `listManagedDeployments`"
(`plan.md:70-73`). That listing is real: `k8s-api.service.ts:337-351` selects
`'ever-works.io/managed=true'` across all namespaces. The same plugin package therefore emits two
incompatible label vocabularies, and nothing in the plan says how a consumer tells an App object from a site
object other than by `ever-works.io/kind: app`.

### K-3. The selector is immutable and different

`manifest.renderer.ts:17-19` selects on `{ 'app.kubernetes.io/name': slug }`. APW-06 selects on
`{ 'ever-works.io/component': <name> }` and justifies the choice ("stable across slug renames",
`plan.md:307-308`). Both are right, and because a Deployment's `spec.selector` is immutable, no object can
ever move from one to the other. Neither epic offers a migration path for a Work that already has site-shaped
objects, and APW-06 plan §4.2's namespace-ownership check only refuses a namespace "labelled for another
Work" (`plan.md:315-317`) — it would not notice site-shaped objects left in the namespace by an earlier path.

### K-4. Probes are hard-coded to the site's paths

`manifest.renderer.ts:57-76` fixes startup `'/'`, readiness `/api/health` and liveness `/api/health`, with
`timeoutSeconds` 10/5/10, `periodSeconds` 10/10/20 and thresholds 30/3/6. APW-06 takes every one of those from
the spec and fills the schema's defaults only where the spec is silent (`plan.md:376-381`;
`APW-03 schema.md:198-201`). There is no input through which `manifest.renderer.ts` could express a
spec-declared probe, which is why the App path must be a separate module rather than an added parameter.

### K-5. `envFrom` optionality is inverted — the single most behaviour-visible difference

Today, `manifest.renderer.ts:106-115`:

```ts
				// Server-side deploys (EW — platform-managed clusters) mount the
				// per-work runtime-env Secret the platform applied just before
				// this manifest. `optional: true` keeps the pod schedulable when
				// the Secret is absent (older works, custom clusters) — the app
				// then boots on its baked-in defaults exactly as before.
				...(input.envFromSecretName
					? {
							envFrom: [{ secretRef: { name: input.envFromSecretName, optional: true } }]
						}
					: {})
```

APW-06 requires the opposite, for both refs: "Env via `envFrom: [{ secretRef: { name: app-env-…, optional:
false } }, { configMapRef: { name: app-platform-…, optional: false } }]` — **not optional**: a missing Secret
must fail loudly (`CreateContainerConfigError`), unlike the site path." (`plan.md:335-338`).

Same helper shape, opposite failure mode. A reviewer reading only one of the two files will get it wrong.

### K-6. `imagePullPolicy` defaults are inverted

`manifest.renderer.ts:45-49` defaults to `'Always'`, with a stated reason: "The server-side path pins a
MUTABLE branch alias (`:dev`/`:stage`/`:prod`) that CI republishes, so a node with a cached layer would keep
serving the old build forever under `IfNotPresent`." APW-06: "`imagePullPolicy: IfNotPresent` (digest-pinned
references make `Always` pointless)" (`plan.md:342-343`). Both are correct for their own image identity —
which is itself the contradiction in K-8.

### K-7. Two different resource default tables in one plugin

|                   | `manifest.renderer.ts:94-105` | `APW-03 schema.md:192-195` |
| ----------------- | ----------------------------- | -------------------------- |
| `requests.cpu`    | `100m`                        | `250m`                     |
| `requests.memory` | `256Mi`                       | `512Mi`                    |
| `limits.cpu`      | `2`                           | _(none by default)_        |
| `limits.memory`   | `2Gi`                         | `2 × memory`               |

APW-06 renders straight from the spec ("`requests.cpu = resources.cpu`, `requests.memory = resources.memory`,
`limits.memory = resources.memoryLimit`", `plan.md:379-381`), so a silent App component gets the _schema's_
defaults while a silent site Work gets the _renderer's_. Two defaults tables with different numbers now live
in the same package.

### K-8. The plugin cannot address a digest today

`k8s.plugin.ts:687-709`:

```ts
	const gitSha = sanitiseDockerTag((opts.gitSha ?? '').slice(0, 12)) || Date.now().toString(36).slice(0, 12);
	…
	const image = `${imageBase}/${imageName}:${gitSha}`;
```

and `sanitiseDockerTag` (`k8s.plugin.ts:1285-1294`) strips `@`:

```ts
return input
	.replace(/[^A-Za-z0-9_.-]+/g, '')
	.replace(/^[._-]+/, '')
	.slice(0, 128);
```

APW-06 requires `image: { reference: string /* …@sha256:<64 hex> */ }` (`plan.md:205`) and FR-32 ("Deployments
reference a Build's digest, never a tag"). The epic knows: "The plugin cannot address a digest
(`sanitiseDockerTag` strips `@`, the tag is truncated to 12 chars)" (`plan.md:62-64`). The contradiction is
that `sanitiseDockerTag` stays in the file, unchanged, on a live code path — nothing structurally prevents a
future caller from routing an App image through the tag builder, and no test asserts it does not.

### K-9. `CONTAINER_PORT = 3000` is a module constant

`k8s.plugin.ts:71-75` and its use at `:775`. The fixture's web port is `8080`; cal-diy's is `3000`. APW-06
renders the spec's port. Two sources of truth for the same number, one of them a constant.

### K-10. The rollout predicate is a near-miss, not a reuse

`status.mapper.ts:27-42` returns `ready` on `Available=True`; `isRolloutComplete` (`:47-52`) checks
`observedGeneration >= generation` and `availableReplicas >= replicas`. APW-06's predicate adds
`updatedReplicas = replicas`, `unavailableReplicas` absent/0, **no older ReplicaSet with ready pods**, and a
30 s restart-free window for probe-less workers (`plan.md:583-585`) — precisely because "`Available=True`
stays true while a broken new ReplicaSet crash-loops behind a healthy old one" (`plan.md:60-61`).
`isRolloutComplete` is documented as having no production caller (`plan.md:35`), so it is tempting to reuse.
The code does not mark it as unsuitable for Apps; APW-06 T9 only says "Do **not** change
`packages/plugins/k8s/src/status.mapper.ts`" (`APW-06 tasks.md:150`).

### K-11. Namespace creation labels the namespace with the forbidden labels

`k8s-api.service.ts:387-420` (`ensureNamespace`) creates a namespace labelled
`'ever-works.io/managed': 'true'` and `'app.kubernetes.io/managed-by': FIELD_MANAGER` (409 already-exists is
swallowed at `:415-416`). APW-06 §4.2 requires the App path to create (or verify) a namespace carrying
`ever-works.io/work-id` equal to this Work (`plan.md:315-317`), and §4.1 forbids `ever-works.io/managed`.
Reusing `ensureNamespace` as-is would stamp every App namespace with the label that means "a platform site
lives here".

### K-12. `k8s-api.service.ts` has no delete, scale, log, Job, PVC, policy or access-review call

Verified list of the file's public methods: `validateConnection`, `getServerVersion`, `listIngressClasses`,
`listNodes`, `getDeployment`, `listManagedDeployments`, `applyDeployment`, `applyService`, `ensureNamespace`,
`applyIngress`, `applyImagePullSecret`, `applySecret`, `readIngress`, `getIngressLoadBalancerHost`. There is
**no** delete, scale, Job/CronJob/PVC/NetworkPolicy/ServiceAccount/LimitRange/ResourceQuota call, no pod logs,
no exec, no events and no `SelfSubjectAccessReview`. APW-06 T10 adds `applyObject`, `readObject`,
`listObjects`, `deleteObject`, `readPodLog`, `createSelfSubjectAccessReview` and `authorizationV1Api` — until
it lands, `destroyApp`, `getAppStatus`, `getAppLogs`, `runAppJob`, `scaleApp` and `checkAppCluster` have **no
implementation surface at all**. The SSA mechanics themselves are reusable: `k8s-api.service.ts:361-369` is
`objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY)` with
`SERVER_SIDE_APPLY = 'application/apply-patch+yaml'` (`:144`) and the rationale for using
`KubernetesObjectApi` rather than the typed patch methods (`:112-118`).

### K-13. One `FIELD_MANAGER` for two renderers, and APW-06 never mentions one

`FIELD_MANAGER = 'ever-works-k8s-plugin'` (`manifest.renderer.ts:8`) is imported by the API service
(`k8s-api.service.ts:14`) and used as the SSA field manager in all five apply methods. Its doc comment says
"Editing this string is a breaking change for users who SSA-conflict on hand-edited fields" (`:4-7`). APW-06
plan §4 never names a field manager for the App path. Either App objects share it — and a hand-edited App
field is silently overwritten exactly as today, which `plan.md:1043` half-acknowledges ("`force: true` as
today; the Activity entry notes fields overwritten are not tracked") — or a second one is introduced, which
the epic does not say. Open question Q-8.

### K-14. Ingress naming, backend naming and the "no class" rule differ

`manifest.renderer.ts:225-241` builds rules with `backend.service.name = input.workSlug` and
`ingressClassName: input.ingressClass` **unconditionally** (even when `input.ingressClass` is `undefined`);
`buildIngress` returns `null` only when `hosts.length === 0` (`:211`). APW-06 names the Ingress _and_ its
backend after the **component** (`plan.md:293`), and refuses to render at all "when no class exists and no
default class was detected (warning `no_ingress_controller`, public smoke skipped)" (`plan.md:446-447`). Two
different absence rules, two different backend names.

Worth noting what _is_ reusable and should be: the strategy registry and its annotation/TLS shapes
(`ingress/nginx.strategy.ts:4-13`, `:17-27`, `:30-33`; `ingress/traefik.strategy.ts:4-12`;
`ingress/generic.strategy.ts:12-25`; `ingress/strategy.registry.ts:16-17`, `:33-36`),
`normaliseIngressHost`'s strict RFC-1123 rule (`k8s.plugin.ts:1296-1309`), `buildDnsGuidance`'s apex
heuristic (`domain.handler.ts:20-40`) and `verifyDomainResolution` (`:135-188`).

---

## B. Epic vs epic

### X-1. `EVER_WORKS_*` env names: the schema forbids exactly what the flagship Blueprint declared — **fixed in the working tree while this directory was being written**

APW-03's schema, R23 (`schema.md:464`):

> | R23 | No `env` entry is named `EVER_WORKS_*` — that prefix is reserved for platform-injected values. | `reserved_env_name` | error |

APW-06 plan §4.7 rests on that rule: the platform ConfigMap holds the `EVER_WORKS_*` names and "collision
with an App spec name is impossible (APW-03 R23)" (`plan.md:394`).

The cal-diy Blueprint **as first read** declared three such names — `EVER_WORKS_WEB_INTERNAL_URL`,
`EVER_WORKS_BOOTSTRAP_ADMIN_EMAIL`, `EVER_WORKS_BOOTSTRAP_ADMIN_PASSWORD` — and `bootstrap-admin` read all
three. Under R23 the flagship Blueprint could not validate, and "nothing is built or deployed from a commit
whose own spec has errors" (`schema.md:83-84`).

**Resolved in the working tree** (not by this directory): the Blueprint was renamed to
`APP_WEB_INTERNAL_URL` (`works.yml:122`), `APP_BOOTSTRAP_ADMIN_EMAIL` (`:137`) and
`APP_BOOTSTRAP_ADMIN_PASSWORD` (`:140`), with a comment recording the rule. The same edit replaced the
password's `pattern` (which used look-around and could not compile under RE2 — `pattern_unsupported`,
`schema.md:242`) with `validate: { minLength: 15 }`.

**Kept here because it is load-bearing for the golden files:** the rename changes the App spec's
runtime-phase **name set**, which changes the env checksum
(`4ca4f0305e428b64` → `3b2eee9155911d5d`) and therefore the names `app-env-3b2eee9155` and
`app-platform-3b2eee9155`, every reference to them in the Jobs and CronJobs, and the
`ever-works.io/env-checksum` pod annotation. It is a worked example of `../../open-questions.md` Q-12 and of
X-15 below: **a name-set change renames objects and rolls pods**, and any golden file produced before such a
fix is silently stale. Both artifacts in this directory are pinned to the post-fix content
(cal-diy `works.yml` sha256 `6977cfdf…ecea`).

### X-2. `schema.md` has no `## 10.` heading

Headings jump `## 9. build` (`schema.md:157`) → `## 11. dependencies` (`:203`). The `components[]` table
physically lives at `schema.md:179-201`; "§10" exists only as a cross-reference label (`:95`, and §22 R2/R3 at
`:443`, `:444`). APW-06 plan §4.5 cites it for the probe object, and APW-06 T6 cites "APW-03 `schema.md` §24
examples" (`tasks.md:115-116`). Any task that says "per §10" needs a human to know it means 179-201.

### X-3. The fixture's worker memory is below the schema's own minimum

`apw-13 … app-fixture-hello/.works/works.yml:62` — `resources: { cpu: 25m, memory: 48Mi, memoryLimit: 96Mi }`.
`schema.md:28`: `MemQuantity` = integer + `Mi`/`Gi`, **64Mi–256Gi**. `48Mi` is `out_of_range` (an error,
`schema.md:32`). The fixture is the app every live acceptance scenario drives, so this must be resolved before
ACC-E2E-05 can run at all. Rendered as written in
`manifests/app-fixture-hello/10-deployments.yaml`.

### X-4. `build.resources.memory` is a string in the spec and a number in the contract

App spec (`schema.md:169`): `MemQuantity` default `7Gi`, `1Gi`–`64Gi`. APW-05's capability type
(`plan.md:498`): `resources: { cpu: number; memoryGiB: number; timeoutMinutes: number }`. APW-05 §4.5 says the
canonical inputs are "`build` (normalised: defaults applied, keys sorted)" (`plan.md:662-664`) but never states
the string → GiB conversion, nor what a non-integral `Mi` quantity becomes. It matters: the conversion feeds
`inputsHash`, which is the file's fingerprint and therefore changes on every App Work on any change of rule.
`2Gi` → `2` is obvious; `1536Mi` → `1.5` is not specified.

### X-5. Two namespace derivations

APW-06 plan §4.1: `ew-<slug ≤ 30>-<first 8 hex of workId>`. APW-10 plan.md:254:
`status.namespace: ewa-<first 20 hex of workId>`. Different prefixes, different inputs, both "the namespace of
this App Work". The renderer must be told which, and `AppRenderInput.ref.namespace` (CONTRACTS §3) carries
one string — so on the managed target the renderer's own namespace rule is simply unused, which no epic says.

### X-6. Two NetworkPolicy families — and R-15 names a third thing

|              | APW-06 plan §4.10                                                                                    | APW-10 plan.md:320-334                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| names        | `ew-default-deny`, `ew-allow-same-namespace`, `ew-allow-ingress`, `ew-allow-egress`, `ew-allow-deps` | `default-deny`, `allow-dns`, `allow-edge-ingress`, `allow-internet-egress`, `allow-tenant-data`, `quarantine` |
| DNS          | inside `ew-allow-egress`                                                                             | its own `allow-dns`                                                                                           |
| IPv4 excepts | 9 ranges                                                                                             | 11 ranges                                                                                                     |
| egress ports | unrestricted                                                                                         | 25 / 465 / 587 and mining ports omitted                                                                       |
| count        | 5                                                                                                    | 6                                                                                                             |

Both describe "the app's network isolation by default". `CONTRACTS.md:58` (R-15) then names the kept policy
`ew-default-deny` — the APW-06 spelling — while APW-10 calls it `default-deny`. On the managed target the
controller applies its own set, so the renderer's five are not what runs; nothing reconciles the two, and
`ew-allow-deps`' hairpin rule (APW-06) has no counterpart in APW-10's list.

### X-7. LimitRange default limit

APW-06 plan §4.2: "default limit 1 CPU / 512Mi". APW-10 plan.md:333: "default limit 500m/512Mi". Same object,
same namespace, two numbers.

### X-8. ResourceQuota numbers and keys

APW-06 plan §4.2 lists 13 keys with values (`requests.cpu: 2`, `limits.cpu: 4`, `requests.memory: 4Gi`,
`limits.memory: 6Gi`, `pods: 20`, `persistentvolumeclaims: 5`, `requests.storage: 20Gi`,
`services.loadbalancers: 0`, `services.nodeports: 0`, `count/jobs.batch: 20`, `count/cronjobs.batch: 20`,
`secrets: 30`, `configmaps: 30`). APW-10 FR-47 ships two profiles by name — Starter (CPU 1/2, memory 2/4 GiB,
10 pods, 4 volumes totalling 10 GiB) and Standard (2/4, 4/8 GiB, 20 pods, 8 volumes totalling 50 GiB) — and
its plan names only four quota keys (`services.loadbalancers`, `services.nodeports`, `count/jobs.batch`,
`count/cronjobs.batch`, `plan.md:332`). `persistentvolumeclaims`, `requests.storage`, `secrets` and
`configmaps` are not specified by APW-10 at all. And the arithmetic does not obviously reconcile: with the
renderer's `max(1, 4 × cpu)` cpu limits, the fixture's two components each carry `limits.cpu: 1`, which a
Starter profile's `limits.cpu: 2` happens to admit but a third component would not.

### X-9. The desired-state schema is narrower than the App spec

| Resource              | App spec allows      | `Work` CRD allows        |
| --------------------- | -------------------- | ------------------------ |
| components            | 10 (`schema.md:179`) | 8 (`APW-10 plan.md:248`) |
| cron entries          | 20 (`schema.md:322`) | 10 (`plan.md:245`)       |
| volumes per component | 5 (`schema.md:196`)  | 4 (`plan.md:243`)        |

A valid App spec can therefore be unrepresentable on the managed target, with the refusal code
`SPEC_LIMIT_EXCEEDED` (`plan.md:265-268`) — which reads to the owner as "your app is too big" rather than "the
tier's schema is smaller than the spec's".

### X-10. The desired state cannot express much of what the renderer needs

`Work.spec` (APW-10 plan.md:222-248) has no `smoke`, no `checks`, no `ingress`/`tls`/`network` fields, and a
`cron` entry narrowed to `{ name, schedule, http: { method, path, authEnv } }`. Against the App spec
(`schema.md:311-331`) that silently drops:

- every `smoke[]` check on the managed target — yet APW-06 §4.12 and FR-36 make smoke the Deployment's gate;
- `cron[].http.authScheme` — so cal-diy's `booking-reminder`, `change-time-zone` and `webhook-triggers`
  (`authScheme: raw`, works.yml:221, :226, :231) would be rendered as `bearer` and their routes would reject
  the call (the Blueprint's own comment: "some cron routes compare the raw Authorization header");
- `cron[].http.expect` (default `[200, 201, 204]`, `schema.md:316`), `cron[].timeoutSeconds`,
  `cron[].concurrency`, `cron[].component`;
- `jobs[].http.expect` and `jobs[].http.authScheme`;
- `components[].resources.cpuLimit` (the CRD has `cpu, memory, memoryLimit` only, `plan.md:242`);
- probe `timeoutSeconds`/`initialDelaySeconds` (the CRD stores `probes` as an opaque object, `plan.md:242`).

The renderer cannot invent these; the managed target is therefore strictly less capable than Your cluster for
the same App spec, and no epic's acceptance criteria cover the loss.

### X-11. Privileged ports

APW-06 plan §4.4 refuses `port < 1024` on `ever-works-apps` (`privileged_port`; T5's test asserts it,
`tasks.md:103`). APW-10 has no such refusal — it is an explicit "not specified" in its own documents, and its
admission bundle (`plan.md:346-357`) contains nothing about component ports. The zone owns the tier's
admission, so the refusal that APW-06 asserts may never be enforced.

### X-12. Root images: before apply, or a Degraded reason?

APW-06 plan §4.4: for `ever-works-apps` "the refusal happens **before apply**: `AppImageConfigReader` reads
the image config's `User` from the registry in the worker … Empty, `0`, `root`, `0:*` or a non-numeric user →
precondition `managed_root_forbidden` / `image_user_unverifiable`".

APW-10 plan.md:268: "Degraded reasons include `IMAGE_RUNS_AS_ROOT`, `QUOTA_EXCEEDED`" — a _status_ reason, not
a refusal — and the enforcement is an overlay (`runAsNonRoot: true`) plus admission refusing `runAsUser: 0`
(LG-05, `plan.md:380`). Different timing (pre-apply vs post-apply/Degraded), different mechanism, different
code names, and APW-10 owns the tier.

### X-13. `runtimeClassName`: rendered by APW-06, overwritten by APW-10

APW-06 §4.3 renders `runtimeClassName` "when the policy names one" (`plan.md:341`), and §5.1 makes a null one
a precondition (`managed_sandbox_unavailable`, R-24). APW-10's overlays overwrite it with the zone's sandbox
class and "any conflicting rendered value is overwritten, never merged" (`plan.md:336-344`). So on the
managed target the rendered value is never the applied value — which is fine, but it means the _golden file_
for the managed target must not assert `runtimeClassName`, and `AppsTierPolicy.podPolicy()`'s value
("informational for APW-06 renderer fixtures", APW-10 `plan.md:582`) is doubly informational.

### X-14. `ew-runner-<hash10>` has a name but no hash

APW-06 §4.1 names the object `ew-runner-<hash10>` and describes its contents ("Script + check list"), and
§4.8 says the runner reads the request list from a second mounted file. Nothing states what `<hash10>` hashes,
so two implementations will disagree and every runner Job's `volume.configMap.name` will differ. This golden
set defines it (see `manifests/*/\_index.md` §4) and records the assumption as open question Q-4.

### X-15. `hashRuntimeEnv`'s scope renames the env Secret whenever a platform variable is added

APW-06 §4.7: "`checksum` = first 16 hex of sha256 over `name=value` lines of **both maps** sorted by name".
Adding a fifth `EVER_WORKS_*` variable (say `EVER_WORKS_SOURCE_URL` when FR-44 starts applying) changes the
checksum and therefore the **names** of `Secret app-env-*` and `ConfigMap app-platform-*` — which is a new pod
template and a full rollout, for a value the app may ignore. Under the epic's own FR-17 ("a changed value
always restarts pods … an unchanged value never does") that is defensible, but it means enabling a
license-driven env var rolls every managed App Work that gains it.

---

## C. App spec fields with no rendering rule

Grep-verified against APW-06's plan and spec. Fields with no rule **by design** (license, blueprint, source,
agents, upstreamSync, upstreamPullRequests, provisioning, `display.protectedPaths`, `checks`) are marked
"by design"; the rest are gaps.

| Field                                                                                                                                   | Defined at                             | Status                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components[].args`                                                                                                                     | `schema.md:186`                        | **Gap.** §4.3 says "`command`/`args` from spec" once (`plan.md:342`) and never again; nothing says whether `args` is emitted as `containers[].args` or appended to `command`. These goldens emit `command` only, because neither Blueprint declares `args`.                                                       |
| `components[].target`                                                                                                                   | `schema.md:187`                        | **Gap.** "Dockerfile stage override for this component" is a _build_ concern that has no meaning after the image exists; no plan line says what a renderer does with it.                                                                                                                                          |
| probe `tcp: true` on a `worker`                                                                                                         | `schema.md:198-201`, `:191`            | **Gap.** §4.5 emits `tcpSocket { port: 'http' }`, but `http` is the container port _name_, and a worker has no port (`worker_port_forbidden`, `schema.md:188`). The schema warns about this (`worker_probe_without_port`) without resolving the rendered port name.                                               |
| `components[].resources.cpuLimit` on Your cluster                                                                                       | `schema.md:194`                        | **Ambiguous.** §4.5 defines `limits.cpu` explicitly only for `ever-works-apps` (`max(1, 4 × cpu)`) and says "`limits.cpu = resources.cpuLimit` when declared". Rendered here as omitted-because-undeclared; the "when declared" half is not stated for Your cluster.                                              |
| `env[].generate.keypair` → `<NAME>_PUBLIC`                                                                                              | `schema.md:253-262`; `CONTRACTS.md:54` | **Gap.** The public half is "exposed as `<NAME>_PUBLIC` only". No rule says whether that synthesised name is a key of the env Secret — which changes the checksum and therefore every derived object name.                                                                                                        |
| `smoke[].when: first-deploy`                                                                                                            | `schema.md:357`                        | **Gap.** FR-36 says such checks "run only on the first Deployment", but the request list is rendered once into the runner ConfigMap, so a `first-deploy` smoke row is indistinguishable from an `always` one at render time. Either the renderer splits the list or the deployer filters it — neither is written. |
| `smoke[].expect.maxLatencyMs`                                                                                                           | `schema.md:356`                        | **Gap.** §4.8's request-list shape lists `name, status, latencyMs, failedExpectation?, found?` and never mentions the expectation's latency bound; T8's test does assert latency behaviour. These goldens omit `maxLatencyMs` from `requests.json`.                                                               |
| `smoke[].component`                                                                                                                     | `schema.md:352`                        | **Gap.** "Must be `web`"; §4.11/§4.12 assume the primary component. Rendered here against the primary component only.                                                                                                                                                                                             |
| `build.services[]`                                                                                                                      | `schema.md:167`                        | By design — an APW-05 input (the workflow's `services:` block), never a cluster object.                                                                                                                                                                                                                           |
| `dependencies.*` details (`extensions`, `redis.persistence`, `maxmemoryPolicy`, `objectStorage.publicBuckets`)                          | `schema.md:209-214`                    | By design — APW-07's providers, not APW-06's renderer. But §4.2's apply order never lists dependency objects, so the ordering between a dependency's workloads and `ew-allow-deps` is unstated.                                                                                                                   |
| `env[].validate`                                                                                                                        | `schema.md:242`                        | By design (APW-07 validates on generation).                                                                                                                                                                                                                                                                       |
| `checks[]`                                                                                                                              | `schema.md:365-368`                    | By design — an APW-05 workflow input; no Kubernetes object renders from it, so a 20-entry `checks` block has zero rendering rule.                                                                                                                                                                                 |
| `appSpecVersion`, `kind`, `license`, `blueprint`, `source`, `display`, `agents`, `upstreamSync`, `upstreamPullRequests`, `provisioning` | `schema.md` passim                     | By design.                                                                                                                                                                                                                                                                                                        |

---

## D. Rendered objects (and fields) with no App spec field behind them

Every row is a value a manifest needs that the App spec cannot express. **None of these is a request to add a
field** — each is recorded so the source of truth is explicit and so nobody "fixes" it by inventing a key.

| Object / field                                                                                                                                                                                                               | Rule                                                                           | Where its value actually comes from                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Namespace` (existence, name, labels)                                                                                                                                                                                        | §4.1                                                                           | the Work's slug + uuid; `WorkAppRuntimeState`                                                                                                                                      |
| `ServiceAccount app` + `automountServiceAccountToken: false`                                                                                                                                                                 | §4.1, §4.3                                                                     | constant                                                                                                                                                                           |
| `LimitRange ew-defaults` (all four values + `max`)                                                                                                                                                                           | §4.2                                                                           | constants, per target                                                                                                                                                              |
| `ResourceQuota ew-quota` (all 13 keys)                                                                                                                                                                                       | §4.2                                                                           | `AppsTierPolicy`                                                                                                                                                                   |
| `Secret app-pull`                                                                                                                                                                                                            | §4.7                                                                           | APW-05 `AppImagePullCredentialSource` — the App spec has no registry field at all                                                                                                  |
| `ConfigMap app-platform-*` (all four/five names)                                                                                                                                                                             | §4.7                                                                           | platform-injected; the App spec is forbidden from naming them (X-1)                                                                                                                |
| `ew-allow-egress`'s DNS rule, its 9 IPv4 + 4 IPv6 excepts                                                                                                                                                                    | §4.10                                                                          | constants                                                                                                                                                                          |
| `ew-allow-ingress`'s controller namespace (+ its fallback)                                                                                                                                                                   | §4.10                                                                          | `targetSettings.controllerNamespace` from the connection check                                                                                                                     |
| `ew-allow-deps`' `extraEgress` addresses                                                                                                                                                                                     | §4.10                                                                          | APW-07 dependency egress data (host, ports)                                                                                                                                        |
| the five policy names themselves                                                                                                                                                                                             | §4.10                                                                          | constants                                                                                                                                                                          |
| `ConfigMap ew-runner-*` (name, script, mount paths)                                                                                                                                                                          | §4.1, §4.8                                                                     | constants; `<hash10>` undefined (X-14)                                                                                                                                             |
| runner image, its `requests`/`limits`, its `runAsUser: 10001`, its `activeDeadlineSeconds = window + 30`                                                                                                                     | §4.8                                                                           | `APP_RUNNER_IMAGE` constant + `APP_*` constants (plan §5.3)                                                                                                                        |
| `Deployment` `revisionHistoryLimit: 5`, `progressDeadlineSeconds`, `minReadySeconds`, `strategy`, `topologySpreadConstraints`, `enableServiceLinks`, `automountServiceAccountToken`, `imagePullPolicy`, `serviceAccountName` | §4.3                                                                           | constants + the deadline formula                                                                                                                                                   |
| pod annotations `ever-works.io/env-checksum`, `-build-commit`, `-deployment-id`                                                                                                                                              | §4.3                                                                           | `AppRenderInput.env.checksum`, `.specCommitSha`, `.deploymentId`                                                                                                                   |
| PVC label `ever-works.io/retain: "true"`; annotation `ever-works.io/backup`                                                                                                                                                  | §4.1, §4.6                                                                     | the label is a constant; the annotation maps from `volumes[].backup`                                                                                                               |
| PVC `storageClassName`                                                                                                                                                                                                       | §4.6                                                                           | `targetSettings.storageClass`, else the cluster default                                                                                                                            |
| `Ingress` `ingressClassName`, strategy annotations, TLS mode, issuer, `previous` hosts                                                                                                                                       | §4.11                                                                          | `AppRenderInput.ingress` + `hosts.previous`                                                                                                                                        |
| `Service` `type: ClusterIP`, `port: 80`                                                                                                                                                                                      | §4.3                                                                           | constant                                                                                                                                                                           |
| `Job`/`CronJob` `ttlSecondsAfterFinished: 86400`, `restartPolicy: Never`, `concurrencyPolicy`, `timeZone`, `startingDeadlineSeconds`, history limits                                                                         | §4.8, §4.9                                                                     | constants (only `concurrency` and `timeoutSeconds` map to spec fields)                                                                                                             |
| the **inner** Job of a CronJob (`jobTemplate.spec.template.metadata.name`)                                                                                                                                                   | §4.1 names table gives `job-<name>-<deploymentShort>` and `run-<name>-<8 hex>` | **undefined.** A CronJob's inner Job must be unique per firing; a fixed name would collide. These goldens omit `metadata.name` so the controller generates it — open question Q-9. |
| `purpose: 'verification'` namespaces' expiry annotation, `-v<attempt>` suffix, `emptyDir` volume substitution                                                                                                                | §4.1, §4.12                                                                    | R-10 / APW-04                                                                                                                                                                      |

Also rendered, with no _object_ behind them but a rule: the **isolation probe** (§4.10) and the **hairpin/smoke
runner Jobs** (§4.11, §4.12) are created by `app-deployer` at deploy time and therefore appear in no
desired-state golden file. Their absence from `manifests/` is deliberate.

---

## E. Refusal and error-code mismatches

### E-1. Two closed, disjoint code vocabularies

`K8sPluginErrorCode` (`errors.ts:9-33`) is exactly:

```ts
export type K8sPluginErrorCode =
	| 'INVALID_YAML'
	| 'MISSING_CONTEXT'
	| 'MISSING_CLUSTER'
	| 'MISSING_USER'
	| 'CLUSTER_UNREACHABLE'
	| 'UNAUTHORIZED'
	| 'NOT_CONFIGURED'
	| 'GITHUB_NOT_CONNECTED'
	| 'REGISTRY_AUTH_FAILED'
	| 'APPLY_FAILED'
	| 'ROLLOUT_TIMEOUT'
	| 'UNKNOWN';
```

APW-06 T11 adds `KUBECONFIG_UNSUPPORTED` and `CLUSTER_ADDRESS_NOT_PUBLIC`. The epic's own
`AppPrecondition[]` codes (`plan.md:488-503`) are a third set — `spec_invalid`, `license_blocks_target`,
`license_attestation_missing`, `env_required_unset`, `dependency_not_ready`, `no_green_build`,
`no_green_build_for_head`, `build_image_missing`, `target_none`, `target_not_checked`,
`cluster_changed_unconfirmed`, `managed_disabled`, `managed_scope_unverified_blueprint`, `quota_exceeded`,
`managed_ineligible`, `managed_sandbox_unavailable`, `app_work_deleting`, `paused`, `deploy_in_progress`,
`cron_auth_env_unset`, `job_auth_env_unset`, `volume_replicas`, `volume_shrink`, `privileged_port`,
`cron_too_frequent`, `managed_root_forbidden`, `image_user_unverifiable`, `worker_not_isolated`,
`env_source_unavailable`, `pull_credential_unavailable` — plus the render warnings `limitrange_forbidden`,
`no_ingress_controller`, `ingress_controller_namespace_unknown`, `tls_disabled`, `hairpin_unreachable`,
`dns_record_pending`, `isolation_not_enforced`, `namespace_foreign`. **No epic maps one set onto another**, so
the same failure surfaces as `APPLY_FAILED` inside the plugin and `target_not_checked` in the UI.

### E-2. `scrubError` infers codes from message text

`errors.ts:86-103`: a non-`K8sPluginError` is classified by regex over its message —
`enotfound|econnrefused|etimedout` → `CLUSTER_UNREACHABLE`; `401|403|forbidden|unauthorized` → `UNAUTHORIZED`;
everything else → `UNKNOWN`. APW-06 must distinguish "cluster unreachable" from "credential rejected" from
"namespace belongs to another Work" to choose `cluster_unreachable` / `target_not_checked` /
`namespace_foreign`. Message-sniffing cannot, and every App-path failure would collapse into one of three
codes.

### E-3. `deploy()` both throws and swallows, depending on where the failure happens

`k8s.plugin.ts:720` opens the `try`; `:821-831` catches everything inside and returns
`{ status: 'error', error: scrubbed.message, … }`. Everything **before** the `try` (`:701-718` — visibility,
image base, pull credentials, ingress class resolution, host collection) propagates. APW-06's `deployApp`
contract is `Promise<AppDeployResult>` with `outcome: 'succeeded' | 'succeeded-with-warnings' | 'failed' |
'rolled-back' | 'cancelled' | 'rollback-failed'` (`plan.md:239`). Nothing states how an old-style
`status: 'error'` result on an App call is interpreted, nor whether `deployApp` may throw.

### E-4. Two connection-check shapes

`checkAppCluster` returns a permission checklist with per-verb results, ingress classes, controller namespace,
issuers and storage classes (`plan.md:679-684`; T13). `validateConnection`/`listIngressClasses`/`listNodes`
(`k8s-api.service.ts:216`, `:253`, `:287`) are a different, coarser shape used by the site path, and §6.2 says
their behaviour for non-App Works is "unchanged (additive rule)". Two shapes, one name ("check the cluster"),
and the completion precondition `target_not_checked` depends on the App one.

### E-5. `EW_VERIFY__PROMPTED` is a legal App env name and a reserved secret name

`APP_BUILD_VERIFY_PROMPTED_SECRET = 'EW_VERIFY__PROMPTED'` (`plan.md:440`) is reserved, and
`buildValueNameReserved` blocks a Build whose env name maps onto it (`plan.md:349`, `:774-775`). But APW-03's
`EnvName` pattern is `^[A-Z_][A-Z0-9_]{0,127}$` (`schema.md:22`) — which admits `EW_VERIFY__PROMPTED`, and
`EW_` is not a reserved prefix in the schema (only `EVER_WORKS_` is, and that is X-1). So a spec can declare
it, validate cleanly, and then block every Build with a code the schema has never heard of.

### E-6. `dispatchWorkflow` discards the run id, which is why correlation exists

`github-actions.service.ts:194-214` returns `Promise<void>` and drops the `workflow_run_id` the API answers.
APW-05 §2.3 must therefore adopt manual runs by scanning `workflow_dispatch` runs and matching
`display_title` inside a 5-minute window, with `APP_BUILD_ADOPT_WINDOW_MS = 300_000` and a `lost` class
(`plan.md:136-139`, `:415-416`). If the wrapper is ever changed to return the id, that entire mechanism (and
its failure class) is dead code — and APW-05 T12's `run-correlator.spec.ts` would have to change with it.
Not an error-code mismatch, but the same class of hidden coupling.

### E-7. Two Actions-hygiene mechanisms, one of which would disable the build workflow

`enableDeploymentWorkflows` (`github-actions.service.ts:151-192`) enables a workflow only when its **name** is
in `ACTIVE_WORKFLOW_NAMES` or its **path** is in `ACTIVE_WORKFLOW_FILES`
(`types.ts:46-51` — `.github/workflows/deploy_vercel.yaml`, `deploy_prod.yaml`, `deploy_k8s.yaml`), and
**disables** every other workflow via the `else` branch (`:178-180`). `ever-works-build.yml` is in neither
list, and APW-05 explicitly leaves `ACTIVE_WORKFLOW_FILES` untouched (Constitution X, `plan.md:1150-1152`).
APW-02 owns a different mechanism — `setActionsPermissions?` with `disableWorkflowsExcept` / `skipWorkflowIds`
(`CONTRACTS.md:282`; `APW-02 plan.md:784`) — and names `APP_BUILD_WORKFLOW_PATH` as its hygiene allowlist
(`APW-02 plan.md:92`). Nothing states which of the two runs, or what happens if both do.

### E-8. Render-time refusal introduced by a non-refusing precondition path

`volume_replicas`, `volume_shrink`, `privileged_port` and `cron_too_frequent` are "render-time checks"
(`plan.md:501`) surfaced as preconditions — but `validateRenderInput` returns them from a **pure** function
(T6, `tasks.md:113-114`), while the preconditions are evaluated service-side before rendering
(`plan.md:144-145`). A pure renderer that returns validation results _and_ renders is two behaviours in one
signature; nothing says whether it renders nothing, renders partially, or throws.

---

## F. Smaller collisions worth knowing

- **F-1.** `pullSecretNameFor(slug)` → `<slug>-pull` (`manifest.renderer.ts:302-304`) vs APW-06's fixed
  `app-pull` (`plan.md:296`). Two pull-secret conventions; if both ever render into one namespace the
  `imagePullSecrets` entry points at the wrong one.
- **F-2.** APW-06 §4.1's Job name limit is 45 characters and APW-03's `Name` is 1–32 (`schema.md:21`):
  `job-` (4) + 32 + `-` (1) + `deploymentShort` (8) = **45 exactly**. Zero headroom, and the manual-run form
  `run-<name>-<8 hex>` is 44. The cap is asserted only by T4's test.
- **F-3.** Non-deterministic fallbacks exist in the old path — `Date.now().toString(36).slice(0, 12)` for a
  missing sha (`k8s.plugin.ts:687`) and `t${Date.now().toString(36)}` for a missing revision (`:795`). Nothing
  like them may appear in the App renderer, and APW-06 §4 does not say so explicitly; `AppRenderInput` carries
  `deploymentShort` and `deploymentId` for exactly this reason.
- **F-4.** ACC-E2E-05 asserts the ordering "bootstrap Job `completionTime` and in-cluster smoke result both
  precede the Ingress `creationTimestamp`" (`ACCEPTANCE.md:340-341`). SSA **updates** an existing Ingress
  rather than recreating it, so the timestamps carry no ordering information on any Deployment after the
  first (a first-deploy Job does not run then either). The assertion is only meaningful on a first publish;
  the row does not say so.
- **F-5.** Web-surface prerequisites for the App Deploy tab are not renderer contradictions but gate this
  work: `apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx` redirects to Overview when
  `!work.websiteRepositoryInitialized && !work.website` (`APW-06 plan.md:51`), so an App Work would never see
  its Deploy tab; §10.1 requires the kind-`app` branch to come first (`plan.md:994-995`). And
  `WorkCapabilities.builds` / `.appEnvironment` (R-7, `CONTRACTS.md:50`) must exist before either tab renders.
- **F-6.** `isDeploymentPlugin` (`deployment.interface.ts:255-257`) gates on `capabilities.includes('deployment')`
  only. APW-06 selects "the deployment plugin with `supportsApps === true` for the Work's `deployProvider`
  that does **not** declare `apps-tier`" (`plan.md:129-132`) — a selection rule with no guard, no type and no
  test today, and `supportsApps` is declared **optional** (`plan.md:252`), so every third-party deployment
  plugin silently has `supportsApps === undefined`.
