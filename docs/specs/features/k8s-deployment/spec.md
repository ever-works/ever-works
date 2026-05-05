# Feature Specification: Kubernetes Deployment Plugin

> Behaviour-first spec per [Constitution Principle IX](../../../specs/memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Implementation lives in [`./plan.md`](./plan.md).

**Feature ID**: `k8s-deployment`
**Branch**: `feat/k8s-deployment`
**Status**: `Draft`
**Created**: 2026-05-05
**Last updated**: 2026-05-05
**Owner**: Ever Works Team

---

## 1. Overview

The Kubernetes (k8s) Deployment Plugin lets users deploy a generated work as a containerised website to any Kubernetes cluster they control, as an alternative to the existing Vercel deployment provider. Users paste a `kubeconfig` file in the deployment-plugins UI, pick a container registry (defaulting to **GitHub Container Registry** because the platform already has access to the user's GitHub account), and from then on can publish a work to their cluster from the same "Deploy" surface that already drives Vercel. The plugin appears under **Deployment** in the Plugins page, exposes the same domain/status/connection-validation behaviours as Vercel, and is selectable per-work either through the dashboard or by declaring `deployProvider: k8s` in the work's `works.yml`. Configuration also covers ingress controller detection (nginx, Traefik, and an extensible strategy registry for additional controllers over time).

Two adjacent changes ship as part of this feature so the new plugin doesn't land on a half-paved road:

1. **Pluggable registry abstraction** — the plugin defines a small `RegistryProvider` strategy with a `github` (GHCR) default and a `generic` fallback; new registry kinds can be added without touching the plugin core.
2. **`deployProvider` in `works.yml`** — the works-config layer learns about `deployProvider` so a work's data repo can declare its target. The same change also applies to Vercel (any `deployProvider: <id>` recognised by the deploy facade is accepted).

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I am signed in and visit `/en/settings/plugins/deployment`, **when** the page loads, **then** I see both **Vercel** and **Kubernetes** as available deployment providers, with the Kubernetes card showing a "Not configured" state.
- **Given** I open the Kubernetes plugin settings, **when** I paste a valid `kubeconfig` YAML and click **Save & verify**, **then** the platform validates the kubeconfig against the cluster API, marks the plugin as configured, and shows the cluster name, server URL, Kubernetes server version, **and the ingress controllers it detected** (e.g. "nginx, traefik").
- **Given** I am configuring the Kubernetes plugin, **when** I do not change the **Registry** field, **then** the registry defaults to **GitHub Container Registry** (`ghcr.io/<my-github-owner>`) because the platform already holds my GitHub credentials, and the cluster pull secret is provisioned automatically.
- **Given** I have a configured Kubernetes plugin, **when** I open `/en/plugins`, **then** the **Kubernetes** entry appears under **Deployment** with status "Configured" and a working **Settings** link.
- **Given** my work is set to `deployProvider = 'k8s'` (either via the dashboard or in `works.yml`), **when** I deploy it, **then** the platform builds a container image of the website, pushes it to the configured registry (GHCR by default), applies a Deployment, Service and (optional) Ingress to the configured namespace, and reports the resulting URL back through the standard deploy facade.
- **Given** my work's `works.yml` declares `deployProvider: k8s`, **when** I import or sync the work, **then** the platform sets `work.deployProvider = 'k8s'` accordingly. The same behaviour applies to `deployProvider: vercel` and to any future provider IDs registered through the deploy capability.
- **Given** my work is already deployed to Kubernetes, **when** I redeploy, **then** the platform applies an updated image tag with `kubectl rollout` semantics so the previous version is replaced without downtime, and the deploy facade reports `ready` once the rollout succeeds.
- **Given** my work has a custom domain (`tools.example.com`), **when** I add it via the **Settings → Domains** UI on a Kubernetes-deployed work, **then** the plugin patches the work's Ingress with the new host, returns DNS guidance (CNAME / A record to the cluster's load-balancer ingress), and lets me trigger verification.

### 2.2 Edge cases & failures

- **Given** I paste a malformed kubeconfig (invalid YAML or missing `clusters`/`users`/`contexts`), **when** I click **Save & verify**, **then** the connection result is `success: false` with a specific message ("kubeconfig YAML is invalid" or "kubeconfig is missing a current-context") and nothing is persisted server-side that names the broken config.
- **Given** my kubeconfig is valid YAML but the cluster API is unreachable (DNS, firewall, expired client cert), **when** verification runs, **then** the plugin returns `success: false` with the underlying error class (`ENOTFOUND`, `403 Forbidden`, `x509: certificate expired`) — never a stack trace.
- **Given** I deploy to a namespace I cannot create/patch in, **when** the workflow applies manifests, **then** the deploy facade transitions the deployment to `error` with the `kubectl` error surfaced verbatim (truncated, no secrets).
- **Given** my registry credentials are wrong, **when** the build pushes the image, **then** the deploy run ends with `error` before any cluster mutation happens, and the work's previous deployment continues to serve traffic.
- **Given** I switch a work from Vercel to Kubernetes, **when** I redeploy, **then** custom-domain rows in the database persist (per `custom-domains` spec FR-8) and are re-synced to the Kubernetes ingress instead of Vercel.
- **Given** my cluster does not have an ingress controller, **when** I deploy without configuring an ingress host, **then** the work is exposed via a `Service` of type `LoadBalancer` (or `ClusterIP` + port-forward note in the deployment result) and the deployment is still marked `ready` once the pod is healthy.
- **Given** my cluster has multiple ingress controllers (e.g. nginx and Traefik), **when** validation runs, **then** the UI lists every detected controller and lets me pick which one this work's Ingress should use; if I never pick, the platform uses the cluster's default IngressClass.
- **Given** an `IngressClass` exists for a controller the plugin doesn't have a strategy for, **when** validation runs, **then** that class still appears in the dropdown labelled with the underlying controller name; the plugin falls back to a "generic" strategy that emits a vanilla `Ingress` and skips controller-specific annotations.
- **Given** I delete my kubeconfig from the plugin settings, **when** I save the empty form, **then** the plugin transitions to "Not configured", existing in-cluster workloads are untouched, and any work whose `deployProvider = 'k8s'` cannot deploy until a new kubeconfig is provided.
- **Given** my GitHub account is not connected, **when** I select **GitHub Container Registry** as the registry kind, **then** the UI tells me to connect GitHub first and links me to the GitHub plugin's auth flow; selecting a different registry kind (Docker Hub, generic) bypasses this requirement.
- **Given** my `works.yml` declares `deployProvider: someUnknownId`, **when** the platform syncs the file, **then** the import surfaces a validation error pointing at the unknown id, the work's `deployProvider` is left unchanged, and a clear message tells the user which provider IDs are available.

## 3. Functional Requirements

- **FR-1** The system MUST register a deployment plugin with `id = 'k8s'`, `name = 'Kubernetes'`, `category = 'deployment'`, `capabilities = ['deployment']`, discoverable via the existing capability-based plugin facade with no hardcoded references in API or web code.
- **FR-2** The plugin MUST expose a settings schema with at minimum: `kubeconfig` (secret, user-scoped, `x-widget: textarea`), `namespace`, `registry` (a discriminated object — see FR-13), and OPTIONAL `kubeContext`, `ingressClass`, `ingressHost`, `tlsIssuer`, `replicas`.
- **FR-3** Saving plugin settings MUST run `validateConnection()` against the cluster (a benign read such as `getServerVersion`) and reject save when the cluster cannot be reached or rejects the credentials.
- **FR-4** The Kubernetes plugin MUST appear automatically alongside Vercel on `/en/settings/plugins/deployment` and on `/en/plugins` under Deployment, with no plugin-id hardcoded in the web app.
- **FR-5** The platform MUST support `work.deployProvider = 'k8s'` end-to-end: the Deploy facade resolves the plugin, the deploy controller orchestrates the workflow, and the deploy verifier polls cluster state.
- **FR-6** Deploying a work MUST (a) build a container image of the website, (b) push it to the configured registry with a deterministic tag (work-id + git SHA), (c) apply a `Deployment` with the new image, a `Service`, and (when `ingressHost` is set) an `Ingress` to the configured namespace, and (d) wait for `kubectl rollout status` before reporting `ready`.
- **FR-7** Redeploys MUST be a rolling update of the existing `Deployment` (not a delete-and-recreate); previous ReplicaSets MUST remain in the rollout history so users can `kubectl rollout undo` out-of-band.
- **FR-8** The plugin MUST implement `addDomain`, `removeDomain`, `verifyDomain` against the work's Ingress, returning provider DNS guidance compatible with the `custom-domains` feature.
- **FR-9** The plugin MUST surface deployment status via `getDeploymentStatus(deploymentId, token)` derived from the Deployment's rollout state (`available` → `ready`, `progressing` → `building`/`deploying`, `failed` → `error`).
- **FR-10** All cluster credentials and registry passwords MUST be stored via the existing `x-secret` plugin-settings store and MUST NOT appear in logs, activity-log entries, or API responses.
- **FR-11** The plugin MUST NOT be `defaultForCapabilities: ['deployment']` (Vercel keeps that role); selecting Kubernetes is an explicit per-work choice.
- **FR-12** `validateConnection()` MUST return cluster name, server URL, and server version on success so the UI can show "Connected to cluster `prod-eu` (v1.30.4) at `https://api.prod-eu.example.com`".
- **FR-13** The plugin MUST support a pluggable registry abstraction with at least three built-in kinds for v1: `github` (GHCR, default — auto-configured from the user's connected GitHub account), `dockerhub` (username + PAT), and `generic` (server URL + username + password). New registry kinds MUST be addable by registering a strategy without modifying the plugin's deploy/apply code.
- **FR-14** When the registry kind is `github`, the system MUST reuse the user's existing GitHub OAuth or PAT (already stored by the GitHub plugin) to authenticate `docker push` in the workflow runner. When GitHub is not connected, saving the plugin settings MUST surface a clear "connect GitHub first" message and link to the GitHub plugin's auth flow.
- **FR-15** `validateConnection()` MUST detect `IngressClass` resources in the cluster and return the list (name + controller string) so the UI can populate an ingress-class dropdown. The system MUST mark which detected classes have a built-in strategy (`nginx`, `traefik`) versus the generic fallback.
- **FR-16** The plugin MUST expose an extensible `IngressStrategy` interface so a contributor can add a new controller (e.g. `haproxy`, `gloo`, `envoy-gateway`) by registering a strategy module. Adding a strategy MUST NOT require changes to `manifest.renderer` or `deploy()`.
- **FR-17** The works-config layer MUST recognise an optional `deployProvider` field in `works.yml`. Importing or syncing a work whose config carries `deployProvider: <id>` MUST set `work.deployProvider` accordingly, validated against `DeployFacadeService.getAvailableProviders()`. This applies to **all** deploy providers (k8s, vercel, future) — there are no hardcoded provider ids in the works-config layer.
- **FR-18** When the work also has a dashboard-set `deployProvider`, the works-config value MUST take precedence on sync so the data repo remains the source of truth (Constitution Principle III). A conflict event MUST be written to the activity log when the two disagree at sync time.
- **FR-19** Adding `deployProvider` support to the works-config layer MUST be a single change reused by Vercel and Kubernetes — no plugin-specific branches.

## 4. Non-Functional Requirements

- **Performance**: `validateConnection` P95 < 3 s against a reachable cluster; full deploy P95 < 6 min for a small site (image build dominates); domain operations P95 < 2 s.
- **Reliability**: a failed deploy MUST leave the previous rollout serving traffic; the plugin MUST never partially apply manifests (use server-side apply or atomic apply order: image push → Deployment → Service → Ingress, with rollback if any step fails after Deployment is created).
- **Security & privacy**: kubeconfig and registry passwords are `x-secret`; the plugin MUST scrub credentials from any error message before raising it; the workflow runner uses short-lived in-process kubeconfig files (`mktemp`) and never persists them on disk beyond the run.
- **Observability**: activity-log events `deployment_started`, `deployment_image_pushed`, `deployment_applied`, `deployment_succeeded`, `deployment_failed` carry `provider = 'k8s'`, `workId`, `namespace`, and (truncated) cluster server URL. Sentry tags: `provider:k8s`, `clusterId` (sha256 of server URL).
- **Compatibility**: requires Kubernetes server ≥ 1.27 (current stable -2). Plugin SDK ≥ the version that ships `IDeploymentPlugin` (already shipped). No breaking changes to existing plugins or to the Vercel plugin.

## 5. Key Entities & Domain Concepts

| Entity / concept | Description |
| ---------------- | ----------- |
| `KubernetesPlugin` | The plugin class implementing `IPlugin` + `IDeploymentPlugin` for `id = 'k8s'`. |
| `kubeconfig` | The standard YAML file holding cluster, user, and context entries; stored as a single secret string in plugin settings. |
| `KubernetesSettings` | Plugin settings shape: `{ kubeconfig, namespace, kubeContext?, registry, ingressClass?, ingressHost?, tlsIssuer?, replicas? }`. |
| `RegistryConfig` | Discriminated union — `{ kind: 'github', owner?, visibility? } \| { kind: 'dockerhub', username, password } \| { kind: 'generic', server, username, password }`. The plugin's deploy code knows only the abstraction. |
| `RegistryProvider` | Strategy that maps a `RegistryConfig` to (a) the image reference base (`ghcr.io/<owner>`, `docker.io/<user>`, …) and (b) the `docker login` / pull-secret credentials at deploy time. |
| `IngressStrategy` | Strategy that takes manifest inputs and emits Ingress annotations specific to a controller (nginx, traefik, generic). Registered in a controller→strategy map. |
| `IngressClassDescriptor` | What `validateConnection` reports per detected class: `{ name, controller, hasStrategy: boolean }`. |
| Manifest bundle | The set of resources the plugin applies per work: one `Deployment`, one `Service`, optional `Ingress`, optional `imagePullSecret`. |
| Cluster identity | The `(server URL, cluster CA fingerprint)` pair used to identify a cluster for activity-log entries without leaking credentials. |
| Image tag | `{registry-base}/{work-slug}:{shortSha}` — deterministic so redeploys are diffable. |
| Rollout state | The Deployment's `status.conditions` mapped to `DeploymentResult.status`. |
| `deployProvider` (works-config) | Optional field in `works.yml` that declares which deployment plugin id (`k8s`, `vercel`, …) the work should use. |

## 6. Out of Scope

- Helm chart authoring or third-party Helm releases. The plugin renders its own minimal manifests; users wanting Helm should use the Helm-based template (separate feature).
- Full GitOps (Argo CD / Flux). The plugin pushes manifests imperatively via kubectl/server-side apply; a future GitOps mode is a separate spec.
- Cluster provisioning (creating the cluster, setting up cert-manager, ingress controller). The plugin assumes a pre-existing, working cluster.
- Multi-cluster failover / blue-green between clusters. One work targets one cluster.
- In-cluster databases or stateful workloads. The website is stateless; databases stay external.
- Bring-your-own Dockerfile. The website template owns the Dockerfile; users who need custom builds modify the template (same pattern as Vercel).
- Helm/Kustomize as the manifest renderer for v1; raw YAML rendering only.
- Cloud-provider-specific registries (ECR, GCR, ACR) in v1 — they are post-v1 and slot into the same `RegistryProvider` strategy.
- Ingress strategies beyond `nginx`, `traefik`, and the generic fallback in v1 — the strategy registry is the extension point.
- A platform-hosted shared image registry. v1 always uses the user's own registry (with GHCR as the zero-config default).

## 7. Acceptance Criteria

- [ ] **Discovery**: a user opening `/en/settings/plugins/deployment` sees both Vercel and Kubernetes; opening `/en/plugins` shows Kubernetes under Deployment.
- [ ] **Configure & verify**: pasting a valid kubeconfig (against any reachable cluster, e.g. kind, k3d, EKS) shows cluster name, server URL, server version, and the list of detected ingress controllers on save.
- [ ] **Configure & reject**: an invalid kubeconfig produces a specific, non-stack-trace error and does not mark the plugin as configured.
- [ ] **GHCR default**: with GitHub already connected, leaving the registry field at default deploys an image to `ghcr.io/<owner>/<work-slug>:<sha>` and provisions a pull secret in the namespace without further input.
- [ ] **Registry switch**: switching the registry kind to Docker Hub or generic uses the supplied credentials end-to-end with no GHCR fallback.
- [ ] **Ingress detection**: clusters with nginx and Traefik installed list both in the dropdown; selecting Traefik produces a Traefik-annotated Ingress; selecting an unknown class falls back to the generic strategy.
- [ ] **Deploy**: a work with `deployProvider = 'k8s'` builds an image, pushes it, applies a Deployment + Service (+ Ingress if `ingressHost` set), and reaches `ready` once rollout completes.
- [ ] **Redeploy**: a second deploy is a rolling update of the same Deployment; old ReplicaSets remain in history.
- [ ] **Failure path**: a wrong registry password fails before any manifest is applied; previous rollout still serves traffic.
- [ ] **Custom domains**: adding `tools.example.com` patches the Ingress and returns DNS guidance; verify endpoint flips `verified` once DNS resolves to the cluster.
- [ ] **Provider switch**: switching a work from Vercel to Kubernetes preserves `custom_domains` rows and re-syncs them to the Ingress.
- [ ] **works-config**: a `works.yml` containing `deployProvider: k8s` results in `work.deployProvider = 'k8s'` after sync; same for `vercel`; an unknown id surfaces a validation error and leaves the existing value untouched.
- [ ] **Secret hygiene**: kubeconfig and registry password are never returned by `GET /api/plugins/k8s/settings`; activity-log entries contain only the cluster fingerprint, not the kubeconfig.
- [ ] **Tests**: every functional requirement has a unit or integration test (FR-1…FR-19 mapped in `tasks.md`). The plugin package's Vitest suite passes; the API e2e suite covers the deploy controller against a stubbed plugin.

## 8. Open Questions

All four prior questions have been resolved by product input and are recorded here as decisions:

- **D1 — Image build location**: build runs in a **GitHub Actions** workflow inside the user's website-template fork (mirrors Vercel). No Trigger.dev / Ever-Works compute is used. (FR-6.)
- **D2 — Default registry**: **GitHub Container Registry** (`ghcr.io/<owner>/<work-slug>`) is the zero-config default, reusing the user's connected GitHub account. The registry is pluggable; Docker Hub and a generic kind ship in v1, cloud-provider registries are post-v1. No platform-hosted registry. (FR-13, FR-14.)
- **D3 — Ingress detection**: `validateConnection()` actively probes `IngressClass` resources and reports them in the response. Strategies for `nginx` and `traefik` ship in v1, with a generic fallback for unknown controllers and a strategy-registry for adding more over time. (FR-15, FR-16.)
- **D4 — Provider visibility & works-config**: the plugin's `visibility` is `'user-only'` (matches Vercel). Independently of visibility, both the dashboard **and** `works.yml` can set `deployProvider`; the works-config layer is extended generically so this works for k8s, Vercel, and any future deploy plugin. (FR-17, FR-18, FR-19.)

Newly opened questions (none blocking):

- `[NEEDS CLARIFICATION: when GHCR is selected and the user's GitHub account is connected via OAuth (not PAT), do we mint a fine-grained PAT on their behalf for the cluster pull-secret, or push public images by default?]`
- `[NEEDS CLARIFICATION: should ingress detection cache results per-cluster on the platform side to avoid round-tripping every time the deployment settings page loads?]`

## 9. Constitution Gates

- [x] **I — Plugin-first**: the integration ships as a new plugin in `packages/plugins/k8s/`; no core code knows about Kubernetes specifics.
- [x] **II — Capability-driven**: routing goes through `DeployFacadeService.getByCapability('deployment')`; no `if (provider === 'k8s')` branches in API or web code.
- [x] **III — Source-of-truth repos**: deployment manifests are derived from work state at deploy time, not stored as a separate source-of-truth repo. The website source repo remains the source of truth.
- [x] **IV — Trigger.dev**: deployment polling continues to use `DeploymentVerifierService` (existing pattern); no new always-on workers.
- [x] **V — Forward-only migrations**: no schema changes — the plugin reuses `plugin_settings`, `custom_domains`, and `works.deployProvider` (already a free-form string column).
- [x] **VI — Tests**: every FR maps to at least one test (see `tasks.md` Phase 7).
- [x] **VII — Secret hygiene**: `kubeconfig` and the registry sub-form's `password` (Docker Hub / generic) are `x-secret`; scrubbing is enforced in error mapping.
- [x] **VIII — Plugin counts**: `docs/plugin-system/built-in-plugins.md` is updated in the same PR (T6).
- [x] **IX — Behaviour-first**: this spec describes user-observable behaviour; manifest layout, kubectl invocation, etc. live in `plan.md`.
- [x] **X — Backwards-compat**: `IDeploymentPlugin` is unchanged; Vercel still works; existing works are unaffected.

## 10. References

- Plan: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Sibling plugin: `packages/plugins/vercel/`
- Capability contract: `packages/plugin/src/contracts/capabilities/deployment.interface.ts`
- Deploy facade: `packages/agent/src/facades/deploy.facade.ts`
- Deploy service: `apps/api/src/plugins-capabilities/deploy/deploy.service.ts`
- Web settings UI: `apps/web/src/app/[locale]/(dashboard)/settings/plugins/[category]/page.tsx`
- Related feature: [`../custom-domains/spec.md`](../custom-domains/spec.md)
- User-facing doc: [`../../../features/k8s-deployment.md`](../../../features/k8s-deployment.md)
