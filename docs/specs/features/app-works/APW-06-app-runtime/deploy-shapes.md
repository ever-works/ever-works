# Deploy shapes — the full family, and what may never be narrowed

**Status:** reference · **Owner decision:** 2026-09-17 (B-01) · **Rule:** additive only — program Resolution **R-26**
(additive-only, top priority), mirrored as `AGENTS.md` NN #27 in the workspace repo. The deploy family itself is
Resolution **R-27**.

This file exists because the plan kept re-litigating "where does an App Work run?" and narrowing the answer each
time. The owner's correction was blunt and it is binding: **the platform has several deploy paths already, it may
gain more, and nothing here may be removed, weakened or marked obsolete.** Anything below marked **shipped** is in
the repository today; anything marked **extension point** is an addition the architecture already admits.

---

## 1. Why "one target" was the wrong frame

An App Work has **exactly one _chosen_ deploy target** (APW-06 FR-1) — that is a product rule and it stays. But the
_choices_ are not two, and the substrate underneath them is not one cluster. The platform already resolves a deploy
context from a **provider id + cluster source + credential** (`packages/agent/src/facades/deployment-context.resolver.ts:181-224`),
which is exactly the shape that admits more providers without touching the resolver.

Two shipped provider ids exist today:

| Provider id                                    | Resolved by                                                                                                                                                                                   | What it means                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `k8s` (`KUBERNETES_DEPLOY_PROVIDER_ID`)        | the `k8s` plugin — it declares `readonly capabilities = ['deployment']` (`packages/plugins/k8s/src/k8s.plugin.ts:302`)                                                                        | Apply desired state to a Kubernetes cluster the owner or the platform supplies |
| `ever-works` (`EVER_WORKS_DEPLOY_PROVIDER_ID`) | the same `k8s` plugin, through a platform-managed sentinel kubeconfig                                                                                                                         | The platform's own cluster, no owner credential involved                       |
| `vercel`                                       | the `vercel` plugin — `readonly category: PluginCategory = 'deployment'`, capabilities `['deployment']` or `['deployment','oauth']` (`packages/plugins/vercel/src/vercel.plugin.ts:61,72-73`) | Vercel, driven through the Vercel API and a workflow dispatch                  |

`DEPLOYMENT: 'deployment'` is a **first-class plugin capability** (`packages/plugin/src/contracts/facade-capabilities.ts:11`),
so a further provider is a plugin, not a change to the runtime.

---

## 2. The shapes

### A · Ever Works shared customer cluster — **shipped**

`ClusterSource` value `k8s-works-shared`, label _"Ever Works shared customer cluster"_
(`apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.ts:43,51`). Every tenant gets its own namespace;
the platform holds no owner credential. This is what managed Works use today, and it is the default shape for the
**Ever Works Apps** target and one of the shapes the Apps tier extends.

### B · Ever Works internal cluster — **shipped, admin-only**

`k8s-works`, label _"Ever Works internal cluster (admin only)"_, offered only to a platform admin and only when the
repository lives in the `ever-works` org (`cluster-source-matrix.ts:40-42,52,58-59`). **Kept as an option.** It is
never a customer's target and nothing in this plan may remove it from the matrix.

### C · Bring your own cluster — **shipped**

`custom-kubeconfig`, label _"Custom — paste your own kubeconfig"_ (`cluster-source-matrix.ts:45,53,60`). The CLI
rules are strict and **stay** as written: `https` only, every resolved address public, validated address reused
without re-resolution, redirects not followed, and a kubeconfig refused up front when it shells out for
credentials, names a local file, uses a proxy, disables verification or lacks inline CA data
(`APW-06/spec.md` FR-3, FR-4). Self-hosted installations may allow specific address ranges explicitly
(`EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`).

### D · A cluster reached through a kubeconfig the operator supplies for the installation — **shipped**

The same `custom-kubeconfig` path with an installation-level credential, and `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`
requiring the connection to be made by an isolated worker (`APW-06/spec.md` FR-5). Not a separate target; a
**deployment posture** — and it stays available for any provider that needs an isolated connector.

### E · Ever Works Apps — the managed, gated tier — **planned (APW-10)**

`ever-works-apps`, offered only while APW-10's gate is open for this installation and the owner is eligible
(`APW-06/spec.md` FR-7). On this target the platform never applies workloads itself: it renders desired state and
hands it to the tier. The tier runs **on shape A** as a namespace-isolated zone, and — per the owner's answer — may
equally be served by shapes C, F or G for a given tenant. `EVER_WORKS_APPS_MANAGED_ENABLED` gates it; the gate board's
LG-01…LG-24 items gain a **per-shape attestation** rather than a deletion (see §3).

### F · A machine the owner connects to Ever Works — **substrate shipped, App-Work deploy path is an extension point**

