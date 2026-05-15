# Feature Specification: Kubernetes Cluster-Source Matrix (EW-616)

> Behaviour-first spec per [Constitution Principle IX](../../../specs/memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Implementation lives in [`./plan.md`](./plan.md).

**Feature ID**: `k8s-cluster-source-matrix`
**Jira**: [EW-616](https://evertech.atlassian.net/browse/EW-616) (parent policy [EW-615](https://evertech.atlassian.net/browse/EW-615))
**Status**: `Implemented`
**Created**: 2026-05-14
**Last updated**: 2026-05-14
**Owner**: Ever Works Team

**Shipped via**:

- Platform code: [#753](https://github.com/ever-works/ever-works/pull/753) (matrix + validator + tests), [#751](https://github.com/ever-works/ever-works/pull/751) (EW-615 classic-PAT push), [#766](https://github.com/ever-works/ever-works/pull/766) (UI conditional visibility)
- Platform infra: [#765](https://github.com/ever-works/ever-works/pull/765) (kubeconfigs as base64 GH secrets → k8s Secret → secretKeyRef on API container)
- Cascades: [#762](https://github.com/ever-works/ever-works/pull/762) + [#763](https://github.com/ever-works/ever-works/pull/763) (round 1), [#767](https://github.com/ever-works/ever-works/pull/767) + [#768](https://github.com/ever-works/ever-works/pull/768) (round 2)

**Builds on**: [k8s-deployment](../k8s-deployment/spec.md) — the original k8s plugin.

---

## 1. Overview

Before EW-616, the k8s deploy plugin had a single way to configure a cluster: paste a `kubeconfig` YAML. That conflated three different operational paths into one form field:

1. **Customer pastes their own kubeconfig** to deploy to their own cluster (BYOC).
2. **Platform admin** wants to deploy to `k8s-gauzy`, the internal cluster, for the platform-owned Works.
3. **Customer Cloud** users (Works whose website repo lives in the platform-owned `ever-works-cloud` GitHub org) should deploy to `k8s-works`, the shared customer cluster, without having to manage cluster credentials at all.

The conflation created a real security problem: if a Work's website repo is in an Ever Works–shared GitHub org (`ever-works` or `ever-works-cloud`) and the user picks their own cluster, the platform's deploy workflow has to push an org-scoped classic PAT onto that customer cluster as an `imagePullSecret`. The customer can then run `kubectl get secret -o yaml` and recover a credential that lets them read every GHCR image in the shared org. This is cross-tenant credential exposure (recorded as the "cell C" policy on EW-615 / 2026-05-14).

EW-616 splits the configuration into an explicit `clusterSource ∈ {k8s-works, k8s-gauzy, custom-kubeconfig}` dropdown, enforces a deploy-time matrix that rejects insecure combinations with a clear error, and substitutes the platform's kubeconfig from env vars for platform-managed cluster sources so the user never has to handle those credentials. Existing Works (with no `clusterSource` set) fall through to `custom-kubeconfig` so customer-org deploys keep working unchanged.

---

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I open the Kubernetes plugin settings, **when** the form loads, **then** I see a new **Target cluster** dropdown with three options: `k8s-works` (Ever Works shared customer cluster), `k8s-gauzy` (Ever Works internal cluster — admin-only), and `custom-kubeconfig` (paste my own). The default is `custom-kubeconfig` for back-compat.
- **Given** I pick `custom-kubeconfig`, **when** the form re-renders, **then** the **kubeconfig** textarea and the optional **Context** field are visible and **kubeconfig** is required to save.
- **Given** I pick `k8s-works` or `k8s-gauzy`, **when** the form re-renders, **then** the **kubeconfig** textarea and **Context** field are hidden, the form can be saved without a kubeconfig, and **Save & verify** succeeds with the message *"Will deploy to platform-managed cluster '<name>'."* (no live cluster check — the platform owns the credentials).
- **Given** my Work's website repo is in `ever-works-cloud` and I picked `clusterSource: 'k8s-works'`, **when** I deploy, **then** the deploy service substitutes `process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG` as the workflow's `K8S_TOKEN` secret, the dispatched `deploy_k8s.yaml` workflow uses it to talk to the shared customer cluster, and the deploy succeeds without me touching cluster credentials.
- **Given** my Work's website repo is in `ever-works` (admin path) and I picked `clusterSource: 'k8s-gauzy'`, **when** I deploy, **then** the deploy service substitutes `process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG` and the deploy targets the internal platform cluster.
- **Given** my Work's website repo is customer-owned (any org other than `ever-works` / `ever-works-cloud`) and I picked `clusterSource: 'custom-kubeconfig'`, **when** I deploy, **then** the platform reads my pasted kubeconfig (the existing path, unchanged) and `K8S_TOKEN` is exactly that value.

### 2.2 Matrix enforcement (rejection paths)

The deploy service rejects four of the nine `(websiteOwner, clusterSource)` combinations:

| Website owner | `k8s-works` | `k8s-gauzy` | `custom-kubeconfig` |
| --- | --- | --- | --- |
| `ever-works` | ✅ | ✅ admin path | ❌ `CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG` |
| `ever-works-cloud` | ✅ default | ❌ `K8S_GAUZY_NOT_ALLOWED` | ❌ `CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG` |
| customer-owned org | ✅ | ❌ `K8S_GAUZY_NOT_ALLOWED` | ✅ BYOC default |

- **Given** a customer Work in `ever-works-cloud` picks `custom-kubeconfig`, **when** the deploy starts, **then** the platform returns `400 Bad Request` with `code: CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG` and a message that explains the cross-tenant exposure risk and the two valid alternatives (pick `k8s-works`, or move the Work to the customer's own org).
- **Given** a customer Work in any non-`ever-works` org picks `k8s-gauzy`, **when** the deploy starts, **then** the platform returns `400 Bad Request` with `code: K8S_GAUZY_NOT_ALLOWED` explaining that `k8s-gauzy` is admin-only and pointing to the two valid alternatives.
- **Given** any Work picks `custom-kubeconfig` but no kubeconfig is saved, **when** the deploy starts, **then** the platform returns `400 Bad Request` with `code: CUSTOM_KUBECONFIG_MISSING_KUBECONFIG`. (In practice the deploy facade rejects earlier with `NoDeployCredentialsError`; this is a defence-in-depth case.)
- **Given** any Work picks `k8s-works` or `k8s-gauzy` but the corresponding `EVER_WORKS_K8S_*_KUBECONFIG` env var is missing on the platform's API container, **when** the deploy starts, **then** the platform returns `500 Internal Server Error` (not 4xx — the user picked a valid option; the platform is misconfigured) with the env-var name in the message so operators can fix the gap.

### 2.3 Back-compat

- **Given** a pre-EW-616 Work whose `clusterSource` was never set in plugin settings, **when** the deploy starts, **then** the platform coerces `clusterSource = 'custom-kubeconfig'` and the deploy proceeds exactly as it did before EW-616.
- **Given** a customer-org Work that had a kubeconfig saved before EW-616, **when** the new form renders, **then** the dropdown shows `custom-kubeconfig` (the back-compat default) and the saved kubeconfig is still in the textarea.

---

## 3. Functional Requirements

### 3.1 Schema additions

- **FR-1.** The k8s plugin's `settingsSchema` MUST expose `clusterSource` as `type: 'string', enum: ['k8s-works', 'k8s-gauzy', 'custom-kubeconfig'], default: 'custom-kubeconfig'`.
- **FR-2.** The schema MUST make `kubeconfig` conditionally required: only when `clusterSource === 'custom-kubeconfig'` (encoded as an `allOf` + `if/then` clause). For platform-managed values the kubeconfig field is optional.
- **FR-3.** The schema MUST hide the `kubeconfig` and `kubeContext` fields when `clusterSource !== 'custom-kubeconfig'` using the existing `x-showIf: { field, value }` extension. The form renderer already handles this.

### 3.2 Deploy-time enforcement

- **FR-4.** `DeployService.deploy()` MUST call `validateClusterSourceForOwner(websiteOwner, clusterSource)` early in the flow. On a failure result, it MUST throw `BadRequestException` with the failure's `code` and `message`.
- **FR-5.** For platform-managed cluster sources, `DeployService` MUST substitute the kubeconfig from the corresponding env var (`EVER_WORKS_K8S_WORKS_KUBECONFIG` / `EVER_WORKS_K8S_GAUZY_KUBECONFIG`) and use that as the `K8S_TOKEN` secret pushed to the website repo. The user-pasted `kubeconfig` (or sentinel) MUST be discarded.
- **FR-6.** When a platform-managed cluster source is picked but the corresponding env var is missing/whitespace, `DeployService` MUST throw `InternalServerErrorException` (not `BadRequestException`) so HTTP responses distinguish operator errors from user input errors.

### 3.3 Deploy-facade sentinel

- **FR-7.** `DeployFacadeService.getTokenFromSettings('k8s', ...)` MUST return a non-empty sentinel string (`PLATFORM_MANAGED_KUBECONFIG_SENTINEL`) when `clusterSource ∈ {k8s-works, k8s-gauzy}` and no kubeconfig is saved, so the facade considers the Work "configured" and the deploy proceeds to `DeployService` for substitution. The sentinel MUST NOT leak into any pushed GitHub Actions secret on the website repo (`DeployService.resolveDeployToken()` discards it).

### 3.4 Plugin-provided secrets

- **FR-8.** `KubernetesPlugin.getDeploymentSecrets(settings)` MUST emit a `K8S_CLUSTER_SOURCE` env var alongside the existing ones, defaulting to `'custom-kubeconfig'` when missing. Workflow templates and downstream observers MAY use this to branch behaviour or for breadcrumbs.

### 3.5 Allowed-sources helper for the UI

- **FR-9.** A pure helper `allowedClusterSourcesFor(websiteOwner)` MUST return the list of `clusterSource` values that are valid for that owner, in UI-recommended order. The helper MUST be exported so the (future) web-side dropdown can drive a context-aware list — though the v1 UI uses the static enum and relies on the deploy-time validator for enforcement.

### 3.6 Platform infrastructure

- **FR-10.** The two kubeconfig env vars MUST be provisioned on the API container in all three environments (`dev`, `stage`, `prod`). The supplied mechanism is: base64-encoded GitHub Actions secrets (`EVER_WORKS_K8S_WORKS_KUBECONFIG_B64`, `EVER_WORKS_K8S_GAUZY_KUBECONFIG_B64`) → `envsubst` into a Kubernetes `Secret.data` block → `valueFrom.secretKeyRef` on the API container. Base64 sidesteps the YAML-inside-YAML escaping trap with multi-line kubeconfig content; Kubernetes auto-decodes `Secret.data` when mounting via `secretKeyRef` so the container receives the raw kubeconfig YAML.

---

## 4. Non-Functional Requirements

- **NFR-1. Security.** The kubeconfig env vars are platform-cluster-admin credentials. They MUST never be returned by any API response, logged with their value, or echoed to terminals. Operator-side probes (key-name listing, byte-length checks) are allowed; value-revealing probes (`printenv`, `kubectl get secret -o yaml | grep KUBECONFIG`) are not.
- **NFR-2. Fail-closed.** Missing env vars MUST fail the deploy with a 5xx, not silently use a wrong kubeconfig or skip the substitution.
- **NFR-3. Error-message clarity.** All four rejection reasons (`CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG`, `K8S_GAUZY_NOT_ALLOWED`, `CUSTOM_KUBECONFIG_MISSING_KUBECONFIG`, missing env var) MUST tell the user (or operator) both *why* the deploy was rejected and what valid alternatives exist.
- **NFR-4. Owner string handling.** Owner comparisons MUST be case-insensitive and whitespace-trimmed — so `ever-works-cloud`, `EVER-WORKS-CLOUD`, and `  ever-works-cloud  ` resolve identically.

---

## 5. Out of Scope

- **Per-Work UI filtering.** The v1 dropdown shows all three options regardless of the current Work's website repo; the deploy-time matrix is the source of truth. A follow-up could call `allowedClusterSourcesFor(websiteOwner)` to filter the dropdown options when the form is rendered in a Work-scoped context.
- **Short-lived service-account tokens.** The platform kubeconfigs are long-lived cluster-admin. A separate hardening ticket should replace them with rotated service-account tokens scoped to the `ever-works` namespace.
- **Per-cluster RBAC scoping.** The platform's kubeconfig is currently full cluster-admin on each managed cluster. A future ticket could scope it to per-namespace RBAC.
- **GitHub-App installation tokens.** An alternative to classic PATs for the GHCR pull-secret was considered (EW-615 discussion). Out of scope here; classic PATs are the chosen path and are documented in [`reference-ghcr-classic-pat`](https://github.com/ever-works/workspace/blob/develop/knowledge/runbooks/EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md).
- **End-to-end test against a real platform cluster.** Existing k8s plugin e2e tests (`packages/plugins/k8s/src/__tests__/e2e/`) run against `kind` and cover deploy + ingress; they do not exercise the new platform-managed cluster sources because that path is API-side, not plugin-side. Unit tests on `cluster-source-matrix.ts` + `DeployService` + `DeployFacadeService` cover the new behaviour.

---

## 6. Test Coverage

- **`apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.spec.ts`** — 19 tests covering all 9 matrix cells (3 owner classes × 3 cluster sources), case insensitivity, env-var substitution, and missing-env failures.
- **`apps/api/src/plugins-capabilities/deploy/deploy.service.spec.ts`** — 6 EW-616 integration tests covering back-compat fall-through, env substitution, validation failures, the sentinel-discarding guarantee, and Vercel pass-through.
- **`packages/agent/src/facades/__tests__/deploy.facade.spec.ts`** — 5 sentinel tests covering both platform-managed cluster sources, the user-kubeconfig-wins rule, and the no-sentinel-for-custom / no-sentinel-for-non-k8s rules.
- **`packages/plugins/k8s/src/__tests__/k8s.plugin.spec.ts`** — 3 schema tests covering the conditional `required`, the cluster-source dropdown enum + default, and the `x-showIf` shape on the conditional fields.

All test suites green at merge time: agent (4381) + api deploy module (170) + k8s plugin (142). The `facades.module.spec.ts` regression guard was updated to include the new `PLATFORM_MANAGED_KUBECONFIG_SENTINEL` export.

---

## 7. Related

- Parent spec: [`k8s-deployment/spec.md`](../k8s-deployment/spec.md) — the original k8s plugin
- Workspace runbook: [`EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md`](https://github.com/ever-works/workspace/blob/develop/knowledge/runbooks/EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md)
- Workspace memory: [`reference-ever-works-github-orgs`](https://github.com/ever-works/workspace/blob/develop/knowledge/memory/reference_ever_works_github_orgs.md), [`reference-ever-works-k8s-clusters`](https://github.com/ever-works/workspace/blob/develop/knowledge/memory/reference_ever_works_k8s_clusters.md), [`reference-ghcr-classic-pat`](https://github.com/ever-works/workspace/blob/develop/knowledge/memory/reference_ghcr_classic_pat.md)
- Jira: [EW-616](https://evertech.atlassian.net/browse/EW-616), [EW-615](https://evertech.atlassian.net/browse/EW-615)
