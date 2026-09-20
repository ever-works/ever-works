# Ever Works Apps — hosting-tier controller

The process that runs **inside a hosting zone** (a Kubernetes cluster that hosts customers' App
Works) and turns `hosting.ever.works` objects into real tenant workloads. It is the zone's side of
the Ever Works Apps hosting tier — **APW-10**.

> ### ⚠️ Current state: a skeleton that refuses to start, on purpose
>
> The CRD contract is complete and installed ([`packages/apps-tier-crds`](../../packages/apps-tier-crds/)).
> **No reconciler exists yet**, so [`src/reconcile/index.ts`](src/reconcile/index.ts) is an empty
> registry and the bootstrap exits `78` (`EX_CONFIG`) with `NO_RECONCILERS_REGISTERED`.
>
> That refusal is the feature. A controller Pod that reports healthy while reconciling nothing is
> the most dangerous state this component can be in: the platform goes on writing `Work` objects and
> reading a `status` that never arrives, every tenant sits in `Pending`, and the zone looks fine.
> When [T6](#7-roadmap) lands, `bootstrap.spec.ts`'s first test goes red — that is the signal to
> update it, not to delete it.

---

## 1. The question this component answers

From the APW-10 spec, quoting the owner:

> _“Before a stranger's app runs next to our production products — how do we **prove** it cannot
> hurt them, and how do we stop it within a minute if it tries?”_

Everything below follows from that sentence. A customer points Ever Works at any GitHub repository;
we fork it, build it and run it. The code is unreviewed, the customer's AI agent keeps changing it,
and in our fleet it would land on the same hardware as Ever Gauzy production. So the hosting tier is
not “deploy, but multi-tenant” — it is a **containment design**, and this controller is its enforcer.

## 2. Why a separate process, and not a plugin

The platform side of the hosting tier **is already a plugin**: capability `apps-tier`,
`IAppsTierProvider`, `PLUGIN_CAPABILITIES.APPS_TIER`
([`packages/plugin/src/contracts/capabilities/apps-tier.interface.ts`](../../packages/plugin/src/contracts/capabilities/apps-tier.interface.ts)),
with the control client landing as the `ever-works-apps` plugin in T12.

That plugin is the **client**. This controller is the **server**, and the whole point is that they
are in different trust domains:

```
   platform cluster                              hosting zone (may be a customer's cluster)
 ┌──────────────────────────┐                  ┌─────────────────────────────────────────────┐
 │ apps/api                 │                  │  control ns: ever-works-apps-control        │
 │  └─ ever-works-apps      │  writes Work ──► │   Work / AppBuild / UsageReport /           │
 │     plugin (apps-tier)   │  reads status ◄─ │   SelfCheck / AbuseSignal                   │
 │                          │                  │        │                                    │
 │  holds NO zone           │                  │        ▼  reconciled by                     │
 │  cluster-admin           │                  │   apps-tier-controller (this app)           │
 └──────────────────────────┘                  │        │                                    │
                                               │        ▼ tenant ns: ewa-<workId>            │
            both ends import the SAME schema   │   Deployment / Service / Ingress / Jobs …   │
            @ever-works/apps-tier-crds  ───────┤   NetworkPolicy / ResourceQuota / LimitRange│
                                               └─────────────────────────────────────────────┘
```

Plugins load **inside the Ever Works API process**. If the controller were a plugin, the API would
need cluster-admin on a cluster full of strangers' code — which is precisely the privilege this
design exists to avoid. Compromise the API and you get an intent object, not a cluster.

Two consequences worth internalising:

- **The platform cannot see tenant secrets.** The controller publishes a sealing public key in
  `ever-works-apps-controller-public-key`; the platform seals a Work's environment to it, bound to
  that Work by AAD (`hosting.ever.works/v1alpha1`, ≤ 256 KiB). Only the controller can unseal it —
  not the platform database, not etcd readers, not an operator with `kubectl get work -o yaml`.
- **The controller must never be able to grant itself anything.** No `clusterroles`, no
  `customresourcedefinitions`, and no `delete` on namespaces or on `hosting.ever.works` objects. See
  [`deploy/README.md §3`](deploy/README.md).

## 3. Layout: why this is two packages

|                                                             |                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/apps-tier-crds`](../../packages/apps-tier-crds/) | **the API contract.** The five CRD schemas as code + the generator that renders `deploy/crds/*.yaml`. A library, because _both_ ends import it and neither may fork the schema. Pure schema: no cluster, no kubeconfig, no clock, no network. |
| `apps/apps-tier-controller` (here)                          | **the process.** Config, bootstrap, reconcilers, probe entrypoint. Ships as one executable bundle; nothing imports it, Kubernetes starts it.                                                                                                  |

> **Provenance (owner ruling, 2026-09-20).** All of this originally shipped as a single
> `apps/apps-tier-controller` holding only CRD types. It was split because `apps/*` in this monorepo
> means _“a thing that starts a process”_ — every other entry has a `start` script or a `bin`, and
> that one had neither, while declaring `main`/`module`/`types`/`exports` and building dual CJS+ESM
> with `.d.ts`, i.e. a library. The schema half moved to `packages/`; this half keeps the name,
> so `pnpm --filter ever-works-apps-tier-controller …` still refers to the process.

## 4. The five objects

All in `hosting.ever.works/v1alpha1`, all in the control namespace, all **closed schemas** — an
unknown field is refused rather than ignored (`ACC-10-26`).

| Kind          | Written by     | Carries                                                                                                                                                                                                              |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Work`        | platform       | one App Work's desired state: images (digest-pinned), components (`web` \| `worker`), hosts, sealed env, quotas, `desiredState` ∈ `running` \| `paused` \| `quarantined` \| `removed`. Named `w-<workId>`, ≤ 512 KiB |
| `AppBuild`    | platform       | one build of that Work, with its signature state                                                                                                                                                                     |
| `UsageReport` | **controller** | metering the platform imports for billing                                                                                                                                                                            |
| `SelfCheck`   | platform       | a request for the zone to prove its own isolation still holds; the controller writes the verdict                                                                                                                     |
| `AbuseSignal` | **controller** | `runtime` \| `mining` \| `mail` \| `bandwidth` \| `report` — the trigger for the quarantine sequencer                                                                                                                |

`Work.status.phase` walks `Pending → Promoting → Provisioning → Ready`, with `Degraded`, `Paused`,
`Quarantined`, `Refused`, `Failed` and `Removed` as terminal or held states. Inside `Provisioning`,
`status.deployPhase` sequences `prepare → pre-deploy-jobs → rollout → first-deploy-jobs →
in-cluster-smoke → publish → public-smoke → post-deploy-jobs → cron → done`.

## 5. How it will be used, end to end

1. A customer creates an App Work from a repository URL and picks **Ever Works hosting** as the
   deployment target. The platform's launch gate must be open for the tier (APW-10 T1).
2. The build produces a digest-pinned image; the platform seals the Work's environment to the zone's
   public key and **writes one `Work` object** into the control namespace. That write is the whole
   platform→zone API: no `kubectl`, no kubeconfig, no shell.
3. This controller's `Work` reconciler (T6) claims it — leader-elected, one active replica —
   creates the tenant namespace `ewa-<workId>` from the tenant template (T4: NetworkPolicy,
   ResourceQuota, LimitRange, ServiceAccount, pod overlays), unseals the env (T5), renders the
   workloads and walks the deploy phases, writing `status` as it goes.
4. The platform polls `status` through the plugin and turns it into the Work's Activity feed — so
   the customer sees the same timeline they see for every other Work.
5. The controller emits `UsageReport`s; the platform imports them for billing.
6. If the app misbehaves, the controller raises an `AbuseSignal` and the quarantine sequencer (T7)
   cuts it off inside the drill's time budget — that is the “stop it within a minute” half of the
   owner's question, and T22's drill is what proves it.
7. `desiredState: removed` releases the workload **without deleting tenant data** (FR-28, T39).

## 6. What exists today

| File                                               | Lines | State                                                                                                                                                                                                      |
| -------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/config.ts`](src/config.ts)                   | 170   | **real.** The startup contract: 5 refusal codes, collected all at once, fail-closed. Env names come from `@ever-works/contracts`, never re-spelled                                                         |
| [`src/reconciler.port.ts`](src/reconciler.port.ts) | 90    | **real.** The seam every reconciler implements + `validateRegistry`, which refuses an empty registry, a duplicate name, or a kind no installed CRD defines (derived from `CRD_MANIFESTS`, never re-listed) |
| [`src/bootstrap.ts`](src/bootstrap.ts)             | 108   | **real.** Startup as a function so it is testable: validate, start in order, roll back on a failed start, reverse-order idempotent shutdown                                                                |
| [`src/main.ts`](src/main.ts)                       | 50    | **real.** The only file that touches `process.env`, signals and the exit code                                                                                                                              |
| [`src/reconcile/index.ts`](src/reconcile/index.ts) | 28    | **empty registry** + the table of the five planned loops                                                                                                                                                   |
| `src/__tests__/`                                   | 338   | **46 behavioural tests**, all green. No type pins, no “the constant exists” assertions                                                                                                                     |
| [`deploy/README.md`](deploy/README.md)             | —     | the image/RBAC/probe specification T10 must satisfy. **No manifests committed** — an untested RBAC YAML that looks authoritative is worse than none                                                        |

```bash
pnpm --filter ever-works-apps-tier-controller test         # 46 tests, hermetic
pnpm --filter ever-works-apps-tier-controller type-check
pnpm --filter ever-works-apps-tier-controller build        # single ESM bundle + shebang
pnpm --filter ever-works-apps-tier-controller start        # exits 78: NO_RECONCILERS_REGISTERED
```

### Verified on 2026-09-20

```
type-check   tsc --noEmit && tsc -p tsconfig.specs.json --noEmit   → exit 0
test         2 files, 46 tests                                     → exit 0
build        tsup → dist/main.js 7.42 KB (single ESM bundle)        → exit 0
run          MANAGED_ENABLED=1 ZONE_ID=eu-hel-1 node dist/main.js   → exit 78
             {"level":"error","message":"refused to start: NO_RECONCILERS_REGISTERED",…}
run          (no env at all)                                        → exit 78, THREE refusals logged
```

**One trap this skeleton already paid for:** `tsc --noEmit` accepted a top-level `await` in
`main.ts` (it is legal under `module: ESNext`) and the bundler then refused it — esbuild targets
`es2021`. A green `type-check` would have shipped a package that cannot build. The work now sits
inside an `async main()`, and the rule generalises: **in this package, `type-check` is not the
build gate — run `build` too.**

## 7. Roadmap

Tasks are from [`docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md`](../../docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md).

| Task    | Lands as                                                | Notes                                                                                                                                                                                   |
| ------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~T3~~  | `packages/apps-tier-crds`                               | ✅ done — CRDs + drift gate (47 tests)                                                                                                                                                  |
| **T4**  | `src/tenant/tenant-template.ts`                         | the tenancy objects. **Only** T4 may emit Namespace / ServiceAccount / LimitRange / ResourceQuota / NetworkPolicy; the APW-06 renderer's copies are discarded (APW10-G03)               |
| **T5**  | `src/seal/`, `src/validate/`                            | unsealing, fingerprints, closed-schema validation                                                                                                                                       |
| **T6**  | `src/reconcile/work.reconciler.ts`                      | the phase machine, heartbeat, leader election. Also `src/render/work-to-render-input.ts` — `Work.spec` → APW-06 `AppRenderInput`, with a golden round-trip against T26's forward mapper |
| **T7**  | `src/reconcile/quarantine.sequencer.ts`                 | the timed cut-off; proven by the `apw10-quarantine-drill`                                                                                                                               |
| **T8**  | `src/probe/`                                            | the probe entrypoint: ≤ 4 KiB JSON to the termination message, and it must **never print a target address**                                                                             |
| **T9**  | `src/reconcile/selfcheck.reconciler.ts`                 | the zone proving its own isolation; `apw10-weakened-zone-drill`                                                                                                                         |
| **T10** | `.deploy/docker/apps-tier-controller/`, `deploy/*.yaml` | see [`deploy/README.md`](deploy/README.md)                                                                                                                                              |
| **T11** | `test/integration/*.int.spec.ts`                        | kind cluster; config already present as `vitest.integration.config.ts`                                                                                                                  |
| **T12** | `packages/plugins/ever-works-apps`                      | the platform-side control client + sealing                                                                                                                                              |
| **T39** | `src/reconcile/removal.reconciler.ts`                   | release without data deletion                                                                                                                                                           |
| **T43** | `src/reconcile/dependency.reconciler.ts`                | per-Work Postgres / Redis / bucket and their release                                                                                                                                    |

## 8. Rules this component keeps

1. **Fail closed, always.** Unknown config is a refusal, not a default. An unparseable version does
   not satisfy a minimum. An empty registry does not start.
2. **Readiness means “every watch is established”**, never a TCP check. The failure mode here is
   _running and watching nothing_, and a socket probe reports that as healthy. APW-10's own build
   hit the equivalent trap twice (a green Pod serving a bundle that predated the fix).
3. **No `delete` verbs** on namespaces or on `hosting.ever.works` objects. Removal is a
   `desiredState` transition through an audited path.
4. **One schema, imported by both ends.** If you find yourself re-declaring a CRD field, stop.
5. **Derive lists, never re-type them.** `WATCHABLE_KINDS` comes from `CRD_MANIFESTS`; env names come
   from `@ever-works/contracts`. A hand-listed set documents what the author thought of.
6. **Hermetic unit tests.** No kubeconfig, cluster, clock or network under `src/**`. The cluster
   lives in the kind lane.

## 9. Open questions

- **Is a zone ever GitOps-managed?** Platform clusters are ArgoCD-managed from `ever-co/k8s-gitops`;
  a customer's zone cannot be. T10 must say which install path applies where.
- **Where do zone manifests live** — here, or `.deploy/k8s/`? The repo convention points at
  `.deploy/`, but these are applied to a _foreign_ cluster, which is a different lifecycle.
- **Multi-zone.** `zoneId` is per-process; nothing yet says how the platform picks a zone, or what
  happens when two controllers claim the same one. Leader election (T6) covers one zone, not two.
- **Does this block the near-term product?** **No, and it must not.** Running a forked repo on our
  shared cluster _or_ on a customer's own kubeconfig already works today through the existing
  `KubernetesPlugin` server-side deploy (`clusterSource: k8s-works-shared` | `custom-kubeconfig`).
  This controller is what makes that **safe at multi-tenant scale and billable** — it is the
  hosting-_tier_ product, not the path to a first demo.
