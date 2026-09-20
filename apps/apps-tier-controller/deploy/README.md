# Deploying the hosting-tier controller

**Nothing here is committed yet, deliberately.** APW-10 **T10 (“Image, manifests and CI”)** owns this
directory, and an untested Dockerfile or RBAC manifest that _looks_ authoritative is worse than an
empty folder — somebody will apply it. What follows is the specification T10 has to satisfy, so the
thinking is not lost between now and then.

> The CRDs are **not** here. They are generated artefacts of
> [`packages/apps-tier-crds`](../../../packages/apps-tier-crds/deploy/crds/) and are installed into
> the zone before this controller starts.

## 1. Where the image build belongs

This repo builds images from **`.deploy/docker/<app>/Dockerfile`**, not from the app folder — see
`.deploy/docker/{api,web,node,mcp,docs}/`. So the controller's image belongs at
**`.deploy/docker/apps-tier-controller/Dockerfile`**, and should be derived from
[`.deploy/docker/node/Dockerfile`](../../../.deploy/docker/node/Dockerfile), which is the closest
analogue (a long-running worker rather than an HTTP server). Reuse from it:

- `turbo prune --scope=ever-works-apps-tier-controller --docker` for the pruned workspace,
- the `VERDACCIO_REGISTRY` probe-with-fallback layer, verbatim — a Verdaccio outage must not fail
  an image build (see that file's own rationale),
- `node:22-bookworm-slim`. There is no Chromium here, so `alpine` would be defensible — but
  matching the fleet's base image is worth more than the megabytes.

Differences from `node`:

- **entrypoint** `node dist/main.js` (the bundle carries its own shebang, so
  `ever-works-apps-tier-controller` works too),
- **run as non-root**, read-only root filesystem, all capabilities dropped, `seccomp: RuntimeDefault`.
  The controller is the most privileged thing in the zone; it should be the least privileged
  _process_ in it.

## 2. Zone-side manifests this directory must gain

| File                       | What it carries                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `namespace.yaml`           | the control namespace — `ever-works-apps-control` (`APPS_TIER_CONTROL_NAMESPACE_DEFAULT`)                                         |
| `serviceaccount.yaml`      | the controller's identity                                                                                                         |
| `clusterrole.yaml`         | **the security boundary** — see §3                                                                                                |
| `clusterrolebinding.yaml`  | binds the above to the service account                                                                                            |
| `deployment.yaml`          | 2 replicas, leader election (T6), the env of §4, probes of §5                                                                     |
| `configmap-zone-info.yaml` | `ever-works-apps-zone-info` (`APPS_TIER_ZONE_INFO_CONFIG_MAP`) — the zone's identity and controller version, read by the platform |
| `poddisruptionbudget.yaml` | `minAvailable: 1`, so a node drain cannot leave the zone unreconciled                                                             |

They are **not** ArgoCD-managed from `ever-co/k8s-gitops` by default: the zone may be a customer's
cluster. T10 must state which zones are GitOps-managed and which are installed by an operator, and
the installer must be idempotent either way.

## 3. RBAC — write this list before writing the YAML

The controller needs, **namespaced to the control namespace**:

- `hosting.ever.works`: `works`, `appbuilds`, `usagereports`, `selfchecks`, `abusesignals` —
  `get,list,watch,update,patch` plus `*/status` `update,patch`. **Not `delete`**: removal is a
  `desiredState` transition (FR-28), and the controller must not be able to erase the platform's
  record of a tenant.

And **cluster-scoped**, because tenants get their own namespaces:

- `namespaces`: `get,list,watch,create,patch` — _not_ `delete`. Namespace deletion is the one verb
  that can destroy tenant data by accident; it belongs to a separate, audited removal path (T39).
- `deployments`, `services`, `ingresses`, `jobs`, `cronjobs`, `persistentvolumeclaims`,
  `secrets`, `configmaps`, `networkpolicies`, `resourcequotas`, `limitranges` — the tenant
  workload set, restricted by a `resourceNames` prefix or an admission policy where the API
  supports it.
- `pods`, `pods/log`, `events`: `get,list,watch` for status and for T7's quarantine evidence.

**Explicitly refuse:** `clusterroles`, `clusterrolebindings`, `customresourcedefinitions`,
`nodes`, `persistentvolumes`, and anything in `hosting.ever.works` outside the control namespace. A
controller that can grant itself permissions is not a boundary. Assert this with a spec over the
generated YAML — a deny-list only holds if something checks it.

## 4. Environment

| Variable                                 | Required | Notes                                                                                                          |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_APPS_MANAGED_ENABLED`        | yes      | must be exactly `1`; anything else refuses to start                                                            |
| `EVER_WORKS_APPS_ZONE_ID`                | yes      | DNS label, ≤ 32 chars; scopes every object the controller claims                                               |
| `EVER_WORKS_APPS_CONTROL_NAMESPACE`      | no       | defaults to `ever-works-apps-control`                                                                          |
| `EVER_WORKS_APPS_CONTROLLER_MIN_VERSION` | no       | the platform's floor; the controller refuses to run below it                                                   |
| `EVER_WORKS_APPS_CONTROL_KUBECONFIG`     | no       | a path, for the local kind lane only. **Never set in a zone** — in-cluster credentials are the production path |

Every one of these is parsed in [`src/config.ts`](../src/config.ts) and each refusal has a test.

## 5. Probes

- **liveness** — the process is up. Trivial, and nearly useless on its own.
- **readiness** — _every_ registered reconciler has an established watch. Readiness must **not** be
  a TCP check: the failure this component actually has is "running, watching nothing", and a
  socket-level probe reports that as healthy. This is the exact trap the platform hit twice during
  APW-10's build (a Pod healthy on a bundle that predated the fix).
- **heartbeat** — the controller writes a timestamp the platform reads; `APPS_TIER_HEARTBEAT_STALE_MS`
  (6 h) is the staleness ceiling. That is the platform's detector for a zone that went quiet, and it
  is separate from the two probes above because a probe can only observe the process, never the link.