The Fleet already enrolls a real machine as a first-class node: `FleetNodeKind = 'desktop-node' | 'node' | 'k8s'`,
an enrollable subset (`FLEET_ENROLLABLE_NODE_KINDS`), a `FleetEnrollRequest` carrying the node's self-description, an
enrollment token with a 15-minute default TTL, credential rotation and a node-offline policy
(`packages/contracts/src/fleet/fleet-node.types.ts:45-51,432-446,558,615-630`). The node connects **outbound** —
nothing needs to reach _in_ — which is exactly what a customer behind NAT or a home-lab install needs.

What is **not** built: a deploy executor that takes an app's rendered desired state and runs it on an enrolled node.
That is an **addition**, and the honest way to record it is as a new deploy shape with its own provider id, not as a
claim that it works today. When it is built it must not change shapes A–E.

### G · A remote host over SSH — **extension point**

The owner names SSH among the ways the platform should be able to reach "separate hosts / nodes". There is **no SSH
deploy provider in the repository today** (checked: no `ssh` capability, no SSH deployment plugin). It is therefore
recorded as an extension point with its own provider id and its own threat model — credentials held like every other
secret (Constitution VII), the connection made by the isolated worker (shape D's posture), and the same
no-platform-credentials rule as LG-11. Building it is additive; declining to build it in Wave 1 does **not** delete
the shape from this document.

### H · Other providers as plugins — **extension point, capability already exists**

Anything that can receive rendered desired state can be a `deployment` provider: the capability is already generic
(`facade-capabilities.ts:11`), two plugins implement it (`k8s`, `vercel`), and the resolver already branches on the
provider id without knowing the provider. A future provider (a PaaS, a serverless platform, a bare-metal provisioner)
is a plugin plus a target entry — never a rewrite.

---

## 3. What this means for the gate (APW-10)

LG-01, LG-03, LG-16 and D15 asserted _separate hosts / network / egress identity_ — written when the tier was imagined
as rented, dedicated capacity. The owner's answer does not delete those items; each gains a **per-shape attestation**:

| Shape the tenant runs on                           | What the operator attests                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (shared customer cluster)                        | namespace + ResourceQuota + LimitRange + NetworkPolicy default-deny + a dedicated egress identity + a distinct ingress for the tier's zone; plus everything LG-04/LG-10/LG-11/LG-12 already demand |
| C/F/G (customer cluster, connected node, SSH host) | the same _properties_, attested for **that** host — the tier does not weaken them just because the hardware is the customer's                                                                      |
| B (internal cluster)                               | not a customer target; kept for the platform's own use                                                                                                                                             |
| E's own zone                                       | everything LG-01…LG-24 as written, unmodified                                                                                                                                                      |

**Nothing is marked "not applicable".** An item the tier genuinely cannot satisfy on a shape is recorded as
**`Failed` with the reason**, which is what the gate board already does — not silently skipped.

---

## 4. Verification

- **ACC-06-50** (added with this file) — the deploy-target picker offers **None**, **Your cluster** and **Ever Works
  Apps**, each with a stated reason when unavailable; no shape is offered that the installation cannot serve, and no
  shipped shape is removed from `allowedClusterSourcesFor` by an app-kind change.
- **ACC-06-51** — an app-kind deploy through `custom-kubeconfig` and through `k8s-works-shared` both succeed on the
  same fixture, proving the target is a configuration of one runtime rather than a fork of it.
- The existing ACC-06-49 (tier desired state), ACC-06-01…ACC-06-48 and ACC-13-20 are unchanged.

---

## 5. Rules that hold for every shape

1. **No new shape may narrow an existing one.** Adding F, G or H never changes what A–E accept.
2. **Credentials live where they live now.** Generated or supplied values are encrypted per App Work, never returned
   by any endpoint, never logged (Constitution VII; ACC-NEG-12).
3. **The isolated worker makes the connection.** Any shape that dials outward does it from the background worker, not
   from web or API (FR-5).
4. **Deletion is unchanged** (R-15): removing an App Work removes what it runs on its target, keeps data unless the
   owner explicitly asks, and never touches the upstream.
5. **The upstream is never pushed to** (D12), whatever the shape.

---

## 6. Open items this file records rather than resolves

- **A concrete enrolled-node deploy executor (F)** — needs a provider id, an executor contract and an acceptance id.
  Not in Wave 1; recorded so it is not lost.
- **An SSH deploy provider (G)** — needs a credential model and a threat model. Recorded, not deleted.
- **Whether the tier is _offered_ on F/G in Wave 2 or Wave 3** — APW-10 `FR-33`/`FR-35` keep the offering rules; the
  owner's answer says the shapes exist, not that all of them are launch-ready. Gate attestation, not a new decision.
